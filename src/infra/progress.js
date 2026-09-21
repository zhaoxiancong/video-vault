'use strict';
/**
 * 进度与阶段解析 —— 纯粹的文本 → 结构化数据，没有任何 IO。
 *
 * 这个文件承载了项目里最难挣来的几条知识，改之前请先读完：
 *
 * ── 为什么不用 JSON 模板（README 坑 4，连撞两次）────────────────────
 *   1) 用 `%(...)s` 把 `_percent_str` 插进 JSON → 得到 `{"p":  0.5%}`，**非法 JSON**
 *   2) 改用 `%(...)j`（JSON 编码）→ 字符串字段好了，但**数值字段取到 NA 时
 *      仍然输出裸 `NA`**（`{"frag":NA}`），照样非法
 *   结论：任何"让模板自己产出结构化格式"的思路都会被 NA 咬。
 *   最终方案：**管道分隔纯文本** —— `NA` 只是自己那一格的值，永远破坏不了整体结构。
 *   下面的 JSON 解析路径只是为了向后兼容，不是主路径。
 *
 * ── 为什么进度一定会"归零一次"（坑 9）──────────────────────────────
 *   一次下载要下两条流（视频流 + 音频流），yt-dlp 是**先后**下的。
 *   所以进度一定会 0→100% → 归零 → 0→100% → 合并。
 *   **归零不是 bug**，但必须让用户知道，否则看起来就像坏了
 *   （界面显示「下载中（第 2 条流）」，靠的就是这里的 stream 序号）。
 *
 * ── 为什么只有"下载开始之后"的后处理器才算进入后处理（坑 9）────────
 *   yt-dlp 的 `ThumbnailsConvertor` 会在**下载开始之前**就先执行一次。
 *   早期代码一见到任何 postprocessor 就把进度顶到 99、状态改成"处理中"，
 *   结果进度条从开场就被钉死在 99%，而真实下载从 0.1% 一路走到 99.4%，
 *   整个过程（689MB / 4 分钟）用户看不到任何进度。
 */

/**
 * 进度模板：让 yt-dlp 每行吐一条管道分隔的纯文本。
 * 格式：
 *   VVP|<percent>|<downloaded>|<total>|<speed>|<eta>|<frag>|<fragc>     下载进度
 *   VVP|<postprocessor>|<status>                                        后期处理
 * 开头的 "download:" / "postprocess:" 是 yt-dlp 的**路由标记**，不会出现在输出里。
 */
const PROGRESS_TEMPLATE =
  'download:VVP|%(progress._percent_str)s|%(progress.downloaded_bytes)s|'
  + '%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress.speed)s|'
  + '%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s';

const POSTPROCESS_TEMPLATE =
  'postprocess:VVP|%(progress.postprocessor)s|%(progress.status)s';

/** yt-dlp 模板里的 "NA" 表示"不可用"，必须归一化成 null，否则 Number('NA')=NaN 会污染前端 */
function num(v) {
  if (v === null || v === undefined || v === 'NA' || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 真正算"进入后处理"的后处理器。
 * 只认这几个 —— `ThumbnailsConvertor` / `Metadata` 会在下载前跑，不能算（坑 9）。
 */
const POST_STAGE_RE = /^(Merger|ExtractAudio|VideoConvertor|VideoRemuxer|Fixup)/i;

/** 管道格式解析（主格式） */
function parsePipeLine(raw) {
  if (!raw.startsWith('VVP|')) return null;
  const parts = raw.slice(4).split('|');

  if (parts.length === 7) {
    const ds = num(parts[1]);
    const ts = num(parts[2]);
    let pct = parseFloat(String(parts[0]).replace('%', '').trim());
    // 兜底：p 不可解析时用字节数自己算
    if (!Number.isFinite(pct) && ds !== null && ts) pct = (ds / ts) * 100;
    return {
      type: 'progress',
      percent: Number.isFinite(pct) ? pct : null,
      downloaded: ds,
      total: ts,
      speed: num(parts[3]),
      eta: num(parts[4]),
      fragment: num(parts[5]),
      fragmentCount: num(parts[6]),
    };
  }

  if (parts.length === 2) {
    return {
      type: 'postprocess',
      stage: (parts[0] || '处理中').trim(),
      status: (parts[1] || '').trim(),
    };
  }
  return null;
}

/** 兼容：JSON 形式的进度行（已不是主格式，保留以防回退） */
function parseDownloadJson(text) {
  const t = String(text).trim();
  if (!t.startsWith('{')) return null;
  let o;
  try { o = JSON.parse(t); } catch { return null; }
  if (!('p' in o)) return null;   // 进度对象必带 p

  const ds = num(o.ds);
  const ts = num(o.ts);
  let pct = parseFloat(String(o.p ?? '').replace('%', '').trim());
  if (!Number.isFinite(pct) && ds !== null && ts) pct = (ds / ts) * 100;

  return {
    type: 'progress',
    percent: Number.isFinite(pct) ? pct : null,
    downloaded: ds,
    total: ts,
    speed: num(o.spd),
    eta: num(o.eta),
    fragment: num(o.frag),
    fragmentCount: num(o.fragc),
  };
}

/** 兼容：JSON 形式的后期处理行。用 pp 字段区分于进度对象（进度是 p） */
function parsePostprocessJson(text) {
  const t = String(text).trim();
  if (!t.startsWith('{')) return null;
  let o;
  try { o = JSON.parse(t); } catch { return null; }
  if (!('pp' in o) && !('stage' in o)) return null;
  return {
    type: 'postprocess',
    stage: o.pp || o.stage || '处理中',
    status: o.status || '',
  };
}

function parseDownloadLine(text) {
  const t = String(text).trim();
  return t.startsWith('VVP|') ? parsePipeLine(t) : null;
}

function parsePostprocessLine(text) {
  const t = String(text).trim();
  return t.startsWith('VVP|') ? parsePipeLine(t) : null;
}

/**
 * 解析一行 yt-dlp 输出。
 *
 * 返回的事件类型：
 *   progress    下载进度
 *   postprocess 后处理阶段变化
 *   file        最终文件路径（VVAULT_FILE:）
 *   stage       阶段标记
 *   meta        元信息（VVAULT_META:）
 *   destination 目标文件名
 *   already     文件已存在（--no-overwrites 命中）
 *   error       ERROR 行
 *   log         其它（原始日志）
 *
 * @returns {object|null}
 */
function parseProgressLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;

  // 带前缀形式（模板的路由标记不会出现在真实输出里，这里只是兼容）
  if (raw.startsWith('download:')) {
    const rest = raw.slice('download:'.length);
    return parseDownloadLine(rest) || parseDownloadJson(rest);
  }
  if (raw.startsWith('postprocess:')) {
    const rest = raw.slice('postprocess:'.length);
    return parsePostprocessLine(rest) || parsePostprocessJson(rest);
  }

  // 裸形式（真实情况）
  const pipe = parsePipeLine(raw);
  if (pipe) return pipe;

  if (raw.startsWith('{')) {
    return parseDownloadJson(raw) || parsePostprocessJson(raw) || null;
  }

  if (raw.startsWith('VVAULT_FILE:')) {
    return { type: 'file', path: raw.slice('VVAULT_FILE:'.length).trim() };
  }
  if (raw.startsWith('VVAULT_POST:')) {
    return { type: 'stage', stage: raw.slice('VVAULT_POST:'.length).trim() };
  }
  if (raw.startsWith('VVAULT_META:')) {
    return { type: 'meta', raw: raw.slice('VVAULT_META:'.length) };
  }

  if (/^\[download\]\s+Destination:/i.test(raw)) {
    return { type: 'destination', value: raw.replace(/^\[download\]\s+Destination:\s*/i, '') };
  }
  if (/^\[download\]\s+.*has already been downloaded/i.test(raw)) {
    return { type: 'already' };
  }
  if (/^ERROR:/i.test(raw)) {
    return { type: 'error', message: raw.replace(/^ERROR:\s*/i, '') };
  }
  if (/^\[Merger\]|^\[ExtractAudio\]|^\[VideoConvertor\]|^\[Metadata\]|^\[ThumbnailsConvertor\]/i.test(raw)) {
    return { type: 'stage', stage: raw.split(']')[0].replace('[', '') };
  }
  return { type: 'log', line: raw };
}

/**
 * 清洗错误信息。
 *
 * ⚠️ 曾经直接取"最后一行"，结果把进度帧（`VVP|100.0%|…`）当成了错误信息存进数据库，
 *    用户看到的错误提示是一串数字（坑 10）。所以必须：
 *    1) 先把进度帧、后处理标记等非错误行排除
 *    2) `ERROR:` 行若只是笼统的 `Postprocessing:`，说明真正原因在其后，取它后面那行
 *    3) 都没有才退回最后一行非噪音内容
 */
function cleanError(text) {
  if (!text) return '';
  const lines = String(text)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((l) => !/^VVP\|/.test(l))
    .filter((l) => !/^VVAULT_/.test(l))
    .filter((l) => !/^\[download\]\s+[\d.]+%/.test(l))
    .filter((l) => !/^\[download\]\s+Destination:/.test(l))
    .filter((l) => !/^Deleting (original|existing) file/.test(l));

  if (!lines.length) return '';

  const errIdx = lines.findIndex((l) => /^ERROR:/i.test(l));
  if (errIdx >= 0) {
    const msg = lines[errIdx].replace(/^ERROR:\s*/i, '').trim();
    // "Postprocessing:" 这类笼统错误，真正的原因通常在下一行
    if (/^Postprocessing:\s*$/i.test(msg)) {
      const next = lines[errIdx + 1];
      if (next && !/^ERROR:/i.test(next)) return `${msg} ${next}`.slice(0, 500);
    }
    return msg.slice(0, 500) || (lines[errIdx + 1] || '').slice(0, 500) || '';
  }

  // 没有 ERROR 行：优先挑看起来像报错的
  const likely = lines.filter((l) => /error|invalid|failed|unable|not available|unavailable|forbidden|403|404|timed? ?out|refused|denied|corrupt/i.test(l));
  const pick = (likely.length ? likely[likely.length - 1] : lines[lines.length - 1]) || '';
  return pick.replace(/^ERROR:\s*/i, '').slice(0, 500);
}

module.exports = {
  PROGRESS_TEMPLATE,
  POSTPROCESS_TEMPLATE,
  POST_STAGE_RE,
  num,
  parsePipeLine,
  parseDownloadJson,
  parsePostprocessJson,
  parseProgressLine,
  cleanError,
};
