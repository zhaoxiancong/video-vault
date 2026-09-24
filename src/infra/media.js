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
 * yt-dlp 的**中间分片**：`标题 [1080p137+251].f137.mp4` 里那个 `.f137`。
 *
 * ⚠️ 这个正则是修一个真实 bug 加的，改动前请先读完：
 *
 *   `findNewest()` 的用途是"结果文件读不到时，扫下载目录兜底找成品"。
 *   但它原来只按"媒体扩展名 + mtime 最新"来挑，于是**经常挑中分片** ——
 *   分片比合并后的成品写得更晚/更近，而且 `.f269.mp4` 也匹配 `.mp4`。
 *
 *   分片只有一条流（视频或音频），ffprobe 读它时**没有时长/分辨率**，
 *   于是 `isPlayable()` 判"不合格" → `finish()` 把文件删掉并触发重下 →
 *   下一次又挑中另一个分片 → 直到重试上限，任务被标成
 *   "文件损坏且重下仍失败"。
 *
 *   而真实情况是：**下载完全成功**（日志里 Merger / Metadata / MoveFiles
 *   全部 finished，零 ERROR），成品就躺在同一个目录里。
 *
 *   所以兜底查找必须把分片排除掉。
 */
const FRAGMENT_RE = /\.f\d+(\.[a-z0-9]+)?$/i;

/** 这个文件名是不是 yt-dlp 的中间分片 */
function isFragment(name) {
  return FRAGMENT_RE.test(String(name || ''));
}

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
  /**
   * 用 ffprobe 读真实媒体信息。
   *
   * ⚠️ 这里踩过一个自己造的坑，记下来免得再犯：
   *    `runSync()` **自己管理输出文件**（它内部开临时文件并把 stdout 读成字符串返回）。
   *    重构时我照搬了老代码的写法 —— 先在外部 openSync 一个临时文件、
   *    再把 fd 传进去 —— 但 `runSync` 的签名是 `(exe, args, opts)`，
   *    **根本不接受 fd**。于是那个外部临时文件永远是 0 字节，
   *    读出来是空串，JSON.parse 报 "Unexpected end of JSON input"，
   *    probe() 返回 null，上层就把一个**完全正常的视频**判成"损坏"。
   *
   *    现在直接用 `runSync` 返回的 stdout，不再自己开文件。
   *    （老代码之所以要开 fd，是因为它直接调 spawnSync；封装之后就不需要了。）
   *
   * @returns {object|null} null = 探测失败（文件坏了 / ffprobe 缺失）
   */
  function probe(filePath) {
    if (!fs.existsSync(paths.ffprobe)) return null;

    const r = runSync(paths.ffprobe, [
      '-v', 'error', '-print_format', 'json',
      '-show_format', '-show_streams', filePath,
    ], { timeout: 60000 });

    // 进程没跑起来 / 退出码非 0 → 读不出东西（半截文件、不支持的容器等）
    if (!r.ranOk || r.status !== 0) return null;

    const text = (r.stdout || '').trim();
    if (!text) return null;

    /**
     * ⚠️ 必须从第一个 `{` 开始截取，不能直接 JSON.parse 整段输出。
     *
     * ffprobe 即使加了 `-v error` 也可能在 JSON **前面**吐一行警告，例如：
     *   [mov,mp4,m4a,3gp,3g2,mj2 @ 00000189…] Invalid mvhd time scale -1108944568, defaulting to 1
     *   {
     *       "streams": [...]
     *   }
     * 直接 parse 整段会以 "Unexpected token 'm'" 失败 → probe 返回 null →
     * 一个**完全正常**的视频被判成"损坏"，然后被删掉重下。
     * 这个坑是处理"带警告输出的文件"时撞出来的（例如 moov atom 写坏的那种）。
     */
    const start = text.indexOf('{');
    if (start === -1) return null;

    let data;
    try {
      data = JSON.parse(text.slice(start));
    } catch {
      return null;
    }

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
  }

  /** "30000/1001" → 29.97 */
  function evalFps(rate) {
    const [a, b] = String(rate).split('/').map(Number);
    if (!b) return a || null;
    return Math.round((a / b) * 100) / 100;
  }

  /**
   * 实测一个媒体文件是不是**真的能用**，并说明判断依据。
   *
   * ⚠️ 为什么返回对象而不是布尔：
   *    以前没有 ffprobe 时这里直接 `return true`（"我验不了，那就当它是好的"）。
   *    那是个**静默的假阳性** —— 上层以为"已验证通过"，实际根本没验。
   *    而"文件存在 ≠ 文件完整"恰恰是这个项目最贵的教训之一（坑 11）。
   *
   *    现在把"没验过"明说出来（`verified:false`），由调用方决定要不要采信。
   *    自动流程的策略是"采信但记下来"，至少不会有人误以为验过了。
   *
   * @returns {{ok:boolean, reason:string, verified:boolean, probe:object|null}}
   */
  function inspect(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, reason: '路径为空', verified: false, probe: null };
    }
    if (!fs.existsSync(filePath)) {
      return { ok: false, reason: '文件不存在', verified: false, probe: null };
    }
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch { /* 下面统一处理 */ }
    if (size < 1024) {
      return { ok: false, reason: `文件太小（${size} 字节）`, verified: true, probe: null };
    }

    // 没有 ffprobe：**明确报告"没验过"**，而不是假装验过了
    if (!fs.existsSync(paths.ffprobe)) {
      return {
        ok: true,
        reason: '没有 ffprobe，无法实测完整性（内容未经校验）',
        verified: false,
        probe: null,
      };
    }

    const p = probe(filePath);
    if (!p) {
      return { ok: false, reason: 'ffprobe 读不出这个文件（很可能是半截/损坏）', verified: true, probe: null };
    }
    if (!p.duration || p.duration <= 0) {
      return { ok: false, reason: 'ffprobe 读不到时长', verified: true, probe: p };
    }
    if (!AUDIO_EXT_RE.test(filePath) && !p.height) {
      return { ok: false, reason: '读不到分辨率（可能只有音频流，或是中间分片）', verified: true, probe: p };
    }
    return { ok: true, reason: 'ffprobe 实测通过', verified: true, probe: p };
  }

  /** 便捷包装：只要"能不能用"。细节用 inspect()。 */
  function isPlayable(filePath) {
    return inspect(filePath).ok;
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
   * 兜底：在下载目录里找该任务最近产生的**成品**媒体文件。
   * 用在「--print-to-file 没读到、日志里也没抓到路径」的时候。
   *
   * ⚠️ 必须排除 yt-dlp 的中间分片（`.f137.mp4` 这种）——
   *    分片只有一条流，ffprobe 读不出时长，会被 isPlayable 判成"损坏"，
   *    然后 finish() 把它删掉重下，形成"永远失败"的假故障。
   *    这个坑真的踩过，见 FRAGMENT_RE 的注释。
   */
  function findNewest(dir, { since = 0, maxDepth = 3, allowFragments = false } = {}) {
    let best = null;
    walk(dir, maxDepth, (full, name) => {
      if (!MEDIA_EXT_RE.test(name)) return;
      if (!allowFragments && isFragment(name)) return;
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
      /**
       * ⚠️ 用 `-map 0:V:0`，**不要**用 `-map 0:v -map -0:V`。
       *
       * 踩过的坑（用户报"下载了合集但都没有封面"）：
       *   原来写的是 `-map 0:v -map -0:V`（选所有视频流，再排除附加封面）。
       *   但**封面流在 mkv 里不带 `attached_pic` 标记**（实测 ffprobe 报 0），
       *   于是 `-0:V` 不排除它，而 `0:v` 选中的又只有这一条封面流 →
       *   ffmpeg 报 `Output file does not contain any stream` 直接失败。
       *   mp4 的封面带 attached_pic=1，所以 mp4 正常 ——
       *   **B站的视频全是 mkv，于是全都抽不出封面**。
       *
       * `-map 0:V:0` = "第一条**非**附加封面的视频流"，两种容器都对。
       */
      const r = runSync(paths.ffmpeg, [
        '-y', '-v', 'error', '-i', filePath, '-map', '0:V:0',
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
    inspect,
    isPlayable,
    cleanupFormatFiles,
    removePartials,
    findNewest,
    grabThumbnail,
    walk,
    isFragment,
    MEDIA_EXT_RE,
    PARTIAL_EXT_RE,
    FRAGMENT_RE,
  };
}

module.exports = {
  createMediaTools, MEDIA_EXT_RE, AUDIO_EXT_RE, PARTIAL_EXT_RE, FRAGMENT_RE, isFragment,
};
