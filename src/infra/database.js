'use strict';
/**
 * 数据访问层：SQLite 仓储。
 *
 * ⚠️ 跟重构前最重要的区别：**不再把裸连接句柄导出给全世界。**
 *
 * 以前 `lib/db.js` 导出 `db`（原始 DatabaseSync），于是 server.js、queue.js
 * 里到处散落着 `db.db.prepare('SELECT ...')`。后果有三个：
 *
 *   1. **SQL 泄漏到每一层** —— 改个表结构要全项目 grep
 *   2. **没有事务边界** —— "读出来 → 算一下 → 写两处"这种序列随时可能被
 *      并发插入打断，而没有任何一处能声明"这三步是一个整体"
 *      （dedupeByFile 就是典型：要合并两条记录 + 删掉多余的，中途失败就半拉子）
 *   3. **测试没法隔离** —— 模块一 require 就打开真实库，测试只能操作用户的真实数据
 *      （历史上因此误删过 7 条记录）
 *
 * 现在：`createDatabase(config, options)` 返回一个仓储对象，SQL 全部关在这一层。
 * 顺带解决了隔离问题 —— 测试传一个指向临时目录的 config 就行。
 */

const fsDefault = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { DEFAULT_SETTINGS } = require('../infra/config');
const { fromRow, toRow } = require('../domain/video');
const { STATUS } = require('../infra/config');

/** 建表语句。跟老库完全兼容 —— 一个字符都不改，否则老用户升级就打不开了。 */
const SCHEMA = `
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

  kind          TEXT NOT NULL DEFAULT 'video',
  quality       TEXT,
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

  transcoded_path TEXT,
  transcode_status TEXT,
  transcode_preset TEXT,

  subscription_id INTEGER,

  playlist_id   INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
  playlist_index INTEGER,
  notes         TEXT,
  starred       INTEGER DEFAULT 0,

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

-- ───────────────────────────── 从网站找视频 ─────────────────────────────
-- 一次爬取一行。status: running | done | failed
-- paging_json 存 [{label,url}] —— 用户点哪一页就再发起一次爬取（不自动翻页）
CREATE TABLE IF NOT EXISTS crawl_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',
  path        TEXT,
  site        TEXT,
  title       TEXT,
  item_count  INTEGER DEFAULT 0,
  paging_json TEXT,
  note        TEXT,
  error       TEXT,
  started_at  TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);

-- 候选条目。**故意不复用 videos 表**：候选不是下载任务，
-- 混进 videos 会污染「我的库」的计数、筛选与查询。
--   url            UNIQUE：同一条视频被多轮爬到时不重复堆积
--   site_video_id  站内 id 优先做去重键（slug 会被人改，站内 id 不会）
--   in_library     爬取时对 videos.url 做一次 IN 查询的快照，不是外键 ——
--                  用户的库随时在变，界面上还要能手动刷新
--   added_at       非空 = 已加入下载队列
CREATE TABLE IF NOT EXISTS candidates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  url            TEXT NOT NULL UNIQUE,
  site_video_id  TEXT,
  title          TEXT,
  duration_sec   INTEGER,
  thumb_url      TEXT,
  source_url     TEXT,
  in_library     INTEGER DEFAULT 0,
  added_at       TEXT,
  created_at     TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_candidates_lib ON candidates(in_library);

-- ───────────────────────────── 库页分组 ─────────────────────────────
-- 自定义分组。name 用 UNIQUE：重名要 409，不能建出两个肉眼一样的组。
-- color 存**预设色的 key**（不是色值）—— 以后调色板变了，旧数据仍是合法 key。
CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL DEFAULT 'amber',
  sort_order  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);

-- 视频 ↔ 分组，多对多。**不在这个表里 = 未分组**。
-- ON DELETE CASCADE：删视频时关系自动清掉，不留悬空行。
CREATE TABLE IF NOT EXISTS video_groups (
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  added_at   TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (video_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_vg_group ON video_groups(group_id);
`;

/** 路径自愈时认作"本项目自己的"子目录（只有这两个，避免误伤用户的外部目录） */
const OWN_SUBDIRS = ['downloads', 'data'];

/**
 * @param {object} config loadConfig() 的产物
 * @param {object} [options]
 * @param {object} [options.fs]      注入 fs（测试用）
 * @param {boolean} [options.strict] 白名单外的字段直接抛错（开发期 VAULT_STRICT_DB=1）
 * @returns {object} 仓储
 */
function createDatabase(config, options = {}) {
  const fs = options.fs || fsDefault;
  const strict = options.strict ?? Boolean(process.env.VAULT_STRICT_DB);

  fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });
  const db = new DatabaseSync(config.paths.db);
  db.exec(SCHEMA);

  // ---------------------------------------------------------------- 事务

  /**
   * 把一组写操作包成一个事务。
   *
   * 为什么必须显式提供：SQLite 的每条语句自带隐式事务，但"读-改-写"这种
   * 跨语句的序列不在同一个事务里。dedupeByFile 要合并两条记录再删掉多余的，
   * 中途抛异常就会留下"合并了一半"的状态 —— 而磁盘文件只有一份，
   * 库和磁盘就对不上了。
   *
   * 用 BEGIN IMMEDIATE 而不是 BEGIN：立刻拿写锁，避免升级锁时才发现冲突。
   */
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败就只能往上抛原错误 */ }
      throw e;
    }
  }

  // ---------------------------------------------------------------- 设置

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
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    );
    transaction(() => {
      for (const [k, v] of Object.entries(patch || {})) {
        // 只接受已知设置键：防止前端塞进来任意键把设置表撑成一锅粥
        if (!(k in DEFAULT_SETTINGS)) continue;
        stmt.run(k, JSON.stringify(v));
      }
    });
    return getSettings();
  }

  // ---------------------------------------------------------------- 迁移

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
   * 背景：数据库里存的是绝对路径。一旦把项目文件夹挪走，服务本身还能起来
   * （路径都从 __dirname 推导），但库里每条记录都指向旧位置 —— 封面空白、
   * 播放 404、找不到源文件。
   *
   * 做法：把"旧根目录 + 相对片段"重写成"当前根目录 + 同一相对片段"。
   * 只有满足下面**全部**条件才改写，避免误伤用户自定义的外部目录：
   *   1. 存的是绝对路径
   *   2. 用当前根目录拼不出来、但旧路径里能识别出一个已知子目录
   *   3. 该子目录在当前根下确实存在
   */
  function healPaths() {
    const fixed = {
      file_path: 0, thumbnail_path: 0, log_path: 0, downloadDir: false,
    };
    const rootLower = config.root.toLowerCase();

    const rewrite = (p) => {
      if (!p || typeof p !== 'string') return null;
      if (!path.isAbsolute(p)) return null;
      const norm = path.normalize(p);
      // 已经在当前根目录下 → 无需处理
      if (norm.toLowerCase().startsWith(rootLower + path.sep)) return null;

      for (const sub of OWN_SUBDIRS) {
        /**
         * 锚点匹配：`\<sub>` 后面要么是分隔符，要么就**到头了**。
         *
         * ⚠️ 这是修一个真实 bug（老代码也有）：
         *    原来只找 `\<sub>\`（带尾分隔符），于是 `settings.downloadDir`
         *    指向 `...\项目\downloads` **本身**时匹配不上（路径以 `downloads` 结尾，
         *    后面没有反斜杠）→ 自愈静默跳过 → 用户把项目文件夹挪走之后，
         *    downloadDir 还指着旧位置，**新下载会落到已经不存在的路径上**。
         *
         *    而 file_path / log_path 这些带文件名的路径末尾有分隔符，所以一直正常 ——
         *    这也解释了为什么这个 bug 一直没被发现。
         */
        const re = new RegExp(`${path.sep.replace(/\\/g, '\\\\')}${sub}(${path.sep.replace(/\\/g, '\\\\')}|$)`, 'i');
        const m = re.exec(norm);
        if (!m) continue;
        // m.index 指向分隔符；+1 跳过它，得到以 <sub> 开头的相对路径
        const rel = norm.slice(m.index + 1);
        const subAbs = path.join(config.root, sub);
        if (!fs.existsSync(subAbs)) continue;   // 当前根下没有该子目录，不动
        return path.join(config.root, rel);
      }
      return null;
    };

    // 只修这三个路径。**不再包含 transcoded_path** —— 转码功能已整体移除，
    // 那个列还留在表里（保留列，代码不碰），但自愈不该再去写它。
    const rows = db.prepare(
      'SELECT id, file_path, thumbnail_path, log_path FROM videos',
    ).all();
    const up = db.prepare(
      'UPDATE videos SET file_path=?, thumbnail_path=?, log_path=? WHERE id=?',
    );
    transaction(() => {
      for (const r of rows) {
        const nf = rewrite(r.file_path);
        const nt = rewrite(r.thumbnail_path);
        const nl = rewrite(r.log_path);
        if (!nf && !nt && !nl) continue;
        if (nf) fixed.file_path += 1;
        if (nt) fixed.thumbnail_path += 1;
        if (nl) fixed.log_path += 1;
        up.run(nf || r.file_path, nt || r.thumbnail_path, nl || r.log_path, r.id);
      }

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
    });

    return fixed;
  }

  /**
   * 一次性迁移。
   *
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
        || healed.downloadDir)) {
      result.pathsHealed = healed;
    }

    const done = db.prepare("SELECT value FROM settings WHERE key='_migrated_unlimited_rate'").get();
    if (!done) {
      const cur = db.prepare("SELECT value FROM settings WHERE key='rateLimitMB'").get();
      let was = null;
      try { was = cur ? JSON.parse(cur.value) : null; } catch { was = null; }
      transaction(() => {
        if (was === 5) db.prepare("UPDATE settings SET value='0' WHERE key='rateLimitMB'").run();
        db.prepare("INSERT INTO settings(key,value) VALUES('_migrated_unlimited_rate','1')").run();
      });
      result.rateLimitMB = { from: was, to: was === 5 ? 0 : was };
    }

    return result;
  }

  // ---------------------------------------------------------------- videos

  function getVideo(id) {
    return fromRow(db.prepare('SELECT * FROM videos WHERE id = ?').get(id) || null);
  }

  function findByUrl(url) {
    return fromRow(db.prepare('SELECT * FROM videos WHERE url = ?').get(url) || null);
  }

  function insertVideo(data) {
    const { cols, values, dropped } = toRow(data, { strict });
    if (!cols.length) {
      const { ValidationError } = require('../domain/errors');
      throw new ValidationError('insertVideo: 没有可写入的字段', {
        hint: dropped.length ? `这些字段不在白名单里：${dropped.join(', ')}` : '',
      });
    }
    const sql = `INSERT INTO videos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    const info = db.prepare(sql).run(...values);
    return getVideo(Number(info.lastInsertRowid));
  }

  function updateVideo(id, patch) {
    const { cols, values } = toRow(patch, { strict });
    if (!cols.length) return getVideo(id);
    const sql = `UPDATE videos SET ${cols.map((c) => `${c}=?`).join(',')},
                 updated_at=datetime('now','localtime') WHERE id=?`;
    db.prepare(sql).run(...values, id);
    return getVideo(id);
  }

  /**
   * 库查询的筛选与排序 —— `listVideos`（分页）与 `listVideosAll`（全集）**共用**。
   *
   * 抽出来是因为分组需要"筛选后的全集"。如果复制一份 WHERE 出来，
   * 两边的筛选条件迟早会不一致 —— 那种 bug 表现为"分组里的条数跟列表对不上"，
   * 而且很难查（两个地方看起来都对）。抽共享片段就没有这个可能。
   *
   * @returns {{whereSql:string, args:any[], orderBy:string}}
   */
  function buildVideoQuery({
    q = '', status = '', site = '', uploader = '', starred = false, sort = 'created_desc',
  } = {}) {
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
    return {
      whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
      args,
      orderBy: sorts[sort] || sorts.created_desc,
    };
  }

  /** 库查询：关键词 + 状态 + 站点 + 作者 + 排序 */
  function listVideos(filters = {}) {
    const { limit = 200, offset = 0 } = filters;
    const { whereSql, args, orderBy } = buildVideoQuery(filters);

    const rows = db.prepare(
      `SELECT * FROM videos ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM videos ${whereSql}`).get(...args).n;
    return { rows: rows.map(fromRow), total };
  }

  /**
   * 与 `listVideos` 同一套筛选与排序，但**不分页**。
   * 分组要用它 —— 分组名后面的条数必须是全量条数，不是"这一页里有多少条"。
   */
  function listVideosAll(filters = {}) {
    const { whereSql, args, orderBy } = buildVideoQuery(filters);
    return db.prepare(`SELECT * FROM videos ${whereSql} ORDER BY ${orderBy}`)
      .all(...args).map(fromRow);
  }

  function facets() {
    return {
      sites: db.prepare(
        "SELECT site AS v, COUNT(*) AS n FROM videos WHERE site IS NOT NULL AND site<>'' GROUP BY site ORDER BY n DESC",
      ).all(),
      uploaders: db.prepare(
        "SELECT uploader AS v, COUNT(*) AS n FROM videos WHERE uploader IS NOT NULL AND uploader<>'' GROUP BY uploader ORDER BY n DESC LIMIT 100",
      ).all(),
      statuses: db.prepare('SELECT status AS v, COUNT(*) AS n FROM videos GROUP BY status').all(),
      totals: db.prepare(
        `SELECT COUNT(*) AS count_all,
                COALESCE(SUM(file_size),0) AS bytes_all,
                COALESCE(SUM(CASE WHEN status='done' THEN 1 ELSE 0 END),0) AS count_done
         FROM videos`,
      ).get(),
    };
  }

  /**
   * 删除记录。
   * ⚠️ 默认**只删记录、不动文件** —— 这条是刻意的：下载好的视频来之不易，
   *    一个误点就永久删掉是不可接受的。要删文件必须显式 keepFile=false 且上层二次确认。
   */
  function deleteVideo(id, { keepFile = true } = {}) {
    const v = getVideo(id);
    if (!v) return null;
    db.prepare('DELETE FROM videos WHERE id = ?').run(id);
    return { video: v, keepFile };
  }

  function countByStatus(status) {
    return db.prepare('SELECT COUNT(*) AS n FROM videos WHERE status = ?').get(status).n;
  }

  function countActive() {
    return db.prepare(
      `SELECT COUNT(*) AS n FROM videos WHERE status IN (?,?,?,?)`,
    ).get(STATUS.QUEUED, STATUS.PARSING, STATUS.DOWNLOADING, STATUS.PROCESSING).n;
  }

  /** 按状态取一批（调度器用） */
  function listByStatus(status, limit = 1) {
    const rows = db.prepare(
      'SELECT * FROM videos WHERE status = ? ORDER BY id ASC LIMIT ?',
    ).all(status, limit);
    return rows.map(fromRow);
  }

  function listByStatuses(statuses) {
    const ph = statuses.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM videos WHERE status IN (${ph})`).all(...statuses).map(fromRow);
  }

  /** 启动时把"上次没跑完"的任务标成 paused，实现「手动点继续才续」 */
  function markStaleActiveAsPaused() {
    const stale = db.prepare(
      `SELECT id FROM videos WHERE status IN (?,?,?,?)`,
    ).all(STATUS.QUEUED, STATUS.PARSING, STATUS.DOWNLOADING, STATUS.PROCESSING);
    if (stale.length) {
      db.prepare(
        `UPDATE videos SET status=?, error='上次会话中断，等待手动继续',
           updated_at=datetime('now','localtime')
         WHERE status IN (?,?,?,?)`,
      ).run(STATUS.PAUSED, STATUS.QUEUED, STATUS.PARSING, STATUS.DOWNLOADING, STATUS.PROCESSING);
    }
    return stale.map((s) => s.id);
  }

  /** 全库扫描一次重复（同 file_path 有多条），供启动时清理 */
  function findDuplicateFiles() {
    return db.prepare(
      `SELECT file_path, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
       FROM videos WHERE file_path IS NOT NULL AND file_path != ''
       GROUP BY file_path HAVING n > 1`,
    ).all();
  }

  /**
   * 合并"指向同一个文件"的重复记录。
   *
   * 为什么需要：如果库出过问题、用 rebuild-library 从磁盘重建过，
   * 重建的记录用的是 `local://` 占位 URL。用户之后把**原始链接**再粘一次
   * 补元数据时，因为 URL 不同，会被当成新任务 → 同一个文件出现两条记录
   * （一条有真实 URL、一条有完整封面/备注）。
   *
   * 做法：优先保留**信息更全**的那条，把另一条缺的字段补过去。
   * 判断"更全"的顺序：有真实 URL > 有封面 > 有备注 > id 更小（先来的）。
   *
   * 整个合并放进一个事务 —— 中途失败绝不能留下"合并了一半"的状态。
   */
  function dedupeByFile(newId) {
    return transaction(() => {
      const nv = getVideo(newId);
      if (!nv || !nv.file_path) return null;

      const twins = db.prepare('SELECT * FROM videos WHERE file_path = ? AND id != ?')
        .all(nv.file_path, newId).map(fromRow);
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
          'thumb_embed_ok', 'thumb_format', 'playlist_id', 'playlist_index', 'video_id',
          'extractor', 'uploader', 'site', 'title', 'file_size', 'container']) {
          if ((keep[col] === null || keep[col] === undefined || keep[col] === '')
            && src[col] !== null && src[col] !== undefined && src[col] !== '') {
            patch[col] = src[col];
            keep = { ...keep, [col]: src[col] };
          }
        }
      }
      if (Object.keys(patch).length) {
        const { cols, values } = toRow(patch, { strict });
        if (cols.length) {
          db.prepare(`UPDATE videos SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`)
            .run(...values, keep.id);
        }
      }

      // 删掉其余的（磁盘文件只留一份，绝不能删）
      let removed = 0;
      for (const t of twins) {
        if (t.id === keep.id) continue;
        db.prepare('DELETE FROM videos WHERE id = ?').run(t.id);
        removed += 1;
      }
      if (nv.id !== keep.id) {
        db.prepare('DELETE FROM videos WHERE id = ?').run(nv.id);
        removed += 1;
      }
      return { kept: keep.id, removed, file: nv.file_path };
    });
  }

  // ---------------------------------------------------------------- playlists

  function upsertPlaylist({ url, title, uploader, site, item_count }) {
    db.prepare(
      `INSERT INTO playlists(url,title,uploader,site,item_count) VALUES(?,?,?,?,?)
       ON CONFLICT(url) DO UPDATE SET title=excluded.title, uploader=excluded.uploader,
         site=excluded.site, item_count=excluded.item_count`,
    ).run(url, title || null, uploader || null, site || null, item_count || 0);
    return db.prepare('SELECT * FROM playlists WHERE url = ?').get(url);
  }

  function getPlaylistItems(playlistId) {
    return db.prepare(
      'SELECT * FROM videos WHERE playlist_id = ? ORDER BY playlist_index ASC, id ASC',
    ).all(playlistId).map(fromRow);
  }

  // ---------------------------------------------------------------- events（SSE 游标）

  function emitEvent(type, payload) {
    const info = db.prepare('INSERT INTO events(type,payload) VALUES(?,?)')
      .run(type, payload ? JSON.stringify(payload) : null);
    return Number(info.lastInsertRowid);
  }

  function eventsSince(id) {
    return db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT 200').all(id)
      .map((e) => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
  }

  /** 老的 events 会一直堆积，启动时清一次 */
  function pruneEvents(keep = 5000) {
    db.prepare(
      `DELETE FROM events WHERE id <= (SELECT MAX(id) - ? FROM events)`,
    ).run(keep);
  }

  // ---------------------------------------------------------------- 爬取候选

  /**
   * 开一次爬取记录，返回 runId。
   * 先写记录再爬 —— 这样爬取中途失败/进程被杀，也能看出"有一次没跑完的爬取"。
   */
  function startCrawlRun({ url }) {
    const info = db.prepare('INSERT INTO crawl_runs (url) VALUES (?)').run(String(url));
    return Number(info.lastInsertRowid);
  }

  function finishCrawlRun(id, {
    status = 'done', path = null, site = null, title = null,
    itemCount = 0, paging = null, note = null, error = null,
  } = {}) {
    db.prepare(`
      UPDATE crawl_runs
         SET status = ?, path = ?, site = ?, title = ?, item_count = ?,
             paging_json = ?, note = ?, error = ?,
             finished_at = datetime('now','localtime')
       WHERE id = ?
    `).run(
      String(status), path, site, title, Number(itemCount) || 0,
      paging ? JSON.stringify(paging) : null, note, error, Number(id),
    );
  }

  function getCrawlRun(id) {
    const row = db.prepare('SELECT * FROM crawl_runs WHERE id = ?').get(Number(id));
    return row || null;
  }

  /**
   * 批量写入候选。
   *
   * 用 `INSERT OR IGNORE` + `changes` 统计 inserted/skipped ——
   * 靠 `url` 的 UNIQUE 约束去重，不先查一遍（那会有并发窗口）。
   * 放在一个事务里：中途失败不留半拉子结果。
   */
  function insertCandidates(runId, items, sourceUrl = null) {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO candidates
        (run_id, url, site_video_id, title, duration_sec, thumb_url, source_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    let skipped = 0;

    transaction(() => {
      for (const it of items || []) {
        if (!it || !it.url) { skipped += 1; continue; }
        const r = stmt.run(
          Number(runId), String(it.url), it.site_video_id || null,
          it.title || null,
          Number.isFinite(it.duration_sec) ? Math.round(it.duration_sec) : null,
          it.thumb_url || null, sourceUrl,
        );
        if (r.changes > 0) inserted += 1; else skipped += 1;
      }
    });
    return { inserted, skipped };
  }

  /** 候选行 → 界面用的形状（把 0/1 变成布尔、added_at 变成 added） */
  function candidateOut(row) {
    return {
      id: row.id,
      run_id: row.run_id,
      url: row.url,
      site_video_id: row.site_video_id,
      title: row.title,
      duration_sec: row.duration_sec,
      thumb_url: row.thumb_url,
      source_url: row.source_url,
      in_library: Boolean(row.in_library),
      added: Boolean(row.added_at),
      created_at: row.created_at,
    };
  }

  /**
   * 查候选。q 走 LIKE（参数化，绝不拼 SQL 字符串）。
   * @param {object} opts {q, onlyNew, runId, limit, offset}
   */
  function listCandidates({ q = '', onlyNew = false, runId = null, limit = 200, offset = 0 } = {}) {
    const where = [];
    const params = [];

    const kw = String(q || '').trim();
    if (kw) {
      where.push('title LIKE ?');
      params.push(`%${kw}%`);
    }
    if (onlyNew) where.push('in_library = 0');
    if (runId) { where.push('run_id = ?'); params.push(Number(runId)); }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM candidates ${clause}`).get(...params).c;
    const rows = db.prepare(
      `SELECT * FROM candidates ${clause} ORDER BY id ASC LIMIT ? OFFSET ?`,
    ).all(...params, Math.max(1, Number(limit) || 200), Math.max(0, Number(offset) || 0));

    return { rows: rows.map(candidateOut), total };
  }

  function getCandidatesByIds(ids) {
    const list = (ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!list.length) return [];
    const marks = list.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM candidates WHERE id IN (${marks}) ORDER BY id ASC`)
      .all(...list)
      .map(candidateOut);
  }

  /** 标记已入队。返回受影响条数。 */
  function markCandidatesAdded(ids) {
    const list = (ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!list.length) return 0;
    const marks = list.map(() => '?').join(',');
    const r = db.prepare(
      `UPDATE candidates SET added_at = datetime('now','localtime') WHERE id IN (${marks})`,
    ).run(...list);
    return Number(r.changes) || 0;
  }

  /**
   * 按 videos.url 重算 in_library。
   * 一条 UPDATE 搞定，不逐行查（候选可能上百条）。
   */
  function refreshLibraryFlags() {
    const r = db.prepare(`
      UPDATE candidates
         SET in_library = EXISTS (SELECT 1 FROM videos WHERE videos.url = candidates.url)
    `).run();
    return Number(r.changes) || 0;
  }

  // ---------------------------------------------------------------- 分组

  /**
   * 分组名归一化：去首尾空白 + 合并内部空白。名字本身保留这份清理后的样子。
   *
   * ⚠️ 查重另外用 `COLLATE NOCASE`（大小写不敏感）。只差一个空格或大小写的两个名字
   * 在界面上看起来一模一样，用户会分不清点哪个 —— 所以都算重名，返回 409。
   */
  const normGroupName = (name) => String(name == null ? '' : name).trim().replace(/\s+/g, ' ');

  function groupOut(row) {
    return {
      id: row.id, name: row.name, color: row.color,
      created_at: row.created_at, count: Number(row.count) || 0,
    };
  }

  /**
   * 所有自定义分组 + 每组条数。**含 0 条的组** ——
   * 刚建的分组如果因为"空"而不显示，用户会以为没建成。
   */
  function listGroups() {
    return db.prepare(`
      SELECT g.id, g.name, g.color, g.created_at,
             (SELECT COUNT(*) FROM video_groups vg WHERE vg.group_id = g.id) AS count
        FROM groups g
       ORDER BY g.created_at ASC, g.id ASC
    `).all().map(groupOut);
  }

  function createGroup({ name, color = 'amber' } = {}) {
    const { ValidationError } = require('../domain/errors');
    const clean = normGroupName(name);
    if (!clean) {
      throw new ValidationError('分组名不能为空', { hint: '给它起个名字，比如「待看」。' });
    }
    if (clean.length > 40) {
      throw new ValidationError('分组名太长了（最多 40 个字符）', { hint: '短一点更好认。' });
    }
    const dup = db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE').get(clean);
    if (dup) {
      throw new ValidationError(`已经有叫「${clean}」的分组了`, {
        status: 409, hint: '换一个名字，或者直接用现有的那个。',
      });
    }
    const info = db.prepare('INSERT INTO groups (name, color) VALUES (?, ?)')
      .run(clean, String(color));
    const row = db.prepare('SELECT id, name, color, created_at FROM groups WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    return groupOut({ ...row, count: 0 });
  }

  function updateGroup(id, { name, color } = {}) {
    const { ValidationError } = require('../domain/errors');
    const gid = Number(id);
    const cur = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
    if (!cur) return null;

    const patch = {};
    if (name !== undefined) {
      const clean = normGroupName(name);
      if (!clean) throw new ValidationError('分组名不能为空', { hint: '给它起个名字。' });
      if (clean.length > 40) throw new ValidationError('分组名太长了（最多 40 个字符）');
      const dup = db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE AND id <> ?')
        .get(clean, gid);
      if (dup) {
        throw new ValidationError(`已经有叫「${clean}」的分组了`, { status: 409, hint: '换一个名字。' });
      }
      patch.name = clean;
    }
    if (color !== undefined) patch.color = String(color);

    const cols = Object.keys(patch);
    if (cols.length) {
      db.prepare(`UPDATE groups SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`)
        .run(...cols.map((c) => patch[c]), gid);
    }
    return listGroups().find((g) => g.id === gid) || null;
  }

  /**
   * 删分组。两种模式（spec 3.1）：
   *   `detach`（默认）：只删关系行，**视频记录一条不少**
   *   `purge`         ：删掉组内视频的**库记录**（CASCADE 顺手清关系），
   *                     **磁盘文件一律不动**
   *
   * ⚠️ `purge` 不删文件是刻意的：与项目现有的删除语义一致 ——
   *    "记录和文件一起永久删除"是列表里另一个带二次确认的路径。
   *    文件名叫 purge 很容易让人以为连文件一起清了，所以这里的注释和
   *    界面文案都必须写明"磁盘文件保留"。
   */
  function deleteGroup(id, { mode = 'detach' } = {}) {
    const gid = Number(id);
    if (!db.prepare('SELECT id FROM groups WHERE id = ?').get(gid)) return null;
    const useMode = mode === 'purge' ? 'purge' : 'detach';

    let removedVideos = 0;
    transaction(() => {
      if (useMode === 'purge') {
        const ids = db.prepare('SELECT video_id FROM video_groups WHERE group_id = ?')
          .all(gid).map((r) => r.video_id);
        if (ids.length) {
          const marks = ids.map(() => '?').join(',');
          removedVideos = db.prepare(`DELETE FROM videos WHERE id IN (${marks})`).run(...ids).changes;
        }
      }
      db.prepare('DELETE FROM groups WHERE id = ?').run(gid);
    });
    return { mode: useMode, removedVideos: Number(removedVideos) || 0 };
  }

  /** 批量入组。幂等（INSERT OR IGNORE）；不存在的视频/分组直接跳过 */
  function addToGroup(videoIds, groupId) {
    const gid = Number(groupId);
    if (!db.prepare('SELECT id FROM groups WHERE id = ?').get(gid)) return 0;
    const exists = db.prepare('SELECT id FROM videos WHERE id = ?');
    const stmt = db.prepare('INSERT OR IGNORE INTO video_groups (video_id, group_id) VALUES (?, ?)');
    let added = 0;
    transaction(() => {
      for (const raw of videoIds || []) {
        const vid = Number(raw);
        if (!Number.isInteger(vid)) continue;
        if (!exists.get(vid)) continue;
        added += Number(stmt.run(vid, gid).changes) || 0;
      }
    });
    return added;
  }

  /** 批量出组。只摘关系，视频记录不动 */
  function removeFromGroup(videoIds, groupId) {
    const list = (videoIds || []).map(Number).filter(Number.isInteger);
    if (!list.length) return 0;
    const marks = list.map(() => '?').join(',');
    return Number(db.prepare(
      `DELETE FROM video_groups WHERE group_id = ? AND video_id IN (${marks})`,
    ).run(Number(groupId), ...list).changes) || 0;
  }

  /** 一批视频各自属于哪些分组 —— 前端据此标"这条在哪几个组里" */
  function groupIdsFor(videoIds) {
    const out = new Map();
    const list = (videoIds || []).map(Number).filter(Number.isInteger);
    if (!list.length) return out;
    const marks = list.map(() => '?').join(',');
    for (const r of db.prepare(
      `SELECT video_id, group_id FROM video_groups WHERE video_id IN (${marks})`,
    ).all(...list)) {
      if (!out.has(r.video_id)) out.set(r.video_id, []);
      out.get(r.video_id).push(r.group_id);
    }
    return out;
  }

  // ---------------------------------------------------------------- 生命周期

  function close() {
    try { db.close(); } catch { /* 已经关了 */ }
  }

  return {
    // 设置
    getSettings, setSettings,
    // 迁移
    runMigrations, healPaths, ensureColumns,
    // videos
    getVideo, findByUrl, insertVideo, updateVideo, listVideos, facets,
    listVideosAll,
    deleteVideo, countByStatus, countActive, listByStatus, listByStatuses,
    markStaleActiveAsPaused, findDuplicateFiles, dedupeByFile,
    // 分组（库页）
    listGroups, createGroup, updateGroup, deleteGroup,
    addToGroup, removeFromGroup, groupIdsFor,
    // playlists
    upsertPlaylist, getPlaylistItems,
    // events
    emitEvent, eventsSince, pruneEvents,
    // 爬取候选（「从网站找视频」）
    startCrawlRun, finishCrawlRun, getCrawlRun,
    insertCandidates, listCandidates, getCandidatesByIds,
    markCandidatesAdded, refreshLibraryFlags,
    // 事务与生命周期
    transaction, close,
    /** 仅供测试与迁移脚本使用。业务代码不要碰它。 */
    raw: db,
  };
}

module.exports = { createDatabase, SCHEMA, OWN_SUBDIRS };
