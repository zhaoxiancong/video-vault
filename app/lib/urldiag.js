'use strict';
/**
 * 链接诊断增强：
 * 当 yt-dlp 报 "Unsupported URL" 时，去抓一下那个页面，
 * 判断它到底是"视频聚合页（含很多视频链接）"还是"根本不是视频页"，
 * 然后把结论写进报错里 —— 让用户知道下一步该干什么，而不是看到一句 Unsupported URL。
 *
 * 安全约束：只在解析失败时抓、10 秒超时、最多读 512KB、失败就静默放弃。
 */
const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 从 HTML 里粗略统计"看起来像视频详情页"的链接数量 */
function countVideoLinks(html, baseUrl) {
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { /* ignore */ }

  const hrefs = new Set();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const h = m[1];
    if (!h || h.startsWith('#') || h.startsWith('javascript:')) continue;
    // 只认本域名下的链接
    if (host && !h.includes(host) && /^https?:/i.test(h)) continue;
    hrefs.add(h);
  }

  // 各站视频详情页的典型形态
  const VIDEO_PATH_RE = new RegExp([
    '/video[./_-]',            // xvideos /video.xxx、pornhub /view_video
    '/watch\\?v=',             // youtube
    '/video/\\w',              // 通用 /video/<id>
    '/shorts/',                // youtube shorts
    '/view_video\\.php',       // pornhub
    '/video/BV',               // bilibili
  ].join('|'), 'i');

  let n = 0;
  for (const h of hrefs) if (VIDEO_PATH_RE.test(h)) n++;
  return { count: n, sampled: hrefs.size };
}

async function diagnoseUnsupported(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let res;
    try {
      res = await fetch(url, {
        signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      });
    } finally { clearTimeout(timer); }

    if (!res.ok) {
      return { kind: 'http-error', status: res.status };
    }
    // 只读前 512KB，避免把整站吞进内存
    const reader = res.body ? res.body.getReader() : null;
    let text = '';
    if (reader) {
      const dec = new TextDecoder('utf-8');
      let total = 0;
      while (total < 512 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        text += dec.decode(value, { stream: true });
      }
      try { await reader.cancel(); } catch {}
    } else {
      text = await res.text();
    }

    const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [, ''])[1].trim();
    const { count, sampled } = countVideoLinks(text, url);

    if (count >= 5) {
      return { kind: 'listing', count, sampled, title };
    }
    if (/<video[\s>]/i.test(text) || /og:video/i.test(text)) {
      return { kind: 'single-page-no-extractor', title };
    }
    return { kind: 'not-a-video-page', count, sampled, title };
  } catch (e) {
    return { kind: 'fetch-failed', message: e.message };
  }
}

/** 把诊断结果转成给用户看的一句话 */
function explain(diag, url) {
  const short = url.length > 60 ? url.slice(0, 57) + '…' : url;
  switch (diag.kind) {
    // ⚠️ 不要在这里用 Markdown 记号（**粗体** 之类）：
    //    前端是用 textContent 显示的，星号会原样露出来。
    case 'listing':
      return `这是一个页面链接，不是单个视频 —— yt-dlp 不支持这种列表页。`
        + `（该页面上检测到约 ${diag.count} 个视频链接）`
        + `\n请点进具体那个视频，复制它的地址再试。`;
    case 'single-page-no-extractor':
      return `这个页面看起来有视频，但 yt-dlp 没有对应的解析器。`
        + `\n如果是嵌入播放器，可以试试复制播放器里的直链（通常以 .mp4 结尾）。`;
    case 'not-a-video-page':
      return `这个地址不像视频页（没检测到视频链接${diag.title ? `，页面标题是「${diag.title.slice(0, 40)}」` : ''}）。`
        + `\n请确认复制的是具体某个视频的地址。`;
    case 'http-error':
      return `访问该地址返回 HTTP ${diag.status}，可能链接失效或需要登录。`;
    case 'fetch-failed':
      return `无法读取该地址（${String(diag.message).slice(0, 60)}），请确认链接可访问。`;
    default:
      return `yt-dlp 不支持这个地址：${short}`;
  }
}

module.exports = { diagnoseUnsupported, explain, countVideoLinks };
