/**
 * 前端"真的跑起来"测试 —— 用 DOM 垫片，不需要浏览器。
 *
 * ══════════════════════════════════════════════════════════════════
 *  这一块之前**从来没被执行过**：
 *
 *   · test/ui/smoke.js 要真实 Chrome，受限沙箱里起不来（crashpad 被拒）
 *   · tools/check-frontend.js 只是静态检查（#id 对不对、import 路径）
 *
 *  静态检查挡不住这三类问题，而它们全是"模块一加载就炸"或"一点就炸"：
 *     1. 模块级代码在 import 时跑（`$('#tabs').addEventListener(...)`），
 *        某个 #id 拼错 → 运行时 "Cannot read properties of null"
 *     2. 事件处理器里读了不存在的属性
 *     3. 渲染函数拼出来的节点结构不对
 *
 *  这个文件把前端真的 import 进来、真的点几下，挡住上面三类。
 *  它**替代不了**真实浏览器（没有布局、没有 CSS、没有渲染），
 *  需要那些的测试请用 test/ui/smoke.js。
 * ══════════════════════════════════════════════════════════════════
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installDom, parseHTML } from '../helpers/dom-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..', '..', 'src', 'web');
const HTML = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

/**
 * 用**绝对 file URL** 导入前端入口。
 *
 * ⚠️ 别用相对路径：这个测试文件在 test/integration/ 下，
 *    相对路径要 `../../../src/web/app.js` 才对（三层），很容易数错。
 *    `?v=...` 是必需的 —— ES 模块有缓存，而前端的模块级代码只跑一次；
 *    不破坏缓存的话，第二个用例拿到的是"已经初始化过"的模块，测不到东西。
 */
const appUrl = (bust) => `${new URL(`file:///${path.join(WEB, 'app.js').replace(/\\/g, '/')}`).href}?v=${bust}`;

/** 起一个装好 DOM 的环境，并把前端入口 import 进来 */
async function bootFrontend({ responses = {} } = {}) {
  const dom = installDom({ html: HTML, responses });
  const mod = await import(appUrl(`${Date.now()}-${Math.random()}`));
  // 前端是 deferred 语义；垫片里 setTimeout(fn,0) 的初始化要给它一次机会
  await new Promise((r) => setTimeout(r, 10));
  return { dom, mod };
}

/**
 * 一组默认的假响应。
 *
 * ⚠️ 队列数据要**同时**给 fetch 和 SSE —— 前端启动时会 GET /api/queue，
 *    而 SSE 也会推 queue 快照，两者都往 `state.queue` 里写。
 *    只给 SSE 的话，那个 GET 的 promise 后落地、把 state 覆盖成空，
 *    任务就"凭空消失"了。那不是 bug，是**测试假设错了**：
 *    真实环境里两者本来就该一致。
 *    第一版测试只喂 SSE，于是时好时坏（取决于哪个先落地）——
 *    这类"看起来像竞态的测试 bug"最费时间，直接两边都给就干净了。
 */
function fakeResponses({ queue = {}, health = {} } = {}) {
  const baseQueue = { active: 0, concurrency: 2, running: [], history: [], counts: {}, ...queue };
  const baseHealth = {
    ok: true,
    engines: {
      ytdlp: { ok: true, version: '2026.08.19', path: 'x' },
      ffmpeg: { ok: true, version: 'ffmpeg n9', path: 'y' },
    },
    settings: { concurrency: 2, rateLimitMB: 0, downloadDir: 'D:\\dl' },
    downloads: 'D:\\dl',
    version: '2.0.0',
    queuedInterrupted: 0,
    ...health,
  };
  return {
    'GET /api/health': baseHealth,
    'GET /api/queue': baseQueue,
    'GET /api/library': { total: 0, rows: [] },
    'GET /api/facets': { sites: [], uploaders: [], statuses: [], totals: {} },
    'GET /api/transcode-presets': [],
  };
}

test('前端入口能在"类浏览器"环境里跑完，不抛异常', async () => {
  const dom = installDom({ html: HTML });
  try {
    await assert.doesNotReject(
      import(appUrl(Date.now())),
      'app.js 在 import 阶段就抛异常 —— 多半是某个 #id 找不到',
    );
    await new Promise((r) => setTimeout(r, 10));
  } finally { dom.restore(); }
});

test('index.html 解析出的结构完整（三个标签页 / 三个视图 / 关键容器）', () => {
  const doc = new (globalThis.document?.constructor || Object)();
  void doc;
  const parsed = parseHTML(HTML);
  const root = { _walk: () => {}, querySelectorAll: () => [] };
  // 用垫片自己的查询能力：把解析结果挂到一个临时 document 上
  const dom = installDom({ html: HTML });
  try {
    assert.equal(globalThis.document.querySelectorAll('.tab').length, 3, '应有 3 个标签页');
    assert.equal(globalThis.document.querySelectorAll('.view').length, 3, '应有 3 个视图');
    for (const id of ['tabs', 'urlBox', 'btnAdd', 'libGrid', 'libList',
      'setConcurrency', 'btnSaveSettings', 'btnTestCookies',
      'playerModal', 'player', 'toasts', 'modal', 'engineDot', 'engineText']) {
      assert.ok(globalThis.document.getElementById(id), `index.html 里缺少 #${id}`);
    }
    void root; void parsed;
  } finally { dom.restore(); }
});

test('boot 之后：引擎状态文字被更新（说明 /api/health 请求发出并被应用）', async () => {
  const { dom } = await bootFrontend({
    responses: {
      'GET /api/health': {
        ok: true,
        engines: {
          ytdlp: { ok: true, version: '2026.08.19', path: 'x' },
          ffmpeg: { ok: true, version: 'ffmpeg version n9', path: 'y' },
        },
        settings: { concurrency: 2, rateLimitMB: 0, downloadDir: 'D:\\dl' },
        downloads: 'D:\\dl',
        version: '2.0.0',
        queuedInterrupted: 0,
      },
    },
  });
  try {
    const calls = dom.calls.map((c) => `${c.method} ${c.url}`);
    assert.ok(calls.some((c) => c.startsWith('GET /api/health')), `应该请求过 /api/health，实际：${calls.join(', ')}`);

    // 引擎就绪时顶栏文案要变（不通的话文案是"检查引擎…"或"无法连接服务"）
    const text = globalThis.document.getElementById('engineText').textContent;
    assert.notEqual(text, '检查引擎…', 'boot 之后引擎状态应该已经更新');
  } finally { dom.restore(); }
});

test('点标签页能切换视图（事件委托 + classList 真的работает）', async () => {
  const { dom } = await bootFrontend({ responses: { 'GET /api/health': { ok: true, engines: { ytdlp: { ok: true, version: '1' }, ffmpeg: { ok: true, version: '1' } }, settings: {}, downloads: '', queuedInterrupted: 0 } } });
  try {
    const tabs = globalThis.document.querySelectorAll('.tab');
    const libTab = tabs.find((t) => t.dataset.view === 'library');
    assert.ok(libTab, '找不到「我的库」标签');

    libTab.click();
    await new Promise((r) => setTimeout(r, 10));

    const libView = globalThis.document.getElementById('view-library');
    const addView = globalThis.document.getElementById('view-add');
    assert.ok(libView.classList.contains('is-active'), '库视图应该被激活');
    assert.ok(!addView.classList.contains('is-active'), '添加视图应该被取消激活');
    assert.ok(libTab.classList.contains('is-active'), '标签自身也要标记为激活');
  } finally { dom.restore(); }
});

test('「仅音频」切换会隐藏清晰度字段（一个真实的条件渲染）', async () => {
  const { dom } = await bootFrontend({ responses: fakeResponses() });
  try {
    const kind = globalThis.document.getElementById('optKind');
    const quality = globalThis.document.getElementById('fieldQuality');
    assert.ok(kind && quality, '找不到 #optKind / #fieldQuality');

    // 先确认垫片本身是通的：直接赋值应该能被读到
    quality.style.display = 'probe';
    assert.equal(quality.style.display, 'probe',
      '垫片的 style 不接受直接赋值 —— 那测试就测不了这个行为');
    quality.style.display = '';

    kind.value = 'audio';
    kind.dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(quality.style.display, 'none',
      `选「仅音频」后应隐藏清晰度（实际 ${JSON.stringify(quality.style.display)}，`
      + `监听器 ${kind._listeners.get('change')?.size ?? 0} 个）`);

    kind.value = 'video';
    kind.dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 5));
    assert.notEqual(quality.style.display, 'none', '切回视频后应重新显示');
  } finally { dom.restore(); }
});

test('空链接点「加入下载队列」不会发请求，也不会崩', async () => {
  const { dom } = await bootFrontend({ responses: { 'GET /api/health': { ok: true, engines: { ytdlp: { ok: true, version: '1' }, ffmpeg: { ok: true, version: '1' } }, settings: {}, downloads: '', queuedInterrupted: 0 } } });
  try {
    const before = dom.calls.length;
    globalThis.document.getElementById('urlBox').value = '   \n  ';
    globalThis.document.getElementById('btnAdd').click();
    await new Promise((r) => setTimeout(r, 20));

    const posted = dom.calls.slice(before).filter((c) => c.method === 'POST' && c.url === '/api/videos');
    assert.equal(posted.length, 0, '没有有效链接时不该发 POST');
  } finally { dom.restore(); }
});

test('队列渲染：SSE 推来一个任务，界面上真的出现进度条', async () => {
  const task = {
    id: 42, title: '测试视频', status: 'downloading', progress: 37.5,
    speed: 1048576, eta: 30, kind: 'video', site: 'Youtube', uploader: 'someone',
  };
  const { dom } = await bootFrontend({
    responses: fakeResponses({ queue: { active: 1, running: [task] } }),
  });
  try {
    const es = dom.streams[0];
    assert.ok(es, '前端应该建立了 SSE 连接');
    assert.equal(es.url, '/api/stream');

    // 服务端再推一次（和 GET 的内容一致，两边都不落空）
    es.emit('queue', { active: 1, concurrency: 2, running: [task] });
    await new Promise((r) => setTimeout(r, 20));

    const item = globalThis.document.querySelector('#queueList [data-id="42"]');
    assert.ok(item, '队列里应该出现这条任务');
    assert.match(item.querySelector('.qname').textContent, /测试视频/);

    const bar = item.querySelector('[data-role=bar]');
    assert.equal(bar.style.width, '37.5%', `进度条宽度应反映进度，实际 ${bar.style.width}`);
    assert.match(item.querySelector('[data-role=meta]').textContent, /37\.5%/);

    // 队列非空时"没有进行中的任务"的提示要消失
    assert.equal(globalThis.document.getElementById('queueEmpty').hidden, true);
  } finally { dom.restore(); }
});

test('进度更新走"打补丁"而不是重建节点（避免进度条闪烁）', async () => {
  const task = { id: 7, title: 'T', status: 'downloading', progress: 10, kind: 'video' };
  const { dom } = await bootFrontend({
    responses: fakeResponses({ queue: { active: 1, running: [task] } }),
  });
  try {
    const es = dom.streams[0];
    es.emit('queue', { active: 1, concurrency: 2, running: [task] });
    await new Promise((r) => setTimeout(r, 20));

    const first = globalThis.document.querySelector('#queueList [data-id="7"]');
    assert.ok(first, '应该先渲染出这条任务');

    // 同一任务再来一帧进度
    es.emit('progress', { ...task, progress: 55 });
    await new Promise((r) => setTimeout(r, 20));

    const second = globalThis.document.querySelector('#queueList [data-id="7"]');
    assert.equal(second, first, '应该复用同一个 DOM 节点（重建会让进度条闪烁、按钮丢焦点）');
    assert.equal(second.querySelector('[data-role=bar]').style.width, '55%', '进度要更新到新值');
  } finally { dom.restore(); }
});

test('「最近任务」面板默认收起，点一下能展开（状态还会持久化）', async () => {
  const { dom } = await bootFrontend({
    responses: fakeResponses({
      queue: {
        counts: { done: 3, failed: 1 },
        history: [{ id: 1, title: '下完的片子', status: 'done', file_size: 1048576, container: 'mkv' }],
      },
    }),
  });
  try {
    const list = globalThis.document.getElementById('historyList');
    const toggle = globalThis.document.getElementById('btnHistoryToggle');

    assert.equal(toggle.textContent, '展开', '默认应该是收起状态');
    assert.equal(list.hidden, true, '默认列表应该隐藏');

    toggle.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(toggle.textContent, '收起');
    assert.equal(list.hidden, false, '点一下应该展开');

    // 展开状态要写进 localStorage（刷新不丢）
    const saved = globalThis.localStorage.getItem('videoVault.prefs.v2');
    assert.ok(saved && JSON.parse(saved).historyOpen === true, '展开状态应该被持久化');
  } finally { dom.restore(); }
});

test('统计数字：已完成/失败/暂停/取消的计数会渲染出来', async () => {
  const { dom } = await bootFrontend({
    responses: fakeResponses({ queue: { counts: { done: 5, failed: 2, paused: 1, canceled: 3 } } }),
  });
  try {
    const summary = globalThis.document.getElementById('historySummary').textContent;
    assert.match(summary, /完成\s*5/, `统计里应有"完成 5"，实际：${summary}`);
    assert.match(summary, /失败\s*2/);
    assert.match(summary, /暂停\s*1/);
    assert.match(summary, /取消\s*3/);

    // 标签页上的库数量
    assert.equal(globalThis.document.getElementById('tabLibCount').textContent, '5');
  } finally { dom.restore(); }
});

test('渲染出来的内容不含未转义尖括号（前端全部走 textContent）', async () => {
  const nasty = '<img src=x onerror=alert(1)>危险标题';
  const { dom } = await bootFrontend({
    responses: fakeResponses({
      queue: { active: 1, running: [{ id: 9, title: nasty, status: 'downloading', progress: 1 }] },
    }),
  });
  try {
    const es = dom.streams[0];
    es.emit('queue', { active: 1, concurrency: 2, running: [{ id: 9, title: nasty, status: 'downloading', progress: 1 }] });
    await new Promise((r) => setTimeout(r, 20));

    const node = globalThis.document.querySelector('#queueList [data-id="9"] .qname');
    assert.ok(node, '应该渲染出这条任务');
    // textContent 原样保留尖括号 = 安全；被解析成子元素就说明走了 innerHTML
    assert.equal(node.textContent, nasty);
    assert.equal(node.children.length, 0, '标题不该被解析成子元素（那意味着用了 innerHTML，存在注入风险）');
  } finally { dom.restore(); }
});

/**
 * index.html 声明的图标文件必须真的存在。
 *
 * 为什么单独钉一条：图标缺失的表现**不是**页面坏掉，而是浏览器悄悄去要
 * `/favicon.ico` 拿到 404、控制台多一条 error —— 只有 `test/ui/smoke.js`
 * 会因此失败，而它要真实 Chrome，受限会话里跑不起来。所以这个坑能在
 * 代码里躺很久（实测躺了至少一个提交）。这条纯静态检查不需要浏览器。
 *
 * 路由映射：`/static/*` → `src/web/*`（见 src/http/server.js 与 infra/config.js）。
 */
test('index.html 声明的图标文件真实存在（缺失会让浏览器回退到 404 的 /favicon.ico）', () => {
  const declared = [...HTML.matchAll(/<link\b[^>]*>/g)]
    .filter((m) => /rel=["'](?:icon|shortcut icon|apple-touch-icon)["']/.test(m[0]))
    .map((m) => (m[0].match(/href=["']([^"']+)["']/) || [])[1])
    .filter((href) => href && href.startsWith('/static/'));

  assert.ok(declared.length > 0,
    'index.html 没有声明任何图标 —— 浏览器会自己去要 /favicon.ico 并拿到 404');

  const missing = declared.filter((href) => !fs.existsSync(
    path.join(WEB, ...href.slice('/static/'.length).split('?')[0].split('/')),
  ));
  assert.deepEqual(missing, [], `声明了但磁盘上没有：${missing.join(', ')}`);
});

/**
 * 上面这些用例能跑的前提是"垫片提供的浏览器 API 跟前端用到的一致"。
 * 哪天前端开始用一个垫片没实现的 API（比如 matchMedia、IntersectionObserver），
 * 表现会是**一堆看起来莫名其妙的失败**。这两个用例把那个前提显式钉住，
 * 让报错直接指向"少了哪个 API"，而不是让人去猜。
 */
test('垫片覆盖了前端实际用到的全局 API', () => {
  const required = [
    'document', 'localStorage', 'fetch', 'EventSource', 'navigator', 'Node',
    'requestAnimationFrame', 'setTimeout', 'setInterval', 'URLSearchParams',
  ];
  const dom = installDom({ html: HTML });
  try {
    const missing = required.filter((k) => globalThis[k] === undefined);
    assert.deepEqual(missing, [], `垫片缺少这些全局：${missing.join(', ')}`);

    for (const m of ['createElement', 'createTextNode', 'getElementById',
      'querySelector', 'querySelectorAll', 'addEventListener']) {
      assert.equal(typeof globalThis.document[m], 'function', `document.${m} 不是函数`);
    }
    assert.ok(globalThis.document.body, 'document.body 应该有值');
  } finally { dom.restore(); }
});

test('垫片：元素该有的常用方法都在（缺一个就会产生一堆假失败）', () => {
  const dom = installDom({ html: HTML });
  try {
    const el = globalThis.document.getElementById('urlBox');
    for (const m of ['addEventListener', 'removeEventListener', 'dispatchEvent', 'click',
      'append', 'appendChild', 'remove', 'removeChild', 'replaceWith',
      'setAttribute', 'getAttribute', 'hasAttribute', 'removeAttribute',
      'querySelector', 'querySelectorAll', 'closest', 'contains',
      'focus', 'blur', 'insertAdjacentHTML', 'getBoundingClientRect']) {
      assert.equal(typeof el[m], 'function', `元素缺少 ${m}()`);
    }
    assert.ok(el.classList, 'classList');
    assert.ok(el.style, 'style');
    assert.ok(el.dataset, 'dataset');
    for (const m of ['add', 'remove', 'contains', 'toggle']) {
      assert.equal(typeof el.classList[m], 'function', `classList 缺少 ${m}()`);
    }

    // style 必须能接受**直接赋值**（前端写的是 style.display = 'none'）
    el.style.display = 'none';
    assert.equal(el.style.display, 'none', 'style 不接受直接赋值 —— 相关行为就测不了');
    el.style.display = '';
  } finally { dom.restore(); }
});
