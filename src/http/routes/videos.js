'use strict';
/**
 * 视频相关路由：添加 / 解析 / 动作 / 播放 / 封面 / 日志 / 删除。
 *
 * 每个处理函数只做三件事：**校验参数 → 调服务 → 返回视图**。
 * 业务逻辑一律在 app/ 那一层，这里不写 SQL、不碰子进程。
 */

const fs = require('node:fs');
const path = require('node:path');

const { json, readJsonBody } = require('../router');
const { validate, R } = require('../validate');
const { slim } = require('../views');
const { NotFoundError, ValidationError } = require('../../domain/errors');
const { STATUS } = require('../../infra/config');
const { normalizeUrl, classifyUrl } = require('../../domain/video');

/** 允许的动作名（写死，避免 body.action 拼错时静默无事发生） */
const ACTIONS = ['pause', 'resume', 'cancel', 'retry', 'star', 'notes'];

function register(router, ctx) {
  const { repo, scheduler, downloader, urldiag, broadcast, settings } = ctx;

  /**
   * 把一批链接加入下载队列 —— **唯一的入队实现**。
   *
   * ⚠️ 抽成函数是为了让「从网站找视频」的批量入队复用它，而不是复制一遍逻辑：
   *    复制出来的第二份会绕过去重、URL 归一化和 `scheduler.kick()`，
   *    表现为"候选点了加入队列，但任务一直不动"。
   *
   * 三种结果要分别告诉用户，不能混成一句"成功"：
   *   added    新入库的
   *   skipped  库里已有、跳过的
   *   retried  库里已有但是失败/暂停状态 —— **重新粘同一个链接就等于重试**
   *            （否则用户会以为"粘了没反应"，尤其在他刚升级完工具、
   *             而当年的失败是旧版本 bug 造成的时候）
   *
   * @param {string[]} rawUrls
   * @param {{kind?:string, quality?:string, forcePlaylist?:boolean}} opts
   * @returns {Promise<object>} report
   */
  async function addUrls(rawUrls, opts = {}) {
    const raws = (Array.isArray(rawUrls) ? rawUrls : [])
      .map((s) => String(s).trim())
      .filter((s) => /^https?:\/\//i.test(s));
    if (!raws.length) {
      throw new ValidationError('没有识别到有效的链接', {
        hint: '请粘贴以 http:// 或 https:// 开头的完整视频地址，一行一个。',
      });
    }

    // 归一化：把"网页版复制出来的地址"转成 yt-dlp 认识的规范形式
    // （典型：抖音的 ?modal_id=xxx → /video/xxx），并按归一化结果去重
    const normalized = [];
    const renamed = [];
    const seen = new Set();
    for (const u of raws) {
      const n = normalizeUrl(u);
      if (n.changed) renamed.push({ from: u, to: n.url, note: n.note });
      if (seen.has(n.url)) continue;
      seen.add(n.url);
      normalized.push(n.url);
    }

    const kind = opts.kind === 'audio' ? 'audio' : 'video';
    const quality = opts.quality || 'best';
    const report = { added: [], skipped: [], playlists: [], errors: [], renamed, retried: [] };

    for (const url of normalized) {
      try {
        const dup = repo.findByUrl(url);
        if (dup) {
          if ([STATUS.FAILED, STATUS.PAUSED, STATUS.CANCELED].includes(dup.status)) {
            scheduler.resume(dup.id, { force: true });
            report.retried.push({ url, id: dup.id, title: dup.title, was: dup.status });
          } else {
            report.skipped.push({ url, id: dup.id, title: dup.title, reason: '库里已有' });
          }
          continue;
        }

        const isList = opts.forcePlaylist === true || classifyUrl(url) === 'playlist';
        if (isList) {
          const { playlist, items } = downloader.probePlaylist(url);
          const pl = repo.upsertPlaylist(playlist);
          let addedHere = 0;
          let skippedHere = 0;
          for (const it of items) {
            if (!it.url) { skippedHere += 1; continue; }
            if (repo.findByUrl(it.url)) { skippedHere += 1; continue; }
            const v = repo.insertVideo({
              url: it.url, title: it.title, duration: it.duration,
              kind, quality, status: STATUS.QUEUED,
              playlist_id: pl.id, playlist_index: it.playlist_index,
            });
            report.added.push({ id: v.id, title: v.title, url: v.url, playlist: pl.title });
            addedHere += 1;
          }
          report.playlists.push({
            id: pl.id, title: pl.title, url, count: items.length,
            added: addedHere, skipped: skippedHere,
          });
        } else {
          // 单视频：入队，元数据由队列在开跑时补（**不阻塞接口** ——
          // 解析要联网，几十条链接串行解析会让用户等几分钟）
          const v = repo.insertVideo({ url, kind, quality, status: STATUS.QUEUED });
          report.added.push({ id: v.id, title: null, url, needsProbe: true });
        }
      } catch (err) {
        report.errors.push({ url, error: err.message, hint: err.hint || '' });
      }
    }

    scheduler.kick();
    broadcast('library', { changed: true });
    return report;
  }

  // ---------------------------------------------------------------- 添加链接

  router.post('/api/videos', async (req, res) => {
    const body = await readJsonBody(req);
    const opts = validate(body, {
      kind: { type: 'string', enum: ['video', 'audio'] },
      quality: { type: 'string', maxLength: 20 },
      forcePlaylist: { type: 'boolean' },
    });

    const rawList = Array.isArray(body.urls) ? body.urls : String(body.urls || '').split(/[\r\n]+/);
    const report = await addUrls(rawList, opts);
    return json(res, 202, report);
  });

  // ---------------------------------------------------------------- 批量操作（分组 / 收藏）
  //
  // ⚠️ 这两条**必须注册在 `/api/videos/:id/...` 之前**。路由是按注册顺序匹配的，
  //    虽然 `:id` 那条只认数字（`bulk-action` 会被 `Number()` 成 NaN 而落到 400），
  //    但"靠参数校验兜住"比"靠注册顺序兜住"脆 —— 测试里有一条专门钉这件事
  //    （批量收藏不能被 :id 那条吃掉返回 400）。

  /**
   * 批量入组 / 出组。
   *
   * 部分成功要好过整体回滚：批量里混有已被删掉的 id 是常态，
   * 该忽略的忽略、该报的报，其余照常生效。
   */
  router.post('/api/videos/group-action', async (req, res) => {
    const body = await readJsonBody(req);
    const numList = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []);
    const ids = numList(body.ids);
    const add = numList(body.add);
    const remove = numList(body.remove);

    if (!ids.length) {
      throw new ValidationError('没有选中任何视频', { hint: '先勾选几条。' });
    }
    if (!add.length && !remove.length) {
      throw new ValidationError('没有指定要加入或移出哪个分组', {
        hint: 'add 或 remove 至少给一个分组 id。',
      });
    }

    const errors = [];
    const live = new Set(repo.listVideosAll({}).map((v) => v.id));
    const missingVideos = ids.filter((id) => !live.has(id));
    for (const id of missingVideos) errors.push({ id, reason: '这条视频已经不在了' });

    const groupIds = new Set(repo.listGroups().map((g) => g.id));
    let added = 0;
    let removed = 0;

    for (const gid of add) {
      if (!groupIds.has(gid)) { errors.push({ id: gid, reason: '这个分组已经不在了' }); continue; }
      added += repo.addToGroup(ids, gid);
    }
    for (const gid of remove) {
      if (!groupIds.has(gid)) { errors.push({ id: gid, reason: '这个分组已经不在了' }); continue; }
      removed += repo.removeFromGroup(ids, gid);
    }

    return json(res, 200, {
      added, removed,
      affected: ids.length - missingVideos.length,
      errors,
    });
  });

  /**
   * 批量收藏 / 取消收藏。
   *
   * 为什么单独开一个入口：前端循环发 N 次 `/:id/action` 会有 N 个请求，
   * 既慢又容易撞上服务端并发。内部**复用 repo.updateVideo**（与单条动作同一条写路径），
   * 不复制逻辑。
   */
  const BULK_ACTIONS = ['star', 'unstar'];
  router.post('/api/videos/bulk-action', async (req, res) => {
    const body = await readJsonBody(req);
    const action = String((body && body.action) || '');
    if (!BULK_ACTIONS.includes(action)) {
      throw new ValidationError(`不支持的批量动作：${action || '(空)'}`, {
        hint: `可用的：${BULK_ACTIONS.join(' / ')}`,
      });
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) {
      throw new ValidationError('没有选中任何视频', { hint: '先勾选几条。' });
    }

    let affected = 0;
    for (const id of ids) {
      if (!repo.getVideo(id)) continue;     // 不存在的跳过，不报错
      repo.updateVideo(id, { starred: action === 'star' });
      affected += 1;
    }
    broadcast('library', { changed: true });
    return json(res, 200, { affected });
  });


  // ---------------------------------------------------------------- 只解析不入队（预览用）

  router.post('/api/videos/probe', async (req, res) => {
    const body = await readJsonBody(req);
    const { url: input } = validate(body, { url: R.url() }, { strict: false });
    const normalized = normalizeUrl(input).url;

    const isList = body.forcePlaylist === true || classifyUrl(normalized) === 'playlist';
    if (isList) {
      const { playlist, items } = downloader.probePlaylist(normalized, { maxItems: 30 });
      return json(res, 200, {
        kind: 'playlist', playlist,
        items: items.slice(0, 30), total: items.length,
      });
    }
    const meta = downloader.probeMetadata(normalized);
    return json(res, 200, { kind: 'video', meta });
  });

  // ---------------------------------------------------------------- 单条记录

  const findOr404 = (id) => {
    const v = repo.getVideo(id);
    if (!v) throw new NotFoundError('记录不存在', { hint: '它可能已经被删掉了，刷新一下库看看。' });
    return v;
  };

  /** 重新解析元数据（给"标题缺失"的历史任务补） */
  router.post('/api/videos/:id/refresh', async (req, res, params) => {
    const id = Number(params.id);
    const v = findOr404(id);
    const meta = await downloader.probeMetadata(v.url);
    const next = repo.updateVideo(id, {
      title: meta.title, uploader: meta.uploader, upload_date: meta.upload_date,
      duration: meta.duration, description: meta.description,
      thumbnail_url: meta.thumbnail_url, video_id: meta.video_id,
      extractor: meta.extractor, site: meta.site,
      width: meta.width, height: meta.height, fps: meta.fps,
    });
    broadcast('progress', slim(next));
    return json(res, 200, slim(next));
  });

  /** 动作：暂停 / 继续 / 取消 / 重试 / 收藏 / 备注 */
  router.post('/api/videos/:id/action', async (req, res, params) => {
    const id = Number(params.id);
    const body = await readJsonBody(req);
    const { action } = validate(body, { action: R.oneOf(ACTIONS, `可用动作：${ACTIONS.join(' / ')}`) });
    findOr404(id);   // 存在性检查（顺便给出一句人话）

    let ok = false;
    switch (action) {
      case 'pause': ok = scheduler.pause(id); break;
      case 'resume':
      case 'retry': ok = scheduler.resume(id, { force: true }); break;
      case 'cancel':
        ok = scheduler.cancel(id, { deletePart: body.deletePart !== false });
        break;
      case 'star': {
        const cur = repo.getVideo(id);
        repo.updateVideo(id, { starred: !cur.starred });
        ok = true;
        break;
      }
      case 'notes':
        repo.updateVideo(id, { notes: String(body.notes ?? '').slice(0, 2000) });
        ok = true;
        break;
      default:
        // validate 的 enum 已经挡住了，这里只是穷尽分支
        ok = false;
    }

    const next = slim(repo.getVideo(id));
    broadcast('progress', next);
    return json(res, 200, { ok, video: next });
  });

  // ---------------------------------------------------------------- 播放 / 封面 / 日志

  router.get('/api/videos/:id/file', (req, res, params) => {
    const id = Number(params.id);
    const v = findOr404(id);
    if (!v.file_path) throw new NotFoundError('这条记录还没有文件', { hint: '它可能还没下载完。' });
    // Range 支持在这里（serveFile），播放器拖进度条靠它
    return ctx.serveFile(res, req, v.file_path);
  });

  router.get('/api/videos/:id/thumb', (req, res, params) => {
    const id = Number(params.id);
    const v = repo.getVideo(id);
    const local = v && v.thumbnail_path && fs.existsSync(v.thumbnail_path) ? v.thumbnail_path : null;
    if (local) return ctx.serveFile(res, req, local, { contentType: 'image/jpeg' });
    // 本地没有则 302 到原始封面地址（不代理，省流量也省得做缓存）
    if (v && v.thumbnail_url && /^https?:\/\//i.test(v.thumbnail_url)) {
      res.writeHead(302, { Location: v.thumbnail_url });
      return res.end();
    }
    throw new NotFoundError('这条记录没有封面');
  });

  /** 原始日志尾部（排错用，界面上「看日志」按钮） */
  router.get('/api/videos/:id/log', (req, res, params) => {
    const id = Number(params.id);
    const v = repo.getVideo(id);
    if (!v || !v.log_path) throw new NotFoundError('这条记录没有日志');
    const text = require('../../infra/subprocess').readTail(v.log_path, 20000);
    return json(res, 200, { id, lines: text.split(/\r?\n/).slice(-400) });
  });

  // ---------------------------------------------------------------- 删除

  /**
   * 删除记录。
   *
   * ⚠️ 默认**保留文件**（`keepFile` 缺省为真）—— 这是刻意的：
   *    下载好的视频往往来之不易，一个误点就永久删掉是不可接受的。
   *    要连文件一起删必须显式传 `?keepFile=0`，而且前端还会二次确认。
   */
  router.delete('/api/videos/:id', (req, res, params, url) => {
    const id = Number(params.id);
    const v = findOr404(id);

    scheduler.cancel(id, { deletePart: true });

    const keepFile = url.searchParams.get('keepFile') !== '0';
    const removed = [];
    if (!keepFile) {
      // 只删这一条记录自己的文件。**没有转码产物了** —— 那个功能已整体移除。
      for (const f of [v.file_path]) {
        if (f && fs.existsSync(f)) {
          try { fs.unlinkSync(f); removed.push(f); } catch { /* 被占用就留着 */ }
        }
      }
      if (v.thumbnail_path && fs.existsSync(v.thumbnail_path)) {
        try { fs.unlinkSync(v.thumbnail_path); } catch { /* 忽略 */ }
      }
    }
    repo.deleteVideo(id);
    broadcast('library', { changed: true, removed: id });
    return json(res, 200, { ok: true, removedFiles: removed, keptFile: keepFile });
  });

  // ---------------------------------------------------------------- 批量删除
  //
  // ⚠️ 这是**不可逆**的操作（删文件那一档尤其）。几条刻意的设计：
  //   · 与单条删除共用同一套语义：`keepFile` 的默认值是"保留"，
  //     这里的 `deleteFiles` 默认也是 false —— 想删文件必须显式说要。
  //   · 部分成功原则：混有已不存在的 id 时，该忽略的忽略、该报的报，
  //     其余照常执行（和 group-action 一致）。
  //   · **去重**：同一个 id 给三次不能算删了三条（那会把报数夸大）。
  //   · 先 `cancel` 再删：不这么做会留下一个"库记录没了但进程还在下"的孤儿。
  //   · 如实报 `freedBytes`，界面才能告诉用户"释放了多少空间"。

  router.post('/api/videos/bulk-delete', async (req, res) => {
    const body = await readJsonBody(req);
    const raw = Array.isArray(body.ids) ? body.ids : [];
    const ids = [...new Set(raw.map(Number).filter(Number.isInteger))];
    const deleteFiles = body.deleteFiles === true;

    if (!ids.length) {
      throw new ValidationError('没有选中任何视频', { hint: '先勾选几条，再点删除。' });
    }

    const errors = [];
    let deleted = 0;
    let removedFiles = 0;
    let freedBytes = 0;

    for (const id of ids) {
      const v = repo.getVideo(id);
      if (!v) {
        errors.push({ id, reason: '这条视频已经不在了' });
        continue;
      }

      // 先取消：否则会留下"记录没了、进程还在下"的孤儿
      try { scheduler.cancel(id, { deletePart: true }); } catch { /* 取消失败不该挡住删除 */ }

      if (deleteFiles) {
        // 与单条删除保持一致：删视频文件 + 封面。任何一步失败都只记录、不中断。
        for (const f of [v.file_path, v.thumbnail_path]) {
          if (!f) continue;
          try {
            if (fs.existsSync(f)) {
              const size = fs.statSync(f).size;
              fs.unlinkSync(f);
              removedFiles += 1;
              // 只把**视频文件**算进释放空间（封面那几十 KB 不值得混进来）
              if (f === v.file_path) freedBytes += size;
            }
          } catch { errors.push({ id, reason: `文件删不掉（可能被占用）：${f}` }); }
        }
      }

      repo.deleteVideo(id);
      deleted += 1;
    }

    broadcast('library', { changed: true });
    return json(res, 200, { deleted, removedFiles, freedBytes, errors });
  });

  // ---------------------------------------------------------------- 批量动作

  const BATCH = ['pauseAll', 'resumeAll', 'retryFailed', 'clearFinished'];

  router.post('/api/queue/action', async (req, res) => {
    const body = await readJsonBody(req);
    const { action } = validate(body, {
      action: R.oneOf(BATCH, `可用批量动作：${BATCH.join(' / ')}`),
    });

    if (action === 'pauseAll') {
      return json(res, 200, { ok: true, affected: scheduler.pauseAll() });
    }
    if (action === 'retryFailed') {
      return json(res, 200, { ok: true, affected: scheduler.retryFailed() });
    }
    if (action === 'resumeAll') {
      const rows = repo.listByStatuses([STATUS.PAUSED, STATUS.FAILED, STATUS.CANCELED]);
      for (const r of rows) scheduler.resume(r.id, { force: true });
      return json(res, 200, { ok: true, affected: rows.length });
    }

    // clearFinished：**只删记录，磁盘文件一律保留**（要删文件必须逐条确认）
    const rows = repo.listByStatuses([STATUS.DONE, STATUS.CANCELED]);
    for (const r of rows) repo.deleteVideo(r.id);
    broadcast('library', { changed: true });
    return json(res, 200, { ok: true, affected: rows.length, keptFiles: true });
  });

  // ---------------------------------------------------------------- 链接诊断

  /** 把"引擎不认这个地址"变成"这个地址是什么、你该做什么" */
  router.post('/api/diagnose', async (req, res) => {
    const body = await readJsonBody(req);
    const { url } = validate(body, { url: R.url() });
    if (!urldiag) {
      throw new ValidationError('当前没有启用链接诊断');
    }
    const diag = await urldiag.diagnoseUnsupported(url);
    return json(res, 200, { ...diag, message: urldiag.explain(diag, url) });
  });

  // 暴露给别的路由（「从网站找视频」的批量入队）——**全项目只有这一个入队入口**。
  // 这样候选入队走的就是和"粘链接"完全相同的那条路：归一化、去重、scheduler.kick()。
  return { addUrls };
}

module.exports = { register, ACTIONS };
