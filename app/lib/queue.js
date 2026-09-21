'use strict';
/**
 * 下载队列调度器。
 *
 * 被 grill 出来的行为约定：
 *  - 并发 2（设置可改），每个任务带 --limit-rate 限速，模拟单人观看流量，降低风控概率
 *  - 进度不靠管道，而是**轮询 tail 任务日志文件**（平台禁止 pipe 子进程输出）
 *  - 关站/中断后任务标 paused，**必须用户点「继续」才续传**，不偷偷跑流量
 *  - 支持暂停 / 取消 / 重试 / 手动继续
 *  - 下载完成后：探测真实文件信息（ffprobe）→ 抓封面缩略图 → 入库
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
// spawn / spawnSync 都要：spawnSync 用于短命令（ffprobe 探测），
// spawn 用于长命令（转码）。曾经漏掉 spawn，导致转码功能一调用就
// "spawn is not defined"，而 node --check 抓不到这种漏导入。
const { spawn, spawnSync } = require('node:child_process');

const cfg = require('./config');
const db = require('./db');
const ytdlp = require('./ytdlp');
const urldiag = require('./urldiag');

const { STATUS, PATHS } = cfg;
const POLL_MS = 700;

/**
 * 真正的"后期处理"阶段：只有这些出现时，才说明下载已经结束、在跑 ffmpeg。
 *
 * ⚠️ 为什么不直接用「看到任何后处理器」当判据：
 *    yt-dlp 的 ThumbnailsConvertor 会在**下载开始之前**先执行一次，
 *    如果用它当"下载已结束"的信号，进度条会从一开场就被顶到 99% 不动。
 *    这个 bug 真实发生过，见 queue.js 里 _tail() 的注释。
 */
const POST_STAGE_RE = /^(Merger|ExtractAudio|VideoConvertor|VideoRemuxer|Fixup)/i;

/**
 * 转码预设。核心约定：**原始文件永不改动，产物另存 _converted/**。
 * 剪辑场景最常要的是「统一成 H.264 + MP4」——任何剪辑软件都能直接吃。
 */
const TRANSCODE_PRESETS = {
  'copy-mp4': {
    label: '仅换容器（秒完成，不重编码）',
    ext: 'mp4',
    args: (out) => ['-c', 'copy', '-movflags', '+faststart', out],
  },
  'h264-1080p': {
    label: 'H.264 1080p（剪辑友好，通用）',
    ext: 'mp4',
    args: (out) => [
      '-vf', 'scale=-2:min(1080\\,ih)', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out,
    ],
  },
  'h264-720p': {
    label: 'H.264 720p（体积小）',
    ext: 'mp4',
    args: (out) => [
      '-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'medium', '-crf', '22',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out,
    ],
  },
  'h265-1080p': {
    label: 'H.265 1080p（更小，但对老设备不友好）',
    ext: 'mp4',
    args: (out) => [
      '-vf', 'scale=-2:min(1080\\,ih)', '-c:v', 'libx265', '-preset', 'medium', '-crf', '24',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out,
    ],
  },
  'audio-mp3': {
    label: '抽音频为 MP3（当播客听）',
    ext: 'mp3',
    args: (out) => ['-vn', '-c:a', 'libmp3lame', '-q:a', '2', out],
  },
};

class DownloadQueue extends EventEmitter {
  constructor() {
    super();
    this.running = new Map();   // videoId -> job
    this.timers = new Map();    // videoId -> interval
    this.transcodes = new Map(); // videoId -> {child,outPath,presetName}
    this._autoRetry = new Set(); // 已因"文件损坏"自动重下过的任务（防止无限循环）
    this._kickPending = false;   // kick 去重标志（见 kick() 里的递归崩溃说明）
    this.stopped = false;
  }

  // ------------------------------------------------------------ 队列驱动

  get concurrency() {
    return Math.max(1, Number(db.getSettings().concurrency || 2));
  }

  activeCount() {
    return this.running.size;
  }

  /** 叫醒调度器：有新任务或槽位空出来了 */
  kick() {
    if (this.stopped) return;
    // ⚠️ 必须异步调度。
    //    曾经这里是同步 this._schedule()，配上 _start 里的 await，
    //    形成了同步无限递归：_start 跑到 await 让出控制权时任务还是 queued，
    //    任何 kick() 都会把它再捞起来 → 同一毫秒内 _start 被调用上千次，
    //    堆内存每秒涨 50MB，几秒后 "JavaScript heap out of memory" 崩溃。
    if (this._kickPending) return;
    this._kickPending = true;
    setImmediate(() => {
      this._kickPending = false;
      this._schedule();
    });
  }

  _schedule() {
    if (this.stopped) return;

    // 兜底：如果已经有一个同 id 的任务正在跑，说明状态迁移漏了，这里补上，
    // 避免同一个任务被并行启动多次。
    const stuck = db.db.prepare(
      `SELECT id FROM videos WHERE status IN (?,?,?)`
    ).all(STATUS.PARSING, STATUS.DOWNLOADING, STATUS.PROCESSING)
      .filter((r) => !this.running.has(r.id));
    for (const r of stuck) {
      // 状态是"进行中"但进程不在跑（多半是上次崩溃残留），修正为暂停，交给用户决定
      db.updateVideo(r.id, { status: STATUS.PAUSED, error: '任务已中断，可点继续重下' });
      this._broadcast(r.id);
    }

    const limit = this.concurrency;
    while (this.running.size < limit) {
      const next = db.db.prepare(
        `SELECT * FROM videos WHERE status = ? ORDER BY id ASC LIMIT 1`
      ).get(STATUS.QUEUED);
      if (!next) break;
      if (this.running.has(next.id)) break;   // 防重入
      // 立刻占位，杜绝"还没离开 queued 状态就被再次调度"
      this.running.set(next.id, { id: next.id, starting: true, child: null });
      this._start(next).catch((err) => {
        this.running.delete(next.id);
        this._fail(next.id, `启动失败: ${err.message}`);
      });
    }
    this.emit('queue', this.snapshot());
  }

  snapshot() {
    const rows = db.db.prepare(
      `SELECT id,title,status,progress,speed,eta,kind,site,uploader,error
       FROM videos WHERE status IN ('queued','parsing','downloading','processing') 
       ORDER BY id ASC`
    ).all();
    return {
      active: this.running.size,
      concurrency: this.concurrency,
      running: rows,
    };
  }

  // ------------------------------------------------------------ 单个任务

  async _start(video) {
    const settings = db.getSettings();

    // ⚠️ 关键：必须在**任何 await 之前**把任务移出 queued 状态。
    //    _start 是 async，第一个 await 会让出控制权；如果那时状态还是 queued，
    //    任何一次 kick() 都会把它重新捞起来再启动一次 —— 同步无限递归，
    //    同一毫秒内 _start 被调用上千次，堆内存每秒涨几十 MB，几秒内 OOM 崩溃。
    //    这个 bug 真实发生过（服务端跑 2 分钟就 FATAL heap out of memory）。
    db.updateVideo(video.id, {
      status: video.title ? STATUS.DOWNLOADING : STATUS.PARSING,
      error: null,
    });
    this._broadcast(video.id);

    // 1) 补元数据（队列里的任务可能只有 url）
    if (!video.title) {
      try {
        const meta = ytdlp.probeMetadata(video.url);
        if (meta) {
          db.updateVideo(video.id, {
            title: meta.title, uploader: meta.uploader, upload_date: meta.upload_date,
            duration: meta.duration, description: meta.description,
            thumbnail_url: meta.thumbnail_url, video_id: meta.video_id,
            extractor: meta.extractor, site: meta.site,
            width: meta.width, height: meta.height, fps: meta.fps,
          });
        }
      } catch (err) {
        // 解析失败时给一句**有用**的话。
        // yt-dlp 对"页面链接"只会说 "Unsupported URL"，用户完全不知道下一步做什么
        // （实测：粘 https://www.xvideos.com/best/2026-08 这种列表页就是这句）。
        // 这里额外抓一下那个页面，判断它到底是列表页还是根页面，再写成可读提示。
        let msg = `解析失败: ${err.message}`;
        if (/unsupported url|no video|unable to extract/i.test(err.message)) {
          try {
            const diag = await urldiag.diagnoseUnsupported(video.url);
            msg = urldiag.explain(diag, video.url);
          } catch { /* 诊断本身失败就保持原报错 */ }
        }
        this._fail(video.id, msg);
        return;
      }
    }

    // 2) 决定要不要嵌封面。
    //    ffmpeg 处理不了 avif/heic 等格式，若硬嵌会让**已经下完的视频**被判失败
    //    （实测 xvideos 的 avif 封面就是这样把 303MB 的任务搞挂的）。
    //    所以先探明封面格式，只对确定支持的格式开 --embed-thumbnail。
    const fresh = db.getVideo(video.id);
    let embedThumb = false;
    if (settings.embedThumbnail !== false) {
      if (fresh.thumb_embed_ok === 1 || fresh.thumb_embed_ok === 0) {
        embedThumb = fresh.thumb_embed_ok === 1;          // 用上次的结论，不重复探测
      } else {
        const verdict = await ytdlp.canEmbedThumbnail(fresh.thumbnail_url);
        embedThumb = verdict.ok;
        db.updateVideo(video.id, {
          thumb_embed_ok: verdict.ok ? 1 : 0,
          thumb_format: verdict.format,
        });
        if (!verdict.ok) {
          this.emit('notice', { id: video.id, message: `跳过封面嵌入：${verdict.reason}` });
        }
      }
    }

    // 重新读一次最新记录（元数据 / 封面判定已合并）
    const cur = db.getVideo(video.id);
    db.updateVideo(video.id, { status: STATUS.DOWNLOADING, error: null, progress: 0 });

    const { child, logPath, resultFile } = ytdlp.startDownload(cur || fresh, settings, {
      resume: !!(cur || fresh).file_path || ['paused', 'failed'].includes((cur || fresh).status),
      embedThumbnail: embedThumb,
    });

    // 复用 _schedule 预先占好的槽位（这样"已占用"从调度那一刻就成立）
    const job = this.running.get(video.id) || {};
    Object.assign(job, {
      id: video.id,
      child,
      logPath,
      resultFile,
      offset: 0,
      buffer: '',
      lastEmit: 0,
      startedAt: Date.now(),
      killing: false,
      stage: '解析中',
      sawFile: null,
      alreadyExisted: false,
      // 进度追踪
      downloading: false,     // 是否已经收到过下载进度（用于区分"下载阶段/后处理阶段"）
      lastPercent: null,      // 上一帧百分比，用于探测"切换到下一条流"
      streamIndex: 0,         // 第几条流（视频流/音频流各自 0→100%）
      destinationCount: 0,
      pipeline: [],           // 已出现过的后处理器（按 started 顺序）
      pipelineSeen: new Set(),
      starting: false,
    });
    this.running.set(video.id, job);
    db.updateVideo(video.id, { log_path: logPath });
    this._broadcast(video.id);
    this.emit('queue', this.snapshot());

    // 轮询 tail 日志文件读进度（不能用 pipe）
    const timer = setInterval(() => this._tail(job), POLL_MS);
    this.timers.set(video.id, timer);

    child.on('error', (err) => {
      this._cleanup(video.id);
      this._fail(video.id, `进程启动失败: ${err.message}`);
    });

    child.on('close', (code) => {
      this._cleanup(video.id);
      this._finish(video.id, code, job).catch((err) => this._fail(video.id, err.message));
    });
  }

  _cleanup(id) {
    const t = this.timers.get(id);
    if (t) { clearInterval(t); this.timers.delete(id); }
    this.running.delete(id);
  }

  /** 读日志文件的新增部分，逐行解析成进度 */
  _tail(job) {
    // 预占槽位阶段（进程还没起来）直接跳过，避免读到不存在的日志
    if (!job.child || !job.logPath) return;
    let st;
    try { st = fs.statSync(job.logPath); } catch { return; }
    if (st.size < job.offset) job.offset = 0;      // 日志被重置
    if (st.size === job.offset) return;

    // 单次最多读 256KB：万一 offset 被重置、或日志异常巨大，
    // 也不会一次性 Buffer.alloc 出天文数字把堆撑爆。
    const MAX_READ = 256 * 1024;
    const want = st.size - job.offset;
    const len = Math.min(want, MAX_READ);

    let chunk = '';
    try {
      const fd = fs.openSync(job.logPath, 'r');
      const buf = Buffer.allocUnsafe(len);
      const got = fs.readSync(fd, buf, 0, len, job.offset);
      fs.closeSync(fd);
      chunk = buf.subarray(0, got).toString('utf8');
      job.offset += got;
    } catch { return; }

    const text = job.buffer + chunk;
    const lines = text.split(/\r?\n/);
    job.buffer = lines.pop() ?? '';   // 最后一行可能不完整，留到下次

    const patch = {};
    let dirty = false;
    for (const line of lines) {
      const ev = ytdlp.parseProgressLine(line);
      if (!ev) continue;
      switch (ev.type) {
        case 'progress':
          if (ev.percent !== null) patch.progress = ev.percent;
          if (ev.speed !== null) patch.speed = ev.speed;
          if (ev.eta !== null) patch.eta = ev.eta;
          // 收到下载进度 = 确实处于下载阶段。
          // 注意：yt-dlp 的多条流（视频流、音频流）会**各自从 0% 走到 100%**，
          // 所以探测到百分比显著回退时，说明切换到下一条流了，要重置已记录的速度。
          if (ev.percent !== null && job.lastPercent !== null && ev.percent < job.lastPercent - 10) {
            job.streamIndex++;
          }
          if (ev.percent !== null) job.lastPercent = ev.percent;
          job.downloading = true;
          job.stage = '下载中';
          dirty = true;
          break;

        case 'postprocess':
          // ⚠️ 这里**绝不能**改 status/progress。
          //    曾经的 bug：以为"stage 变了 = 下载完了"，一看到后处理器就把进度顶到 99。
          //    但 yt-dlp 的 ThumbnailsConvertor 在**下载开始之前**就会先跑一次，
          //    结果进度条整场卡在 99%，而真实下载从 0% 走到 99%。
          //    现在只把它记进 pipeline 列表，等 child 退出后由 _finish 决定终态。
          if (ev.status === 'started' || ev.status === 'finished') {
            const key = `${ev.stage}:${ev.status}`;
            if (!job.pipelineSeen.has(key)) {
              job.pipelineSeen.add(key);
              if (ev.status === 'started') job.pipeline.push(ev.stage);
            }
          }
          break;

        case 'destination':
          // 每发现一个新目标文件，说明开始下一条流
          job.destinationCount++;
          break;

        case 'stage':
          job.stage = ev.stage || job.stage;
          break;

        case 'file':
          job.sawFile = ev.path;
          break;

        case 'already':
          job.alreadyExisted = true;
          break;

        case 'error':
          patch.error = ev.message;
          dirty = true;
          break;

        default:
          break;
      }
    }

    // 状态推进：只有"下载确实结束了、正在跑 ffmpeg 后处理"才算 processing。
    // 判据是「已经见过下载进度 且 已出现真正的后期处理（合并/抽音频/转码）」，
    // 而不是"看到任何后处理器"。
    if (!patch.status && !patch.error) {
      const inPost = job.downloading && job.pipeline.some((p) => POST_STAGE_RE.test(p));
      patch.status = inPost ? STATUS.PROCESSING : STATUS.DOWNLOADING;
    }

    if (dirty || patch.status) {
      db.updateVideo(job.id, patch);
      const now = Date.now();
      if (now - job.lastEmit > 400) {   // 限流，别把前端刷爆
        job.lastEmit = now;
        this._broadcast(job.id, { stage: stageLabel(job) });
      }
    }
  }

  _broadcast(id, extra = {}) {
    const v = db.getVideo(id);
    if (!v) return;
    this.emit('progress', { ...v, ...extra });
    db.emitEvent('progress', { id, status: v.status, progress: v.progress, ...extra });
  }

  _fail(id, message) {
    db.updateVideo(id, { status: STATUS.FAILED, error: String(message).slice(0, 500) });
    this._broadcast(id);
    this.emit('queue', this.snapshot());
    this.kick();
  }

  /** 进程退出后的收尾：探测文件、抓封面、入库 */
  async _finish(id, code, job) {
    const v = db.getVideo(id);
    if (!v) return;

    if (job.killing) {
      db.updateVideo(id, { status: STATUS.PAUSED, error: '已暂停，可点继续' });
      this._broadcast(id); this.kick(); return;
    }

    if (code !== 0) {
      const log = readTail(job.logPath, 4000);
      const raw = ytdlp.cleanError(log) || `yt-dlp 退出码 ${code}`;
      // 登录态相关的报错要翻译成人话。yt-dlp 的原话（"Could not copy Chrome
      // cookie database"）不会告诉用户"把浏览器关掉再试"，而这条恰好是
      // 用户最可能撞上、又最摸不着头脑的失败。
      let err = raw;
      try {
        // eslint-disable-next-line global-require
        const { decorateError } = require('./cookies');
        err = decorateError(raw);
      } catch { /* cookies 模块不可用时用原文 */ }
      this._fail(id, err);
      return;
    }

    // 找最终文件：优先读 --print-to-file 的结果文件（UTF-8，中文路径不会乱码），
    // 其次用日志里捕获的路径，最后按时间扫下载目录兜底。
    let filePath = ytdlp.readResultFile(job.resultFile);
    if (!filePath && job.sawFile && fs.existsSync(job.sawFile)) filePath = job.sawFile;
    if (!filePath) filePath = findNewestFile(db.getSettings().downloadDir || PATHS.DOWNLOADS, v, job.startedAt);

    // 完整性校验：容器文件可能"存在但损坏/不完整"（典型原因是上一次下载被中断，
    // 留下了半截分片，yt-dlp 合并时直接报 Invalid data）。这里用 ffprobe 实测，
    // 不靠"文件存在"就算成功。
    if (filePath && fs.existsSync(filePath) && !isPlayable(filePath)) {
      const log = readTail(job.logPath, 4000);
      const detail = ytdlp.cleanError(log);
      cleanupFormatFiles(db.getSettings().downloadDir || PATHS.DOWNLOADS, v, filePath);
      try { fs.unlinkSync(filePath); } catch {}

      // 只自动重下一次，避免坏源导致无限循环
      if (!this._autoRetry.has(id)) {
        this._autoRetry.add(id);
        db.updateVideo(id, {
          status: STATUS.QUEUED, progress: 0, speed: 0, eta: 0,
          error: '输出文件损坏，已清理残留并自动重新下载一次',
        });
        this._broadcast(id);
        this.emit('queue', this.snapshot());
        this.kick();
        return;
      }
      this._autoRetry.delete(id);
      this._fail(id, `文件损坏且重下仍失败${detail ? '：' + detail : ''}`);
      return;
    }

    const patch = { status: STATUS.DONE, progress: 100, speed: 0, eta: 0, error: null,
                    finished_at: new Date().toISOString() };
    if (filePath && fs.existsSync(filePath)) {
      const st = fs.statSync(filePath);
      patch.file_path = filePath;
      patch.file_size = st.size;
      patch.container = path.extname(filePath).replace('.', '');
      const probe = probeMedia(filePath);
      if (probe) Object.assign(patch, probe);
      const thumb = grabThumbnail(v, filePath);
      if (thumb) patch.thumbnail_path = thumb;
      // 合并成功后清理中间分片，避免同目录残留 .fXXX 文件
      cleanupFormatFiles(db.getSettings().downloadDir || PATHS.DOWNLOADS, v, filePath);
      this._autoRetry.delete(id);
    } else if (job.alreadyExisted) {
      patch.error = '文件已存在，跳过下载';
    } else {
      patch.status = STATUS.FAILED;
      patch.error = '下载进程正常退出，但没找到输出文件';
    }

    db.updateVideo(id, patch);
    this._broadcast(id);
    this.emit('queue', this.snapshot());

    // 同一文件已存在别的记录 → 合并，避免"重建的占位记录 + 用户重粘的真实 URL"
    // 变成同一个文件两条记录（rebuild-library.js 之后重新粘链接就会这样）
    try {
      const merged = db.dedupeByFile(id);
      if (merged) {
        this.emit('notice', {
          id: merged.kept,
          message: `发现同一文件的重复记录，已自动合并（清理 ${merged.removed} 条）`,
        });
        this._broadcast(merged.kept);
      }
    } catch { /* 合并失败不影响下载结果 */ }

    this.kick();
  }

  // ------------------------------------------------------------ 外部操作

  /** 暂停：杀进程，保留 .part，状态置 paused */
  pause(id) {
    const job = this.running.get(id);
    if (job) {
      job.killing = true;
      // ⚠️ child 在"已占槽位但进程还没起来"的窗口期是 null，必须判空。
      //    直接写 job.child.pid 会抛
      //    "Cannot read properties of null (reading 'pid')"，
      //    用户看到的就是一句莫名其妙的报错（这个 bug 真实发生过）。
      if (job.child && job.child.pid) {
        killTree(job.child.pid);
      } else {
        db.updateVideo(id, { status: STATUS.PAUSED, error: '已暂停（进程尚未启动）' });
        this._broadcast(id);
      }
      return true;
    }
    const v = db.getVideo(id);
    if (v && [STATUS.QUEUED].includes(v.status)) {
      db.updateVideo(id, { status: STATUS.PAUSED, error: '已暂停' });
      this._broadcast(id);
      return true;
    }
    return false;
  }

  /** 继续：把 paused/failed 的任务重新排进队列 */
  resume(id, { force = false } = {}) {
    const v = db.getVideo(id);
    if (!v) return false;
    if (![STATUS.PAUSED, STATUS.FAILED, STATUS.CANCELED].includes(v.status) && !force) return false;
    db.updateVideo(id, { status: STATUS.QUEUED, error: null, progress: 0, speed: 0 });
    this._broadcast(id);
    this.kick();
    return true;
  }

  /** 取消：停进程，可选删掉半截文件 */
  cancel(id, { deletePart = true } = {}) {
    const job = this.running.get(id);
    if (job) {
      job.killing = true;
      // 同上：窗口期 job.child 为 null，必须判空
      if (job.child && job.child.pid) killTree(job.child.pid);
    } else {
      this._cleanup(id);
    }

    const v = db.getVideo(id);
    if (deletePart && v && v.file_path) {
      // 只删下载目录下的分片/临时文件，绝不动已完成的正式文件
      removePartials(db.getSettings().downloadDir || PATHS.DOWNLOADS, v);
    }
    db.updateVideo(id, { status: STATUS.CANCELED, progress: 0, speed: 0, eta: 0 });
    this._broadcast(id);
    this.emit('queue', this.snapshot());
    this.kick();
    return true;
  }

  /** 只重试网络类失败任务 */
  retryFailed() {
    const rows = db.db.prepare(`SELECT id FROM videos WHERE status = ?`).all(STATUS.FAILED);
    for (const r of rows) {
      db.updateVideo(r.id, { status: STATUS.QUEUED, error: null, progress: 0 });
    }
    this.kick();
    return rows.length;
  }

  /** 全部暂停（关站前调用） */
  pauseAll() {
    const ids = [...this.running.keys()];
    for (const id of ids) this.pause(id);
    const queued = db.db.prepare(`SELECT id FROM videos WHERE status = ?`).all(STATUS.QUEUED);
    for (const q of queued) db.updateVideo(q.id, { status: STATUS.PAUSED, error: '已暂停' });
    return ids.length + queued.length;
  }

  // ------------------------------------------------------------ 转码层

  /**
   * 转码 / 重封装。对应「当剪辑素材用」这个真实需求：
   * 原始文件永不改动，产物另存到 downloads/_converted/，
   * 这样既满足"防丢"（保原始），又满足"好剪"（统一格式）。
   */
  startTranscode(video, presetName) {
    const preset = TRANSCODE_PRESETS[presetName];
    if (!preset) throw new Error(`未知转码预设: ${presetName}`);
    if (!fs.existsSync(PATHS.FFMPEG)) throw new Error('ffmpeg 不可用，无法转码');
    if (!video.file_path || !fs.existsSync(video.file_path)) throw new Error('原始文件不存在');

    const outDir = path.join(db.getSettings().downloadDir || PATHS.DOWNLOADS, '_converted');
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.basename(video.file_path, path.extname(video.file_path));
    const outPath = path.join(outDir, `${base} [${presetName}].${preset.ext}`);
    const logPath = path.join(PATHS.LOGS, `transcode-${video.id}.log`);

    const args = ['-y', '-hide_banner', '-i', video.file_path, ...preset.args(outPath), outPath];
    fs.writeFileSync(logPath, '');
    const fd = fs.openSync(logPath, 'a');
    let child;
    try {
      child = spawn(PATHS.FFMPEG, args, { stdio: ['ignore', fd, fd], windowsHide: true });
    } finally { try { fs.closeSync(fd); } catch {} }

    this.transcodes.set(video.id, { child, outPath, presetName });
    db.updateVideo(video.id, { transcode_status: 'running', transcode_preset: presetName });
    this._broadcast(video.id);

    child.on('close', (code) => {
      this.transcodes.delete(video.id);
      if (code === 0 && fs.existsSync(outPath)) {
        db.updateVideo(video.id, {
          transcode_status: 'done', transcoded_path: outPath,
        });
        this.emit('transcoded', { id: video.id, preset: presetName, path: outPath });
      } else {
        const err = readTail(logPath, 2000).trim().split(/\r?\n/).pop() || `ffmpeg 退出码 ${code}`;
        db.updateVideo(video.id, { transcode_status: 'failed', error: `转码失败: ${err}`.slice(0, 500) });
      }
      this._broadcast(video.id);
    });
    child.on('error', (err) => {
      this.transcodes.delete(video.id);
      db.updateVideo(video.id, { transcode_status: 'failed', error: `转码进程启动失败: ${err.message}` });
      this._broadcast(video.id);
    });
    return { outPath, logPath };
  }

  /** 服务启动时：把上次没跑完的任务标 paused（手动继续才续） */
  recoverStale() {
    const ids = db.markStaleActiveAsPaused();
    for (const id of ids) this._broadcast(id);
    this.kick();
    return ids;
  }
}

// ---------------------------------------------------------------- 工具函数

/**
 * 给前端看的阶段文案。
 * 多流下载时明确标出"第几条流"，因为视频流和音频流会**各自从 0% 走到 100%**，
 * 不说明的话用户会以为进度条坏了（百分比归零）。
 */
function stageLabel(job) {
  const post = job.pipeline.filter((p) => POST_STAGE_RE.test(p));
  if (job.downloading && post.length) {
    return `处理中 · ${post[post.length - 1]}`;
  }
  if (job.downloading) {
    return job.streamIndex > 0 ? `下载中（第 ${job.streamIndex + 1} 条流）` : '下载中';
  }
  return job.stage || '下载中';
}

/** 杀掉进程树（yt-dlp 会拉起 ffmpeg 子进程） */
function killTree(pid) {
  if (!pid) return;
  // 优先用 taskkill 连子进程一起收，失败则退回普通 kill
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore', windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function readTail(file, maxBytes = 4000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

/** 用 ffprobe 读真实媒体信息 */
function probeMedia(filePath) {
  if (!fs.existsSync(PATHS.FFPROBE)) return null;
  const tmp = path.join(PATHS.DATA, `_ffprobe-${Date.now()}.json`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    const r = spawnSync(PATHS.FFPROBE, [
      '-v', 'error', '-print_format', 'json',
      '-show_format', '-show_streams', filePath,
    ], { stdio: ['ignore', fd, fd], timeout: 60000, windowsHide: true });
    fs.closeSync(fd); fd = null;
    if (r.status !== 0) return null;
    const data = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    const v = (data.streams || []).find((s) => s.codec_type === 'video');
    const a = (data.streams || []).find((s) => s.codec_type === 'audio');
    return {
      file_size: Number(data.format?.size) || null,
      duration: data.format?.duration ? Math.round(Number(data.format.duration)) : null,
      width: v?.width || null,
      height: v?.height || null,
      fps: v?.r_frame_rate ? evalFps(v.r_frame_rate) : null,
      vcodec: v?.codec_name || null,
      acodec: a?.codec_name || null,
    };
  } catch { return null; }
  finally {
    if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function evalFps(rate) {
  const [a, b] = String(rate).split('/').map(Number);
  if (!b) return a || null;
  return Math.round((a / b) * 100) / 100;
}

/** 下载完成后把封面存成缩略图（本地化，避免界面依赖外链失效） */
function grabThumbnail(video, filePath) {
  const dir = path.join(PATHS.DATA, 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${video.id}.jpg`);

  // 优先从媒体文件里抽出嵌入的封面
  if (fs.existsSync(PATHS.FFMPEG) && fs.existsSync(filePath)) {
    const r = spawnSync(PATHS.FFMPEG, [
      '-y', '-v', 'error', '-i', filePath, '-map', '0:v', '-map', '-0:V',
      '-frames:v', '1', '-vf', 'scale=480:-2', dest,
    ], { stdio: 'ignore', timeout: 60000, windowsHide: true });
    if (r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  }

  // 退回：下载网络封面
  if (video.thumbnail_url) {
    // 异步 fire-and-forget：抽帧失败时用网络封面兜底，不阻塞任务收尾
    fetch(video.thumbnail_url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .then((ab) => { if (ab) fs.writeFileSync(dest, Buffer.from(ab)); })
      .catch(() => {});
  }
  return null;
}

/** 兜底：在下载目录里找该任务最近产生的文件 */
function findNewestFile(dir, video, since) {
  let best = null;
  const walk = (d, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/\.(mp4|mkv|webm|mp3|m4a|opus|flac|wav|mov|avi)$/i.test(e.name)) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs < since - 5000) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs };
    }
  };
  walk(dir);
  return best ? best.path : null;
}

/** 清理某任务的半截文件（.part / .ytdl），不动正式成品 */
function removePartials(dir, video) {
  const walk = (d, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (/\.(part|ytdl|temp|tmp)$/i.test(e.name)) {
        try { fs.unlinkSync(full); } catch {}
      }
    }
  };
  walk(dir);
}

/**
 * 用 ffprobe 实测一个媒体文件是否**真的可播放**。
 *
 * 为什么必须实测：文件"存在"不等于"完整"。上一次下载被中断会留下半截分片，
 * yt-dlp 合并时读到坏数据直接报 "Invalid data found when processing input"，
 * 但文件本身是躺在磁盘上的 —— 只判断 fs.existsSync 会把它当成功。
 */
function isPlayable(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    if (fs.statSync(filePath).size < 1024) return false;
  } catch { return false; }
  if (!fs.existsSync(PATHS.FFPROBE)) return true;   // 没有 ffprobe 就不阻断流程
  const p = probeMedia(filePath);
  if (!p) return false;
  // 至少要有时长；视频文件还必须有分辨率
  if (!p.duration || p.duration <= 0) return false;
  const isAudioOnly = /\.(mp3|m4a|opus|flac|wav|aac)$/i.test(filePath);
  if (!isAudioOnly && !p.height) return false;
  return true;
}

/**
 * 合并成功后清理中间分片（.fXXX.mp4 / .fXXX.webm 等）。
 * yt-dlp 默认会自己删，但下载被中断时它来不及删，残留文件既占地方
 * 又会在下次下载时被当成"已存在的分片"参与合并 → 直接把任务搞坏。
 */
function cleanupFormatFiles(dir, video, finalFile) {
  const base = path.basename(finalFile || '', path.extname(finalFile || ''));
  if (!base) return 0;
  let removed = 0;
  const walk = (d, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (full === finalFile) continue;
      // 只删"同名前缀 + 分片后缀"的中间产物，绝不误删别的成品
      const stem = e.name.replace(/\.[^.]+$/, '');
      if (stem.startsWith(base + '.') && /\.f\d+$/i.test(stem)) {
        try { fs.unlinkSync(full); removed++; } catch {}
      }
    }
  };
  walk(dir);
  return removed;
}

module.exports = {
  DownloadQueue, probeMedia, killTree, readTail, TRANSCODE_PRESETS,
  isPlayable, cleanupFormatFiles, stageLabel, POST_STAGE_RE,
};
