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
