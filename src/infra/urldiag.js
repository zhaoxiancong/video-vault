'use strict';
/**
 * 链接诊断增强。
 *
 * 解决的是这个项目里**用户最容易困惑的一类失败**：
 * 粘了个列表页/首页进来，yt-dlp 只回一句 `Unsupported URL: ...`，
 * 用户完全不知道下一步该做什么，还容易以为工具坏了（README 坑 15）。
 *
 * 做法：解析失败时额外抓一下那个页面，统计里面有多少个"像视频详情页"的链接，
 * 据此给出结论 —— 是列表页？是没解析器的视频页？还是根本不是视频页？
 *
 * ── 刻意设的边界（不要为了"更实用"而放宽）────────────────────────
 *   · 只在**解析失败时**才抓，不做主动爬取
 *   · 10 秒超时
 *   · 最多读 512KB
 *   · 失败就静默退回原始报错，绝不因为诊断本身出错而让下载更糟
 *   · **不做整站爬虫** —— 那既超出范围也越过站点条款
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 各站视频详情页的典型形态 */
const VIDEO_PATH_RE = new RegExp([
  '/video[./_-]',            // xvideos /video.xxx、pornhub /view_video
  '/watch\\?v=',             // youtube
  '/video/\\w',              // 通用 /video/<id>
  '/shorts/',                // youtube shorts
  '/view_video\\.php',       // pornhub
  '/video/BV',               // bilibili
].join('|'), 'i');

/**
 * 从 HTML 里粗略统计"看起来像视频详情页"的链接数量。
 *
 * @returns {{count:number, sampled:number}} count=像视频的链接数，sampled=总链接数
 */
function countVideoLinks(html, baseUrl) {
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { /* baseUrl 不合法就用相对匹配 */ }

  const hrefs = new Set();
  for (const m of String(html).matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const h = m[1];
    if (!h || h.startsWith('#') || h.startsWith('javascript:')) continue;
    // 只认本域名下的链接（外链不算"这个页面的视频列表"）
    if (host && !h.includes(host) && /^https?:/i.test(h)) continue;
    hrefs.add(h);
  }

  let n = 0;
  for (const h of hrefs) if (VIDEO_PATH_RE.test(h)) n += 1;
  return { count: n, sampled: hrefs.size };
}

/**
 * 抓取并判断这个地址是什么。
 *
 * @returns {Promise<object>} 一定 resolve（失败返回 `{kind:'fetch-failed'}`），
 *          因为这个函数的调用方已经处于失败路径上，不能再抛
 */
async function diagnoseUnsupported(url, { fetchImpl = fetch, timeout = 10000, maxBytes = 512 * 1024 } = {}) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return { kind: 'http-error', status: res.status };

    // 只读前 512KB，避免把整站吞进内存
    let text = '';
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (reader) {
      const dec = new TextDecoder('utf-8');
      let total = 0;
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        text += dec.decode(value, { stream: true });
      }
      try { await reader.cancel(); } catch { /* 忽略 */ }
    } else {
      text = (await res.text()).slice(0, maxBytes);
    }

    const title = ((text.match(/<title[^>]*>([^<]*)<\/title>/i) || [, ''])[1] || '').trim();
    const { count, sampled } = countVideoLinks(text, url);

    if (count >= 5) return { kind: 'listing', count, sampled, title };
    if (/<video[\s>]/i.test(text) || /og:video/i.test(text)) {
      return { kind: 'single-page-no-extractor', title };
    }
    return { kind: 'not-a-video-page', count, sampled, title };
  } catch (e) {
    return { kind: 'fetch-failed', message: e.message };
  }
}

/**
 * 把诊断结果转成给用户看的一句话。
 *
 * ⚠️ 这里的文案**不能写 Markdown 记号**（`**粗体**` 之类）：
 *    前端是用 textContent 显示的，星号会原样露出来。这条也写进了回归测试。
 */
function explain(diag, url) {
  const short = String(url).length > 60 ? `${String(url).slice(0, 57)}…` : String(url);
  switch (diag.kind) {
    case 'listing':
      return '这是一个页面链接，不是单个视频 —— yt-dlp 不支持这种列表页。'
        + `（该页面上检测到约 ${diag.count} 个视频链接）`
        + '\n请点进具体那个视频，复制它的地址再试。';
    case 'single-page-no-extractor':
      return '这个页面看起来有视频，但 yt-dlp 没有对应的解析器。'
        + '\n如果是嵌入播放器，可以试试复制播放器里的直链（通常以 .mp4 结尾）。';
    case 'not-a-video-page':
      return `这个地址不像视频页（没检测到视频链接${diag.title ? `，页面标题是「${diag.title.slice(0, 40)}」` : ''}）。`
        + '\n请确认复制的是具体某个视频的地址。';
    case 'http-error':
      return `访问该地址返回 HTTP ${diag.status}，可能链接失效或需要登录。`;
    case 'fetch-failed':
      return `无法读取该地址（${String(diag.message).slice(0, 60)}），请确认链接可访问。`;
    default:
      return `yt-dlp 不支持这个地址：${short}`;
  }
}

module.exports = { diagnoseUnsupported, explain, countVideoLinks, VIDEO_PATH_RE };
