'use strict';
/**
 * 仓储（数据访问层）测试。
 *
 * 全部跑在**临时目录里的独立数据库**上 —— 这一点在重构前根本做不到
 * （db.js 一被 require 就打开真实库）。历史教训：验证「清空已完成记录」时
 * 直接对用户的真实库执行，真删掉了 7 条记录。
 *
 * 所以这里每个测试都先 mkdtempSync 建一个隔离环境，跑完删掉。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, ensureDirs, DEFAULT_SETTINGS } = require('../../src/infra/config');
const { createDatabase } = require('../../src/infra/database');

/** 建一个完全隔离的仓储 */
function freshRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-db-'));
  const config = loadConfig({
    root: tmp,
    data: path.join(tmp, 'data'),
    downloads: path.join(tmp, 'downloads'),
  });
  ensureDirs(config);
  const repo = createDatabase(config);
  return {
    repo, config, tmp,
    cleanup() { try { repo.close(); } catch { /* 忽略 */ } fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

test('建库 + 迁移不碰任何已存在的目录', () => {
  const ctx = freshRepo();
  try {
    const mig = ctx.repo.runMigrations();
    assert.ok(Array.isArray(mig.columnsAdded));
    // 表都建出来了
    const tables = ctx.repo.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((r) => r.name);
    for (const t of ['videos', 'playlists', 'settings', 'events', 'subscriptions']) {
      assert.ok(tables.includes(t), `缺表 ${t}`);
    }
  } finally { ctx.cleanup(); }
});

test('insertVideo 会静默丢弃白名单外的字段 —— 除非开严格模式（坑 16）', () => {
  const ctx = freshRepo();
  try {
    // 非严格：不该抛错，但字段确实丢了（这是既有行为，保留）
    const v = ctx.repo.insertVideo({ url: 'https://a/1', title: 't', bogus: 1 });
    assert.equal(v.title, 't');

    // 严格：必须当场报错，而不是静默丢数据
    const strict = createDatabase(ctx.config, { strict: true });
    assert.throws(
      () => strict.insertVideo({ url: 'https://a/2', title: 't', bogus: 1 }),
      /不在可写白名单里/,
    );
    strict.close();
  } finally { ctx.cleanup(); }
});

test('file_path / file_size / thumbnail_path 能被写入（曾经漏在白名单外）', () => {
  const ctx = freshRepo();
  try {
    const v = ctx.repo.insertVideo({
      url: 'https://a/3', title: 't',
      file_path: 'D:\\x\\a.mkv', file_size: 123, thumbnail_path: 'D:\\x\\t.jpg',
    });
    assert.equal(v.file_path, 'D:\\x\\a.mkv', 'file_path 被静默丢弃了');
    assert.equal(v.file_size, 123);
    assert.equal(v.thumbnail_path, 'D:\\x\\t.jpg');
  } finally { ctx.cleanup(); }
});

test('布尔字段出库时是布尔，不是 0/1', () => {
  const ctx = freshRepo();
  try {
    const v = ctx.repo.insertVideo({ url: 'https://a/4', title: 't' });
    assert.equal(typeof v.starred, 'boolean');
    assert.equal(v.starred, false);

    ctx.repo.updateVideo(v.id, { starred: true });
    const v2 = ctx.repo.getVideo(v.id);
    assert.equal(v2.starred, true, '写 true 读回来必须还是 true');
  } finally { ctx.cleanup(); }
});

test('url 唯一约束：重复插入会抛错', () => {
  const ctx = freshRepo();
  try {
    ctx.repo.insertVideo({ url: 'https://dup/1', title: 'a' });
    assert.throws(() => ctx.repo.insertVideo({ url: 'https://dup/1', title: 'b' }));
    assert.ok(ctx.repo.findByUrl('https://dup/1'));
  } finally { ctx.cleanup(); }
});

test('设置：默认值 + 只接受已知键', () => {
  const ctx = freshRepo();
  try {
    const s = ctx.repo.getSettings();
    assert.equal(s.concurrency, DEFAULT_SETTINGS.concurrency);
    // 默认不启用登录态（隐私底线）
    assert.equal(s.cookiesFromBrowser, '');
    assert.equal(s.cookiesFile, '');

    const next = ctx.repo.setSettings({ concurrency: 4, bogusKey: 'x' });
    assert.equal(next.concurrency, 4);
    assert.equal(next.bogusKey, undefined, '未知设置键不该被存进去');

    // 存进去的值要能读回来（JSON 往返）
    assert.equal(ctx.repo.getSettings().concurrency, 4);
  } finally { ctx.cleanup(); }
});

test('listVideos 的筛选、排序、分页', () => {
  const ctx = freshRepo();
  try {
    const mk = (url, title, status, size, site) => ctx.repo.insertVideo({
      url, title, status, file_size: size, site,
    });
    mk('https://s/1', '苹果', 'done', 300, 'Youtube');
    mk('https://s/2', '香蕉', 'done', 100, 'BiliBili');
    mk('https://s/3', '橙子', 'failed', 200, 'Youtube');

    assert.equal(ctx.repo.listVideos({}).total, 3);
    assert.equal(ctx.repo.listVideos({ q: '苹' }).total, 1, '关键词搜索');
    assert.equal(ctx.repo.listVideos({ status: 'done' }).total, 2);
    assert.equal(ctx.repo.listVideos({ site: 'Youtube' }).total, 2);

    const bySize = ctx.repo.listVideos({ sort: 'size_desc' }).rows.map((r) => r.file_size);
    assert.deepEqual(bySize, [300, 200, 100], '按体积排序');

    const page = ctx.repo.listVideos({ limit: 1, offset: 1 });
    assert.equal(page.rows.length, 1);
    assert.equal(page.total, 3, 'total 是总数，不受分页影响');

    // 排序字段是白名单的，乱传要退回默认而不是拼进 SQL
    assert.doesNotThrow(() => ctx.repo.listVideos({ sort: 'DROP TABLE videos' }));
    assert.equal(ctx.repo.listVideos({}).total, 3, '乱传排序不该破坏数据');
  } finally { ctx.cleanup(); }
});

test('deleteVideo 默认保留文件（这条是刻意的）', () => {
  const ctx = freshRepo();
  try {
    const v = ctx.repo.insertVideo({ url: 'https://d/1', title: 't' });
    const r = ctx.repo.deleteVideo(v.id);
    assert.equal(r.keepFile, true, '默认必须保留文件');
    assert.equal(ctx.repo.getVideo(v.id), null, '记录要删掉');
  } finally { ctx.cleanup(); }
});

test('dedupeByFile 合并同文件的重复记录，保留信息更全的那条', () => {
  const ctx = freshRepo();
  try {
    const file = 'D:\\x\\same.mkv';
    // 一条是 rebuild 出来的占位（local:// URL + 无封面），一条是用户重粘的真实记录
    const poor = ctx.repo.insertVideo({ url: 'local://x', title: '占位', file_path: file });
    const rich = ctx.repo.insertVideo({ url: 'https://real/1', title: '真实', file_path: file, notes: '备注' });

    const merged = ctx.repo.dedupeByFile(rich.id);
    assert.ok(merged, '应该合并');
    assert.equal(merged.kept, rich.id, '要保留信息更全的那条（有真实 URL）');
    assert.equal(merged.removed, 1);
    assert.equal(ctx.repo.getVideo(poor.id), null, '占位记录应被删掉');
    assert.ok(ctx.repo.getVideo(rich.id), '真实记录要留着');
    assert.equal(ctx.repo.listVideos({}).total, 1);
  } finally { ctx.cleanup(); }
});

test('同一文件只有一条记录时 dedupeByFile 返回 null（不该误删）', () => {
  const ctx = freshRepo();
  try {
    const v = ctx.repo.insertVideo({ url: 'https://only/1', file_path: 'D:\\x\\solo.mkv' });
    assert.equal(ctx.repo.dedupeByFile(v.id), null);
    assert.ok(ctx.repo.getVideo(v.id), '唯一的那条绝不能被删');
  } finally { ctx.cleanup(); }
});

test('markStaleActiveAsPaused 把残留任务标成暂停（手动继续才续）', () => {
  const ctx = freshRepo();
  try {
    const a = ctx.repo.insertVideo({ url: 'https://q/1', status: 'downloading' });
    const b = ctx.repo.insertVideo({ url: 'https://q/2', status: 'queued' });
    const c = ctx.repo.insertVideo({ url: 'https://q/3', status: 'done' });

    const ids = ctx.repo.markStaleActiveAsPaused();
    assert.deepEqual(ids.sort(), [a.id, b.id].sort());
    assert.equal(ctx.repo.getVideo(a.id).status, 'paused');
    assert.equal(ctx.repo.getVideo(b.id).status, 'paused');
    assert.equal(ctx.repo.getVideo(c.id).status, 'done', '已完成的不该被动');
    assert.match(ctx.repo.getVideo(a.id).error, /中断/);
  } finally { ctx.cleanup(); }
});

test('事务：出错要整体回滚，不留半拉子状态', () => {
  const ctx = freshRepo();
  try {
    ctx.repo.insertVideo({ url: 'https://t/1', title: 'before' });
    assert.throws(() => {
      ctx.repo.transaction(() => {
        ctx.repo.insertVideo({ url: 'https://t/2', title: 'inside' });
        throw new Error('故意失败');
      });
    }, /故意失败/);

    assert.equal(ctx.repo.findByUrl('https://t/2'), null, '事务里的写入应该被回滚');
    assert.ok(ctx.repo.findByUrl('https://t/1'), '事务前的数据不受影响');
  } finally { ctx.cleanup(); }
});

test('事件游标：emitEvent / eventsSince', () => {
  const ctx = freshRepo();
  try {
    const id1 = ctx.repo.emitEvent('test', { a: 1 });
    const id2 = ctx.repo.emitEvent('test', { b: 2 });
    assert.ok(id2 > id1);

    const since = ctx.repo.eventsSince(id1);
    assert.equal(since.length, 1);
    assert.deepEqual(since[0].payload, { b: 2 }, 'payload 要能 JSON 往返');
  } finally { ctx.cleanup(); }
});

test('facets 统计站点/作者/状态/总量', () => {
  const ctx = freshRepo();
  try {
    ctx.repo.insertVideo({ url: 'https://f/1', site: 'Youtube', uploader: 'A', status: 'done', file_size: 10 });
    ctx.repo.insertVideo({ url: 'https://f/2', site: 'Youtube', uploader: 'B', status: 'done', file_size: 20 });
    ctx.repo.insertVideo({ url: 'https://f/3', site: 'BiliBili', uploader: 'A', status: 'failed', file_size: 5 });

    const fac = ctx.repo.facets();
    assert.equal(fac.totals.count_all, 3);
    assert.equal(fac.totals.count_done, 2);
    assert.equal(fac.totals.bytes_all, 35);
    const yt = fac.sites.find((s) => s.v === 'Youtube');
    assert.equal(yt.n, 2);
  } finally { ctx.cleanup(); }
});

test('两个隔离的库互不影响（这正是重构要买到的能力）', () => {
  const a = freshRepo();
  const b = freshRepo();
  try {
    a.repo.insertVideo({ url: 'https://iso/1', title: '只在 A' });
    assert.equal(a.repo.listVideos({}).total, 1);
    assert.equal(b.repo.listVideos({}).total, 0, 'B 不该看到 A 的数据');
    assert.notEqual(a.config.paths.db, b.config.paths.db);
  } finally { a.cleanup(); b.cleanup(); }
});

// ---------------------------------------------------------------- 爬取候选

test('候选：插入后能按 runId / 关键字 / 只在库外 查询', () => {
  const ctx = freshRepo();
  try {
    const runId = ctx.repo.startCrawlRun({ url: 'https://x/' });
    const r = ctx.repo.insertCandidates(runId, [
      { url: 'https://x/video.aaa/1/1/cat_video', title: 'cat video', duration_sec: 60, site_video_id: '1', thumb_url: null },
      { url: 'https://x/video.bbb/1/1/dog_video', title: 'dog video', duration_sec: null, site_video_id: '2', thumb_url: null },
    ], 'https://x/');

    assert.equal(r.inserted, 2);
    assert.equal(ctx.repo.listCandidates({}).total, 2);
    assert.equal(ctx.repo.listCandidates({ q: 'cat' }).total, 1);
    assert.equal(ctx.repo.listCandidates({ runId }).total, 2);

    const rows = ctx.repo.listCandidates({}).rows;
    assert.equal(rows[0].duration_sec, 60);
    assert.equal(rows[1].duration_sec, null, '缺失时长保持 null，不能变成 0');
    // 这两个字段是给前端直接用的，所以是布尔而不是 SQLite 的 0/1
    assert.equal(rows[0].in_library, false);
    assert.equal(rows[0].added, false);
  } finally { ctx.cleanup(); }
});

test('候选：重复 url 不堆积，第二次插入算 skipped', () => {
  const ctx = freshRepo();
  try {
    const a = ctx.repo.startCrawlRun({ url: 'https://x/' });
    ctx.repo.insertCandidates(a, [{ url: 'https://x/video.aaa/1/1/same', title: 't' }], 'https://x/');
    const b = ctx.repo.startCrawlRun({ url: 'https://x/new/2' });
    const r = ctx.repo.insertCandidates(b, [{ url: 'https://x/video.aaa/1/1/same', title: 't' }], 'https://x/new/2');

    assert.equal(r.inserted, 0);
    assert.equal(r.skipped, 1);
    assert.equal(ctx.repo.listCandidates({}).total, 1, '不能变成两条');
  } finally { ctx.cleanup(); }
});

test('候选：refreshLibraryFlags 把已在库的标出来，onlyNew 能排除它们', () => {
  const ctx = freshRepo();
  try {
    const url = 'https://x/video.ccc/1/1/in_lib';
    ctx.repo.insertVideo({ url, title: 'in lib' });
    const runId = ctx.repo.startCrawlRun({ url: 'https://x/' });
    ctx.repo.insertCandidates(runId, [{ url, title: 'in lib' }], 'https://x/');

    const n = ctx.repo.refreshLibraryFlags();
    assert.ok(n >= 1, '至少标出 1 条');
    assert.equal(ctx.repo.listCandidates({ onlyNew: true }).total, 0, '已在库的应被 onlyNew 排除');
    assert.equal(ctx.repo.listCandidates({}).rows[0].in_library, true);
  } finally { ctx.cleanup(); }
});

test('候选：markCandidatesAdded 之后 added 字段能查出来', () => {
  const ctx = freshRepo();
  try {
    const runId = ctx.repo.startCrawlRun({ url: 'https://x/' });
    ctx.repo.insertCandidates(runId, [
      { url: 'https://x/video.a/1/1/one', title: 'one' },
      { url: 'https://x/video.b/1/1/two', title: 'two' },
    ], 'https://x/');
    const ids = ctx.repo.listCandidates({}).rows.map((r) => r.id);

    const n = ctx.repo.markCandidatesAdded([ids[0]]);
    assert.equal(n, 1);
    const rows = ctx.repo.listCandidates({}).rows;
    assert.equal(rows.find((r) => r.id === ids[0]).added, true);
    assert.equal(rows.find((r) => r.id === ids[1]).added, false);
  } finally { ctx.cleanup(); }
});

test('候选：getCandidatesByIds 按 id 取回 url/title（入队要用）', () => {
  const ctx = freshRepo();
  try {
    const runId = ctx.repo.startCrawlRun({ url: 'https://x/' });
    ctx.repo.insertCandidates(runId, [
      { url: 'https://x/video.a/1/1/one', title: 'one' },
      { url: 'https://x/video.b/1/1/two', title: 'two' },
    ], 'https://x/');
    const ids = ctx.repo.listCandidates({}).rows.map((r) => r.id);

    const got = ctx.repo.getCandidatesByIds([ids[0], ids[1], 99999]);
    assert.equal(got.length, 2, '不存在的 id 被忽略而不是报错');
    assert.equal(got[0].url, 'https://x/video.a/1/1/one');
    assert.equal(got[0].title, 'one');
    assert.deepEqual(ctx.repo.getCandidatesByIds([]), []);
  } finally { ctx.cleanup(); }
});

test('爬取记录：finishCrawlRun 记录状态、路径、条数与翻页', () => {
  const ctx = freshRepo();
  try {
    const runId = ctx.repo.startCrawlRun({ url: 'https://x/' });
    const running = ctx.repo.getCrawlRun(runId);
    assert.equal(running.status, 'running');
    assert.equal(running.url, 'https://x/');

    ctx.repo.finishCrawlRun(runId, {
      status: 'done', path: 'html', site: 'x.com', title: '首页',
      itemCount: 3, paging: [{ label: '第 2 页', url: 'https://x/new/2' }], note: '用页面解析',
    });
    const run = ctx.repo.getCrawlRun(runId);
    assert.equal(run.status, 'done');
    assert.equal(run.path, 'html');
    assert.equal(run.item_count, 3);
    assert.equal(run.note, '用页面解析');
    assert.equal(JSON.parse(run.paging_json)[0].label, '第 2 页');
    assert.ok(run.finished_at, '完成时间要被写上');
  } finally { ctx.cleanup(); }
});

test('爬取记录：失败时记 error，且 getCrawlRun 对不存在的 id 返回 null', () => {
  const ctx = freshRepo();
  try {
    const runId = ctx.repo.startCrawlRun({ url: 'https://bad/' });
    ctx.repo.finishCrawlRun(runId, { status: 'failed', error: '目标站在限速（HTTP 429）' });
    const run = ctx.repo.getCrawlRun(runId);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /429|限速/);
    assert.equal(ctx.repo.getCrawlRun(999999), null);
  } finally { ctx.cleanup(); }
});

test('候选：listCandidates 的分页与 limit 生效', () => {
  const ctx = freshRepo();
  try {
    const runId = ctx.repo.startCrawlRun({ url: 'https://x/' });
    const items = Array.from({ length: 10 }, (_, i) => ({
      url: `https://x/video.g${i}/1/1/t${i}`, title: `t${i}`,
    }));
    ctx.repo.insertCandidates(runId, items, 'https://x/');

    assert.equal(ctx.repo.listCandidates({}).total, 10);
    assert.equal(ctx.repo.listCandidates({ limit: 4 }).rows.length, 4);
    assert.equal(ctx.repo.listCandidates({ limit: 4, offset: 8 }).rows.length, 2);
  } finally { ctx.cleanup(); }
});

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

    // Review Focus 2：只差空格或大小写的同名也算重名 ——
    // 否则界面上会出现两个肉眼一样的组，用户分不清点哪个
    assert.throws(() => ctx.repo.createGroup({ name: ' 待看 ' }), (e) => {
      assert.equal(e.httpStatus, 409, '重名必须是 409，不能静默建两个');
      return true;
    });
    assert.throws(() => ctx.repo.createGroup({ name: '待看' }), (e) => e.httpStatus === 409);
  } finally { ctx.cleanup(); }
});

test('分组：名字为空或超长要报错，且不说"已保存"', () => {
  const ctx = freshRepo();
  try {
    assert.throws(() => ctx.repo.createGroup({ name: '   ' }), (e) => e.httpStatus === 400);
    assert.throws(() => ctx.repo.createGroup({ name: 'x'.repeat(41) }), (e) => e.httpStatus === 400);
    assert.equal(ctx.repo.listGroups().length, 0, '失败的创建不能留下记录');
  } finally { ctx.cleanup(); }
});

test('分组：重名归一化要覆盖非 ASCII（评审 Minor）', () => {
  const ctx = freshRepo();
  try {
    /**
     * 原来查重走 SQL 的 `COLLATE NOCASE`，它**只折叠 ASCII** ——
     * 于是 `Ä`/`ä` 会建出两个肉眼一模一样的分组。现在改成 JS 里
     * `NFKC` + `toLowerCase` 比对（分组数量极少，这么做完全够用）。
     */
    ctx.repo.createGroup({ name: 'Ärger' });
    assert.throws(() => ctx.repo.createGroup({ name: 'ärger' }), (e) => e.httpStatus === 409,
      'ä 和 Ä 看起来一样，该算重名');
    assert.throws(() => ctx.repo.createGroup({ name: 'ÄRGER' }), (e) => e.httpStatus === 409);

    // 全角字母（NFKC 会折成半角）
    ctx.repo.createGroup({ name: 'ABC' });
    assert.throws(() => ctx.repo.createGroup({ name: 'ＡＢＣ' }), (e) => e.httpStatus === 409,
      '全角 ＡＢＣ 与半角 ABC 看起来一样');

    // 组合字符：é 的两种 Unicode 写法
    ctx.repo.createGroup({ name: 'cafe\u0301' });     // e + 组合重音
    assert.throws(() => ctx.repo.createGroup({ name: 'caf\u00e9' }), (e) => e.httpStatus === 409,
      'é 的两种写法要算同一个名字');

    assert.equal(ctx.repo.listGroups().length, 3, '只该有 3 个组');
  } finally { ctx.cleanup(); }
});

test('分组：改名时也要用同一套归一化查重（且要排除自己）', () => {
  const ctx = freshRepo();
  try {
    const a = ctx.repo.createGroup({ name: 'Ärger' });
    const b = ctx.repo.createGroup({ name: 'anderes' });

    // 改成**别人的**名字（大小写不同也算）：必须 409
    assert.throws(() => ctx.repo.updateGroup(a.id, { name: 'ANDERES' }), (e) => e.httpStatus === 409,
      '改成别人名字的另一种大小写也要 409');

    /**
     * 改成"自己名字的另一种大小写"应当**成功**。
     * ⚠️ 我第一版测试在这里断言 409，那是把语义搞反了：
     *    `Ärger` 与 `ärger` 归一化后是同一个键，但它是**自己**的键 ——
     *    查重要排除自己，否则用户连"把分组名改成大写"都做不到。
     */
    const same = ctx.repo.updateGroup(a.id, { name: 'ärger' });
    assert.equal(same.name, 'ärger', '只改大小写应当允许');
    assert.equal(same.id, a.id, '还是同一个分组，不该新建');

    assert.equal(ctx.repo.listGroups().length, 2, '数量不变');
    assert.equal(ctx.repo.listGroups().find((g) => g.id === b.id).name, 'anderes', '别的不受影响');
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
    assert.deepEqual(map.get(a.id).slice().sort(), [g1.id, g2.id].slice().sort(), 'v1 在两个组里');
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

test('分组：addToGroup 忽略不存在的视频 id 与不存在的分组', () => {
  const ctx = freshRepo();
  try {
    const v = ctx.repo.insertVideo({ url: 'https://x/1', title: 'v1' });
    const g = ctx.repo.createGroup({ name: '待看' });
    assert.equal(ctx.repo.addToGroup([v.id, 999999], g.id), 1, '只加存在的那条');
    assert.equal(ctx.repo.addToGroup([v.id], 999999), 0, '分组不存在时什么都不做');
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
    assert.equal(ctx.repo.removeFromGroup([v.id], g.id), 0, '再摘一次是 0');
  } finally { ctx.cleanup(); }
});

test('分组：改名与换色；改成别人的名字要 409；不存在返回 null', () => {
  const ctx = freshRepo();
  try {
    const a = ctx.repo.createGroup({ name: '待看', color: 'amber' });
    ctx.repo.createGroup({ name: '教程', color: 'blue' });

    const renamed = ctx.repo.updateGroup(a.id, { name: '稍后看', color: 'green' });
    assert.equal(renamed.name, '稍后看');
    assert.equal(renamed.color, 'green');

    assert.throws(() => ctx.repo.updateGroup(a.id, { name: '教程' }), (e) => e.httpStatus === 409,
      '改成已存在的名字必须 409');
    assert.equal(ctx.repo.updateGroup(999999, { name: 'x' }), null, '不存在返回 null');

    // 只改颜色时名字不能被清掉
    const colored = ctx.repo.updateGroup(a.id, { color: 'red' });
    assert.equal(colored.name, '稍后看');
    assert.equal(colored.color, 'red');
  } finally { ctx.cleanup(); }
});

test('分组：detach 只解散，purge 删记录但不动磁盘文件（Review Focus 6）', () => {
  const ctx = freshRepo();
  try {
    const file = path.join(ctx.tmp, 'downloads', 'keepme.mp4');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fake video bytes');

    const v = ctx.repo.insertVideo({
      url: 'https://x/1', title: 'v1', status: 'done', file_path: file,
    });
    const g1 = ctx.repo.createGroup({ name: '待看' });
    const g2 = ctx.repo.createGroup({ name: '教程' });
    ctx.repo.addToGroup([v.id], g1.id);

    // detach：视频和文件都必须还在
    const d1 = ctx.repo.deleteGroup(g1.id, { mode: 'detach' });
    assert.equal(d1.mode, 'detach');
    assert.equal(d1.removedVideos, 0);
    assert.ok(ctx.repo.getVideo(v.id), 'detach 不能删视频记录');
    assert.ok(fs.existsSync(file), 'detach 不能动磁盘文件');

    // purge：删库记录，但**磁盘文件仍然在**（这条最容易做错，也最伤人）
    ctx.repo.addToGroup([v.id], g2.id);
    const d2 = ctx.repo.deleteGroup(g2.id, { mode: 'purge' });
    assert.equal(d2.mode, 'purge');
    assert.equal(d2.removedVideos, 1);
    assert.equal(ctx.repo.getVideo(v.id), null, 'purge 要删掉库记录');
    assert.ok(fs.existsSync(file), '⚠️ purge 绝不能删磁盘文件');
    assert.equal(ctx.repo.listGroups().length, 0);
  } finally { ctx.cleanup(); }
});

test('分组：删除不存在的分组返回 null，不抛异常', () => {
  const ctx = freshRepo();
  try {
    assert.equal(ctx.repo.deleteGroup(999999), null);
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

test('分组：groupIdsFor 对空输入与不存在的 id 都安全', () => {
  const ctx = freshRepo();
  try {
    assert.equal(ctx.repo.groupIdsFor([]).size, 0);
    assert.equal(ctx.repo.groupIdsFor([999999]).size, 0);
  } finally { ctx.cleanup(); }
});

test('分组：listVideosAll 与 listVideos 用同一套筛选，只是不分页', () => {
  const ctx = freshRepo();
  try {
    for (let i = 0; i < 5; i++) {
      ctx.repo.insertVideo({
        url: `https://x/${i}`, title: `t${i}`, site: i < 2 ? 'Youtube' : 'XVideos',
      });
    }
    const paged = ctx.repo.listVideos({ site: 'Youtube', limit: 1 });
    const all = ctx.repo.listVideosAll({ site: 'Youtube' });
    assert.equal(paged.total, 2);
    assert.equal(paged.rows.length, 1, '分页版只给 1 条');
    assert.equal(all.length, 2, '全集版要给全部 2 条');
    // 顺序必须一致 —— 两者共用同一段 ORDER BY，抽共享片段就是为了这个
    assert.deepEqual(
      all.map((r) => r.id),
      ctx.repo.listVideos({ site: 'Youtube' }).rows.map((r) => r.id),
      '两者的顺序必须一致（同一套 ORDER BY）',
    );
  } finally { ctx.cleanup(); }
});

test('分组：listVideosAll 支持全部筛选维度（q/status/site/uploader/starred）', () => {
  const ctx = freshRepo();
  try {
    ctx.repo.insertVideo({ url: 'https://x/1', title: 'alpha', site: 'Youtube', uploader: 'u1', status: 'done' });
    ctx.repo.insertVideo({ url: 'https://x/2', title: 'beta', site: 'BiliBili', uploader: 'u2', status: 'failed' });
    assert.equal(ctx.repo.listVideosAll({ q: 'alpha' }).length, 1);
    assert.equal(ctx.repo.listVideosAll({ status: 'failed' }).length, 1);
    assert.equal(ctx.repo.listVideosAll({ uploader: 'u1' }).length, 1);
    assert.equal(ctx.repo.listVideosAll({ starred: true }).length, 0);
    assert.equal(ctx.repo.listVideosAll({}).length, 2);
  } finally { ctx.cleanup(); }
});
