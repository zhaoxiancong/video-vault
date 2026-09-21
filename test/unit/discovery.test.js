'use strict';
/**
 * 爬取任务生命周期测试 —— **全离线**，crawler 与 repo 都是假的。
 *
 * 核心要钉的是 20 秒兜底的确切语义（spec 3.2）：
 *   · 20 秒内完成 → 200，返回结果
 *   · 超过 20 秒    → 202 + runId，**且爬取继续跑到底并入库**（不是取消）
 *   · 失败          → 返回 {status:'failed'}，不把异常抛给调用方
 * 以及：串行（一次只跑一个）、stop() 之后不再发事件。
 *
 * ⚠️ `syncWaitMs` 必须可注入 —— 测试里绝不能真的等 20 秒。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDiscovery } = require('../../src/app/discovery');
const { AppError } = require('../../src/domain/errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假仓储：记录调用，不碰任何数据库 */
function fakeRepo() {
  const calls = { start: [], finish: [], insert: [], refresh: 0 };
  let nextId = 1;
  return {
    calls,
    startCrawlRun({ url }) { calls.start.push(url); return nextId++; },
    finishCrawlRun(id, info) { calls.finish.push({ id, ...info }); },
    insertCandidates(runId, items, sourceUrl) {
      calls.insert.push({ runId, count: items.length, sourceUrl });
      return { inserted: items.length, skipped: 0 };
    },
    refreshLibraryFlags() { calls.refresh += 1; return 0; },
  };
}

/** 假 crawler：可控延迟与结果 */
function fakeCrawler({ delay = 0, result = null, error = null, onCall = null } = {}) {
  const state = { calls: 0, concurrent: 0, peak: 0 };
  return {
    state,
    async analyzeSource(url) {
      state.calls += 1;
      state.concurrent += 1;
      state.peak = Math.max(state.peak, state.concurrent);
      if (onCall) onCall(url);
      try {
        await sleep(delay);
        if (error) throw error;
        return result || {
          path: 'html', title: null, site: 'x.com',
          items: [{ url: 'https://x/video.a/1/1/one', title: 'one', duration_sec: 60 }],
          paging: [], note: null,
        };
      } finally {
        state.concurrent -= 1;
      }
    },
    stop() { state.stopped = true; },
  };
}

const make = ({ repo, crawler, syncWaitMs = 1000, broadcast } = {}) =>
  createDiscovery({ repo: repo || fakeRepo(), crawler: crawler || fakeCrawler(), syncWaitMs, broadcast });

// ---------------------------------------------------------------- 快路径

test('20 秒内完成 → 返回 done，带 items 与 paging', async () => {
  const repo = fakeRepo();
  const d = make({ repo, crawler: fakeCrawler({ delay: 5 }), syncWaitMs: 200 });

  const r = await d.run('https://x/');
  assert.equal(r.status, 'done');
  assert.equal(r.path, 'html');
  assert.equal(r.items.length, 1);
  assert.ok(r.runId >= 1, '要带 runId');
  assert.equal(repo.calls.finish.length, 1, '要落一条完成记录');
  assert.equal(repo.calls.finish[0].status, 'done');
  assert.equal(repo.calls.insert.length, 1, '候选要入库');
});

// ---------------------------------------------------------------- 慢路径（20 秒兜底）

test('超过 syncWaitMs → 返回 202 语义的 running，且爬取**继续跑到底并入库**', async () => {
  const repo = fakeRepo();
  const crawler = fakeCrawler({ delay: 80 });
  const d = make({ repo, crawler, syncWaitMs: 10 });

  const r = await d.run('https://x/');
  assert.equal(r.status, 'running', '超过等待窗口就是 running');
  assert.ok(r.runId >= 1);
  assert.equal(repo.calls.finish.length, 0, '这时候还没跑完');

  // 关键：调用方拿到 202 之后，爬取必须自己跑完 —— 关掉浏览器也不影响
  await sleep(150);
  assert.equal(crawler.state.calls, 1);
  assert.equal(repo.calls.finish.length, 1, '后台上跑完了要落记录');
  assert.equal(repo.calls.finish[0].status, 'done');
  assert.equal(repo.calls.insert.length, 1, '后台上跑完了候选要入库');
  assert.equal(repo.calls.refresh, 1, '要刷新在库标记');
});

test('running 之后可以用 get(runId) 查到最终状态', async () => {
  const repo = fakeRepo();
  const d = make({ repo, crawler: fakeCrawler({ delay: 60 }), syncWaitMs: 10 });

  const r = await d.run('https://x/');
  assert.equal(r.status, 'running');
  assert.equal(d.get(r.runId).status, 'running');

  await sleep(120);
  const after = d.get(r.runId);
  assert.equal(after.status, 'done');
  assert.equal(after.itemCount, 1);
});

// ---------------------------------------------------------------- 失败

test('爬取失败 → 返回 failed 并带 error/hint，不抛给调用方', async () => {
  const repo = fakeRepo();
  const err = new AppError('目标站在限速（HTTP 429）', { kind: 'crawl-rate-limited', hint: '等几分钟再试。' });
  const d = make({ repo, crawler: fakeCrawler({ error: err }), syncWaitMs: 200 });

  const r = await d.run('https://x/');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /429|限速/);
  assert.ok(r.hint, 'hint 要透传给前端');
  assert.equal(repo.calls.finish[0].status, 'failed');
  assert.match(repo.calls.finish[0].error, /429|限速/);
});

test('后台跑失败也要落 failed 记录（不能静默）', async () => {
  const repo = fakeRepo();
  const err = new AppError('超时', { hint: '等一下再试' });
  const d = make({ repo, crawler: fakeCrawler({ delay: 60, error: err }), syncWaitMs: 10 });

  const r = await d.run('https://x/');
  assert.equal(r.status, 'running');
  await sleep(120);
  assert.equal(repo.calls.finish[0].status, 'failed');
});

// ---------------------------------------------------------------- 串行

test('串行：第二个请求等第一个跑完，峰值并发为 1', async () => {
  const repo = fakeRepo();
  const crawler = fakeCrawler({ delay: 40 });
  const d = make({ repo, crawler, syncWaitMs: 1000 });

  await Promise.all([d.run('https://a/'), d.run('https://b/')]);
  assert.equal(crawler.state.calls, 2);
  assert.equal(crawler.state.peak, 1, '同一时刻只能有一个在跑');
  assert.equal(repo.calls.start.length, 2, '两次爬取各有一条记录');
});

// ---------------------------------------------------------------- 事件

test('广播：发出 crawl 事件（开始与结束各一次）', async () => {
  const events = [];
  const d = make({ crawler: fakeCrawler({ delay: 5 }), syncWaitMs: 200, broadcast: (e, p) => events.push([e, p]) });

  await d.run('https://x/');
  const kinds = events.filter(([e]) => e === 'crawl').map(([, p]) => p.status);
  assert.ok(kinds.includes('running'), `应广播过 running，实际 ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('done'), `应广播过 done，实际 ${JSON.stringify(kinds)}`);
});

test('on() 注册的监听器能收到事件；stop() 之后不再收到', async () => {
  const seen = [];
  const repo = fakeRepo();
  const crawler = fakeCrawler({ delay: 30 });
  const d = make({ repo, crawler, syncWaitMs: 500 });

  d.on('crawl', (e) => seen.push(e.status));
  const p = d.run('https://x/');
  await sleep(5);
  d.stop();
  await p.catch(() => {});
  const countAtStop = seen.length;
  await sleep(60);
  assert.ok(countAtStop >= 1, 'stop 之前应当已经收到过事件');
  assert.equal(seen.length, countAtStop, 'stop 之后不该再发事件');
  assert.equal(crawler.state.stopped, true, 'stop 要透传给 crawler');
});

test('stop() 之后再 run 会立刻失败而不是重新跑起来', async () => {
  const d = make({ crawler: fakeCrawler({ delay: 5 }), syncWaitMs: 100 });
  d.stop();
  const r = await d.run('https://x/');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /停止|关闭/);
});

// ---------------------------------------------------------------- 卫生

test('每次 run 都新建一条 crawl_runs 记录（翻页会产生多条）', async () => {
  const repo = fakeRepo();
  const d = make({ repo, crawler: fakeCrawler({ delay: 1 }), syncWaitMs: 200 });

  await d.run('https://x/');
  await d.run('https://x/new/2');
  assert.deepEqual(repo.calls.start, ['https://x/', 'https://x/new/2']);
  assert.notEqual(repo.calls.finish[0].id, repo.calls.finish[1].id, '两条记录要有各自的 id');
});
