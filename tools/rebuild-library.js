#!/usr/bin/env node
'use strict';
/**
 * 从磁盘重建视频库 —— **库万一没了，用它把记录找回来**。
 *
 * 这个脚本存在的原因是一次真实事故：验证「清空已完成记录」时，
 * 我直接对用户的真实库执行了操作，真删掉了 7 条记录。
 * 好消息是**视频文件全在磁盘上**，而且命名规则本身就带信息：
 *     downloads/<站点>/<作者>/<标题> [<高度>p<格式号>].<扩展名>
 * 加上 ffprobe 实测和已有封面，足以把记录重建回来。
 *
 * 用不了/恢复不了的：原始 URL、发布时间、简介（yt-dlp 的元数据已随下载丢失）。
 * 这些会在最后明确列出来，让用户知道缺什么 —— 而不是假装全都恢复了。
 *
 * 用法：
 *   node tools/rebuild-library.js            预演（只报告，不写库）
 *   node tools/rebuild-library.js --yes      真的写库
 *   node tools/rebuild-library.js --data <目录> --downloads <目录>   指定目录（测试用）
 *
 * ⚠️ 默认是**预演**。这个脚本会往库里插记录，不给它一个明确的 --yes
 *    就不该动用户的数据 —— 跟工作区里 kill-safe.js 的约定一致。
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, ensureDirs, STATUS } = require('../src/infra/config');
const { createDatabase } = require('../src/infra/database');
const { createMediaTools } = require('../src/infra/media');

const APP_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const apply = args.includes('--yes');
/** 取 `--flag value` 形式的参数 */
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const dataOverride = flagValue('--data');
const downloadsOverride = flagValue('--downloads');

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[90m', B: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', d: '', B: '', x: '' };

const VIDEO_EXT_RE = /\.(mp4|mkv|webm|mp3|m4a)$/i;
/** 测试产物不算"用户的视频" */
const TEST_DIR_RE = /^_(selftest|deltest|converted)$/i;

/** 扫磁盘上所有视频文件 */
function scanVideos(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (TEST_DIR_RE.test(e.name)) continue;
      scanVideos(full, out);
      continue;
    }
    if (!VIDEO_EXT_RE.test(e.name)) continue;
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    out.push({ file: full, name: e.name, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/**
 * 从相对路径与文件名反推 站点/作者/标题/清晰度。
 * 命名规则是 `站点/作者/标题 [高度p格式号].ext`，信息量足够。
 */
function parseName(rel, name) {
  const parts = rel.split(path.sep);
  const site = parts.length >= 3 ? parts[0] : null;
  const uploader = parts.length >= 3 ? parts[1] : null;
  const stem = name.replace(/\.[^.]+$/, '');
  // 去掉结尾的 [1080p30077+30280] 这类清晰度标记
  const m = stem.match(/^(.*?)\s*\[(\d{3,4})p[^\]]*\]$/);
  const title = (m ? m[1] : stem).trim();
  const height = m ? Number(m[2]) : null;
  return { site, uploader, title, height };
}

async function main() {
  const config = loadConfig({
    root: APP_ROOT,
    ...(dataOverride ? { data: dataOverride } : {}),
    ...(downloadsOverride ? { downloads: downloadsOverride } : {}),
  });
  ensureDirs(config);

  const repo = createDatabase(config);
  const media = createMediaTools(config);

  console.log(`\n${C.B}从磁盘重建视频库${C.x}`);
  console.log(`${C.d}下载目录 ${config.paths.downloads}${C.x}`);
  console.log(`${C.d}数据库   ${config.paths.db}${C.x}`);
  if (!apply) console.log(`${C.y}预演模式（不会写库）。确认无误后加 --yes 真正执行。${C.x}`);

  const found = scanVideos(config.paths.downloads);
  console.log(`\n磁盘上找到 ${found.length} 个媒体文件\n`);

  if (!found.length) {
    console.log('  （下载目录里没有媒体文件，没什么可重建的）\n');
    repo.close();
    return;
  }

  const existing = new Set(
    repo.raw.prepare('SELECT file_path FROM videos WHERE file_path IS NOT NULL').all()
      .map((r) => path.normalize(r.file_path).toLowerCase()),
  );

  let added = 0;
  let skipped = 0;
  const planned = [];

  for (const x of found) {
    const key = path.normalize(x.file).toLowerCase();
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    const p = parseName(path.relative(config.paths.downloads, x.file), x.name);
    // 实测媒体信息 —— 文件大小不可信（可能是半截的），ffprobe 说了算
    const info = media.probe(x.file) || {};
    planned.push({ x, p, info });
  }

  for (const { x, p, info } of planned) {
    // url 有唯一约束，重建时用本地占位地址，避免和以后重新添加的真实 URL 冲突。
    // 用户之后把原始链接再粘一次，dedupeByFile 会把两条合并成一条。
    const placeholder = `local://${encodeURIComponent(path.relative(config.paths.downloads, x.file))}`;

    if (!apply) {
      console.log(`  ${C.d}[预演]${C.x} ${p.title.slice(0, 48)}`);
      console.log(`         ${C.d}${p.site || '?'}/${p.uploader || '?'}  ${(x.size / 1048576).toFixed(1)}MB  `
        + `${info.width || '?'}x${info.height || p.height || '?'}  ${info.duration || '?'}s${C.x}`);
      added += 1;
      continue;
    }

    try {
      repo.insertVideo({
        url: placeholder,
        title: p.title,
        uploader: p.uploader,
        site: p.site,
        kind: /\.(mp3|m4a)$/i.test(x.name) ? 'audio' : 'video',
        quality: p.height ? `${p.height}p` : 'best',
        status: STATUS.DONE,
        progress: 100,
        file_path: x.file,
        file_size: x.size,
        container: path.extname(x.name).replace('.', ''),
        duration: info.duration || null,
        width: info.width || null,
        height: info.height || p.height || null,
        fps: info.fps || null,
        vcodec: info.vcodec || null,
        acodec: info.acodec || null,
        finished_at: new Date(x.mtimeMs).toISOString(),
        notes: '从磁盘重建（原库记录已丢失，URL/简介不可恢复）',
      });
      added += 1;
      console.log(`  ${C.g}✔${C.x} ${p.title.slice(0, 48)}`);
    } catch (e) {
      console.log(`  ${C.r}✘${C.x} ${p.title.slice(0, 40)} —— ${e.message}`);
    }
  }

  console.log('');
  console.log(apply
    ? `  ${C.g}已重建 ${added} 条记录${C.x}，跳过 ${skipped} 条（已在库中）`
    : `  ${C.y}预演：将重建 ${added} 条记录${C.x}，跳过 ${skipped} 条（已在库中）`);

  // 封面：文件名是旧记录 id，映射关系已随记录丢失，不强行配对
  let thumbs = [];
  try { thumbs = fs.readdirSync(config.paths.thumbs); } catch { /* 没有就没有 */ }
  if (thumbs.length && added) {
    console.log(`\n  ${C.d}磁盘上还有 ${thumbs.length} 张封面，但文件名是旧记录 id，`
      + `映射关系已随记录丢失，未强行配对。${C.x}`);
    console.log(`  ${C.d}重新粘一次原始链接可以补回封面和简介。${C.x}`);
  }

  if (added) {
    console.log(`\n${C.y}⚠️ 以下内容无法从磁盘恢复${C.x}（yt-dlp 的元数据已随原记录丢失）：`);
    console.log('   · 原始 URL  → 把原来的链接重新粘一次即可，文件已存在会跳过下载、只补元数据');
    console.log('   · 发布时间、简介、精确的封面映射');
    console.log('   · 收藏标记与备注');
    console.log('   文件本身完好，不影响播放、搜索、转码。');
  }
  console.log('');

  repo.close();
}

main().catch((e) => {
  console.error(`\n${C.r}重建失败：${e.message}${C.x}\n`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
