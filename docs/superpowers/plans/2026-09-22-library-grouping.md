# 库页分组 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「我的库」页能把列表按站点自动分段、并支持用户自建分组（多对多），配合多选做批量入组与批量收藏。

**Architecture:** 两张新表（`groups` / `video_groups`），`videos` 表一个字段都不加。仓储层新增分组读写 + 一个"筛选后全集"查询；HTTP 层新增 `GET /api/library/grouped`（服务端做分组，保证条数准确）与 groups 的 CRUD；前端在工具栏加「展示维度」下拉、分组渲染（可折叠）、多选与批量操作。

**Tech Stack:** Node ≥22.5（仅内置模块：`node:sqlite` / `node:test`）· 原生 ES 模块前端（无框架、无构建）· 零 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-22-library-grouping-design.md`

## Global Constraints

以下每条都来自 spec，**每个任务的要求都隐含包含本节**：

- **零 npm 依赖**：只用 Node 内置模块。不要 `require('better-sqlite3')`、不要引入任何包。
- **`videos` 表不加字段**：分组是独立维度，只用新表表达。
- **筛选先于分组**：`q`/`status`/`site`/`uploader`/`starred`/`sort` 先作用于全集，再分组。所以"筛了 BiliBili 再按站点分段"只会出现一个段 —— **这是正确行为，不是 bug**。
- **分组时忽略分页，封顶 2000**：超了返回前 2000 并置 `truncated: true`，界面必须明说。
- **删分组的默认模式是 `detach`**（只解散，视频记录一条不少）。`purge` 删的是**库记录**，**磁盘文件一律不动**；界面文案必须写成"删分组和里面的库记录（磁盘文件保留）"。
- **重名分组返回 409**，不静默建两个、不覆盖。
- **前端提示一律 `textContent`**，不拼 `innerHTML`；文案里**不写 Markdown 记号**（星号会原样露出）。
- **每个新类名都要在 `styles.css` 里有规则**，否则 `tools/check-classes.js` 会红。
- **改完 `src/` 必跑**：`node test/run.js`、`node tools/lint-undefined.js`、`node tools/check-frontend.js`、`node tools/check-classes.js`。
- **破坏性测试只用隔离实例**（临时目录），绝不碰用户真实库。
- **提交信息写文件再 `git commit -F`**，不要 `git commit -m`（消息里有引号会被 PowerShell 拆坏，本会话踩过 5 次）。

## Review Focus

spec 是愿景文档，它对下面这些输入的沉默**不是**"可以崩"的许可。每条都已分派到拥有该代码的任务：

1. **同一站点大小写不同**（`Youtube` vs `youtube`）：分组键必须**不敏感**地归并，否则会裂成两段。
2. **自定义分组重名**（只差空格或大小写）：必须 409，不能建出两个肉眼一样的组。
3. **一条视频都不在分组里**（全未分组）：`按分组` 模式下必须出现「未分组」段，而不是空列表。
4. **一个组里 0 条**：照常出现并标 `(0)`（用户明确要求 —— 刚建的组建完就"消失"会让人以为没建成）。
5. **批量操作里混有已不存在的视频 id**：忽略并如实报 `affected`，不能整体 500。
6. **`purge` 删分组后磁盘文件还在**：断言文件仍存在（这条最容易做错，也最伤人）。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/infra/database.js` | **改**：加两张表（SCHEMA）+ 8 个仓储方法；把 `listVideos` 的 WHERE/ORDER 抽成共享片段，新增"筛选后全集"查询 |
| `src/http/routes/library.js` | **改**：加 `GET /api/library/grouped`、`GET/POST/PATCH/DELETE /api/groups` |
| `src/http/routes/videos.js` | **改**：加 `POST /api/videos/group-action`、`POST /api/videos/bulk-action` |
| `src/web/views/library.js` | **改**：分组下拉、分组渲染与折叠、多选与批量操作 |
| `src/web/index.html` | **改**：工具栏加「展示维度」下拉与多选开关；加分组管理的弹层骨架 |
| `src/web/styles.css` | **改**：分组标题、颜色条、勾选框、管理弹层的样式 |
| `test/integration/database.test.js` | **改**：加分组仓储测试 |
| `test/integration/api.test.js` | **改**：加分组接口测试 |
| `test/integration/frontend-dom.test.mjs` | **改**：加分组渲染/折叠/多选测试 |

---

### Task 1: 数据层 —— 两张表 + 分组仓储

**Files:**
- Modify: `src/infra/database.js`（SCHEMA 末尾加表；仓储里加方法；`listVideos` 抽共享片段）
- Test: `test/integration/database.test.js`（追加）

**Interfaces:**
- Produces（都挂在 `repo` 上）：
  - `listGroups(): Array<{id,name,color,count,created_at}>` —— **含 0 条的组**
  - `createGroup({name,color}): {id,name,color}` —— 重名抛 `ValidationError`（`httpStatus` 409）
  - `updateGroup(id, {name,color}): {id,name,color}|null` —— 重名同样抛 409；不存在返回 null
  - `deleteGroup(id, {mode='detach'}): {mode, removedVideos:number}|null`
  - `addToGroup(videoIds, groupId): number`（返回实际新增的关系数，用 `INSERT OR IGNORE`）
  - `removeFromGroup(videoIds, groupId): number`
  - `groupIdsFor(videoIds): Map<number, number[]>`（给前端标"这条在哪几个组里"）
  - `listVideosAll(filters): Array<video>` —— 与 `listVideos` **同一套 WHERE/ORDER**，但不分页

- [ ] **Step 1: 写失败测试**

追加到 `test/integration/database.test.js`（沿用该文件已有的 `freshRepo()`）：

```js
// ---------------------------------------------------------------- 分组

test('分组：建组、列表（含 0 条的组）、重复名字报错', () => {
  const ctx = freshRepo();
  try {
    const g1 = ctx.repo.createGroup({ name: '待看', color: 'amber' });
    assert.ok(g1.id > 0);
    ctx.repo.createGroup({ name: '教程', color: 'blue' });

    const list = ctx.repo.listGroups();
    assert.equal(list.length, 2, '两个都要在');
    assert.equal(list.find((g) => g.name === '教程').count, 0, '空分组也要出现且 count=0');

    // Review Focus 2：只差空格的同名也算重名
    assert.throws(() => ctx.repo.createGroup({ name: ' 待看 ' }), (e) => {
      assert.equal(e.httpStatus, 409, '重名必须是 409，不能静默建两个');
      return true;
    });
  } finally { ctx.cleanup(); }
});

test('分组：多对多 —— 一个视频能同时在两个组里，count 正确', () => {
  const ctx = freshRepo();
  try {
    const a = ctx.repo.insertVideo({ url: 'https://x/1', title: 'v1' });
    const b = ctx.repo.insertVideo({ url: 'https://x/2', title: 'v2' });
    const g1 = ctx.repo.createGroup({ name: '待看' });
    const g2 = ctx.repo.createGroup({ name: '教程' });

    assert.equal(ctx.repo.addToGroup([a.id, b.id], g1.id), 2);
    assert.equal(ctx.repo.addToGroup([a.id], g2.id), 1);

    const list = ctx.repo.listGroups();
    assert.equal(list.find((g) => g.id === g1.id).count, 2);
    assert.equal(list.find((g) => g.id === g2.id).count, 1);

    const map = ctx.repo.groupIdsFor([a.id, b.id]);
    assert.deepEqual(map.get(a.id).sort(), [g1.id, g2.id].sort(), 'v1 在两个组里');
    assert.deepEqual(map.get(b.id), [g1.id]);
  } finally { ctx.cleanup(); }
});

test('分组：addToGroup 幂等 —— 重复加同一条不报错也不重复', () => {
  const ctx = freshRepo();
  try {
    const v = ctx.repo.insertVideo({ url: 'https://x/1', title: 'v1' });
    const g = ctx.repo.createGroup({ name: '待看' });
    assert.equal(ctx.repo.addToGroup([v.id], g.id), 1);
    assert.equal(ctx.repo.addToGroup([v.id], g.id), 0, '第二次应当 0 条新增');
    assert.equal(ctx.repo.listGroups()[0].count, 1, '不能变成 2');
  } finally { ctx.cleanup(); }
});

test('分组：removeFromGroup 只摘关系，视频记录还在', () => {
  const ctx = freshRepo();
  try {
    const v = ctx.repo.insertVideo({ url: 'https://x/1', title: 'v1' });
    const g = ctx.repo.createGroup({ name: '待看' });
    ctx.repo.addToGroup([v.id], g.id);
    assert.equal(ctx.repo.removeFromGroup([v.id], g.id), 1);
    assert.equal(ctx.repo.listGroups()[0].count, 0);
    assert.ok(ctx.repo.getVideo(v.id), '视频记录必须还在');
  } finally { ctx.cleanup(); }
});

test('分组：detach 只解散，purge 删记录但不动磁盘文件（Review Focus 6）', () => {
  const ctx = freshRepo();
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(ctx.tmp, 'downloads', 'keepme.mp4');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fake video bytes');

    const v = ctx.repo.insertVideo({ url: 'https://x/1', title: 'v1', status: 'done', file_path: file });
    const g1 = ctx.repo.createGroup({ name: '待看' });
    const g2 = ctx.repo.createGroup({ name: '教程' });
    ctx.repo.addToGroup([v.id], g1.id);

    // detach：视频和文件都必须还在
    const d1 = ctx.repo.deleteGroup(g1.id, { mode: 'detach' });
    assert.equal(d1.mode, 'detach');
    assert.equal(d1.removedVideos, 0);
    assert.ok(ctx.repo.getVideo(v.id), 'detach 不能删视频记录');
    assert.ok(fs.existsSync(file), 'detach 不能动磁盘文件');

    // purge：删库记录，但磁盘文件仍然在
    ctx.repo.addToGroup([v.id], g2.id);
    const d2 = ctx.repo.deleteGroup(g2.id, { mode: 'purge' });
    assert.equal(d2.mode, 'purge');
    assert.equal(d2.removedVideos, 1);
    assert.equal(ctx.repo.getVideo(v.id), null, 'purge 要删掉库记录');
    assert.ok(fs.existsSync(file), '⚠️ purge 绝不能删磁盘文件');
    assert.equal(ctx.repo.listGroups().length, 0);
  } finally { ctx.cleanup(); }
});

test('分组：删视频时关系跟着级联清掉（不留悬空行）', () => {
  const ctx = freshRepo();
  try {
    const v = ctx.repo.insertVideo({ url: 'https://x/1', title: 'v1' });
    const g = ctx.repo.createGroup({ name: '待看' });
    ctx.repo.addToGroup([v.id], g.id);
    ctx.repo.deleteVideo(v.id);
    assert.equal(ctx.repo.listGroups()[0].count, 0, '关系行应当被级联删除');
  } finally { ctx.cleanup(); }
});

test('分组：listVideosAll 与 listVideos 用同一套筛选，只是不分页', () => {
  const ctx = freshRepo();
  try {
    for (let i = 0; i < 5; i++) {
      ctx.repo.insertVideo({ url: `https://x/${i}`, title: `t${i}`, site: i < 2 ? 'Youtube' : 'XVideos' });
    }
    const paged = ctx.repo.listVideos({ site: 'Youtube', limit: 1 });
    const all = ctx.repo.listVideosAll({ site: 'Youtube' });
    assert.equal(paged.total, 2);
    assert.equal(paged.rows.length, 1, '分页版只给 1 条');
    assert.equal(all.length, 2, '全集版要给全部 2 条');
    assert.deepEqual(all.map((r) => r.id), ctx.repo.listVideos({ site: 'Youtube' }).rows.map((r) => r.id),
      '两者的顺序必须一致（同一套 ORDER BY）');
  } finally { ctx.cleanup(); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/run.js integration database`
Expected: 失败 —— `ctx.repo.createGroup is not a function`

- [ ] **Step 3: 加表**

把以下两段加进 `src/infra/database.js` 的 `SCHEMA` 常量末尾（`candidates` 表之后）：

```sql
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

-- 视频 ↔ 分组，多对多。不在这个表里 = 未分组。
-- ON DELETE CASCADE：删视频时关系自动清掉，不留悬空行。
CREATE TABLE IF NOT EXISTS video_groups (
  video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  added_at   TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (video_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_vg_group ON video_groups(group_id);
```

- [ ] **Step 4: 抽出 `listVideos` 的 WHERE/ORDER 共享片段**

⚠️ **不要复制那一段 WHERE**（复制必然漂移）。在 `listVideos` 上方加一个内部函数，
然后让 `listVideos` 与新的 `listVideosAll` 都用它：

```js
  /**
   * 库查询的筛选与排序 —— `listVideos`（分页）与 `listVideosAll`（全集）共用。
   *
   * 抽出来是因为分组需要"筛选后的全集"，如果复制一份 WHERE 出来，
   * 两边的筛选条件迟早会不一致 —— 那种 bug 表现为"分组里的条数跟列表对不上"。
   *
   * @returns {{whereSql:string, args:any[], orderBy:string}}
   */
  function buildVideoQuery({ q = '', status = '', site = '', uploader = '', starred = false, sort = 'created_desc' } = {}) {
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
```

然后把 `listVideos` 的函数体改成用它（行为必须完全不变）：

```js
  function listVideos(filters = {}) {
    const { limit = 200, offset = 0 } = filters;
    const { whereSql, args, orderBy } = buildVideoQuery(filters);
    const rows = db.prepare(
      `SELECT * FROM videos ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM videos ${whereSql}`).get(...args).n;
    return { rows: rows.map(fromRow), total };
  }

  /** 与 listVideos 同一套筛选/排序，但**不分页**（分组要用筛选后的全集） */
  function listVideosAll(filters = {}) {
    const { whereSql, args, orderBy } = buildVideoQuery(filters);
    return db.prepare(`SELECT * FROM videos ${whereSql} ORDER BY ${orderBy}`)
      .all(...args).map(fromRow);
  }
```

- [ ] **Step 5: 加 8 个分组仓储方法**

放在 `refreshLibraryFlags()` 之后、`// 生命周期` 之前：

```js
  // ---------------------------------------------------------------- 分组

  /**
   * 分组名归一化：去首尾空白 + 合并内部空白 + 转小写用于**查重**。
   *
   * 为什么要归一化（Review Focus 2）：只差一个空格或大小写的两个名字，
   * 在界面上看起来一模一样，用户会以为自己建重了、或者分不清点哪个。
   * 名字本身保留用户输入的原样，只有查重走归一化。
   */
  const normGroupName = (name) => String(name == null ? '' : name).trim().replace(/\s+/g, ' ');

  function groupOut(row) {
    return { id: row.id, name: row.name, color: row.color, created_at: row.created_at, count: row.count };
  }

  /** 所有自定义分组 + 每组条数。**含 0 条的组**（用户明确要求：刚建的组不能"消失"） */
  function listGroups() {
    return db.prepare(`
      SELECT g.id, g.name, g.color, g.created_at,
             (SELECT COUNT(*) FROM video_groups vg WHERE vg.group_id = g.id) AS count
        FROM groups g
       ORDER BY g.created_at ASC, g.id ASC
    `).all().map(groupOut);
  }

  function createGroup({ name, color = 'amber' } = {}) {
    const clean = normGroupName(name);
    const { ValidationError } = require('../domain/errors');
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
    const info = db.prepare('INSERT INTO groups (name, color) VALUES (?, ?)').run(clean, String(color));
    const row = db.prepare('SELECT id, name, color, created_at FROM groups WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    return groupOut({ ...row, count: 0 });
  }

  function updateGroup(id, { name, color } = {}) {
    const { ValidationError } = require('../domain/errors');
    const cur = db.prepare('SELECT * FROM groups WHERE id = ?').get(Number(id));
    if (!cur) return null;

    const patch = {};
    if (name !== undefined) {
      const clean = normGroupName(name);
      if (!clean) throw new ValidationError('分组名不能为空', { hint: '给它起个名字。' });
      if (clean.length > 40) throw new ValidationError('分组名太长了（最多 40 个字符）');
      const dup = db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE AND id <> ?')
        .get(clean, Number(id));
      if (dup) {
        throw new ValidationError(`已经有叫「${clean}」的分组了`, { status: 409, hint: '换一个名字。' });
      }
      patch.name = clean;
    }
    if (color !== undefined) patch.color = String(color);

    const cols = Object.keys(patch);
    if (cols.length) {
      db.prepare(`UPDATE groups SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`)
        .run(...cols.map((c) => patch[c]), Number(id));
    }
    return listGroups().find((g) => g.id === Number(id)) || null;
  }

  /**
   * 删分组。两种模式（spec 3.1）：
   *   detach（默认）：只删关系行，视频记录一条不少
   *   purge         ：删掉组内视频的**库记录**（CASCADE 顺手清关系），**磁盘文件一律不动**
   *
   * ⚠️ purge 不删文件是刻意的：与项目现有的删除语义一致 ——
   *    "记录和文件一起永久删除"是列表里另一个带二次确认的路径。
   */
  function deleteGroup(id, { mode = 'detach' } = {}) {
    const gid = Number(id);
    const cur = db.prepare('SELECT id FROM groups WHERE id = ?').get(gid);
    if (!cur) return null;
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

  function addToGroup(videoIds, groupId) {
    const gid = Number(groupId);
    if (!db.prepare('SELECT id FROM groups WHERE id = ?').get(gid)) return 0;
    const stmt = db.prepare('INSERT OR IGNORE INTO video_groups (video_id, group_id) VALUES (?, ?)');
    let added = 0;
    transaction(() => {
      for (const vid of videoIds || []) {
        const n = Number(vid);
        if (!Number.isInteger(n)) continue;
        if (!db.prepare('SELECT id FROM videos WHERE id = ?').get(n)) continue;  // 不存在的忽略
        added += Number(stmt.run(n, gid).changes) || 0;
      }
    });
    return added;
  }

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
```

- [ ] **Step 6: 导出新方法**

在 `src/infra/database.js` 的 `return { ... }` 里，`listCandidates` 那一组后面加：

```js
    // 分组
    listGroups, createGroup, updateGroup, deleteGroup,
    addToGroup, removeFromGroup, groupIdsFor,
    // 库查询（全集版，分组用）
    listVideosAll,
```

- [ ] **Step 7: 跑测试确认通过**

Run: `node test/run.js integration database`
Expected: 全部通过

- [ ] **Step 8: 反证 —— 确认测试咬得住**

把 `listGroups` 里那个子查询的 `COUNT(*)` 改成 `0`，重跑。
Expected: **"多对多 —— count 正确" 必须失败**。改回来。

- [ ] **Step 9: 提交**

```bash
git add src/infra/database.js test/integration/database.test.js
git commit -F .handoff/commit-msg-t1.txt   # 消息写文件，别用 -m
```

---

### Task 2: `GET /api/library/grouped` —— 站点分段 / 自定义分组 / 未分组

**Files:**
- Modify: `src/http/routes/library.js`（加一个路由）
- Test: `test/integration/api.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `repo.listVideosAll` / `repo.listGroups` / `repo.groupIdsFor`
- Produces: `GET /api/library/grouped?by=site|group&<筛选参数>` →
  `{by, total, shown, truncated, cap, groups:[{key,id,name,color,count,rows}]}`

- [ ] **Step 1: 写失败测试**

追加到 `test/integration/api.test.js`（沿用 `startApp()`）：

```js
test('分组接口：按站点分段，条数必须是全量而不是当前页', async () => {
  const s = await startApp();
  try {
    // 造 5 条：站点点数要能区分开
    for (const [url, site] of [
      ['https://x/a1', 'Youtube'], ['https://x/a2', 'Youtube'],
      ['https://x/b1', 'BiliBili'], ['https://x/c1', 'XVideos'], ['https://x/c2', 'XVideos'],
    ]) {
      await s.call('POST', '/api/videos', { urls: url });
      const lib = await s.call('GET', '/api/library');
      const row = lib.data.rows.find((r) => r.url === url);
      s.app.repo.updateVideo(row.id, { site, status: 'done' });
    }

    const r = await s.call('GET', '/api/library/grouped?by=site');
    assert.equal(r.status, 200);
    assert.equal(r.data.by, 'site');
    assert.equal(r.data.total, 5);

    const names = r.data.groups.map((g) => g.name).sort();
    assert.deepEqual(names, ['BiliBili', 'XVideos', 'Youtube'], '三个站点各一段');
    assert.equal(r.data.groups.find((g) => g.name === 'Youtube').count, 2);
    assert.equal(r.data.groups.find((g) => g.name === 'XVideos').count, 2);
    assert.equal(r.data.groups.find((g) => g.name === 'BiliBili').count, 1);
    // 每段里的 rows 数量要与 count 一致（这条咬住"只分组了当前页"那种实现）
    for (const g of r.data.groups) assert.equal(g.rows.length, g.count);
  } finally { await s.cleanup(); }
});

test('分组接口：Review Focus 1 —— 站点名大小写不同要归并成一段', async () => {
  const s = await startApp();
  try {
    for (const [url, site] of [['https://x/y1', 'Youtube'], ['https://x/y2', 'youtube'], ['https://x/y3', 'YOUTUBE']]) {
      await s.call('POST', '/api/videos', { urls: url });
      const lib = await s.call('GET', '/api/library');
      s.app.repo.updateVideo(lib.data.rows.find((r) => r.url === url).id, { site, status: 'done' });
    }
    const r = await s.call('GET', '/api/library/grouped?by=site');
    assert.equal(r.data.groups.length, 1, `三种写法必须归并成一段，实际 ${JSON.stringify(r.data.groups.map((g) => g.name))}`);
    assert.equal(r.data.groups[0].count, 3);
  } finally { await s.cleanup(); }
});

test('分组接口：按自定义分组 —— 未分组的要有自己的段（Review Focus 3）', async () => {
  const s = await startApp();
  try {
    const ids = [];
    for (const url of ['https://x/1', 'https://x/2', 'https://x/3']) {
      await s.call('POST', '/api/videos', { urls: url });
      const lib = await s.call('GET', '/api/library');
      ids.push(lib.data.rows.find((r) => r.url === url).id);
    }
    const g = await s.call('POST', '/api/groups', { name: '待看', color: 'amber' });
    assert.equal(g.status, 200);
    await s.call('POST', '/api/videos/group-action', { ids: [ids[0]], add: [g.data.id] });

    const r = await s.call('GET', '/api/library/grouped?by=group');
    const keys = r.data.groups.map((x) => x.key);
    assert.ok(keys.includes('__ungrouped__'), '未分组必须单独成段');
    assert.equal(r.data.groups.find((x) => x.key === String(g.data.id)).count, 1);
    assert.equal(r.data.groups.find((x) => x.key === '__ungrouped__').count, 2);
  } finally { await s.cleanup(); }
});

test('分组接口：空分组也返回且 count=0（Review Focus 4）', async () => {
  const s = await startApp();
  try {
    await s.call('POST', '/api/groups', { name: '空的' });
    const r = await s.call('GET', '/api/library/grouped?by=group');
    const empty = r.data.groups.find((g) => g.name === '空的');
    assert.ok(empty, '刚建的空分组必须出现，否则用户以为没建成');
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.rows, []);
  } finally { await s.cleanup(); }
});

test('分组接口：筛选先于分组 —— 筛了站点就只出现一段（这是正确行为）', async () => {
  const s = await startApp();
  try {
    for (const [url, site] of [['https://x/a', 'Youtube'], ['https://x/b', 'BiliBili']]) {
      await s.call('POST', '/api/videos', { urls: url });
      const lib = await s.call('GET', '/api/library');
      s.app.repo.updateVideo(lib.data.rows.find((r) => r.url === url).id, { site, status: 'done' });
    }
    const r = await s.call('GET', '/api/library/grouped?by=site&site=Youtube');
    assert.equal(r.data.groups.length, 1);
    assert.equal(r.data.groups[0].name, 'Youtube');
    assert.equal(r.data.total, 1);
  } finally { await s.cleanup(); }
});

test('分组接口：by 参数不合法时 400，不是静默当 site', async () => {
  const s = await startApp();
  try {
    const r = await s.call('GET', '/api/library/grouped?by=nonsense');
    assert.equal(r.status, 400);
    assert.ok(r.data.hint, '要告诉用户可用值');
  } finally { await s.cleanup(); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/run.js integration api`
Expected: 失败 —— 404（路由不存在）

- [ ] **Step 3: 实现路由**

追加到 `src/http/routes/library.js` 的 `register()` 里（`/api/facets` 之后）：

```js
  /**
   * 分组后的库。
   *
   * 为什么由服务端分组（而不是前端拿一堆 row 自己归并）：
   *   分组名后的条数必须是**全量**条数。前端分页拿到的只是当前页，
   *   自己归并出来的数字必然是"这一页里有多少条"—— 那正是 spec 要避开的坑。
   *   服务端分组还让"筛选先于分组"这件事只有一个实现处。
   */
  const GROUP_CAP = 2000;

  router.get('/api/library/grouped', (req, res, params, url) => {
    const sp = url.searchParams;
    const by = sp.get('by') || 'site';
    if (by !== 'site' && by !== 'group') {
      throw new ValidationError(`分组维度只能是 site 或 group，收到的是「${by}」`, {
        hint: 'by=site 按站点分段；by=group 按自定义分组分段。',
      });
    }

    const filters = {
      q: sp.get('q') || '', status: sp.get('status') || '',
      site: sp.get('site') || '', uploader: sp.get('uploader') || '',
      starred: sp.get('starred') === '1', sort: sp.get('sort') || 'created_desc',
    };
    const total = repo.listVideos({ ...filters, limit: 1, offset: 0 }).total;
    const all = repo.listVideosAll(filters);
    const shown = Math.min(all.length, GROUP_CAP);
    const capped = all.slice(0, shown);

    const groups = by === 'site'
      ? groupBySite(capped, total)
      : groupByCustom(capped, repo, total);

    return json(res, 200, {
      by, total, shown, truncated: all.length > GROUP_CAP, cap: GROUP_CAP, groups,
    });
  });
```

再在文件底部（`module.exports` 之前）加两个**纯函数** —— 纯函数才能单独测、且不碰 repo：

```js
/**
 * 按站点分段。
 *
 * ⚠️ 站点名按**大小写不敏感**归并（Review Focus 1）：yt-dlp 不同版本/不同来源
 *    给出的站点名大小写并不统一（Youtube / youtube / YOUTUBE），
 *    不做归并的话同一站点会裂成好几段，看起来像 bug。
 *    显示名取**第一次出现的那个写法**（保持它原本的样子）。
 */
function groupBySite(rows, total) {
  const buckets = new Map();   // 归并键(小写) → {name, rows}
  for (const r of rows) {
    const raw = (r.site && String(r.site).trim()) || '（未标注站点）';
    const key = raw.toLowerCase();
    if (!buckets.has(key)) buckets.set(key, { name: raw, rows: [] });
    buckets.get(key).rows.push(r);
  }
  return [...buckets.entries()]
    .map(([key, b]) => ({
      key: b.name, id: null, name: b.name, color: null, count: b.rows.length, rows: b.rows,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * 按自定义分组分段。
 * 顺序：先自定义分组（按创建顺序，含 0 条的），最后是「未分组」（仅当真有条目）。
 */
function groupByCustom(rows, repo, total) {
  const groups = repo.listGroups().map((g) => ({
    key: String(g.id), id: g.id, name: g.name, color: g.color, count: 0, rows: [],
  }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const membership = repo.groupIdsFor(rows.map((r) => r.id));

  const ungrouped = [];
  for (const row of rows) {
    const ids = membership.get(row.id) || [];
    if (!ids.length) { ungrouped.push(row); continue; }
    for (const gid of ids) {
      const g = byId.get(gid);
      if (g) { g.rows.push(row); g.count += 1; }
    }
  }

  const out = groups;
  if (ungrouped.length) {
    out.push({ key: '__ungrouped__', id: null, name: '未分组', color: null, count: ungrouped.length, rows: ungrouped });
  }
  return out;
}
```

顶部记得 `const { ValidationError } = require('../../domain/errors');`（若文件里还没有）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/run.js integration api`

- [ ] **Step 5: 反证**

把 `groupBySite` 的归并键从 `raw.toLowerCase()` 改成 `raw`，重跑。
Expected: **"大小写不同要归并" 必须失败**。改回来。

- [ ] **Step 6: 提交**

```bash
git add src/http/routes/library.js test/integration/api.test.js
git commit -F .handoff/commit-msg-t2.txt
```

---

### Task 3: groups 的 CRUD + 两个批量入口

**Files:**
- Modify: `src/http/routes/library.js`（groups 的 CRUD）
- Modify: `src/http/routes/videos.js`（`group-action` / `bulk-action`）
- Test: `test/integration/api.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的仓储方法
- Produces:
  - `GET /api/groups` → `{groups:[{id,name,color,count}]}`
  - `POST /api/groups {name,color}` → `200 {id,name,color,count}`；重名 **409**
  - `PATCH /api/groups/:id {name?,color?}` → `200 {...}`；不存在 404；重名 409
  - `DELETE /api/groups/:id?mode=detach|purge` → `200 {mode, removedVideos}`
  - `POST /api/videos/group-action {ids,add?,remove?}` → `200 {added,removed,affected,errors}`
  - `POST /api/videos/bulk-action {ids,action:'star'|'unstar'}` → `200 {affected}`

- [ ] **Step 1: 写失败测试**

追加到 `test/integration/api.test.js`：

```js
test('分组 CRUD：建、改名、换色、重名 409、不存在 404', async () => {
  const s = await startApp();
  try {
    const a = await s.call('POST', '/api/groups', { name: '待看', color: 'amber' });
    assert.equal(a.status, 200);
    assert.ok(a.data.id > 0);

    // Review Focus 2：只差空格也算重名
    const dup = await s.call('POST', '/api/groups', { name: ' 待看 ' });
    assert.equal(dup.status, 409, '重名必须是 409');
    assert.match(dup.data.error, /已经有/);

    const renamed = await s.call('PATCH', `/api/groups/${a.data.id}`, { name: '稍后看', color: 'blue' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.name, '稍后看');
    assert.equal(renamed.data.color, 'blue');

    const missing = await s.call('PATCH', '/api/groups/999999', { name: 'x' });
    assert.equal(missing.status, 404);

    const empty = await s.call('POST', '/api/groups', { name: '   ' });
    assert.equal(empty.status, 400, '空名字要 400');

    const list = await s.call('GET', '/api/groups');
    assert.equal(list.data.groups.length, 1);
  } finally { await s.cleanup(); }
});

test('分组 CRUD：删分组默认只解散，视频记录一条不少', async () => {
  const s = await startApp();
  try {
    await s.call('POST', '/api/videos', { urls: 'https://x/1' });
    const lib = await s.call('GET', '/api/library');
    const id = lib.data.rows[0].id;
    const g = await s.call('POST', '/api/groups', { name: '待看' });
    await s.call('POST', '/api/videos/group-action', { ids: [id], add: [g.data.id] });

    const del = await s.call('DELETE', `/api/groups/${g.data.id}`);   // 默认 detach
    assert.equal(del.status, 200);
    assert.equal(del.data.mode, 'detach');
    assert.equal(del.data.removedVideos, 0);

    const after = await s.call('GET', '/api/library');
    assert.equal(after.data.total, 1, 'detach 不能删视频');
  } finally { await s.cleanup(); }
});

test('批量入组：部分 id 不存在时忽略并如实报 affected（Review Focus 5）', async () => {
  const s = await startApp();
  try {
    await s.call('POST', '/api/videos', { urls: 'https://x/1' });
    const lib = await s.call('GET', '/api/library');
    const real = lib.data.rows[0].id;
    const g = await s.call('POST', '/api/groups', { name: '待看' });

    const r = await s.call('POST', '/api/videos/group-action', {
      ids: [real, 999999], add: [g.data.id],
    });
    assert.equal(r.status, 200, '不能整体 500');
    assert.equal(r.data.affected, 1, '只影响真实存在的那条');
    assert.ok(r.data.errors.length >= 1, '要如实报告被忽略的 id');
  } finally { await s.cleanup(); }
});

test('批量收藏：一次请求搞定，且不被 :id 路由吃掉', async () => {
  const s = await startApp();
  try {
    const ids = [];
    for (const url of ['https://x/1', 'https://x/2']) {
      await s.call('POST', '/api/videos', { urls: url });
      const lib = await s.call('GET', '/api/library');
      ids.push(lib.data.rows.find((r) => r.url === url).id);
    }

    const star = await s.call('POST', '/api/videos/bulk-action', { ids, action: 'star' });
    assert.equal(star.status, 200, '不能被 /api/videos/:id/action 吃掉返回 400');
    assert.equal(star.data.affected, 2);

    const lib = await s.call('GET', '/api/library');
    assert.ok(lib.data.rows.every((r) => r.starred === true), '两条都要变成已收藏');

    const unstar = await s.call('POST', '/api/videos/bulk-action', { ids, action: 'unstar' });
    assert.equal(unstar.data.affected, 2);
    assert.ok((await s.call('GET', '/api/library')).data.rows.every((r) => r.starred === false));
  } finally { await s.cleanup(); }
});

test('批量收藏：action 不合法时报 400 并列出可用值', async () => {
  const s = await startApp();
  try {
    const r = await s.call('POST', '/api/videos/bulk-action', { ids: [1], action: 'nuke' });
    assert.equal(r.status, 400);
    assert.match(r.data.hint || '', /star/);
  } finally { await s.cleanup(); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/run.js integration api`
Expected: 404（路由不存在）

- [ ] **Step 3: 实现 groups CRUD（library.js）**

```js
  // ---------------------------------------------------------------- 分组 CRUD

  router.get('/api/groups', (req, res) => {
    return json(res, 200, { groups: repo.listGroups() });
  });

  router.post('/api/groups', async (req, res) => {
    const body = await readJsonBody(req);
    const { name, color } = validate(body, {
      name: { type: 'string', maxLength: 40, required: true },
      color: { type: 'string', maxLength: 20 },
    }, { strict: false });
    return json(res, 200, repo.createGroup({ name, color }));
  });

  router.patch('/api/groups/:id', async (req, res, params) => {
    const body = await readJsonBody(req);
    const { name, color } = validate(body, {
      name: { type: 'string', maxLength: 40 },
      color: { type: 'string', maxLength: 20 },
    }, { strict: false });
    const out = repo.updateGroup(Number(params.id), { name, color });
    if (!out) throw new NotFoundError('找不到这个分组', { hint: '它可能已经被删了，刷新一下。' });
    return json(res, 200, out);
  });

  router.delete('/api/groups/:id', (req, res, params, url) => {
    const mode = url.searchParams.get('mode') || 'detach';
    if (mode !== 'detach' && mode !== 'purge') {
      throw new ValidationError('mode 只能是 detach 或 purge', {
        hint: 'detach = 只解散分组（默认）；purge = 连库记录一起删（磁盘文件保留）。',
      });
    }
    const out = repo.deleteGroup(Number(params.id), { mode });
    if (!out) throw new NotFoundError('找不到这个分组');
    broadcast('library', { changed: true });
    return json(res, 200, out);
  });
```

顶部 require 需补 `readJsonBody`、`validate`、`NotFoundError`、`ValidationError`（按该文件现有的 import 风格补全）。

> ⚠️ 路由注册顺序：`PATCH /api/groups/:id` 与 `GET /api/groups` 不冲突。
> 但若路由器**先注册先匹配**，请确认 `/api/groups` 不会被 `:id` 吃掉 —— 用测试里的
> `GET /api/groups` 断言（它必须返回列表，不是 404）。

- [ ] **Step 4: 实现两个批量入口（videos.js）**

放在 `POST /api/videos` 之后**紧邻的位置**，并且**注册顺序要在 `/api/videos/:id/...` 之前**
（若路由器是先注册先匹配）：

```js
  /** 批量入组 / 出组 */
  router.post('/api/videos/group-action', async (req, res) => {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
    const add = Array.isArray(body.add) ? body.add.map(Number).filter(Number.isInteger) : [];
    const remove = Array.isArray(body.remove) ? body.remove.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) throw new ValidationError('没有选中任何视频', { hint: '先勾选几条。' });
    if (!add.length && !remove.length) {
      throw new ValidationError('没有指定要加入或移出哪个分组', { hint: '至少给一个分组 id。' });
    }

    const errors = [];
    let added = 0;
    let removed = 0;
    const known = new Set(repo.listVideosAll({}).map((v) => v.id));
    for (const id of ids) if (!known.has(id)) errors.push({ id, error: '这条视频不在了' });

    for (const gid of add) {
      const n = repo.addToGroup(ids, gid);
      if (n === 0 && !repo.listGroups().some((g) => g.id === gid)) {
        errors.push({ id: gid, error: '这个分组不在了' });
      }
      added += n;
    }
    for (const gid of remove) removed += repo.removeFromGroup(ids, gid);

    broadcast('library', { changed: true });
    return json(res, 200, {
      added, removed, affected: ids.length - errors.filter((x) => x.error === '这条视频不在了').length, errors,
    });
  });

  /**
   * 批量收藏 / 取消收藏。
   *
   * 为什么单独开一个入口：前端循环发 N 次 `/:id/action` 会有 N 个请求，
   * 既慢又容易撞上服务端并发。内部**复用 repo.updateVideo**（和单条动作同一条写路径）。
   */
  const BULK_ACTIONS = ['star', 'unstar'];
  router.post('/api/videos/bulk-action', async (req, res) => {
    const body = await readJsonBody(req);
    const action = String(body.action || '');
    if (!BULK_ACTIONS.includes(action)) {
      throw new ValidationError(`不支持的批量动作：${action || '(空)'}`, {
        hint: `可用的：${BULK_ACTIONS.join(' / ')}`,
      });
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) throw new ValidationError('没有选中任何视频', { hint: '先勾选几条。' });

    let affected = 0;
    for (const id of ids) {
      if (!repo.getVideo(id)) continue;
      repo.updateVideo(id, { starred: action === 'star' });
      affected += 1;
    }
    broadcast('library', { changed: true });
    return json(res, 200, { affected });
  });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node test/run.js integration api`

- [ ] **Step 6: 反证**

把 `bulk-action` 的 `BULK_ACTIONS.includes(action)` 改成 `true`（即不校验），重跑。
Expected: **"action 不合法时报 400" 必须失败**。改回来。

- [ ] **Step 7: 提交**

```bash
git add src/http/routes/library.js src/http/routes/videos.js test/integration/api.test.js
git commit -F .handoff/commit-msg-t3.txt
```

---

### Task 4: 前端 —— 工具栏 + 分组渲染 + 折叠

**Files:**
- Modify: `src/web/index.html`（工具栏加「展示维度」下拉 + 多选开关）
- Modify: `src/web/views/library.js`（分组加载与渲染）
- Modify: `src/web/styles.css`（分组标题、颜色条）
- Test: `test/integration/frontend-dom.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 2 的 `GET /api/library/grouped`
- Produces（library.js 内）：
  - `reload()` 在 `prefs.library.by` 非空时走 grouped 接口
  - `renderLibrary()` 分组模式下渲染分段
  - `state.prefs.library.by`（`''|'site'|'group'`）与 `state.prefs.library.collapsed`（`{key:true}`）

- [ ] **Step 1: 写失败测试**

追加到 `test/integration/frontend-dom.test.mjs`：

```js
// ---------------------------------------------------------------- 库页分组

/** 造一个"分组后的库"假响应 */
function groupedResponse() {
  const row = (id, title) => ({
    id, url: `https://x/${id}`, title, site: 'Youtube', status: 'done',
    created_at: '2026-09-22 10:00', file_path: `D:\\dl\\${id}.mp4`, starred: false, height: 1080,
  });
  return {
    by: 'site', total: 3, shown: 3, truncated: false, cap: 2000,
    groups: [
      { key: 'Youtube', id: null, name: 'Youtube', color: null, count: 2, rows: [row(1, '第一'), row(2, '第二')] },
      { key: 'BiliBili', id: null, name: 'BiliBili', color: null, count: 1, rows: [row(3, '第三')] },
    ],
  };
}

async function bootGrouped() {
  return bootFrontend({
    responses: {
      ...fakeResponses(),
      'GET /api/library/grouped': groupedResponse(),
      'GET /api/groups': { groups: [{ id: 9, name: '待看', color: 'amber', count: 0 }] },
    },
  });
}

test('库页分组：切到按站点分段后，出现两段且标题带条数', async () => {
  const { dom } = await bootGrouped();
  try {
    const sel = globalThis.document.getElementById('libGroupBy');
    assert.ok(sel, 'index.html 里应当有 #libGroupBy');
    sel.value = 'site';
    sel.dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 30));

    const heads = globalThis.document.querySelectorAll('#libGrid .grp-head');
    assert.equal(heads.length, 2, '应当有两段');
    const labels = [...globalThis.document.querySelectorAll('#libGrid .grp-name')].map((n) => n.textContent);
    assert.deepEqual(labels, ['Youtube', 'BiliBili']);
    const counts = [...globalThis.document.querySelectorAll('#libGrid .grp-count')].map((n) => n.textContent);
    assert.deepEqual(counts, ['2', '1'], '条数要渲染出来');
  } finally { dom.restore(); }
});

test('库页分组：分组模式下不出现「加载更多」', async () => {
  const { dom } = await bootGrouped();
  try {
    const sel = globalThis.document.getElementById('libGroupBy');
    sel.value = 'site';
    sel.dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(globalThis.document.getElementById('loadMoreWrap').hidden, true,
      '已经全量了，不该再给「加载更多」');
  } finally { dom.restore(); }
});

test('库页分组：点标题能折叠，且状态写进 localStorage', async () => {
  const { dom } = await bootGrouped();
  try {
    const sel = globalThis.document.getElementById('libGroupBy');
    sel.value = 'site';
    sel.dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 30));

    const head = globalThis.document.querySelector('#libGrid .grp-head');
    head.click();
    await new Promise((r) => setTimeout(r, 30));

    const body = globalThis.document.querySelector('#libGrid .grp-body');
    assert.equal(body.hidden, true, '点一下要收起');
    const saved = globalThis.localStorage.getItem('vv.prefs');
    assert.match(String(saved), /collapsed/, '折叠状态要持久化');
  } finally { dom.restore(); }
});

test('库页分组：标题里的尖括号原样保留（防注入）', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const { dom } = await bootFrontend({
    responses: {
      ...fakeResponses(),
      'GET /api/library/grouped': {
        by: 'site', total: 1, shown: 1, truncated: false, cap: 2000,
        groups: [{ key: nasty, id: null, name: nasty, color: null, count: 1, rows: [] }],
      },
      'GET /api/groups': { groups: [] },
    },
  });
  try {
    const sel = globalThis.document.getElementById('libGroupBy');
    sel.value = 'site';
    sel.dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 30));
    const name = globalThis.document.querySelector('#libGrid .grp-name');
    assert.equal(name.textContent, nasty, '文本原样保留');
    assert.equal(name.children.length, 0, '不该被解析成子元素');
  } finally { dom.restore(); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/run.js integration frontend-dom`
Expected: 失败 —— `#libGroupBy` 是 null

- [ ] **Step 3: index.html 加控件**

在工具栏（`#libLayout` 那个 `.seg` 之前）插入：

```html
      <label class="field compact">
        <span>展示</span>
        <select id="libGroupBy">
          <option value="">不分组</option>
          <option value="site">按站点分段</option>
          <option value="group">按分组分段</option>
        </select>
      </label>
```

并在工具栏末尾（`#btnRefresh` 之前）加多选开关：

```html
      <label class="field field-check compact">
        <input type="checkbox" id="libMulti">
        <span>多选</span>
      </label>
```

- [ ] **Step 4: library.js —— 加载与渲染**

要点（照抄现有写法：`el()` 建节点、`replace()` 换内容、`textContent` 不拼 HTML）：

1. `initLibraryView` 里恢复 `$('#libGroupBy').value = lib.by || ''`，并挂 `change` → 存 pref + `reload({reset:true})`；`#libMulti` 同理（存 `lib.multi`）。
2. `reload()`：若 `state.prefs.library.by` 非空 → 请求 `/api/library/grouped?by=...&<同样的筛选参数>`，把结果存进 `state.library = { grouped: data }`；否则走原来的 `/api/library`。
3. `renderLibrary()`：分组模式下对每组渲染
   ```js
   el('div', { class: 'grp' }, [
     el('div', { class: 'grp-head', dataset: { grp: g.key } }, [
       el('span', { class: 'grp-caret', text: collapsed ? '▶' : '▼' }),
       g.color ? el('span', { class: `grp-dot c-${g.color}` }) : null,
       el('span', { class: 'grp-name', text: g.name }),
       el('span', { class: 'grp-count', text: String(g.count) }),
     ]),
     el('div', { class: 'grp-body', hidden: collapsed }, g.rows.map((v) => buildCard(v))),
   ])
   ```
   ⚠️ `grp-head` 的点击用**事件委托**（库页已有 `document` 上的委托，加一个 `[data-grp]` 分支）。
4. 折叠状态读写 `state.prefs.library.collapsed`（对象，`{key: true}`），用 `savePrefs`。
5. 分组模式下 `$('#loadMoreWrap').hidden = true`；并在 `#libStat` 之外显示 `truncated` 警告（若为 true）。
6. 空分组：`grp-body` 里放一句 `.grp-empty`「这个分组还是空的」。

- [ ] **Step 5: styles.css 加样式**

至少要覆盖（`check-classes.js` 会红否则）：`.grp` `.grp-head` `.grp-caret` `.grp-name` `.grp-count` `.grp-body` `.grp-dot` `.grp-empty`，以及 5 个颜色类 `.c-amber` `.c-blue` `.c-green` `.c-purple` `.c-red`。
`grp-head` 要 `cursor: pointer`、`user-select: none`，`grp-dot` 是 8px 圆点。

- [ ] **Step 6: 跑测试 + 检查**

```bash
node test/run.js integration frontend-dom
node tools/check-frontend.js
node tools/check-classes.js
```

- [ ] **Step 7: 提交**

```bash
git add src/web/ test/integration/frontend-dom.test.mjs
git commit -F .handoff/commit-msg-t4.txt
```

---

### Task 5: 前端 —— 多选与批量操作

**Files:**
- Modify: `src/web/views/library.js`
- Modify: `src/web/styles.css`（勾选框样式）
- Test: `test/integration/frontend-dom.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 3 的 `group-action` / `bulk-action`
- Produces: 勾选状态 `picked: Set<number>`（**不跨筛选持久化**，换筛选就清空）

- [ ] **Step 1: 写失败测试**

```js
test('库页多选：勾上后工具栏出现计数，批量收藏只发一个请求', async () => {
  const calls = [];
  const dom = installDom({
    html: HTML,
    responses: {
      ...fakeResponses(),
      'GET /api/library': { total: 2, rows: [
        { id: 1, url: 'https://x/1', title: 'a', status: 'done', created_at: '2026-09-22 10:00', file_path: 'D:\\1.mp4', starred: false },
        { id: 2, url: 'https://x/2', title: 'b', status: 'done', created_at: '2026-09-22 10:00', file_path: 'D:\\2.mp4', starred: false },
      ] },
      'POST /api/videos/bulk-action': { affected: 2 },
      'GET /api/groups': { groups: [] },
    },
  });
  try {
    await import(appUrl(`multi-${Date.now()}`));
    await new Promise((r) => setTimeout(r, 20));
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 30));

    globalThis.document.getElementById('libMulti').checked = true;
    globalThis.document.getElementById('libMulti').dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 20));

    const boxes = [...globalThis.document.querySelectorAll('#libGrid .pick')];
    assert.equal(boxes.length, 2, '多选模式下每张卡片要有勾选框');
    boxes[0].checked = true; boxes[0].dispatchEvent(new globalThis.Event('change'));
    boxes[1].checked = true; boxes[1].dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 20));

    // 只发一个请求，不是两条
    const posts = dom.calls.filter((c) => c.method === 'POST' && c.url.includes('bulk-action'));
    assert.equal(posts.length, 1, `批量收藏应当只发 1 个请求，实际 ${posts.length}`);
    assert.equal(posts[0].body.action, 'star');
    assert.deepEqual(posts[0].body.ids.sort(), [1, 2]);
  } finally { dom.restore(); }
});
```

- [ ] **Step 2: 跑测试确认失败** → `#libMulti` 无效果 / 没有 `.pick`

- [ ] **Step 3: 实现**

要点：
1. `picked = new Set()`；`#libMulti` 勾上后 `renderLibrary()` 重绘（卡片带 `.pick`）。
2. 勾选框 `change` → 增删 `picked` → 更新工具栏：
   `已选 N 条 · [加入分组▾] [收藏] [取消收藏] [取消选择]`。
3. 工具栏那行是**动态渲染**的（`el()` 建），放在 `#libGrid` 之前的一个容器 `#libBulkBar`（在 index.html 里加空容器，默认 `hidden`）。
4. 「加入分组」下拉里的选项来自 `GET /api/groups`。
5. 任何 `reload()`（含换筛选）都 `picked.clear()` —— 否则会出现"选中的东西看不见了"。
6. 动作完成后 `reload({reset:true})` 并提示影响条数。

- [ ] **Step 4: 跑测试** → 通过
- [ ] **Step 5: 提交**（`git commit -F .handoff/commit-msg-t5.txt`）

---

### Task 6: 分组管理弹层（建 / 改名 / 换色 / 删）

**Files:**
- Modify: `src/web/views/library.js`（或新建 `src/web/views/groups.js` —— 若 library.js 超过 ~450 行就拆出去）
- Modify: `src/web/index.html`（下拉里加 `＋ 新建分组…` / `管理分组…` 两项）
- Test: `test/integration/frontend-dom.test.mjs`

- [ ] **Step 1: 写失败测试**：点「管理分组…」后弹层里列出分组（含 0 条的）；点删除**必须出现确认框**，且默认选项是"只解散"（断言对话框里两个按钮的文案）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（复用 `ui.js` 的 `confirmDialog`；删除时按 spec 3.2 的文案）
- [ ] **Step 4: 跑测试** → 通过
- [ ] **Step 5: 提交**

---

### Task 7: 真实浏览器截图核对（含 200+ 条压力观感）

**Files:**
- 不改产品代码；用 `.handoff/` 下的一次性脚本 + `tools/screenshot.js`

- [ ] **Step 1: 起隔离实例并灌 200+ 条假数据**

```powershell
# 临时 data 目录 + 用 createApp 建库，然后直接 INSERT 200 条
node .handoff\seed-groups.cjs "$env:TEMP\vv-grp\data"
```
灌入的数据要覆盖：3 个站点、2 个自定义分组（其中一个空组）、若干未分组。

- [ ] **Step 2: 起实例（后台作业，端口 8794）**，用 `preview\server.mjs`

- [ ] **Step 3: 截图并**看图**确认

```powershell
node tools\screenshot.js http://127.0.0.1:8794 <输出目录>
```
要看的是：分段标题是否清楚、**长列表下是否卡/错位**、颜色条是否明显、折叠箭头方向、多选勾选框位置。
⚠️ 截图脚本目前没有"切到分组模式"的步骤 —— 需要在脚本里补一段（点 `#libGroupBy` 选 `site`）。

- [ ] **Step 4: 若版式有问题就回去改**
- [ ] **Step 5: 收尾**：停实例（`job_kill`）、删临时数据

---

### Task 8: 文档与收尾

**Files:**
- Modify: `README.md`（功能一览加"库页分组"；第 6 节加一条坑：DOM 垫片曾经测不到库页交互）
- Modify: `PROGRESS.md`（`handoff.js save` 后手写补齐）

- [ ] **Step 1: README 补用法**（分组怎么用、`detach`/`purge` 的区别、2000 上限）
- [ ] **Step 2: 全套验证**

```bash
node test/run.js
node tools/lint-undefined.js
node tools/check-frontend.js
node tools/check-classes.js
node tools/check-launchers.js
```

- [ ] **Step 3: 干净检出验证**（`git archive` 导出后跑测试）
- [ ] **Step 4: 提交 + 推送 + 验远端**

---

## 自检记录（写完后跑的）

**spec 覆盖**：spec 第 3 节（数据模型）→ Task 1；4.1（grouped 接口）→ Task 2；
4.2/4.3（CRUD 与两个批量入口）→ Task 3；5.1~5.2（工具栏/渲染/折叠）→ Task 4；
5.3（多选）→ Task 5；5.4（分组管理）→ Task 6；第 6 节（错误与边界）→ Task 2/3 的断言；
第 7 节（测试策略，含真实浏览器截图）→ Task 4/5/7；第 8 节（实施顺序）→ Task 1-8 同序。

**Review Focus 的六条**分别落在：1（站点大小写）→ Task 2 Step 1 第二条测试；
2（重名只差空格）→ Task 1 与 Task 3 各一条；3（全未分组）→ Task 2；
4（空分组）→ Task 1 与 Task 2 各一条；5（不存在的 id）→ Task 3；
6（purge 不动磁盘文件）→ Task 1 的 detach/purge 测试。

**占位符**：无 TBD。Task 4/5/6 的实现步写"要点 + 必须满足的断言 + 照抄哪个现有文件"，
而不是完整代码 —— 刻意的：那三块是前端渲染，写一整份草稿会在实现时被当作正确代码粘贴，
反而掩盖真实的结构差异。Task 1/2/3 给了完整代码，因为它们逻辑纯、容易写错、测试最密。

**类型一致性**：`listGroups` 返回 `{id,name,color,count,created_at}` 在 Task 1/2/3 一致；
`groups[].{key,id,name,color,count,rows}` 在 Task 2/4 一致；
`group-action` 返回 `{added,removed,affected,errors}` 在 Task 3/5 一致。
