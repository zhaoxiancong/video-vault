'use strict';
/**
 * Video 领域模型 —— "库里的一个媒体文件"是什么，以及它能怎么被改。
 *
 * 重构前，一条记录就是一行裸 SQL（`SELECT * FROM videos`），
 * 字段拼写错误、类型混淆（`starred` 一会儿是 0/1 一会儿是布尔）
 * 全靠调用方自觉。`insertVideo` 的字段白名单漏了三个字段导致**静默丢数据**，
 * 就是这么发生的（README 坑 16）。
 *
 * 现在：所有进出库的记录都经过 `fromRow()` / `toRow()`，
 * 字段名和类型有唯一一处定义。
 */

const { STATUS } = require('../infra/config');

/** 能被写进库的列（插入 + 更新共用一份，避免两边漂移 —— 坑 16 的教训） */
const WRITABLE_COLS = Object.freeze([
  // 标识与来源
  'url', 'video_id', 'extractor', 'site', 'title', 'uploader', 'upload_date',
  'duration', 'description', 'thumbnail_url', 'thumbnail_path',
  'kind', 'quality', 'container', 'status',
  // 进度
  'progress', 'speed', 'eta', 'error', 'log_path',
  // 产物
  'file_path', 'file_size',
  'width', 'height', 'fps', 'vcodec', 'acodec',
  // 归类与元信息
  'playlist_id', 'playlist_index', 'subscription_id',
  'notes', 'starred', 'finished_at',
  'thumb_embed_ok', 'thumb_format',
  // ⚠️ 表里还有 transcoded_path / transcode_status / transcode_preset 三列，
  //    但**不在这里**：转码功能已整体移除，代码不再写它们（列保留，迁移零风险）。
]);

const WRITABLE = new Set(WRITABLE_COLS);

/** 只读列（由数据库自己维护，不接受外部写入） */
const READONLY_COLS = Object.freeze(['id', 'created_at', 'updated_at']);

/**
 * 链接归一化：把"网页版实际复制出来的地址"转成 yt-dlp 认识的形式。
 *
 * 背景：用户在浏览器里复制到的往往不是规范视频地址。最典型的是抖音 ——
 * 新版网页版点开视频后地址栏是
 *     https://www.douyin.com/jingxuan?modal_id=7671972624104197391
 *     https://www.douyin.com/user/xxxx?modal_id=7671972624104197391
 * 而 yt-dlp 只认 https://www.douyin.com/video/<id>，直接粘会报 Unsupported URL。
 * 这类"粘进去就说解析失败"最让人摸不着头脑，所以在入口处先纠正掉。
 *
 * @returns {{url:string, changed:boolean, note:string}}
 */
function normalizeUrl(input) {
  const url = String(input || '').trim();
  if (!/^https?:\/\//i.test(url)) return { url, changed: false, note: '' };

  // 抖音：各种带 modal_id 的地址 → 规范视频地址
  const dy = url.match(/douyin\.com\/.*[?&]modal_id=(\d+)/i);
  if (dy) {
    return {
      url: `https://www.douyin.com/video/${dy[1]}`,
      changed: true,
      note: '已自动识别为视频地址',
    };
  }

  // 抖音分享短链/小程序链接里可能带 vid=
  if (/douyin\.com/i.test(url)) {
    const vid = url.match(/[?&]vid=(\d{15,})/i);
    if (vid) {
      return {
        url: `https://www.douyin.com/video/${vid[1]}`,
        changed: true,
        note: '已自动识别为视频地址',
      };
    }
  }

  // 小红书 /explore/<id>、快手 /short-video/<id>、YouTube /shorts 与 /watch?v=
  // B 站 av 与 BV —— yt-dlp 都认，保持原样，不做多余转换
  return { url, changed: false, note: '' };
}

/**
 * 判断一个链接是单视频还是列表/频道。
 * 决定"粘进来是下一个"还是"展开成一堆单集"。
 */
function classifyUrl(url) {
  const u = String(url || '');
  if (/[?&]list=|^https?:\/\/(www\.)?(youtube\.com\/(playlist|channel|c\/|user\/|@))|bilibili\.com\/medialist|space\.bilibili\.com|\/playlist\b|\/sets\//i.test(u)) {
    return 'playlist';
  }
  return 'video';
}

/**
 * 把 yt-dlp 的 -J 输出归一化成库里的字段。
 * 纯函数，好测 —— yt-dlp 的字段名在不同站点/版本间会漂，收敛在这一处。
 */
function normalizeInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const height = info.height || (info.format_note && parseInt(info.format_note, 10)) || null;
  return {
    url: info.webpage_url || info.original_url || info.url || null,
    video_id: info.id ? String(info.id) : null,
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
    is_live: Boolean(info.is_live),
  };
}

/** 数据库行 → 领域对象。补上类型，别让 0/1 和 true/false 到处混 */
function fromRow(row) {
  if (!row) return null;
  return {
    ...row,
    // SQLite 没有布尔类型，统一在这一层转换，调用方永远拿布尔
    starred: Boolean(row.starred),
    thumb_embed_ok: row.thumb_embed_ok === null || row.thumb_embed_ok === undefined
      ? null : Boolean(row.thumb_embed_ok),
  };
}

/**
 * 领域对象 → 可写列。
 *
 * @param {object} patch
 * @param {object} [opts]
 * @param {boolean} [opts.strict] 传了不在白名单里的键就直接抛错
 *        （开发期用 VAULT_STRICT_DB=1 打开，把"静默丢数据"变成"当场报错"——坑 16）
 * @returns {{cols:string[], values:any[], dropped:string[]}}
 */
function toRow(patch, { strict = false } = {}) {
  const src = patch || {};
  const cols = [];
  const values = [];
  const dropped = [];

  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;              // undefined = 没打算改这一列
    if (READONLY_COLS.includes(k)) { dropped.push(k); continue; }
    if (!WRITABLE.has(k)) { dropped.push(k); continue; }
    cols.push(k);
    // 布尔统一存成 0/1
    values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }

  if (dropped.length && strict) {
    const { ValidationError } = require('./errors');
    throw new ValidationError(
      `这些字段不在可写白名单里，会被丢弃：${dropped.join(', ')}`,
      { hint: `可写的列是：${WRITABLE_COLS.join(', ')}` },
    );
  }
  return { cols, values, dropped };
}

/** 一条记录算不算"已经拿到成品文件" */
function isComplete(video) {
  return Boolean(video && video.status === STATUS.DONE && video.file_path);
}

/** 展示用标题（标题可能为空，回退到 id 或 URL） */
function displayTitle(video) {
  if (!video) return '';
  return video.title || (video.video_id ? `（无标题 ${video.video_id}）` : video.url || '（未知）');
}

module.exports = {
  WRITABLE_COLS,
  READONLY_COLS,
  normalizeUrl,
  classifyUrl,
  normalizeInfo,
  fromRow,
  toRow,
  isComplete,
  displayTitle,
};
