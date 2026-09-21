'use strict';
/**
 * 下载调度器 —— 队列驱动 + 单任务生命周期。
 *
 * ═══════════════════════════════════════════════════════════════════
 *  这个文件里有三处**绝对不能动**的时序约束，每一处都对应一次真实事故。
 *  重构这个文件之前，请先读完下面三段。
 * ═══════════════════════════════════════════════════════════════════
 *
 * 【约束 1】kick() 必须**异步**调度（README 坑 13，最严重的一次）
 *
 *   曾经的写法是 `kick()` 里直接同步调 `_schedule()`，而 `_start()` 是 async
 *   （里面有 `await canEmbedThumbnail()`）。于是：
 *     _start 跑到 await 让出控制权 → 此刻任务状态**还是 queued**
 *     → 任何 kick() 都会把它重新捞起来 → 又同步跑到 await → 又 kick …
 *   **同一毫秒内 _start 被调用上千次**，堆内存每秒涨约 50MB，
 *   服务端跑不到 2 分钟就 `FATAL ERROR: Reached heap limit`。
 *
 *   三道防线，少一道都不行：
 *     ① kick() 用 setImmediate 打断同步递归链（本文件）
 *     ② _schedule() 在调用 _start() **之前**就占住 running 槽位（本文件）
 *     ③ _start() 在**任何 await 之前**完成状态迁移（本文件）
 *
 * 【约束 2】_start() 的状态迁移必须在第一个 await 之前
 *
 *   理由同上。只要"任务还在 queued 状态时把控制权交出去"，
 *   递归链就会重新连上。
 *
 * 【约束 3】只有"下载开始之后"的后处理器才算进入后处理（README 坑 9）
 *
 *   yt-dlp 的 ThumbnailsConvertor 会在**下载开始之前**先跑一次。
 *   早期代码一见到任何 postprocessor 就把进度顶到 99、状态改成"处理中"，
 *   结果进度条从开场就被钉死在 99%，而真实下载从 0.1% 一路走到 99.4%，
 *   整个过程（689MB / 4 分钟）用户看不到任何进度。
 *   判据必须是「已见过下载进度 **且** 出现了 Merger/ExtractAudio 这类
 *   真正的后期处理」。
 *
 * ── 另外两条工程约定 ──────────────────────────────────────────────
 *   · 进度靠**轮询 tail 日志文件**拿到，不用管道（沙箱会拒，见 infra/subprocess）
 *   · 关掉服务时所有定时器/子进程都要清干净，否则进程退不出来
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { STATUS } = require('../infra/config');
const { parseProgressLine, POST_STAGE_RE } = require('../infra/progress');
const { readTail, killTree } = require('../infra/subprocess');
const { transition } = require('../domain/job-state');
const { fromEngineOutput, ValidationError } = require('../domain/errors');

/** 进度轮询间隔。700ms 是"够跟手"和"别把磁盘读爆"之间的折中。 */
const POLL_MS = 700;

/** 单次读日志的上限。万一 offset 被重置或日志异常巨大，也不会一次性 alloc 出天文数字。 */
const MAX_READ = 256 * 1024;

/** 进度广播限流：别把前端刷爆 */
const BROADCAST_THROTTLE_MS = 400;

/**
 * @param {object} config
 * @param {object} deps
 * @param {object} deps.repo        数据库仓储
 * @param {object} deps.downloader  引擎适配层
 * @param {object} deps.media       文件级工具
 * @param {object} deps.settings    () => 已合并默认值的设置
 * @param {object} [deps.urldiag]   解析失败时的诊断（可选）
 */
function createScheduler(config, deps) {
  const { paths } = config;
  const { repo, downloader, media, settings } = deps;
  const urldiag = deps.urldiag || null;

  const emitter = new EventEmitter();

  /** videoId → job。**存在即代表占用了一个并发槽位。** */
  const running = new Map();
  /** videoId → interval */
  const timers = new Map();
  /** 已因"文件损坏"自动重下过的任务（防止坏源无限循环） */
  const autoRetry = new Set();

  let kickPending = false;
  let stopped = false;
  let scheduleTimer = null;

  // ---------------------------------------------------------------- 广播

  function broadcast(id, extra = {}) {
    if (stopped) return;
    const v = repo.getVideo(id);
    if (!v) return;
    emitter.emit('progress', { ...v, ...extra });
  }

  function emitQueue() {
    if (!stopped) emitter.emit('queue', snapshot());
  }

  function notice(message, id = null) {
    emitter.emit('notice', { id, message });
  }

  // ---------------------------------------------------------------- 队列驱动

  function concurrency() {
    return Math.max(1, Number(settings().concurrency || 2));
  }

  function activeCount() {
    return running.size;
  }

  function snapshot() {
    const rows = repo.listByStatuses([
      STATUS.QUEUED, STATUS.PARSING, STATUS.DOWNLOADING, STATUS.PROCESSING,
    ]);
    return {
      active: running.size,
      concurrency: concurrency(),
      running: rows.map((r) => ({
        id: r.id, title: r.title, status: r.status, progress: r.progress,
        speed: r.speed, eta: r.eta, kind: r.kind, site: r.site,
        uploader: r.uploader, error: r.error,
      })),
    };
  }

  /**
   * 叫醒调度器：有新任务或槽位空出来了。
   *
   * ⚠️ 必须异步（约束 1）。setImmediate 打断同步递归链 ——
   *    就算调用方在一个循环里 kick() 一千次，也只会调度一次 _schedule()。
   */
  function kick() {
    if (stopped) return;
    if (kickPending) return;
    kickPending = true;
    scheduleTimer = setImmediate(() => {
      scheduleTimer = null;
      kickPending = false;
      schedule();
    });
  }

  /** 状态迁移的唯一入口：先过状态机，再落库 */
  function setStatus(id, next, patch = {}, context = '') {
    const cur = repo.getVideo(id);
    if (!cur) return null;
    transition(cur.status, next, { context: context || `任务 ${id}` });
    return repo.updateVideo(id, { status: next, ...patch });
  }

  function schedule() {
    if (stopped) return;

    // 兜底：状态是"进行中"但进程不在跑（多半是上次崩溃残留），修正为暂停，
    // 交给用户决定要不要继续。这一步同时也清掉了"同一个任务被并行启动"的可能。
    const stuck = repo.listByStatuses([STATUS.PARSING, STATUS.DOWNLOADING, STATUS.PROCESSING])
      .filter((r) => !running.has(r.id));
    for (const r of stuck) {
      transition(r.status, STATUS.PAUSED, { context: `崩溃残留任务 ${r.id}` });
      repo.updateVideo(r.id, { status: STATUS.PAUSED, error: '任务已中断，可点继续重下' });
      broadcast(r.id);
    }

    const limit = concurrency();
    while (running.size < limit) {
      const next = repo.listByStatus(STATUS.QUEUED, 1)[0];
      if (!next) break;
      if (running.has(next.id)) break;   // 防重入

      // ⚠️ 约束 1 的第 ②道防线：**在调用 _start 之前**就占住槽位。
      //    这样"已占用"从调度那一刻就成立，不依赖 _start 内部多快改状态。
      running.set(next.id, { id: next.id, starting: true, child: null });
      startJob(next).catch((err) => {
        running.delete(next.id);
        fail(next.id, `启动失败: ${err.message}`);
      });
    }
    emitQueue();
  }

  // ---------------------------------------------------------------- 单任务

  async function startJob(video) {
    const st = settings();

    // ⚠️ 约束 1 的第 ③道防线 + 约束 2：
    //    **必须在任何 await 之前**把任务移出 queued。
    //    否则 await 让出控制权时它还是 queued，会被反复捞起来启动。
    setStatus(video.id, video.title ? STATUS.DOWNLOADING : STATUS.PARSING,
      { error: null }, `启动任务 ${video.id}`);
    broadcast(video.id);

    // ---- 1) 补元数据（队列里的任务可能只有 url）
    if (!video.title) {
      try {
        const meta = await downloader.probeMetadata(video.url);
        if (meta) {
          repo.updateVideo(video.id, {
            title: meta.title, uploader: meta.uploader, upload_date: meta.upload_date,
            duration: meta.duration, description: meta.description,
            thumbnail_url: meta.thumbnail_url, video_id: meta.video_id,
            extractor: meta.extractor, site: meta.site,
            width: meta.width, height: meta.height, fps: meta.fps,
          });
        }
      } catch (err) {
        fail(video.id, await explainParseFailure(err, video.url));
        return;
      }
    }

    // ---- 2) 决定要不要嵌封面
    //    ffmpeg 处理不了 avif/heic，硬嵌会让**已经下完的视频**被判失败
    //    （实测 xvideos 的 avif 封面把 303MB 的任务搞挂了）。
    //    所以先探明格式，只对确定支持的格式开 --embed-thumbnail。
    const fresh = repo.getVideo(video.id);
    let embedThumb = false;
    if (st.embedThumbnail !== false) {
      if (fresh.thumb_embed_ok === true || fresh.thumb_embed_ok === false) {
        embedThumb = fresh.thumb_embed_ok;      // 用上次的结论，不重复探测
      } else {
        const verdict = await downloader.canEmbedThumbnail(fresh.thumbnail_url);
        embedThumb = verdict.ok;
        repo.updateVideo(video.id, {
          thumb_embed_ok: verdict.ok ? 1 : 0,
          thumb_format: verdict.format,
        });
        if (!verdict.ok) notice(`跳过封面嵌入：${verdict.reason}`, video.id);
      }
    }

    // ---- 3) 起进程
    const cur = repo.getVideo(video.id);
    setStatus(video.id, STATUS.DOWNLOADING, { error: null, progress: 0 }, `开下 ${video.id}`);

    const { child, logPath, resultFile } = downloader.startDownload(cur || fresh, st, {
      // 续传判据：已经有成品文件，或者上次是暂停/失败
      resume: Boolean((cur || fresh).file_path)
        || [STATUS.PAUSED, STATUS.FAILED].includes((cur || fresh).status),
      embedThumbnail: embedThumb,
    });

    // 复用 schedule() 预先占好的槽位
    const job = running.get(video.id) || {};
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
      downloading: false,     // 是否已经收到过下载进度（约束 3 的关键状态）
      lastPercent: null,      // 上一帧百分比，用于探测"切换到下一条流"
      streamIndex: 0,         // 第几条流（视频流/音频流各自 0→100%）
      destinationCount: 0,
      pipeline: [],           // 已出现过的后处理器（按 started 顺序）
      pipelineSeen: new Set(),
      starting: false,
    });
    running.set(video.id, job);
    repo.updateVideo(video.id, { log_path: logPath });
    broadcast(video.id);
    emitQueue();

    // 顺便把登录态配置的问题写进任务日志 —— 用户能看到"为什么登录态没生效"
    const cookieNote = downloader.takeCookieNote ? downloader.takeCookieNote() : null;
    if (cookieNote) {
      try { fs.appendFileSync(logPath, `[登录态] ${cookieNote}\n`); } catch { /* 忽略 */ }
    }

    // ---- 4) 轮询 tail 日志读进度（不能用 pipe）
    const timer = setInterval(() => tail(job), POLL_MS);
    timers.set(video.id, timer);

    child.on('error', (err) => {
      cleanup(video.id);
      fail(video.id, `进程启动失败: ${err.message}`);
    });

    child.on('close', (code) => {
      cleanup(video.id);
      finish(video.id, code, job).catch((err) => fail(video.id, err.message));
    });
  }

  /** 解析失败时给一句**有用**的话 */
  async function explainParseFailure(err, url) {
    let msg = `解析失败: ${err.message}`;
    // yt-dlp 对"页面链接"只会说 "Unsupported URL"，用户完全不知道下一步做什么
    // （实测：粘 https://www.xvideos.com/best/2026-08 这种列表页就是这句）。
    // 额外抓一下那个页面，判断它到底是列表页还是根页面，再写成可读提示。
    if (urldiag && /unsupported url|no video|unable to extract/i.test(err.message)) {
      try {
        const diag = await urldiag.diagnoseUnsupported(url);
        msg = urldiag.explain(diag, url);
      } catch { /* 诊断本身失败就保持原报错 */ }
    } else if (!urldiag) {
      // 没有诊断模块时，至少给一句方向性提示
      const classified = fromEngineOutput(err.message, { url });
      msg = classified.toUserText();
    }
    return msg;
  }

  /**
   * 诊断快照：**把内存里的并发状态暴露出来**。
   *
   * 起因是一次真实的排障：`/api/queue` 报 `active=2, concurrency=2`，
   * 可库里只有 1 条进行中的任务、而且它一条事件都没写过（说明压根没启动）。
   * 结论是 `running` 这个内存 Map 里有个**不属于任何现存任务的幽灵条目**
   * 占着槽位 —— 但这只是推断：从外面看不到 `running` 里到底有谁。
   *
   * 所以这里把"调度器自己以为在跑什么"与"库里实际存在的任务"**并排列出来**，
   * 对不上就是幽灵。以后遇到"以为有任务在跑但其实没有"不用再猜。
   *
   * ⚠️ 只读，无副作用。
   */
  function diagnostics() {
    const dbActive = repo.listByStatuses([
      STATUS.QUEUED, STATUS.PARSING, STATUS.DOWNLOADING, STATUS.PROCESSING,
    ]).map((r) => ({ id: r.id, status: r.status }));

    const ids = [...running.keys()];
    const dbIds = new Set(dbActive.map((r) => r.id));
    // 幽灵 = 内存里有、但库里已经没有任何进行中的状态对应它
    const ghosts = ids.filter((id) => !dbIds.has(id));

    return {
      limit: concurrency(),
      inMemory: ids.length,
      dbActive: dbActive.length,
      slotsFree: Math.max(0, concurrency() - ids.length),
      /** 内存里占着槽位的任务 id */
      memoryIds: ids,
      /** 库里处于进行中状态的任务（含排队中） */
      dbIds: dbActive,
      /** ⚠️ 非空 = 槽位泄漏：这些 id 占着槽位却没有对应的进行中任务 */
      ghosts,
      timers: timers.size,
      jobs: ids.map((id) => {
        const j = running.get(id);
        return {
          id,
          starting: Boolean(j && j.starting),
          hasChild: Boolean(j && j.child),
          stage: (j && j.stage) || null,
          runningMs: j && j.startedAt ? Date.now() - j.startedAt : null,
        };
      }),
    };
  }

  function cleanup(id) {
    const t = timers.get(id);
    if (t) { clearInterval(t); timers.delete(id); }
    running.delete(id);
  }

  /**
   * 读日志文件的新增部分，逐行解析成进度。
   *
   * 为什么是"增量读 + 保留半行"：日志是边写边读的，最后一行随时可能只写了一半；
   * 直接按整行解析会丢掉那半行（或解析出错误的数值）。所以 buffer 住留到下次。
   */
  function tail(job) {
    if (stopped || !job.child || !job.logPath) return;

    let st;
    try { st = fs.statSync(job.logPath); } catch { return; }
    if (st.size < job.offset) job.offset = 0;      // 日志被重置
    if (st.size === job.offset) return;

    const len = Math.min(st.size - job.offset, MAX_READ);
    let chunk = '';
    try {
      const fd = fs.openSync(job.logPath, 'r');
      const buf = Buffer.allocUnsafe(len);
      const got = fs.readSync(fd, buf, 0, len, job.offset);
      fs.closeSync(fd);
      chunk = buf.subarray(0, got).toString('utf8');
      job.offset += got;
    } catch { return; }

    const lines = (job.buffer + chunk).split(/\r?\n/);
    job.buffer = lines.pop() ?? '';   // 最后一行可能不完整，留到下次

    const patch = {};
    let dirty = false;

    for (const line of lines) {
      const ev = parseProgressLine(line);
      if (!ev) continue;

      switch (ev.type) {
        case 'progress':
          if (ev.percent !== null) patch.progress = ev.percent;
          if (ev.speed !== null) patch.speed = ev.speed;
          if (ev.eta !== null) patch.eta = ev.eta;
          // 收到下载进度 = 确实处于下载阶段（约束 3 的判据之一）
          // yt-dlp 的多条流会**各自从 0% 走到 100%**，所以百分比显著回退
          // 说明切换到下一条流了 —— 要标出来，否则用户以为进度条坏了。
          if (ev.percent !== null && job.lastPercent !== null && ev.percent < job.lastPercent - 10) {
            job.streamIndex += 1;
          }
          if (ev.percent !== null) job.lastPercent = ev.percent;
          job.downloading = true;
          job.stage = '下载中';
          dirty = true;
          break;

        case 'postprocess':
          // ⚠️ 这里**绝不能**改 status/progress（约束 3）。
          //    只把它记进 pipeline 列表，等 child 退出后由 finish() 决定终态。
          if (ev.status === 'started' || ev.status === 'finished') {
            const key = `${ev.stage}:${ev.status}`;
            if (!job.pipelineSeen.has(key)) {
              job.pipelineSeen.add(key);
              if (ev.status === 'started') job.pipeline.push(ev.stage);
            }
          }
          break;

        case 'destination':
          job.destinationCount += 1;
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

    // 状态推进：只有"下载确实开始了、正在跑 ffmpeg 后处理"才算 processing（约束 3）
    if (!patch.error) {
      const inPost = job.downloading && job.pipeline.some((p) => POST_STAGE_RE.test(p));
      patch.status = inPost ? STATUS.PROCESSING : STATUS.DOWNLOADING;
    }

    if (dirty || patch.status) {
      // 状态变化要先过状态机（非严格模式：这是高频路径，
      // 一次意外转换不该让正在跑的下载崩掉 —— 打警告并按原样继续）
      if (patch.status) {
        const cur = repo.getVideo(job.id);
        if (cur && cur.status !== patch.status) {
          transition(cur.status, patch.status, { context: `任务 ${job.id} 进度推进` });
        }
      }
      repo.updateVideo(job.id, patch);

      const now = Date.now();
      if (now - job.lastEmit > BROADCAST_THROTTLE_MS) {
        job.lastEmit = now;
        broadcast(job.id, { stage: stageLabel(job) });
      }
    }
  }

  function fail(id, message) {
    const text = String(message).slice(0, 500);
    setStatus(id, STATUS.FAILED, { error: text }, `任务 ${id} 失败`);
    broadcast(id);
    emitQueue();
    kick();
  }

  /** 进程退出后的收尾：探测文件、抓封面、入库 */
  async function finish(id, code, job) {
    const v = repo.getVideo(id);
    if (!v) return;

    if (job.killing) {
      setStatus(id, STATUS.PAUSED, { error: '已暂停，可点继续' }, `任务 ${id} 已暂停`);
      broadcast(id);
      kick();
      return;
    }

    if (code !== 0) {
      const log = readTail(job.logPath, 4000);
      const raw = require('../infra/progress').cleanError(log) || `yt-dlp 退出码 ${code}`;
      fail(id, fromEngineOutput(raw, { url: v.url }).toUserText());
      return;
    }

    // ---- 找最终文件：优先读 --print-to-file 的结果（UTF-8，中文路径不会乱码），
    //      其次用日志里捕获的路径，最后按时间扫下载目录兜底。
    let filePath = downloader.readResultFile(job.resultFile);
    if (!filePath && job.sawFile && fs.existsSync(job.sawFile)) filePath = job.sawFile;
    if (!filePath) filePath = media.findNewest(deps.downloadDir(), { since: job.startedAt });

    // ---- 完整性校验（README 坑 11）：文件"存在"不等于"完整"
    //
    // 判据是 ffprobe **实测**，不是 fs.existsSync。
    // 实测不通过就清掉残留 + 自动重下一次（只重一次，避免坏源无限循环）。
    if (filePath && fs.existsSync(filePath)) {
      const verdict = media.inspect(filePath);
      if (!verdict.ok) {
        const detail = require('../infra/progress').cleanError(readTail(job.logPath, 4000));
        media.cleanupFormatFiles(deps.downloadDir(), v, filePath);
        try { fs.unlinkSync(filePath); } catch { /* 删不掉就让它在原地 */ }

        if (!autoRetry.has(id)) {
          autoRetry.add(id);
          setStatus(id, STATUS.QUEUED, {
            progress: 0, speed: 0, eta: 0,
            error: `输出文件不合格（${verdict.reason}），已清理并自动重新下载一次`,
          }, `任务 ${id} 损坏重下`);
          broadcast(id);
          emitQueue();
          kick();
          return;
        }
        autoRetry.delete(id);
        fail(id, `文件不合格且重下仍失败：${verdict.reason}${detail ? `（${detail}）` : ''}`);
        return;
      }

      // 没验过（缺 ffprobe）也要说出来 —— 不能让"没验"看起来像"验过了"
      if (!verdict.verified) {
        notice(`提示：${verdict.reason}，本次按可用处理`, id);
      }
    }

    const patch = {
      status: STATUS.DONE, progress: 100, speed: 0, eta: 0, error: null,
      finished_at: new Date().toISOString(),
    };
    if (filePath && fs.existsSync(filePath)) {
      const st = fs.statSync(filePath);
      patch.file_path = filePath;
      patch.file_size = st.size;
      patch.container = path.extname(filePath).replace('.', '');
      const probe = media.probe(filePath);
      if (probe) Object.assign(patch, probe);
      const thumb = media.grabThumbnail(v, filePath);
      if (thumb) patch.thumbnail_path = thumb;
      // 合并成功后清理中间分片，避免同目录残留 .fXXX 文件
      media.cleanupFormatFiles(deps.downloadDir(), v, filePath);
      autoRetry.delete(id);
    } else if (job.alreadyExisted) {
      patch.error = '文件已存在，跳过下载';
    } else {
      patch.status = STATUS.FAILED;
      patch.error = '下载进程正常退出，但没找到输出文件';
    }

    if (patch.status !== v.status) {
      transition(v.status, patch.status, { context: `任务 ${id} 收尾` });
    }
    repo.updateVideo(id, patch);
    broadcast(id);
    emitQueue();

    // ---- 同一文件已存在别的记录 → 合并
    //      避免"重建的占位记录 + 用户重粘的真实 URL"变成同一个文件两条记录
    try {
      const merged = repo.dedupeByFile(id);
      if (merged) {
        notice(`发现同一文件的重复记录，已自动合并（清理 ${merged.removed} 条）`, merged.kept);
        broadcast(merged.kept);
      }
    } catch { /* 合并失败不影响下载结果 */ }

    kick();
  }

  // ---------------------------------------------------------------- 外部操作

  /**
   * 暂停：杀进程，保留 .part，状态置 paused。
   *
   * ⚠️ 窗口期判空：child 在"已占槽位但进程还没起来"时是 null。
   *    直接写 `job.child.pid` 会抛 "Cannot read properties of null"，
   *    用户看到的就是一句莫名其妙的报错（这个 bug 真实发生过）。
   */
  function pause(id) {
    const job = running.get(id);
    if (job) {
      job.killing = true;
      if (job.child && job.child.pid) {
        killTree(job.child.pid);
      } else {
        setStatus(id, STATUS.PAUSED, { error: '已暂停（进程尚未启动）' }, `暂停 ${id}`);
        broadcast(id);
      }
      return true;
    }
    const v = repo.getVideo(id);
    if (v && v.status === STATUS.QUEUED) {
      setStatus(id, STATUS.PAUSED, { error: '已暂停' }, `暂停排队中的 ${id}`);
      broadcast(id);
      return true;
    }
    return false;
  }

  /**
   * 继续：把 paused/failed/canceled 的任务重新排进队列。
   * `force` 时允许从任意状态回到队列（界面上的「重新下载」）。
   */
  function resume(id, { force = false } = {}) {
    const v = repo.getVideo(id);
    if (!v) return false;
    if (![STATUS.PAUSED, STATUS.FAILED, STATUS.CANCELED].includes(v.status) && !force) return false;
    autoRetry.delete(id);   // 用户手动重试 → 给"损坏重下"再来一次的机会
    setStatus(id, STATUS.QUEUED, { error: null, progress: 0, speed: 0 }, `继续 ${id}`);
    broadcast(id);
    kick();
    return true;
  }

  /** 取消：停进程，可选删掉半截文件（**绝不动已完成的正式文件**） */
  function cancel(id, { deletePart = true } = {}) {
    const job = running.get(id);
    if (job) {
      job.killing = true;
      if (job.child && job.child.pid) killTree(job.child.pid);
    } else {
      cleanup(id);
    }

    const v = repo.getVideo(id);
    if (deletePart && v) {
      media.removePartials(deps.downloadDir(), v);
    }
    setStatus(id, STATUS.CANCELED, { progress: 0, speed: 0, eta: 0 }, `取消 ${id}`);
    broadcast(id);
    emitQueue();
    kick();
    return true;
  }

  /** 把所有失败的任务重新排队 */
  function retryFailed() {
    const rows = repo.listByStatus(STATUS.FAILED, 10000);
    for (const r of rows) {
      autoRetry.delete(r.id);
      setStatus(r.id, STATUS.QUEUED, { error: null, progress: 0 }, `重试 ${r.id}`);
    }
    kick();
    return rows.length;
  }

  /** 全部暂停（关站前调用） */
  function pauseAll() {
    const ids = [...running.keys()];
    for (const id of ids) pause(id);
    const queued = repo.listByStatus(STATUS.QUEUED, 10000);
    for (const q of queued) {
      transition(q.status, STATUS.PAUSED, { context: `全部暂停 ${q.id}` });
      repo.updateVideo(q.id, { status: STATUS.PAUSED, error: '已暂停' });
    }
    return ids.length + queued.length;
  }

  /** 服务启动时：把上次没跑完的任务标 paused（**手动继续才续**，不偷偷跑流量） */
  function recoverStale() {
    const ids = repo.markStaleActiveAsPaused();
    for (const id of ids) broadcast(id);
    kick();
    return ids;
  }

  /** 停掉一切：清定时器、杀子进程。**不调它进程退不出来。** */
  function stop() {
    stopped = true;
    if (scheduleTimer) { clearImmediate(scheduleTimer); scheduleTimer = null; }
    for (const [, t] of timers) clearInterval(t);
    timers.clear();
    for (const [, job] of running) {
      if (job.child && job.child.pid) killTree(job.child.pid);
    }
    running.clear();
    emitter.removeAllListeners();
  }

  return {
    // 事件：progress / queue / notice
    on: (...a) => emitter.on(...a),
    off: (...a) => emitter.off(...a),
    // 队列
    kick, snapshot, activeCount, concurrency, diagnostics,
    // 单任务操作
    pause, resume, cancel, retryFailed, pauseAll, recoverStale,
    // 生命周期
    stop,
    /** 供测试断言 —— 生产代码别用 */
    _running: running,
    _timers: timers,
  };
}

/**
 * 给前端看的阶段文案。
 *
 * 多流下载时明确标出"第几条流"：视频流和音频流会**各自从 0% 走到 100%**，
 * 不说明的话用户会以为进度条坏了（百分比归零）。
 */
function stageLabel(job) {
  const post = job.pipeline.filter((p) => POST_STAGE_RE.test(p));
  if (job.downloading && post.length) return `处理中 · ${post[post.length - 1]}`;
  if (job.downloading) {
    return job.streamIndex > 0 ? `下载中（第 ${job.streamIndex + 1} 条流）` : '下载中';
  }
  return job.stage || '下载中';
}

module.exports = { createScheduler, stageLabel, POLL_MS, MAX_READ, BROADCAST_THROTTLE_MS };
