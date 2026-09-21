'use strict';
/**
 * 下载诊断：把「API 看到的进度序列」和「yt-dlp 原始日志」并排采下来，
 * 用证据定位进度条为什么显示不对、以及速度到底被什么限制。
 *
 * 用法：
 *   node diagnose.js                    # 默认测试视频
 *   node diagnose.js <url>              # 指定视频
 *   node diagnose.js <url> --no-rate    # 临时关掉限速对比速度
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.VAULT_BASE || 'http://127.0.0.1:8787';
const args = process.argv.slice(2);
const NO_RATE = args.includes('--no-rate');
const URL_ARG = args.find((a) => a.startsWith('http')) ||
  'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const LOG_DIR = path.resolve(__dirname, '..', 'data', 'logs');
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

(async () => {
  console.log('\n════════ 下载诊断 ════════\n');

  const before = (await j('GET', '/api/settings')).data;
  console.log('原始设置: 限速=' + before.rateLimitMB + 'MB/s  并发=' + before.concurrency
    + '  分片并发=' + before.fragmentConcurrency);

  if (NO_RATE) {
    await j('PATCH', '/api/settings', { rateLimitMB: 0 });
    console.log('→ 已临时关闭限速（测试完会恢复）');
  }
  const st = (await j('GET', '/api/settings')).data;

  // 提交
  const add = await j('POST', '/api/videos', { urls: URL_ARG, quality: 'best' });
  let id = (add.data.added[0] || {}).id;
  if (!id) {
    // 库里已有这个链接。直接重跑会命中 --no-overwrites 跳过下载，
    // 那样根本采不到下载进度帧（只能看到后处理阶段），会得出错误结论。
    // 所以先删记录 + 删文件，确保是一次真正的全新下载。
    const dupId = (add.data.skipped[0] || {}).id;
    console.log('（该链接已在库中 id=' + dupId + '，先删除记录与文件，保证是全新下载）');
    await j('DELETE', `/api/videos/${dupId}`);
    await sleep(600);
    const again = await j('POST', '/api/videos', { urls: URL_ARG, quality: 'best' });
    id = (again.data.added[0] || {}).id;
  }
  console.log('已入队 id=' + id);
  if (!id) { console.log('无法入队'); process.exit(1); }

  const logPath = path.join(LOG_DIR, `video-${id}.log`);
  const t0 = Date.now();
  const samples = [];
  let lastLogSize = 0;
  let final = null;

  console.log('\n时刻     状态          进度     速度        原始日志新增');
  console.log('─'.repeat(78));

  while (Date.now() - t0 < 300000) {
    const lib = await j('GET', '/api/library?limit=500');
    const v = (lib.data.rows || []).find((r) => r.id === id);
    if (v) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      // 取日志新增部分里最后一条进度帧
      let lastFrame = '';
      try {
        const sz = fs.statSync(logPath).size;
        if (sz > lastLogSize) {
          const fd = fs.openSync(logPath, 'r');
          const buf = Buffer.alloc(sz - lastLogSize);
          fs.readSync(fd, buf, 0, buf.length, lastLogSize);
          fs.closeSync(fd);
          const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.startsWith('VVP|'));
          if (lines.length) lastFrame = lines[lines.length - 1].slice(0, 46);
          lastLogSize = sz;
        }
      } catch {}
      samples.push({
        t: secs, status: v.status, progress: v.progress,
        speed: v.speed, eta: v.eta, height: v.height,
      });
      console.log(
        String(secs).padStart(6) + '  ' +
        String(v.status).padEnd(12) + '  ' +
        String((v.progress || 0).toFixed(1) + '%').padStart(7) + '  ' +
        String(v.speed ? (v.speed / 1048576).toFixed(2) + ' MB/s' : '-').padStart(10) + '  ' +
        lastFrame
      );
      if (['done', 'failed', 'canceled', 'paused'].includes(v.status)) { final = v; break; }
    }
    await sleep(900);
  }

  const elapsed = (Date.now() - t0) / 1000;

  // ── 日志分析：按流分段
  console.log('\n════════ 日志分段分析（每个「Destination」= 一个独立下载流）════════');
  const log = fs.readFileSync(logPath, 'utf8');
  const lines = log.split(/\r?\n/);
  const segments = [];
  let cur = null;
  for (const l of lines) {
    if (/^\[download\] Destination:/.test(l)) {
      cur = { dest: l.replace(/^\[download\] Destination:\s*/, ''), frames: [] };
      segments.push(cur);
    } else if (l.startsWith('VVP|') && cur) {
      const parts = l.slice(4).split('|');
      if (parts.length === 7) cur.frames.push(parseFloat(parts[0]) || 0);
    }
  }
  segments.forEach((s, i) => {
    const pcts = s.frames;
    const first = pcts.length ? pcts[0] : null;
    const last = pcts.length ? pcts[pcts.length - 1] : null;
    let resets = 0;
    for (let k = 1; k < pcts.length; k++) if (pcts[k] < pcts[k - 1] - 1) resets++;
    console.log(`\n  流 #${i + 1}: ${path.basename(s.dest)}`);
    console.log(`    进度帧 ${pcts.length} 个，首帧 ${first}% → 末帧 ${last}%`);
    console.log(`    序列: ${pcts.slice(0, 12).map((p) => p.toFixed(0)).join(' → ')}${pcts.length > 12 ? ' → …' : ''}`);
    console.log(`    ⚠️ 内部回退次数（进度倒退）: ${resets}`);
  });

  // ── API 序列里的进度倒退
  console.log('\n════════ API 进度序列分析 ════════');
  let apiResets = 0;
  const resetPoints = [];
  for (let k = 1; k < samples.length; k++) {
    if (samples[k].progress < samples[k - 1].progress - 1) {
      apiResets++;
      resetPoints.push(`${samples[k - 1].progress.toFixed(0)}% → ${samples[k].progress.toFixed(0)}%`
        + ` (${samples[k - 1].status} → ${samples[k].status}, ${samples[k].t}s)`);
    }
  }
  console.log('  前端会看到的进度倒退次数: ' + apiResets);
  resetPoints.forEach((r) => console.log('    ⚠️ ' + r));

  const maxSpeed = Math.max(...samples.map((s) => s.speed || 0));
  console.log('\n  峰值速度: ' + (maxSpeed / 1048576).toFixed(2) + ' MB/s');

  // ── 结论
  console.log('\n════════ 结论 ════════');
  if (final) {
    const mb = (final.file_size || 0) / 1048576;
    console.log('  最终: ' + final.status + '  ' + mb.toFixed(2) + ' MB  耗时 ' + elapsed.toFixed(1) + 's'
      + '  平均 ' + (mb / elapsed).toFixed(2) + ' MB/s');
    console.log('  文件: ' + final.file_path);
  }
  console.log('  限速设定: ' + st.rateLimitMB + ' MB/s');

  // 恢复设置
  if (NO_RATE) {
    await j('PATCH', '/api/settings', { rateLimitMB: before.rateLimitMB });
    console.log('  （已恢复限速为 ' + before.rateLimitMB + ' MB/s）');
  }
  console.log('');
})();
