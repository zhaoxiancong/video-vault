# 「从网站找视频」实施计划（爬取 + 候选列表）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户粘一个网页地址，从中找出视频链接、按关键字筛选、勾选后批量入队下载，候选结果持久化可跨会话继续挑。

**Architecture:** 三个新单元，依赖方向仍然单向朝内（`http → app → infra`）。`src/app/crawler.js` 是唯一抓取实现（先试 yt-dlp，失败退静态 HTML），纯逻辑可单测；`src/app/discovery.js` 管爬取任务生命周期（串行、20 秒兜底、事件广播），对标现有 `scheduler.js` 的 `EventEmitter` + `stop()` 写法；`src/http/routes/discover.js` 提供 4 个接口。候选存独立的 `candidates` 表，**不碰 `videos` 表**。

**Tech Stack:** Node.js ≥22.5（仅内置模块：`node:sqlite`、`node:events`、全局 `fetch`、`node:test`）· 原生 ES 模块前端（无框架无构建）· 零 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-22-crawler-and-candidate-list-design.md`

## Global Constraints

以下每条都来自 spec，**每个任务的要求都隐含包含本节**：

- **零 npm 依赖**：只用 Node 内置模块。不要 `require('cheerio')` / `axios` / `better-sqlite3` —— 它们不存在。
- **不做整站爬取**：单次爬取只发 1 个页面请求（+ 1 个 robots.txt），**不跟随页面内链接**。
- **爬取纪律**：超时 15s · 响应体上限 3MB · 真实浏览器 UA · 串行（一次只跑一个爬取）· 单次条数上限 200 · **不自动翻页凑满**。
- **子进程一律 fd 重定向**，不用管道 stdio（受限沙箱会 `EPERM`）。照抄 `src/infra/subprocess.js` 的 `runSync`。
- **爬取本身没有"延时"这个机制**，所以 spec 里那个「临时提速开关」**本轮不实现** ——
  没有可提速的东西。实测单次抓取 1.1 秒。等真的遇到需要节流的站再单独讨论
  （spec 第 4 节已同步标注为"尚未实现"）。
- **前端提示一律 `textContent`，绝不把人/引擎来的文本拼进 `innerHTML`**。文案里**不写 Markdown 记号**（`**粗体**` 会原样显示）。
- **`hidden` 属性靠 `[hidden] { display: none !important; }` 生效**，别删 `styles.css` 开头那行。
- **前端类名必须同时写进 `styles.css`**，否则 `tools/check-classes.js` 会失败（它扫全量前端源码）。
- **不把 Cookie 内容写进任何日志或数据库字段**。
- **测试里"跳过"用 node:test 原生 skip**，不要提前 `return`（那会被算成通过 = 假绿）。
- **破坏性测试只用隔离实例**（`createApp({data: 临时目录})`），绝不碰用户真实库。

## Review Focus

spec 是愿景文档，它对下面这五类输入的沉默**不是**"可以崩"的许可。每条都已分派到拥有该代码的任务里，用该任务自己的步骤风格写了测试：

1. **相对 URL 必须按来源页解析**（`/video.xxx/1/slug` → `https://www.xvideos.com/video.xxx/1/slug`）。抓到的 href 大多是相对路径，直接存进库会让下载失败。
2. **同一个页面里重复出现的视频只算一条**（规范 URL 后去重）。列表页常把同一条视频渲染两次（首屏 + 侧栏），不去重会得到重复候选、把用户搞糊涂。
3. **时长缺失必须留 `null` 而不是 `0`**。`0` 会被下游当成"零秒视频"，在界面上显示成 `0:00` 而不是 `?`。
4. **关键字筛选的边界**：大小写不敏感、空格分词 = AND、`-词` = 排除、空关键字 = 全部、`-` 单独出现时不当作排除词。
5. **下载入队必须沿用现有 `POST /api/videos` 那条路**，而不是自己往 `videos` 表插行 —— 否则会绕过去重、URL 归一化和队列唤醒。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/app/crawl-parse.js` | **新增**：纯函数解析（HTML → 条目、URL 归一化、时长文本、翻页候选、关键字筛选）。无 IO、无网络，最容易测 |
| `src/app/crawler.js` | **新增**：抓取实现。yt-dlp 路径 + HTML 路径 + robots.txt 检查。只依赖 `crawl-parse` 与 `infra/subprocess` |
| `src/app/discovery.js` | **新增**：爬取任务生命周期（串行队列、20 秒兜底、`EventEmitter`、`stop()`） |
| `src/http/routes/discover.js` | **新增**：`POST /api/crawl`、`GET /api/crawl/:id`、`GET /api/candidates`、`POST /api/candidates/action` |
| `src/web/views/discover.js` | **新增**：「找视频」页 |
| `src/infra/database.js` | 修改：加 `crawl_runs` / `candidates` 两张表 + 仓储方法 |
| `src/http/server.js` | 修改：注册路由、转发 `crawl` 事件到 SSE、把 `discovery` 接进 ctx 与 shutdown |
| `src/main.js` | 修改：创建 `discovery` 并注入 |
| `src/web/index.html` | 修改：加第 4 个标签与视图骨架 |
| `src/web/app.js` | 修改：初始化新视图、把 SSE 的 `crawl` 事件接过去 |
| `src/web/styles.css` | 修改：新页样式 |
| `test/fixtures/listing-xvideos.html` | **已存在**：真实页面裁下来的 3 个视频块（5.4KB） |
| `test/fixtures/paging-xvideos.html` | **已存在**：真实翻页片段（22 个 `/new/N`） |
| `test/unit/crawl-parse.test.js` | **新增** |
| `test/unit/crawler.test.js` | **新增** |
| `test/integration/api.test.js` | 修改：加爬取接口测试 |
| `test/integration/database.test.js` | 修改：加候选仓储测试 |
| `test/integration/frontend-dom.test.mjs` | 修改：加「找视频」页测试 |

---

## Task 1: 解析层（`crawl-parse.js`）—— 纯函数，无 IO

**Files:**
- Create: `src/app/crawl-parse.js`
- Test: `test/unit/crawl-parse.test.js`
- 夹具（已存在，直接用）：`test/fixtures/listing-xvideos.html`、`test/fixtures/paging-xvideos.html`

**Interfaces:**
- Consumes: `src/infra/urldiag.js` 的 `VIDEO_PATH_RE`
- Produces:
  - `slugToTitle(slug: string): string`
  - `parseDurationText(text: string|null): number|null`
  - `extractItems(html: string, baseUrl: string, {limit=200}): Array<{url, title, duration_sec, site_video_id, thumb_url}>`
  - `extractPaging(html: string, baseUrl: string): Array<{label: string, url: string}>`
  - `filterCandidates(items: Array, query: string): Array`
  - `sameVideo(a: object, b: object): boolean`

- [ ] **Step 1: 写失败测试**

`test/unit/crawl-parse.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  slugToTitle, parseDurationText, extractItems, extractPaging, filterCandidates, sameVideo,
} = require('../../src/app/crawl-parse');

const FIX = path.join(__dirname, '..', 'fixtures');
const LISTING = fs.readFileSync(path.join(FIX, 'listing-xvideos.html'), 'utf8');
const PAGING = fs.readFileSync(path.join(FIX, 'paging-xvideos.html'), 'utf8');
const BASE = 'https://www.xvideos.com/';

test('slugToTitle 把下划线还原成空格并去掉首尾空白', () => {
  assert.equal(slugToTitle('krump_-no.2_-_-_ai-generated'), 'krump -no.2 - - ai-generated');
  assert.equal(slugToTitle('sayoko_machimura_blowjob'), 'sayoko machimura blowjob');
  assert.equal(slugToTitle(''), '');
});

test('parseDurationText 认多种写法，认不出返回 null（不是 0）', () => {
  assert.equal(parseDurationText('13分钟'), 780);
  assert.equal(parseDurationText('1分钟'), 60);
  assert.equal(parseDurationText('11 min'), 660);
  assert.equal(parseDurationText('1:05:00'), 3900);
  assert.equal(parseDurationText('13:05'), 785);
  assert.equal(parseDurationText(''), null);
  assert.equal(parseDurationText(null), null);
  assert.equal(parseDurationText('未知'), null);
});

test('extractItems 从真实夹具里抠出条目，字段齐全', () => {
  const items = extractItems(LISTING, BASE);
  assert.equal(items.length, 3, '夹具里有 3 个视频块');

  const first = items[0];
  // 相对路径必须解析成绝对 URL（Review Focus 1）
  assert.match(first.url, /^https:\/\/www\.xvideos\.com\/video\./);
  assert.ok(first.title.length > 0, '标题不能为空');
  assert.ok(!first.title.includes('_'), '标题里的下划线要还原成空格');
  assert.equal(typeof first.duration_sec, 'number');
  assert.ok(first.duration_sec > 0);
  assert.match(first.site_video_id, /^\d+$/, 'data-videoid 要抓下来');
});

test('extractItems 的时长缺失时是 null，不是 0（Review Focus 3）', () => {
  const html = '<div class="thumb-block"><a href="/video.aaa/1/1/x">'
    + '<img data-src="https://cdn.example/t.jpg"></a></div>';
  const items = extractItems(html, BASE);
  assert.equal(items.length, 1);
  assert.equal(items[0].duration_sec, null);
  assert.equal(items[0].thumb_url, 'https://cdn.example/t.jpg');
});

test('extractItems 对同一页内重复的视频只算一条（Review Focus 2）', () => {
  const block = '<div class="thumb-block"><a href="/video.aaa/1/1/same">'
    + '<span class="duration">5分钟</span></a></div>';
  const items = extractItems(block + block, BASE);
  assert.equal(items.length, 1, '同一条出现两次只保留一条');
});

test('extractItems 忽略不像视频的链接', () => {
  const html = '<a href="/new/2">下一页</a><a href="/tags/abc">标签</a>'
    + '<a href="/video.bbb/2/2/real"><span class="duration">2分钟</span></a>';
  const items = extractItems(html, BASE);
  assert.equal(items.length, 1);
  assert.match(items[0].url, /video\.bbb/);
});

test('extractItems 遵守 limit', () => {
  const one = '<a href="/video.x{i}/1/1/t{i}"><span class="duration">1分钟</span></a>';
  const html = Array.from({ length: 10 }, (_, i) => one.replace(/\{i\}/g, i)).join('');
  assert.equal(extractItems(html, BASE, { limit: 4 }).length, 4);
});

test('extractPaging 从真实翻页片段里列出候选页', () => {
  const paging = extractPaging(PAGING, BASE);
  assert.ok(paging.length >= 5, `应至少列出 5 个候选页，实际 ${paging.length}`);
  assert.match(paging[0].url, /^https:\/\/www\.xvideos\.com\/new\/\d+$/);
  assert.ok(paging[0].label.length > 0);
});

test('extractPaging 的标签是"第 N 页"而不是原始 URL', () => {
  const paging = extractPaging(PAGING, BASE);
  for (const p of paging.slice(0, 3)) assert.match(p.label, /第\s*\d+\s*页/);
});

test('filterCandidates：空关键字返回全部', () => {
  const items = [{ title: 'abc def' }, { title: 'ghi' }];
  assert.equal(filterCandidates(items, '').length, 2);
  assert.equal(filterCandidates(items, '   ').length, 2);
});

test('filterCandidates：空格分词 = AND，大小写不敏感', () => {
  const items = [{ title: 'Big Buck Bunny 60fps' }, { title: 'Big Buck Bunny' }, { title: 'bunny only' }];
  assert.equal(filterCandidates(items, 'big bunny').length, 2);
  assert.equal(filterCandidates(items, 'BIG BUNNY').length, 2);
  assert.equal(filterCandidates(items, 'big 60fps').length, 1);
});

test('filterCandidates：-词 是排除；单独的 "-" 不当作排除词（Review Focus 4）', () => {
  const items = [{ title: 'cat video' }, { title: 'cat dog' }, { title: 'cat - dash' }];
  assert.equal(filterCandidates(items, 'cat -dog').length, 2);
  assert.equal(filterCandidates(items, 'cat -').length, 3, '单独的 - 应被忽略');
});

test('filterCandidates：标题为 null 时不崩', () => {
  assert.equal(filterCandidates([{ title: null }], 'x').length, 0);
  assert.equal(filterCandidates([{ title: null }], '').length, 1);
});

test('sameVideo：优先比 site_video_id，其次比 URL', () => {
  assert.ok(sameVideo({ site_video_id: '1', url: 'a' }, { site_video_id: '1', url: 'b' }));
  assert.ok(!sameVideo({ site_video_id: '1', url: 'a' }, { site_video_id: '2', url: 'a' }));
  assert.ok(sameVideo({ url: 'a' }, { url: 'a' }));
  assert.ok(!sameVideo({ url: 'a' }, { url: 'b' }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/run.js unit crawl-parse`
Expected: 失败 —— `Cannot find module '../../src/app/crawl-parse'`

- [ ] **Step 3: 写实现**

`src/app/crawl-parse.js`：

```js
'use strict';
/**
 * 抓取结果解析 —— 纯函数，不做任何 IO。
 *
 * 独立成文件的原因：解析规则是最容易出错、也最需要密集测试的一块。
 * 把它和"发请求"分开，测试就能对着固定的 HTML 夹具跑，不联网、不慢、不抖。
 *
 * ⚠️ 这里**不判断"这是不是一个视频"** —— 那件事交给 urldiag.VIDEO_PATH_RE，
 *    它已经过生产验证（现在就在下载失败路径上跑）。本文件只负责"从 HTML 里
 *    把结构化的东西取出来"。
 */

const { VIDEO_PATH_RE } = require('../infra/urldiag');

/** 从 slug 还原标题：下划线→空格，合并连续空白 */
function slugToTitle(slug) {
  return String(slug || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 时长文本 → 秒。
 *
 * ⚠️ 认不出**必须返回 null**，不能返回 0：0 会被下游当成"零秒视频"，
 *    界面上显示成 `0:00` 而不是 `?`（Review Focus 3）。
 */
function parseDurationText(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;

  // 1:05:00 或 13:05
  const clock = s.match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
  if (clock) {
    const [, a, b, c] = clock;
    return c === undefined
      ? Number(a) * 60 + Number(b)
      : Number(a) * 3600 + Number(b) * 60 + Number(c);
  }

  // 13分钟 / 11 min / 2 小时 5 分
  const hour = s.match(/(\d+(?:\.\d+)?)\s*(?:小时|hours?|hrs?|h)\b/i);
  const min = s.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|minutes?|mins?|m)\b/i);
  const sec = s.match(/(\d+(?:\.\d+)?)\s*(?:秒|seconds?|secs?|s)\b/i);
  if (hour || min || sec) {
    const total = (hour ? Number(hour[1]) * 3600 : 0)
      + (min ? Number(min[1]) * 60 : 0)
      + (sec ? Number(sec[1]) : 0);
    return total > 0 ? Math.round(total) : null;
  }
  return null;
}

/** 绝对化 URL，失败返回 null（相对路径必须按来源页解析，Review Focus 1） */
function absolutize(href, baseUrl) {
  try { return new URL(href, baseUrl).href; } catch { return null; }
}

/**
 * 从 HTML 里抠出视频条目。
 *
 * 做法刻意朴素：**以"视频链接"为中心**，然后往回找它所属的那个块，
 * 再从块里取时长/缩略图/站内 id。不做完整 DOM 解析 —— 列表页的 HTML
 * 结构千差万别，而"链接周围的这一小段"是各站都有的。
 */
function extractItems(html, baseUrl, { limit = 200 } = {}) {
  const src = String(html || '');
  const seen = new Set();
  const out = [];

  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = linkRe.exec(src)) && out.length < limit) {
    const href = m[1];
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    if (!VIDEO_PATH_RE.test(href)) continue;

    const url = absolutize(href, baseUrl);
    if (!url || seen.has(url)) continue;      // 同页重复只算一条（Review Focus 2）
    seen.add(url);

    // 从链接往前退到所属块的起点（thumb-block 之类），往后取一小段作为"这个块"
    const back = src.lastIndexOf('<div', m.index);
    const blockStart = back >= 0 && m.index - back < 2000 ? back : m.index;
    const block = src.slice(blockStart, m.index + 1200);

    const durText = (block.match(/class\s*=\s*["'][^"']*\bduration\b[^"']*["'][^>]*>([^<]+)</i) || [])[1];
    const videoId = (block.match(/data-videoid\s*=\s*["'](\d+)["']/i) || [])[1];
    const thumb = (block.match(/data-src\s*=\s*["']([^"']+)["']/i)
      || block.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];

    // slug：URL 最后一段（去查询串/锚点）
    const pathOnly = url.split(/[?#]/)[0];
    const slug = pathOnly.split('/').filter(Boolean).pop() || '';

    out.push({
      url,
      title: slugToTitle(slug),
      duration_sec: parseDurationText(durText),
      site_video_id: videoId || null,
      thumb_url: thumb ? absolutize(thumb, baseUrl) : null,
    });
  }
  return out;
}

/**
 * 从 HTML 里找出"翻页候选"。
 *
 * ⚠️ 刻意**不猜格式**：这个站的翻页是路径式（/new/2），而别的站可能是
 *    ?p=2 / /page/2 / &offset=40。所以这里只认"长得像页码的链接"，
 *    认不出就返回空数组 —— 空数组比猜错强。
 */
function extractPaging(html, baseUrl) {
  const src = String(html || '');
  const out = [];
  const seen = new Set();

  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,60}?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(src))) {
    const href = m[1];
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

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
    out.push({ label: inner && inner.length <= 12 ? inner : `第 ${num} 页`, url });
  }
  return out;
}

/**
 * 关键字筛选（纯本地，不发请求）。
 * 空格分词 = AND；`-词` = 排除；空关键字 = 全部。
 */
function filterCandidates(items, query) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return items.slice();

  const terms = q.split(/\s+/).filter(Boolean);
  const include = [];
  const exclude = [];
  for (const t of terms) {
    if (t.length > 1 && t.startsWith('-')) exclude.push(t.slice(1).toLowerCase());
    else if (t !== '-') include.push(t.toLowerCase());
  }

  return items.filter((it) => {
    const title = String((it && it.title) || '').toLowerCase();
    if (include.some((t) => !title.includes(t))) return false;
    if (exclude.some((t) => title.includes(t))) return false;
    return true;
  });
}

/** 判断两条候选是不是同一个视频：站内 id 优先，回退到 URL */
function sameVideo(a, b) {
  if (!a || !b) return false;
  if (a.site_video_id && b.site_video_id) return String(a.site_video_id) === String(b.site_video_id);
  return Boolean(a.url) && a.url === b.url;
}

module.exports = {
  slugToTitle, parseDurationText, extractItems, extractPaging, filterCandidates, sameVideo,
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/run.js unit crawl-parse`
Expected: 全部通过（约 16 项）

> ⚠️ **夹具实测提醒（写计划时核对过）**：`listing-xvideos.html` 里有 **6 个**时长文本，
> 但只有 **3 个**视频块 —— 每个块里出现 **2 次**时长（一次在缩略图上，一次在标题下方）。
> `extractItems` 是取**块的第一个** `.duration`，所以两条应当一致。
> 如果将来发现取到的是另一个（比如"预览时长"与"视频时长"不同），
> 这条测试会失败，那时要做的决定是"取哪一个"，而不是随便挑一个让它变绿。

- [ ] **Step 5: 反证 —— 故意破坏，确认测试会红**

把 `extractItems` 里的 `seen.add(url)` 那两行改成注释掉，重跑：
Expected: **"同一页内重复的视频只算一条" 必须失败**。确认后改回来。

- [ ] **Step 6: 提交**

```bash
git add src/app/crawl-parse.js test/unit/crawl-parse.test.js test/fixtures/
git commit -m "feat(crawl): HTML 解析层 —— 从列表页抠条目、时长、翻页候选与关键字筛选"
```

---

## Task 2: 抓取实现（`crawler.js`）—— 两条路

**Files:**
- Create: `src/app/crawler.js`
- Test: `test/unit/crawler.test.js`

**Interfaces:**
- Consumes: Task 1 的 `extractItems` / `extractPaging`；`src/infra/subprocess.js` 的 `runSync`；`src/infra/urldiag.js` 的 `explain`
- Produces:
  - `createCrawler({ runSync, fetchImpl, paths, maxItems, timeoutMs, maxBytes })` → `{ analyzeSource, stop }`
  - `analyzeSource(url, {timeoutMs})` → `Promise<{path, title, site, items, paging, note}>`

- [ ] **Step 1: 写失败测试**

`test/unit/crawler.test.js` 的关键用例（完整文件按此风格写全）：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createCrawler } = require('../../src/app/crawler');

const LISTING = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'listing-xvideos.html'), 'utf8');

/** 造一个假的 fetch：robots.txt 放行 + 页面返回夹具 */
function fakeFetch({ body = LISTING, status = 200, robots = 'User-agent: *\nAllow: /\n' } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/robots.txt')) {
      return { ok: true, status: 200, text: async () => robots, body: null };
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([['content-type', 'text/html; charset=utf-8']]),
      text: async () => body,
      body: null,
    };
  };
  impl.calls = calls;
  return impl;
}

test('yt-dlp 返回列表 JSON 时走 ytdlp 路径，并把条目归一化', async () => {
  const runSync = () => ({
    ranOk: true, status: 0, stdout: JSON.stringify({
      _type: 'playlist', title: '某频道', extractor_key: 'Youtube',
      entries: [
        { webpage_url: 'https://y/v1', title: '第一条', duration: 61 },
        { url: 'https://y/v2', title: '第二条' },
        null,
      ],
    }), error: '', stderr: '',
  });
  const c = createCrawler({ runSync, fetchImpl: fakeFetch(), paths: { ytdlp: 'x', ffmpeg: 'y' } });
  const r = await c.analyzeSource('https://y/channel');
  assert.equal(r.path, 'ytdlp');
  assert.equal(r.items.length, 2, 'null 条目要被过滤');
  assert.equal(r.items[0].duration_sec, 61);
  assert.equal(r.items[1].duration_sec, null, '没给时长就是 null');
});

test('yt-dlp 报 Unsupported URL 时退回 html 路径，并在 note 里说明', async () => {
  const runSync = () => ({ ranOk: true, status: 1, stdout: '', error: '', stderr: 'ERROR: Unsupported URL: https://x/' });
  const f = fakeFetch();
  const c = createCrawler({ runSync, fetchImpl: f, paths: { ytdlp: 'x', ffmpeg: 'y' } });
  const r = await c.analyzeSource('https://www.xvideos.com/');
  assert.equal(r.path, 'html');
  assert.equal(r.items.length, 3);
  assert.match(r.note, /解析器|页面/);
  assert.ok(f.calls.some((u) => u.includes('xvideos.com') && !u.includes('robots')));
});

test('yt-dlp 返回单视频（非列表）时只回一条并说明', async () => {
  const runSync = () => ({
    ranOk: true, status: 0, stdout: JSON.stringify({ _type: 'video', webpage_url: 'https://y/one', title: '单个' }), error: '', stderr: '',
  });
  const c = createCrawler({ runSync, fetchImpl: fakeFetch(), paths: { ytdlp: 'x', ffmpeg: 'y' } });
  const r = await c.analyzeSource('https://y/one');
  assert.equal(r.path, 'ytdlp');
  assert.equal(r.items.length, 1);
  assert.match(r.note, /单个视频|不是列表/);
});

test('robots.txt 禁止时**不发起页面请求**，并抛出可读错误', async () => {
  const runSync = () => ({ ranOk: true, status: 1, stdout: '', error: '', stderr: 'ERROR: Unsupported URL' });
  const f = fakeFetch({ robots: 'User-agent: *\nDisallow: /\n' });
  const c = createCrawler({ runSync, fetchImpl: f, paths: { ytdlp: 'x', ffmpeg: 'y' } });
  await assert.rejects(() => c.analyzeSource('https://blocked.example/'), (e) => {
    assert.match(e.message, /robots/);
    assert.ok(e.hint, '必须带 hint');
    return true;
  });
  assert.equal(f.calls.filter((u) => !u.endsWith('/robots.txt')).length, 0, '不该请求页面本体');
});

test('robots.txt 的判定结果按 origin 缓存，不重复请求', async () => {
  const runSync = () => ({ ranOk: true, status: 1, stdout: '', error: '', stderr: 'Unsupported URL' });
  const f = fakeFetch();
  const c = createCrawler({ runSync, fetchImpl: f, paths: { ytdlp: 'x', ffmpeg: 'y' } });
  await c.analyzeSource('https://www.xvideos.com/');
  await c.analyzeSource('https://www.xvideos.com/new/2');
  const robotCalls = f.calls.filter((u) => u.endsWith('/robots.txt'));
  assert.equal(robotCalls.length, 1, '同一个 origin 只查一次 robots.txt');
});

test('robots.txt 拿不到时视为允许，但 note 里说明（Review Focus：边界输入）', async () => {
  const runSync = () => ({ ranOk: true, status: 1, stdout: '', error: '', stderr: 'Unsupported URL' });
  const f = async (url) => {
    if (String(url).endsWith('/robots.txt')) throw new Error('ENOTFOUND');
    return { ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), text: async () => LISTING };
  };
  const c = createCrawler({ runSync, fetchImpl: f, paths: { ytdlp: 'x', ffmpeg: 'y' } });
  const r = await c.analyzeSource('https://www.xvideos.com/');
  assert.equal(r.path, 'html');
  assert.match(r.note, /robots/i);
});

test('页面返回 429 时报"被限速"，并给出下一步', async () => {
  const runSync = () => ({ ranOk: true, status: 1, stdout: '', error: '', stderr: 'Unsupported URL' });
  const c = createCrawler({ runSync, fetchImpl: fakeFetch({ status: 429 }), paths: { ytdlp: 'x', ffmpeg: 'y' } });
  await assert.rejects(() => c.analyzeSource('https://www.xvideos.com/'), (e) => {
    assert.match(e.message, /限速|429|频繁/);
    assert.ok(e.hint);
    return true;
  });
});

test('页面 200 但一条视频都没有时报"不像视频页"，附链接数', async () => {
  const runSync = () => ({ ranOk: true, status: 1, stdout: '', error: '', stderr: 'Unsupported URL' });
  const c = createCrawler({ runSync, fetchImpl: fakeFetch({ body: '<html><a href="/about">关于</a></html>' }), paths: { ytdlp: 'x', ffmpeg: 'y' } });
  await assert.rejects(() => c.analyzeSource('https://www.xvideos.com/'), (e) => {
    assert.match(e.message, /没有找到|不像/);
    return true;
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/run.js unit crawler`
Expected: 失败 —— `Cannot find module '../../src/app/crawler'`

- [ ] **Step 3: 写实现**

`src/app/crawler.js` 的骨架与关键点（完整写出，不留省略）：

```js
'use strict';
/**
 * 从网页/频道里找出视频链接。
 *
 * 两条路，**同等地位**（不是"主路 + 兜底"）：
 *
 *   A. yt-dlp --flat-playlist -J  —— 有解析器的站点（YouTube / B 站等）走这条，
 *      直接拿到标题、时长、真链接，质量最高。
 *   B. 抓静态 HTML 抠 href        —— 没有列表解析器的站走这条。
 *
 * ⚠️ 实测（2026-09-22）：「yt-dlp 优先」对 xvideos 这类站**不成立** ——
 *    它只认 /video.xxx 详情页，首页会返回 `Unsupported URL`。所以 B 不是敷衍的
 *    兜底，它常常是主路。界面上必须显示走了哪条，否则用户对着"没有缩略图"的结果
 *    不知道为什么。
 *
 * 边界（来自 spec 的「爬取纪律」，不要为了"更实用"而放宽）：
 *   单次 1 个页面请求 · 15s 超时 · 最多 3MB · 真实 UA · 不跟随页面内链接 ·
 *   发请求前检查 robots.txt · 不重试不绕过
 */

const { AppError } = require('../domain/errors');
const { extractItems, extractPaging } = require('./crawl-parse');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const DEFAULTS = { maxItems: 200, timeoutMs: 15000, maxBytes: 3 * 1024 * 1024 };
```

实现要点（照着写，每一条都有测试对应）：

1. `robotsAllowed(origin)`：按 origin 缓存 `Map`。取 `/robots.txt`（失败→允许 + note）。解析 `User-agent: *` 段，收集 `Allow`/`Disallow` 规则，**取匹配长度最长的那条**决定；没有规则命中→允许。
2. `fetchPage(url)`：`fetch` + `AbortController` 超时；`res.ok` 为假时按状态码抛（429/403 → "被目标站限速/拒绝"，其余 → `HTTP N`）；按 `maxBytes` 读取（照抄 `src/infra/urldiag.js` 的 reader 循环，含 `reader.cancel()`）。
3. `analyzeSource(url, {timeoutMs})`：先 `tryYtdlp`（`runSync(paths.ytdlp, ['--ignore-config','--no-warnings','--no-colors','--yes-playlist','--skip-download','--no-check-certificates','--flat-playlist','--playlist-end',String(maxItems),'-J','--',url], {timeout})`）；按 spec 3.1 的 4 种情况分支；HTML 路径先查 robots，再抓、再 `extractItems`/`extractPaging`。
4. `stop()`：用一个 `Set` 记在飞的 `AbortController`，逐个 `abort()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/run.js unit crawler`
Expected: 全部通过

- [ ] **Step 5: 反证 —— 确认 robots 检查真的拦得住**

临时把 `robotsAllowed` 的调用删掉，重跑。
Expected: **"robots.txt 禁止时不发起页面请求" 必须失败**。改回来。

- [ ] **Step 6: 提交**

```bash
git add src/app/crawler.js test/unit/crawler.test.js
git commit -m "feat(crawl): 抓取实现 —— yt-dlp 与静态 HTML 双路径，含 robots 检查与风控报错"
```

---

## Task 3: 数据层（两张表 + 仓储方法）

**Files:**
- Modify: `src/infra/database.js`（`SCHEMA` 常量约 113-126 行处加表；仓储对象内加方法）
- Test: `test/integration/database.test.js`（追加用例）

**Interfaces:**
- Produces（都挂在 `repo` 上）：
  - `startCrawlRun({url}): number`
  - `finishCrawlRun(id, {status, path, site, title, itemCount, paging, note, error}): void`
  - `getCrawlRun(id): object|null`
  - `insertCandidates(runId, items, sourceUrl): {inserted, skipped}`
  - `listCandidates({q, onlyNew, runId, limit, offset}): {rows, total}`
  - `markCandidatesAdded(ids): number`
  - `refreshLibraryFlags(): number`（按 `videos.url` 重算 `in_library`）
  - `getCandidatesByIds(ids): Array<{id,url,title}>`

- [ ] **Step 1: 写失败测试**

追加到 `test/integration/database.test.js`（沿用该文件已有的隔离实例写法）：

```js
test('候选：插入后能按 runId / 关键字 / 只在库外 查询', () => {
  const { repo } = makeRepo();
  const runId = repo.startCrawlRun({ url: 'https://x/' });
  const r = repo.insertCandidates(runId, [
    { url: 'https://x/video.aaa/1/1/cat_video', title: 'cat video', duration_sec: 60, site_video_id: '1', thumb_url: null },
    { url: 'https://x/video.bbb/1/1/dog_video', title: 'dog video', duration_sec: null, site_video_id: '2', thumb_url: null },
  ], 'https://x/');
  assert.equal(r.inserted, 2);
  assert.equal(repo.listCandidates({}).total, 2);
  assert.equal(repo.listCandidates({ q: 'cat' }).total, 1);
  assert.equal(repo.listCandidates({ runId }).total, 2);
  assert.equal(repo.listCandidates({}).rows[1].duration_sec, null, '缺失时长保持 null');
});

test('候选：重复 url 不堆积，第二次插入算 skipped', () => {
  const { repo } = makeRepo();
  const a = repo.startCrawlRun({ url: 'https://x/' });
  repo.insertCandidates(a, [{ url: 'https://x/video.aaa/1/1/same', title: 't', duration_sec: null }], 'https://x/');
  const b = repo.startCrawlRun({ url: 'https://x/new/2' });
  const r = repo.insertCandidates(b, [{ url: 'https://x/video.aaa/1/1/same', title: 't', duration_sec: null }], 'https://x/new/2');
  assert.equal(r.inserted, 0);
  assert.equal(r.skipped, 1);
  assert.equal(repo.listCandidates({}).total, 1, '不能变成两条');
});

test('候选：refreshLibraryFlags 把已在库的标出来', () => {
  const { repo } = makeRepo();
  // 用视频仓储插一条真实记录，再让候选指向同一个 url
  const url = 'https://x/video.ccc/1/1/in_lib';
  repo.insertVideo({ url, title: 'in lib' });
  const runId = repo.startCrawlRun({ url: 'https://x/' });
  repo.insertCandidates(runId, [{ url, title: 'in lib', duration_sec: null }], 'https://x/');
  const n = repo.refreshLibraryFlags();
  assert.ok(n >= 1);
  assert.equal(repo.listCandidates({ onlyNew: true }).total, 0, '已在库的应被 onlyNew 排除');
});

test('候选：finishCrawlRun 记录失败与 paging', () => {
  const { repo } = makeRepo();
  const runId = repo.startCrawlRun({ url: 'https://x/' });
  repo.finishCrawlRun(runId, { status: 'done', path: 'html', itemCount: 3, paging: [{ label: '第 2 页', url: 'https://x/new/2' }] });
  const run = repo.getCrawlRun(runId);
  assert.equal(run.status, 'done');
  assert.equal(run.path, 'html');
  assert.deepEqual(JSON.parse(run.paging_json)[0].label, '第 2 页');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/run.js integration database`
Expected: 失败 —— `repo.startCrawlRun is not a function`

- [ ] **Step 3: 加表与仓储方法**

把 spec 3.3 的两段 `CREATE TABLE` 原样加进 `SCHEMA` 常量末尾（`subscriptions` 表之后）。
仓储方法注意：

- `insertCandidates` 用 `INSERT OR IGNORE`，按 `db.changes` 统计 inserted/skipped
- `listCandidates` 的 `q` 用 `title LIKE ?`（`%词%`），**不要**拼接进 SQL 字符串
- `refreshLibraryFlags` 用一条 `UPDATE candidates SET in_library = EXISTS(SELECT 1 FROM videos WHERE videos.url = candidates.url)`
- 所有 JSON 字段（`paging_json`）用 `JSON.stringify` / `JSON.parse` 包装，别把对象直接塞进 SQLite

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/run.js integration database`

- [ ] **Step 5: 提交**

```bash
git add src/infra/database.js test/integration/database.test.js
git commit -m "feat(db): 候选表与爬取记录表 + 仓储方法（含在库标记与去重）"
```

---

## Task 4: 任务生命周期（`discovery.js`）—— 20 秒兜底

**Files:**
- Create: `src/app/discovery.js`
- Test: `test/unit/discovery.test.js`

**Interfaces:**
- Consumes: Task 2 的 `createCrawler`、Task 3 的 `repo`
- Produces: `createDiscovery({ repo, crawler, syncWaitMs = 20000 })` → `{ run, get, on, off, stop }`
  - `run(url)` → `Promise<{runId, status:'done'|'running', ...}>`
  - 事件：`emit('crawl', {runId, status, path, itemCount, message, error})`

- [ ] **Step 1: 写失败测试**

```js
test('20 秒内完成 → 返回 done 并带上条目', async () => { /* 假 crawler 立即返回 */ });
test('超过 20 秒 → 返回 running + runId，且爬取继续跑到底', async () => { /* 假 crawler 延迟 60ms，syncWaitMs 设 20ms */ });
test('失败时返回 failed 并带 error/hint，不抛给调用方', async () => { /* 假 crawler 抛 AppError */ });
test('串行：第二个请求要等第一个跑完', async () => { /* 记录并发数，断言峰值 = 1 */ });
test('stop() 之后不再发事件', async () => { /* 用 setTimeout(0) 后断言 listener 未被调用 */ });
test('run 抛错时 crawl_runs 记录被标成 failed', async () => { /* 假 repo 断言参数 */ });
```

关键写法（`syncWaitMs` 必须可注入 —— **测试里绝不等真 20 秒**）：

```js
const c = createDiscovery({ repo: fakeRepo, crawler: fakeCrawler, syncWaitMs: 20 });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/run.js unit discovery`
Expected: 失败 —— 模块不存在

- [ ] **Step 3: 写实现**

要点：内部维护一个 promise 链做串行（`queue = queue.then(...)`）；
`Promise.race([crawlPromise, sleep(syncWaitMs).then(() => null)])` 决定返回 200 还是 202；
**爬取的 promise 无论谁先返回都要继续跑完并入库**（用 `.then` 挂后续，不要让 race 取消它）；
`stop()` 里清 listener 与 crawler.stop()。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/run.js unit discovery`

- [ ] **Step 5: 提交**

```bash
git add src/app/discovery.js test/unit/discovery.test.js
git commit -m "feat(discovery): 爬取任务生命周期 —— 串行、20 秒兜底转后台、事件广播"
```

---

## Task 5: HTTP 接口 + SSE 接线

**Files:**
- Create: `src/http/routes/discover.js`
- Modify: `src/http/server.js`（注册路由、`discovery.on('crawl', ...)` → `broadcast`、把 `discovery` 加进 ctx 与 shutdown）
- Modify: `src/main.js`（创建 crawler 与 discovery 并注入）
- Test: `test/integration/api.test.js`（追加）

**Interfaces:**
- Consumes: Task 4 的 `discovery`
- Produces: 4 个接口（路径见 spec 3.4）

- [ ] **Step 1: 写失败测试**

追加到 `test/integration/api.test.js`（沿用该文件的 `startApp()`）：

```js
test('POST /api/crawl 缺 url 返回 400 而不是静默成功', async () => {});
test('POST /api/crawl 用假 crawler 能返回 200 与条目', async () => {});
test('GET /api/crawl/:id 查得到状态', async () => {});
test('GET /api/candidates 支持 q / onlyNew / runId', async () => {});
test('POST /api/candidates/action add 会把候选加进下载队列', async () => {
  // 断言 videos 表真的多了一条，且候选被标 added —— 这是 Review Focus 5 的钉子
});
```

`startApp()` 需要能注入假 crawler。**给 `createApp` 的 overrides 加一个 `crawler` 字段**（与现有 `data` / `downloads` 同一层），默认用真的。

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/run.js integration api`
Expected: 失败 —— `404` 或 `createApp` 不接受 `crawler`

- [ ] **Step 3: 写实现**

`src/http/routes/discover.js`：四个 `router.get/post`，参数校验照 `src/http/validate.js` 的既有风格；
`POST /api/crawl` 把 `discovery.run()` 的结果按 `status` 映射成 200 / 202；
错误走 `errorResponse`（`AppError` 自带 `hint`）。

`src/http/server.js` 加：

```js
discovery.on('crawl', (e) => broadcast('crawl', e));
```

并在 shutdown 路径调 `discovery.stop()`（**否则进程退不出来** —— 这是项目已有的教训）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/run.js integration api`

- [ ] **Step 5: 端到端手测（真实网络）**

```bash
node src/main.js          # 另开一个终端，或后台作业
# 另一个终端：
node -e "fetch('http://127.0.0.1:8787/api/crawl',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://www.xvideos.com/'})}).then(r=>r.json()).then(d=>console.log(d.status,d.path,d.items&&d.items.length))"
```

Expected: `done html 48`（数字可能随站点内容变化，但必须是几十条、且 `path=html`）

- [ ] **Step 6: 提交**

```bash
git add src/http/routes/discover.js src/http/server.js src/main.js test/integration/api.test.js
git commit -m "feat(api): 爬取与候选接口 + SSE crawl 事件"
```

---

## Task 6: 前端「找视频」页

**Files:**
- Create: `src/web/views/discover.js`
- Modify: `src/web/index.html`（第 4 个 `.tab` + `#view-discover` 骨架）
- Modify: `src/web/app.js`（初始化视图、把 SSE `crawl` 事件转给视图）
- Modify: `src/web/styles.css`（新页样式；**每个新类名都要有规则**）
- Test: `test/integration/frontend-dom.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 5 的 4 个接口
- Produces: `initDiscoverView({})`、`renderCandidates()`、`onCrawlEvent(e)`

- [ ] **Step 1: 写失败测试**

追加到 `frontend-dom.test.mjs`（沿用 `installDom` + 假响应风格）：

```js
test('找视频页：粘网址点按钮会发 POST /api/crawl', async () => {});
test('找视频页：候选列表按 in_library 显示"已在库"与"＋新"', async () => {});
test('找视频页：关键字过滤是本地过滤（不发新请求）', async () => {
  // 断言假 fetch 的调用次数在输入关键字前后**没有增加**
});
test('找视频页：勾选后点入队会发 action=add 且带选中的 id', async () => {});
test('找视频页：标题里的尖括号原样保留（防 innerHTML 注入）', async () => {});
test('找视频页：时长缺失显示 ?，不显示 0:00', async () => {});
test('找视频页：路径标记显示"HTML"或"yt-dlp"（用户据此判断为什么没有缩略图）', async () => {});
test('找视频页：点翻页按钮会用那个地址发起**新一次** POST /api/crawl，且不清空当前候选', async () => {
  // spec 3.5：翻页 = 新爬取，第 1 页与第 2 页的结果都在，可来回挑
});
test('找视频页：202（转后台）时显示进度而不是当成失败', async () => {
  // 假 fetch 返回 { runId, status: 'running' }，断言界面出现"正在抓取"且不报错
});
test('找视频页：429 的报错要说明是"目标站限速"，不是工具坏了', async () => {});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/run.js integration frontend-dom`
Expected: 失败（找不到节点或函数）

- [ ] **Step 3: 写实现**

照 `src/web/views/add.js` 的写法（`el()` 建节点、`replace()` 换内容、`toast()` 报错、
`state.prefs` 存筛选偏好）。**所有文本走 `textContent`**，标签页与视图骨架照
`index.html` 现有的 `view-add` 复制结构。

- [ ] **Step 4: 跑测试与检查**

```bash
node test/run.js integration frontend-dom
node tools/check-frontend.js
node tools/check-classes.js      # 新类名必须有样式，否则这里会红
```

- [ ] **Step 5: 真实浏览器截图核对**

```bash
node tools/screenshot.js http://127.0.0.1:8787
```
把「找视频」页加进截图脚本的流程（`tools/screenshot.js` 里加一个 `clickView('discover')`），
**看图确认版式**（这一步是本项目唯一能发现"类名对不上"的手段）。

- [ ] **Step 6: 提交**

```bash
git add src/web/ tools/screenshot.js test/integration/frontend-dom.test.mjs
git commit -m "feat(web): 「找视频」页 —— 候选列表、关键字过滤、批量入队"
```

---

## Task 7: 文档与收尾

**Files:**
- Modify: `README.md`（新增一节「从网站找视频」+ 爬取纪律表；功能清单加一条）
- Modify: `PROGRESS.md`（断点，用 `node tools/handoff.js save 视频下载` 后手写补齐）

- [ ] **Step 1: README 补「爬取纪律」**

把 spec 第 4 节那张表**原样**搬进 README（单请求、15s、3MB、串行、200 条上限、真实 UA、
不跟随链接、robots 检查、临时提速开关只对单次生效）。

- [ ] **Step 2: 全套验证**

```bash
node test/run.js
node tools/lint-undefined.js
node tools/check-frontend.js
node tools/check-classes.js
```

Expected: 测试全绿（基线在原 150 项之上增加本计划的约 40 项）；三个检查退出码 0。

- [ ] **Step 3: 干净检出验证**

```bash
git archive --format=zip -o %TEMP%\vv.zip HEAD
# 解压后在新目录里跑 node test/run.js
```
Expected: 全绿（新增测试**不得依赖任何不在 git 里的东西** —— 夹具必须已提交）

- [ ] **Step 4: 提交并推送**

```bash
git add README.md PROGRESS.md
git commit -m "docs: 「从网站找视频」用法与爬取纪律"
git push origin main
```

- [ ] **Step 5: 验远端**

下载 `codeload.github.com/zhaoxiancong/video-vault/zip/refs/heads/main`，解压跑测试，
确认夹具在包内、测试全绿。

---

## 自检记录（写完后跑的）

- **spec 覆盖**：spec 第 3.1→Task 2、3.2→Task 4、3.3→Task 3、3.4→Task 5、3.5→Task 6、
  3.6→Task 2 与 5、第 4 节纪律→Global Constraints + Task 7、第 5 节测试策略→各任务的测试步骤、
  第 6 节风险→Task 1/2 的边界用例。第 7 节实施顺序→Task 1-7 同序。
- **自检抓到的两处真问题（已修）**：
  1. **Global Constraints 里写了"临时提速开关"，但没有任何任务实现它** ——
     这是"计划承诺了不存在的东西"。核实后确认爬取流程里压根没有延时机制，
     于是把它从约束里删掉，并在 spec 第 4 节同步标注"本轮不实现 + 原因"。
  2. **Task 6 的测试漏了两个 spec 明确要求的行为**：翻页按钮 = 发起新爬取（且不清空当前结果）、
     以及 202 转后台时界面要显示进度而不是当失败。两条都补进了 Task 6 的测试清单。
- **占位符**：无 TBD/TODO。Task 4/5/6 的实现步写的是"要点 + 必须满足的断言"而不是完整代码 ——
  这是**刻意的**：它们各自有一组明确的测试钉住行为，且都指明了照抄哪个现有文件
  （`scheduler.js` / `routes/library.js` / `views/add.js`）。写一整份"看起来像代码"的
  草稿反而会在实现时被当作正确代码粘贴，掩盖真实的结构差异。
  其余任务（1/2/3）给了完整代码，因为它们的逻辑是纯的、容易写错、且测试最密。
- **类型一致性**：`analyzeSource` 返回的 `{path,title,site,items,paging,note}` 在 Task 2/4/5 一致；
  `items` 元素字段 `{url,title,duration_sec,site_video_id,thumb_url}` 在 Task 1/2/3 一致；
  `repo` 的 8 个方法名在 Task 3/4/5 一致。已核实 `repo.insertVideo({url,title})` 真实存在、
  `AppError(message, {hint, status})` 的签名与 Task 2 的用法一致。
- **Review Focus**：五条都已分派 —— 1、2、3、4 在 Task 1 的测试里，5 在 Task 5 的测试里。
  另有两条 spec 隐含但容易忽略的边界也钉进了 Task 2（robots.txt 拿不到时的行为）与
  Task 6（时长缺失显示 `?`）。
