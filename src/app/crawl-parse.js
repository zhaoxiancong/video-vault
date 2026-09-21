'use strict';
/**
 * 抓取结果解析 —— 纯函数，不做任何 IO。
 *
 * 独立成文件的原因：解析规则是最容易出错、也最需要密集测试的一块。
 * 把它和"发请求"分开，测试就能对着固定的 HTML 夹具跑：不联网、不慢、不抖。
 *
 * ⚠️ 这里**不判断"这是不是一个视频"** —— 那件事交给 `urldiag.VIDEO_PATH_RE`，
 *    它已过生产验证（现在就在下载失败路径上跑）。本文件只负责"从 HTML 里把
 *    结构化的东西取出来"。
 */

const { VIDEO_PATH_RE } = require('../infra/urldiag');

/**
 * 从 slug 还原标题。
 *
 * 列表页的链接形如 `/video.<id>/<数字>/<slug>`，slug 本身就是标题，
 * 只是把空格换成了下划线。所以这一步不需要额外请求。
 */
function slugToTitle(slug) {
  return String(slug == null ? '' : slug)
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 时长文本 → 秒数。
 *
 * ⚠️ 认不出**必须返回 null**，不能返回 0：0 会被下游当成"零秒视频"，
 *    在界面上显示成 `0:00` 而不是 `?`。
 *
 * 之所以要容忍这么多写法：各站用的是本地化文案（`13分钟` / `11 min`），
 * 有些站用时钟格式（`13:05`）。实测 xvideos 用的是 `13分钟`。
 */
function parseDurationText(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;

  // 时钟格式：1:05:00 或 13:05
  const clock = s.match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
  if (clock) {
    const [, a, b, c] = clock;
    return c === undefined
      ? Number(a) * 60 + Number(b)
      : Number(a) * 3600 + Number(b) * 60 + Number(c);
  }

  // 本地化单位：13分钟 / 11 min / 2 小时 5 分
  //
  // ⚠️ 两个坑，都是实测踩出来的：
  //   1. **必须同时列出 `分钟` 和 `分`**。只写 `分钟` 时，"2 小时 5 分" 里的
  //      `5 分` 匹配不上（正则先试 `分钟` 失败，而后面没有单独 `分` 这条），
  //      结果只拿到小时部分 —— 实测表现为 7200 而不是 7500。
  //   2. 中文没有词边界，不能用 `\b`；改用 `(?![a-z])` 排掉
  //      "11 min" 被当成 `11 m` + `in` 的情况。
  const hour = s.match(/(\d+(?:\.\d+)?)\s*(?:小时|hours?|hrs?|h)(?![a-z])/i);
  const min = s.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|minutes?|mins?|min|m)(?![a-z])/i);
  const sec = s.match(/(\d+(?:\.\d+)?)\s*(?:秒钟|秒|seconds?|secs?|sec|s)(?![a-z])/i);
  if (hour || min || sec) {
    const total = (hour ? Number(hour[1]) * 3600 : 0)
      + (min ? Number(min[1]) * 60 : 0)
      + (sec ? Number(sec[1]) : 0);
    return total > 0 ? Math.round(total) : null;
  }
  return null;
}

/** 绝对化 URL；失败返回 null。抓到的 href 大多是相对路径，必须按来源页解析。 */
function absolutize(href, baseUrl) {
  try {
    return new URL(String(href), baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * 从 HTML 里抠出视频条目。
 *
 * 做法刻意朴素：**以"像视频链接的 href"为中心**，再从它周围取时长 / 缩略图 /
 * 站内 id。不做完整 DOM 解析 —— 列表页的 HTML 结构千差万别，
 * 而"链接周围的这一小段"是各站都有的东西。
 *
 * ⚠️ 实测（xvideos 真实页面）逼出来的三条规则，别想当然地简化掉：
 *
 *   1. **同一个视频在页面里有两个 `<a>`**：一个包缩略图、一个在标题里。
 *      两条链接同一个 URL。所以先按 URL 归并，再用"块里最好的那份数据"，
 *      而不是遇到第一个链接就定稿。
 *
 *   2. **标题用 `title="..."` 属性，而不是从 URL 的 slug 推。**
 *      标题链接上的 `title` 属性是完整的真实标题（含中文、括号、标点），
 *      slug 只是它的 ASCII 化近似（实测 slug 是
 *      `_ai_ai-generated_ep.2-1_i_m_building...`，而真标题是
 *      `【AI生成(AI-generated)】我在斗罗开后宫 ep.2-1 小舞上篇(...)`）。
 *      slug 只作为兜底。
 *
 *   3. **块的边界不是"往后 N 个字符"，而是这个视频真正的结束处。**
 *      一开始用固定窗口（1200 → 2500 字符）都会漏：标题链接在缩略图链接之后
 *      约 **5500 字符**处。而无限加大窗口会串到下一个视频，把别人的时长算进来。
 *      这个站的每个视频块以 `<script>xv.thumbs.prepareVideo('…')</script>` 收尾，
 *      所以切到那个 `</script>` 为止；认不出这个标记时退回固定窗口。
 *
 *   4. 每个视频块里有 **两处** `.duration`（缩略图上一个"预览时长"、标题里一个真时长）。
 *      取**最后一个**：实测第二个视频的预览时长是 7 分钟、真时长是 13 分钟，
 *      取第一个就会把 13 分钟的视频记成 7 分钟。
 *
 * @returns {Array<{url,title,duration_sec,site_video_id,thumb_url}>}
 */
function extractItems(html, baseUrl, { limit = 200 } = {}) {
  const src = String(html == null ? '' : html);

  /**
   * 取一个链接所属的"块"。
   * 先退到所属 `<div`；再往后找块结束标记（`</script>`），找不到才用固定窗口。
   */
  function blockAround(index, windowFallback = 6000) {
    const back = src.lastIndexOf('<div', index);
    const start = back >= 0 && index - back < 2000 ? back : index;
    const scriptEnd = src.indexOf('</script>', index);
    const end = scriptEnd >= 0 && scriptEnd - start < 8000 ? scriptEnd : index + windowFallback;
    return src.slice(start, end);
  }

  // ---- 第一遍：把所有像视频的链接按 URL 归并
  const groups = new Map();   // url -> { url, titleAttr, durText, videoId, thumb }
  const linkRe = /<a\b([^>]*)href\s*=\s*["']([^"']+)["']([^>]*)>/gi;
  let m;
  while ((m = linkRe.exec(src)) !== null) {
    const href = m[2];
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    if (!VIDEO_PATH_RE.test(href)) continue;

    const url = absolutize(href, baseUrl);
    if (!url) continue;

    const attrs = `${m[1]} ${m[3]}`;
    const titleAttr = (attrs.match(/\btitle\s*=\s*["']([^"']*)["']/i) || [])[1];
    const block = blockAround(m.index);

    const durs = [...block.matchAll(/class\s*=\s*["'][^"']*\bduration\b[^"']*["'][^>]*>([^<]+)</gi)]
      .map((x) => x[1].trim());
    const videoId = (block.match(/data-videoid\s*=\s*["'](\d+)["']/i) || [])[1];
    const thumb = (block.match(/data-src\s*=\s*["']([^"']+)["']/i)
      || block.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];

    const g = groups.get(url) || { url, titleAttr: null, durText: null, videoId: null, thumb: null };
    if (titleAttr && !g.titleAttr) g.titleAttr = titleAttr;       // 先拿到的 title 属性优先
    if (durs.length) g.durText = durs[durs.length - 1];           // 取最后一个（真时长）
    if (videoId && !g.videoId) g.videoId = videoId;
    if (thumb && !g.thumb) g.thumb = thumb;
    groups.set(url, g);
  }

  // ---- 第二遍：定稿
  const out = [];
  for (const g of groups.values()) {
    if (out.length >= limit) break;

    const pathOnly = g.url.split(/[?#]/)[0];
    const slug = pathOnly.split('/').filter(Boolean).pop() || '';

    out.push({
      url: g.url,
      title: g.titleAttr ? decodeEntities(g.titleAttr).trim() : slugToTitle(slug),
      duration_sec: parseDurationText(g.durText),
      site_video_id: g.videoId || null,
      thumb_url: g.thumb ? absolutize(g.thumb, baseUrl) : null,
    });
  }
  return out;
}

/** 解开 HTML 实体。标题属性里实测有 `&#039;` 这类编码。 */
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');   // 必须最后做，否则 `&amp;lt;` 会被解成 `<`
}

/**
 * 从 HTML 里找出"翻页候选"。
 *
 * ⚠️ 刻意**不猜格式**：实测 xvideos 的翻页是**路径式**（`/new/2`），
 *    而别的站可能是 `?p=2` / `/page/2` / `&offset=40`。
 *    这里只认"href 里带一个像页码的数字"的链接，认不出就返回空数组 ——
 *    空数组比猜错强（猜错会让用户点到一个不存在的页）。
 */
function extractPaging(html, baseUrl) {
  const src = String(html == null ? '' : html);
  const out = [];
  const seen = new Set();

  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,60}?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(src)) !== null) {
    const href = m[1];
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    // 视频链接不可能是翻页
    if (VIDEO_PATH_RE.test(href)) continue;

    // 页码形态：路径尾 /N、或查询串里的 p/page/pagenum/offset
    const byPath = href.match(/\/(\d+)\/?(?:[?#]|$)/);
    const byQuery = href.match(/[?&](?:p|page|pagenum|offset)=(\d+)/i);
    const num = byPath ? Number(byPath[1]) : (byQuery ? Number(byQuery[1]) : null);
    if (num === null || num < 1 || num > 500) continue;

    const url = absolutize(href, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    if (out.length >= 20) break;

    const inner = m[2].replace(/<[^>]*>/g, '').trim();
    out.push({
      label: inner && inner.length <= 12 ? inner : `第 ${num} 页`,
      url,
    });
  }
  return out;
}

/**
 * 关键字筛选（纯本地，不发任何请求）。
 *
 * 规则：空格分词 = AND；`-词` = 排除；空关键字 = 全部。
 * 单独的 `-` 不是排除词（用户可能只是手滑打了个短横）。
 */
function filterCandidates(items, query) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query == null ? '' : query).trim();
  if (!q) return list.slice();

  const include = [];
  const exclude = [];
  for (const t of q.split(/\s+/).filter(Boolean)) {
    if (t.length > 1 && t.startsWith('-')) exclude.push(t.slice(1).toLowerCase());
    else if (t !== '-') include.push(t.toLowerCase());
  }

  return list.filter((it) => {
    const title = String((it && it.title) || '').toLowerCase();
    if (include.some((t) => !title.includes(t))) return false;
    if (exclude.some((t) => title.includes(t))) return false;
    return true;
  });
}

/**
 * 判断两条候选是不是同一个视频。
 *
 * 站内 id 优先：slug 是会被人改的，`data-videoid` 不会。
 * 两边都有 id 就只比 id；有一边没有才回退到 URL。
 */
function sameVideo(a, b) {
  if (!a || !b) return false;
  if (a.site_video_id && b.site_video_id) {
    return String(a.site_video_id) === String(b.site_video_id);
  }
  return Boolean(a.url) && a.url === b.url;
}

module.exports = {
  slugToTitle,
  parseDurationText,
  extractItems,
  extractPaging,
  filterCandidates,
  sameVideo,
};
