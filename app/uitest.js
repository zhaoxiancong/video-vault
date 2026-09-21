'use strict';
/**
 * 真实浏览器 UI 冒烟测试（Chrome DevTools Protocol，零依赖）。
 *
 * 为什么需要它：像"[hidden] 被 display:flex 覆盖 → 全屏遮罩盖住整个界面"
 * 这种 bug，靠读代码、靠 HTTP 接口测试都抓不到 —— 必须真的在浏览器里
 * 用 elementFromPoint 去看"这个坐标上到底是哪个元素"。
 *
 * 用法：先启动 server.js，再 node uitest.js
 * 环境变量：VAULT_BASE（默认 http://127.0.0.1:8787）
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const BASE = process.env.VAULT_BASE || 'http://127.0.0.1:8787';
const PORT = 9222 + Math.floor(Math.random() * 300);

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, evidence) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
  if (evidence) String(evidence).split('\n').forEach((l) => console.log(`       ${l}`));
}

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

/** 极简 CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS 执行异常');
    return r.result.value;
  }
}

(async function main() {
  console.log('\n════════ 真实浏览器 UI 冒烟测试 ════════\n');

  const browser = findBrowser();
  if (!browser) {
    console.log('  ⏭  没找到 Chrome/Edge，跳过 UI 测试');
    process.exit(0);
  }
  console.log(`  浏览器：${path.basename(browser)}`);
  console.log(`  目标页面：${BASE}\n`);

  // ⚠️ 沙箱不许往系统 TEMP 写，profile 必须放在工作区内
  const profile = path.join(__dirname, '..', 'data', 'chrome-profile');
  fs.mkdirSync(profile, { recursive: true });

  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1400,900',
    BASE,
  ], { stdio: 'ignore', windowsHide: true });

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
  }

  if (!wsUrl) {
    check('浏览器能连上调试端口', false, '30 秒内没拿到 CDP 地址');
    try { child.kill(); } catch {}
    process.exit(1);
  }
  check('浏览器能连上调试端口', true, wsUrl.replace(/ws:\/\/[^/]+/, 'ws://…'));

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await sleep(2500);   // 等前端 JS 跑完（含 SSE 建连）

  // ── 1. 页面基本加载
  console.log('── 1. 页面加载 ──');
  const title = await cdp.eval('document.title');
  check('页面标题正确', /Video Vault/.test(title || ''), title);

  const jsErr = await cdp.eval('window.__jsError || ""');
  check('前端 JS 无致命错误', !jsErr, jsErr || '无');

  const health = await cdp.eval('(document.getElementById("engineText")||{}).textContent || ""');
  check('顶栏引擎状态已更新（说明 fetch + SSE 通了）', /引擎就绪|引擎缺失/.test(health), health);

  // ── 2. 关键回归：不能有任何东西盖住界面
  //    上个版本 .modal 的 display:flex 覆盖了 [hidden]，
  //    导致全屏遮罩从加载起就盖在最上层，整个界面点不动。
  console.log('\n── 2. 遮挡检测（本次修复的回归点）──');
  const overlay = await cdp.eval(`(() => {
    const modal = document.getElementById('playerModal');
    const cs = getComputedStyle(modal);
    const topEl = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return {
      modalDisplay: cs.display,
      modalHasHidden: modal.hasAttribute('hidden'),
      modalVisible: cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0',
      topElId: topEl ? (topEl.id || '') : '',
      topElClass: topEl ? (topEl.className || '') : '',
      topElTag: topEl ? topEl.tagName : '',
    };
  })()`);
  check('播放弹层默认不可见（hidden 真的生效）',
    !overlay.modalVisible,
    `display=${overlay.modalDisplay}  hidden 属性=${overlay.modalHasHidden}`);
  check('屏幕中心的最上层元素不是遮罩层（界面没被盖住）',
    !String(overlay.topElClass).includes('modal') && overlay.topElId !== 'playerModal',
    `最上层：<${overlay.topElTag} id="${overlay.topElId}" class="${overlay.topElClass}">`);

  // ── 3. 它到底能不能点
  console.log('\n── 3. 可点击性（每个可交互元素都做 elementFromPoint 校验）──');
  // ⚠️ 必须先在浏览器里切到对应视图再检查：
  //    未激活视图是 display:none，其子元素 getBoundingClientRect 全是 0×0，
  //    elementFromPoint(0,0 附近) 自然返回 null，会把"视图没打开"误报成"被遮挡"。
  const viewEls = {
    add: [['#btnAdd', '加入下载队列按钮'], ['#urlBox', '链接粘贴框'],
          ['#optKind', '下载内容下拉'], ['#optQuality', '清晰度下拉']],
    library: [['#libSearch', '库搜索框'], ['#libSort', '排序下拉'],
              ['#btnRefresh', '刷新按钮']],
    settings: [['#btnSaveSettings', '保存设置按钮'], ['#setDir', '下载目录输入框'],
               ['#setConcurrency', '并发数输入框']],
    tabs: [['.tab[data-view="library"]', '我的库标签'], ['.tab[data-view="settings"]', '设置标签']],
  };

  const clickables = [];
  for (const [view, sels] of Object.entries(viewEls)) {
    if (view !== 'tabs') {
      await cdp.eval(`document.querySelector('.tab[data-view="${view}"]').click(); true`);
      await sleep(350);
    }
    const res = await cdp.eval(`(() => {
      const sels = ${JSON.stringify(sels)};
      return sels.map(([sel, label]) => {
        const el = document.querySelector(sel);
        if (!el) return { label, sel, found: false };
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return { label, sel, found: true, visible: false };
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const reachable = !!top && (top === el || el.contains(top) || top.contains(el));
        return {
          label, sel, found: true, visible: true, reachable,
          topTag: top ? top.tagName : '(null)',
          topClass: top ? String(top.className || '') : '(null)',
        };
      });
    })()`);
    clickables.push(...res.map((r) => ({ ...r, view })));
  }

  for (const c of clickables) {
    if (!c.found) { check(`${c.label} 存在`, false, `找不到 ${c.sel}`); continue; }
    if (!c.visible) { check(`${c.label} 可见`, false, `在 ${c.view} 视图里尺寸为 0`); continue; }
    check(`${c.label} 可点击`, c.reachable === true,
      c.reachable ? '命中自身' : `被 <${c.topTag} class="${c.topClass}"> 挡住`);
  }

  // 回到添加页，后面的点击测试从这里开始
  await cdp.eval(`document.querySelector('.tab[data-view="add"]').click(); true`);
  await sleep(350);

  // ── 4. 真的点一下：切到"我的库"
  console.log('\n── 4. 真实点击测试 ──');
  await cdp.eval(`document.querySelector('.tab[data-view="library"]').click(); true`);
  await sleep(800);
  const libActive = await cdp.eval(`(() => ({
    viewActive: document.getElementById('view-library').classList.contains('is-active'),
    addHidden: !document.getElementById('view-add').classList.contains('is-active'),
    tabActive: document.querySelector('.tab[data-view="library"]').classList.contains('is-active'),
  }))()`);
  check('点击"我的库"能切换视图',
    libActive.viewActive && libActive.addHidden && libActive.tabActive,
    JSON.stringify(libActive));

  // 切回添加页，并点一下"更多"看弹层能不能弹出来、能不能关
  await cdp.eval(`document.querySelector('.tab[data-view="add"]').click(); true`);
  await sleep(400);

  const modalTest = await cdp.eval(`(() => {
    const m = document.getElementById('playerModal');
    m.hidden = false;                        // 手动打开，模拟点"播放"
    const opened = getComputedStyle(m).display !== 'none';
    const btn = document.getElementById('playerClose');
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const clickable = !!top && (top === btn || btn.contains(top));
    return { opened, closeClickable: clickable, topTag: top ? top.tagName : null };
  })()`);
  check('播放弹层能被打开（display 变为可见）', modalTest.opened, JSON.stringify(modalTest));
  check('关闭按钮在弹层打开时可点击', modalTest.closeClickable, `最上层 <${modalTest.topTag}>`);

  await cdp.eval(`document.getElementById('playerClose').click(); true`);
  await sleep(400);
  const closed = await cdp.eval(`(() => {
    const m = document.getElementById('playerModal');
    return { hidden: m.hasAttribute('hidden'), display: getComputedStyle(m).display };
  })()`);
  check('点关闭按钮能真正关掉弹层', closed.hidden && closed.display === 'none',
    `hidden=${closed.hidden} display=${closed.display}`);

  // ── 5. 截图，人工也能看一眼
  console.log('\n── 5. 截图 ──');
  const shotDir = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = path.join(shotDir, 'ui-add.png');
  const data = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shot, Buffer.from(data.data, 'base64'));
  check('截图已保存', fs.existsSync(shot) && fs.statSync(shot).size > 5000,
    `${shot}  ${(fs.statSync(shot).size / 1024).toFixed(0)} KB`);

  // 库页面也截一张
  await cdp.eval(`document.querySelector('.tab[data-view="library"]').click(); true`);
  await sleep(1500);
  const shot2 = path.join(shotDir, 'ui-library.png');
  const data2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shot2, Buffer.from(data2.data, 'base64'));
  check('库页面截图已保存', fs.existsSync(shot2) && fs.statSync(shot2).size > 5000,
    `${shot2}  ${(fs.statSync(shot2).size / 1024).toFixed(0)} KB`);

  // ── 汇总
  ws.close();
  try { child.kill(); } catch {}

  console.log('\n════════════════════════════════════════');
  console.log(`  通过 ${pass}   失败 ${fail}`);
  console.log('════════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('\nUI 测试出错：', err.message);
  process.exit(2);
});
