#!/usr/bin/env node
'use strict';
/**
 * 把启动脚本规范成它们**必须**的字节形态（并校验结果）。
 *
 *   .cmd → 纯 ASCII + CRLF
 *   .ps1 → UTF-8 **with BOM** + CRLF
 *
 * 为什么需要这个脚本而不是"写的时候注意点"：
 *   write / edit 工具产出的是 **UTF-8 无 BOM 且 LF 行尾** —— 正好是 .ps1 的
 *   禁忌形态（PS 5.1 会按 GBK 读坏中文），对 .cmd 也不可靠。所以**每次改完
 *   启动脚本都要跑一遍这个**，否则改完看着没问题、双击就坏。
 *
 * 用法: node tools/fix-launchers.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

const TARGETS = [
  { file: '启动.cmd', bom: false },
  { file: '启动.ps1', bom: true },
];

for (const t of TARGETS) {
  const full = path.join(ROOT, t.file);
  const buf = fs.readFileSync(full);
  const hadBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const text = (hadBom ? buf.subarray(3) : buf).toString('utf8');

  const crlfBefore = (text.match(/\r\n/g) || []).length;
  const nlBefore = (text.match(/\n/g) || []).length;

  // 统一成 LF 再统一成 CRLF，避免 \r\r\n
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const body = Buffer.from(normalized, 'utf8');
  const out = t.bom ? Buffer.concat([BOM, body]) : body;
  fs.writeFileSync(full, out);

  const changes = [];
  if (hadBom !== t.bom) changes.push(`BOM ${hadBom ? '有→无' : '无→有'}`);
  if (crlfBefore !== nlBefore) changes.push(`行尾 LF→CRLF（${nlBefore} 行）`);
  console.log(`  ${t.file}: ${changes.length ? changes.join(' · ') : '已经是规范形态'}`);
}

// 顺手跑一遍检查，不通过就非零退出
console.log('\n复查：');
const { execFileSync } = require('node:child_process');
try {
  process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, 'check-launchers.js')], { encoding: 'utf8' }));
} catch (e) {
  process.stdout.write(String(e.stdout || ''));
  process.exit(1);
}
