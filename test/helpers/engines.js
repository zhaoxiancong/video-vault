'use strict';
/**
 * 引擎可用性探测 —— 让"没装 yt-dlp / ffmpeg"时的测试**诚实跳过**。
 *
 * 这个文件解决的是一类很危险的假象，两个真实教训：
 *
 *   1. 原先的写法是 `if (!f) { console.log('⏭ 跳过'); return; }` ——
 *      汇总里显示的是 **✔ 通过**。也就是说：一条断言都没跑，却和"真测过了"
 *      长得一模一样。当年整片需要 ffmpeg 的测试在没引擎的机器上集体假绿。
 *
 *   2. 引擎（`tools/bin/`，约 344MB）**不进 git**，靠 `npm run setup` 下载。
 *      所以刚 clone 下来的仓库本来就没有引擎 —— 这时有 4 条测试会硬失败，
 *      让 clone 的人以为代码是坏的。**公开仓库第一条命令就飘红，是不可接受的。**
 *
 * 于是这里统一成：有引擎 → 照常跑全量；没引擎 → node:test 原生 skip
 * （汇总里单独算"跳过"，不混进"通过"），并且跳过原因里写清**怎么办**。
 *
 * 刻意只用 `fs.existsSync`：探测必须是**便宜且无副作用**的，不能为了判断
 * ffmpeg 在不在就真的去启动一次 ffmpeg（那会在受限沙箱里变成另一个坑）。
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../../src/infra/config');

/** 真实项目根 —— 只有用真 root，`tools/bin/` 才可达（用 tmp 会静默走"没引擎"分支） */
const APP_ROOT = path.resolve(__dirname, '..', '..');
const PATHS = loadConfig({ root: APP_ROOT }).paths;

const SETUP_HINT = '先跑 `npm run setup` 下载引擎（约 344MB，只下一次）';

/** 探测一个可执行文件在不在 */
function probe(file, label) {
  if (fs.existsSync(file)) return { ok: true, label, path: file, reason: '' };
  return {
    ok: false,
    label,
    path: file,
    reason: `${label} 没装（找不到 ${file}）—— ${SETUP_HINT}`,
  };
}

const engines = {
  ytdlp: probe(PATHS.ytdlp, 'yt-dlp'),
  ffmpeg: probe(PATHS.ffmpeg, 'ffmpeg'),
  ffprobe: probe(PATHS.ffprobe, 'ffprobe'),
};

/**
 * 给 node:test 的 `{ skip }` 选项用。
 *
 * 用法：`test('名字', { skip: skipWithout('ffmpeg') }, () => { ... })`
 *
 * 缺引擎时返回原因字符串（测试被标记为"跳过"），否则返回 `false`（照常跑）。
 * 返回 `false` 而不是 `undefined` 是刻意的 —— node:test 把 `{skip: ''}` 之类的
 * 假值都当"不跳过"，但显式的 `false` 读代码时意图最清楚。
 *
 * @param {'ytdlp'|'ffmpeg'|'ffprobe'} name
 * @returns {string|false}
 */
function skipWithout(name) {
  const e = engines[name];
  if (!e) throw new Error(`未知引擎：${name}（只有 ytdlp / ffmpeg / ffprobe）`);
  return e.ok ? false : e.reason;
}

/** 三个引擎是否齐全 —— 用来打一行提示，告诉用户"这次有多少东西没测" */
const allPresent = Object.values(engines).every((e) => e.ok);

/** 缺了哪些引擎的可读清单（全都在时返回空数组） */
function missing() {
  return Object.values(engines).filter((e) => !e.ok).map((e) => e.label);
}

module.exports = { engines, skipWithout, allPresent, missing, APP_ROOT, PATHS, SETUP_HINT };
