'use strict';
/**
 * 从网页/频道里找出视频链接。
 *
 * 两条路，**同等地位**（不是"主路 + 兜底"）：
 *
 *   A. `yt-dlp --flat-playlist -J` —— 有列表解析器的站点（YouTube / B 站等）走这条，
 *      直接拿到标题、时长、真链接，质量最高。
 *   B. 抓静态 HTML 抠 href —— 没有列表解析器的站走这条。
 *
 * ⚠️ 实测（2026-09-22）：「yt-dlp 优先」对 xvideos 这类站**不成立** ——
 *    它只认 `/video.xxx` 详情页，首页会返回 `Unsupported URL`。
 *    所以 B 不是敷衍的兜底，它常常才是主路。界面上必须显示走了哪条 ——
 *    否则用户会对着"没有缩略图的结果"不知道为什么。
 *
 * 边界（来自 spec 的「爬取纪律」，不要为了"更实用"而放宽）：
 *   单次 1 个页面请求 · 15s 超时 · 最多 3MB · 真实 UA · 不跟随页面内链接 ·
 *   发请求前检查 robots.txt · 不重试不绕过
 */

const { AppError } = require('../domain/errors');
const { runSync: realRunSync } = require('../infra/subprocess');
const { extractItems, extractPaging } = require('./crawl-parse');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const DEFAULTS = {
  maxItems: 200,
  timeoutMs: 15000,
  maxBytes: 3 * 1024 * 1024,
};

// ---------------------------------------------------------------- robots.txt

/**
 * 按 robots.txt 的标准挑选适用的规则组。
 *
 * 只做这件事：找 `User-agent` 匹配（`*` 或我们 UA 里的标识）的组，把它的
 * Allow / Disallow 收集起来。**刻意不做** Crawl-delay 与 Sitemap（spec 已写明）。
 */
function parseRobots(text) {
  const lines = String(text || '').split(/\r?\n/);
  const groups = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // 连续的 User-agent 行属于同一组
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && current) {
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  return groups;
}

/**
 * 判断某个路径是否被允许。
 *
 * `Allow` 与 `Disallow` 冲突时**取匹配更长的那条**（这是标准做法，
 * 不做的话等于假装遵守 robots.txt）。
 */
function robotsAllows(groups, pathname) {
  const uaLower = UA.toLowerCase();
  const applicable = groups.filter((g) => g.agents.some((a) => {
    if (a === '*') return true;
    // robots 里的"标识"通常是 UA 里的一个词，如 `googlebot`
    return uaLower.includes(a.split('/')[0]);
  }));
  if (!applicable.length) return true;

  let best = null;   // { allow, len }
  for (const g of applicable) {
    for (const r of g.rules) {
      if (!r.path) continue;                    // `Disallow:` 空值 = 全放行
      if (r.path.includes('*')) continue;       // 不认识通配，保守跳过而不是乱判
      const hit = pathname === r.path || pathname.startsWith(r.path);
      if (!hit) continue;
      if (!best || r.path.length > best.len) best = { allow: r.allow, len: r.path.length };
    }
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------- 工厂

function createCrawler(options = {}) {
  const {
    runSync = realRunSync,
    fetchImpl = fetch,
    paths = {},
    maxItems = DEFAULTS.maxItems,
    timeoutMs = DEFAULTS.timeoutMs,
    maxBytes = DEFAULTS.maxBytes,
  } = options;

  /** robots 判定按 origin 缓存：同一次会话里不重复请求同一个站 */
  const robotsCache = new Map();
  /** 在飞的请求，stop() 时逐个中止 */
  const inflight = new Set();

  function timedFetch(url) {
    const ctrl = new AbortController();
    inflight.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const done = () => { clearTimeout(timer); inflight.delete(ctrl); };
    return fetchImpl(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    }).then((r) => { done(); return r; }, (e) => { done(); throw e; });
  }

  /** 把一个网络错误翻译成给用户看的 AppError */
  function translateFetchError(err, url) {
    if (err && err.name === 'AbortError') {
      return new AppError(`目标站在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`, {
        kind: 'crawl-timeout',
        hint: '可能是站点很慢或被限速。稍等一下再试，或换一个地址。',
        cause: err,
      });
    }
    return new AppError(`无法读取该地址（${String(err && err.message || err).slice(0, 80)}）`, {
      kind: 'crawl-network',
      hint: '确认这个地址能在浏览器里打开，以及网络是否正常。',
      cause: err,
    });
  }

  /** 按状态码翻译 HTTP 失败 */
  function translateHttpStatus(status, url) {
    if (status === 429) {
      return new AppError(`目标站在限速（HTTP 429）—— 不是工具的问题`, {
        kind: 'crawl-rate-limited',
        hint: '等几分钟再试。这个站短时间内收到了太多请求。',
      });
    }
    if (status === 403) {
      return new AppError(`目标站拒绝了这次访问（HTTP 403）`, {
        kind: 'crawl-forbidden',
        hint: '可能需要登录态，也可能是站点的反爬保护（如 Cloudflare 挑战）。'
          + '本工具不会绕过它 —— 可以试试「设置 → 登录态」，或换一个地址。',
      });
    }
    if (status === 404) {
      return new AppError(`这个地址不存在（HTTP 404）`, {
        kind: 'crawl-not-found',
        hint: '检查一下网址有没有复制完整。',
      });
    }
    return new AppError(`目标站返回 HTTP ${status}`, {
      kind: 'crawl-http',
      hint: '这个站可能暂时不可用，或者需要登录。',
    });
  }

  /**
   * 读 robots.txt 并判定。返回 `{allowed, note}`。
   * 拿不到（404 / 超时 / 网络错误）→ 视为允许，但 note 里如实说明。
   */
  async function checkRobots(url) {
    const u = new URL(url);
    const origin = u.origin;
    if (robotsCache.has(origin)) return robotsCache.get(origin);

    let result;
    try {
      const res = await timedFetch(`${origin}/robots.txt`);
      if (!res.ok) {
        result = { allowed: true, note: `未能读到 robots.txt（HTTP ${res.status}）` };
      } else {
        const text = await res.text();
        const path = u.pathname || '/';
        const allowed = robotsAllows(parseRobots(text), path);
        result = {
          allowed,
          note: allowed ? null : `robots.txt 不允许抓取 ${path}`,
          robotsText: text,
        };
      }
    } catch {
      result = { allowed: true, note: '未能读到 robots.txt' };
    }
    robotsCache.set(origin, result);
    return result;
  }

  /** 抓一个页面，返回 HTML 文本 */
  async function fetchPage(url) {
    let res;
    try {
      res = await timedFetch(url);
    } catch (e) {
      throw translateFetchError(e, url);
    }
    if (!res.ok) throw translateHttpStatus(res.status, url);

    // 按 maxBytes 读，别把整站吞进内存。
    // 优先用 reader（能提前停），没有就退回 text() 再截断。
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return String(await res.text()).slice(0, maxBytes);

    const dec = new TextDecoder('utf-8');
    let text = '';
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      text += dec.decode(value, { stream: true });
    }
    try { await reader.cancel(); } catch { /* 忽略 */ }
    return text;
  }

  // ---------------------------------------------------------------- 路径 A

  function tryYtdlp(url) {
    const args = [
      '--ignore-config', '--no-warnings', '--no-colors',
      '--yes-playlist', '--skip-download', '--no-check-certificates',
      '--flat-playlist', '--playlist-end', String(maxItems),
      '-J', '--', url,
    ];
    if (paths.ffmpeg) args.unshift('--ffmpeg-location', paths.ffmpeg);

    const r = runSync(paths.ytdlp, args, { timeout: timeoutMs * 12 });
    if (!r || !r.ranOk) return { ok: false, reason: r && r.error ? r.error : '引擎没能启动' };

    const text = String(r.stdout || '').trim();
    const start = text.indexOf('{');
    if (start === -1) {
      return { ok: false, reason: String(r.stderr || text).split('\n').filter(Boolean).pop() || `退出码 ${r.status}` };
    }

    let json;
    try {
      json = JSON.parse(text.slice(start));
    } catch {
      return { ok: false, reason: 'JSON 解析失败' };
    }

    if (Array.isArray(json.entries)) {
      const items = json.entries.filter(Boolean).map((e) => ({
        url: e.webpage_url || e.url || null,
        title: e.title || null,
        duration_sec: Number.isFinite(e.duration) ? Math.round(e.duration) : null,
        site_video_id: e.id ? String(e.id) : null,
        thumb_url: e.thumbnail || null,
      })).filter((e) => e.url && e.title !== undefined);

      return {
        ok: true,
        data: {
          path: 'ytdlp',
          title: json.title || null,
          site: json.extractor_key || json.extractor || null,
          items,
          paging: [],
          note: items.length ? null : '这个地址没有列出任何条目。',
        },
      };
    }

    // 不是列表 → 单个视频
    return {
      ok: true,
      data: {
        path: 'ytdlp',
        title: json.title || null,
        site: json.extractor_key || json.extractor || null,
        items: [{
          url: json.webpage_url || json.original_url || url,
          title: json.title || null,
          duration_sec: Number.isFinite(json.duration) ? Math.round(json.duration) : null,
          site_video_id: json.id ? String(json.id) : null,
          thumb_url: json.thumbnail || null,
        }],
        paging: [],
        note: '这是一个单个视频的地址，不是列表 —— 只会得到这一条。',
      },
    };
  }

  // ---------------------------------------------------------------- 主入口

  /**
   * 分析一个来源地址。
   *
   * 超时/上限都来自工厂参数 —— **不做 per-call 覆盖**：第一版加过
   * `{timeoutMs}` 覆盖参数，结果要对一个 `const` 重新赋值，把
   * `analyzeSource` 里每个用例都变成 "Assignment to constant variable"。
   * 没有真实需求就别加这个开关。
   *
   * @returns {Promise<{path:'ytdlp'|'html', title, site, items, paging, note}>}
   */
  async function analyzeSource(url) {
    if (!url || typeof url !== 'string') {
      throw new AppError('没有提供网址', { hint: '把要抓的页面地址粘进来。', status: 400 });
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppError('这个地址看起来不是合法的网址', { hint: '要带上 http:// 或 https:// 的完整地址。', status: 400 });
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new AppError('只支持 http/https 地址', { hint: '本工具不抓本地文件或其它协议。', status: 400 });
    }

    // ---- 路径 A：yt-dlp
    const a = tryYtdlp(url);
    if (a.ok) return a.data;

    // ---- 路径 B：静态 HTML
    const robots = await checkRobots(url);
    if (!robots.allowed) {
      throw new AppError('这个站的 robots.txt 不允许抓取该路径', {
        kind: 'crawl-robots',
        hint: '尊重站点声明，本工具不会绕过它。可以换一个允许抓取的地址。',
      });
    }

    const html = await fetchPage(url);
    const items = extractItems(html, url, { limit: maxItems });
    if (!items.length) {
      throw new AppError('这个页面上没有找到视频链接', {
        kind: 'crawl-empty',
        hint: '确认这个地址是一个列表页/频道页。如果它需要 JavaScript 才能显示出内容，'
          + '服务端抓到的 HTML 里会没有链接 —— 这种站本工具暂不支持。',
      });
    }

    const notes = [];
    if (robots.note) notes.push(robots.note);
    notes.push('该站没有列表解析器，已改用页面解析');

    return {
      path: 'html',
      title: null,
      site: parsed.hostname,
      items,
      paging: extractPaging(html, url),
      note: notes.join('；'),
    };
  }

  /** 中止所有在飞的请求（进程退出 / shutdown 时调用） */
  function stop() {
    for (const ctrl of inflight) {
      try { ctrl.abort(); } catch { /* 忽略 */ }
    }
    inflight.clear();
  }

  return { analyzeSource, stop };
}

module.exports = { createCrawler, parseRobots, robotsAllows, UA };
