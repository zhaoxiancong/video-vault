'use strict';
/**
 * 出站数据的形状定义 —— 前端能看到的字段清单，只有这一处。
 *
 * 为什么要"瘦身"而不是直接把数据库行丢给前端：
 *  1. 数据库行长这样：`SELECT *` 里有 log_path（本机绝对路径）、
 *     thumb_embed_ok（内部判定）、subscription_id（二期字段）……
 *     这些泄露给前端既没用，也把本机目录结构暴露给了页面。
 *  2. 前端能看到的字段一旦散落各处，就没法回答"改这个字段名会影响谁"。
 *
 * 所以：**凡是发给浏览器的记录，都先过 slim()。**
 */

/** 单条视频记录 → 前端视图 */
function slim(v) {
  if (!v) return null;
  return {
    id: v.id, url: v.url, title: v.title, uploader: v.uploader, site: v.site,
    kind: v.kind, quality: v.quality, status: v.status, progress: v.progress,
    speed: v.speed, eta: v.eta, error: v.error, duration: v.duration,
    file_size: v.file_size, width: v.width, height: v.height, fps: v.fps,
    vcodec: v.vcodec, acodec: v.acodec,
    container: v.container, upload_date: v.upload_date, description: v.description,
    thumbnail_path: v.thumbnail_path, thumbnail_url: v.thumbnail_url,
    file_path: v.file_path,
    playlist_id: v.playlist_id, playlist_index: v.playlist_index,
    notes: v.notes, starred: v.starred,
    created_at: v.created_at, finished_at: v.finished_at,
  };
}

/** 队列里的活动任务：只留进度条需要的字段（比 slim 更瘦，因为要高频推送） */
function slimQueueItem(v) {
  return {
    id: v.id, title: v.title, status: v.status, progress: v.progress,
    speed: v.speed, eta: v.eta, kind: v.kind, site: v.site,
    uploader: v.uploader, error: v.error,
  };
}

/** 历史任务：比 slim 再瘦一点，加上封面可用性标记 */
function slimHistoryRow(v) {
  return {
    id: v.id, title: v.title, url: v.url, status: v.status, progress: v.progress,
    kind: v.kind, site: v.site, uploader: v.uploader, error: v.error,
    file_path: v.file_path, file_size: v.file_size, duration: v.duration,
    height: v.height, container: v.container, finished_at: v.finished_at,
    thumb_embed_ok: v.thumb_embed_ok,
  };
}

/** 分页结果 */
function slimPage({ rows, total }) {
  return { total, rows: rows.map(slim) };
}

module.exports = { slim, slimQueueItem, slimHistoryRow, slimPage };
