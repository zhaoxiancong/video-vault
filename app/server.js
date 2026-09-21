'use strict';
/**
 * HTTP 服务端 + SSE 实时推送。
 * 零依赖：只用 node:http / node:fs / node:url。
 *
 * 路由总览
 *   GET  /                         前端页面
 *   GET  /static/*                 前端静态资源
 *   GET  /api/health               引擎自检（yt-dlp / ffmpeg 是否可用）
 *   GET  /api/stream               SSE：进度、队列、库变更
 *   GET  /api/settings  PATCH /api/settings
 *   GET  /api/library              库查询（q/status/site/uploader/sort/limit/offset）
 *   GET  /api/facets               筛选项计数
 *   POST /api/videos               添加链接（自动识别单视频 / 列表 / 频道）
 *   POST /api/videos/probe         只解析元数据不入队（预览用）
 *   POST /api/videos/:id/action    动作：pause|resume|cancel|retry
 *   POST /api/videos/:id/transcode 转码（剪辑层的统一格式）
 *   GET  /api/videos/:id/file      带 Range 的视频流（网页内播放）
 *   GET  /api/videos/:id/thumb     封面图
 *   GET  /api/videos/:id/log       该任务的 yt-dlp 原始日志尾部
 *   DELETE /api/videos/:id         从库里删除（可连带删文件）
 *   GET  /api/queue                当前活跃队列快照
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const cfg = require('./lib/config');
const db = require('./lib/db');
const ytdlp = require('./lib/ytdlp');
const cookies = require('./lib/cookies');
const { DownloadQueue, readTail, TRANSCODE_PRESETS } = require('./lib/queue');

const { STATUS, PATHS, PORT, HOST } = cfg;

cfg.ensureDirs();

const migrations = db.runMigrations();

// 启动时清理"指向同一个文件"的重复记录。
// 触发场景：用 rebuild-library.js 从磁盘重建过库（占位 local:// URL），
// 之后用户把原始链接重新粘一次补元数据 → 同一文件出现两条记录。
const dupGroups = db.findDuplicateFiles();
const dupMerged = [];
for (const g of dupGroups) {
  const ids = String(g.ids).split(',').map(Number);
  for (const id of ids) {
    try {
      const r = db.dedupeByFile(id);
      if (r) { dupMerged.push(`保留 id=${r.kept}，清理 ${r.removed} 条`); break; }
    } catch { /* 单条失败不影响启动 */ }
  }
}

const queue = new DownloadQueue();

// ---------------------------------------------------------------- SSE

const sseClients = new Set();

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* 客户端已断开 */ }
}

function broadcast(event, data) {
  for (const res of sseClients) sseSend(res, event, data);
}

queue.on('progress', (v) => broadcast('progress', slim(v)));
queue.on('queue', (snap) => broadcast('queue', snap));

function slim(v) {
  return {
    id: v.id, url: v.url, title: v.title, uploader: v.uploader, site: v.site,
    kind: v.kind, quality: v.quality, status: v.status, progress: v.progress,
    speed: v.speed, eta: v.eta, error: v.error, duration: v.duration,
    file_size: v.file_size, width: v.width, height: v.height, fps: v.fps,
    vcodec: v.vcodec, acodec: v.acodec,
    container: v.container, upload_date: v.upload_date, description: v.description,
    thumbnail_path: v.thumbnail_path, thumbnail_url: v.thumbnail_url,
    file_path: v.file_path, transcoded_path: v.transcoded_path,
    transcode_status: v.transcode_status, transcode_preset: v.transcode_preset,
    playlist_id: v.playlist_id, playlist_index: v.playlist_index,
    notes: v.notes, starred: v.starred,
    created_at: v.created_at, finished_at: v.finished_at,
  };
}

// ---------------------------------------------------------------- 工具

function json(res, code, body) {
  const text = JSON.stringify(body ?? null);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStatic(res, baseDir, relPath) {
  const full = path.join(baseDir, relPath);
  const normalized = path.normalize(full);
  if (!normalized.startsWith(path.normalize(baseDir))) {
    return json(res, 403, { error: '禁止访问' });
  }
  fs.stat(normalized, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: '文件不存在' });
    const ext = path.extname(normalized).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(normalized).pipe(res);
  });
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;

  try {
    // ---- 静态资源 ----
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return serveStatic(res, PATHS.FRONTEND, 'index.html');
    }
    if (req.method === 'GET' && p.startsWith('/static/')) {
      return serveStatic(res, PATHS.FRONTEND, p.slice('/static/'.length));
    }

    // ---- SSE ----
    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      sseSend(res, 'queue', queue.snapshot());
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }

    // ---- 引擎自检 ----
    if (req.method === 'GET' && p === '/api/health') {
      const info = ytdlp.binaryInfo();
      const stale = db.db.prepare(
        `SELECT COUNT(*) AS n FROM videos WHERE status IN ('paused','failed')`
      ).get().n;
      return json(res, 200, {
        ok: info.ytdlp.ok,
        engines: info,
        queuedInterrupted: stale,
        settings: db.getSettings(),
        downloads: PATHS.DOWNLOADS,
        version: require('./package.json').version,
      });
    }

    // ---- 登录态（Cookie）----
    // 检测本机装了哪些浏览器 + 当前配置状态。**只报告，不读 cookie 内容。**
    if (req.method === 'GET' && p === '/api/cookies/status') {
      const cur = db.getSettings();
      return json(res, 200, {
        installed: cookies.detectBrowsers(),
        supported: cookies.BROWSERS,
        settings: {
          cookiesFromBrowser: cur.cookiesFromBrowser || '',
          cookiesFile: cur.cookiesFile || '',
        },
        effective: cookies.cookieArgs(cur),
      });
    }

    // 真跑一次解析，验证 Cookie 现在到底能不能用。
    // 为什么要真跑：设置页写"已配置"毫无说服力，用户要知道的是"现在能不能下"。
    // 而 cookie 失效（登录过期）、被锁、格式不对，都只有真跑一次才暴露。
    if (req.method === 'POST' && p === '/api/cookies/test') {
      const cur = db.getSettings();
      const body = await readBody(req).catch(() => ({}));
      const probeSettings = body && Object.keys(body).length ? { ...cur, ...body } : cur;
      const result = await cookies.testCookies(probeSettings);
      return json(res, 200, result);
    }

    // ---- 设置 ----
    if (p === '/api/settings') {
      if (req.method === 'GET') return json(res, 200, db.getSettings());
      if (req.method === 'PATCH' || req.method === 'POST') {
        const patch = await readBody(req);
        // 登录态相关的字段单独校验：配错了要当场告诉用户，
        // 而不是等他下一次下载失败时才发现
        const warn = [];
        if (patch && typeof patch === 'object') {
          if (patch.cookiesFromBrowser !== undefined) {
            const b = String(patch.cookiesFromBrowser || '').trim().toLowerCase();
            if (b && b !== 'none' && !cookies.BROWSERS.includes(b)) {
              return json(res, 400, {
                error: `不认识的浏览器「${b}」，支持：${cookies.BROWSERS.join(' / ')}`,
              });
            }
          }
          if (patch.cookiesFile !== undefined && String(patch.cookiesFile || '').trim()) {
            const w = cookies.cookieArgs({ cookiesFile: patch.cookiesFile }).warning;
            if (w) warn.push(w);
          }
        }
        const next = db.setSettings(patch);
        broadcast('settings', next);
        queue.kick();
        return json(res, 200, warn.length ? { ...next, _warning: warn.join('；') } : next);
      }
    }

    // ---- 队列快照（活动任务 + 最近历史）----
    // 为什么要带历史：服务端的队列和库本来就是持久的，但如果只回活动任务，
    // 用户刷新页面就觉得"什么都没了"。把最近结束的任务一起回过去，
    // 刷新后仍能看到刚下完/失败的任务，并能直接删掉。
    if (req.method === 'GET' && p === '/api/queue') {
      const limit = Math.min(100, Number(u.searchParams.get('history') || 20));
      const snap = queue.snapshot();
      const history = db.db.prepare(
        `SELECT id,title,url,status,progress,kind,site,uploader,error,
                file_path,file_size,duration,height,container,finished_at,
                thumb_embed_ok, transcode_status
         FROM videos
         WHERE status IN ('done','failed','canceled','paused')
         ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC
         LIMIT ?`
      ).all(limit).map(slim);
      const counts = db.db.prepare(
        `SELECT
           SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) AS paused,
           SUM(CASE WHEN status='canceled' THEN 1 ELSE 0 END) AS canceled
         FROM videos`
      ).get();
      return json(res, 200, { ...snap, history, counts });
    }

    // ---- 库查询 ----
    if (req.method === 'GET' && p === '/api/library') {
      const q = {
        q: u.searchParams.get('q') || '',
        status: u.searchParams.get('status') || '',
        site: u.searchParams.get('site') || '',
        uploader: u.searchParams.get('uploader') || '',
        starred: u.searchParams.get('starred') === '1',
        sort: u.searchParams.get('sort') || 'created_desc',
        limit: Math.min(500, Number(u.searchParams.get('limit') || 200)),
        offset: Number(u.searchParams.get('offset') || 0),
      };
      const { rows, total } = db.listVideos(q);
      return json(res, 200, { total, rows: rows.map(slim) });
    }

    if (req.method === 'GET' && p === '/api/facets') {
      return json(res, 200, db.facets());
    }

    if (req.method === 'GET' && p === '/api/transcode-presets') {
      return json(res, 200, Object.entries(TRANSCODE_PRESETS)
        .map(([key, v]) => ({ key, label: v.label, ext: v.ext })));
    }

    // ---- 添加链接 ----
    if (req.method === 'POST' && p === '/api/videos') {
      const body = await readBody(req);
      const urls = Array.isArray(body.urls) ? body.urls : String(body.urls || '').split(/[\r\n]+/);
      const raw = urls.map((s) => String(s).trim())
        .filter((s) => s && /^https?:\/\//i.test(s));
      if (!raw.length) return json(res, 400, { error: '没有识别到有效的 http(s) 链接' });

      // 归一化：把"网页版复制出来的地址"转成 yt-dlp 认识的规范形式
      // （典型：抖音的 ?modal_id=xxx → /video/xxx），并按归一化结果去重
      const normalized = [];
      const renamed = [];
      const seenInput = new Set();
      for (const u of raw) {
        const n = ytdlp.normalizeUrl(u);
        if (n !== u) renamed.push({ from: u, to: n });
        if (seenInput.has(n)) continue;
        seenInput.add(n);
        normalized.push(n);
      }
      const clean = normalized;
      const opts = {
        kind: body.kind === 'audio' ? 'audio' : 'video',
        quality: body.quality || 'best',
      };
      const report = { added: [], skipped: [], playlists: [], errors: [], renamed, retried: [] };

      for (const url of clean) {
        try {
          const dup = db.findByUrl(url);
          if (dup) {
            // 库里已有的失败/暂停任务，重新粘同一个链接时直接重试。
            // 否则用户会以为"粘了没反应 / 还是坏的"——尤其在他刚升级了工具、
            // 而当年的失败是旧版本 bug 造成的时候。
            if ([STATUS.FAILED, STATUS.PAUSED, STATUS.CANCELED].includes(dup.status)) {
              queue.resume(dup.id, { force: true });
              report.retried.push({ url, id: dup.id, title: dup.title, was: dup.status });
            } else {
              report.skipped.push({ url, id: dup.id, title: dup.title, reason: '库里已有' });
            }
            continue;
          }
          const isList = body.forcePlaylist === true || ytdlp.classifyUrl(url) === 'playlist';

          if (isList) {
            const { playlist, items } = ytdlp.probePlaylist(url);
            const pl = db.upsertPlaylist(playlist);
            let addedHere = 0, skippedHere = 0;
            for (const it of items) {
              if (!it.url) { skippedHere++; continue; }
              if (db.findByUrl(it.url)) { skippedHere++; continue; }
              const v = db.insertVideo({
                url: it.url, video_id: it.video_id, extractor: it.extractor, site: it.site,
                title: it.title, uploader: it.uploader, upload_date: it.upload_date,
                duration: it.duration, description: it.description,
                thumbnail_url: it.thumbnail_url, kind: opts.kind, quality: opts.quality,
                status: STATUS.QUEUED, playlist_id: pl.id, playlist_index: it.playlist_index,
              });
              report.added.push({ id: v.id, title: v.title, url: v.url, playlist: pl.title });
              addedHere++;
            }
            report.playlists.push({
              id: pl.id, title: pl.title, url, count: items.length,
              added: addedHere, skipped: skippedHere,
            });
          } else {
            // 单视频：入队，元数据由队列在开跑时补（不阻塞接口）
            const v = db.insertVideo({
              url, kind: opts.kind, quality: opts.quality, status: STATUS.QUEUED,
            });
            report.added.push({ id: v.id, title: null, url, needsProbe: true });
          }
        } catch (err) {
          report.errors.push({ url, error: err.message });
        }
      }

      queue.kick();
      broadcast('library', { changed: true });
      return json(res, 202, report);
    }

    // ---- 只解析不入队 ----
    if (req.method === 'POST' && p === '/api/videos/probe') {
      const body = await readBody(req);
      const url = ytdlp.normalizeUrl(String(body.url || '').trim());
      if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: '无效链接' });
      const isList = body.forcePlaylist === true || ytdlp.classifyUrl(url) === 'playlist';
      if (isList) {
        const { playlist, items } = ytdlp.probePlaylist(url, { maxItems: 30 });
        return json(res, 200, { kind: 'playlist', playlist, items: items.slice(0, 30), total: items.length });
      }
      const meta = ytdlp.probeMetadata(url);
      return json(res, 200, { kind: 'video', meta });
    }

    // ---- 针对单条记录的元数据重解析（给"标题缺失"的历史任务补） ----
    const metaMatch = p.match(/^\/api\/videos\/(\d+)\/refresh$/);
    if (metaMatch && req.method === 'POST') {
      const id = Number(metaMatch[1]);
      const v = db.getVideo(id);
      if (!v) return json(res, 404, { error: '记录不存在' });
      const meta = ytdlp.probeMetadata(v.url);
      const next = db.updateVideo(id, {
        title: meta.title, uploader: meta.uploader, upload_date: meta.upload_date,
        duration: meta.duration, description: meta.description,
        thumbnail_url: meta.thumbnail_url, video_id: meta.video_id,
        extractor: meta.extractor, site: meta.site,
        width: meta.width, height: meta.height, fps: meta.fps,
      });
      broadcast('progress', slim(next));
      return json(res, 200, slim(next));
    }

    // ---- 动作 ----
    const actMatch = p.match(/^\/api\/videos\/(\d+)\/action$/);
    if (actMatch && req.method === 'POST') {
      const id = Number(actMatch[1]);
      const body = await readBody(req);
      const action = String(body.action || '');
      const v = db.getVideo(id);
      if (!v) return json(res, 404, { error: '记录不存在' });

      let ok = false;
      switch (action) {
        case 'pause': ok = queue.pause(id); break;
        case 'resume': ok = queue.resume(id, { force: true }); break;
        case 'cancel': ok = queue.cancel(id, { deletePart: body.deletePart !== false }); break;
        case 'retry': ok = queue.resume(id, { force: true }); break;
        case 'star':
          db.updateVideo(id, { starred: v.starred ? 0 : 1 });
          ok = true; break;
        case 'notes':
          db.updateVideo(id, { notes: String(body.notes ?? '').slice(0, 2000) });
          ok = true; break;
        default: return json(res, 400, { error: `未知动作: ${action}` });
      }
      broadcast('progress', slim(db.getVideo(id)));
      return json(res, 200, { ok, video: slim(db.getVideo(id)) });
    }

    // ---- 转码（剪辑层：原始文件永不改动，产物另存） ----
    const tcMatch = p.match(/^\/api\/videos\/(\d+)\/transcode$/);
    if (tcMatch && req.method === 'POST') {
      const id = Number(tcMatch[1]);
      const body = await readBody(req);
      const v = db.getVideo(id);
      if (!v) return json(res, 404, { error: '记录不存在' });
      if (v.status !== STATUS.DONE || !v.file_path) {
        return json(res, 400, { error: '只有已下载完成的任务才能转码' });
      }
      const preset = String(body.preset || 'h264-1080p');
      try {
        await queue.startTranscode(v, preset);
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
      broadcast('progress', slim(db.getVideo(id)));
      return json(res, 202, { ok: true, preset, video: slim(db.getVideo(id)) });
    }

    // ---- 视频流（支持 Range，网页播放器才能拖动进度） ----
    const fileMatch = p.match(/^\/api\/videos\/(\d+)\/file$/);
    if (fileMatch && req.method === 'GET') {
      const id = Number(fileMatch[1]);
      const v = db.getVideo(id);
      if (!v || !v.file_path) return json(res, 404, { error: '文件不存在' });
      const useTranscoded = u.searchParams.get('source') === 'transcoded';
      const target = useTranscoded ? (v.transcoded_path || v.file_path) : v.file_path;
      if (!fs.existsSync(target)) return json(res, 404, { error: '磁盘上找不到该文件' });

      const st = fs.statSync(target);
      const ext = path.extname(target).toLowerCase();
      const type = ext === '.mp4' || ext === '.m4a' ? 'video/mp4'
        : ext === '.webm' ? 'video/webm'
        : ext === '.mkv' ? 'video/x-matroska'
        : ext === '.mp3' ? 'audio/mpeg'
        : ext === '.opus' ? 'audio/ogg'
        : 'application/octet-stream';

      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (Number.isNaN(start) || start < 0) start = 0;
        if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
        if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(target, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': st.size,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(target).pipe(res);
      }
      return;
    }

    // ---- 封面 ----
    const thMatch = p.match(/^\/api\/videos\/(\d+)\/thumb$/);
    if (thMatch && req.method === 'GET') {
      const id = Number(thMatch[1]);
      const v = db.getVideo(id);
      const local = v && v.thumbnail_path && fs.existsSync(v.thumbnail_path) ? v.thumbnail_path : null;
      if (local) {
        const st = fs.statSync(local);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': st.size, 'Cache-Control': 'max-age=86400' });
        return fs.createReadStream(local).pipe(res);
      }
      // 本地没有则 302 到原始封面地址（不代理，省流量）
      if (v && v.thumbnail_url && /^https?:\/\//i.test(v.thumbnail_url)) {
        res.writeHead(302, { Location: v.thumbnail_url });
        return res.end();
      }
      return json(res, 404, { error: '没有封面' });
    }

    // ---- 原始日志尾部（排错用） ----
    const logMatch = p.match(/^\/api\/videos\/(\d+)\/log$/);
    if (logMatch && req.method === 'GET') {
      const id = Number(logMatch[1]);
      const v = db.getVideo(id);
      if (!v || !v.log_path) return json(res, 404, { error: '没有日志' });
      const text = readTail(v.log_path, 20000);
      return json(res, 200, { id, lines: text.split(/\r?\n/).slice(-400) });
    }

    // ---- 删除记录 ----
    const delMatch = p.match(/^\/api\/videos\/(\d+)$/);
    if (delMatch && req.method === 'DELETE') {
      const id = Number(delMatch[1]);
      const v = db.getVideo(id);
      if (!v) return json(res, 404, { error: '记录不存在' });
      queue.cancel(id, { deletePart: true });
      const keepFile = u.searchParams.get('keepFile') === '1';
      const removed = [];
      if (!keepFile) {
        for (const f of [v.file_path, v.transcoded_path]) {
          if (f && fs.existsSync(f)) { try { fs.unlinkSync(f); removed.push(f); } catch {} }
        }
        if (v.thumbnail_path && fs.existsSync(v.thumbnail_path)) { try { fs.unlinkSync(v.thumbnail_path); } catch {} }
      }
      db.deleteVideo(id);
      broadcast('library', { changed: true, removed: id });
      return json(res, 200, { ok: true, removedFiles: removed, keptFile: keepFile });
    }

    // ---- 批量操作 ----
    if (req.method === 'POST' && p === '/api/queue/action') {
      const body = await readBody(req);
      const action = String(body.action || '');
      if (action === 'pauseAll') return json(res, 200, { ok: true, affected: queue.pauseAll() });
      if (action === 'retryFailed') return json(res, 200, { ok: true, affected: queue.retryFailed() });
      if (action === 'resumeAll') {
        const rows = db.db.prepare(`SELECT id FROM videos WHERE status IN ('paused','failed','canceled')`).all();
        for (const r of rows) queue.resume(r.id, { force: true });
        return json(res, 200, { ok: true, affected: rows.length });
      }
      if (action === 'clearFinished') {
        const rows = db.db.prepare(`SELECT id FROM videos WHERE status IN ('done','canceled')`).all();
        for (const r of rows) db.deleteVideo(r.id);
        broadcast('library', { changed: true });
        return json(res, 200, { ok: true, affected: rows.length });
      }
      return json(res, 400, { error: `未知批量动作: ${action}` });
    }

    return json(res, 404, { error: `无此路由: ${req.method} ${p}` });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

// ---------------------------------------------------------------- 启动

queue.recoverStale();

server.listen(PORT, HOST, () => {
  const health = ytdlp.binaryInfo();
  console.log('');
  console.log('  ╭──────────────────────────────────────────────────────────╮');
  console.log('  │  视频下载工具 Video Vault 已启动                          │');
  console.log('  ╰──────────────────────────────────────────────────────────╯');
  console.log(`  界面地址   http://${HOST}:${PORT}`);
  console.log(`  下载目录   ${PATHS.DOWNLOADS}`);
  console.log(`  数据库     ${PATHS.DB}`);
  console.log(`  yt-dlp     ${health.ytdlp.ok ? health.ytdlp.version : '❌ ' + health.ytdlp.error}`);
  console.log(`  ffmpeg     ${health.ffmpeg.ok ? '可用' : '❌ ' + health.ffmpeg.error}`);
  console.log(`  并发/限速  ${db.getSettings().concurrency} 个 / ${db.getSettings().rateLimitMB ? db.getSettings().rateLimitMB + ' MB/s' : '不限速'}`);
  if (migrations && migrations.columnsAdded && migrations.columnsAdded.length) {
    console.log(`  [迁移]     已为数据库补充字段：${migrations.columnsAdded.join(', ')}`);
  }
  if (migrations && migrations.rateLimitMB && migrations.rateLimitMB.from !== migrations.rateLimitMB.to) {
    console.log(`  [迁移]     限速 ${migrations.rateLimitMB.from} MB/s → ${migrations.rateLimitMB.to === 0 ? '不限速' : migrations.rateLimitMB.to + ' MB/s'}（可在设置或添加页改）`);
  }
  if (migrations && migrations.pathsHealed) {
    const h = migrations.pathsHealed;
    const parts = Object.entries(h)
      .filter(([, v]) => v && v !== 0)
      .map(([k, v]) => (typeof v === 'object' ? `${k} → ${v.to}` : `${k} ${v} 条`));
    console.log(`  [迁移]     检测到工具目录被移动，已自动修正：${parts.join('，')}`);
  }
  if (dupMerged.length) {
    console.log(`  [清理]     合并 ${dupMerged.length} 组重复记录（同一文件被记了多条）：${dupMerged.join('；')}`);
  }
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n  收到中断，正在暂停下载任务…');
  const n = queue.pauseAll();
  console.log(`  已暂停 ${n} 个任务，未完成的文件保留，下次可手动继续。`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});

module.exports = { server, queue };
