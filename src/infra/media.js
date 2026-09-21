'use strict';
/**
 * 媒体文件探测与清理 —— 围绕 ffprobe / ffmpeg 的文件级工具。
 *
 * 这个模块里最值钱的一条是 `isPlayable()`：
 *
 *   **文件"存在"不等于"完整"。**
 *
 * 上一次下载被中断会留下半截分片，yt-dlp 合并时读到坏数据直接报
 * `Invalid data found when processing input`，但最终文件确实躺在磁盘上 ——
 * 只判断 `fs.existsSync()` 会把它当成下载成功（README 坑 11）。
 * 所以这里一律**实测**：用 ffprobe 读出真实时长/分辨率才算数。
 */

const fs = require('node:fs');
const path = require('node:path');

const { runSync } = require('./subprocess');

/** 认得出的媒体扩展名（扫目录兜底时用） */
const MEDIA_EXT_RE = /\.(mp4|mkv|webm|mp3|m4a|opus|flac|wav|mov|avi)$/i;
/** 纯音频扩展名（isPlayable 对它们不要求分辨率） */
const AUDIO_EXT_RE = /\.(mp3|m4a|opus|flac|wav|aac)$/i;
/** 半截文件 */
const PARTIAL_EXT_RE = /\.(part|ytdl|temp|tmp)$/i;

/**
 * @param {object} config loadConfig() 产物
 */
function createMediaTools(config) {
  const { paths } = config;

  /**
   * 用 ffprobe 读真实媒体信息。
   *
   * ⚠️ 输出走临时文件而不是管道 —— 沙箱会拒管道（见 infra/subprocess 的说明）。
   *
   * @returns {object|null} null = 探测失败（文件坏了 / ffprobe 缺失）
   */
  function probe(filePath) {
    if (!fs.existsSync(paths.ffprobe)) return null;
    const tmp = path.join(paths.data, `_ffprobe-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    let fd;
    try {
      fd = fs.openSync(tmp, 'w');
      const r = runSync(paths.ffprobe, [
        '-v', 'error', '-print_format', 'json',
        '-show_format', '-show_streams', filePath,
      ], { timeout: 60000 });
      fs.closeSync(fd);
      fd = null;
      if (!r.ranOk || r.status !== 0) return null;

      const data = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      const v = (data.streams || []).find((s) => s.codec_type === 'video');
      const a = (data.streams || []).find((s) => s.codec_type === 'audio');
      return {
        file_size: Number(data.format && data.format.size) || null,
        duration: data.format && data.format.duration
          ? Math.round(Number(data.format.duration)) : null,
        width: (v && v.width) || null,
        height: (v && v.height) || null,
        fps: v && v.r_frame_rate ? evalFps(v.r_frame_rate) : null,
        vcodec: (v && v.codec_name) || null,
        acodec: (a && a.codec_name) || null,
      };
    } catch {
      return null;
    } finally {
      if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    }
  }

  /** "30000/1001" → 29.97 */
  function evalFps(rate) {
    const [a, b] = String(rate).split('/').map(Number);
    if (!b) return a || null;
    return Math.round((a / b) * 100) / 100;
  }

  /**
   * 实测一个媒体文件是不是**真的能用**。
   * 判据：至少有时长；视频文件还必须能读出分辨率。
   */
  function isPlayable(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    try {
      if (fs.statSync(filePath).size < 1024) return false;
    } catch { return false; }

    // 没有 ffprobe 就不阻断流程（宁可放过，也不要因为工具缺失把好文件判死）
    if (!fs.existsSync(paths.ffprobe)) return true;

    const p = probe(filePath);
    if (!p) return false;
    if (!p.duration || p.duration <= 0) return false;
    if (!AUDIO_EXT_RE.test(filePath) && !p.height) return false;
    return true;
  }

  /**
   * 合并成功后清理中间分片（`.fXXX.mp4` / `.fXXX.webm` 等）。
   *
   * yt-dlp 默认会自己删，但下载被中断时它来不及删 —— 残留文件既占地方，
   * 又会在下次下载时被当成"已存在的分片"参与合并，**直接把任务搞坏**。
   *
   * 只删"同名前缀 + 分片后缀"的中间产物，绝不误删别的成品。
   */
  function cleanupFormatFiles(dir, video, finalFile) {
    const base = path.basename(finalFile || '', path.extname(finalFile || ''));
    if (!base) return 0;
    let removed = 0;
    walk(dir, 3, (full, name) => {
      if (full === finalFile) return;
      const stem = name.replace(/\.[^.]+$/, '');
      if (stem.startsWith(`${base}.`) && /\.f\d+$/i.test(stem)) {
        try { fs.unlinkSync(full); removed += 1; } catch { /* 被占用就算了 */ }
      }
    });
    return removed;
  }

  /** 清理某任务的半截文件（.part / .ytdl），**不动正式成品** */
  function removePartials(dir, video) {
    let removed = 0;
    walk(dir, 3, (full, name) => {
      if (PARTIAL_EXT_RE.test(name)) {
        try { fs.unlinkSync(full); removed += 1; } catch { /* 忽略 */ }
      }
    });
    return removed;
  }

  /**
   * 兜底：在下载目录里找该任务最近产生的媒体文件。
   * 用在「--print-to-file 没读到、日志里也没抓到路径」的时候。
   */
  function findNewest(dir, { since = 0, maxDepth = 3 } = {}) {
    let best = null;
    walk(dir, maxDepth, (full, name) => {
      if (!MEDIA_EXT_RE.test(name)) return;
      let st;
      try { st = fs.statSync(full); } catch { return; }
      // 留 5 秒余量：文件系统时间戳精度和时钟抖动
      if (st.mtimeMs < since - 5000) return;
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs };
    });
    return best ? best.path : null;
  }

  /**
   * 下载完成后把封面存成缩略图。
   *
   * 优先从媒体文件里**抽一帧**（本地化，不依赖外链）；抽不出来再异步下载网络封面。
   * 网络那条是 fire-and-forget：封面是加分项，**绝不能阻塞任务收尾**。
   *
   * @returns {string|null} 抽帧成功时返回缩略图路径；否则 null（网络封面稍后落盘）
   */
  function grabThumbnail(video, filePath, { fetchImpl = fetch, thumbsDir = paths.thumbs } = {}) {
    const dest = path.join(thumbsDir, `${video.id}.jpg`);
    try { fs.mkdirSync(thumbsDir, { recursive: true }); } catch { /* 忽略 */ }

    if (fs.existsSync(paths.ffmpeg) && filePath && fs.existsSync(filePath)) {
      const r = runSync(paths.ffmpeg, [
        '-y', '-v', 'error', '-i', filePath, '-map', '0:v', '-map', '-0:V',
        '-frames:v', '1', '-vf', 'scale=480:-2', dest,
      ], { timeout: 60000 });
      if (r.status === 0 && fs.existsSync(dest)) {
        try { if (fs.statSync(dest).size > 0) return dest; } catch { /* 落到网络封面 */ }
      }
    }

    if (video && video.thumbnail_url) {
      fetchImpl(video.thumbnail_url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .then((ab) => { if (ab) fs.writeFileSync(dest, Buffer.from(ab)); })
        .catch(() => { /* 封面失败不影响任何事 */ });
    }
    return null;
  }

  /** 深度受限的目录遍历。目录不存在/读不了都静默跳过 —— 这些是清理工具，不该抛错。 */
  function walk(dir, maxDepth, visit) {
    const go = (d, depth) => {
      if (depth > maxDepth) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { go(full, depth + 1); continue; }
        if (e.isFile()) visit(full, e.name);
      }
    };
    go(dir, 0);
  }

  return {
    probe,
    evalFps,
    isPlayable,
    cleanupFormatFiles,
    removePartials,
    findNewest,
    grabThumbnail,
    walk,
    MEDIA_EXT_RE,
    PARTIAL_EXT_RE,
  };
}

module.exports = { createMediaTools, MEDIA_EXT_RE, AUDIO_EXT_RE, PARTIAL_EXT_RE };
