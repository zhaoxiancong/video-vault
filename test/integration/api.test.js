'use strict';
/**
 * HTTP 接口集成测试 —— 起一个**完全隔离**的应用实例，走真实 HTTP 请求。
 *
 * 这是重构带来的最大好处之一：`createApp({data: 临时目录})` 就能起一个
 * 跟用户数据毫无关系的实例，跑完关掉。重构前做不到 —— 模块一 require
 * 就打开了真实数据库。
 *
 * 所以这些测试可以放心地做"破坏性"操作（删记录、清空、改设置），
 * 因为它们只碰得到临时目录。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../../src/main');

/** 真实的项目根 —— 前端源码在 `src/web/`，只有真 root 才找得到 */
const APP_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 起一个隔离实例，返回 base URL 和清理函数。
 *
 * @param {object} [overrides] 透传给 createApp —— 爬取测试用它注入**假 crawler**，
 *                             这样接口测试完全不联网。
 */
async function startApp(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-api-'));
  const app = createApp({
    data: path.join(tmp, 'data'),
    downloads: path.join(tmp, 'downloads'),
    ...overrides,
  });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;

  const call = async (method, p, body) => {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + p, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };

  return {
    app, base, call, tmp,
    async cleanup() {
      await app.shutdown();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('健康检查返回引擎状态与设置', async () => {
  const s = await startApp();
  try {
    const r = await s.call('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.ok(r.data.engines.ytdlp, '要报告 yt-dlp 状态');
    assert.ok(r.data.engines.ffmpeg, '要报告 ffmpeg 状态');
    assert.equal(typeof r.data.settings.concurrency, 'number');
    assert.ok(r.data.downloads.includes('downloads'));
  } finally { await s.cleanup(); }
});

/**
 * 图标必须真的服务得出来。
 *
 * 这条测试是从一个真实的坑补回来的：之前 index.html **没声明图标**，仓库里也没有
 * 图标文件，于是浏览器自动去要 `/favicon.ico` 拿到 404 —— 控制台多一条 error，
 * 而 `test/ui/smoke.js` 的「没有运行时报错」把任何 console error 都算失败，
 * 结果那条 UI 冒烟测试**在任何机器上都必然报 1 项失败**（生来就红）。
 * 而浏览器不是每个会话都起得来，所以这个坑当时没被发现。
 *
 * 这里走真实 HTTP 验"服务端确实吐得出这个文件"，纯静态的部分（HTML 里声明的
 * 文件存不存在）在 test/integration/frontend-dom.test.mjs 里。
 */
test('图标：/static/favicon.svg 真的服务得出来，且浏览器不会再去要 /favicon.ico', async () => {
  const s = await startApp();
  try {
    const res = await fetch(`${s.base}/static/favicon.svg`);
    assert.equal(res.status, 200, '图标必须 200 —— 404 会让浏览器回退去要 /favicon.ico');
    assert.match(res.headers.get('content-type') || '', /image\/svg\+xml/,
      'MIME 不对浏览器可能不认这个图标');
    const body = await res.text();
    assert.ok(body.includes('<svg'), '内容应该是 SVG');

    const fallback = await s.call('GET', '/favicon.ico');
    assert.equal(fallback.status, 404,
      '本项目的静态服务没有映射 /favicon.ico —— 所以 index.html 里必须显式声明图标，'
      + '否则浏览器那次自动请求就是一条 404 console error');
  } finally { await s.cleanup(); }
});

test('设置：未知键返回 400 而不是静默忽略', async () => {
  const s = await startApp();
  try {
    const bad = await s.call('PATCH', '/api/settings', { bogusKey: 1 });
    assert.equal(bad.status, 400, '未知键必须报错，不能假装保存成功');
    assert.match(bad.data.error, /bogusKey/);
    assert.ok(bad.data.hint, '错误要带 hint');

    const good = await s.call('PATCH', '/api/settings', { concurrency: 3 });
    assert.equal(good.status, 200);
    assert.equal(good.data.concurrency, 3);
  } finally { await s.cleanup(); }
});

test('设置：越界的值被拒绝', async () => {
  const s = await startApp();
  try {
    const r = await s.call('PATCH', '/api/settings', { concurrency: 999 });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /不能大于/);
  } finally { await s.cleanup(); }
});

test('设置：非法浏览器名被拒绝，并列出可用的', async () => {
  const s = await startApp();
  try {
    const r = await s.call('PATCH', '/api/settings', { cookiesFromBrowser: 'netscape' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /netscape/);
    assert.match(r.data.hint, /chrome/);
  } finally { await s.cleanup(); }
});

test('登录态：默认不启用（隐私底线）', async () => {
  const s = await startApp();
  try {
    const r = await s.call('GET', '/api/cookies/status');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.effective.args, [], '没配置时一个 cookie 参数都不该带');
    assert.equal(r.data.effective.source, 'none');
    assert.ok(Array.isArray(r.data.supported));
  } finally { await s.cleanup(); }
});

test('登录态自检：没配置时给"去哪配"的提示，而不是报错', async () => {
  const s = await startApp();
  try {
    const r = await s.call('POST', '/api/cookies/test', {});
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, false);
    assert.equal(r.data.configured, false);
    assert.match(r.data.hint, /设置|浏览器|cookies/);
  } finally { await s.cleanup(); }
});

test('添加链接：非法地址被拒，返回可操作提示', async () => {
  const s = await startApp();
  try {
    const r = await s.call('POST', '/api/videos', { urls: '不是链接\n也不是' });
    assert.equal(r.status, 400);
    assert.match(r.data.hint, /http/);
  } finally { await s.cleanup(); }
});

test('添加链接：抖音地址被自动归一化，并在报告里说明', async () => {
  const s = await startApp();
  try {
    const r = await s.call('POST', '/api/videos', {
      urls: 'https://www.douyin.com/jingxuan?modal_id=7671972624104197391',
    });
    assert.equal(r.status, 202);
    assert.equal(r.data.renamed.length, 1);
    assert.equal(r.data.renamed[0].to, 'https://www.douyin.com/video/7671972624104197391');
    assert.match(r.data.renamed[0].note, /自动识别/);
    assert.equal(r.data.added.length, 1);
  } finally { await s.cleanup(); }
});

test('添加链接：同一批里的重复地址只入库一次', async () => {
  const s = await startApp();
  try {
    const r = await s.call('POST', '/api/videos', {
      urls: 'https://example.com/same\nhttps://example.com/same',
    });
    assert.equal(r.data.added.length, 1, '同一批里重复的要去重');
  } finally { await s.cleanup(); }
});

test('添加链接：库里已有的跳过；失败状态的自动重试', async () => {
  const s = await startApp();
  try {
    const url = 'https://example.com/repeat';
    const first = await s.call('POST', '/api/videos', { urls: url });
    assert.equal(first.data.added.length, 1);
    const id = first.data.added[0].id;

    // ⚠️ 注意：新任务入库后，调度器会**立刻**把它捞起来开跑（状态会从 queued
    //    变成 parsing/downloading，然后因为 example.com 不是真视频站而失败）。
    //    所以这里不能假设"刚添加完还是 queued"——那是跟调度器抢时序。
    //    明确地把它设成一个终态，才是在测"跳过"这条逻辑本身。
    s.app.repo.updateVideo(id, { status: 'done', error: null });
    const second = await s.call('POST', '/api/videos', { urls: url });
    assert.equal(second.data.skipped.length, 1, '已完成的再粘一次应该跳过');
    assert.equal(second.data.skipped[0].id, id);
    assert.equal(second.data.skipped[0].reason, '库里已有');

    // 标成失败再粘一次 → 应该走"重试"分支
    s.app.repo.updateVideo(id, { status: 'failed', error: '模拟失败' });
    const third = await s.call('POST', '/api/videos', { urls: url });
    assert.equal(third.data.retried.length, 1, '失败的任务重新粘链接应该等于重试');
    assert.equal(third.data.retried[0].was, 'failed');
    assert.equal(third.data.skipped.length, 0);
  } finally { await s.cleanup(); }
});

test('单条动作：未知动作被拒，收藏能翻转', async () => {
  const s = await startApp();
  try {
    const add = await s.call('POST', '/api/videos', { urls: 'https://example.com/act' });
    const id = add.data.added[0].id;

    const bad = await s.call('POST', `/api/videos/${id}/action`, { action: 'explode' });
    assert.equal(bad.status, 400);
    // 报错要说清"允许什么"和"你给的是什么" —— 只说一句"参数错误"没法排查
    assert.match(bad.data.error, /只能是/);
    assert.match(bad.data.error, /pause/);
    assert.match(bad.data.hint, /explode/);

    const star1 = await s.call('POST', `/api/videos/${id}/action`, { action: 'star' });
    assert.equal(star1.data.video.starred, true);
    const star2 = await s.call('POST', `/api/videos/${id}/action`, { action: 'star' });
    assert.equal(star2.data.video.starred, false, '再点一次应该取消收藏');
  } finally { await s.cleanup(); }
});

test('不存在的记录：返回 404 且带可读提示', async () => {
  const s = await startApp();
  try {
    const r = await s.call('POST', '/api/videos/99999/action', { action: 'pause' });
    assert.equal(r.status, 404);
    assert.match(r.data.error, /记录不存在/);
    assert.ok(r.data.hint);
  } finally { await s.cleanup(); }
});

test('删除：默认保留文件，带 keepFile=0 才删', async () => {
  const s = await startApp();
  try {
    const add = await s.call('POST', '/api/videos', { urls: 'https://example.com/del' });
    const id = add.data.added[0].id;

    // 造一个假文件挂到记录上
    const fake = path.join(s.tmp, 'downloads', 'fake.mkv');
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.writeFileSync(fake, 'not a real video');
    s.app.repo.updateVideo(id, { status: 'done', file_path: fake });

    const keep = await s.call('DELETE', `/api/videos/${id}?keepFile=1`);
    assert.equal(keep.status, 200);
    assert.equal(keep.data.keptFile, true);
    assert.ok(fs.existsSync(fake), '默认必须保留磁盘文件');
    assert.equal(s.app.repo.getVideo(id), null, '记录要删掉');
  } finally { await s.cleanup(); }
});

test('批量动作：clearFinished 只删记录，绝不动文件', async () => {
  const s = await startApp();
  try {
    const add = await s.call('POST', '/api/videos', { urls: 'https://example.com/bulk1' });
    const id = add.data.added[0].id;
    const fake = path.join(s.tmp, 'downloads', 'keepme.mkv');
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.writeFileSync(fake, 'x');
    s.app.repo.updateVideo(id, { status: 'done', file_path: fake });

    const r = await s.call('POST', '/api/queue/action', { action: 'clearFinished' });
    assert.equal(r.status, 200);
    assert.equal(r.data.affected, 1);
    assert.equal(r.data.keptFiles, true, '响应要明确告诉调用方文件被保留了');
    assert.ok(fs.existsSync(fake), '文件必须还在');
    assert.equal(s.app.repo.listVideos({}).total, 0);
  } finally { await s.cleanup(); }
});

test('批量动作：未知动作被拒', async () => {
  const s = await startApp();
  try {
    const r = await s.call('POST', '/api/queue/action', { action: 'nuke' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /只能是/);
    assert.match(r.data.error, /pauseAll/);
  } finally { await s.cleanup(); }
});

test('库查询与 facets 都能用', async () => {
  const s = await startApp();
  try {
    await s.call('POST', '/api/videos', { urls: 'https://example.com/lib1' });

    const lib = await s.call('GET', '/api/library');
    assert.equal(lib.status, 200);
    assert.equal(lib.data.total, 1);
    assert.ok(Array.isArray(lib.data.rows));

    const fac = await s.call('GET', '/api/facets');
    assert.equal(fac.status, 200);
    assert.ok(fac.data.totals);
  } finally { await s.cleanup(); }
});

test('转码相关的接口与字段已彻底移除（用户要求去掉这个功能）', async () => {
  const s = await startApp();
  try {
    const add = await s.call('POST', '/api/videos', { urls: 'https://example.com/no-tc' });
    const id = add.data.added[0].id;

    // 接口不该再存在
    const tc = await s.call('POST', `/api/videos/${id}/transcode`, { preset: 'h264-1080p' });
    assert.equal(tc.status, 404, '转码接口应当已经没了');
    const presets = await s.call('GET', '/api/transcode-presets');
    assert.equal(presets.status, 404, '预设接口应当已经没了');

    // 出站数据里也不该再出现那几个字段
    const lib = await s.call('GET', '/api/library');
    const row = lib.data.rows[0];
    for (const k of ['transcoded_path', 'transcode_status', 'transcode_preset']) {
      assert.equal(Object.hasOwn(row, k), false, `响应里不该再有 ${k}`);
    }
  } finally { await s.cleanup(); }
});

test('队列快照包含活动任务与历史', async () => {
  const s = await startApp();
  try {
    await s.call('POST', '/api/videos', { urls: 'https://example.com/q1' });
    const r = await s.call('GET', '/api/queue');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.running));
    assert.ok(Array.isArray(r.data.history));
    assert.equal(typeof r.data.concurrency, 'number');
    assert.ok(r.data.counts, '要有已完成/失败/暂停/取消的计数');
  } finally { await s.cleanup(); }
});

test('未知路由 404，方法不匹配 405（两者要能区分）', async () => {
  const s = await startApp();
  try {
    const r404 = await s.call('GET', '/api/definitely-not-here');
    assert.equal(r404.status, 404);

    const r405 = await s.call('DELETE', '/api/health');
    assert.equal(r405.status, 405, '路径存在但方法不对应该是 405，不是 404');
    assert.match(r405.data.error, /DELETE/);
  } finally { await s.cleanup(); }
});

test('请求体不是合法 JSON 时返回 400 而不是 500', async () => {
  const s = await startApp();
  try {
    const res = await fetch(`${s.base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{这不是 JSON',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /JSON/);
  } finally { await s.cleanup(); }
});

test('静态资源：ES 模块用 text/javascript 提供（否则浏览器拒绝加载）', async () => {
  const s = await startApp();
  try {
    const r = await fetch(`${s.base}/static/app.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/, 'MIME 不对浏览器会拒绝当模块加载');

    const html = await fetch(`${s.base}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /type="module"/);
  } finally { await s.cleanup(); }
});

test('静态资源：目录穿越被拦住', async () => {
  const s = await startApp();
  try {
    const r = await fetch(`${s.base}/static/..%2f..%2fdata%2fvault.db`);
    assert.ok(r.status === 403 || r.status === 404, `穿越请求应该被拒，实际 ${r.status}`);
  } finally { await s.cleanup(); }
});

/**
 * 上一个测试只检查了 `/static/app.js` 一个文件。
 *
 * 但前端是 **10 个模块互相 import** 的图 —— 只要有**任何一个**模块
 * 没带对 MIME，或者某个相对 import 的路径写错，浏览器就是在那一处炸，
 * 而服务端和单元测试全都看不出来（历史上踩过：`Cannot use import statement
 * outside a module`，起因是 `src/web/package.json` 缺 `{"type":"module"}`）。
 *
 * 这条把整个模块图走一遍：**每个 .js 的 MIME** + **每条相对 import 都能取到**。
 * 走真实 HTTP，不碰文件系统 —— 因为浏览器就是走 HTTP 的。
 */
test('静态资源：整个前端模块图都能按模块加载（每个 MIME + 每条 import）', async () => {
  const s = await startApp();
  try {
    const webDir = path.join(APP_ROOT, 'src', 'web');
    const mods = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js')) mods.push(full);
      }
    }(webDir));

    assert.ok(mods.length >= 8, `前端模块数量不对，只找到 ${mods.length} 个`);

    let importsChecked = 0;
    for (const full of mods) {
      const rel = path.relative(webDir, full).replace(/\\/g, '/');
      const url = `${s.base}/static/${rel}`;

      const r = await fetch(url);
      assert.equal(r.status, 200, `${rel} 取不到（HTTP ${r.status}）`);
      assert.match(r.headers.get('content-type') || '', /javascript/,
        `${rel} 的 MIME 不是 javascript —— 浏览器会拒绝把它当模块加载`);

      // 每条**相对** import 都要真的能取到（裸包名不走 HTTP，这里不检查）
      const code = await r.text();
      for (const m of code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const resolved = new URL(m[1], `http://x/static/${rel}`).pathname;
        const rr = await fetch(s.base + resolved);
        assert.equal(rr.status, 200, `${rel} 里 import 的 ${m[1]}（${resolved}）取不到`);
        importsChecked += 1;
      }
    }
    assert.ok(importsChecked >= 15, `检查到的 import 太少（${importsChecked}），正则可能没匹配上`);
  } finally { await s.cleanup(); }
});

test('两个隔离实例互不干扰（并发起两个也不串数据）', async () => {
  const a = await startApp();
  const b = await startApp();
  try {
    await a.call('POST', '/api/videos', { urls: 'https://example.com/iso-a' });
    const la = await a.call('GET', '/api/library');
    const lb = await b.call('GET', '/api/library');
    assert.equal(la.data.total, 1);
    assert.equal(lb.data.total, 0, 'B 不该看到 A 的数据');
  } finally { await a.cleanup(); await b.cleanup(); }
});

// ---------------------------------------------------------------- 从网站找视频

/** 假 crawler：不联网，返回固定候选 */
function fakeCrawler({ items, delay = 0, error = null } = {}) {
  return {
    async analyzeSource() {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (error) throw error;
      return {
        path: 'html', title: null, site: 'x.com',
        items: items || [
          { url: 'https://x/video.aaa/1/1/one', title: 'one', duration_sec: 60, site_video_id: '1', thumb_url: null },
          { url: 'https://x/video.bbb/1/1/two', title: 'two', duration_sec: null, site_video_id: '2', thumb_url: null },
        ],
        paging: [{ label: '第 2 页', url: 'https://x/new/2' }],
        note: '该站没有列表解析器，已改用页面解析',
      };
    },
    stop() {},
  };
}

test('POST /api/crawl 缺 url 返回 400 而不是静默成功', async () => {
  const s = await startApp({ crawler: fakeCrawler() });
  try {
    const r = await s.call('POST', '/api/crawl', {});
    assert.equal(r.status, 400);
    assert.ok(r.data.error);
    assert.ok(r.data.hint, '要告诉用户下一步做什么');
  } finally { await s.cleanup(); }
});

test('POST /api/crawl 抓取成功返回 200 + runId，且候选已入库、带翻页信息', async () => {
  const s = await startApp({ crawler: fakeCrawler() });
  try {
    const r = await s.call('POST', '/api/crawl', { url: 'https://x/' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'done');
    assert.equal(r.data.path, 'html');
    assert.equal(r.data.itemCount, 2);
    assert.match(r.data.note, /解析器|页面/);
    assert.equal(r.data.paging.length, 1);
    assert.ok(r.data.runId >= 1);

    // 候选走单独的接口取（POST 响应里不含 items —— 两种状态同形）
    assert.equal(r.data.items, undefined, 'POST 响应不该塞进 whole items');

    const list = await s.call('GET', `/api/candidates?runId=${r.data.runId}`);
    assert.equal(list.data.total, 2);
    assert.equal(list.data.rows[0].title, 'one');
    assert.equal(list.data.rows[0].in_library, false);
    assert.equal(list.data.rows[1].duration_sec, null, '缺失时长是 null');
  } finally { await s.cleanup(); }
});

test('GET /api/crawl/:id 能查到状态（进程重启后的兜底也走这条路）', async () => {
  const s = await startApp({ crawler: fakeCrawler() });
  try {
    const start = await s.call('POST', '/api/crawl', { url: 'https://x/' });
    const got = await s.call('GET', `/api/crawl/${start.data.runId}`);
    assert.equal(got.status, 200);
    assert.equal(got.data.status, 'done');
    assert.equal(got.data.itemCount, 2);

    const missing = await s.call('GET', '/api/crawl/999999');
    assert.equal(missing.status, 404);
  } finally { await s.cleanup(); }
});

test('POST /api/crawl 抓取失败时返回 400/502 且带 hint，不是 500', async () => {
  const { AppError } = require('../../src/domain/errors');
  const s = await startApp({
    crawler: fakeCrawler({
      error: new AppError('目标站在限速（HTTP 429）—— 不是工具的问题', {
        kind: 'crawl-rate-limited', hint: '等几分钟再试。',
      }),
    }),
  });
  try {
    const r = await s.call('POST', '/api/crawl', { url: 'https://x/' });
    assert.ok(r.status === 502 || r.status === 400, `状态应是 400/502，实际 ${r.status}`);
    assert.match(r.data.error, /429|限速/);
    assert.ok(r.data.hint);
  } finally { await s.cleanup(); }
});

test('GET /api/candidates 支持 q / onlyNew 筛选', async () => {
  const s = await startApp({ crawler: fakeCrawler() });
  try {
    await s.call('POST', '/api/crawl', { url: 'https://x/' });
    assert.equal((await s.call('GET', '/api/candidates')).data.total, 2);
    assert.equal((await s.call('GET', '/api/candidates?q=one')).data.total, 1);
    assert.equal((await s.call('GET', '/api/candidates?q=nothing')).data.total, 0);
    assert.equal((await s.call('GET', '/api/candidates?onlyNew=1')).data.total, 2);
    assert.equal((await s.call('GET', '/api/candidates?limit=1')).data.rows.length, 1);
  } finally { await s.cleanup(); }
});

test('POST /api/candidates/action add 把候选真的送进下载队列，并标记 added', async () => {
  // ⚠️ 这条是 Review Focus 5 的钉子：候选入队必须走**和"粘链接"完全相同**的那条路，
  //    否则会绕过去重、归一化和 scheduler.kick()。
  const s = await startApp({ crawler: fakeCrawler() });
  try {
    await s.call('POST', '/api/crawl', { url: 'https://x/' });
    const list = await s.call('GET', '/api/candidates');
    const ids = list.data.rows.map((r) => r.id);

    const r = await s.call('POST', '/api/candidates/action', { action: 'add', ids });
    assert.equal(r.status, 200);
    assert.equal(r.data.added, 2);

    // 队列里真的多出这两条
    const lib = await s.call('GET', '/api/library');
    assert.equal(lib.data.total, 2, '候选应当真的进了视频库');

    // 候选被标记为已入队，并且刷新后在库标记为 true
    const after = await s.call('GET', '/api/candidates');
    assert.ok(after.data.rows.every((row) => row.added === true), '勾选过的要标记已入队');
    assert.ok(after.data.rows.every((row) => row.in_library === true), '入队后应标为已在库');
  } finally { await s.cleanup(); }
});

test('POST /api/candidates/action 参数不对时明确报错', async () => {
  const s = await startApp({ crawler: fakeCrawler() });
  try {
    await s.call('POST', '/api/crawl', { url: 'https://x/' });

    const noAction = await s.call('POST', '/api/candidates/action', { ids: [1] });
    assert.equal(noAction.status, 400);
    assert.match(noAction.data.error, /动作/);

    const badAction = await s.call('POST', '/api/candidates/action', { action: 'nuke', ids: [1] });
    assert.equal(badAction.status, 400);

    const noIds = await s.call('POST', '/api/candidates/action', { action: 'add', ids: [] });
    assert.equal(noIds.status, 400);
    assert.match(noIds.data.error, /选中/);

    const ghost = await s.call('POST', '/api/candidates/action', { action: 'add', ids: [999999] });
    assert.equal(ghost.status, 404);
  } finally { await s.cleanup(); }
});

test('慢爬取：超过等待窗口返回 202 + runId，候选随后仍会入库', async () => {
  const s = await startApp({
    crawler: fakeCrawler({ delay: 120 }),
    syncWaitMs: 20,          // 注入小值 —— 测试里绝不等真 20 秒
  });
  try {
    const r = await s.call('POST', '/api/crawl', { url: 'https://x/' });
    assert.equal(r.status, 202, '超过窗口就是 202');
    assert.equal(r.data.status, 'running');
    assert.ok(r.data.runId >= 1);
    assert.equal(r.data.items, undefined);

    // 等后台跑完，候选应当已经入库了（关掉浏览器也不影响）
    await new Promise((res) => setTimeout(res, 300));
    const list = await s.call('GET', `/api/candidates?runId=${r.data.runId}`);
    assert.equal(list.data.total, 2, '后台跑完的候选也要入库');
  } finally { await s.cleanup(); }
});

// ---------------------------------------------------------------- 库页分组

/** 灌几条带站点的记录（站点要能区分开），返回它们的 id */
async function seedSites(s, pairs) {
  const ids = [];
  for (const [url, site] of pairs) {
    await s.call('POST', '/api/videos', { urls: url });
    const lib = await s.call('GET', '/api/library');
    const row = lib.data.rows.find((r) => r.url === url);
    s.app.repo.updateVideo(row.id, { site, status: 'done' });
    ids.push(row.id);
  }
  return ids;
}

test('分组接口：按站点分段，每段的 rows 数量必须等于 count（不是当前页条数）', async () => {
  const s = await startApp();
  try {
    await seedSites(s, [
      ['https://x/a1', 'Youtube'], ['https://x/a2', 'Youtube'],
      ['https://x/b1', 'BiliBili'], ['https://x/c1', 'XVideos'], ['https://x/c2', 'XVideos'],
    ]);

    const r = await s.call('GET', '/api/library/grouped?by=site');
    assert.equal(r.status, 200);
    assert.equal(r.data.by, 'site');
    assert.equal(r.data.total, 5);
    assert.equal(r.data.truncated, false);
    assert.equal(r.data.cap, 2000);

    const names = r.data.groups.map((g) => g.name).sort();
    assert.deepEqual(names, ['BiliBili', 'XVideos', 'Youtube'], '三个站点各一段');
    assert.equal(r.data.groups.find((g) => g.name === 'Youtube').count, 2);
    assert.equal(r.data.groups.find((g) => g.name === 'XVideos').count, 2);
    assert.equal(r.data.groups.find((g) => g.name === 'BiliBili').count, 1);

    // 这条咬住"只把当前页分了组"那种实现
    for (const g of r.data.groups) {
      assert.equal(g.rows.length, g.count, `${g.name} 的 rows 数量应当等于 count`);
    }
  } finally { await s.cleanup(); }
});

test('分组接口：Review Focus 1 —— 站点名大小写不同要归并成一段', async () => {
  const s = await startApp();
  try {
    await seedSites(s, [
      ['https://x/y1', 'Youtube'], ['https://x/y2', 'youtube'], ['https://x/y3', 'YOUTUBE'],
    ]);
    const r = await s.call('GET', '/api/library/grouped?by=site');
    assert.equal(r.data.groups.length, 1,
      `三种写法必须归并成一段，实际 ${JSON.stringify(r.data.groups.map((g) => g.name))}`);
    assert.equal(r.data.groups[0].count, 3);
    // 显示名取"第一次出现"的写法，而默认排序是 created_desc（最新的排最前），
    // 所以这里**不能断言具体是哪个大小写** —— 那跟排序耦合，会变成脆测试。
    // 断言"它是三种写法之一"就够了：归并成功才是这条测试要钉的东西。
    assert.ok(['Youtube', 'youtube', 'YOUTUBE'].includes(r.data.groups[0].name),
      `显示名应当是三种写法之一，实际 ${r.data.groups[0].name}`);
  } finally { await s.cleanup(); }
});

test('分组接口：站点为空的记录归入「未标注站点」，不是消失', async () => {
  const s = await startApp();
  try {
    await s.call('POST', '/api/videos', { urls: 'https://x/nosite' });
    const r = await s.call('GET', '/api/library/grouped?by=site');
    assert.equal(r.data.total, 1, '不能因为没站点就把它丢了');
    assert.equal(r.data.groups.length, 1);
    assert.match(r.data.groups[0].name, /未标注/);
  } finally { await s.cleanup(); }
});

// ⚠️ 「未分组要有自己的段」与「一个视频同时在两个组里」这两条测试**移到 Task 3 一起做** ——
// 它们都要先调 POST /api/videos/group-action 才能造出场景，而那个接口是 Task 3 的产物。
// 放在这里会让 Task 2 停在"有 2 条红着"，看不出是自己坏了还是依赖没到。

// ---------------------------------------------------------------- 分组 CRUD 与批量操作

test('分组 CRUD：建、改名、换色、重名 409、不存在 404', async () => {
  const s = await startApp();
  try {
    const a = await s.call('POST', '/api/groups', { name: '待看', color: 'amber' });
    assert.equal(a.status, 200);
    assert.ok(a.data.id > 0);
    assert.equal(a.data.count, 0);

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
    assert.equal(list.status, 200);
    assert.equal(list.data.groups.length, 1, 'GET /api/groups 必须返回列表，不能被 :id 吃掉');
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

    assert.equal((await s.call('GET', '/api/library')).data.total, 1, 'detach 不能删视频');
    assert.equal((await s.call('GET', '/api/groups')).data.groups.length, 0);
  } finally { await s.cleanup(); }
});

test('分组 CRUD：mode 不合法时 400 并说明两种模式的差别', async () => {
  const s = await startApp();
  try {
    const g = await s.call('POST', '/api/groups', { name: '待看' });
    const r = await s.call('DELETE', `/api/groups/${g.data.id}?mode=nuke`);
    assert.equal(r.status, 400);
    assert.match(r.data.hint || '', /detach/);
  } finally { await s.cleanup(); }
});

test('分组 CRUD：purge 删库记录但磁盘文件保留', async () => {
  const s = await startApp();
  try {
    await s.call('POST', '/api/videos', { urls: 'https://x/1' });
    const lib = await s.call('GET', '/api/library');
    const id = lib.data.rows[0].id;
    const file = path.join(s.tmp, 'downloads', 'keep.mp4');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'bytes');
    s.app.repo.updateVideo(id, { file_path: file, status: 'done' });

    const g = await s.call('POST', '/api/groups', { name: '待看' });
    await s.call('POST', '/api/videos/group-action', { ids: [id], add: [g.data.id] });

    const del = await s.call('DELETE', `/api/groups/${g.data.id}?mode=purge`);
    assert.equal(del.data.mode, 'purge');
    assert.equal(del.data.removedVideos, 1);
    assert.equal((await s.call('GET', '/api/library')).data.total, 0, '库记录要没了');
    assert.ok(fs.existsSync(file), '⚠️ purge 绝不能删磁盘文件');
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
    assert.ok(r.data.errors[0].reason, 'errors 里要有可读的原因');
  } finally { await s.cleanup(); }
});

test('批量入组：分组不存在时如实报错，不是静默成功', async () => {
  const s = await startApp();
  try {
    await s.call('POST', '/api/videos', { urls: 'https://x/1' });
    const id = (await s.call('GET', '/api/library')).data.rows[0].id;
    const r = await s.call('POST', '/api/videos/group-action', { ids: [id], add: [999999] });
    assert.equal(r.status, 200);
    assert.equal(r.data.added, 0);
    assert.ok(r.data.errors.some((x) => /分组/.test(x.reason)), '要说清是分组没了');
  } finally { await s.cleanup(); }
});

test('批量入组：既没给 add 也没给 remove 时 400', async () => {
  const s = await startApp();
  try {
    const r = await s.call('POST', '/api/videos/group-action', { ids: [1] });
    assert.equal(r.status, 400);
    assert.ok(r.data.hint);
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
    assert.ok((await s.call('GET', '/api/library')).data.rows.every((r) => r.starred === true),
      '两条都要变成已收藏');

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

test('批量收藏：id 全不存在时 affected=0，不报错', async () => {
  const s = await startApp();
  try {
    const r = await s.call('POST', '/api/videos/bulk-action', { ids: [999999], action: 'star' });
    assert.equal(r.status, 200);
    assert.equal(r.data.affected, 0);
  } finally { await s.cleanup(); }
});

// ---------------------------------------------------------------- Task 3 补做的两条（依赖 group-action）

test('分组接口：按自定义分组 —— 未分组要有自己的段（Review Focus 3）', async () => {
  const s = await startApp();
  try {
    const ids = await seedSites(s, [
      ['https://x/1', 'Youtube'], ['https://x/2', 'Youtube'], ['https://x/3', 'Youtube'],
    ]);
    const g = await s.call('POST', '/api/groups', { name: '待看', color: 'amber' });
    await s.call('POST', '/api/videos/group-action', { ids: [ids[0]], add: [g.data.id] });

    const r = await s.call('GET', '/api/library/grouped?by=group');
    const keys = r.data.groups.map((x) => x.key);
    assert.ok(keys.includes('__ungrouped__'), '未分组必须单独成段');
    assert.equal(r.data.groups.find((x) => x.key === String(g.data.id)).count, 1);
    assert.equal(r.data.groups.find((x) => x.key === '__ungrouped__').count, 2);
  } finally { await s.cleanup(); }
});

test('分组接口：一个视频同时在两个组里时，两组都要有它', async () => {
  const s = await startApp();
  try {
    const ids = await seedSites(s, [['https://x/1', 'Youtube']]);
    const g1 = await s.call('POST', '/api/groups', { name: '待看' });
    const g2 = await s.call('POST', '/api/groups', { name: '教程' });
    await s.call('POST', '/api/videos/group-action', { ids, add: [g1.data.id, g2.data.id] });

    const r = await s.call('GET', '/api/library/grouped?by=group');
    assert.equal(r.data.groups.find((g) => g.name === '待看').count, 1);
    assert.equal(r.data.groups.find((g) => g.name === '教程').count, 1);
    assert.ok(!r.data.groups.some((g) => g.key === '__ungrouped__'), '没有未分组时不该造这个段');
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
    await seedSites(s, [['https://x/a', 'Youtube'], ['https://x/b', 'BiliBili']]);
    const r = await s.call('GET', '/api/library/grouped?by=site&site=Youtube');
    assert.equal(r.data.groups.length, 1);
    assert.equal(r.data.groups[0].name, 'Youtube');
    assert.equal(r.data.total, 1);
  } finally { await s.cleanup(); }
});

test('分组接口：by 不合法时 400，且 hint 要列出可用值', async () => {
  const s = await startApp();
  try {
    const r = await s.call('GET', '/api/library/grouped?by=nonsense');
    assert.equal(r.status, 400);
    assert.match(r.data.hint || '', /site/);
  } finally { await s.cleanup(); }
});

test('分组接口：by 缺省时按站点分段（不是报错）', async () => {
  const s = await startApp();
  try {
    await seedSites(s, [['https://x/a', 'Youtube']]);
    const r = await s.call('GET', '/api/library/grouped');
    assert.equal(r.status, 200);
    assert.equal(r.data.by, 'site');
    assert.equal(r.data.groups.length, 1);
  } finally { await s.cleanup(); }
});

// ---------------------------------------------------------------- 只看某个分组

test('只看某个分组：/api/library?groupId= 只返回那一组的成员', async () => {
  const s = await startApp();
  try {
    const ids = await seedSites(s, [
      ['https://x/1', 'Youtube'], ['https://x/2', 'Youtube'], ['https://x/3', 'Youtube'],
    ]);
    const g = await s.call('POST', '/api/groups', { name: '待看' });
    await s.call('POST', '/api/videos/group-action', { ids: [ids[0], ids[2]], add: [g.data.id] });

    const r = await s.call('GET', `/api/library?groupId=${g.data.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 2, '只该有这一组的 2 条');
    assert.deepEqual(r.data.rows.map((x) => x.id).sort(), [ids[0], ids[2]].sort());
  } finally { await s.cleanup(); }
});

test('只看某个分组：和分组展示能叠加（筛选先于分组）', async () => {
  const s = await startApp();
  try {
    const ids = await seedSites(s, [
      ['https://x/1', 'Youtube'], ['https://x/2', 'BiliBili'],
      ['https://x/3', 'Youtube'], ['https://x/4', 'Youtube'],
    ]);
    const g = await s.call('POST', '/api/groups', { name: '待看' });
    const other = await s.call('POST', '/api/groups', { name: '别的组' });
    // ⚠️ 关键：第四条**只属于另一个组**。如果筛选没生效，它就会漏进来 ——
    //    第一版测试把全部视频都放进了同一个组，那种场景下"筛没筛"结果一样，
    //    根本区分不出来（测试写弱了，不是代码对了）。
    await s.call('POST', '/api/videos/group-action', { ids: [ids[0], ids[1], ids[2]], add: [g.data.id] });
    await s.call('POST', '/api/videos/group-action', { ids: [ids[3]], add: [other.data.id] });

    const r = await s.call('GET', `/api/library/grouped?by=site&groupId=${g.data.id}`);
    assert.equal(r.data.total, 3, '只看这一组时 total 是组内条数（第四条不该算进来）');
    const names = r.data.groups.map((x) => x.name).sort();
    assert.deepEqual(names, ['BiliBili', 'Youtube'], '按站点分段后仍只有组内成员的段');
    assert.equal(r.data.groups.find((x) => x.name === 'Youtube').count, 2);
    assert.equal(r.data.groups.find((x) => x.name === 'BiliBili').count, 1);
    const allIds = r.data.groups.flatMap((x) => x.rows.map((v) => v.id));
    assert.ok(!allIds.includes(ids[3]), '别的组的成员绝不能出现');
  } finally { await s.cleanup(); }
});

test('只看某个分组：组不存在时返回空列表，不是报错', async () => {
  const s = await startApp();
  try {
    await seedSites(s, [['https://x/1', 'Youtube']]);
    const r = await s.call('GET', '/api/library?groupId=999999');
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 0, '不存在的分组 = 没有成员，不该 500');
  } finally { await s.cleanup(); }
});

test('只看某个分组：groupId 不是数字时要 400，而不是当成没传', async () => {
  const s = await startApp();
  try {
    const r = await s.call('GET', '/api/library?groupId=abc');
    assert.equal(r.status, 400, '不能静默忽略一个明显写错的筛选条件');
    assert.ok(r.data.hint, '要告诉用户这个参数该是什么');
  } finally { await s.cleanup(); }
});
