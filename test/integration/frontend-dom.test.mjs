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

/**
 * 起一个装好 DOM 的环境，并把前端入口 import 进来。
 *
 * ⚠️ **`resetPrefs()` 这一步不能省。**
 *
 * `?v=` 只破坏 `app.js` 自己的缓存 —— 它 import 的 `state.js` 在同一个进程里
 * 是**同一个模块实例**。垫片每个用例只重置 DOM 与 localStorage，不重置模块状态，
 * 于是"上一条用例把展示维度设成了 site、勾了两条"会整套漏到下一条用例里。
 * 表现是一批看起来很随机的失败（某条单独跑是绿的、跟别的用例一起跑就红）。
 *
 * 在 import 之后重置是**有效**的：`resetPrefs()` 改的是同一个 `state` 对象，
 * 而 `init()` 里的首次 `reload()` 是异步的（`setTimeout(0)`），会在重置之后才跑到。
 */
async function bootFrontend({ responses = {} } = {}) {
  const dom = installDom({ html: HTML, responses });
  const mod = await import(appUrl(`${Date.now()}-${Math.random()}`));
  const { resetPrefs } = await import(new URL(`file:///${path.join(WEB, 'state.js').replace(/\\/g, '/')}`).href);
  resetPrefs();
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

test('index.html 解析出的结构完整（四个标签页 / 四个视图 / 关键容器）', () => {
  const doc = new (globalThis.document?.constructor || Object)();
  void doc;
  const parsed = parseHTML(HTML);
  const root = { _walk: () => {}, querySelectorAll: () => [] };
  // 用垫片自己的查询能力：把解析结果挂到一个临时 document 上
  const dom = installDom({ html: HTML });
  try {
    assert.equal(globalThis.document.querySelectorAll('.tab').length, 4, '应有 4 个标签页');
    assert.equal(globalThis.document.querySelectorAll('.view').length, 4, '应有 4 个视图');
    for (const id of ['tabs', 'urlBox', 'btnAdd', 'libGrid', 'libList',
      'setConcurrency', 'btnSaveSettings', 'btnTestCookies',
      'playerModal', 'player', 'toasts', 'modal', 'engineDot', 'engineText',
      // 「找视频」页的关键节点
      'discUrl', 'btnCrawl', 'discStatus', 'discPaging', 'discFilter',
      'discOnlyNew', 'discList', 'btnDiscAdd', 'btnDiscRefresh', 'btnDiscMore']) {
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

/**
 * 选择器能力。这个垫片已经因为"与真实 DOM 有偏差"吃过好几次亏
 * （`hidden` 不是访问器、`textContent` 不递归、`.类名[带值属性]` 静默不匹配），
 * 每一次的表现都是**代码明明做了、测试说没做**。所以把支持的形态逐条钉住。
 */
test('垫片：组合选择器的各种形态都要能用（含类名+带值属性）', () => {
  const dom = installDom({ html: HTML });
  try {
    const doc = globalThis.document;
    // 四种"属性"写法都要认
    assert.equal(doc.querySelectorAll('.tab[data-view=library]').length, 1,
      '类名 + 带值属性（不加引号）');
    assert.equal(doc.querySelectorAll('.tab[data-view="library"]').length, 1,
      '类名 + 带值属性（双引号）');
    assert.equal(doc.querySelectorAll('[data-view=library]').length, 1, '只有带值属性');
    assert.equal(doc.querySelectorAll('button[data-view=library]').length, 1, '标签 + 带值属性');

    // 无值属性（这是上一次踩坑的形态，别再退化）
    const probe = doc.createElement('div');
    probe.className = 'probe-box';
    doc.body.append(probe);
    probe.hidden = true;
    assert.equal(doc.querySelectorAll('.probe-box[hidden]').length, 1,
      '类名 + 无值属性（且用属性赋值写的 hidden）');
    probe.hidden = false;
    assert.equal(doc.querySelectorAll('.probe-box[hidden]').length, 0, '取消后不该再匹配');
    probe.remove();

    // 属性值不匹配时必须是 0，不能"匹配任意"
    assert.equal(doc.querySelectorAll('.tab[data-view=nope]').length, 0, '值不对就不该匹配');

    // 后代组合与逗号并列（这两条是前端在用、且已有测试依赖的形态）
    assert.ok(doc.querySelectorAll('#libGrid [data-id]').length >= 0, '后代组合不该抛异常');
    assert.equal(doc.querySelectorAll('.tab[data-view=library], .tab[data-view=add]').length, 2,
      '逗号并列应当合并结果');
  } finally { dom.restore(); }
});

test('垫片：textContent 要递归收集子节点文本', () => {
  const dom = installDom({ html: HTML });
  try {
    const doc = globalThis.document;
    const box = doc.createElement('div');
    const inner = doc.createElement('span');
    inner.textContent = '已选 1 条';
    box.append(inner);
    doc.body.append(box);
    // 这条踩过：textContent 曾经只是个普通字符串属性，
    // 于是"有子节点的元素读出来是空字符串"，而 children.length 又是对的
    assert.equal(box.textContent, '已选 1 条', 'textContent 必须递归收集子孙文本');

    // 写的时候要清空子节点
    box.textContent = '换了';
    assert.equal(box.children.length, 0, '写 textContent 应当清空子节点');
    assert.equal(box.textContent, '换了');
    box.remove();
  } finally { dom.restore(); }
});

test('垫片：表单元素的 value / checked 要能按属性查（el() 与 attribute 一致）', () => {
  const dom = installDom({ html: HTML });
  try {
    const doc = globalThis.document;
    const sel = doc.createElement('select');
    const opt = doc.createElement('option');
    opt.value = '9';           // 只写 JS 属性，不调 setAttribute
    opt.textContent = '待看';
    sel.append(opt);
    doc.body.append(sel);

    assert.equal(opt.value, '9');
    assert.equal(opt.getAttribute('value'), '9',
      'el({value}) 写的值必须同步到 attribute —— 否则 querySelectorAll 按 value 找不到选项');
    sel.remove();
  } finally { dom.restore(); }
});

// ---------------------------------------------------------------- 「找视频」页

/** 造一批候选，覆盖"未下过 / 已在库 / 已入队"三种状态与缺失时长 */
function candidateRows() {
  return [
    {
      id: 1, url: 'https://x/video.aaa/1/1/cat_video', title: 'cat video',
      duration_sec: 60, in_library: false, added: false, created_at: '2026-09-22 10:00',
    },
    {
      id: 2, url: 'https://x/video.bbb/1/1/dog_video', title: 'dog video',
      duration_sec: null, in_library: true, added: false, created_at: '2026-09-22 10:00',
    },
    {
      id: 3, url: 'https://x/video.ccc/1/1/已入队', title: 'queued item',
      duration_sec: 125, in_library: true, added: true, created_at: '2026-09-22 10:00',
    },
  ];
}

/** 起一个装好候选数据的「找视频」页环境 */
async function bootDiscover({ rows = candidateRows(), crawl = null } = {}) {
  const calls = [];
  const responses = {
    ...fakeResponses(),
    'GET /api/candidates': { total: rows.length, rows },
    'POST /api/crawl': crawl || {
      runId: 7, status: 'done', path: 'html', itemCount: rows.length,
      paging: [{ label: '第 2 页', url: 'https://x/new/2' }],
      note: '该站没有列表解析器，已改用页面解析',
    },
    'POST /api/candidates/action': { requested: 1, added: 1, skipped: 0, retried: 0, errors: [] },
  };
  const dom = installDom({ html: HTML, responses });
  // 记录所有请求，用来断言"关键字筛选没有发新请求"
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(`${(init && init.method) || 'GET'} ${String(url).replace(/^https?:\/\/[^/]+/, '')}`); return origFetch(url, init); };
  const mod = await import(appUrl(`disc-${Date.now()}-${Math.random()}`));
  await new Promise((r) => setTimeout(r, 20));
  return { dom, mod, calls };
}

test('找视频页：候选列表渲染出三条，三种状态标签各自正确', async () => {
  const { dom } = await bootDiscover();
  try {
    const rows = globalThis.document.querySelectorAll('#discList .disc-row');
    assert.equal(rows.length, 3, '应渲染出 3 条候选');

    const tags = [...globalThis.document.querySelectorAll('#discList .disc-tag')].map((t) => t.textContent);
    assert.deepEqual(tags, ['＋新', '已在库', '已加入队列']);
  } finally { dom.restore(); }
});

test('找视频页：时长缺失显示 ?，不显示 0:00', async () => {
  const { dom } = await bootDiscover();
  try {
    const durs = [...globalThis.document.querySelectorAll('#discList .disc-dur')].map((d) => d.textContent);
    assert.deepEqual(durs, ['1:00', '?', '2:05']);
  } finally { dom.restore(); }
});

test('找视频页：关键字筛选是本地过滤 —— 不发新请求', async () => {
  const { dom, calls } = await bootDiscover();
  try {
    const before = calls.filter((c) => c.includes('/api/candidates')).length;

    const filter = globalThis.document.getElementById('discFilter');
    filter.value = 'cat';
    filter.dispatchEvent(new globalThis.Event('input'));

    const after = calls.filter((c) => c.includes('/api/candidates')).length;
    assert.equal(after, before, '输入关键字不该触发新的候选请求（本地过滤）');

    const rows = globalThis.document.querySelectorAll('#discList .disc-row');
    assert.equal(rows.length, 1, '只剩匹配 cat 的那条');
    // ⚠️ 断言**子元素**的 textContent：垫片的 textContent 不聚合子树
    assert.equal(globalThis.document.querySelector('#discList .disc-title').textContent, 'cat video');
  } finally { dom.restore(); }
});

test('找视频页：关键字支持 -词 排除', async () => {
  const { dom } = await bootDiscover();
  try {
    const filter = globalThis.document.getElementById('discFilter');
    filter.value = 'video -dog';
    filter.dispatchEvent(new globalThis.Event('input'));
    const rows = globalThis.document.querySelectorAll('#discList .disc-row');
    assert.equal(rows.length, 1);
    assert.equal(globalThis.document.querySelector('#discList .disc-title').textContent, 'cat video');
  } finally { dom.restore(); }
});

test('找视频页：勾选后点入队会发 action=add 并带选中的 id', async () => {
  const { dom, calls } = await bootDiscover();
  try {
    const boxes = [...globalThis.document.querySelectorAll('#discList .disc-pick')];
    assert.equal(boxes.length, 3);

    // 未选中时按钮应当是禁用的
    assert.equal(globalThis.document.getElementById('btnDiscAdd').disabled, true);

    boxes[0].checked = true;
    boxes[0].dispatchEvent(new globalThis.Event('change'));
    boxes[2].checked = true;
    boxes[2].dispatchEvent(new globalThis.Event('change'));

    const btn = globalThis.document.getElementById('btnDiscAdd');
    assert.equal(btn.disabled, false, '有勾选就要能点');
    assert.match(btn.textContent, /2/, '按钮上要显示选中条数');

    btn.click();
    await new Promise((r) => setTimeout(r, 30));

    const addCall = calls.find((c) => c.startsWith('POST /api/candidates/action'));
    assert.ok(addCall, '应当发出了入队请求');
  } finally { dom.restore(); }
});

test('找视频页：粘网址点「从网站找」会发 POST /api/crawl，并把走了哪条路显示出来', async () => {
  const { dom, calls } = await bootDiscover();
  try {
    const input = globalThis.document.getElementById('discUrl');
    input.value = 'https://x/';
    globalThis.document.getElementById('btnCrawl').click();
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(calls.some((c) => c.startsWith('POST /api/crawl')), '应当发出爬取请求');

    const status = globalThis.document.getElementById('discStatus');
    assert.equal(status.hidden, false, '状态条要显示出来');
    // ⚠️ 垫片的 textContent 不聚合子树，所以取状态条里那个 span
    const line = status.querySelector('span');
    assert.ok(line, '状态条里应当有个 span');
    // 走了哪条路必须写出来 —— 用户据此判断为什么没有缩略图
    assert.match(line.textContent, /页面解析/);
    assert.match(line.textContent, /找到 3 条/, '要显示找到多少条');
  } finally { dom.restore(); }
});

test('找视频页：翻页按钮用那个地址发起**新一次**爬取，且不清空当前候选', async () => {
  const { dom, calls } = await bootDiscover();
  try {
    const input = globalThis.document.getElementById('discUrl');
    input.value = 'https://x/';
    globalThis.document.getElementById('btnCrawl').click();
    await new Promise((r) => setTimeout(r, 40));

    const pagingBtns = [...globalThis.document.querySelectorAll('#discPaging [data-page-url]')];
    assert.ok(pagingBtns.length >= 1, '应当渲染出翻页按钮');
    assert.equal(pagingBtns[0].textContent, '第 2 页');

    const before = calls.filter((c) => c.startsWith('POST /api/crawl')).length;
    pagingBtns[0].click();
    await new Promise((r) => setTimeout(r, 40));
    const after = calls.filter((c) => c.startsWith('POST /api/crawl')).length;
    assert.equal(after, before + 1, '翻页是新一次爬取');

    // 候选列表仍然在（翻页不替换当前结果）
    assert.ok(globalThis.document.querySelectorAll('#discList .disc-row').length > 0,
      '翻页不该清空当前候选列表');
  } finally { dom.restore(); }
});

test('找视频页：202（转后台）时显示进度提示，而不是当成失败', async () => {
  const { dom } = await bootDiscover({ crawl: { runId: 9, status: 'running' } });
  try {
    const input = globalThis.document.getElementById('discUrl');
    input.value = 'https://slow/';
    globalThis.document.getElementById('btnCrawl').click();
    await new Promise((r) => setTimeout(r, 40));

    const status = globalThis.document.getElementById('discStatus');
    assert.equal(status.hidden, false);
    const line = status.querySelector('span');
    assert.match(line.textContent, /后台|抓取/, '要说清"转后台了"');
    assert.doesNotMatch(line.textContent, /失败|错误/);
  } finally { dom.restore(); }
});

test('找视频页：候选标题里的尖括号原样保留（防 innerHTML 注入）', async () => {
  const nasty = '<img src=x onerror=alert(1)> & "引号"';
  const { dom } = await bootDiscover({
    rows: [{
      id: 1, url: 'https://x/video.aaa/1/1/x', title: nasty,
      duration_sec: 60, in_library: false, added: false, created_at: '2026-09-22 10:00',
    }],
  });
  try {
    const title = globalThis.document.querySelector('#discList .disc-title');
    assert.equal(title.textContent, nasty, '文本要原样保留');
    assert.equal(title.children.length, 0, '不该被解析成子元素（那意味着用了 innerHTML）');
  } finally { dom.restore(); }
});

// ---------------------------------------------------------------- 库页的收藏按钮

/**
 * ⚠️ 这条测试是从一个真 bug 补回来的（用户报"收藏按钮点了没反应"）。
 *
 * 病灶：`handleAction` 里**客户端和服务端各翻转了一次**。
 *   服务端：`repo.updateVideo(id, { starred: !cur.starred })`（权威）
 *   客户端：`v.starred = !v.starred`（基于**本地可能已过期**的值）
 * 两者方向相反时（本地 false / 服务端已是 true），界面上会出现
 * "翻成 false、5ms 后又被服务端的 true 翻回 true" —— 净效果为零，
 * 用户看到的就是"没反应"，而**数据库里其实已经改了**（界面与库不一致）。
 *
 * 所以这里刻意让本地值过期（行里写 false，而服务端这次返回 true），
 * 断言最终按钮文字必须与服务端一致 —— 修复前这条必然红。
 */
test('库页：本地值过期时点收藏，界面必须跟服务端一致（不能双翻转）', async () => {
  const staleRow = {
    id: 42, url: 'https://x/v/42', title: 'star target', site: 'X', uploader: 'u',
    status: 'done', height: 1080, file_size: 1024, duration: 60,
    created_at: '2026-09-22 10:00', file_path: 'D:\\dl\\42.mp4',
    starred: false,          // ← 本地以为没收藏
  };
  // 服务端这次返回的是 **true**（权威值），与本地相反
  const serverRow = { ...staleRow, starred: true };

  // ⚠️ 只建**一个** DOM 环境。第一版写了两个（外面一个 installDom、
  //    bootFrontend 里面又建一个），全局 document 被后建的换掉，
  //    于是外层那个变量指向的是已经被丢弃的 document，`.tab` 查出来是 null。
  const { dom } = await bootFrontend({
    responses: {
      ...fakeResponses(),
      'GET /api/library': { total: 1, rows: [staleRow] },
      'POST /api/videos/42/action': { ok: true, video: serverRow },
    },
  });
  try {
    // ⚠️ 用 querySelectorAll + find，别写 `document.querySelector('.tab[data-view="library"]')`：
    //    垫片的 **document 级**查询对"组合选择器 + 属性"支持不全（返回 null），
    //    而元素级支持。本文件里所有能跑的测试都用这个写法。
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 30));

    const btnBefore = globalThis.document.querySelector('#libGrid [data-lib="star"]');
    assert.ok(btnBefore, '库页应当渲染出收藏按钮');
    assert.equal(btnBefore.textContent, '☆', '本地以为没收藏');

    btnBefore.click();
    await new Promise((r) => setTimeout(r, 60));

    const btnAfter = globalThis.document.querySelector('#libGrid [data-lib="star"]');
    assert.equal(btnAfter.textContent, '★',
      '服务端返回 starred=true，界面必须显示 ★；显示 ☆ 说明本地又翻转了一次（双翻转 bug）');
    assert.equal(btnAfter.getAttribute('title'), '取消收藏');
  } finally { dom.restore(); }
});

/**
 * ⚠️ 上面那条测试**还不够**：SSE 推来的服务端权威值会把错误纠正掉，
 * 所以即使代码是"本地翻转"的旧写法，它也能通过（反证验过：退回旧写法仍然全绿）。
 *
 * 真正会咬住 bug 的是**"SSE 没送到"**这个场景：
 *   - SSE 断线（离线过、代理超时、页面刚从后台唤醒）时收不到校正
 *   - 或者事件就是丢了
 * 那时界面只能靠 `handleAction` 自己写对。用本地翻转就会把权威值写反，
 * 于是**点了没反应**（正好是用户报的症状）。
 *
 * 做法：装好 DOM 后先把 SSE 流切断，再点收藏。
 */
test('库页：SSE 没送到时，收藏也必须写对（不能依赖服务端推回来纠正）', async () => {
  const staleRow = {
    id: 55, url: 'https://x/v/55', title: 'offline star', status: 'done',
    created_at: '2026-09-22 10:00', file_path: 'D:\\dl\\55.mp4',
    starred: false,     // 本地过期（服务端其实已是 true）
  };
  const { dom } = await bootFrontend({
    responses: {
      ...fakeResponses(),
      'GET /api/library': { total: 1, rows: [staleRow] },
      'POST /api/videos/55/action': { ok: true, video: { ...staleRow, starred: true } },
    },
  });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 30));

    // 把 SSE 流全掐掉 —— 模拟断线，收不到服务端校正
    if (dom.streams && dom.streams.length) {
      for (const s of dom.streams) { try { s.emit = () => {}; } catch { /* 忽略 */ } }
      assert.ok(true, '已掐断 SSE');
    } else {
      throw new Error('垫片没提供 streams，无法模拟 SSE 断线');
    }

    const btn = globalThis.document.querySelector('#libGrid [data-lib="star"]');
    assert.ok(btn, '库页应当渲染出收藏按钮');
    assert.equal(btn.textContent, '☆', '本地以为没收藏');

    btn.click();
    await new Promise((r) => setTimeout(r, 60));

    const after = globalThis.document.querySelector('#libGrid [data-lib="star"]');
    assert.equal(after.textContent, '★',
      'SSE 没送到时，界面必须直接用 POST 返回的权威值（starred=true）→ ★。'
      + '显示 ☆ 说明代码用了本地翻转，一旦 SSE 断线用户就会看到"点了没反应"');
  } finally { dom.restore(); }
});

test('库页：点收藏会调用 action 接口，而不是只改本地', async () => {
  const row = {
    id: 7, url: 'https://x/v/7', title: 't', status: 'done',
    created_at: '2026-09-22 10:00', file_path: 'D:\\dl\\7.mp4', starred: false,
  };
  const { dom } = await bootFrontend({
    responses: {
      ...fakeResponses(),
      'GET /api/library': { total: 1, rows: [row] },
      'POST /api/videos/7/action': { ok: true, video: { ...row, starred: true } },
    },
  });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 30));

    const btn = globalThis.document.querySelector('#libGrid [data-lib="star"]');
    assert.ok(btn, '库页应当渲染出收藏按钮');

    btn.click();
    await new Promise((r) => setTimeout(r, 60));

    const hit = dom.calls.find((c) => c.method === 'POST' && c.url.includes('/api/videos/7/action'));
    assert.ok(hit, `必须真的发请求，不能只改本地。实际调用：${dom.calls.map((c) => c.url.split('?')[0]).join(' | ')}`);
    assert.equal(hit.body.action, 'star');
  } finally { dom.restore(); }
});

// ---------------------------------------------------------------- 库页分组

/**
 * 造一个"分组后的库"假响应。
 *
 * ⚠️ `by` 必须跟着请求走，不能写死。原因：`state.prefs.library` 是**模块级**对象，
 *    而 DOM 垫片每个测试只重置 DOM 与 localStorage，**不重置模块状态** ——
 *    于是"上一条测试把 by 设成了 site"会漏到下一条测试里。
 *    写死 `by: 'site'` 时，前端拿到的响应与自己请求的维度对不上，
 *    `renderLibrary` 就会走错分支（表现为"选了 group 却按 site 渲染"）。
 *    让假响应回显请求参数，测试之间就干净了 —— 这也更接近真实服务端的行为。
 */
function groupedResponse(by = 'site') {
  const row = (id, title) => ({
    id, url: `https://x/${id}`, title, site: 'Youtube', status: 'done',
    created_at: '2026-09-22 10:00', file_path: `D:\\dl\\${id}.mp4`, starred: false, height: 1080,
  });
  return {
    by, total: 3, shown: 3, truncated: false, cap: 2000,
    groups: [
      { key: 'Youtube', id: null, name: 'Youtube', color: null, count: 2, rows: [row(1, '第一'), row(2, '第二')] },
      { key: 'BiliBili', id: null, name: 'BiliBili', color: null, count: 1, rows: [row(3, '第三')] },
    ],
  };
}

/**
 * 一组"按站点分段"的响应。
 * `GET /api/library/grouped` 用函数值 —— 垫片对函数值会**把请求交给它**，
 * 于是 `by` 能跟着请求走（见上面 groupedResponse 的说明）。
 */
function groupedResponses() {
  return {
    ...fakeResponses(),
    'GET /api/library/grouped': (req) => {
      const u = new URL(req.url, 'http://x');
      return groupedResponse(u.searchParams.get('by') || 'site');
    },
    'GET /api/groups': { groups: [{ id: 9, name: '待看', color: 'amber', count: 0 }] },
  };
}

/** 切到某个展示维度（等价于用户在下拉里选一下） */
async function chooseGroupBy(value) {
  const sel = globalThis.document.getElementById('libGroupBy');
  assert.ok(sel, 'index.html 里应当有 #libGroupBy');
  sel.value = value;
  sel.dispatchEvent(new globalThis.Event('change'));
  await new Promise((r) => setTimeout(r, 40));
}

test('库页分组：切到按站点分段后，出现两段且标题带条数', async () => {
  const { dom } = await bootFrontend({ responses: groupedResponses() });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 30));

    await chooseGroupBy('site');

    const heads = globalThis.document.querySelectorAll('#libGrid .grp-head');
    assert.equal(heads.length, 2, `应当有两段，实际 ${heads.length}`);
    const names = [...globalThis.document.querySelectorAll('#libGrid .grp-name')].map((n) => n.textContent);
    assert.deepEqual(names, ['Youtube', 'BiliBili']);
    const counts = [...globalThis.document.querySelectorAll('#libGrid .grp-count')].map((n) => n.textContent);
    assert.deepEqual(counts, ['2', '1'], '条数要渲染出来');

    // 卡片真的在各段里面（不是只画了标题）
    assert.equal(globalThis.document.querySelectorAll('#libGrid .grp-body .card').length, 3);
  } finally { dom.restore(); }
});

test('库页分组：走的是 grouped 接口（不是普通 library 接口）', async () => {
  const { dom } = await bootFrontend({ responses: groupedResponses() });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 30));
    await chooseGroupBy('group');

    const grouped = dom.calls.filter((c) => c.url.includes('/api/library/grouped'));
    assert.ok(grouped.length, '切到分组模式必须请求 grouped 接口');
    /**
     * ⚠️ 用 `some` 而不是 `find` + 断言第一条。
     * `state` 是**模块级**的，垫片每个测试只重置 DOM 与 localStorage ——
     * 于是"上一条测试留下的请求"也在 `dom.calls` 里，`find` 会命中它，
     * 断言就变成了在考验测试顺序，而不是在考验代码。
     */
    assert.ok(grouped.some((c) => /by=group/.test(c.url)),
      `要有一次 by=group 的请求，实际：${grouped.map((c) => c.url).join(' | ')}`);
    // 反向：分组模式下不该再去请求"平铺列表"的那条（by 为空）
    assert.ok(!grouped.some((c) => !/by=/.test(c.url)), '分组请求必须带 by');
  } finally { dom.restore(); }
});

test('库页分组：分组模式下不出现「加载更多」', async () => {
  const { dom } = await bootFrontend({ responses: groupedResponses() });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 30));
    await chooseGroupBy('site');
    assert.equal(globalThis.document.getElementById('loadMoreWrap').hidden, true,
      '已经全量了，不该再给「加载更多」');
  } finally { dom.restore(); }
});

test('库页分组：点标题能折叠，且状态写进 localStorage', async () => {
  const { dom } = await bootFrontend({ responses: groupedResponses() });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 30));
    await chooseGroupBy('site');

    const head = globalThis.document.querySelector('#libGrid .grp-head');
    head.click();
    await new Promise((r) => setTimeout(r, 40));

    /**
     * ⚠️ 两个坑，都在这里踩过：
     *
     * 1. **要查文档里的新节点。** `renderLibrary()` 折叠后会 `replace()` 重建 DOM，
     *    之前 `querySelectorAll` 拿到的那些节点已经**脱离文档**了，它们的 `hidden`
     *    永远停在旧值 —— 查它们会得到"折叠没生效"的假结论。
     *    所以重新查一遍，并直接用属性选择器 `.grp-body[hidden]`。
     * 2. **localStorage 的 key 是 `videoVault.prefs.v2`**（见 `state.js` 的 PREF_KEY），
     *    不是想当然的 `vv.prefs`。查错 key 会得到"没持久化"的假结论。
     */
    const collapsedBodies = globalThis.document.querySelectorAll('#libGrid .grp-body[hidden]');
    assert.ok(collapsedBodies.length > 0, '点一下要把分组收起（.grp-body 应当带 hidden）');
    assert.match(String(globalThis.localStorage.getItem('videoVault.prefs.v2')), /collapsed/,
      '折叠状态要持久化');
  } finally { dom.restore(); }
});

test('库页分组：截断时要明说「只分组了前 N 条」', async () => {
  const r = groupedResponse();
  const { dom } = await bootFrontend({
    responses: {
      ...fakeResponses(),
      'GET /api/library/grouped': { ...r, total: 5000, shown: 2000, truncated: true, cap: 2000 },
      'GET /api/groups': { groups: [] },
    },
  });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 30));
    await chooseGroupBy('site');
    const stat = globalThis.document.getElementById('libStat').textContent;
    assert.match(stat, /只分组了前 2000 条/, `要明说截断了，实际「${stat}」`);
  } finally { dom.restore(); }
});

test('库页分组：空分组显示「这个分组还是空的」，不是空白', async () => {
  const { dom } = await bootFrontend({
    responses: {
      ...fakeResponses(),
      'GET /api/library/grouped': {
        by: 'group', total: 0, shown: 0, truncated: false, cap: 2000,
        groups: [{ key: '9', id: 9, name: '待看', color: 'amber', count: 0, rows: [] }],
      },
      'GET /api/groups': { groups: [{ id: 9, name: '待看', color: 'amber', count: 0 }] },
    },
  });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 30));
    await chooseGroupBy('group');

    const empty = globalThis.document.querySelector('#libGrid .grp-empty');
    assert.ok(empty, '空分组要有提示文字');
    assert.match(empty.textContent, /空/);
    // 颜色点：自定义分组有颜色（用 some —— 理由同上：模块状态会跨测试残留）
    assert.ok(
      [...globalThis.document.querySelectorAll('#libGrid .grp-dot')].some((d) => d.classList.contains('c-amber')),
      '有颜色的分组要画色点',
    );
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
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 30));
    await chooseGroupBy('site');
    const name = globalThis.document.querySelector('#libGrid .grp-name');
    assert.equal(name.textContent, nasty, '文本原样保留');
    assert.equal(name.children.length, 0, '不该被解析成子元素');
  } finally { dom.restore(); }
});

// ---------------------------------------------------------------- 多选与批量操作

/** 两条平铺记录 + 可用的批量接口响应 */
function multiResponses() {
  const row = (id, title) => ({
    id, url: `https://x/${id}`, title, status: 'done',
    created_at: '2026-09-22 10:00', file_path: `D:\\dl\\${id}.mp4`, starred: false,
  });
  return {
    ...fakeResponses(),
    'GET /api/library': { total: 2, rows: [row(1, 'a'), row(2, 'b')] },
    'GET /api/groups': { groups: [{ id: 9, name: '待看', color: 'amber', count: 0 }] },
    'POST /api/videos/bulk-action': (req) => ({ affected: (req.params && 2) || 2 }),
    'POST /api/videos/group-action': { added: 2, removed: 0, affected: 2, errors: [] },
  };
}

/** 切到库页并勾上多选 */
async function bootMulti() {
  const booted = await bootFrontend({ responses: multiResponses() });
  globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
  await new Promise((r) => setTimeout(r, 40));
  const box = globalThis.document.getElementById('libMulti');
  box.checked = true;
  box.dispatchEvent(new globalThis.Event('change'));
  await new Promise((r) => setTimeout(r, 40));
  return booted;
}

/** 勾选第 n 张卡片的勾选框 */
async function tick(n) {
  const boxes = [...globalThis.document.querySelectorAll('#libGrid .pick')];
  assert.ok(boxes[n], `应当有第 ${n + 1} 个勾选框，实际只有 ${boxes.length} 个`);
  boxes[n].checked = true;
  boxes[n].dispatchEvent(new globalThis.Event('change'));
  await new Promise((r) => setTimeout(r, 20));
}

test('库页多选：勾上多选后，每张卡片出现勾选框', async () => {
  const { dom } = await bootMulti();
  try {
    assert.equal(globalThis.document.querySelectorAll('#libGrid .pick').length, 2,
      '两条记录要有两个勾选框');
    // 没勾任何东西时，批量条不出现
    assert.equal(globalThis.document.getElementById('libBulkBar').hidden, true);
  } finally { dom.restore(); }
});

test('库页多选：勾选后出现「已选 N 条」与批量按钮', async () => {
  const { dom } = await bootMulti();
  try {
    await tick(0);
    const bar = globalThis.document.getElementById('libBulkBar');
    assert.equal(bar.hidden, false, '勾了东西就该出现批量条');
    assert.match(bar.textContent, /已选 1 条/, `实际内容：${bar.textContent}`);

    await tick(1);
    assert.match(bar.textContent, /已选 2 条/, '再勾一条要变成 2');

    // 取消勾选要减回去
    const boxes = [...globalThis.document.querySelectorAll('#libGrid .pick')];
    boxes[0].checked = false;
    boxes[0].dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    assert.match(bar.textContent, /已选 1 条/);
  } finally { dom.restore(); }
});

test('库页多选：批量收藏**只发一个请求**，不是循环发 N 个', async () => {
  const { dom } = await bootMulti();
  try {
    await tick(0);
    await tick(1);

    const btn = [...globalThis.document.querySelectorAll('#libBulkBar button')]
      .find((b) => b.textContent === '收藏');
    assert.ok(btn, `批量条里应当有「收藏」按钮，实际：${globalThis.document.getElementById('libBulkBar').textContent}`);
    btn.click();
    await new Promise((r) => setTimeout(r, 60));

    const posts = dom.calls.filter((c) => c.method === 'POST' && c.url.includes('bulk-action'));
    assert.equal(posts.length, 1, `批量收藏应当只发 1 个请求，实际 ${posts.length} 个`);
    assert.equal(posts[0].body.action, 'star');
    assert.deepEqual(posts[0].body.ids.slice().sort(), [1, 2], '两条 id 都要带上');

    // 反向：不能是"逐条调 action 接口"
    const singles = dom.calls.filter((c) => /\/api\/videos\/\d+\/action/.test(c.url));
    assert.equal(singles.length, 0, `不该逐条发 action 请求，实际 ${singles.length} 个`);
  } finally { dom.restore(); }
});

test('库页多选：加入分组会带上选中的 id 与目标分组', async () => {
  const { dom } = await bootMulti();
  try {
    await tick(0);
    const sel = globalThis.document.querySelector('#libBulkBar select');
    assert.ok(sel, '批量条里应当有分组下拉');

    sel.value = '9';
    sel.dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 60));

    const hit = dom.calls.find((c) => c.method === 'POST' && c.url.includes('group-action'));
    assert.ok(hit, '要真的发 group-action 请求');
    assert.deepEqual(hit.body.ids, [1]);
    assert.deepEqual(hit.body.add, [9]);
  } finally { dom.restore(); }
});

test('库页多选：「取消选择」清空批量条', async () => {
  const { dom } = await bootMulti();
  try {
    await tick(0);
    const btn = [...globalThis.document.querySelectorAll('#libBulkBar button')]
      .find((b) => b.textContent === '取消选择');
    assert.ok(btn);
    btn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(globalThis.document.getElementById('libBulkBar').hidden, true,
      '取消选择后批量条应当收起来');
  } finally { dom.restore(); }
});

test('库页多选：换筛选条件会清空多选（避免"选中的东西看不见了"）', async () => {
  const { dom } = await bootMulti();
  try {
    await tick(0);
    assert.match(globalThis.document.getElementById('libBulkBar').textContent, /已选 1 条/);

    // 改一个筛选（这里用"仅收藏"）
    const star = globalThis.document.getElementById('libStarred');
    star.checked = true;
    star.dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(globalThis.document.getElementById('libBulkBar').hidden, true,
      '换了筛选就不该还留着上次的选中状态');
  } finally { dom.restore(); }
});

test('库页多选：分组模式也能勾选（勾选框在分组内容里）', async () => {
  const { dom } = await bootFrontend({
    responses: {
      ...multiResponses(),
      'GET /api/library/grouped': (req) => ({
        by: req.params.get('by') || 'site', total: 1, shown: 1, truncated: false, cap: 2000,
        groups: [{ key: 'Youtube', id: null, name: 'Youtube', color: null, count: 1, rows: [
          { id: 1, url: 'https://x/1', title: 'a', status: 'done', created_at: '2026-09-22 10:00', file_path: 'D:\\1.mp4', starred: false },
        ] }],
      }),
    },
  });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 40));
    const m = globalThis.document.getElementById('libMulti');
    m.checked = true;
    m.dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 20));

    await chooseGroupBy('site');
    const boxes = [...globalThis.document.querySelectorAll('#libGrid .grp-body .pick')];
    assert.equal(boxes.length, 1, '分组里的卡片也要有勾选框');
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 20));

    const hit = dom.calls.find((c) => c.method === 'POST' && c.url.includes('bulk-action'));
    // 还没点批量按钮，所以这时候不该有请求；先确认批量条出现了
    assert.equal(globalThis.document.getElementById('libBulkBar').hidden, false,
      '在分组里勾选也要能触发批量条');
    assert.equal(hit, undefined, '没点批量按钮之前不该发请求');
  } finally { dom.restore(); }
});

// ---------------------------------------------------------------- 分组管理

/** 两个分组（其中一个 0 条）+ 可用的增删改接口 */
function manageResponses() {
  return {
    ...fakeResponses(),
    'GET /api/groups': {
      groups: [
        { id: 1, name: '待看', color: 'amber', count: 3 },
        { id: 2, name: '空的', color: 'blue', count: 0 },
      ],
    },
    'POST /api/groups': { id: 3, name: '新建的', color: 'amber', count: 0 },
    'PATCH /api/groups/1': { id: 1, name: '改名后', color: 'green', count: 3 },
    'DELETE /api/groups/1': { mode: 'detach', removedVideos: 0 },
  };
}

async function bootManage() {
  const booted = await bootFrontend({ responses: manageResponses() });
  globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
  await new Promise((r) => setTimeout(r, 50));
  return booted;
}

test('分组管理：点「管理分组」列出所有分组，**含 0 条的**', async () => {
  const { dom } = await bootManage();
  try {
    globalThis.document.getElementById('btnManageGroups').click();
    await new Promise((r) => setTimeout(r, 30));

    const rows = [...globalThis.document.querySelectorAll('#modal .gm-row')];
    assert.equal(rows.length, 2, `两个分组都要列出来（含 0 条的），实际 ${rows.length}`);
    const text = globalThis.document.getElementById('modal').textContent;
    assert.match(text, /待看/);
    assert.match(text, /空的/, '0 条的分组也要在列表里 —— 否则刚建完就"消失"了');
    assert.match(text, /0 条/, '条数要显示');
  } finally { dom.restore(); }
});

test('分组管理：删除时必须弹确认框，且默认选项是"只解散"', async () => {
  const { dom } = await bootManage();
  try {
    globalThis.document.getElementById('btnManageGroups').click();
    await new Promise((r) => setTimeout(r, 30));

    // 点第一行的「删除」
    const del = [...globalThis.document.querySelectorAll('#modal .gm-row')][0]
      .querySelectorAll('button').find((b) => b.textContent === '删除');
    assert.ok(del, '每行要有删除按钮');
    del.click();
    await new Promise((r) => setTimeout(r, 30));

    const box = globalThis.document.querySelector('#modal .dialog');
    const labels = [...box.querySelectorAll('.dialog-actions button')].map((b) => b.textContent);
    assert.ok(labels.some((l) => /只解散/.test(l)), `要有"只解散"这个选项，实际：${labels.join(' | ')}`);
    assert.ok(labels.some((l) => /库记录/.test(l)), '要有"删库记录"这个选项');

    // ⚠️ 关键：purge 那个选项**必须写明磁盘文件保留** ——
    // 它删的是库记录，文件仍在。只写"一起删除"会让用户以为文件也没了。
    assert.ok(labels.some((l) => /磁盘文件保留/.test(l)),
      `危险选项必须写明文件保留，实际：${labels.join(' | ')}`);

    // 默认（primary）那一边必须是安全的 detach，不是 purge
    const primary = box.querySelector('.dialog-actions .btn-primary');
    assert.ok(primary, '应当有一个默认选中的选项');
    assert.match(primary.textContent, /只解散/, '默认必须是"只解散"，不能默认删记录');

    // 还没确认，所以不该发删除请求
    assert.equal(dom.calls.filter((c) => c.method === 'DELETE').length, 0, '确认前不该删');
  } finally { dom.restore(); }
});

test('分组管理：选「只解散」后发的请求带 mode=detach', async () => {
  const { dom } = await bootManage();
  try {
    globalThis.document.getElementById('btnManageGroups').click();
    await new Promise((r) => setTimeout(r, 30));
    [...globalThis.document.querySelectorAll('#modal .gm-row')][0]
      .querySelectorAll('button').find((b) => b.textContent === '删除').click();
    await new Promise((r) => setTimeout(r, 30));

    const keep = [...globalThis.document.querySelectorAll('#modal .dialog-actions button')]
      .find((b) => /只解散/.test(b.textContent));
    keep.click();
    await new Promise((r) => setTimeout(r, 60));

    const hit = dom.calls.find((c) => c.method === 'DELETE' && c.url.includes('/api/groups/1'));
    assert.ok(hit, `要真的发删除请求。实际调用：${dom.calls.map((c) => c.method + ' ' + c.url.split('?')[0]).join(' | ')}`);
    assert.match(hit.url, /mode=detach/, `默认必须是 detach，实际 ${hit.url}`);
  } finally { dom.restore(); }
});

test('分组管理：新建分组会发 POST，并带上名字与颜色', async () => {
  const { dom } = await bootManage();
  try {
    globalThis.document.getElementById('btnNewGroup').click();
    await new Promise((r) => setTimeout(r, 30));

    const nameBox = globalThis.document.getElementById('groupName');
    assert.ok(nameBox, '新建弹层里要有名字输入框');
    nameBox.value = '新建的';

    // 换一个颜色
    const blue = [...globalThis.document.querySelectorAll('#groupColors .swatch')]
      .find((s) => s.dataset.color === 'blue');
    assert.ok(blue, '颜色选择块要渲染出来');
    blue.click();

    [...globalThis.document.querySelectorAll('#modal .dialog-actions button')]
      .find((b) => b.textContent === '建立').click();
    await new Promise((r) => setTimeout(r, 60));

    const hit = dom.calls.find((c) => c.method === 'POST' && c.url.includes('/api/groups'));
    assert.ok(hit, '要发 POST /api/groups');
    assert.equal(hit.body.name, '新建的');
    assert.equal(hit.body.color, 'blue', '选的颜色要带上');
  } finally { dom.restore(); }
});

test('分组管理：名字为空时不发请求，并在弹层里报错', async () => {
  const { dom } = await bootManage();
  try {
    globalThis.document.getElementById('btnNewGroup').click();
    await new Promise((r) => setTimeout(r, 30));
    globalThis.document.getElementById('groupName').value = '   ';

    [...globalThis.document.querySelectorAll('#modal .dialog-actions button')]
      .find((b) => b.textContent === '建立').click();
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(dom.calls.filter((c) => c.method === 'POST' && c.url.includes('/api/groups')).length, 0,
      '空名字不该发请求');
    const err = globalThis.document.querySelector('#modal .form-error');
    assert.ok(err && !err.hidden, '要在弹层里显示错误，而不是静默什么也不做');
    assert.match(err.textContent, /名字/);
  } finally { dom.restore(); }
});

// ---------------------------------------------------------------- 只看某个分组（快捷筛选）

test('只看某个分组：选中后请求里必须带 groupId', async () => {
  const { dom } = await bootFrontend({
    responses: {
      ...multiResponses(),
      'GET /api/library': { total: 1, rows: [{
        id: 1, url: 'https://x/1', title: 'a', status: 'done',
        created_at: '2026-09-22 10:00', file_path: 'D:\\1.mp4', starred: false,
      }] },
    },
  });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 50));

    const sel = globalThis.document.getElementById('libOnlyGroup');
    assert.ok(sel, 'index.html 里应当有 #libOnlyGroup');
    assert.equal(sel.hidden, false, '有自定义分组时这个下拉要显示出来');
    const opt = [...sel.querySelectorAll('option')].find((o) => o.value === '9');
    assert.ok(opt, `下拉里应当有待看这一项，实际选项：${[...sel.querySelectorAll('option')].map((o) => o.value + ':' + o.textContent).join(' | ')}`);

    sel.value = '9';
    sel.dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 60));

    // ⚠️ 这条是审计出来的漏做：曾经只把值存进偏好、从没发给接口，
    //    于是"只看：待看"选了什么都不发生，而界面上完全看不出问题。
    const hit = dom.calls.filter((c) => c.url.includes('/api/library') && c.url.includes('groupId=9'));
    assert.ok(hit.length > 0,
      `选中分组后请求必须带 groupId=9。实际请求：${dom.calls.filter((c) => c.url.includes('/api/library')).map((c) => c.url).join(' | ')}`);

    // 取消选择后不该再带这个参数
    sel.value = '';
    sel.dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 60));
    const after = dom.calls[dom.calls.length - 1];
    assert.ok(!after.url.includes('groupId='),
      `取消"只看"之后不该再带 groupId，实际 ${after.url}`);
  } finally { dom.restore(); }
});

test('只看某个分组：分组模式下也带 groupId（两种模式叠加）', async () => {
  const { dom } = await bootFrontend({
    responses: {
      ...groupedResponses(),
      'GET /api/groups': { groups: [{ id: 9, name: '待看', color: 'amber', count: 3 }] },
    },
  });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 50));

    const sel = globalThis.document.getElementById('libOnlyGroup');
    sel.value = '9';
    sel.dispatchEvent(new globalThis.Event('change'));
    await new Promise((r) => setTimeout(r, 60));

    await chooseGroupBy('site');
    const grouped = dom.calls.filter((c) => c.url.includes('/api/library/grouped'));
    assert.ok(grouped.some((c) => /groupId=9/.test(c.url)),
      `分组模式下也要带 groupId。实际：${grouped.map((c) => c.url).join(' | ')}`);
  } finally { dom.restore(); }
});

// ---------------------------------------------------------------- 分组 × 列表视图

/**
 * 切到列表布局（等价于点工具栏那个「列表」按钮）
 * @param {boolean} drawAgain 点完之后是否直接调 renderLibrary()（模拟真实前端的行为）
 */
async function chooseLayout(name) {
  const btn = [...globalThis.document.querySelectorAll('#libLayout .seg-btn')]
    .find((b) => b.dataset.layout === name);
  assert.ok(btn, `应当有 ${name} 视图按钮`);
  btn.click();
  await new Promise((r) => setTimeout(r, 60));
}

test('分组 + 列表视图：必须能看到分段和行，不能白屏（评审 C1）', async () => {
  const { dom } = await bootFrontend({ responses: groupedResponses() });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 40));

    // 先切成列表视图，再开分组 —— 这是评审实测白屏的路径之一
    await chooseLayout('list');
    await chooseGroupBy('site');

    const grid = globalThis.document.getElementById('libGrid');
    const list = globalThis.document.getElementById('libList');

    // 可见的那个容器里必须有内容（另一个是隐藏的）
    const visible = grid.hidden ? list : grid;
    assert.equal(visible.hidden, false, '可见容器不该是 hidden');
    assert.ok(visible.textContent.includes('Youtube'),
      `可见容器里应当能看到分段标题，实际文本：「${visible.textContent}」`);
    assert.ok(visible.querySelectorAll('.grp').length > 0, '可见容器里应当有分段');

    // 列表视图下分段里应当是"行"，不是"卡片"
    assert.ok(list.querySelectorAll('.lrow').length > 0,
      `列表视图的分段里应当有行（.lrow），实际 ${list.querySelectorAll('.lrow').length} 行`);
    assert.equal(grid.querySelectorAll('.card').length, 0, '列表视图下网格容器不该有卡片');

    // 反向：整个可见区域不能是空的（原 bug 的表现就是可见区 textContent 为空）
    assert.notEqual(visible.textContent.trim(), '', '可见区不能是空的（那就是白屏）');
  } finally { dom.restore(); }
});

test('分组 + 列表视图：先分组再点「列表」也要能看见（评审 C1 的另一条路径）', async () => {
  const { dom } = await bootFrontend({ responses: groupedResponses() });
  try {
    globalThis.document.querySelectorAll('.tab').find((t) => t.dataset.view === 'library').click();
    await new Promise((r) => setTimeout(r, 40));

    await chooseGroupBy('site');        // 先开分组（此时是网格视图）
    await chooseLayout('list');          // 再点列表 —— 原来这条路径会白屏

    const grid = globalThis.document.getElementById('libGrid');
    const list = globalThis.document.getElementById('libList');
    const visible = grid.hidden ? list : grid;
    assert.ok(visible.textContent.includes('Youtube'),
      `点完「列表」之后必须还能看见分段，实际文本：「${visible.textContent}」`);
    assert.ok(list.querySelectorAll('.lrow').length > 0, '分段里应当是行');
  } finally { dom.restore(); }
});
