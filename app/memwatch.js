'use strict';
/**
 * 内存监控（带硬超时）。
 *
 * 硬约束：
 *   - 总时长超过 MAX_TOTAL_MS 立即退出（默认 240 秒）
 *   - 连续 STALL_LIMIT 次拿不到 API 响应立即退出
 *   - 服务端一旦崩溃立即退出并打印日志尾部
 *   —— 之前的调试脚本会无限挂着，这次全部加硬上限。
 *
 * 用法: node memwatch.js [url] [总秒数]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const PORT = 8811;
const BASE = `http://127.0.0.1:${PORT}`;
const URL_ARG = (process.argv[2] && process.argv[2].startsWith('http')) ? process.argv[2] : null;
const MAX_TOTAL_MS = Number(process.argv[3] || 240) * 1000;
const STALL_LIMIT = 6;               // 连续 6 次（30 秒）无响应就放弃
const T0 = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function procMem(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
      { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return out.trim().split('","').map((s) => s.replace(/"/g, ''))[4] || '?';
  } catch { return '?'; }
}

async function j(p, method = 'GET', body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);      // 单请求 5 秒超时
  try {
    const res = await fetch(BASE + p, {
      method, signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await res.text();
    try { return txt ? JSON.parse(txt) : null; } catch { return txt; }
  } finally { clearTimeout(t); }
}

(async () => {
  console.log('\n════ 内存监控（硬超时 ' + (MAX_TOTAL_MS / 1000) + 's）════\n');
  const srvLog = path.join(__dirname, '..', 'data', '_mw-server.log');
  const fd = fs.openSync(srvLog, 'w');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, stdio: ['ignore', fd, fd], windowsHide: true,
    env: { ...process.env, VAULT_PORT: String(PORT), VAULT_MEMPROBE: '1' },
  });
  fs.closeSync(fd);
  const pid = child.pid;
  console.log('  服务 PID =', pid);
  await sleep(3000);

  let id = null;
  if (URL_ARG) {
    try {
      const add = await j('/api/videos', 'POST', { urls: URL_ARG, quality: 'best' });
      id = (add.added && add.added[0] && add.added[0].id)
        || (add.skipped && add.skipped[0] && add.skipped[0].id) || null;
      if (id && add.skipped && add.skipped.length) {
        await j(`/api/videos/${id}/action`, 'POST', { action: 'retry' });
      }
      console.log('  任务 id =', id, ' 地址:', URL_ARG);
    } catch (e) {
      console.log('  入队失败:', e.message);
    }
  } else {
    console.log('  （不下载，只观察空闲基线）');
  }

  const dlLog = id ? path.join(__dirname, '..', 'data', 'logs', `video-${id}.log`) : null;
  console.log('\n   时刻    内存       日志      状态         进度     备注');
  console.log('  ' + '─'.repeat(64));

  let stall = 0;
  let lastStatus = '';
  while (Date.now() - T0 < MAX_TOTAL_MS) {
    await sleep(5000);

    if (!alive(pid)) {
      console.log('\n  ❌ 服务进程崩溃（' + ((Date.now() - T0) / 1000).toFixed(0) + 's）\n');
      const t = fs.readFileSync(srvLog, 'utf8');
      t.split(/\r?\n/).slice(-20).forEach((l) => console.log('    ' + l));
      try { child.kill(); } catch {}
      process.exit(1);
    }

    let logSize = 0;
    if (dlLog) { try { logSize = fs.statSync(dlLog).size; } catch {} }

    let status = '-', prog = 0, note = '';
    try {
      const lib = await j('/api/library?limit=500');
      const v = (lib.rows || []).find((r) => r.id === id);
      if (v) { status = v.status; prog = v.progress || 0; }
      stall = 0;
    } catch (e) {
      stall++;
      status = 'API超时';
      note = `连续 ${stall} 次`;
      if (stall >= STALL_LIMIT) {
        console.log(`\n  ❌ API 连续 ${stall} 次无响应，判定服务卡死，放弃等待\n`);
        try { child.kill(); } catch {}
        process.exit(2);
      }
    }

    console.log(
      String(((Date.now() - T0) / 1000).toFixed(0) + 's').padStart(7) +
      procMem(pid).padStart(11) +
      ((logSize / 1024).toFixed(0) + ' KB').padStart(10) +
      ('  ' + status).padEnd(14) +
      (prog.toFixed(1) + '%').padStart(8) +
      ('  ' + note)
    );

    if (id && ['done', 'failed', 'canceled'].includes(status)) {
      console.log('\n  ✅ 任务结束:', status, ' 结束后内存:', procMem(pid));
      lastStatus = status;
      break;
    }
  }

  if (Date.now() - T0 >= MAX_TOTAL_MS) {
    console.log('\n  ⏱  达到硬超时上限，主动结束（内存: ' + procMem(pid) + '）');
  }
  if (alive(pid)) { try { child.kill(); } catch {} }
  console.log('');
  process.exit(0);
})().catch((e) => { console.error('监控脚本出错:', e.message); process.exit(3); });
