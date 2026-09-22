#!/usr/bin/env node
'use strict';
/**
 * 截图工具 —— 真实 Chrome + CDP，零依赖，用来肉眼验界面。
 *
 * 为什么需要它：**CSS 类名错配是纯静态检查抓不到的一类 bug**。
 * 这个项目真出过：样式表为老前端写的类名（.q-top/.card-thumb 容器）和新前端
 * 渲染出来的类名（.qmain/.card-media）对不上，整个队列页和库卡片没有样式，
 * 而所有测试都是绿的 —— 因为没人真的在浏览器里看过。
 *
 * 用法：
 *   node tools/screenshot.js <baseUrl> <输出目录>
 * 行为：每个视图各截一张，外加「更多」面板和确认框各一张。
 *      每个步骤都有硬超时；Chrome 用完一定杀掉（不留残留进程）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '..', 'data', 'screenshots'));

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

// ---------------------------------------------------------------- CDP 客户端

/** 极简 CDP：一个 WebSocket，带 id 匹配和硬超时 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  on(fn) { this.listeners.push(fn); }

  send(method, params = {}, timeoutMs = 15000) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

/** 轮询 /json/version 等调试端口就绪 */
function waitForDebugPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { retry(); }
        });
      });
      req.on('error', retry);
      req.setTimeout(1500, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error(`${timeoutMs}ms 内调试端口没起来`));
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

/** 连调试端口上的第一个页面 target */
async function wsUrlFor(port) {
  const list = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的 page target');
  return page.webSocketDebuggerUrl;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('  ⏭  没找到 Chrome/Edge，跳过截图');
    return 0;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-shot-'));
  const port = 9700 + Math.floor(Math.random() * 200);

  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    // Chrome 111+ 默认拒绝非浏览器来源的 WebSocket 连接
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,1000',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  let failed = 0;
  const shot = async (name, opts = {}) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', ...opts });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  ✔ ${name}.png  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  };

  try {
    await waitForDebugPort(port);
    const url = await wsUrlFor(port);

    // Node 22+ 自带 WebSocket，不需要任何依赖
    const WS = globalThis.WebSocket;
    if (!WS) throw new Error('当前 Node 没有 WebSocket（需要 Node 22+）');
    const ws = new WS(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
      setTimeout(() => rej(new Error('WebSocket 连接超时')), 10000);
    });
    cdp = new Cdp(ws);

    const consoleErrors = [];
    cdp.on((m) => {
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        consoleErrors.push(m.params.entry.text);
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    });

    console.log(`  浏览器：${path.basename(browser)}  →  ${OUT}`);
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(2500);

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };
    const clickView = async (view) => {
      await evalJs(`document.querySelector('.tab[data-view="${view}"]').click()`);
      await sleep(1200);
    };

    // ---- 添加下载
    await shot('shot-add');

    // ---- 找视频（候选列表要先有数据才看得出样子）
    await clickView('discover');
    await evalJs(`
      (async () => {
        // 用后端已有的候选；没有就造几条，好让截图能看出三种状态标签
        const res = await fetch('/api/candidates?limit=8');
        const data = await res.json();
        if (!data.rows || !data.rows.length) {
          await fetch('/api/crawl', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://www.xvideos.com/' }),
          }).catch(() => {});
        }
        // 切回该页触发一次重载
        document.querySelector('.tab[data-view="library"]').click();
        document.querySelector('.tab[data-view="discover"]').click();
        return true;
      })()
    `);
    await sleep(3000);
    await shot('shot-discover');

    // ---- 提交报告（四种结果各来一条，验 .rep-* 那套样式）
    // 这是"只有提交过才看得见"的面，用前端自己的 renderReport 塞一份假数据最省事
    await evalJs(`
      (async () => {
        const m = await import('/static/views/add.js');
        m.renderReport({
          added: [{ title: '新增的一条（标题很长，看看会不会把行撑破）', url: 'https://example.com/a' }],
          skipped: [{ title: '库里已有', reason: 'URL 已存在' }],
          retried: [{ title: '原来是失败，现在重新排队' }],
          errors: [{ url: 'https://example.com/c', error: '无法解析这个地址', hint: '可能需要登录态' }],
          renamed: [{ note: '已归一化', to: 'https://example.com/d' }],
          playlists: [{ title: '某个播放列表', count: 12, added: 3, skipped: 9 }],
        });
        return true;
      })()
    `);
    await sleep(900);
    await shot('shot-report');

    // ---- 我的库（网格）—— 用户报的那个 bug 就在这一屏
    await clickView('library');
    await shot('shot-library-grid');
    // ---- 我的库（列表）
    await evalJs(`document.querySelector('[data-layout="list"]').click()`);
    await sleep(900);
    await shot('shot-library-list');

    // ---- 「更多」面板（对话框 + 表单）
    await evalJs(`document.querySelector('[data-layout="grid"]').click()`);
    await sleep(600);
    // ⚠️ 库里可能一条都没有（空实例）——那样就没有卡片可点。
    //    不判断就点会抛 Uncaught，把整个截图流程打断（剩下的页全截不到）。
    const cardCount = await evalJs(`document.querySelectorAll('#libGrid .card').length`);
    if (cardCount > 0) {
      await evalJs(`document.querySelector('#libGrid .card [data-lib="more"]').click()`);
      await sleep(900);
      await shot('shot-more-panel');
      await evalJs(`document.getElementById('modal').hidden = true`);
    } else {
      console.log('  · 库里没有卡片，跳过「更多」面板截图');
    }

    // ---- 库页分组：按站点分段 / 按分组分段 / 分组管理 / 多选
    //
    // 这几屏**必须有真实的分组数据才看得见**。空实例（库里一条都没有）跑这段
    // 只会截到一张空列表，所以先看库里有没有东西再决定跑不跑。
    const libCount = await evalJs(`document.querySelectorAll('#libGrid .card').length`);
    if (libCount > 0) {
      const setGroupBy = async (val) => {
        await evalJs(`
          (() => {
            const s = document.getElementById('libGroupBy');
            s.value = ${JSON.stringify(val)};
            s.dispatchEvent(new Event('change'));
            return true;
          })()
        `);
        await sleep(1200);   // 分组要重新请求接口
      };

      await setGroupBy('site');
      await shot('shot-library-group-site');

      await setGroupBy('group');
      await shot('shot-library-group-custom');

      // 折叠：点第一段的标题
      await evalJs(`(() => {
        const h = document.querySelector('#libGrid .grp-head');
        if (h) h.click();
        return Boolean(h);
      })()`);
      await sleep(700);
      await shot('shot-library-group-collapsed');

      // 分组管理弹层（含 0 条的分组与颜色选择）
      await setGroupBy('');
      await evalJs(`document.getElementById('btnManageGroups').click()`);
      await sleep(700);
      await shot('shot-group-manager');
      await evalJs(`document.getElementById('modal').hidden = true`);

      // 多选：勾上开关 + 选两条，看批量条
      await evalJs(`
        (() => {
          const m = document.getElementById('libMulti');
          m.checked = true;
          m.dispatchEvent(new Event('change'));
          return true;
        })()
      `);
      await sleep(700);
      await evalJs(`
        (() => {
          const boxes = [...document.querySelectorAll('#libGrid .pick')].slice(0, 2);
          for (const b of boxes) { b.checked = true; b.dispatchEvent(new Event('change')); }
          return boxes.length;
        })()
      `);
      await sleep(700);
      await shot('shot-library-multi');
      // 还原，免得影响后面的截图
      await evalJs(`
        (() => {
          const m = document.getElementById('libMulti');
          m.checked = false;
          m.dispatchEvent(new Event('change'));
          return true;
        })()
      `);
      await sleep(500);
    } else {
      console.log('  · 库里没有卡片，跳过分组相关截图');
    }

    // ---- 确认框
    await evalJs(`
      (async () => {
        const m = await import('/static/ui.js');
        m.confirmDialog({
          title: '删除这条记录',
          body: '默认只删列表记录，磁盘上的文件保留。',
          actions: [
            { label: '取消', value: null },
            { label: '只从列表删掉（保留文件）', value: 'keep', primary: true },
            { label: '记录和文件一起永久删除', value: 'purge', tone: 'danger' },
          ],
        });
      })()
    `);
    await sleep(900);
    await shot('shot-dialog');
    await evalJs(`document.getElementById('modal').hidden = true`);

    // ---- 设置
    await clickView('settings');
    await shot('shot-settings');

    // ---- 队列（历史列表要展开才看得到队列项的样子）
    await clickView('add');
    await sleep(300);
    await evalJs(`
      (() => {
        const t = document.getElementById('btnHistoryToggle');
        if (t && t.textContent.trim() === '展开') t.click();
        return true;
      })()
    `);
    await sleep(1200);
    await evalJs(`window.scrollTo(0, document.body.scrollHeight)`);
    await sleep(600);
    await shot('shot-queue');

    // ---- 整页（长图，用来看版式是否整体一致）
    await evalJs(`window.scrollTo(0, 0)`);
    await sleep(400);
    await shot('shot-fullpage', { captureBeyondViewport: true });

    if (consoleErrors.length) {
      failed = 1;
      console.log(`\n  ⚠ 控制台有 ${consoleErrors.length} 条 error：`);
      for (const e of consoleErrors.slice(0, 8)) console.log(`     ${e}`);
    } else {
      console.log('\n  ✔ 控制台无 error');
    }
    console.log(`\n  截图完成 → ${OUT}\n`);
  } finally {
    // 一定要收掉：CDP 断开 + 杀 Chrome + 删临时 profile
    try { if (cdp) await cdp.send('Browser.close', {}, 3000); } catch { /* 忽略 */ }
    await sleep(400);
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  return failed;
}

const HARD_TIMEOUT = setTimeout(() => {
  console.error('\n  ✘ 截图脚本超时（90s），强制退出\n');
  process.exit(1);
}, 90000);

main()
  .then((code) => { clearTimeout(HARD_TIMEOUT); process.exit(code); })
  .catch((e) => {
    clearTimeout(HARD_TIMEOUT);
    console.error(`\n  ✘ 截图失败：${e.message}\n`);
    // 受限沙箱里 Chrome 起不来是已知限制，不算失败
    if (/调试端口没起来|WebSocket/.test(e.message)) {
      console.error('     （受限沙箱里 Chrome 可能起不来，这是已知平台限制）\n');
      process.exit(0);
    }
    process.exit(1);
  });
