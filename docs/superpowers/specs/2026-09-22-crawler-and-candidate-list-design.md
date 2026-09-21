# 设计：从网站找视频（爬取 + 候选列表）

- 日期：2026-09-22
- 状态：待用户审阅
- 范围：**只做爬取与候选列表**。常用网站 / 站内搜索模板 / 订阅追更留给后续轮次。

---

## 1. 目标

让用户能粘一个**网页地址**（不一定是视频链接，通常是列表页或站点首页），从里面找出视频链接，
用关键字筛选后勾选、批量加入下载队列；**候选结果持久化**，关掉浏览器明天回来还能接着挑。

### 成功标准

1. 粘 `https://www.xvideos.com/` → 列出约 48 条候选，每条有标题、时长、是否已在库
2. 关键字过滤**不发网络请求**（在已加载的候选里即时筛）
3. 勾选若干条 → 一键入队 → 走进现有的下载流程
4. 关掉浏览器再打开 → 候选列表还在
5. 遇到慢站（>20 秒）→ 界面显示进度而不是干等或超时

> 每条都**可验证**：1 用真实站跑一次；2 用抓包或断网验证；3 看队列里真的多出任务；
> 4 重开页面看列表；5 用注入的慢爬取函数测（不等真 20 秒）。

### 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| 自动翻页 | 用户明确选择"把翻页链接列出来给我点" |
| 站内搜索 URL 模板 | 需要"每站搜索 URL 长什么样"的配置，属于下一轮「常用网站」 |
| 用真浏览器渲染 JS 页面 | 需要 Chrome，重且慢；本轮先靠 yt-dlp + 静态 HTML |
| 定时自动抓取 | 那是「订阅追更」（二期第二项），与爬取共用表但不是同一件事 |
| 整站爬虫（跟随页面内链接） | 越过站点条款；`urldiag.js` 已有这条边界，继续遵守 |
| 复制站点的列表视觉 | 只取数据，界面是本工具自己的 |

---

## 2. 实测证据（2026-09-22，真实网络请求）

对 `https://www.xvideos.com/`（用户提供的真实地址）做过一次双路径实测。
**这些数字是设计依据，不是估算**：

| 项目 | 实测值 |
|---|---|
| 路径 A（`yt-dlp --flat-playlist -J`） | **失败**：`ERROR: Unsupported URL: https://www.xvideos.com/`（3.9s） |
| 路径 B（抓静态 HTML） | **成功**：HTTP 200 · `nginx` · **无 Cloudflare 挑战** · 1.1s · 198 KB |
| 本域链接总数 | 175 |
| 命中"视频详情页" | **48 条** |
| 时长 | **有**：`<span class="duration">11分钟</span>` |
| 站内视频 id | **有**：`data-videoid="91951075"` |
| 标题 | 在 URL 里：`/video.<id>/<数字>/<slug>`，slug 即标题 |
| 翻页 | **路径式**：`/new/1` … `/new/10`（**不是** `?p=N`） |

### 这次实测推翻的两个假设

1. **"yt-dlp 优先"对这个站不成立** —— 它没有列表解析器，只认 `/video.xxx/...` 详情页。
   所以路径 B 不是"退路"，对这个站它是**主路**。设计上两条路必须同等对待，不能把 B 当兜底敷衍。
2. **翻页不能靠猜格式** —— 原计划匹配 `[?&](p|page)=\d+`，而这个站用路径式 `/new/N`，
   一条都匹配不到。如果照原计划实现，用户会看到"翻页链接 0 个"且不知为何。

### 纪律（实测时遵守的，实现时同样）

单次请求 · 15s 超时 · 最多 3MB · 真实 UA + `Accept-Language` · 不跟随页面内链接 · 不重试不绕过。

---

## 3. 架构

三个新单元 + 一处复用，依赖方向仍然单向朝内（`http → app → infra`）：

```
src/app/crawler.js           新增  抓取实现（纯逻辑，可单独测）
src/app/discovery.js         新增  爬取任务的生命周期 + 事件广播
src/http/routes/discover.js  新增  4 个 HTTP 接口
src/web/views/discover.js    新增  「找视频」页
src/infra/database.js        改动  加两张表 + 仓储方法
src/infra/urldiag.js         复用  VIDEO_PATH_RE 与抓取边界
src/http/server.js           改动  注册路由 + 转发 crawl 事件到 SSE
src/web/index.html           改动  加顶级标签与视图骨架
src/web/styles.css           改动  新页样式
```

### 3.1 `crawler.js` —— 唯一的抓取实现

对外只暴露两个函数：

```js
/**
 * 分析一个来源地址，返回候选条目。
 * 先试 yt-dlp；失败则抓静态 HTML。
 * @returns {Promise<{
 *   path: 'ytdlp'|'html',
 *   title: string|null,
 *   site: string|null,
 *   items: Array<{url,title,duration_sec,site_video_id,thumb_url}>,
 *   paging: Array<{label:string,url:string}>,
 *   note: string|null        // 给用户看的说明（例如"该站无列表解析器，已改用页面解析"）
 * }>}
 */
async function analyzeSource(url, opts) {}

function stop() {}   // 清掉在飞的请求（AbortController）
```

**路径选择逻辑**：

1. 跑 `yt-dlp --flat-playlist -J --playlist-end 200`
2. 输出是 JSON 且 `entries` 是数组 → **路径 A**，逐条取 `webpage_url` / `title` / `duration`
3. 输出是单个对象（不是列表）→ 返回 `items: [那一条]` 并标注"这是一个单视频页，不是列表"
4. 任何失败（`Unsupported URL` / 非零退出 / 无 JSON）→ 转 **路径 B**
5. 路径 B：抓 HTML（纪律见上）→ 用 `urldiag.VIDEO_PATH_RE` 抠本域链接 → 去重 →
   每条解析：标题（slug 反转义）、时长（`.duration` 文本）、`site_video_id`（就近的 `data-videoid`）、缩略图（`data-src`）
6. 两条路都失败 → 抛出带 `hint` 的 `AppError`，文案复用 `urldiag.explain()` 的既有话术

**为什么复用它而不是重写**：`VIDEO_PATH_RE` 已经过生产验证（它现在就在下载失败路径上跑），
为新站点加规则只需改一处。

### 3.2 `discovery.js` —— 任务生命周期

对标 `scheduler.js` 的写法（`EventEmitter` + `stop()` 清理）：

```js
createDiscovery({ repo, crawler, broadcast }) → {
  run(url)        // 起一次爬取，返回 { runId, promise }
  get(runId)      // 查状态
  stop()          // 清定时器/监听器（挂到 app.shutdown 上）
}
```

**20 秒兜底的确切语义**（这是本轮最容易做错的地方）：

不是"跑到一半切换模式"，而是**爬取一开始就在后台跑，POST 只负责等最多 20 秒**：

| 情况 | HTTP | 响应体 | 前端行为 |
|---|---|---|---|
| 20 秒内完成 | `200` | `{runId, status:'done', path, items, paging}` | 直接渲染 |
| 超过 20 秒 | `202` | `{runId, status:'running'}` | 订阅 SSE 看进度；**爬取继续跑到底并入库** |
| 失败 | `400/502` | `{error, hint}` | 显示错误 + 下一步建议 |

关键性质：**客户端断开（关浏览器）不影响爬取完成**。结果照样入库，
所以"关掉浏览器明天回来还能挑"这条自动成立。

事件：`emit('crawl', {runId, phase, done, total, message})`，`server.js` 里加一行
`discovery.on('crawl', (e) => broadcast('crawl', e))`，与现有
`scheduler.on('progress', ...)` 完全同构。

### 3.3 数据模型

```sql
CREATE TABLE IF NOT EXISTS crawl_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',   -- running | done | failed
  path        TEXT,                              -- ytdlp | html
  site        TEXT,
  title       TEXT,
  item_count  INTEGER DEFAULT 0,
  paging_json TEXT,                              -- [{label,url}]
  note        TEXT,
  error       TEXT,
  started_at  TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS candidates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  url            TEXT NOT NULL UNIQUE,
  site_video_id  TEXT,
  title          TEXT,
  duration_sec   INTEGER,
  thumb_url      TEXT,
  source_url     TEXT,          -- 它是从哪个页面被发现的
  in_library     INTEGER DEFAULT 0,
  added_at       TEXT,          -- 非空 = 已加入下载队列
  created_at     TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_candidates_lib ON candidates(in_library);
```

**设计决定及理由**：

- `url` 用 `UNIQUE`：同一条视频在不同轮次被爬到不会重复堆积
- `site_video_id` **优先做去重键，回退到 `url`**：站内 id 比 slug 稳定（slug 会被人改）
- `in_library` 是**爬取时对 `videos.url` 做一次 `IN` 查询的快照**，不是外键 ——
  用户的库随时在变，界面上还要能手动刷新
- `candidates` **不写进 `videos` 表**：候选不是下载任务，混进去会污染"我的库"的
  计数、筛选与查询
- **`subscriptions` 表本轮不动**。它有 `url UNIQUE` / `enabled` / `check_interval_min` 等
  字段，是下一轮「常用网站 / 订阅追更」的落点；本轮不新建 `sites` 表，避免一个概念两张表

### 3.4 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/crawl` | body `{url}`。起一次爬取。200=已完成 / 202=转后台 |
| `GET` | `/api/crawl/:id` | 查状态与进度（SSE 断线时兜底） |
| `GET` | `/api/candidates` | `q=` 关键字 · `onlyNew=1` 只看未下载 · `runId=` 限定某次 · `limit`/`offset` |
| `POST` | `/api/candidates/action` | body `{action:'add', ids:[...]}`。**批量入队复用现有 `POST /api/videos` 那条路**，不重写下载入队逻辑 |

`/api/candidates` 的返回每条带 `in_library`、`added`（是否已入队）、`crawled_at`。

### 3.5 界面：「找视频」标签

新增顶级标签（现有为 3 个，变 4 个）。页面自上而下：

```
┌ 网址 [_______________________________] [从网站找] ──────────────┐
│ 状态：走了 HTML 路径 · 找到 48 条 · 用时 1.1s · 该站无列表解析器   │
└──────────────────────────────────────────────────────────────────┘
┌ 关键字 [____________]  ☐ 只看未下载   已选 3 条 [加入下载队列] ┐
│                                     [刷新库状态]                │
├──────────────────────────────────────────────────────────────────┤
│ ☐  11分钟   krump - no.2 - ai-generated              已在库      │
│ ☑   4分钟   sayoko machimura blowjob                 ＋新        │
│ ☐   ?       skinny ebony beauty with perfect ...      ＋新        │
└──────────────────────────────────────────────────────────────────┘
翻页：[第1页] [第2页] [第3页] … （点了就用那个地址重新爬）
```

- **关键字是纯本地过滤**：空格分词 = AND；`-词` = 排除。不重新请求网络
- 时长缺失显示 `?`（有些列表页没有时长角标）
- 路径标记（`yt-dlp` / `HTML`）**必须显示** —— 两条路的失败模式不同，
  用户看到"走了 HTML"才知道为什么没有缩略图
- 翻页按钮点击 = 用那个地址**发起一次新爬取**（`crawl_runs` 多一条），
  不是替换当前结果 —— 所以"第 1 页的结果"和"第 2 页的结果"都在，可以来回挑

### 3.6 错误与风控反馈

| 情况 | 界面文案方向 |
|---|---|
| HTTP 429 / 403 | 明说**"目标站在限速/拒绝"**，不是工具坏了；给出"等几分钟再试"和"临时提速开关"两个选项 |
| Cloudflare 挑战页 | 说明"这个站有反爬保护，服务端拿不到内容"，并建议改用 yt-dlp 能认的地址 |
| 页面 0 条视频链接 | 用 `urldiag.explain()` 的既有话术（"这不像视频页…"），附检测到的链接数 |
| 超时 | "目标站 15 秒没响应"，建议重试或换地址 |

所有文案走 `textContent`（**不拼 `innerHTML`**），且**不写 Markdown 记号** ——
这两条都是项目已有的回归测试钉住的约定。

---

## 4. 爬取纪律（写进 README，作为设计约束而非可调参数）

| 约束 | 值 | 理由 |
|---|---|---|
| 单次爬取的网络请求数 | **1**（用户点翻页 = 新一次） | 不整站爬 |
| 超时 | 15s | 与 `urldiag.js` 一致 |
| 响应体上限 | 3MB | 实测页面 198KB，留足余量 |
| 并发 | 串行（一次只跑一个爬取） | 避免被风控 |
| 单次条数上限 | 200 | 与 `probePlaylist` 默认值一致；**不自动多拿凑满** |
| UA | 真实浏览器 UA | 与 `urldiag.js` 一致 |
| 跟随页面内链接 | **否** | 不整站爬 |
| robots.txt | 发请求前**检查一次**并缓存结果；`Disallow` 命中则**不抓**，返回明确说明 | 本轮新增的自我约束 |
| "临时提速"开关 | 只在**同一次**爬取内生效，重载即失效 | 避免留成一个长期"关掉护栏"的开关 |

**robots.txt 的确切行为**（不留模糊）：

1. 抓目标页**之前**，先 `GET /robots.txt`（同样 15s 超时、不加 UA 伪装、复用同一个 `fetch`）
2. 按 `User-agent: *` 段（以及匹配我们 UA 的段，如果有）判定目标路径是否 `Disallow`
3. 命中 `Disallow` → **不发起抓取**，返回 `AppError`：`该站的 robots.txt 不允许抓取这个路径`，
   并把命中的那条规则原文附上，让用户自己判断
4. `robots.txt` 拿不到（404 / 超时 / 网络错误）→ **视为允许**，继续抓，但在 `note` 里
   记一句"未能读到 robots.txt"
5. 判定结果**按 origin 缓存在内存**（同一次会话内不重复请求同一个站的 robots.txt）

不做的事：不解析 `Crawl-delay`、不处理 `Sitemap`、不支持 `Allow` 的优先级细节
（`Allow`/`Disallow` 冲突时取更长的匹配规则 —— 这条要按标准做，否则等于假装遵守）。

---

## 5. 测试策略

| 层次 | 做法 |
|---|---|
| `crawler.js` 纯函数 | **固定 HTML 夹具**：把实测那个 198KB 页面裁一小段（含 3-4 个视频块 + 翻页链接）存进 `test/fixtures/`。**不联网**，所以测试稳定、快 |
| 路径 A/B 选择 | 注入假的 `runSync`，分别返回"列表 JSON / 单视频 JSON / 报错"三种，断言走了哪条路 |
| `discovery.js` 的 20 秒兜底 | 注入假 `crawler`（可控延迟），**不等真 20 秒**；断言 200 与 202 两条分支各返回什么 |
| 仓储 | 沿用 `test/integration/database.test.js` 的隔离实例模式（临时目录，不碰用户库） |
| 接口 | 沿用 `test/integration/api.test.js` 的 `startApp()` 模式（随机端口） |
| 前端 | DOM 垫片（能测行为）+ **真实浏览器截图**（能测版式，见 `tools/screenshot.js`） |
| 类名一致性 | `tools/check-classes.js` 自动覆盖新页（它扫全量前端源码） |

**反证要求**：每条新增的"解析类"测试都要能被故意破坏而变红。
例如把 slug→标题的解析改错，测试必须失败 —— 否则那条测试等于没测
（项目在第三轮吃过这个教训）。

---

## 6. 风险与已知限制

| 风险 | 应对 |
|---|---|
| 目标站上 Cloudflare，服务端 `fetch` 拿不到内容 | 明确报"有反爬保护"；不实现绕过。**这是有意的限制** |
| 各站 HTML 结构千差万别，`VIDEO_PATH_RE` 可能不认某些站 | 规则集中在一处，按实际遇到的站增量加；界面显示"检测到 0 条"而不是静默空列表 |
| `data-videoid` 这类属性只有部分站有 | 它是**加分项**：没有就回退到 URL 去重 |
| 时长文本是"11分钟"这类本地化文案 | 解析器要容忍多种格式（`11分钟` / `11 min` / `11:00`）；解析不出就留 `null`，界面显示 `?` |
| 用户配的 Cookie 是给 yt-dlp 的，抓 HTML 那条路默认不带 | 本轮**路径 B 不带 Cookie**（避免拿用户账号跑批量请求）；如果实测发现某些站必须带，再单独讨论 |

---

## 7. 实施顺序（供下一步写计划用）

1. `crawler.js` + 夹具测试（纯逻辑，先能解析出 48 条）
2. 两张表 + 仓储方法 + 隔离测试
3. `discovery.js`（含 20 秒兜底）+ 事件
4. HTTP 路由 + SSE 事件转发 + 接口测试
5. 前端「找视频」页 + 样式 + DOM 垫片测试 + 截图核对
6. 端到端：真实爬 `https://www.xvideos.com/` → 勾选 → 入队 → 确认真的开始下载
7. README 补「爬取纪律」与用法；本 spec 归档
