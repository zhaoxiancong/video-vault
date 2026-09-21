#!/usr/bin/env node
'use strict';
/**
 * 用真实浏览器验证新前端能不能跑起来（Chrome DevTools Protocol，零依赖）。
 *
 * ⚠️ 这个脚本需要在**权限放宽**的会话里跑。Chrome 的 crashpad 要 OpenProcess、
 *    多进程 IPC 要命名管道，受限沙箱里全被拒（见 README 坑 8）。
 *
 * 它检查的事情，静态分析查不出来：
 *   · ES 模块在浏览器里**真的被解析并执行**了吗（MIME 不对会静默失败）
 *   · 有没有运行时报错 / 未捕获的 Promise 拒绝
 *   · 关键元素真的渲染出来了吗
 *   · 有没有元素被遮挡（elementFromPoint 检查 —— 曾经一个看不见的遮罩
 *     把整个界面罩住，看起来像"按钮坏了"）
 *
 * 用法：node test/ui/smoke.js <baseUrl>
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9333 + (process.pid % 500);

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

/** 极简 CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }

  on(fn) { this.listeners.push(fn); }
}

let pass = 0;
let fail = 0;
function check(name, ok, evidence) {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); } else { fail += 1; console.log(`  ❌ ${name}`); }
  if (evidence) String(evidence).split('\n').slice(0, 6).forEach((l) => console.log(`       ${l}`));
}

(async () => {
  const chrome = findChrome();
  if (!chrome) {
    console.log('  ⏭  没找到 Chrome/Edge，跳过 UI 测试');
    process.exit(0);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-ui-'));
  console.log(`\n════ 前端冒烟测试（真实浏览器）════\n`);
  console.log(`  浏览器：${path.basename(chrome)}`);
  console.log(`  页面：  ${BASE}\n`);

  const child = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,1000',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const cleanup = () => {
    try { child.kill(); } catch { /* 已经退了 */ }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ } }, 500);
  };
  process.on('exit', cleanup);

  // ---- 等 CDP 就绪
  let target = null;
  const started = Date.now();
  while (Date.now() - started < 30000) {
    await sleep(400);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page');
      if (target && target.webSocketDebuggerUrl) break;
    } catch { /* 还没起来 */ }
  }

  if (!target) {
    // ⚠️ 这里**不能算失败**。受限沙箱里 Chrome 起不来是已知的平台限制
    //    （crashpad 要 OpenProcess、多进程 IPC 要命名管道），不是代码问题。
    //    把它算成失败会训练人忽略这个测试 —— 跟 kill-safe 那个教训一样。
    console.log('  ⏭  Chrome 起不来，跳过浏览器冒烟测试');
    console.log('       受限沙箱里 Chrome 无法启动（crashpad/IPC 被拒），这是已知平台限制。');
    console.log('       要在放宽权限的会话里跑：node test/ui/smoke.js <baseUrl>');
    console.log('       注意这不代表前端有问题 —— 静态一致性检查（tools/check-frontend.js）');
    console.log('       和 ES 模块语法检查仍然会跑，能挡住大部分低级错误。\n');
    cleanup();
    process.exit(0);
  }
  check('浏览器能连上调试端口', true);

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  // ---- 收集控制台报错
  const errors = [];
  const consoleErrors = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`${d.text} ${d.exception ? d.exception.description : ''}`.trim());
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim());
    }
  });

  // ---- 打开页面
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2500);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  // ---- 断言
  check('页面标题正确', (await evalJs('document.title')).includes('Video Vault'),
    await evalJs('document.title'));

  const moduleLoaded = await evalJs('typeof window.__VV_BOOTED__ !== "undefined" || document.body.dataset.booted === "1"');
  check('ES 模块被真实执行（入口跑完了 boot）', Boolean(moduleLoaded),
    '入口会在 boot 成功后给 body 打 data-booted 标记');

  const runtimeErrs = errors.length + consoleErrors.length;
  check('没有运行时报错', runtimeErrs === 0,
    runtimeErrs ? [...errors, ...consoleErrors].join('\n') : '');

  // 关键元素真的渲染出来了吗
  const dom = await evalJs(`JSON.stringify({
    tabs: document.querySelectorAll('.tab').length,
    views: document.querySelectorAll('.view').length,
    toasts: !!document.getElementById('toasts'),
    modal: !!document.getElementById('modal'),
    urlBox: !!document.getElementById('urlBox'),
    libGrid: !!document.getElementById('libGrid'),
    engineText: document.getElementById('engineText')?.textContent || ''
  })`);
  const d = JSON.parse(dom);
  check('三个标签页都在', d.tabs === 3, `实际 ${d.tabs}`);
  check('三个视图都在', d.views === 3, `实际 ${d.views}`);
  check('toast 容器与对话框容器存在', d.toasts && d.modal);
  check('引擎状态文字已更新（说明 /api/health 拿到了）',
    d.engineText && !d.engineText.includes('检查引擎'), `"${d.engineText}"`);

  // ---- 遮挡检查（曾经的坑：一个看不见的遮罩罩住整个界面）
  const covered = await evalJs(`(() => {
    const sel = ['#urlBox','#btnAdd','.tab[data-view=library]','.tab[data-view=settings]'];
    const bad = [];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (!el) { bad.push(s + ' 不存在'); continue; }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) { bad.push(s + ' 尺寸为 0'); continue; }
      const hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      if (hit !== el && !el.contains(hit)) bad.push(s + ' 被 ' + (hit?.className || hit?.tagName) + ' 遮挡');
    }
    return JSON.stringify(bad);
  })()`);
  const bad = JSON.parse(covered);
  check('没有元素被遮挡（elementFromPoint 检查）', bad.length === 0, bad.join('\n'));

  // ---- 切标签页真的能切
  await evalJs(`document.querySelector('.tab[data-view=settings]').click()`);
  await sleep(400);
  const settingsActive = await evalJs(`document.getElementById('view-settings').classList.contains('is-active')`);
  check('点「设置」标签能切过去', settingsActive);

  await evalJs(`document.querySelector('.tab[data-view=library]').click()`);
  await sleep(600);
  const libActive = await evalJs(`document.getElementById('view-library').classList.contains('is-active')`);
  check('点「我的库」标签能切过去', libActive);

  // ---- 设置页的登录态自检按钮真的在，且能点
  await evalJs(`document.querySelector('.tab[data-view=settings]').click()`);
  await sleep(300);
  const cookieBtn = await evalJs(`!!document.getElementById('btnTestCookies')`);
  check('登录态自检按钮在设置页里', cookieBtn);

  console.log(`\n  通过 ${pass}   失败 ${fail}\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`\n  冒烟测试崩了：${e.message}\n`);
  process.exit(1);
});
