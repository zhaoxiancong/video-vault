#!/usr/bin/env node
'use strict';
/**
 * 启动脚本形态检查 —— 这两个脚本坏掉的症状是"双击没反应"，很难查，
 * 所以把它们的字节级要求固化成一条自动检查。
 *
 * 三条要求都是**实测撞出来的**，别改成"看起来更整齐"的样子：
 *
 *   1. `启动.cmd` **必须是纯 ASCII**。cmd.exe 用系统 ANSI 代码页解析 .cmd 文件，
 *      而 `chcp 65001` 只改变*输出*。于是多字节 UTF-8 字符被拆错，
 *      cmd 把中文提示当成命令去执行，每一行中文都报
 *      `<乱码> is not recognized as an internal or external command`，
 *      **服务根本起不来**。中文提示放 tools/launcher-banner.js。
 *
 *   2. `启动.ps1` **必须带 UTF-8 BOM**。PowerShell 5.1 读无 BOM 的 UTF-8 会按
 *      系统 ANSI（GBK）解析 → 中文注释与提示乱码，严重时把引号吃掉直接语法错误。
 *      （和 AGENTS.md 里记的 `.ps1` BOM 坑同源。）
 *
 *   3. 两个都**用 CRLF 行尾**。cmd.exe 对 LF-only 批处理支持不可靠 ——
 *      实测把 LF 改成 CRLF 之前，脚本每一行中文都在报错。
 *
 * 另外查一条逻辑约束：启动命令必须是**绝对路径**（`%~dp0` / `Join-Path`），
 * 否则命令行里没有项目路径，工作区的 kill-safe.js 认不出归属、会保守拒绝清理。
 *
 * 用法：node tools/check-launchers.js
 * 退出码非 0 表示有问题（可以挂到 CI / npm run check 上）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const TARGETS = [
  {
    file: '启动.cmd',
    asciiOnly: true,
    bom: false,
    // 反例是好例子：这里必须是绝对路径启动
    mustMatch: [[/%~dp0src\\main\.js/, '用 %~dp0 绝对路径启动 src\\main.js']],
    mustNotMatch: [[/^\s*node\s+src\\main\.js/m, '出现相对路径启动（kill-safe 会认不出归属）']],
  },
  {
    file: '启动.ps1',
    asciiOnly: false,
    bom: true,
    mustMatch: [
      [/Join-Path\s+\$root\s+'src\\main\.js'/, '用 Join-Path 绝对路径启动 src\\main.js'],
      [/VAULT_PORT/, '把 -Port 传给服务'],
      [/--open/, '把 --open 传给服务（让服务自己开浏览器）'],
    ],
    // 这两样都用不得：
    //   · 后台作业依赖命名管道与子进程 IPC，受限环境会失败
    //   · 后台起服务会脱离窗口，"关窗即停"就成了假话
    mustNotMatch: [
      [/Start-Job|Start-ThreadJob/, '用了 PowerShell 后台作业（依赖命名管道，受限环境会失败）'],
      [/Start-Process\s+-FilePath\s+'node'/, '把服务放到后台起（会脱离窗口，"关窗即停"就成了假话）'],
    ],
  },
];

let problems = 0;
const ok = [];

function fail(msg) { problems += 1; console.log(`  ✘ ${msg}`); }

for (const t of TARGETS) {
  const full = path.join(ROOT, t.file);
  if (!fs.existsSync(full)) { fail(`${t.file} 不存在`); continue; }

  const buf = fs.readFileSync(full);
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const text = (hasBom ? buf.subarray(3) : buf).toString('utf8');

  // 1. 非 ASCII
  if (t.asciiOnly) {
    const bad = [...text].filter((c) => c.charCodeAt(0) > 127);
    if (bad.length) {
      fail(`${t.file} 含 ${bad.length} 个非 ASCII 字符（cmd.exe 会把它们当命令执行）`
        + ` —— 例：${JSON.stringify(bad.slice(0, 12).join(''))}。`
        + '中文提示请放 tools/launcher-banner.js');
    }
  }

  // 2. BOM
  if (hasBom !== t.bom) {
    fail(t.bom
      ? `${t.file} 缺少 UTF-8 BOM（PowerShell 5.1 会按 GBK 读坏中文）`
      : `${t.file} 多了 UTF-8 BOM`);
  }

  // 3. 行尾
  const crlf = (text.match(/\r\n/g) || []).length;
  const totalNl = (text.match(/\n/g) || []).length;
  if (totalNl === 0) fail(`${t.file} 一行都没有？`);
  else if (crlf !== totalNl) {
    fail(`${t.file} 行尾混用：CRLF ${crlf} / 换行总数 ${totalNl}`
      + '（cmd.exe 对 LF-only 批处理支持不可靠）');
  }

  // 4. 逻辑约束
  for (const [re, label] of t.mustMatch || []) {
    if (!re.test(text)) fail(`${t.file} 没有${label}`);
  }
  for (const [re, label] of t.mustNotMatch || []) {
    if (re.test(text)) fail(`${t.file} ${label}`);
  }

  if (!problems) ok.push(`${t.file} 形态正确`);
}

console.log('');
for (const s of ok) console.log(`  ✔ ${s}`);
console.log('');
if (problems) {
  console.log(`  ${problems} 个问题需要修。\n`);
  process.exit(1);
}
console.log('  启动脚本检查通过。\n');
