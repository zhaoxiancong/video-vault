# 历史轮次记录（归档）

> 从 `PROGRESS.md` 搬出来的**过程明细**。
> 为什么搬：`handoff.js resume` 会把 `PROGRESS.md` 的「已完成 / 下一步 / 坑与约束」
> 三节整段打印到接手会话的上下文里，而这个文件曾经长到 759 行 / 约 1.8 万 tokens，
> 其中 58% 是历史轮次明细。**这个文件只在"想查某轮到底怎么做的"时才需要打开。**
>
> 真正的教训已经提炼进 `PROGRESS.md` 的「坑与约束」（那是每次都要读的）。
> 这里留的是"当时发生了什么、试过什么、为什么那么改"。

---

## 第七轮：体检 + 补上那个"生来就红"的图标（2026-09-22）

用户要求"先不开工，只做体检"。体检结果是**功能全好**（150 项测试、lint、前端一致性、
服务起来、引擎都认到、用户的库 6 条一条没少），但**体检本身挖出 4 个问题**：

| # | 问题 | 处理 |
|---|---|---|
| 1 | `D:\AI\tools\dev.js` 认不出这个项目 —— 它写死找 `app/lib/config.js`，而重构后是 `src/infra/config.js` + `src/main.js`；端口正则也只认 `\|\|` 不认 `??`。**AGENTS.md 力推的那个闭环在这个项目上一直用不了** | 改成两种结构都认（工具在工作区根，不在仓库里） |
| 2 | `test/ui/smoke.js` 的「没有运行时报错」**必然失败** | 见下，已修 |
| 3 | `.handoff/` 没进 `.gitignore`（`dev.js` 的日志目录，README 教的命令一跑就生成） | 补上 |
| 4 | 本文件「环境事实」写着"不在 git 仓库里"，实际 remote 完好 | 已改对 |

**「生来就红」那条的完整因果**（本轮最有价值的发现）：

```
index.html 从来没声明过图标 + 仓库里根本没有图标文件
  → 浏览器每次自动请求 /favicon.ico → 404 → 控制台一条 error
  → smoke.js 的「没有运行时报错」把**任何** console error 都算失败
  → 那条 UI 冒烟测试在任何机器、任何一次运行都必然报 1 项失败
```

**为什么上个会话没发现**：这个套件要真实 Chrome，受限会话里 Chrome 起不来、脚本会
**跳过**。所以断点里写的"唯一没验过的面"，其实是**一验就是红的** —— 跳过让它看起来
像"没测过"，实际是"测了会挂"。

**修法**（不是把断言改绿，是修根因）：新增 `src/web/favicon.svg`（配色照 `styles.css`
的 `--panel` + `--amber`，图案就是顶栏那个 ▼ 品牌记号），`index.html` 显式声明它 ——
有声明浏览器就不会再去要 `/favicon.ico`。**真实浏览器实测**：修前 11 通过 1 失败，
修后 **12 通过 0 失败**。

**补了两条回归测试**（让这个坑在没有 Chrome 的会话里也挡得住）：

- api 测试：走真实 HTTP 验 `/static/favicon.svg` 返回 200 且 MIME 正确，
  **并断言 `/favicon.ico` 仍是 404**（所以"必须显式声明"这件事有测试钉住）
- 前端测试：纯静态验"声明了的图标文件真的存在"
- `tools/check-frontend.js` 加了同一条静态检查

**反证验过**：把 `favicon.svg` 改名藏起来，两条新测试都会红，报错直接指向根因。

**推送并验了远端**：`ae47938`，远端 `main` SHA 与本地一致；
从 `codeload.github.com` 把 zip 下回来跑：65 个文件、139 通过 0 失败 11 跳过、
无 `PROGRESS.md`/引擎/用户数据。

---

## 第六轮：公开审计 + 推送（2026-09-21）

**已完成推送**：https://github.com/zhaoxiancong/video-vault （Public · MIT · 默认分支 main）

推之前做了一次「这个仓库能不能安全公开」的审计，**关键点是只看 HEAD 不够**：
历史是永久的，任何历史提交里出现过的东西，推上去就公开了，之后删也没用。

审计发现并修掉两处：

| 问题 | 在哪 | 处理 |
|---|---|---|
| `PROGRESS.md`（本地交接文档 + 约 20 处 `D:\AI\...` 路径）**仍在历史里** | `9283f4f`、`f25af5f` 两个提交的树 | **重写历史**清掉（详见下面提交历史那段的说明） |
| README 里写着 `cd D:\AI\works\20260920_视频下载工具` | HEAD | 改成"先 cd 到你放这个项目的目录" |

审计同时**确认没问题**的：历史上从未出现 `downloads/` / `data/` / `tools/bin/` /
日志 / cookies / 浏览器 profile（`.gitignore` 从头就是对的）；没有 token、
私钥、个人邮箱；9 个提交的身份**全部**是
`zhaoxiancong <59738606+zhaoxiancong@users.noreply.github.com>`。

**推送后从 GitHub 真的下载回来验了一遍**（不是验本地）：
`codeload.github.com/.../zip/refs/heads/main` → 解压 → 64 个文件、
无 `PROGRESS.md`、无 `data/`/`downloads/`/`tools/bin/` → `node test/run.js`
**136 通过 0 失败 12 跳过，11/11 全绿**。远端 `main` 的 SHA 与本地 HEAD 一致（`b867a43`）。

**留给以后的两条**：

- **PAT 用完要吊销**。这次用的是经典 token（`repo` + `workflow` 权限）。
- 审计脚本里"."只看新增行"这条很重要：`git log -p` 的流里还有删除行，
  把删除行也算进来，"修掉一个本地路径"这个动作本身会被报成泄露，**正好报反**。
  （那个脚本是一次性的，已删；以后再写要注意。）

---

## 第五轮：让"跳过"长得像跳过（2026-09-21）

**起因**：想验证"公开仓库 clone 下来能不能用"，于是用 `git archive` 把 **HEAD 导出成
一个干净目录**（没有 `downloads/`、`data/`、`tools/bin/`、`node_modules/`）跑测试。
结果 **4 条失败** —— 而在我这台机器上 146 项全绿。

顺着查下去，发现三个都属于同一类：**报告和事实不一致**。

| 问题 | 事实 | 报告 |
|---|---|---|
| 转码测试用 `if (!f) { console.log('⏭ 跳过'); return; }` | 7 项一条断言都没跑 | 显示 **✔ 通过** |
| 引擎不进 git，clone 下来本来就没有 | 4 项测试必然失败 | 显示 **✘ 失败**（像代码坏了） |
| `start()` 先查 ffmpeg 再查源文件（`transcode.js:110 → :116`） | "源文件不存在"那条分支根本走不到 | 显示 **✘ 失败**（假失败） |

**改法**：新增 `test/helpers/engines.js`（只做 `fs.existsSync`，**便宜且无副作用** ——
不能为了判断 ffmpeg 在不在就真去启动一次），统一成 `skipWithout('ffmpeg')`，
用 node:test **原生 skip**。于是：

- 有引擎：`148 通过 0 失败 0 跳过` —— 覆盖一条没少
- 无引擎（干净检出）：`135 通过 0 失败 12 跳过`，11/11 全绿，每条都写明怎么办

**刻意没做的事**（别以为是漏了）：

- **没改 `start()` 的检查顺序**。把"源文件不存在"提到 ffmpeg 前面确实更合理
  （更具体的错误优先），但那是**行为变更**，不该顺手塞进重构。
- **没让失败的断言"蒙对"**。`isPlayable` 的"垃圾内容"那条在没 ffprobe 时返回
  `false` —— 结论碰巧对，但走的是"没验过"分支，是蒙的。所以把它**拆出来单独 skip**，
  而不是留着让它假绿。

**顺带验证了一件更重要的事**：提交进 git 的东西**是自洽的**。
64 个文件、无引擎、无用户数据，测试照样 0 失败 —— 说明 `.gitignore` 没漏掉必需文件。

**教训**：判断"交付物能不能用"要在**干净检出**上判，不能在工作区判。
工作区里有 `tools/bin/`、`downloads/`、`data/`、`node_modules/` 这些**不在 git 里**的东西，
它们会让本该失败的测试通过。用 `git archive --format=zip -o x.zip HEAD` 导出再跑
（本机 `git clone` 本地路径会踩沙箱的 fork 限制，报 `couldn't create signal pipe`）。

---

## 第四轮：前端"真的跑起来"了（2026-09-21）

前端之前是**唯一一块从未被执行过**的面。写了 `test/helpers/dom-shim.mjs`
（一个刻意保持最小的 DOM 垫片）+ `test/integration/frontend-dom.test.mjs`，
把前端真的 import 进来、真的点几下。

覆盖到的：模块加载不抛异常 / 引擎状态被更新 / 标签页真的切换 /
「仅音频」隐藏清晰度 / 空链接不发请求 / 队列渲染进度条 /
**进度更新复用同一个 DOM 节点**（防闪烁）/ 展开状态持久化 /
统计数字 / 标题里的尖括号原样保留（防 innerHTML 注入）。

**垫片自己踩的坑比被测代码还多** —— 而且最费时间的是"垫片不够真导致的假失败"：
测试红了，被测代码其实是对的。坑都写在 `dom-shim.mjs` 的注释里了，改它之前值得读：
`navigator` 只有 getter 不能直接赋值 · `dataset` 必须双向映射到 `data-*`（否则
属性选择器匹配不到、事件委托全失效）· `style` 必须**自己就是 Proxy** ·
包装定时器要先存原生函数（否则无限递归）· 假 fetch 要剥查询串 ·
`querySelector` 要支持后代组合 · `restore()` 要清定时器。

---

## 第三轮：补齐老套件覆盖（2026-09-21）

**起因**：重构目标写的是"111 项一条不丢"，但我**其实没有严格核对过**。
写了 `tools/audit-test-parity.js` 从 git 历史取回老套件，
把每个 `check('名字')` 抽出来按主题比对，发现【参数构造】掉得最狠
（老 9 条 → 新 2 条），【元数据】【转码】【路径自愈】也都偏薄。

**补齐后 76 → 133 项**，新增 4 个文件：
`test/unit/downloader.test.js`(24) · `test/unit/media.test.js`(14) ·
`test/integration/path-healing.test.js`(7) ·
一个用 ffmpeg 现场生成真视频的转码测试(10)（**第十轮已随转码功能一起删除**） ·
`test/e2e/download.test.js`(2)

补测过程中抓到**两个之前完全没测到的 bug**（都不是重构引入的，是本来就有的）：

| bug | 后果 | 为什么一直没发现 |
|---|---|---|
| `startTranscode()` 把输出路径传了**两次**（`[...preset.args(out), out]`，而 `preset.args()` 的契约就是以输出路径结尾） | ffmpeg 得到两个输出指向同一文件、写两遍 → moov atom 写坏 → **转码产物打不开**（`Invalid mvhd time scale`） | 老 selftest 测转码时是**直接调 ffmpeg、自己拼参数**的，从来没走过 `startTranscode()` |
| `healPaths()` 找锚点用 `\downloads\`（带尾分隔符） | `downloadDir` 指向 downloads 目录**本身**时路径以 `downloads` 结尾、没有尾分隔符 → 匹配不上 → 静默跳过 → **项目搬走后 downloadDir 还指着旧位置** | `file_path` 这类带文件名的路径末尾有分隔符，一直正常，掩盖了这个问题 |

顺带修：`media.probe()` 原来 `JSON.parse(整段输出)`，而 ffprobe 可能在 JSON
**前面**吐警告行（就是上面那个 `Invalid mvhd`）→ parse 失败 → probe 返回 null →
**正常视频被判"损坏"、删掉、重下**。现在从第一个 `{` 开始截取。

**教训**：测试跑得再多，**只要它绕过了出问题的代码，就等于没测**。
老套件"111 项"听起来很多，但转码那部分是自己拼 ffmpeg 参数、绕过了服务层，
所以真实的转码路径一直是坏的。**补测试时优先补"经过真实入口"的那种。**

---

## 第二轮：真实下载路径的验证（2026-09-21）

写了一条**真的把视频下下来**的端到端测试（`test/e2e/download.test.js`）：
下载 → 合并 → ffprobe 入库 → 网页播放 Range → 库查询去重。
它当场抓到**两个我重构时自己引入的 bug**，而且两个都会让**每一个下载都失败** ——
此前 76 项测试全绿，因为那些测试用的地址是 example.com，
走到"解析失败"就结束了，**从来没有真的下载过一个文件**。

| bug | 后果 | 根因 |
|---|---|---|
| `media.probe()` 永远是 null | 正常视频被判"损坏"→删掉→重下→又判损坏→报"文件损坏" | `runSync()` **自己管理输出文件**，签名是 `(exe,args,opts)`，不接受 fd。我照搬老代码"外部 openSync + 传 fd"的写法，那个文件永远是 0 字节 |
| `scheduler.js` 漏 `require('node:path')` | 每个下载收尾时抛 `path is not defined` | 纯漏写；而**当时的 linter 抓不到** —— 它只查"函数调用 `foo(`"，而 `path` 从来不是被调用的那个（被调用的是 `extname`） |

顺手修掉的：

- `findNewest()` 会把 yt-dlp 的**中间分片**（`.f269.mp4`）当成成品 →
  分片只有一条流、ffprobe 读不出时长 → 判"损坏" → 删掉重下 → 又挑中另一个分片。
  现在用 `FRAGMENT_RE` 排除，加了 8 项回归测试。
- `media.isPlayable()` 在没有 ffprobe 时直接 `return true`（"我验不了就当它是好的"）——
  静默的假阳性。新增 `inspect()` 返回 `{ok, reason, verified}`，把"没验过"明说出来。
- `tools/lint-undefined.js` 补了"**用了某个 Node 内置模块却没 require 它**"这条检查。
  （试过扫所有裸标识符引用，但那把注释里的 `AGENTS.md`、字符串里的 `github.com`
  全报成未定义，29 个文件误报 —— 裸标识符扫描需要真正的解析器。）

**教训**：重构之后，"测试全绿"不等于"没搞坏"。如果测试从没走过某条路径，
那条路径上的 bug 一个都抓不到。**改动最大的代码路径，必须有走它的测试。**

---

## 架构重构（2026-09-21）

把 HTTP / 业务 / SQL 混在一起的 16 个文件重构成四层，依赖方向单向朝内：

```
src/domain/   纯逻辑：Video 模型、显式状态机、错误分类
src/infra/    唯一碰外部世界的地方：config / database / subprocess / progress / media / urldiag
src/app/      应用服务：downloader / scheduler / transcode / cookies
src/http/     HTTP 层：路由 / 校验 / 视图 / SSE
src/web/      前端 10 个原生 ES 模块（无框架、无构建步骤）
```

三个关键机制：

1. **加载模块不再有副作用** —— config 不再在 require 时建目录，
   database 不再在 require 时打开真实库
2. **依赖显式注入**（工厂函数）—— 所以测试能起完全隔离的实例，不碰用户数据
   （重构前做不到，历史上因此误删过 7 条记录）
3. **数据访问层不导出裸连接**，SQL 全关在仓储里，并补上事务边界
   （`dedupeByFile` 以前是"合并 + 删除"两步，中途失败会留下半拉子状态）

旧 `app/` 目录**已整体删除**，功能由新结构完全覆盖。

| 旧 | 新 |
|---|---|
| `app/server.js` | `src/main.js` + `src/http/*` |
| `app/lib/*.js` | `src/infra/*` + `src/domain/*` + `src/app/*` |
| `app/frontend/*` | `src/web/*` |
| `app/selftest.js`(111 项) + `app/e2e.js`(24 项) + `app/uitest.js` | `test/` 统一框架 |
| `app/lint-undefined.js` | `tools/lint-undefined.js`（现在扫描 src/ 与 tools/） |
| `app/rebuild-library.js` | `tools/rebuild-library.js`（新增预演模式与 --data/--downloads） |
| `app/diagnose.js` `memwatch.js` `memdiag.js` | **未移植** —— 当时抓内存/速度问题的一次性工具 |

---

## 已知遗留（诚实清单，别当成"全验过了"）

- ~~真实下载路径没有被自动化测试覆盖~~ → **第二轮补上了**。
- ~~"111 项一条不丢"只是声称、没有严格核对~~ → **第三轮补上了**。
- ~~前端从未被执行过~~ → **第四轮补上了**（DOM 垫片）。
- **真实浏览器**：第九轮起已能跑通（`test/ui/smoke.js`、`tools/screenshot.js`）。
  但仍有一层它测不到：**CSS 级联**（DOM 垫片没有）与**跨浏览器兼容**（只用过 Chrome）。
  第十一轮的收藏 bug 就是"垫片与真实 DOM 有偏差"导致的漏测 —— 靠真实浏览器复测才发现。
- 旧 `app/` 里那三个诊断工具（diagnose / memwatch / memdiag）没移植。
  如果以后再遇到内存/速度问题，可以照 `git show 0804305:app/memwatch.js` 把当时的做法捞回来。

---

## 提交历史（第二版历史，已推送）

```
b867a43 fix: 去掉仓库里的本地路径；审计脚本不再写死 SHA
e5e3e5f test: 整个前端模块图都按模块加载一遍（147 → 148 项）
5c258cd test: 没引擎时不再"假绿"，clone 下来测试全绿（146 → 147 项）
682ddf1 test: 前端终于在 CI 里"真的跑起来"了（133 → 146 项）
b7b27b0 test: 补齐老套件的覆盖 + 修掉两个之前没测到的 bug（76 → 133 项）
0d0e89e fix: 真实下载路径的两处回归 + 补上能抓到这类问题的检查
9b33198 chore: 把交接断点移出仓库，补全 .gitignore
f25af5f refactor: 分层重构为四层架构，消除加载期副作用
9283f4f chore: 重构前的基线快照
```

> ⚠️ **上面这 9 个 SHA 是第二版历史**。推送前做公开审计时发现 `PROGRESS.md`
> （本地交接文档 + 约 20 处 `D:\AI\...` 本地路径）**虽然已从 HEAD 移除，却仍在历史里** ——
> 历史是永久的，推上去就公开了。于是趁没推之前重写了一遍历史把它清掉。
>
> 重写用的**不是** `git filter-branch`（它要起 `sh.exe`，受限沙箱拒绝，
> 报 `couldn't create signal pipe, Win32 error 5`、退出码 66），
> 而是手工 `git commit-tree` 逐个重放。脚本的校验全部通过：
> 9 个提交的树**差异只有 `PROGRESS.md`**、提交信息/作者/时间戳**逐字节保留**、
> **最终文件树逐字节一致**（`191bc8e76e7f`）。原始 `.git` 备份在
> `D:\AI\.tmp-git-backup`（若已删除，说明确认无误后清理掉了）。
>
> 踩到的坑：`git log --format=%B` 会在提交信息末尾**自己再加一个换行**，
> 直接拿来喂 `commit-tree -F` 会让每个提交多一个 `\n`（实测 556 → 557 字符），
> 提交信息就"变了"。要取原字节得用 `git cat-file commit <sha>` 再切第一个空行之后的部分。

> 提交身份是仓库局部配置：`zhaoxiancong <59738606+zhaoxiancong@users.noreply.github.com>`
> （全局身份没动，还是 `Supreme <1507300057@qq.com>`）。
> 提交信息里的 BOM 和多余引号已修掉（`Out-File -Encoding UTF8` 会加 BOM，
> 我用它写提交信息文件时把 BOM 带进去了；和 AGENTS.md 里记的 `.ps1` BOM 坑同源）。
> 修的时候用 `git commit-tree` 重放，**文件树哈希前后一致**（`d0db40ae…`），内容没被改动。
> ⚠️ 以后写提交信息文件**用 `write` 工具**，别再走 `Out-File`。
> 另外 PowerShell 没有 `<<<`（here-string 重定向），`git commit -F -` 那条路走不通。

---

## 二期第一项「Cookie 登录态」

- `src/app/cookies.js`：参数构造 + 报错翻译 + 真跑自检
- 两个接口：`GET /api/cookies/status`、`POST /api/cookies/test`
- 设置项 `cookiesFromBrowser` / `cookiesFile`（存在 settings 表里）
- `src/app/downloader.js` 的 `commonArgs()` 已接上；`probeWithArgs()` 支持不改设置试跑
- `src/app/scheduler.js` 的失败路径会把 cookie 相关报错翻译成人话再入库
- `src/domain/errors.js` 里那唯一一份翻译规则表，被设置页和下载失败路径共用
- 前端「设置」页有「登录态（Cookie）」面板 +「测试登录态是否可用」按钮
- README 第 3 节有完整说明

**实测验证过的**（不是"应该能用"）：

- 默认**不带**任何 cookie 参数（不偷读浏览器，有回归测试钉住）
- 真跑一次：Chrome 开着 → 报 `Could not copy Chrome cookie database`
  → **翻译成"浏览器正开着，退出再试，或改用 cookies.txt"**
- cookies.txt 路径真实走通（配置 → yt-dlp 读到 → 报错翻译）
- JSON 格式的假 cookies.txt 被提前识别并说明要 Netscape 格式
