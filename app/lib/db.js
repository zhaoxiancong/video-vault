'use strict';
/**
 * 元数据库：SQLite（Node 内置 node:sqlite，零依赖）。
 *
 * 设计说明（对应被 grill 出来的三个真实需求：防丢 / 建库 / 剪素材）：
 *  - videos       一条 = 一个媒体文件。是"库"的本体，支持搜索筛选。
 *  - playlists    播放列表/合集，下面前者是它的条目。
 *  - settings     键值设置。
 *  - events       递增事件游标，供 SSE 推送。
 *
 * 去重策略：videos.url UNIQUE。重复粘同一个链接不会重复下载，
 * 而是把已存在的那条返回给前端（并提示"库里已有"）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PATHS, DEFAULT_SETTINGS } = require('./config');

const db = new DatabaseSync(PATHS.DB);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS playlists (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  url           TEXT NOT NULL,
  title         TEXT,
  uploader      TEXT,
  site          TEXT,
  item_count    INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(url)
);

CREATE TABLE IF NOT EXISTS videos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  url           TEXT NOT NULL UNIQUE,
  video_id      TEXT,
  extractor     TEXT,
  site          TEXT,
  title         TEXT,
  uploader      TEXT,
  upload_date   TEXT,
  duration      INTEGER,
  description   TEXT,
  thumbnail_url TEXT,
  thumbnail_path TEXT,

  kind          TEXT NOT NULL DEFAULT 'video',   -- video | audio
  quality       TEXT,                            -- best / 1080p / 720p ...
  container     TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',
  progress      REAL DEFAULT 0,
  speed         REAL DEFAULT 0,
  eta           INTEGER,
  error         TEXT,
  log_path      TEXT,

  file_path     TEXT,
  file_size     INTEGER,
  width         INTEGER,
  height        INTEGER,
  fps           REAL,
  vcodec        TEXT,
  acodec        TEXT,

  -- 转码产物（剪辑层）：原始文件永不改动，转码结果另存
  transcoded_path TEXT,
  transcode_status TEXT,
  transcode_preset TEXT,

  -- 订阅追更（二期）
  subscription_id INTEGER,

  playlist_id   INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
  playlist_index INTEGER,
  notes         TEXT,
  starred       INTEGER DEFAULT 0,

  -- 封面能否安全嵌入（ffmpeg 不支持 avif 等格式；为 0 时下载参数里不加 --embed-thumbnail）
  thumb_embed_ok INTEGER,
  thumb_format   TEXT,

  created_at    TEXT DEFAULT (datetime('now','localtime')),
  updated_at    TEXT DEFAULT (datetime('now','localtime')),
  finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_videos_status   ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_uploader ON videos(uploader);
CREATE INDEX IF NOT EXISTS idx_videos_site     ON videos(site);
CREATE INDEX IF NOT EXISTS idx_videos_created  ON videos(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT NOT NULL UNIQUE,
  label       TEXT,
  site        TEXT,
  enabled     INTEGER DEFAULT 1,
  quality     TEXT DEFAULT 'best',
  kind        TEXT DEFAULT 'video',
  last_check  TEXT,
  last_seen   TEXT,
  check_interval_min INTEGER DEFAULT 60,
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);
`);

// ---------- settings ----------

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

function setSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue; // 只接受已知设置键
    stmt.run(k, JSON.stringify(v));
  }
  return getSettings();
}

/**
 * 给已存在的表补列。
 *
 * ⚠️ SQLite 的 `CREATE TABLE IF NOT EXISTS` **不会**给已存在的表加新列，
 *    所以每次给 videos 加字段，都必须在这里补一条 ALTER TABLE，
 *    否则老用户的数据库会缺列、查询直接报 "no such column"。
 */
function ensureColumns() {
  const added = [];
  const cols = db.prepare('PRAGMA table_info(videos)').all().map((r) => r.name);
  const needed = [
    ['thumb_embed_ok', 'INTEGER'],
    ['thumb_format', 'TEXT'],
  ];
  for (const [name, type] of needed) {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE videos ADD COLUMN ${name} ${type}`);
      added.push(name);
    }
  }
  return added;
}

/**
 * 路径自愈：让整个工具目录可以**被移动到任何地方**而不丢数据。
 *
 * 背景：数据库里存的是绝对路径（file_path / thumbnail_path / log_path /
 * transcoded_path，以及 settings.downloadDir）。一旦把项目文件夹挪走，
 * 服务本身还能起来（所有路径都是相对 __dirname 定位的），
 * 但库里每条记录都指向旧位置 —— 封面空白、播放 404、转码找不到源文件。
 *
 * 做法：把"旧根目录 + 相对片段"重写成"当前根目录 + 同一相对片段"。
 * 只有满足下面**全部**条件才改写，避免误伤用户自定义的外部目录：
 *   1. 存的是绝对路径
 *   2. 用当前根目录拼不出来、但旧路径里能识别出一个已知子目录
 *      （downloads / data，这正是本项目自己的目录）
 *   3. 该子目录在当前根下确实存在
 */
const OWN_SUBDIRS = ['downloads', 'data'];

function healPaths() {
  const fixed = { file_path: 0, thumbnail_path: 0, log_path: 0, transcoded_path: 0, downloadDir: false };

  const rewrite = (p) => {
    if (!p || typeof p !== 'string') return null;
    if (!path.isAbsolute(p)) return null;
    // 已经在当前根目录下 → 无需处理
    const norm = path.normalize(p);
    if (norm.toLowerCase().startsWith(PATHS.ROOT.toLowerCase() + path.sep)) return null;

    // 找出路径里属于本项目的子目录片段
    for (const sub of OWN_SUBDIRS) {
      const marker = path.sep + sub + path.sep;
      const idx = norm.toLowerCase().indexOf(marker.toLowerCase());
      if (idx === -1) continue;
      const rel = norm.slice(idx + 1);                 // downloads/... 或 data/...
      const candidate = path.join(PATHS.ROOT, rel);
      const subAbs = path.join(PATHS.ROOT, sub);
      if (!fs.existsSync(subAbs)) continue;            // 当前根下没有该子目录，不动
      return candidate;
    }
    return null;
  };

  const rows = db.prepare(
    'SELECT id, file_path, thumbnail_path, log_path, transcoded_path FROM videos'
  ).all();
  const up = db.prepare(
    `UPDATE videos SET file_path=?, thumbnail_path=?, log_path=?, transcoded_path=? WHERE id=?`
  );
  for (const r of rows) {
    const nf = rewrite(r.file_path);
    const nt = rewrite(r.thumbnail_path);
    const nl = rewrite(r.log_path);
    const nc = rewrite(r.transcoded_path);
    if (!nf && !nt && !nl && !nc) continue;
    if (nf) fixed.file_path++;
    if (nt) fixed.thumbnail_path++;
    if (nl) fixed.log_path++;
    if (nc) fixed.transcoded_path++;
    up.run(nf || r.file_path, nt || r.thumbnail_path, nl || r.log_path, nc || r.transcoded_path, r.id);
  }

  // settings.downloadDir 同理
  const row = db.prepare("SELECT value FROM settings WHERE key='downloadDir'").get();
  if (row) {
    let cur = null;
    try { cur = JSON.parse(row.value); } catch { cur = row.value; }
    const next = rewrite(cur);
    if (next) {
      db.prepare("UPDATE settings SET value=? WHERE key='downloadDir'").run(JSON.stringify(next));
      fixed.downloadDir = { from: cur, to: next };
    }
  }

  return fixed;
}

/**
 * 一次性迁移。
 * 背景：早期版本默认限速 5MB/s，下大文件时它成了唯一瓶颈（实测被完整吃满）。
 * 默认值已改成不限速，但**已存在的数据库里仍存着旧的 5**，改默认值对老库无效，
 * 所以这里做一次显式迁移。只跑一次，之后用户自己改的值不会再被覆盖。
 */
function runMigrations() {
  const result = { columnsAdded: ensureColumns(), rateLimitMB: null, pathsHealed: null };

  // 路径自愈每次都跑：它自带"已经在正确位置就跳过"的判断，开销只有一次全表扫描，
  // 换来的是"整个文件夹随便挪"的能力。
  const healed = healPaths();
  if (healed && (healed.file_path || healed.thumbnail_path || healed.log_path
      || healed.transcoded_path || healed.downloadDir)) {
    result.pathsHealed = healed;
  }

  const done = db.prepare("SELECT value FROM settings WHERE key='_migrated_unlimited_rate'").get();
  if (!done) {
    const cur = db.prepare("SELECT value FROM settings WHERE key='rateLimitMB'").get();
    let was = null;
    try { was = cur ? JSON.parse(cur.value) : null; } catch { was = null; }

    if (was === 5) {
      db.prepare("UPDATE settings SET value='0' WHERE key='rateLimitMB'").run();
    }
    db.prepare("INSERT INTO settings(key,value) VALUES('_migrated_unlimited_rate','1')").run();
    result.rateLimitMB = { from: was, to: was === 5 ? 0 : was };
  }

  return result;
}

// ---------- videos ----------

/**
 * 允许写入的列（插入 + 更新共用一份名单）。
 *
 * ⚠️ 为什么合成一份：原先"插入"和"更新"各有一份白名单，两边会各自漂移。
 *    实际后果是 insertVideo() 悄悄丢字段 —— 曾经 file_path / file_size /
 *    thumbnail_path 不在插入名单里，传进去直接被忽略，记录插进来却没有文件路径。
 *    这类"静默丢数据"的 bug 最难查：不报错、不崩溃，只是字段莫名其妙是 null。
 */
const WRITABLE_COLS = [
  // 标识与来源
  'url', 'video_id', 'extractor', 'site', 'title', 'uploader', 'upload_date',
  'duration', 'description', 'thumbnail_url', 'thumbnail_path',
  'kind', 'quality', 'container', 'status',
  // 进度
  'progress', 'speed', 'eta', 'error', 'log_path',
  // 产物（这三个曾经漏在插入名单外）
  'file_path', 'file_size',
  'width', 'height', 'fps', 'vcodec', 'acodec',
  // 转码
  'transcoded_path', 'transcode_status', 'transcode_preset',
  // 归类与元信息
  'playlist_id', 'playlist_index', 'subscription_id',
  'notes', 'starred', 'finished_at',
  'thumb_embed_ok', 'thumb_format',
];

const WRITABLE = new Set(WRITABLE_COLS);

function insertVideo(data) {
  const cols = WRITABLE_COLS.filter((c) => data[c] !== undefined);
  if (!cols.length) throw new Error('insertVideo: 没有可写入的字段');
  // 开发期自检：传了但不在白名单里的键，直接报出来，别再静默丢弃
  const dropped = Object.keys(data).filter(
    (k) => data[k] !== undefined && !WRITABLE.has(k) && k !== 'transcode_status'
  );
  if (dropped.length && process.env.VAULT_STRICT_DB) {
    throw new Error(`insertVideo: 这些字段不在白名单里，会被丢弃 → ${dropped.join(', ')}`);
  }
  const sql = `INSERT INTO videos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const info = db.prepare(sql).run(...cols.map((c) => data[c]));
  return getVideo(Number(info.lastInsertRowid));
}

function findByUrl(url) {
  return db.prepare('SELECT * FROM videos WHERE url = ?').get(url) || null;
}

function getVideo(id) {
  return db.prepare('SELECT * FROM videos WHERE id = ?').get(id) || null;
}

const UPDATABLE = WRITABLE;

function updateVideo(id, patch) {
  const cols = Object.keys(patch).filter((c) => UPDATABLE.has(c));
  if (!cols.length) return getVideo(id);
  const sql = `UPDATE videos SET ${cols.map((c) => `${c}=?`).join(',')},
               updated_at=datetime('now','localtime') WHERE id=?`;
  db.prepare(sql).run(...cols.map((c) => patch[c]), id);
  return getVideo(id);
}

/**
 * 库查询：关键词 + 状态 + 站点 + 作者 + 排序。
 */
function listVideos({ q = '', status = '', site = '', uploader = '', starred = false,
                      sort = 'created_desc', limit = 200, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (q) {
    where.push('(title LIKE ? OR uploader LIKE ? OR description LIKE ? OR url LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  if (status) { where.push('status = ?'); args.push(status); }
  if (site) { where.push('site = ?'); args.push(site); }
  if (uploader) { where.push('uploader = ?'); args.push(uploader); }
  if (starred) where.push('starred = 1');

  const sorts = {
    created_desc: 'created_at DESC',
    created_asc: 'created_at ASC',
    title_asc: 'title COLLATE NOCASE ASC',
    size_desc: 'file_size DESC',
    duration_desc: 'duration DESC',
  };
  const orderBy = sorts[sort] || sorts.created_desc;

  const sql = `SELECT * FROM videos
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, limit, offset);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM videos ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
  ).get(...args).n;
  return { rows, total };
}

function facets() {
  return {
    sites: db.prepare(
      "SELECT site AS v, COUNT(*) AS n FROM videos WHERE site IS NOT NULL AND site<>'' GROUP BY site ORDER BY n DESC"
    ).all(),
    uploaders: db.prepare(
      "SELECT uploader AS v, COUNT(*) AS n FROM videos WHERE uploader IS NOT NULL AND uploader<>'' GROUP BY uploader ORDER BY n DESC LIMIT 100"
    ).all(),
    statuses: db.prepare('SELECT status AS v, COUNT(*) AS n FROM videos GROUP BY status').all(),
    totals: db.prepare(
      `SELECT COUNT(*) AS count_all,
              COALESCE(SUM(file_size),0) AS bytes_all,
              COALESCE(SUM(CASE WHEN status='done' THEN 1 ELSE 0 END),0) AS count_done
       FROM videos`
    ).get(),
  };
}

function deleteVideo(id, { keepFile = false } = {}) {
  const v = getVideo(id);
  if (!v) return null;
  db.prepare('DELETE FROM videos WHERE id = ?').run(id);
  return { video: v, keepFile };
}

/**
 * 合并"指向同一个文件"的重复记录。
 *
 * 为什么需要：如果库出过问题、用 rebuild-library.js 从磁盘重建过，
 * 重建的记录用的是 `local://` 占位 URL。用户之后把**原始链接**再粘一次
 * 补元数据时，因为 URL 不同，会被当成新任务 → 同一个文件出现两条记录
 * （一条有真实 URL、一条有完整封面/备注）。
 *
 * 做法：优先保留**信息更全**的那条，把另一条缺的字段补过去。
 * 判断"更全"的顺序：有真实 URL > 有封面 > 有备注 > id 更小（先来的）。
 *
 * @returns {{kept:number, removed:number, file:string}|null}
 */
function dedupeByFile(newId) {
  const nv = getVideo(newId);
  if (!nv || !nv.file_path) return null;

  const twins = db.prepare('SELECT * FROM videos WHERE file_path = ? AND id != ?')
    .all(nv.file_path, newId);
  if (!twins.length) return null;

  const score = (v) => (
    (v.url && !String(v.url).startsWith('local://') ? 8 : 0)
    + (v.thumbnail_path ? 4 : 0)
    + (v.notes ? 2 : 0)
    + (v.description ? 1 : 0)
  );

  let keep = nv;
  for (const t of twins) if (score(t) > score(keep)) keep = t;

  // 把各条里"有值而 keep 没有"的字段汇总过去，尽量不丢信息
  const patch = {};
  for (const src of [nv, ...twins]) {
    if (src.id === keep.id) continue;
    for (const col of ['thumbnail_path', 'notes', 'description', 'upload_date',
      'duration', 'width', 'height', 'fps', 'vcodec', 'acodec',
      'transcoded_path', 'transcode_status', 'transcode_preset',
      'thumb_embed_ok', 'thumb_format', 'playlist_id', 'playlist_index', 'video_id',
      'extractor', 'uploader', 'site', 'title', 'file_size', 'container']) {
      if ((keep[col] === null || keep[col] === undefined || keep[col] === '')
        && src[col] !== null && src[col] !== undefined && src[col] !== '') {
        patch[col] = src[col];
        keep = { ...keep, [col]: src[col] };
      }
    }
  }
  if (Object.keys(patch).length) updateVideo(keep.id, patch);

  // 删掉其余的（磁盘文件只留一份，绝不能删）
  let removed = 0;
  for (const t of twins) {
    if (t.id === keep.id) continue;
    db.prepare('DELETE FROM videos WHERE id = ?').run(t.id);
    removed++;
  }
  if (nv.id !== keep.id) {
    db.prepare('DELETE FROM videos WHERE id = ?').run(nv.id);
    removed++;
  }
  return { kept: keep.id, removed, file: nv.file_path };
}

/** 全库扫描一次重复（同 file_path 有多条），供启动时清理 */
function findDuplicateFiles() {
  return db.prepare(
    `SELECT file_path, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
     FROM videos WHERE file_path IS NOT NULL AND file_path != ''
     GROUP BY file_path HAVING n > 1`
  ).all();
}

/** 启动时把"上次没跑完"的任务标成 paused，实现「手动点继续才续」。 */
function markStaleActiveAsPaused() {
  const stale = db.prepare(
    `SELECT id FROM videos WHERE status IN ('queued','parsing','downloading','processing')`
  ).all();
  if (stale.length) {
    db.prepare(
      `UPDATE videos SET status='paused',
         error='上次会话中断，等待手动继续',
         updated_at=datetime('now','localtime')
       WHERE status IN ('queued','parsing','downloading','processing')`
    ).run();
  }
  return stale.map((s) => s.id);
}

// ---------- playlists ----------

function upsertPlaylist({ url, title, uploader, site, item_count }) {
  db.prepare(
    `INSERT INTO playlists(url,title,uploader,site,item_count) VALUES(?,?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET title=excluded.title, uploader=excluded.uploader,
       site=excluded.site, item_count=excluded.item_count`
  ).run(url, title ?? null, uploader ?? null, site ?? null, item_count ?? 0);
  return db.prepare('SELECT * FROM playlists WHERE url = ?').get(url);
}

function getPlaylistItems(playlistId) {
  return db.prepare(
    'SELECT * FROM videos WHERE playlist_id = ? ORDER BY playlist_index ASC, id ASC'
  ).all(playlistId);
}

// ---------- events (SSE 游标) ----------

function emitEvent(type, payload) {
  const info = db.prepare('INSERT INTO events(type,payload) VALUES(?,?)')
    .run(type, JSON.stringify(payload ?? null));
  // 只保留最近 500 条，避免无限增长
  db.prepare('DELETE FROM events WHERE id < (SELECT MAX(id) FROM events) - 500').run();
  return Number(info.lastInsertRowid);
}

function eventsSince(id) {
  return db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT 200').all(id)
    .map((e) => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
}

module.exports = {
  db,
  getSettings, setSettings, runMigrations,
  insertVideo, findByUrl, getVideo, updateVideo, listVideos, facets,
  deleteVideo, markStaleActiveAsPaused,
  dedupeByFile, findDuplicateFiles,
  upsertPlaylist, getPlaylistItems,
  emitEvent, eventsSince,
};
