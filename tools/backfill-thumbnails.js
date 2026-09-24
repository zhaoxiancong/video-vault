#!/usr/bin/env node
'use strict';
/**
 * 给"有视频文件但没有封面"的记录**从视频里抽一帧**当封面。
 *
 * 为什么需要它：封面本来是在**下载完成时**由 `media.grabThumbnail()` 抽的
 * （先 ffmpeg 从文件抽、失败再抓网络封面）。但记录一旦是从磁盘**重建**出来的，
 * 就没人再走那条路了 —— 文件里明明嵌着封面（实测 mkv/mp4 里都有 mjpeg 流），
 * 界面上却是"无封面"。
 *
 * 所以这不是新功能，是**把已有机制补跑一遍**：
 * 复用同一套抽帧参数（`-map 0:v -map -0:V -frames:v 1 -vf scale=480:-2`），
 * 存到同一个地方（`data/thumbs/{id}.jpg`），写同一个字段（`thumbnail_path`）。
 *
 * 用法：
 *   node tools/backfill-thumbnails.js            预演（只报告能抽多少张）
 *   node tools/backfill-thumbnails.js --yes      真的抽并写库
 *   node tools/backfill-thumbnails.js --yes --limit 5   只做前 5 条（试水）
 */
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, ensureDirs } = require('../src/infra/config');
const { createDatabase } = require('../src/infra/database');
const { createMediaTools, isFragment } = require('../src/infra/media');

const APP_ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const apply = args.includes('--yes');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;

const config = loadConfig({ root: APP_ROOT });
ensureDirs(config);
const repo = createDatabase(config);
const media = createMediaTools(config);

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[90m', x: '\x1b[0m' }
  : { g: '', y: '', d: '', x: '' };

const all = repo.listVideosAll({});
/**
 * ⚠️ 跳过 yt-dlp 的**中间分片**（如 `标题 [1080p100026+30280].f30280.m4a`）。
 *
 * 那种文件是"只有音频"或"只有视频"的半成品，抽不出封面（本来就不是完整视频），
 * 而且它存在说明**这条记录指向的是没下完的残件** —— 该做的是重下，不是给它配封面。
 */
const need = all.filter((v) => v.file_path && !v.thumbnail_path
  && fs.existsSync(v.file_path) && !isFragment(v.file_path));
const fragments = all.filter((v) => v.file_path && !v.thumbnail_path
  && fs.existsSync(v.file_path) && isFragment(v.file_path));
const noFile = all.filter((v) => !v.file_path);
const hasThumb = all.filter((v) => v.thumbnail_path);

console.log(`库里 ${all.length} 条：`);
console.log(`  已有封面      ${hasThumb.length} 条`);
console.log(`  有文件但缺封面 ${need.length} 条  ← 要补的就是这些`);
console.log(`  只有中间分片   ${fragments.length} 条  ← 跳过（半成品，抽不出封面，该重下）`);
console.log(`  没有文件      ${noFile.length} 条（抽不了，本来就是失败任务）`);
if (fragments.length) {
  console.log('  分片记录示例：');
  for (const v of fragments.slice(0, 4)) {
    console.log(`    id=${v.id}  ${path.basename(v.file_path).slice(0, 56)}`);
  }
}

const todo = limit > 0 ? need.slice(0, limit) : need;
if (!apply) {
  console.log(`\n${C.y}[预演]${C.x} 将对 ${todo.length} 条抽帧，不写库。`);
  console.log('  前 5 条示例：');
  for (const v of todo.slice(0, 5)) {
    console.log(`    id=${v.id}  ${path.basename(v.file_path).slice(0, 52)}`);
  }
  console.log(`\n确认没问题就加 --yes 真正执行。`);
  process.exit(0);
}

console.log(`\n开始抽帧（${todo.length} 条）…`);
const t0 = Date.now();
let ok = 0;
let failed = 0;
let skipped = 0;

for (const v of todo) {
  // 复用 media 里那条路径：它先 ffmpeg 抽帧，失败再抓网络封面
  const dest = media.grabThumbnail(v, v.file_path);
  if (dest && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    repo.updateVideo(v.id, { thumbnail_path: dest });
    ok += 1;
    if (ok % 20 === 0) {
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  已补 ${ok} 张 …（${secs}s）`);
    }
  } else {
    failed += 1;
    if (failed <= 5) console.log(`  ${C.y}抽不出来${C.x} id=${v.id} ${path.basename(v.file_path).slice(0, 44)}`);
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n${C.g}完成${C.x}：补上 ${ok} 张 · 抽不出 ${failed} 张 · 跳过 ${skipped} 张 · 用时 ${secs}s`);

const after = repo.listVideosAll({}).filter((v) => v.thumbnail_path).length;
console.log(`库里现在有封面的：${after} / ${all.length} 条`);
console.log(`\n${C.d}封面存在 ${config.paths.thumbs}，文件名是记录 id（如 671.jpg）。${C.x}`);
