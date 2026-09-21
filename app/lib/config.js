'use strict';
/**
 * 全局配置与路径常量。
 *
 * 目录布局（ROOT = 工具根目录）：
 *   ROOT/tools/bin/yt-dlp.exe      下载引擎（目录式分发，非 onefile）
 *   ROOT/tools/bin/ffmpeg.exe      转码 / 合并 / 抽音频
 *   ROOT/downloads/                视频与音频落盘处
 *   ROOT/data/vault.db             SQLite 元数据库（可搜索的库）
 *   ROOT/data/logs/*.log           每个任务的 yt-dlp 原始输出（进度从这里 tail）
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');

const PATHS = {
  ROOT,
  BIN: path.join(ROOT, 'tools', 'bin'),
  // yt-dlp 用目录式分发包，必须保留 _internal 同级结构
  YTDLP: path.join(ROOT, 'tools', 'bin', 'ytdlp-win', 'yt-dlp.exe'),
  FFMPEG: path.join(ROOT, 'tools', 'bin', 'ffmpeg.exe'),
  FFPROBE: path.join(ROOT, 'tools', 'bin', 'ffprobe.exe'),
  DOWNLOADS: path.join(ROOT, 'downloads'),
  DATA: path.join(ROOT, 'data'),
  LOGS: path.join(ROOT, 'data', 'logs'),
  DB: path.join(ROOT, 'data', 'vault.db'),
  FRONTEND: path.join(__dirname, '..', 'frontend'),
};

const PORT = Number(process.env.VAULT_PORT || 8787);
const HOST = process.env.VAULT_HOST || '127.0.0.1';

/** 默认设置。用户可在界面上改，改完写进 settings 表。 */
const DEFAULT_SETTINGS = {
  downloadDir: PATHS.DOWNLOADS,
  concurrency: 2,
  // 默认不限速。限速是给"怕被站点风控"准备的选项；
  // 开着它下大文件时它会成为唯一瓶颈（实测 5MB/s 被完整吃满）。
  rateLimitMB: 0,
  fragmentConcurrency: 8,  // 单任务内部并发分片数；对 HLS/DASH 流提速明显
  retries: 2,
  organizeByUploader: true, // 按 站点/作者 建子目录
  audioFormat: 'mp3',
  videoContainer: 'mp4',
  embedThumbnail: true,     // 嵌入封面（遇到 ffmpeg 不支持的格式会自动跳过，不会导致任务失败）
  transcodeTarget: '',      // 如 "h264-1080p"，空 = 不转码
  deletePartOnCancel: true,

  // ---- 登录态（二期）----
  // 空字符串 = 不用 Cookie。**刻意不设默认浏览器**：偷偷读用户的浏览器 cookie
  // 是不可接受的，必须由用户显式开启。见 lib/cookies.js 的说明。
  cookiesFromBrowser: '',   // chrome / edge / firefox / brave / chromium / opera / vivaldi / safari
  cookiesFile: '',          // 自己导出的 cookies.txt 绝对路径（优先级高于浏览器）
};

/**
 * 进度模板：让 yt-dlp 每行吐一条**管道分隔的纯文本**，服务端自己解析。
 *
 * ⚠️ 为什么不用 JSON 模板？这是实测撞了两次墙才定下来的：
 *   1) 用 %(...)s 直接把 _percent_str 插进 JSON → 得到 {"p":  0.5%"}，非法 JSON。
 *   2) 改用 %(...)j（JSON 编码）→ 字符串字段能正确加引号，但**数值字段取到 NA 时
 *      仍然输出裸 NA**（{"frag":NA}），依然非法。yt-dlp 的 j 转换对 NA 不可靠。
 *   结论：任何"让模板自己产出结构化格式"的思路都会被 NA 咬。
 *   于是改成管道分隔：NA 只是自己那一格的值，永远破坏不了整体结构。
 *
 * 格式：
 *   VVP|<percent>|<downloaded>|<total>|<speed>|<eta>|<frag>|<fragc>     下载进度
 *   VVP|<postprocessor>|<status>                                       后期处理
 * 开头的 "download:" / "postprocess:" 是 yt-dlp 的路由标记，不会出现在输出里。
 */
const PROGRESS_TEMPLATE =
  'download:VVP|%(progress._percent_str)s|%(progress.downloaded_bytes)s|' +
  '%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress.speed)s|' +
  '%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s';

const POSTPROCESS_TEMPLATE =
  'postprocess:VVP|%(progress.postprocessor)s|%(progress.status)s';

/** 任务状态机 */
const STATUS = {
  QUEUED: 'queued',
  PARSING: 'parsing',
  DOWNLOADING: 'downloading',
  PROCESSING: 'processing',   // 合并 / 抽音频 / 转码
  DONE: 'done',
  FAILED: 'failed',
  PAUSED: 'paused',           // 用户主动暂停 / 关站中断，可手动继续
  CANCELED: 'canceled',
};

const ACTIVE_STATUSES = [STATUS.QUEUED, STATUS.PARSING, STATUS.DOWNLOADING, STATUS.PROCESSING];

function ensureDirs() {
  for (const d of [PATHS.DOWNLOADS, PATHS.DATA, PATHS.LOGS]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// 本模块一被加载就把目录建好：db.js 在加载期就会打开 SQLite 文件，
// 如果等到 server.js 再建目录，任何直接 require db 的入口（如 selftest）都会开库失败。
ensureDirs();

module.exports = {
  ROOT, PATHS, PORT, HOST,
  DEFAULT_SETTINGS, PROGRESS_TEMPLATE, POSTPROCESS_TEMPLATE,
  STATUS, ACTIVE_STATUSES, ensureDirs,
};
