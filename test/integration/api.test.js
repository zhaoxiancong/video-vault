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

/** 起一个隔离实例，返回 base URL 和清理函数 */
async function startApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-api-'));
  const app = createApp({
    data: path.join(tmp, 'data'),
    downloads: path.join(tmp, 'downloads'),
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

test('转码：未完成的任务被拒绝', async () => {
  const s = await startApp();
  try {
    const add = await s.call('POST', '/api/videos', { urls: 'https://example.com/tc' });
    const id = add.data.added[0].id;
    const r = await s.call('POST', `/api/videos/${id}/transcode`, { preset: 'h264-1080p' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /已下载完成/);
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

test('库查询、facets、转码预设都能用', async () => {
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

    const presets = await s.call('GET', '/api/transcode-presets');
    assert.equal(presets.status, 200);
    assert.ok(presets.data.some((p) => p.key === 'h264-1080p'));
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
