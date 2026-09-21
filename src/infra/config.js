'use strict';
/**
 * 配置：把"这个应用需要知道的一切外部事实"收在一个显式对象里。
 *
 * ⚠️ 这里跟重构前最大的区别是：**加载本模块不再有任何副作用**。
 *
 * 以前 `lib/config.js` 一被 require 就 `fs.mkdirSync` 建目录，`lib/db.js` 一被
 * require 就打开真实的 SQLite 文件。副作用藏在模块加载里，后果是：
 *   - 想写一个单元测试，得先有一个真实数据库和真实下载目录
 *   - 想换个数据目录跑测试，做不到（路径是模块级常量，没人能替换）
 *   - 测试被迫操作**用户的真实库**（历史上因此误删过 7 条记录）
 *
 * 现在改成：`loadConfig()` 只**读**环境变量并算路径，什么也不创建、不打开。
 * 要建目录就显式调 `ensureDirs(config)`，要开库就显式 `createDatabase(config)`。
 * 谁需要什么，一眼看得见；测试也能塞一份指向临时目录的 config 进来。
 */

const path = require('node:path');

/** 工具根目录。默认由本文件位置推导；测试可以显式覆盖。 */
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 任务状态机。
 * 放在 config 之上单独一层意义不大，但它属于"领域词汇"，
 * 所以这里只放常量，合法转换规则在 domain/job-state.js。
 */
const STATUS = Object.freeze({
  QUEUED: 'queued',
  PARSING: 'parsing',
  DOWNLOADING: 'downloading',
  PROCESSING: 'processing',   // 合并 / 抽音频
  DONE: 'done',
  FAILED: 'failed',
  PAUSED: 'paused',           // 用户主动暂停 / 关站中断，可手动继续
  CANCELED: 'canceled',
});

/** 处于"占用队列槽位"的状态 —— 调度器只认这几个 */
const ACTIVE_STATUSES = Object.freeze([
  STATUS.QUEUED, STATUS.PARSING, STATUS.DOWNLOADING, STATUS.PROCESSING,
]);

/** 默认设置。用户可在界面上改，改完写进 settings 表。 */
const DEFAULT_SETTINGS = Object.freeze({
  downloadDir: null,          // null = 用 config.paths.downloads（见 loadConfig 的解析）
  concurrency: 2,
  // 默认不限速。限速是给"怕被站点风控"准备的选项；
  // 开着它下大文件时它会成为唯一瓶颈（实测 5MB/s 被完整吃满）。
  rateLimitMB: 0,
  fragmentConcurrency: 8,     // 单任务内部并发分片数；对 HLS/DASH 流提速明显
  retries: 2,
  organizeByUploader: true,   // 按 站点/作者 建子目录
  audioFormat: 'mp3',
  videoContainer: 'mp4',
  embedThumbnail: true,       // 嵌入封面（遇到 ffmpeg 不支持的格式会自动跳过，不会导致任务失败）
  deletePartOnCancel: true,

  // ---- 登录态（二期）----
  // 空字符串 = 不用 Cookie。**刻意不设默认浏览器**：偷偷读用户的浏览器 cookie
  // 是不可接受的，必须由用户显式开启。见 infra/cookies.js 的说明。
  cookiesFromBrowser: '',     // chrome / edge / firefox / brave / chromium / opera / vivaldi / safari
  cookiesFile: '',            // 自己导出的 cookies.txt 绝对路径（优先级高于浏览器）
});

/**
 * 推导所有路径。
 * 纯函数：给一个 root，返回一整套路径，不碰文件系统。
 */
function resolvePaths(root) {
  return {
    root,
    bin: path.join(root, 'tools', 'bin'),
    // yt-dlp 用目录式分发包，必须保留 _internal 同级结构（见 README 坑 2）
    ytdlp: path.join(root, 'tools', 'bin', 'ytdlp-win', 'yt-dlp.exe'),
    ffmpeg: path.join(root, 'tools', 'bin', 'ffmpeg.exe'),
    ffprobe: path.join(root, 'tools', 'bin', 'ffprobe.exe'),
    downloads: path.join(root, 'downloads'),
    data: path.join(root, 'data'),
    logs: path.join(root, 'data', 'logs'),
    thumbs: path.join(root, 'data', 'thumbs'),
    db: path.join(root, 'data', 'vault.db'),
    frontend: path.join(root, 'src', 'web'),
  };
}

/**
 * 读环境变量 + 算路径。
 *
 * @param {object} [overrides]
 * @param {string} [overrides.root]       覆盖根目录（测试用临时目录）
 * @param {string} [overrides.downloads]  覆盖下载目录（跑测试的临时目录）
 * @param {string} [overrides.data]       覆盖数据目录（把整库/日志隔离出去）
 * @param {number} [overrides.port]
 * @param {string} [overrides.host]
 * @param {object} [overrides.env]        注入一份环境变量（不传则用 process.env）
 * @returns {{root,paths,port,host,env}}
 */
function loadConfig(overrides = {}) {
  const env = overrides.env || process.env;
  const root = overrides.root || env.VAULT_ROOT || DEFAULT_ROOT;

  const paths = resolvePaths(root);
  // 单独覆盖 data / downloads：测试只要隔离这两处，就能完全不碰用户真实数据
  if (overrides.data) {
    paths.data = overrides.data;
    paths.logs = path.join(overrides.data, 'logs');
    paths.thumbs = path.join(overrides.data, 'thumbs');
    paths.db = path.join(overrides.data, 'vault.db');
  }
  if (overrides.downloads) paths.downloads = overrides.downloads;

  return {
    root,
    paths,
    port: Number(overrides.port ?? env.VAULT_PORT ?? 8787),
    host: overrides.host ?? env.VAULT_HOST ?? '127.0.0.1',
    env,
  };
}

/** 该建哪些目录 —— 显式列出来，别让调用方猜 */
function requiredDirs(config) {
  return [config.paths.downloads, config.paths.data, config.paths.logs, config.paths.thumbs];
}

/**
 * 建目录。**必须显式调用**，不在模块加载时偷偷做。
 * 幂等，重复调用无副作用。
 */
function ensureDirs(config, fs = require('node:fs')) {
  for (const d of requiredDirs(config)) fs.mkdirSync(d, { recursive: true });
}

/** 把 null 的 downloadDir 解析成实际路径（settings 存在库里，可能是 null） */
function effectiveDownloadDir(settings, config) {
  return (settings && settings.downloadDir) || config.paths.downloads;
}

/** 把库里的设置和默认值合并，并把 downloadDir 解析掉 */
function withDefaults(settings, config) {
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  merged.downloadDir = effectiveDownloadDir(merged, config);
  return merged;
}

module.exports = {
  DEFAULT_ROOT,
  STATUS,
  ACTIVE_STATUSES,
  DEFAULT_SETTINGS,
  resolvePaths,
  loadConfig,
  ensureDirs,
  requiredDirs,
  effectiveDownloadDir,
  withDefaults,
};
