'use strict';
/**
 * 从磁盘重建视频库。
 *
 * 起因：我在测试"清空已完成记录"时真删掉了库里的记录（这是我的失误）。
 * 好消息是**视频文件全在磁盘上**，而且命名规则本身就带信息：
 *     downloads\<站点>\<作者>\<标题> [<高度>p<格式号>].<扩展名>
 * 加上每个视频的 ffprobe 信息和已有封面，足以把记录重建回来。
 *
 * 无法恢复的：原始 URL、发布时间、简介（yt-dlp 的元数据已随下载丢失）。
 * 这些会在最后明确列出来，让用户知道缺什么。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { probeMedia } = require('./lib/queue');

const DL = path.resolve(__dirname, '..', 'downloads');
const THUMBS = path.resolve(__dirname, '..', 'data', 'thumbs');
const db = new DatabaseSync(path.resolve(__dirname, '..', 'data', 'vault.db'));

// 1) 磁盘上的视频（排除测试目录）
const found = [];
(function walk(d) {
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) {
      if (/^_(selftest|deltest)$/i.test(e.name)) continue;   // 测试产物不算
      walk(f); continue;
    }
    if (!/\.(mp4|mkv|webm|mp3|m4a)$/i.test(e.name)) continue;
    const st = fs.statSync(f);
    found.push({ file: f, name: e.name, size: st.size, rel: path.relative(DL, f) });
  }
})(DL);

console.log(`\n在磁盘上找到 ${found.length} 个视频文件\n`);

/** 从相对路径与文件名反推 站点/作者/标题/清晰度 */
function parse(rel, name) {
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

// 2) 已有封面（文件名是 <video_id>.jpg，但记录已删，只能按序号猜；先留着不用）
const thumbFiles = fs.existsSync(THUMBS) ? fs.readdirSync(THUMBS) : [];

let added = 0;
const lost = [];

for (const x of found) {
  const p = parse(x.rel, x.name);
  // 去重：同路径只插一次
  const exists = db.prepare('SELECT id FROM videos WHERE file_path = ?').get(x.file);
  if (exists) { console.log(`  跳过（已在库中）: ${x.name.slice(0, 50)}`); continue; }

  const media = probeMedia(x.file) || {};

  // url 有唯一约束，重建时用本地占位地址，避免和以后重新添加的真实 URL 冲突
  const placeholder = `local://${encodeURIComponent(x.rel)}`;

  const info = db.prepare(
    `INSERT INTO videos
       (url, title, uploader, site, kind, quality, status, progress,
        file_path, file_size, container, duration, width, height, fps, vcodec, acodec,
        thumb_format, finished_at, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),?)`
  ).run(
    placeholder,
    p.title,
    p.uploader,
    p.site,
    /\.(mp3|m4a)$/i.test(x.name) ? 'audio' : 'video',
    p.height ? `${p.height}p` : 'best',
    'done', 100,
    x.file,
    x.size,
    path.extname(x.name).replace('.', ''),
    media.duration || null,
    media.width || null,
    media.height || p.height || null,
    media.fps || null,
    media.vcodec || null,
    media.acodec || null,
    null,
    '从磁盘重建（原库记录已丢失，URL/简介不可恢复）'
  );
  added++;
  lost.push({ id: Number(info.lastInsertRowid), title: p.title, rel: x.rel });
  console.log(`  ✅ 重建: [${p.site}/${p.uploader}] ${p.title.slice(0, 44)}`);
  console.log(`       ${(x.size / 1048576).toFixed(1)} MB  ${media.width || '?'}x${media.height || p.height || '?'}  ${media.duration || '?'}s`);
}

console.log(`\n共重建 ${added} 条记录`);

// 3) 尝试把封面按"文件 mtime 与视频最接近"配对（原记录已删，只能近似）
if (thumbFiles.length && added) {
  console.log(`\n磁盘上还有 ${thumbFiles.length} 张封面（${thumbFiles.slice(0, 8).join(', ')}）`);
  console.log('  但封面文件名是旧记录 id，映射关系已随记录丢失，未强行配对。');
}

console.log('\n=== 当前库 ===');
db.prepare('SELECT id,status,site,uploader,substr(title,1,46) AS t FROM videos ORDER BY id')
  .all().forEach((r) => console.log(`  id=${String(r.id).padStart(3)} [${r.status}] ${r.site || '?'}/${r.uploader || '?'}  ${r.t}`));

if (lost.length) {
  console.log('\n⚠️ 以下内容无法从磁盘恢复（yt-dlp 的元数据已随原记录丢失）：');
  console.log('   · 原始 URL  → 想恢复的话，把原来的链接重新粘一次即可（文件已存在会跳过下载，只补元数据）');
  console.log('   · 发布时间、简介、精确封面映射');
  console.log('   · 收藏标记与备注');
  console.log('   文件本身完好，不影响播放、搜索、转码。');
}
console.log('');
