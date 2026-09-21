#!/usr/bin/env node
'use strict';
/**
 * 测试运行器 —— 把 test/ 下的测试文件逐个跑一遍并汇总。
 *
 * ⚠️ 为什么不用 `node --test`：
 *    Node 自带的 test runner 会**为每个测试文件起一个子进程**，而受限沙箱
 *    拒绝子进程启动（EPERM）。于是 `npm test` 在受限会话里会报
 *    "spawn EPERM"，看起来像测试全挂了 —— 其实是环境不让起子进程。
 *
 *    绕过办法：**直接运行每个测试文件**。node:test 在文件被直接执行时
 *    同样会跑里面的 test() 并输出结果，只是少了自动发现和多进程并行。
 *    代价是慢一点（串行），换来的是在所有环境里都能跑。
 *
 * 用法：
 *   node test/run.js              全部
 *   node test/run.js unit         只跑单元测试
 *   node test/run.js unit domain  只跑 test/unit/domain-*（按前缀筛）
 *   node test/run.js --verbose    把每个文件的完整输出都打出来
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;

/**
 * 跑一个测试文件并把输出拿回来。
 *
 * ⚠️ 刻意用**文件描述符重定向**而不是管道 —— 这是这个项目反复吃过的亏：
 *    受限沙箱拒绝管道 stdio（EPERM），而 `spawnSync(..., {encoding:'utf8'})`
 *    默认就是管道，于是失败时拿到的是空字符串，看起来像"测试没有任何输出"。
 *    用 fd 重定向在两种沙箱下都能跑（应用本身也是这么调 yt-dlp 的）。
 */
function runFile(file) {
  const outFile = path.join(os.tmpdir(), `vv-test-${process.pid}-${Date.now()}.log`);
  let fd;
  try {
    fd = fs.openSync(outFile, 'w');
    const r = spawnSync(process.execPath, [file], {
      cwd: ROOT, stdio: ['ignore', fd, fd], timeout: 600000, windowsHide: true,
    });
    fs.closeSync(fd);
    fd = null;
    const out = fs.readFileSync(outFile, 'utf8');
    return { status: r.status, error: r.error, out };
  } finally {
    if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
    try { fs.unlinkSync(outFile); } catch { /* 忽略 */ }
  }
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const filters = args.filter((a) => !a.startsWith('--'));

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[90m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', d: '', B: '', x: '' };

/** 收集测试文件，跳过辅助文件（run.js 自己、helpers/、ui/ 要真浏览器） */
function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // ui/ 要真实 Chrome（受限沙箱里起不来），helpers/ 是共享垫片不是测试
      if (e.name === 'ui' || e.name === 'helpers' || e.name === 'fixtures') continue;
      collect(full, out);
    } else if (e.name.endsWith('.test.js') || e.name.endsWith('.test.mjs')) {
      out.push(full);
    }
  }
  return out;
}

let files = collect(TEST_DIR).sort();

// 按参数过滤（路径片段匹配）
if (filters.length) {
  files = files.filter((f) => {
    const rel = path.relative(TEST_DIR, f).replace(/\\/g, '/');
    return filters.some((needle) => rel.includes(needle));
  });
}

if (!files.length) {
  console.log(`${C.y}没有匹配到测试文件${C.x}${filters.length ? `（筛选条件：${filters.join(', ')}）` : ''}`);
  process.exit(1);
}

console.log(`\n${C.B}视频下载工具 · 测试${C.x}`);
console.log(`${C.d}共 ${files.length} 个文件${filters.length ? `（筛选：${filters.join(', ')}）` : ''}${C.x}\n`);

const results = [];
let totalPass = 0;
let totalFail = 0;
let totalSkip = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const started = Date.now();
  const r = runFile(file);
  const ms = Date.now() - started;
  const out = r.out || '';

  if (r.error && r.error.code === 'EPERM') {
    results.push({ rel, ok: false, err: 'spawn EPERM —— 环境不允许起子进程' });
    console.log(`  ${C.r}✘${C.x} ${rel}  ${C.r}起不来（EPERM）${C.x}`);
    totalFail += 1;
    continue;
  }

  // node:test 的汇总行形如 "ℹ pass 9" / "ℹ fail 1" / "ℹ skipped 0"
  const grab = (key) => {
    const m = out.match(new RegExp(`^\\u2139\\s*${key}\\s+(\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const pass = grab('pass');
  const fail = grab('fail');
  const skip = grab('skipped');
  const ok = r.status === 0 && (fail === null || fail === 0);

  totalPass += pass || 0;
  totalFail += fail || 0;
  totalSkip += skip || 0;

  results.push({ rel, ok, pass, fail, skip, ms, out });

  const counts = `${pass !== null ? `${C.g}${pass} 通过${C.x}` : ''}`
    + `${fail ? ` ${C.r}${fail} 失败${C.x}` : ''}`
    + `${skip ? ` ${C.d}${skip} 跳过${C.x}` : ''}`;
  console.log(`  ${ok ? `${C.g}✔${C.x}` : `${C.r}✘${C.x}`} ${rel.padEnd(42)} ${counts} ${C.d}${ms}ms${C.x}`);

  if (!ok || verbose) {
    // 失败的把细节打出来，别让用户自己去翻。
    //
    // ⚠️ 这里要小心：node:test 的输出里，"✖ failing tests:" 之后会**再列一遍**
    //    失败的测试名 —— 只按 ✖ 抓行会把汇总行当成真正的失败原因显示出来，
    //    而真正的 AssertionError 细节被挤掉。所以优先抓 AssertionError
    //    那一段（它带 actual/expected），抓不到才退回按 ✖ 抓。
    const lines = out.split('\n');
    const assertionAt = lines.findIndex((l) => /AssertionError|\bError:/.test(l));
    const picked = assertionAt >= 0
      ? lines.slice(assertionAt, assertionAt + 10)
      : lines.filter((l) => /✖/.test(l)).slice(0, 10);
    for (const l of picked) console.log(`      ${C.d}${l.trim()}${C.x}`);
    if (!picked.length) {
      for (const l of lines.slice(-14)) console.log(`      ${C.d}${l}${C.x}`);
    }
  }
}

// ---------------------------------------------------------------- 汇总

const failed = results.filter((x) => !x.ok);
console.log(`\n${'═'.repeat(58)}`);
console.log(`  ${C.B}合计${C.x}  ${C.g}通过 ${totalPass}${C.x}`
  + `  ${failed.length ? `${C.r}失败 ${totalFail}${C.x}` : `失败 0`}`
  + `${totalSkip ? `  ${C.d}跳过 ${totalSkip}${C.x}` : ''}`);
console.log(`  ${C.d}文件 ${results.length - failed.length}/${results.length} 全绿${C.x}`);
console.log(`${'═'.repeat(58)}\n`);

if (failed.length) {
  console.log(`  ${C.r}这些文件有失败：${C.x}`);
  for (const f of failed) console.log(`    ${f.rel}${f.err ? `（${f.err}）` : ''}`);
  console.log('');
  process.exit(1);
}
