'use strict';
/**
 * 下载引擎适配层：把"怎么调 yt-dlp"关在这一层里。
 *
 * 这是**唯一**知道 yt-dlp 命令行长什么样的地方。上层只表达意图
 * （"取元数据"、"下这个任务"、"展开这个列表"），不拼参数。
 *
 * 重构前这套逻辑和队列调度、数据库写入混在 700 行的 queue.js 里，
 * 结果是"改一个 yt-dlp 参数"要在一堆状态迁移代码里翻找。
 */

const fs = require('node:fs');
const path = require('node:path');

const { runSync, spawnToFile, probeBinary, childEnv } = require('../infra/subprocess');
const {
  PROGRESS_TEMPLATE, POSTPROCESS_TEMPLATE, cleanError,
} = require('../infra/progress');
const { normalizeInfo } = require('../domain/video');
const { EngineError } = require('../domain/errors');
const { cookieArgs } = require('./cookies');

/** 清晰度 → yt-dlp 的 -f 表达式 */
const QUALITY_MAP = Object.freeze({
  best: 'bv*+ba/b',
  worst: 'wv*+wa/w',
  '2160p': 'bv*[height<=2160]+ba/b[height<=2160]',
  '1440p': 'bv*[height<=1440]+ba/b[height<=1440]',
  '1080p': 'bv*[height<=1080]+ba/b[height<=1080]',
  '720p': 'bv*[height<=720]+ba/b[height<=720]',
  '480p': 'bv*[height<=480]+ba/b[height<=480]',
  '360p': 'bv*[height<=360]+ba/b[height<=360]',
});

/** 被用户-Agent 骗过的站点太多，统一装成桌面 Chrome */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * @param {object} config loadConfig() 产物
 * @param {object} [options]
 * @param {object} [options.fetchImpl] 注入 fetch（测试用）
 */
function createDownloader(config, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const { paths } = config;

  /** 上一次调用里登录态配置的问题（取一次就清空，避免粘到下一次下载上） */
  let lastCookieNote = null;

  function takeCookieNote() {
    const n = lastCookieNote;
    lastCookieNote = null;
    return n;
  }

  // ---------------------------------------------------------------- 健康检查

  /** 两个引擎能不能用（启动自检、/api/health 用） */
  function binaryInfo() {
    return {
      ytdlp: probeBinary(paths.ytdlp, ['--version']),
      ffmpeg: probeBinary(paths.ffmpeg, ['-version']),
    };
  }

  // ---------------------------------------------------------------- 参数构造

  /**
   * 通用参数：任何一次 yt-dlp 调用都带上。
   *
   * @param {object} settings 已合并默认值的设置
   * @param {string} [resultFile] 最终文件路径用 --print-to-file 写到这里。
   *   为什么不走 stdout：中文路径经 fd 重定向会被按 GBK 编码写坏（见 infra/subprocess）。
   *   --print-to-file 由 yt-dlp 自己以 UTF-8 落盘，路径绝对不会乱码。
   */
  function commonArgs(settings = {}, resultFile) {
    const args = [
      '--no-warnings',
      '--no-colors',
      '--ignore-config',          // 不受用户全局 yt-dlp 配置干扰，行为可预期
      '--no-playlist',            // 单视频任务默认只下一个；播放列表由我们显式展开
      '--no-mtime',
      '--socket-timeout', '20',
      '--retries', String(settings.retries ?? 2),
      '--fragment-retries', String(settings.retries ?? 2),
      '--extractor-retries', '2',
      '--user-agent', USER_AGENT,
      '--newline',
      '--progress',
      '--progress-template', PROGRESS_TEMPLATE,
      '--progress-template', POSTPROCESS_TEMPLATE,
    ];

    if (resultFile) {
      args.push('--print-to-file', 'after_move:%(filepath)s', resultFile);
    }
    // 供失败定位的轻量标记（纯 ASCII，不受编码影响）
    args.push('--print', 'before_dl:VVAULT_META:%(id)s|%(extractor)s');

    if (fs.existsSync(paths.ffmpeg)) args.push('--ffmpeg-location', paths.ffmpeg);

    const rl = Number(settings.rateLimitMB || 0);
    if (rl > 0) args.push('--limit-rate', `${rl}M`);
    const fc = Number(settings.fragmentConcurrency || 4);
    if (fc > 1) args.push('--concurrent-fragments', String(fc));

    // 登录态（二期）
    const c = cookieArgs(settings);
    if (c.args.length) args.push(...c.args);
    // ⚠️ 配置有问题时不能往 args 里塞自定义参数（yt-dlp 不认识会直接报错），
    //    也不能静默跳过（用户以为开了登录态、其实没开）。记下来带回去。
    if (c.warning) lastCookieNote = c.warning;

    return args;
  }

  /**
   * 输出路径模板：站点/作者/标题 [清晰度].ext
   * yt-dlp 会自动清洗文件名里的非法字符，并对过长标题截断。
   */
  function outtmpl(settings, kind) {
    const parts = ['%(extractor_key)s'];
    if (settings.organizeByUploader !== false) parts.push('%(uploader|unknown)s');
    if (kind === 'audio') {
      // 音频任务不带清晰度后缀，命名更干净
      parts.push('%(title).120B.%(ext)s');
    } else {
      parts.push('%(title).120B [%(height)sp%(format_id)s].%(ext)s');
    }
    return path.join(settings.downloadDir || paths.downloads, ...parts);
  }

  /**
   * 组装一次下载的参数。
   *
   * @param {object} video    {url, kind, quality}
   * @param {object} settings 已合并默认值的设置
   * @param {object} [opts]   {resume, resultFile, embedThumbnail}
   */
  function buildDownloadArgs(video, settings = {}, opts = {}) {
    const kind = video.kind === 'audio' ? 'audio' : 'video';
    const quality = video.quality || 'best';
    const args = [...commonArgs(settings, opts.resultFile)];

    if (kind === 'audio') {
      args.push('-x', '--audio-format', settings.audioFormat || 'mp3', '--audio-quality', '0');
    } else {
      args.push('-f', QUALITY_MAP[quality] || QUALITY_MAP.best);
      // 统一合并进 mkv：YouTube 高清普遍是 vp9/av1 + opus，
      // mp4 容器装不下，强行 mp4 会让合并直接失败（README 坑 5）。
      args.push('--merge-output-format', 'mkv');
    }

    args.push('--embed-metadata');
    // 封面嵌入是"加分项"，不能因为封面格式不被 ffmpeg 支持就把整个下载判失败。
    // 实测：xvideos 提供 .avif 封面，而 ffmpeg 没有 avif 解码器，
    // --embed-thumbnail 会报 "Error opening output files: Invalid argument"，
    // 结果 303MB 的视频明明下完了，任务却显示失败。
    // 所以先探明封面格式，只对确定能处理的格式才开启嵌入（见 canEmbedThumbnail）。
    if (opts.embedThumbnail) {
      args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
    }

    if (opts.resume) {
      // 续传：保留 .part 接着下，已完成的文件不重复覆盖
      args.push('--continue', '--no-overwrites', '--part');
    } else {
      args.push('--continue', '--part');
    }

    args.push('-o', outtmpl(settings, kind));
    args.push('--', video.url);
    return args;
  }

  // ---------------------------------------------------------------- 封面探测

  /**
   * 判断一个封面能不能被 ffmpeg 嵌入。
   *
   * yt-dlp 的 --convert-thumbnails 只支持 jpg / png / webp 三种互转；
   * 别的格式（实测遇到 avif）它转不了，原样丢给 ffmpeg，
   * 而 ffmpeg 这版没有 avif 解码器 → 嵌入失败 → 整个任务被判失败。
   */
  async function canEmbedThumbnail(url, { timeout = 8000 } = {}) {
    if (!url) return { ok: false, format: null, reason: '没有封面地址' };

    // 1) 先看 URL 后缀，最省事
    const byExt = String(url).match(/\.(jpe?g|png|webp|avif|gif|bmp|heic|heif)(?:[?#]|$)/i);
    if (byExt) {
      const ext = byExt[1].toLowerCase().replace('jpeg', 'jpg');
      const ok = ['jpg', 'png', 'webp'].includes(ext);
      return {
        ok, format: ext,
        reason: ok ? `URL 后缀 .${ext} 可嵌入` : `URL 后缀 .${ext} 不被 ffmpeg 支持`,
      };
    }

    // 2) 后缀看不出来就发个 HEAD 看 content-type
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'HEAD', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' },
        });
      } finally {
        clearTimeout(timer);
      }
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      const m = ct.match(/image\/(jpeg|jpg|png|webp|avif|gif|bmp|heic|heif)/);
      if (m) {
        const fmt = m[1] === 'jpeg' ? 'jpg' : m[1];
        const ok = ['jpg', 'png', 'webp'].includes(fmt);
        return { ok, format: fmt, reason: `Content-Type 为 ${fmt}` };
      }
    } catch (e) {
      return { ok: false, format: null, reason: `无法确认封面格式（${e.message}），保守起见不嵌入` };
    }

    // 3) 完全查不到 → 保守不嵌，宁可少个封面也不要任务失败
    return { ok: false, format: null, reason: '无法确认封面格式，保守起见不嵌入' };
  }

  // ---------------------------------------------------------------- 元数据

  /**
   * 取元数据，可额外带上指定参数（用于「登录态自检」这类要临时加 --cookies 的场景）。
   *
   * 为什么不改设置再改回来：那会留下中间状态，中途失败用户就莫名其妙被改了配置。
   *
   * @returns {{ok:boolean, title:string, error:string, info:object|null}}
   */
  function probeWithArgs(url, extraArgs = [], { timeout = 30000 } = {}) {
    const args = [
      '--ignore-config', '--no-warnings', '--no-colors',
      '--no-playlist', '--skip-download', '--no-check-certificates',
      ...extraArgs,
      '-J', '--', url,
    ];
    if (fs.existsSync(paths.ffmpeg)) args.unshift('--ffmpeg-location', paths.ffmpeg);

    const r = runSync(paths.ytdlp, args, { timeout });
    if (!r.ranOk) {
      return { ok: false, title: '', error: `yt-dlp 没能启动（${r.error}）`, info: null, status: null };
    }
    const text = (r.stdout || '').trim();
    const start = text.indexOf('{');
    if (start === -1) {
      return {
        ok: false, title: '',
        error: cleanError(text) || `yt-dlp 退出码 ${r.status}`,
        info: null, status: r.status,
      };
    }
    try {
      const info = JSON.parse(text.slice(start));
      return { ok: true, title: info.title || '', error: '', info: normalizeInfo(info), status: r.status };
    } catch {
      return {
        ok: false, title: '',
        error: cleanError(text) || '元数据 JSON 解析失败',
        info: null, status: r.status,
      };
    }
  }

  /** 取单条视频元数据（不下载）。返回归一化对象，失败抛错。 */
  function probeMetadata(url, { timeout = 90000 } = {}) {
    const r = probeWithArgs(url, [], { timeout });
    if (!r.ok) {
      const { ProviderError } = require('../domain/errors');
      const { fromEngineOutput } = require('../domain/errors');
      throw fromEngineOutput(r.error, { url });
    }
    return r.info;
  }

  /**
   * 展开播放列表 / 合集 / 频道。返回 { playlist, items[] }。
   * 用于"喂一个列表地址，自动拆成一堆单集排队"。
   */
  function probePlaylist(url, { maxItems = 200, timeout = 180000 } = {}) {
    const args = [
      '--ignore-config', '--no-warnings', '--no-colors',
      '--yes-playlist', '--skip-download', '--no-check-certificates',
      '--flat-playlist',
      '--playlist-end', String(maxItems),
      '-J', '--', url,
    ];
    if (fs.existsSync(paths.ffmpeg)) args.unshift('--ffmpeg-location', paths.ffmpeg);

    const r = runSync(paths.ytdlp, args, { timeout });
    if (!r.ranOk) throw new EngineError(`yt-dlp 没能启动（${r.error}）`);

    const text = (r.stdout || '').trim();
    const start = text.indexOf('{');
    if (start === -1) {
      const { fromEngineOutput } = require('../domain/errors');
      throw fromEngineOutput(cleanError(text) || `yt-dlp 退出码 ${r.status}`, { url });
    }

    let json;
    try { json = JSON.parse(text.slice(start)); } catch { throw new EngineError('播放列表 JSON 解析失败'); }

    const entries = Array.isArray(json.entries) ? json.entries : [];
    return {
      playlist: {
        url: json.webpage_url || url,
        title: json.title || null,
        uploader: json.uploader || json.channel || null,
        site: json.extractor_key || json.extractor || null,
        item_count: entries.length || json.playlist_count || 0,
      },
      items: entries.filter(Boolean).map((e, i) => ({
        url: e.webpage_url || e.url || null,
        title: e.title || null,
        duration: Number.isFinite(e.duration) ? Math.round(e.duration) : null,
        playlist_index: e.playlist_index || i + 1,
      })).filter((e) => e.url),
    };
  }

  // ---------------------------------------------------------------- 下载进程

  /**
   * 启动下载。**输出重定向到日志文件**，调用方拿 pid 和 logPath，
   * 通过读取日志文件获得进度。
   *
   * 另有一个 resultFile：yt-dlp 用 --print-to-file 把最终文件路径写进去，
   * 彻底避开 stdout 的编码问题（中文路径在 GBK 控制台下会乱码）。
   *
   * @returns {{child, logPath, resultFile, pid}}
   */
  function startDownload(video, settings, opts = {}) {
    const logPath = path.join(paths.logs, `video-${video.id}.log`);
    const resultFile = path.join(paths.logs, `video-${video.id}.result`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(resultFile, '');   // 清空旧结果，避免读到上次的路径

    const args = buildDownloadArgs(video, settings, { ...opts, resultFile });
    const { child } = spawnToFile(paths.ytdlp, args, { logPath, env: childEnv() });
    return { child, logPath, resultFile, pid: child.pid };
  }

  /** 读 --print-to-file 的结果（最终文件路径），UTF-8 不会有编码问题 */
  function readResultFile(resultFile) {
    try {
      const t = fs.readFileSync(resultFile, 'utf8').trim();
      return t || null;
    } catch {
      return null;
    }
  }

  /** 引擎版本号，用于日志 */
  function version() {
    return probeBinary(paths.ytdlp, ['--version']).version || '未知';
  }

  return {
    QUALITY_MAP,
    USER_AGENT,
    binaryInfo,
    version,
    commonArgs,
    outtmpl,
    buildDownloadArgs,
    canEmbedThumbnail,
    probeWithArgs,
    probeMetadata,
    probePlaylist,
    startDownload,
    readResultFile,
    takeCookieNote,
  };
}

module.exports = { createDownloader, QUALITY_MAP, USER_AGENT };
