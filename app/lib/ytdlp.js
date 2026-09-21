'use strict';
/**
 * yt-dlp 引擎封装。
 *
 * ⚠️ 本文件有一个必须遵守的平台约束：
 *    当前运行环境禁止「用管道捕获子进程输出」（spawn + pipe 会抛 EPERM）。
 *    因此所有子进程一律用 **文件描述符重定向** 输出：
 *      - 短命命令（--version / -J 取元数据）：fd 指向临时文件，跑完读文件。
 *      - 长命命令（真正下载）：fd 指向任务日志文件，由 queue 侧轮询 tail 该文件
 *        解析进度，而不是去 pipe 里读。
 *    这也顺手换来一个好处：每个任务都留有完整原始日志，排错可直接看。
 *
 * 另一个平台坑：yt-dlp 官方 yt-dlp.exe（PyInstaller onefile）会在系统 %TEMP%
 * 里自解包，被沙箱拒绝（"Failed to create parent directory structure"）。
 * 必须使用目录式分发包 yt-dlp_win.zip（exe + _internal 同级），见 config.PATHS.YTDLP。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { PATHS, PROGRESS_TEMPLATE, POSTPROCESS_TEMPLATE } = require('./config');

// ---------------------------------------------------------------- 基础检查

/**
 * 子进程环境。
 *
 * ⚠️ 这是本项目踩过的一个真实大坑：
 *    中文 Windows 上子进程用 fd 重定向写文件时，默认按系统 ANSI 代码页（GBK）编码，
 *    于是日志里的中文路径全变乱码（...\20260920_??Ƶ????\...），导致
 *    fs.existsSync() 永远失败、文件永远收不了尾。
 *    强制 PYTHONUTF8 / PYTHONIOENCODING 让 yt-dlp 统一吐 UTF-8。
 */
function childEnv() {
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONLEGACYWINDOWSSTDIO: '0',
  };
}

function binaryInfo() {
  const check = (exe, args) => {
    if (!fs.existsSync(exe)) return { ok: false, reason: '文件不存在', path: exe };
    const probePath = path.join(os.tmpdir(), `probe-${process.pid}.log`);
    const fd = fs.openSync(probePath, 'w');
    const r = spawnSync(exe, args, { stdio: ['ignore', fd, fd], timeout: 20000, env: childEnv() });
    fs.closeSync(fd);
    const out = safeRead(probePath).trim();
    return {
      ok: !r.error && r.status === 0,
      version: out.split(/\r?\n/)[0] || '',
      error: r.error ? r.error.message : (r.status === 0 ? '' : out.split(/\r?\n/)[0]),
      path: exe,
    };
  };
  return {
    ytdlp: check(PATHS.YTDLP, ['--version']),
    ffmpeg: check(PATHS.FFMPEG, ['-version']),
  };
}

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * 用 fd 重定向跑一个短命令，返回 {status, output}。
 * 绝不使用管道，规避 EPERM。
 */
function runCaptured(exe, args, { timeout = 120000 } = {}) {
  const tmp = path.join(PATHS.DATA, `_tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    const r = spawnSync(exe, args, { stdio: ['ignore', fd, fd], timeout, windowsHide: true, env: childEnv() });
    fs.closeSync(fd);
    fd = null;
    return {
      status: r.status,
      signal: r.signal,
      error: r.error ? r.error.message : null,
      output: safeRead(tmp),
    };
  } finally {
    if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ---------------------------------------------------------------- 参数构造

/**
 * 上一次 commonArgs 调用里登录态配置的问题（没有则为 null）。
 * 下载启动时读一次，非空就写进任务日志，用户能看到"为什么登录态没生效"。
 */
let cookieNote = null;
function takeCookieNote() {
  const n = cookieNote;
  cookieNote = null;
  return n;
}

const QUALITY_MAP = {
  best: 'bv*+ba/b',
  worst: 'wv*+wa/w',
  '2160p': 'bv*[height<=2160]+ba/b[height<=2160]',
  '1440p': 'bv*[height<=1440]+ba/b[height<=1440]',
  '1080p': 'bv*[height<=1080]+ba/b[height<=1080]',
  '720p': 'bv*[height<=720]+ba/b[height<=720]',
  '480p': 'bv*[height<=480]+ba/b[height<=480]',
  '360p': 'bv*[height<=360]+ba/b[height<=360]',
};

/**
 * 通用参数：任何一次 yt-dlp 调用都带上。
 * @param {object} settings
 * @param {string} [resultFile] 若给出，最终文件路径用 --print-to-file 写到这里。
 *   为什么不走 stdout：中文路径经 fd 重定向会被按 GBK 编码写坏（见 childEnv 注释）。
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
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    // 关键：让进度以「每行一段 JSON」的形式吐出来，便于逐行解析。
    // 注意 PROGRESS_TEMPLATE 里的 "download:" / "postprocess:" 是 yt-dlp 的
    // **路由标记**，它本身不会出现在输出里 —— 所以解析器必须能处理「裸 JSON 行」。
    '--newline',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '--progress-template', POSTPROCESS_TEMPLATE,
  ];
  // 最终文件路径：写进独立结果文件（UTF-8，绕开控制台代码页，中文路径不会乱码）
  if (resultFile) {
    args.push('--print-to-file', 'after_move:%(filepath)s', resultFile);
  }
  // 供失败定位的轻量标记（纯 ASCII，不受编码影响）
  args.push('--print', 'before_dl:VVAULT_META:%(id)s|%(extractor)s');
  if (fs.existsSync(PATHS.FFMPEG)) {
    args.push('--ffmpeg-location', PATHS.FFMPEG);
  }
  const rl = Number(settings.rateLimitMB || 0);
  if (rl > 0) args.push('--limit-rate', `${rl}M`);
  const fc = Number(settings.fragmentConcurrency || 4);
  if (fc > 1) args.push('--concurrent-fragments', String(fc));

  // 登录态（二期）。懒加载 cookies.js 是为了避免循环依赖：
  // cookies.js 需要本模块的 probeWithArgs，本模块又需要它的 cookieArgs。
  // 用函数级 require 打断这个环，加载期就不会互相等。
  //
  // ⚠️ 配置有问题时**不能**往 args 里塞自定义参数（yt-dlp 不认识会直接报错），
  //    也**不能**静默跳过（用户以为开了登录态、其实没开，失败时一头雾水）。
  //    正确做法：记在 cookieNote 上带回去，由调用方决定怎么告诉用户。
  try {
    // eslint-disable-next-line global-require
    const { cookieArgs } = require('./cookies');
    const c = cookieArgs(settings);
    if (c.args.length) args.push(...c.args);
    if (c.warning) cookieNote = c.warning;
  } catch { /* cookies 模块不可用时不影响下载本身 */ }

  return args;
}

/**
 * 输出路径模板：站点/作者/标题 [清晰度].ext
 * yt-dlp 会自动清洗文件名里的非法字符，并对过长标题截断。
 */
function outputTemplate(settings, kind) {
  const parts = [];
  parts.push('%(extractor_key)s');
  if (settings.organizeByUploader !== false) parts.push('%(uploader|unknown)s');
  parts.push('%(title).120B [%(height)sp%(format_id)s].%(ext)s');
  return path.join(settings.downloadDir || PATHS.DOWNLOADS, ...parts);
}

function outtmplFor(settings, kind) {
  // 音频任务不带清晰度后缀，命名更干净
  const parts = ['%(extractor_key)s'];
  if (settings.organizeByUploader !== false) parts.push('%(uploader|unknown)s');
  if (kind === 'audio') {
    parts.push('%(title).120B.%(ext)s');
  } else {
    parts.push('%(title).120B [%(height)sp%(format_id)s].%(ext)s');
  }
  return path.join(settings.downloadDir || PATHS.DOWNLOADS, ...parts);
}

/**
 * 组装一次下载的参数。
 * @param {object} video 库里的记录（url / kind / quality）
 * @param {object} settings
 * @param {object} opts { resume:boolean, resultFile:string }
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
    // mp4 容器装不下，强行 mp4 会让合并直接失败。mkv 通吃。
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

  args.push('-o', outtmplFor(settings, kind));
  args.push('--', video.url);
  return args;
}

/**
 * 判断一个封面能不能被 ffmpeg 嵌入。
 *
 * yt-dlp 的 --convert-thumbnails 只支持 jpg / png / webp 三种互转；
 * 别的格式（实测遇到 avif）它转不了，原样丢给 ffmpeg，
 * 而 ffmpeg 这版没有 avif 解码器 → 嵌入失败 → 整个任务被判失败。
 *
 * @returns {Promise<{ok:boolean, format:string|null, reason:string}>}
 */
async function canEmbedThumbnail(url, { timeout = 8000 } = {}) {
  if (!url) return { ok: false, format: null, reason: '没有封面地址' };

  // 1) 先看 URL 后缀，最省事
  const byExt = String(url).match(/\.(jpe?g|png|webp|avif|gif|bmp|heic|heif)(?:[?#]|$)/i);
  if (byExt) {
    const ext = byExt[1].toLowerCase().replace('jpeg', 'jpg');
    const ok = ['jpg', 'png', 'webp'].includes(ext);
    return { ok, format: ext, reason: ok ? `URL 后缀 .${ext} 可嵌入` : `URL 后缀 .${ext} 不被 ffmpeg 支持` };
  }

  // 2) 后缀看不出来就发个 HEAD 看 content-type
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
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
 * 取单条视频元数据（不下载）。返回归一化对象。
 */
function probeMetadata(url, { timeout = 90000 } = {}) {
  const args = [
    '--ignore-config', '--no-warnings', '--no-colors',
    '--no-playlist', '--skip-download', '--no-check-certificates',
    '-J', '--', url,
  ];
  if (fs.existsSync(PATHS.FFMPEG)) args.unshift('--ffmpeg-location', PATHS.FFMPEG);
  const r = runCaptured(PATHS.YTDLP, args, { timeout });
  const text = r.output.trim();
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error(cleanError(text) || `yt-dlp 未返回元数据（退出码 ${r.status}）`);
  }
  let info;
  try {
    info = JSON.parse(text.slice(start));
  } catch {
    // 可能在 JSON 前有杂项行，取最后一行尝试
    const last = text.split(/\r?\n/).filter(Boolean).pop();
    try { info = JSON.parse(last); } catch { throw new Error(cleanError(text) || '元数据 JSON 解析失败'); }
  }
  return normalizeInfo(info);
}

/**
 * 取元数据，但额外带上指定的参数（用于「登录态自检」这类要临时加 --cookies 的场景）。
 *
 * 为什么不复用 probeMetadata：那个函数把参数写死了，而登录态自检需要
 * **在不改用户设置的前提下试一次**。改设置再改回来会留下中间状态，
 * 万一中途失败，用户就莫名其妙地被改了配置。
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
  if (fs.existsSync(PATHS.FFMPEG)) args.unshift('--ffmpeg-location', PATHS.FFMPEG);

  const r = runCaptured(PATHS.YTDLP, args, { timeout });
  const text = (r.output || '').trim();
  const start = text.indexOf('{');
  if (start === -1) {
    const raw = cleanError(text) || `yt-dlp 退出码 ${r.status}`;
    return { ok: false, title: '', error: raw, info: null, status: r.status };
  }
  try {
    const info = JSON.parse(text.slice(start));
    return {
      ok: true,
      title: info.title || '',
      error: '',
      info: normalizeInfo(info),
      status: r.status,
    };
  } catch {
    return { ok: false, title: '', error: cleanError(text) || '元数据 JSON 解析失败', info: null, status: r.status };
  }
}

/**
 * 展开播放列表 / 合集 / 频道。返回 { playlist, items[] }。
 * 限制 maxItems 防止用户误粘一个万集频道直接把库撑爆。
 */
function probePlaylist(url, { maxItems = 200, timeout = 180000 } = {}) {
  const args = [
    '--ignore-config', '--no-warnings', '--no-colors',
    '--flat-playlist', '--skip-download',
    '-J', '--playlist-end', String(maxItems), '--', url,
  ];
  if (fs.existsSync(PATHS.FFMPEG)) args.unshift('--ffmpeg-location', PATHS.FFMPEG);
  const r = runCaptured(PATHS.YTDLP, args, { timeout });
  const text = r.output.trim();
  const start = text.indexOf('{');
  if (start === -1) throw new Error(cleanError(text) || '播放列表解析失败');
  const info = JSON.parse(text.slice(start));

  const entries = info.entries || [];
  return {
    playlist: {
      url,
      title: info.title || info.playlist_title || '未命名列表',
      uploader: info.uploader || info.channel || info.playlist_uploader || null,
      site: info.extractor_key || info.extractor || null,
      item_count: entries.length,
    },
    items: entries.filter(Boolean).map((e, i) => {
      const v = normalizeInfo(e);
      v.playlist_index = i + 1;
      // flat 模式下 url 可能是纯 id，补全成完整地址
      if (v.url && !/^https?:/i.test(v.url)) {
        v.url = e.webpage_url || e.url || v.url;
      }
      return v;
    }),
    isPlaylist: true,
  };
}

/**
 * 链接归一化：把各站"网页版实际复制出来的地址"转成 yt-dlp 认识的形式。
 *
 * 背景：用户在浏览器里复制到的往往不是规范视频地址。最典型的是抖音 ——
 * 新版网页版点开视频后地址栏是
 *     https://www.douyin.com/jingxuan?modal_id=7671972624104197391
 *     https://www.douyin.com/user/xxxx?modal_id=7671972624104197391
 * 而 yt-dlp 只认 https://www.douyin.com/video/<id>，直接粘会报 Unsupported URL。
 * 这类"粘进去就说解析失败"最让人摸不着头脑，所以在入口处先纠正掉。
 */
function normalizeUrl(input) {
  const url = String(input || '').trim();
  if (!/^https?:\/\//i.test(url)) return url;

  // 抖音：各种带 modal_id 的地址 → 规范视频地址
  const dy = url.match(/douyin\.com\/.*[?&]modal_id=(\d+)/i);
  if (dy) return `https://www.douyin.com/video/${dy[1]}`;

  // 抖音分享短链/小程序链接里可能带 vid=
  if (/douyin\.com/i.test(url)) {
    const vid = url.match(/[?&]vid=(\d{15,})/i);
    if (vid) return `https://www.douyin.com/video/${vid[1]}`;
  }

  // 小红书：复制出来常带 xsec_token 等参数，但 /explore/<id> 本身是规范地址，保持原样

  // 快手：/short-video/<id> 已是规范形式

  // YouTube：/shorts/<id> 和 /watch?v=<id> yt-dlp 都认，不动

  // B 站：把 av 号地址规范成 BV（yt-dlp 两者都认，保持原样即可）

  return url;
}

/**
 * 判断一个链接是单视频还是列表/频道。
 */
function classifyUrl(url) {
  const u = String(url);
  if (/[?&]list=|^https?:\/\/(www\.)?(youtube\.com\/(playlist|channel|c\/|user\/|@))|bilibili\.com\/medialist|space\.bilibili\.com|\/playlist\b|\/sets\//i.test(u)) {
    return 'playlist';
  }
  return 'video';
}

function normalizeInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const height = info.height || (info.format_note && parseInt(info.format_note, 10)) || null;
  return {
    url: info.webpage_url || info.original_url || info.url || null,
    video_id: info.id || null,
    extractor: info.extractor || null,
    site: info.extractor_key || info.extractor || null,
    title: info.title || null,
    uploader: info.uploader || info.channel || info.playlist_uploader || null,
    upload_date: info.upload_date || null,
    duration: Number.isFinite(info.duration) ? Math.round(info.duration) : null,
    description: (info.description || '').slice(0, 4000) || null,
    thumbnail_url: info.thumbnail || (Array.isArray(info.thumbnails) && info.thumbnails.length
      ? info.thumbnails[info.thumbnails.length - 1].url : null),
    width: info.width || null,
    height: height || null,
    fps: info.fps || null,
    vcodec: info.vcodec || null,
    acodec: info.acodec || null,
    file_size: info.filesize || info.filesize_approx || null,
    is_live: !!info.is_live,
  };
}

/**
 * 把 yt-dlp 的日志压成一句有用的报错。
 *
 * ⚠️ 曾经直接取"最后一行"，结果把进度帧（VVP|100.0%|…）当成了错误信息存进数据库，
 *    用户看到的错误提示是一串数字。所以这里必须：
 *    1) 先把进度帧、后处理标记等非错误行排除
 *    2) "ERROR:" 行若只是笼统的 "Postprocessing:"，说明真正原因在其后，取它后面那行
 *    3) 都没有才退回最后一行非噪音内容
 */
function cleanError(text) {
  if (!text) return '';
  const lines = String(text)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    // 排除我们自己吐的进度/后处理标记和常见噪音
    .filter((l) => !/^VVP\|/.test(l))
    .filter((l) => !/^VVAULT_/.test(l))
    .filter((l) => !/^\[download\]\s+[\d.]+%/.test(l))
    .filter((l) => !/^\[download\]\s+Destination:/.test(l))
    .filter((l) => !/^Deleting (original|existing) file/.test(l));

  if (!lines.length) return '';

  const errIdx = lines.findIndex((l) => /^ERROR:/i.test(l));
  if (errIdx >= 0) {
    const msg = lines[errIdx].replace(/^ERROR:\s*/i, '').trim();
    // "Postprocessing: ..." 这类笼统错误，真正的原因通常在下一行
    if (/^Postprocessing:\s*$/i.test(msg) || /^Postprocessing:$/i.test(msg)) {
      const next = lines[errIdx + 1];
      if (next && !/^ERROR:/i.test(next)) return `${msg} ${next}`.slice(0, 500);
    }
    return msg.slice(0, 500) || lines[errIdx + 1]?.slice(0, 500) || '';
  }

  // 没有 ERROR 行：优先挑看起来像报错的
  const likely = lines.filter((l) =>
    /error|invalid|failed|unable|not available|unavailable|forbidden|403|404|timed? ?out|refused|denied|corrupt/i.test(l)
  );
  const pick = (likely.length ? likely[likely.length - 1] : lines[lines.length - 1]) || '';
  return pick.replace(/^ERROR:\s*/i, '').slice(0, 500);
}

// ---------------------------------------------------------------- 下载进程

/**
 * 启动下载。**输出重定向到日志文件**，调用方拿 pid 和 logPath，
 * 通过读取日志文件获得进度。
 *
 * 另有一个 resultFile：yt-dlp 用 --print-to-file 把最终文件路径写进去，
 * 彻底避开 stdout 的编码问题（中文路径在 GBK 控制台下会乱码）。
 */
function startDownload(video, settings, opts = {}) {
  const logPath = path.join(PATHS.LOGS, `video-${video.id}.log`);
  const resultFile = path.join(PATHS.LOGS, `video-${video.id}.result`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '');   // 清空旧日志
  fs.writeFileSync(resultFile, ''); // 清空旧结果，避免读到上次的路径

  const args = buildDownloadArgs(video, settings, { ...opts, resultFile });
  const fd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn(PATHS.YTDLP, args, {
      stdio: ['ignore', fd, fd],   // ← 文件描述符，不是 pipe（平台禁止 pipe 子进程输出）
      windowsHide: true,
      detached: false,
      env: childEnv(),
    });
  } finally {
    // 父进程侧立刻关掉自己那份 fd，子进程已继承
    try { fs.closeSync(fd); } catch {}
  }
  return { child, logPath, resultFile, args, pid: child.pid };
}

/** 读取 --print-to-file 的结果文件，返回最终文件路径（UTF-8 安全）。 */
function readResultFile(resultFile) {
  try {
    const txt = fs.readFileSync(resultFile, 'utf8').trim();
    if (!txt) return null;
    // 可能有多行（理论上一次下载只有一行），取最后一个存在的
    const lines = txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (fs.existsSync(lines[i])) return lines[i];
    }
    return lines[lines.length - 1] || null;
  } catch { return null; }
}

/**
 * 解析一行日志 → 进度事件（可能返回 null）。
 *
 * ⚠️ 实测发现：--progress-template 里的 "download:" / "postprocess:" 前缀是
 *    yt-dlp 的路由标记，**不会出现在输出里**，所以实际拿到的是裸 JSON 行。
 *    这里两种形式都兼容（带前缀和裸 JSON），以免将来 yt-dlp 改行为就崩。
 */
function parseProgressLine(line) {
  const raw = line.trim();
  if (!raw) return null;

  // 带前缀形式（模板的路由标记不会出现在真实输出里，这里只是兼容）
  if (raw.startsWith('download:')) {
    return parseDownloadLine(raw.slice('download:'.length)) || parseDownloadJson(raw.slice('download:'.length));
  }
  if (raw.startsWith('postprocess:')) {
    return parsePostprocessLine(raw.slice('postprocess:'.length)) || parsePostprocessJson(raw.slice('postprocess:'.length));
  }

  // 裸形式（真实情况）
  const pipe = parsePipeLine(raw);
  if (pipe) return pipe;

  if (raw.startsWith('{')) {
    const dl = parseDownloadJson(raw);
    if (dl) return dl;
    const pp = parsePostprocessJson(raw);
    if (pp) return pp;
    return null;
  }

  if (raw.startsWith('VVAULT_FILE:')) {
    return { type: 'file', path: raw.slice('VVAULT_FILE:'.length).trim() };
  }
  if (raw.startsWith('VVAULT_POST:')) {
    return { type: 'stage', stage: raw.slice('VVAULT_POST:'.length).trim() };
  }
  if (raw.startsWith('VVAULT_META:')) {
    return { type: 'meta', raw: raw.slice('VVAULT_META:'.length) };
  }

  if (/^\[download\]\s+Destination:/i.test(raw)) {
    return { type: 'destination', value: raw.replace(/^\[download\]\s+Destination:\s*/i, '') };
  }
  if (/^\[download\]\s+.*has already been downloaded/i.test(raw)) {
    return { type: 'already' };
  }
  if (/^ERROR:/i.test(raw)) {
    return { type: 'error', message: raw.replace(/^ERROR:\s*/i, '') };
  }
  if (/^\[Merger\]|^\[ExtractAudio\]|^\[VideoConvertor\]|^\[Metadata\]|^\[ThumbnailsConvertor\]/i.test(raw)) {
    return { type: 'stage', stage: raw.split(']')[0].replace('[', '') };
  }
  return { type: 'log', line: raw };
}

/**
 * 管道格式解析（当前使用的主格式）。
 *   VVP|<percent>|<downloaded>|<total>|<speed>|<eta>|<frag>|<fragc>   → 7 字段
 *   VVP|<postprocessor>|<status>                                     → 2 字段
 * 「NA」表示该字段不可用，归一化成 null。
 */
function parsePipeLine(raw) {
  if (!raw.startsWith('VVP|')) return null;
  const parts = raw.slice(4).split('|');

  if (parts.length === 7) {
    const ds = num(parts[1]);
    const ts = num(parts[2]);
    let pct = parseFloat(String(parts[0]).replace('%', '').trim());
    // 兜底：p 不可解析时用字节数自己算
    if (!Number.isFinite(pct) && ds !== null && ts) pct = (ds / ts) * 100;
    return {
      type: 'progress',
      percent: Number.isFinite(pct) ? pct : null,
      downloaded: ds,
      total: ts,
      speed: num(parts[3]),
      eta: num(parts[4]),
      fragment: num(parts[5]),
      fragmentCount: num(parts[6]),
    };
  }

  if (parts.length === 2) {
    return {
      type: 'postprocess',
      stage: (parts[0] || '处理中').trim(),
      status: (parts[1] || '').trim(),
    };
  }
  return null;
}

/** 解析 download: 前缀后的内容（管道优先，兼容旧 JSON）。 */
function parseDownloadLine(text) {
  const t = String(text).trim();
  if (t.startsWith('VVP|')) return parsePipeLine(t);
  return null;
}

/** 解析 postprocess: 前缀后的内容。 */
function parsePostprocessLine(text) {
  const t = String(text).trim();
  if (t.startsWith('VVP|')) return parsePipeLine(t);
  return null;
}

/**
 * 兼容用：JSON 形式的进度行解析（已不再是主格式，保留以防回退）。
 * 形如：{"p":"  0.5%","ds":1024,"ts":NA,...}
 */
function parseDownloadJson(text) {
  const t = String(text).trim();
  if (!t.startsWith('{')) return null;
  let o;
  try { o = JSON.parse(t); } catch { return null; }
  // 进度对象必带 p 字段；postprocess 对象带 pp，用字段形状区分
  if (!('p' in o)) return null;

  const ds = num(o.ds);
  const ts = num(o.ts);
  let pct = parseFloat(String(o.p ?? '').replace('%', '').trim());
  // 兜底：万一 p 不可解析，用字节数自己算百分比
  if (!Number.isFinite(pct) && ds !== null && ts) pct = (ds / ts) * 100;

  return {
    type: 'progress',
    percent: Number.isFinite(pct) ? pct : null,
    downloaded: ds,
    total: ts,
    speed: num(o.spd),
    eta: num(o.eta),
    fragment: num(o.frag),
    fragmentCount: num(o.fragc),
  };
}

/**
 * 尝试把一段文本解析成后期处理 JSON。
 * 形如：{"pp":"Merger","status":"started"}
 */
function parsePostprocessJson(text) {
  const t = String(text).trim();
  if (!t.startsWith('{')) return null;
  let o;
  try { o = JSON.parse(t); } catch { return null; }
  // 用 pp 区分于进度对象（进度对象是 p）
  if (!('pp' in o) && !('stage' in o)) return null;
  return {
    type: 'postprocess',
    stage: o.pp || o.stage || '处理中',
    status: o.status || '',
  };
}

/** yt-dlp 模板里的 "NA" 表示"不可用"，必须归一化成 null，否则 Number('NA') = NaN 会污染前端。 */
function num(v) {
  if (v === null || v === undefined || v === 'NA' || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  binaryInfo, runCaptured, childEnv,
  probeMetadata, probeWithArgs, probePlaylist, classifyUrl, normalizeUrl, normalizeInfo,
  buildDownloadArgs, outtmplFor, startDownload, readResultFile, parseProgressLine,
  cleanError, canEmbedThumbnail, QUALITY_MAP,
  takeCookieNote,
};
