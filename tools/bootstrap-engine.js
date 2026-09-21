#!/usr/bin/env node
'use strict';
/**
 * 下载并安装运行所需的两个引擎到 tools/bin/。
 *
 * 为什么不把引擎直接提交进仓库：yt-dlp.exe 约 18MB，ffmpeg + ffprobe 各约 163MB，
 * 合计约 344MB —— 那是绝大多数 clone 的人不需要承担的体积（而且 ffmpeg 官方
 * 构建的许可证条款也不适合直接塞进 MIT 项目）。
 *
 *   node tools/bootstrap-engine.js            装 yt-dlp 和 ffmpeg
 *   node tools/bootstrap-engine.js --ytdlp    只装 yt-dlp
 *   node tools/bootstrap-engine.js --ffmpeg   只装 ffmpeg
 *   node tools/bootstrap-engine.js --check    只检查现状，不下载
 *
 * ⚠️ 两条踩过的坑，写在这里省得下次再踩：
 *
 * 1. **yt-dlp 必须用目录式分发包（yt-dlp_win.zip），不能用单文件 exe。**
 *    官方 onefile 版会在 %TEMP% 里自解包，受限环境下会被拒绝，
 *    报 "Failed to create parent directory structure"。
 *    见 README 坑 2。
 *
 * 2. **ffmpeg 用 gyan.dev 的 essentials 构建**：体积小、解码器够用。
 *    （yt-dlp 官方推荐的 BtbN 构建也行，改 URL 即可。）
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'tools', 'bin');
const YTDLP_DIR = path.join(BIN, 'ytdlp-win');
const YTDLP_EXE = path.join(YTDLP_DIR, 'yt-dlp.exe');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip';
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

const args = process.argv.slice(2);
const onlyYtdlp = args.includes('--ytdlp');
const onlyFfmpeg = args.includes('--ffmpeg');
const checkOnly = args.includes('--check');

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[90m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', d: '', B: '', x: '' };

function human(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(1)} ${u[i]}`;
}

/** 现状检查 */
function status() {
  const ytdlpOk = fs.existsSync(YTDLP_EXE);
  const internalOk = fs.existsSync(path.join(YTDLP_DIR, '_internal'));
  const ffmpegOk = fs.existsSync(path.join(BIN, 'ffmpeg.exe'));
  const ffprobeOk = fs.existsSync(path.join(BIN, 'ffprobe.exe'));
  return { ytdlpOk, internalOk, ffmpegOk, ffprobeOk };
}

function printStatus(s) {
  console.log(`${C.B}引擎现状${C.x}  ${C.d}${BIN}${C.x}`);
  console.log(`  ${s.ytdlpOk && s.internalOk ? `${C.g}✔` : `${C.r}✘`}${C.x} yt-dlp   ${YTDLP_EXE}`);
  if (s.ytdlpOk && !s.internalOk) {
    console.log(`      ${C.y}⚠ 旁边缺少 _internal 目录 —— 这是单文件版，跑不起来（见脚本注释）${C.x}`);
  }
  console.log(`  ${s.ffmpegOk ? `${C.g}✔` : `${C.r}✘`}${C.x} ffmpeg   ${path.join(BIN, 'ffmpeg.exe')}`);
  console.log(`  ${s.ffprobeOk ? `${C.g}✔` : `${C.r}✘`}${C.x} ffprobe  ${path.join(BIN, 'ffprobe.exe')}`);
  return s.ytdlpOk && s.internalOk && s.ffmpegOk && s.ffprobeOk;
}

/**
 * 下载到临时文件。
 * 用 Node 自带的 fetch —— 本机 PowerShell 走 schannel 直连 GitHub 会报
 * SEC_E_NO_CREDENTIALS（见 AGENTS.md），Node 的 TLS 栈不受影响。
 */
async function download(url, dest, label) {
  console.log(`  ${C.d}下载 ${label} …${C.x}`);
  console.log(`  ${C.d}${url}${C.x}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length') || 0);
  const chunks = [];
  let got = 0;
  let lastPrint = 0;

  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    const now = Date.now();
    if (now - lastPrint > 400) {
      lastPrint = now;
      const pct = total ? ` ${((got / total) * 100).toFixed(0)}%` : '';
      process.stdout.write(`\r    ${human(got)}${total ? ` / ${human(total)}` : ''}${pct}      `);
    }
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  fs.writeFileSync(dest, Buffer.concat(chunks));
  console.log(`  ${C.g}✔${C.x} ${human(got)} → ${path.basename(dest)}`);
  return got;
}

/** 用 PowerShell 解压（Windows 自带 Expand-Archive，不用引第三方 zip 库） */
function unzip(zipPath, destDir) {
  console.log(`  ${C.d}解压到 ${path.relative(ROOT, destDir)} …${C.x}`);
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; `
    + `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' `
    + `-DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
  if (r.status !== 0) {
    throw new Error(`解压失败：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  }
}

/** 在目录里递归找某个文件名，找到就返回完整路径 */
function findFile(dir, name, depth = 0) {
  if (depth > 6) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;
    if (e.isDirectory()) {
      const hit = findFile(full, name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function installYtdlp() {
  console.log(`\n${C.B}yt-dlp${C.x}`);
  const tmp = path.join(BIN, '_ytdlp-download.zip');
  await download(YTDLP_URL, tmp, 'yt-dlp_win.zip');

  // 目录式分发包解出来通常是 yt-dlp.exe + _internal/ 同级
  fs.mkdirSync(YTDLP_DIR, { recursive: true });
  unzip(tmp, YTDLP_DIR);
  fs.rmSync(tmp, { force: true });

  // 有的版本会多套一层目录，把内容提上来
  if (!fs.existsSync(YTDLP_EXE)) {
    const found = findFile(YTDLP_DIR, 'yt-dlp.exe');
    if (found && path.dirname(found) !== YTDLP_DIR) {
      const from = path.dirname(found);
      for (const e of fs.readdirSync(from)) {
        fs.renameSync(path.join(from, e), path.join(YTDLP_DIR, e));
      }
      console.log(`  ${C.d}（从子目录 ${path.basename(from)}/ 提到了 ytdlp-win/）${C.x}`);
    }
  }

  if (!fs.existsSync(YTDLP_EXE)) throw new Error('解压后没找到 yt-dlp.exe');
  if (!fs.existsSync(path.join(YTDLP_DIR, '_internal'))) {
    throw new Error('缺少 _internal 目录 —— 下到的可能是单文件版，这在受限环境下跑不起来');
  }
  console.log(`  ${C.g}✔ yt-dlp 就位${C.x}`);
}

async function installFfmpeg() {
  console.log(`\n${C.B}ffmpeg / ffprobe${C.x}`);
  const tmp = path.join(BIN, '_ffmpeg-download.zip');
  await download(FFMPEG_URL, tmp, 'ffmpeg-release-essentials.zip');

  const staging = path.join(BIN, '_ffmpeg-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  unzip(tmp, staging);
  fs.rmSync(tmp, { force: true });

  let moved = 0;
  for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
    const found = findFile(staging, exe);
    if (!found) throw new Error(`解压后没找到 ${exe}`);
    fs.copyFileSync(found, path.join(BIN, exe));
    moved += 1;
  }
  fs.rmSync(staging, { recursive: true, force: true });
  console.log(`  ${C.g}✔ ${moved} 个可执行文件就位${C.x}`);
}

async function main() {
  fs.mkdirSync(BIN, { recursive: true });

  if (checkOnly) {
    const ok = printStatus(status());
    process.exitCode = ok ? 0 : 1;
    return;
  }

  console.log(`${C.B}准备下载引擎到 tools/bin/${C.x}`);
  console.log(`${C.d}这两个引擎体积不小（合计约 344MB），所以没有放进仓库。${C.x}`);

  const before = status();
  const wantYtdlp = !onlyFfmpeg && !(before.ytdlpOk && before.internalOk);
  const wantFfmpeg = !onlyYtdlp && !(before.ffmpegOk && before.ffprobeOk);

  if (!wantYtdlp && !wantFfmpeg) {
    console.log(`\n${C.g}两个引擎都已经在了，不用下载。${C.x}\n`);
    printStatus(status());
    return;
  }

  if (wantYtdlp) await installYtdlp();
  else console.log(`\n${C.d}yt-dlp 已存在，跳过${C.x}`);

  if (wantFfmpeg) await installFfmpeg();
  else console.log(`\n${C.d}ffmpeg 已存在，跳过${C.x}`);

  console.log('');
  const ok = printStatus(status());
  console.log(ok ? `\n${C.g}引擎准备好了，可以启动工具了。${C.x}\n`
    : `\n${C.r}还有缺失，请看上面的 ✘。${C.x}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`\n${C.r}安装失败：${e.message}${C.x}`);
    console.error(`${C.d}可以手工下载：`);
    console.error(`  yt-dlp : ${YTDLP_URL}   → 解压到 tools/bin/ytdlp-win/`);
    console.error(`  ffmpeg : ${FFMPEG_URL} → 把 ffmpeg.exe / ffprobe.exe 放进 tools/bin/${C.x}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, status, printStatus, BIN, YTDLP_EXE };
