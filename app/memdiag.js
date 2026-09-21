'use strict';
/**
 * 内存诊断：边下载边观察服务端的堆内存走向，并抓 heap 快照做对比。
 * 目标 —— 定位那次 "JavaScript heap out of memory"（堆涨到 4GB 后崩溃）。
 *
 * 用法：
 *   node memdiag.js <url>            诊断一次真实下载
 *   node memdiag.js <url> --no-dl    不下载，只空转观察基线
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const BASE = process.env.VAULT_BASE || 'http://127.0.0.1:8787';
const args = process.argv.slice(2);
const URL_ARG = args.find((a) => a.startsWith('http')) ||
  'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const NO_DL = args.includes('--no-dl');

const DATA = path.resolve(__dirname, '..', 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  return { status: res.status, data: d };
}

// 用 V8 的 inspector 抓堆统计（需要服务端开了 --inspect）
async function heapStats() {
  try {
    const list = await (await fetch('http://127.0.0.1:9229/json/list')).json();
    if (!list.length) return null;
    const ws = new WebSocket(list[0].webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws err')), { once: true });
      setTimeout(() => rej(new Error('ws timeout')), 4000);
    });
    const result = await new Promise((resolve, reject) => {
      const id = 1;
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) resolve(m.result);
      });
      ws.send(JSON.stringify({ id, method: 'Runtime.getHeapUsage' }));
      setTimeout(() => reject(new Error('heap timeout')), 5000);
    });
    ws.close();
    return result;
  } catch { return null; }
}

(async () => {
  console.log('\n════════ 内存诊断 ════════\n');

  const probe = await heapStats();
  if (!probe) {
    console.log('  ⚠️ 服务端没有开 --inspect，无法读堆内存。');
    console.log('     请用这个方式启动服务后重试：');
    console.log('       node --inspect=9229 server.js\n');
    process.exit(0);
  }
  console.log('  ✅ 已连上 V8 inspector\n');

  let id = null;
  if (!NO_DL) {
    const add = await j('POST', '/api/videos', { urls: URL_ARG, quality: 'worst' });
    id = (add.data.added[0] || {}).id;
    if (!id) {
      id = (add.data.skipped[0] || {}).id;
      if (id) await j('POST', `/api/videos/${id}/action`, { action: 'retry' });
    }
    console.log('  任务 id =', id, ' 地址:', URL_ARG, '\n');
  } else {
    console.log('  （不下载，只观察空转基线）\n');
  }

  console.log('   时刻     usedHeap   totalHeap   外部内存   日志大小   状态');
  console.log('  ' + '─'.repeat(74));

  const t0 = Date.now();
  const samples = [];
  const logPath = id ? path.join(DATA, 'logs', `video-${id}.log`) : null;
  let lastStatus = '';

  while (Date.now() - t0 < 300000) {
    const h = await heapStats();
    let logSize = 0;
    if (logPath) { try { logSize = fs.statSync(logPath).size; } catch {} }

    let status = '-', progress = 0;
    if (id) {
      const lib = await j('GET', `/api/library?limit=500`);
      const v = (lib.data.rows || []).find((r) => r.id === id);
      if (v) { status = v.status; progress = v.progress || 0; }
    }

    if (h) {
      const row = {
        t: (Date.now() - t0) / 1000,
        used: h.usedHeapSize, total: h.totalHeapSize, ext: h.embedderHeapUsedSize || 0,
        logSize, status,
      };
      samples.push(row);
      console.log(
        String(row.t.toFixed(0) + 's').padStart(7) +
        (row.used / 1048576).toFixed(1).padStart(10) + ' MB' +
        (row.total / 1048576).toFixed(1).padStart(9) + ' MB' +
        (row.ext / 1048576).toFixed(1).padStart(9) + ' MB' +
        (row.logSize / 1024).toFixed(0).padStart(9) + ' KB   ' + status
      );
    }

    if (id && ['done', 'failed', 'canceled', 'paused'].includes(status) && status !== lastStatus) {
      lastStatus = status;
      console.log('  ' + '─'.repeat(74));
      console.log('  任务进入终态: ' + status + '（继续观察 15 秒，看内存是否回落）');
      await sleep(15000);
      const after = await heapStats();
      if (after) {
        console.log(`  终态后堆内存: ${(after.usedHeapSize / 1048576).toFixed(1)} MB`);
      }
      break;
    }
    await sleep(2000);
  }

  // 分析趋势
  console.log('\n════════ 趋势分析 ════════');
  if (samples.length >= 4) {
    const first = samples[0].used, last = samples[samples.length - 1].used;
    const mid = samples[Math.floor(samples.length / 2)].used;
    const growth1 = mid - first, growth2 = last - mid;
    console.log(`  起始堆: ${(first / 1048576).toFixed(1)} MB`);
    console.log(`  中点堆: ${(mid / 1048576).toFixed(1)} MB   (前半段增长 ${(growth1 / 1048576).toFixed(1)} MB)`);
    console.log(`  结束堆: ${(last / 1048576).toFixed(1)} MB   (后半段增长 ${(growth2 / 1048576).toFixed(1)} MB)`);
    const totalGrowth = last - first;
    console.log(`  总增长: ${(totalGrowth / 1048576).toFixed(1)} MB`);
    console.log('');
    // 后半段仍在持续增长 = 泄漏；增速放缓 = 正常缓存
    if (growth2 > 20 * 1048576 && growth2 > growth1 * 0.5) {
      console.log('  ⚠️ 后半段仍在快速增长 —— 疑似内存泄漏');
    } else if (totalGrowth > 40 * 1048576) {
      console.log('  ⚠️ 总增长较大，但后半段趋缓 —— 可能是日志/缓存占用，需进一步确认');
    } else {
      console.log('  ✅ 内存增长在合理范围');
    }
    const maxLog = Math.max(...samples.map((s) => s.logSize));
    console.log(`  日志文件最大: ${(maxLog / 1024).toFixed(0)} KB`);
  } else {
    console.log('  样本太少，无法判断');
  }
  console.log('');
})();
