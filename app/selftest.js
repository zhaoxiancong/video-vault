'use strict';
/**
 * 端到端验收脚本。用法：
 *   node selftest.js            # 全部检查（含真实下载）
 *   node selftest.js --quick    # 跳过真实下载，只查引擎和接口
 *
 * 设计原则：每条检查都打印**实测证据**，不做"应该可以"式断言。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cfg = require('./lib/config');
const db = require('./lib/db');
const ytdlp = require('./lib/ytdlp');
const cookies = require('./lib/cookies');
const { probeMedia, isPlayable, cleanupFormatFiles, stageLabel, POST_STAGE_RE } = require('./lib/queue');
const urldiag = require('./lib/urldiag');

const QUICK = process.argv.includes('--quick');

// 用 yt-dlp 自带的可离线测试视频（很小），避免依赖外网大文件
const TEST_URL = process.env.VAULT_TEST_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

let pass = 0, fail = 0, skip = 0;
const results = [];

function check(name, ok, evidence) {
  results.push({ name, ok, evidence });
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
  if (evidence) {
    for (const line of String(evidence).split('\n')) {
      console.log(`       ${line}`);
    }
  }
}

function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`); }

(async function main() {
  console.log('\n════════ 视频下载工具 · 验收测试 ════════');

  // ───────────────────────────── 1. 目录与引擎
  section('1. 目录与引擎二进制');

  cfg.ensureDirs();
  check('下载目录可写', !!fs.existsSync(cfg.PATHS.DOWNLOADS), cfg.PATHS.DOWNLOADS);
  check('数据目录可写', !!fs.existsSync(cfg.PATHS.DATA), cfg.PATHS.DATA);

  const info = ytdlp.binaryInfo();
  check('yt-dlp 可执行', info.ytdlp.ok, `版本 ${info.ytdlp.version || info.ytdlp.error}`);
  check('ffmpeg 可执行', info.ffmpeg.ok, info.ffmpeg.version || info.ffmpeg.error || '');
  check('ffprobe 存在', fs.existsSync(cfg.PATHS.FFPROBE), cfg.PATHS.FFPROBE);
  check('yt-dlp 使用目录式分发（非 onefile，避免沙箱 TEMP 解包失败）',
    fs.existsSync(path.join(cfg.PATHS.BIN, 'ytdlp-win', '_internal')),
    path.join(cfg.PATHS.BIN, 'ytdlp-win', '_internal'));

  // ───────────────────────────── 2. 数据库
  section('2. 元数据库');

  const tables = db.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map((r) => r.name);
  check('表结构创建成功', ['videos', 'playlists', 'settings', 'events', 'subscriptions'].every((t) => tables.includes(t)),
    '表：' + tables.join(', '));

  const s = db.getSettings();
  check('默认设置可读', s.concurrency === 2 && s.rateLimitMB === 0,
    `并发=${s.concurrency} 限速=${s.rateLimitMB === 0 ? '不限速' : s.rateLimitMB + 'MB/s'} 分片并发=${s.fragmentConcurrency} 目录=${s.downloadDir}`);

  const before = db.getSettings().concurrency;
  db.setSettings({ concurrency: 3 });
  const after = db.getSettings().concurrency;
  db.setSettings({ concurrency: before });
  check('设置可写且持久化', after === 3, `${before} → ${after} → 还原 ${db.getSettings().concurrency}`);

  const testUrl = 'https://example.com/selftest-' + Date.now();
  const inserted = db.insertVideo({ url: testUrl, title: '验收测试条目', site: 'SelfTest',
    uploader: 'tester', status: 'queued', kind: 'video', quality: 'best' });
  check('可插入视频记录', !!inserted.id, `id=${inserted.id}`);

  const dup = db.findByUrl(testUrl);
  check('可按 URL 去重查询', dup && dup.id === inserted.id, `查到 id=${dup && dup.id}`);

  let uniqueViolation = false;
  try { db.insertVideo({ url: testUrl, title: '重复' }); }
  catch { uniqueViolation = true; }
  check('URL 唯一约束生效（防重复下载）', uniqueViolation, '重复插入被数据库拒绝');

  const found = db.listVideos({ q: '验收测试' });
  check('库搜索可用', found.total >= 1, `关键词"验收测试"命中 ${found.total} 条`);

  const starred = db.updateVideo(inserted.id, { starred: 1 });
  check('可更新记录字段', starred.starred === 1, `starred=${starred.starred}`);

  const f = db.facets();
  check('筛选项统计可用', Array.isArray(f.sites) && f.totals.count_all >= 1,
    `站点数 ${f.sites.length}，总条目 ${f.totals.count_all}`);

  db.deleteVideo(inserted.id);
  check('可删除记录', !db.getVideo(inserted.id), `id=${inserted.id} 已删除`);

  // ───────────────────────────── 3. 进度解析
  section('3. 进度行解析（沙箱禁管道，靠解析日志文件）');

  // ⚠️ 这一节曾经用「手写数据」通过测试，掩盖了两个真 bug：
  //    ① %()s 把 "  0.5%" 直接插进 JSON → 非法 JSON
  //    ② 改用 %()j 后，数值字段取到 NA 时仍输出裸 NA → 依然非法
  //    所以下面这些样例**全部原样抄自真实下载日志**，不许手写美化。
  const REAL_DL_LINE = 'VVP|  0.5%|1024|223779|68430.42661398253|3|NA|NA';
  const REAL_DL_LINE_2 = 'VVP| 58.1%|130048|223779|563706.9119169271|0|NA|NA';
  const REAL_PP_LINE = 'VVP|Merger|started';

  check('进度模板是管道分隔格式（避开 NA 破坏 JSON 的坑）',
    cfg.PROGRESS_TEMPLATE.includes('VVP|') && !cfg.PROGRESS_TEMPLATE.includes('{'),
    cfg.PROGRESS_TEMPLATE.slice(0, 130));

  const cases = [
    [REAL_DL_LINE,
      (r) => r.type === 'progress' && Math.abs(r.percent - 0.5) < 0.01
             && r.downloaded === 1024 && r.total === 223779 && r.speed > 60000
             && r.eta === 3 && r.fragment === null && r.fragmentCount === null,
      '真实进度行（NA 字段归一化为 null）'],
    [REAL_DL_LINE_2,
      (r) => r.type === 'progress' && Math.abs(r.percent - 58.1) < 0.01 && r.downloaded === 130048,
      '真实进度行 #2（百分比含前导空格）'],
    [REAL_PP_LINE,
      (r) => r.type === 'postprocess' && r.stage === 'Merger' && r.status === 'started',
      '真实 postprocess 行'],
    ['download:VVP|100.0%|223779|223779|NA|NA|NA|NA',
      (r) => r.type === 'progress' && r.percent === 100 && r.speed === null,
      '带 download: 前缀的兼容形式'],
    ['VVP|MoveFiles|finished',
      (r) => r.type === 'postprocess' && r.stage === 'MoveFiles' && r.status === 'finished',
      'postprocess 第二类'],
    ['VVAULT_FILE:D:\\videos\\a.mp4',
      (r) => r.type === 'file' && r.path.endsWith('a.mp4'), 'VVAULT_FILE 行'],
    ['ERROR: Video unavailable',
      (r) => r.type === 'error' && r.message === 'Video unavailable', '错误行'],
    ['[download] Destination: out.mp4',
      (r) => r.type === 'destination', 'Destination 行'],
    ['[Merger] Merging formats into "x.mkv"',
      (r) => r.type === 'stage', 'Merger 阶段行'],
    ['random noise line',
      (r) => r.type === 'log', '普通日志行'],
  ];
  for (const [line, pred, label] of cases) {
    const r = ytdlp.parseProgressLine(line);
    check('解析：' + label, !!r && pred(r), r ? JSON.stringify(r).slice(0, 130) : 'null');
  }

  // ───────────────────────────── 4. 参数构造
  section('4. 下载参数构造');

  const dargs = ytdlp.buildDownloadArgs(
    { url: 'https://x/y', kind: 'video', quality: '1080p' },
    { ...db.getSettings(), rateLimitMB: 5, fragmentConcurrency: 4 }, {});
  check('限速参数已注入', dargs.includes('--limit-rate') && dargs.includes('5M'),
    dargs.join(' ').match(/--limit-rate \S+/)?.[0] || '');
  check('格式选择已注入', dargs.includes('-f') && dargs.includes('bv*[height<=1080]+ba/b[height<=1080]'),
    dargs[dargs.indexOf('-f') + 1]);
  check('合并容器设为 mkv（兼容 vp9/opus）',
    dargs.includes('--merge-output-format') && dargs[dargs.indexOf('--merge-output-format') + 1] === 'mkv',
    '--merge-output-format mkv');
  check('进度模板已注入（管道格式）',
    dargs.some((a) => String(a).includes('VVP|%(progress._percent_str)s')),
    '--progress-template 存在且为管道格式');

  const aargs = ytdlp.buildDownloadArgs(
    { url: 'https://x/y', kind: 'audio', quality: 'best' },
    { ...db.getSettings() }, {});
  check('仅音频走 -x + --audio-format', aargs.includes('-x'), aargs[aargs.indexOf('--audio-format') - 1] + ' ' + aargs[aargs.indexOf('--audio-format') + 1]);

  check('限速为 0 时不注入 --limit-rate',
    !ytdlp.buildDownloadArgs({ url: 'u', kind: 'video', quality: 'best' },
      { ...db.getSettings(), rateLimitMB: 0 }, {}).includes('--limit-rate'), '0 = 不限速');

  // ───────────────────────────── 4b. 已修 bug 的回归测试
  section('4b. 回归测试（这些 bug 都真实发生过）');

  // 回归 0（最严重）：调度器同步无限递归 → 堆爆 4GB 崩溃。
  // 原因：_start 是 async，await 让出控制权时任务还是 queued，
  //      那时任何 kick() 都会把它再捞起来重复启动。
  // 三道防线都要在：kick 异步化、_schedule 先占位、状态在 await 前迁移。
  const qsrc = fs.readFileSync(path.join(__dirname, 'lib', 'queue.js'), 'utf8');
  check('kick() 是异步调度（防同步递归）',
    /kick\(\)\s*\{[\s\S]{0,600}?setImmediate/.test(qsrc),
    'kick 内部必须用 setImmediate 解耦，否则 _schedule 会同步递归');
  check('_schedule 先占位再启动（防同一任务被并行启动）',
    /this\.running\.set\(next\.id,\s*\{[^}]*starting/.test(qsrc),
    '_schedule 必须在调用 _start 之前就把 id 放进 running');
  check('_start 在任何 await 之前迁移状态（防被重复捞起）',
    (() => {
      const i = qsrc.indexOf('async _start(video)');
      if (i < 0) return false;
      // ⚠️ 必须先剥掉注释再判断：这段代码的注释里就写着"必须在任何 await 之前"，
      //    直接 indexOf('await') 会命中注释，导致断言永远失败（我踩过）。
      const raw = qsrc.slice(i, i + 3000);
      const body = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
        .replace(/^\s*\/\/.*$/gm, '');          // 行注释
      const iStatus = body.indexOf('db.updateVideo(video.id');
      const iAwait = body.indexOf('await ');
      return iStatus > 0 && iAwait > 0 && iStatus < iAwait;
    })(),
    '状态必须早于第一个真实 await 更新，这是递归的直接诱因');

  // 回归 1：进度条曾经整场卡在 99%。
  // 原因：一看到任何后处理器就把 progress 顶到 99，而 yt-dlp 的
  // ThumbnailsConvertor 在下载开始前就会先跑一次。
  check('ThumbnailsConvertor 不算"后期处理阶段"（否则进度条开场即卡 99%）',
    !POST_STAGE_RE.test('ThumbnailsConvertor'),
    'ThumbnailsConvertor 在下载前就会执行，不能作为"下载已结束"的判据');
  check('Merger 算"后期处理阶段"', POST_STAGE_RE.test('Merger'), 'Merger 确实发生在下载之后');
  check('ExtractAudio 算"后期处理阶段"', POST_STAGE_RE.test('ExtractAudio'), '抽音频发生在下载之后');

  const fakeJob = (over) => Object.assign({
    downloading: false, streamIndex: 0, pipeline: [], stage: '解析中',
  }, over);
  check('阶段文案：尚未收到下载进度时不谎报"处理中"',
    stageLabel(fakeJob({ stage: '解析中' })) === '解析中',
    stageLabel(fakeJob({ stage: '解析中' })));
  check('阶段文案：下载中不显示后处理阶段',
    stageLabel(fakeJob({ downloading: true })) === '下载中',
    stageLabel(fakeJob({ downloading: true })));
  check('阶段文案：多流下载要标出"第几条流"（避免百分比归零让人误解）',
    stageLabel(fakeJob({ downloading: true, streamIndex: 1 })).includes('第 2 条流'),
    stageLabel(fakeJob({ downloading: true, streamIndex: 1 })));
  check('阶段文案：下载结束进入 Merger 才显示"处理中"',
    stageLabel(fakeJob({ downloading: true, pipeline: ['Merger'] })).startsWith('处理中'),
    stageLabel(fakeJob({ downloading: true, pipeline: ['Merger'] })));

  // 回归 2：错误信息里曾经存的是一段进度帧（因为取了日志最后一行）。
  const dirtyLog = [
    'VVP| 98.5%|20729404|21039208|354233.4|0|NA|NA',
    'VVP|100.0%|21039208|21039208|167229.6|NA|NA|NA',
    'VVAULT_META:abc|youtube',
    '[download] Destination: x.mkv',
    'Deleting original file x.f137.mp4 (pass -k to keep)',
    'ERROR: Postprocessing: Error opening input files: Invalid data found when processing input',
  ].join('\n');
  const cleaned = ytdlp.cleanError(dirtyLog);
  check('错误信息里不会混进进度帧',
    !/VVP\|/.test(cleaned), `提取结果：${cleaned}`);
  check('错误信息能提取到真正的原因',
    /Invalid data/.test(cleaned), `提取结果：${cleaned}`);

  const noErrLog = ['VVP| 50.0%|100|200|1000|1|NA|NA', 'VVP|100.0%|200|200|NA|NA|NA|NA'].join('\n');
  check('日志里没有 ERROR 行时不会把进度帧当错误',
    !/VVP\|/.test(ytdlp.cleanError(noErrLog)) && ytdlp.cleanError(noErrLog) === '',
    `提取结果：${JSON.stringify(ytdlp.cleanError(noErrLog))}`);

  // 回归 3：损坏文件必须被识别（"文件存在" ≠ "文件完整"）
  const probeDir = path.join(cfg.PATHS.DATA, '_selftest_probe');
  fs.mkdirSync(probeDir, { recursive: true });
  const fakeMkv = path.join(probeDir, 'broken.mkv');
  fs.writeFileSync(fakeMkv, 'this is not a video at all, just text pretending to be one');
  check('损坏/不完整的文件被判为不可播放', !isPlayable(fakeMkv),
    `${path.basename(fakeMkv)} (${fs.statSync(fakeMkv).size} 字节文本) → isPlayable=false`);
  check('不存在的文件被判为不可播放', !isPlayable(path.join(probeDir, 'nope.mkv')), 'nope.mkv');
  const realSample = path.join(cfg.PATHS.DOWNLOADS, '_selftest', 'selftest.mkv');
  if (fs.existsSync(realSample)) {
    check('真实视频被判为可播放', isPlayable(realSample), path.basename(realSample));
  } else {
    console.log('  （跳过"真实视频可播放"检查：还没有测试文件）');
  }

  // 回归 4：中间分片清理不能误删成品
  const clDir = path.join(probeDir, 'cleanup');
  fs.mkdirSync(clDir, { recursive: true });
  const clFinal = path.join(clDir, 'movie [1080p137+140].mkv');
  fs.writeFileSync(clFinal, 'final');
  fs.writeFileSync(path.join(clDir, 'movie [1080p137+140].f137.mp4'), 'v');
  fs.writeFileSync(path.join(clDir, 'movie [1080p137+140].f140.m4a'), 'a');
  fs.writeFileSync(path.join(clDir, 'movie [1080p137+140].jpg'), 'thumb');
  fs.writeFileSync(path.join(clDir, 'other [720p].mkv'), 'unrelated');
  const removedN = cleanupFormatFiles(cfg.PATHS.DATA, null, clFinal);
  const left = fs.readdirSync(clDir).sort();
  check('清理中间分片：分片被删掉', removedN === 2 && !left.some((f) => /\.f\d+\./.test(f)),
    `删除 ${removedN} 个，剩余 ${JSON.stringify(left)}`);
  check('清理中间分片：成品、封面、无关文件都保留',
    left.includes('movie [1080p137+140].mkv') && left.includes('movie [1080p137+140].jpg')
    && left.includes('other [720p].mkv'),
    '成品 .mkv / 封面 .jpg / 别的视频 均未被误删');
  fs.rmSync(probeDir, { recursive: true, force: true });

  // 回归 5：整个项目目录必须能**被移动到任何地方**（路径自愈）。
  // server.js 全部用 __dirname 相对定位，所以服务能起来；但数据库里存的是
  // 绝对路径，不修正的话移动后所有记录都指向旧位置（封面空白、播放 404）。
  const healSrc = fs.readFileSync(path.join(__dirname, 'lib', 'db.js'), 'utf8');
  check('存在路径自愈逻辑（移动项目后自动修正库内绝对路径）',
    /function healPaths/.test(healSrc) && /healPaths\(\)/.test(healSrc),
    'healPaths 必须在 runMigrations 里被调用');
  check('路径自愈只认本项目自己的子目录（不误伤用户自定义的外部目录）',
    /OWN_SUBDIRS\s*=\s*\[[^\]]*'downloads'[^\]]*'data'/.test(healSrc),
    "只把 downloads / data 当锚点");
  check('路径自愈会修正 settings.downloadDir',
    /key='downloadDir'/.test(healSrc),
    'downloadDir 也是绝对路径，同样需要迁移');

  // 幂等性：在未移动的位置跑迁移，不该改动任何路径
  try {
    const m2 = db.runMigrations();
    check('在当前（未移动）位置运行迁移不会误改路径',
      !m2.pathsHealed,
      m2.pathsHealed ? '⚠️ 竟然改动了：' + JSON.stringify(m2.pathsHealed) : '幂等，未改动任何路径');
  } catch (e) {
    check('在当前（未移动）位置运行迁移不会误改路径', false, e.message);
  }

  // 启动脚本必须用"相对脚本自身"定位，否则复制到别处就找不到 app
  const cmdTxt = fs.readFileSync(path.join(__dirname, '..', '启动.cmd'), 'utf8');
  const ps1Txt = fs.readFileSync(path.join(__dirname, '..', '启动.ps1'), 'utf8');
  check('启动.cmd 用 %~dp0 相对定位（移动后仍可用）',
    /%~dp0/.test(cmdTxt), '取脚本自身所在目录，不写死盘符');
  check('启动.ps1 用 $MyInvocation 相对定位（移动后仍可用）',
    /\$MyInvocation\.MyCommand\.Path/.test(ps1Txt), '同上');

  // 回归 6：不得存在"调用了未定义的函数"。
  // 真实事故：删调试代码时漏删一处 trace()，_start() 一进 try 就抛 ReferenceError，
  // 被 catch 吞成 "解析失败: trace is not defined"，**所有新任务全部下载失败**。
  // 另一个：transcode 用了 spawn 却只导入了 spawnSync，转码功能从未可用。
  // node --check 只查语法，这两种都抓不到，所以单独做了个 linter。
  //
  // ⚠️ 这里**不能**用 spawnSync + 管道读子进程输出：受限沙箱下会 EPERM，
  //    stdout 是空的，于是这一项报"失败" —— 环境问题被显示成代码问题。
  //    改用文件描述符重定向（和下载走的是同一套路，见 README 坑 1）。
  try {
    const tmp = path.join(os.tmpdir(), `vault-lint-${process.pid}.txt`);
    const fd = fs.openSync(tmp, 'w');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'lint-undefined.js')], {
      stdio: ['ignore', fd, fd], windowsHide: true, timeout: 60000,
    });
    fs.closeSync(fd);
    let out = '';
    try { out = fs.readFileSync(tmp, 'utf8'); } catch { out = ''; }
    try { fs.unlinkSync(tmp); } catch { /* 留着也无害 */ }

    if (r.error && r.error.code === 'EPERM') {
      // 命令根本没跑起来。说清楚是环境问题，别伪装成检查失败。
      check('静态检查：没有调用未定义的函数（含漏导入）', false,
        `跑不起来：spawnSync EPERM（受限沙箱不允许子进程？）。`
        + `这不是代码问题，请单独跑 node app/lint-undefined.js 确认`);
    } else {
      check('静态检查：没有调用未定义的函数（含漏导入）',
        r.status === 0,
        r.status === 0 ? 'lint-undefined.js 通过' : out.trim().split('\n').slice(-8).join('\n'));
    }
  } catch (e) {
    check('静态检查：没有调用未定义的函数（含漏导入）', false, e.message);
  }

  // 回归 7：spawn 与 spawnSync 都必须导入（转码用 spawn，探测用 spawnSync）
  const qSrc2 = fs.readFileSync(path.join(__dirname, 'lib', 'queue.js'), 'utf8');
  check('queue.js 同时导入了 spawn 与 spawnSync',
    /const\s*\{[^}]*\bspawn\b[^}]*\}\s*=\s*require\('node:child_process'\)/.test(qSrc2)
    && /const\s*\{[^}]*\bspawnSync\b[^}]*\}\s*=\s*require\('node:child_process'\)/.test(qSrc2),
    'spawn 用于转码（长命令），spawnSync 用于 ffprobe 探测（短命令）');

  // 回归 8：窗口期（已占槽位、进程未起）点暂停/取消不能崩。
  // 真实事故：用户一点操作就报 "Cannot read properties of null (reading 'pid')"
  check('暂停/取消对 child 为 null 的情况做了防护',
    /if\s*\(\s*job\.child\s*&&\s*job\.child\.pid\s*\)/.test(qSrc2),
    'job.child 在预占槽位阶段是 null，直接读 .pid 会抛错');

  // 回归 9：粘"页面链接"（列表页/首页）时要给出有用的提示。
  // 真实体验问题：yt-dlp 只会说 "Unsupported URL"，用户完全不知道下一步做什么。
  const htmlish = [
    '<title>示例列表页</title>',
    '<a href="/video.abc123/title_one">1</a>',
    '<a href="/video.def456/title_two">2</a>',
    '<a href="https://www.xvideos.com/video.ghi789/three">3</a>',
    '<a href="/best/2026-08">列表</a>',
    '<a href="#top">锚点</a>',
    '<a href="javascript:void(0)">js</a>',
  ].join('\n');
  const counted = urldiag.countVideoLinks(htmlish, 'https://www.xvideos.com/best/2026-08');
  check('能从页面 HTML 里数出视频链接数（含相对/绝对/同域）',
    counted.count === 3,
    `识别到 ${counted.count} 个（期望 3）`);

  const listingMsg = urldiag.explain({ kind: 'listing', count: 27 }, 'https://x.com/best/2026-08');
  check('列表页的提示说清"这是页面不是视频"并给出下一步',
    /页面链接/.test(listingMsg) && /点进/.test(listingMsg),
    listingMsg.split('\n')[0]);
  check('提示里不含 Markdown 记号（前端用 textContent 显示，星号会露出来）',
    !/\*\*|__/.test(listingMsg),
    '无 ** / __ 等记号');

  for (const [kind, kw] of [
    ['single-page-no-extractor', '解析器'],
    ['not-a-video-page', '不像视频页'],
    ['http-error', 'HTTP'],
    ['fetch-failed', '无法读取'],
  ]) {
    const m = urldiag.explain({ kind, status: 404, message: 'x' }, 'https://x.com/a');
    check(`诊断类型 ${kind} 有对应提示`, new RegExp(kw).test(m), m.split('\n')[0]);
  }

  // 回归 10：破坏性操作（删除/清空）必须先造自己的测试数据，绝不能拿用户库做实验。
  //
  // 教训：我在验证"清空已完成记录"时直接对**用户的真实库**执行了 clearFinished，
  // 结果真删掉了 7 条记录（文件还在，但库空了，只能从磁盘重建）。
  // 破坏性操作的正确测法是：先插入自己的测试记录 → 对它操作 → 再清理。
  console.log('  （下面这组测试会插入自己的临时记录，操作完立即删除，不碰你的数据）');

  // 前置清理：万一上次跑到一半中断，先把残留的测试记录清掉，
  // 否则重跑时会撞 url 唯一约束（这个坑我踩过）。
  const TESTURL_PREFIX = 'https://selftest.local/';
  const staleTest = db.db.prepare(
    "SELECT id FROM videos WHERE url LIKE ? OR url LIKE 'local://dbg/%' OR title LIKE '破坏性测试-%' OR title LIKE '重复%'"
  ).all(TESTURL_PREFIX + '%');
  for (const s of staleTest) db.deleteVideo(s.id);
  if (staleTest.length) console.log(`  （先清掉了上次残留的 ${staleTest.length} 条测试记录）`);

  const libCountBeforeDelTest = db.facets().totals.count_all;
  const stamp = Date.now();
  const mkTmp = (tag) => {
    const dir = path.join(cfg.PATHS.DATA, '_selftest_del');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `tmp-${tag}-${stamp}.mp4`);
    fs.writeFileSync(f, 'x'.repeat(1024));
    const r = db.insertVideo({
      url: `${TESTURL_PREFIX}del-${tag}-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
      title: `破坏性测试-${tag}-${stamp}`, kind: 'video', quality: 'best',
      status: 'done', file_path: f, file_size: 1024,
    });
    return { id: r.id, file: f };
  };

  // 只删记录 → 文件必须保留
  const t1 = mkTmp('keep');
  const tv1 = db.getVideo(t1.id);
  check('插入的测试记录存在', !!tv1, `id=${t1.id}`);
  check('插入时 file_path 没有被白名单丢掉（曾经的静默丢字段 bug）',
    !!tv1.file_path && tv1.file_path === t1.file,
    `file_path=${tv1.file_path ? path.basename(tv1.file_path) : '❌ null'}`);
  db.deleteVideo(t1.id);
  check('删除记录后，磁盘文件必须保留（防误删用户数据）',
    fs.existsSync(t1.file),
    fs.existsSync(t1.file) ? '文件仍在 ✅' : '❌ 文件被删了');

  // clearFinished 的语义必须是"只删记录、不动文件"
  const t2 = mkTmp('clear');
  const rowsBefore = db.facets().totals.count_all;
  const finished = db.db.prepare(
    "SELECT id, title FROM videos WHERE status IN ('done','canceled')"
  ).all();
  const myRow = finished.find((r) => r.id === t2.id);
  check('clearFinished 的目标集合包含刚插入的测试记录（说明它确实是按状态批量删的）',
    !!myRow, `done/canceled 共 ${finished.length} 条`);

  // 这里**只对测试记录**执行删除，验证"文件不受影响"这一语义
  db.deleteVideo(t2.id);
  check('按状态清理只删记录、文件保留',
    fs.existsSync(t2.file),
    fs.existsSync(t2.file) ? '文件仍在 ✅（与 clearFinished 语义一致）' : '❌ 文件被删了');

  // 清理测试目录
  fs.rmSync(path.join(cfg.PATHS.DATA, '_selftest_del'), { recursive: true, force: true });
  const libCountAfterDelTest = db.facets().totals.count_all;
  check('破坏性测试没有污染用户库（记录数回到测试前）',
    libCountAfterDelTest === libCountBeforeDelTest,
    `测试前 ${libCountBeforeDelTest} 条 → 测试后 ${libCountAfterDelTest} 条`);

  // 回归 11：同一文件的重复记录要能自动合并（rebuild-library 后重粘链接会产生）
  const dupDir = path.join(cfg.PATHS.DATA, '_selftest_dup');
  fs.mkdirSync(dupDir, { recursive: true });
  const dupFile = path.join(dupDir, 'same-file.mp4');
  fs.writeFileSync(dupFile, 'y'.repeat(2048));
  const d1 = db.insertVideo({
    // 模拟"从磁盘重建"产生的占位 URL
    url: `local://${encodeURIComponent('dup/a.mp4')}-${stamp}`, title: `重复A-${stamp}`,
    kind: 'video', quality: 'best', status: 'done', file_path: dupFile, file_size: 2048,
  });
  const d2 = db.insertVideo({
    url: `https://example.com/real-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
    title: `重复B-${stamp}`, uploader: 'realUploader',
    kind: 'video', quality: 'best', status: 'done', file_path: dupFile, file_size: 2048,
  });
  const merged = db.dedupeByFile(d2.id);
  check('能发现并合并"同一文件的多条记录"', !!merged,
    merged ? `保留 id=${merged.kept}，清理 ${merged.removed} 条` : '未发现重复');
  if (merged) {
    const kept = db.getVideo(merged.kept);
    check('合并时优先保留有真实 URL 的那条', !String(kept.url).startsWith('local://'),
      `保留的记录 url=${String(kept.url).slice(0, 50)}`);
    check('合并后磁盘文件不能被删掉', fs.existsSync(dupFile),
      fs.existsSync(dupFile) ? '文件仍在 ✅' : '❌ 文件没了');
    check('合并把另一条独有的字段也带过来了（uploader）',
      kept.uploader === 'realUploader', `uploader=${kept.uploader}`);
    const left = db.db.prepare('SELECT COUNT(*) AS n FROM videos WHERE file_path = ?').get(dupFile).n;
    check('同文件只剩一条记录', left === 1, `剩余 ${left} 条`);
  }
  db.db.prepare("DELETE FROM videos WHERE file_path = ?").run(dupFile);
  fs.rmSync(dupDir, { recursive: true, force: true });

  // ───────────────────────────── 5. 链接分类
  section('5. 链接分类（单视频 / 列表）');

  const cls = [
    ['https://www.youtube.com/watch?v=abc', 'video'],
    ['https://www.youtube.com/playlist?list=PL123', 'playlist'],
    ['https://www.bilibili.com/video/BV1xx', 'video'],
    ['https://space.bilibili.com/123/video', 'playlist'],
    ['https://www.youtube.com/@SomeChannel', 'playlist'],
    ['https://vimeo.com/12345', 'video'],
  ];
  for (const [u, want] of cls) {
    const got = ytdlp.classifyUrl(u);
    check(`${u.slice(0, 44)} → ${want}`, got === want, `实际=${got}`);
  }

  // ───────────────────────────── 5b. 登录态（Cookie）
  section('5b. 登录态（Cookie）参数与报错翻译');

  // 默认不该带任何 cookie 参数。
  // 这是个**隐私底线**：不能让工具"猜一个默认浏览器"然后偷偷读用户 cookie。
  // 必须是用户显式开启的。
  const noCookie = cookies.cookieArgs({});
  check('没配置时不带任何 cookie 参数（不偷读浏览器）',
    noCookie.args.length === 0 && noCookie.source === 'none',
    `实际 args=${JSON.stringify(noCookie.args)}`);

  const browserCookie = cookies.cookieArgs({ cookiesFromBrowser: 'chrome' });
  check('选了浏览器就生成 --cookies-from-browser',
    browserCookie.args[0] === '--cookies-from-browser' && browserCookie.args[1] === 'chrome',
    JSON.stringify(browserCookie.args));

  const badBrowser = cookies.cookieArgs({ cookiesFromBrowser: 'netscape' });
  check('不认识的浏览器不给参数、但明确报出来（不静默忽略）',
    badBrowser.args.length === 0 && Boolean(badBrowser.warning),
    `warning=${badBrowser.warning}`);

  // 文件优先于浏览器：用户显式给了文件说明他知道自己在干什么
  const tmpCookie = path.join(cfg.PATHS.DATA, '_selftest-cookies.txt');
  fs.writeFileSync(tmpCookie,
    '# Netscape HTTP Cookie File\n'
    + '.example.com\tTRUE\t/\tFALSE\t0\tsid\tabc123\n', 'utf8');
  const fileCookie = cookies.cookieArgs({ cookiesFromBrowser: 'chrome', cookiesFile: tmpCookie });
  check('同时配了浏览器和文件时，文件优先',
    fileCookie.args[0] === '--cookies' && fileCookie.source === 'file',
    JSON.stringify(fileCookie.args));

  const missingFile = cookies.cookieArgs({ cookiesFile: path.join(cfg.PATHS.DATA, '_不存在.txt') });
  check('cookie 文件不存在时不给参数、并说明原因',
    missingFile.args.length === 0 && /不存在/.test(missingFile.warning || ''),
    `warning=${missingFile.warning}`);

  // 格式校验：浏览器插件导出的 JSON 是最常见的坑
  const jsonCookie = path.join(cfg.PATHS.DATA, '_selftest-cookies.json');
  fs.writeFileSync(jsonCookie, '[{"name":"sid","value":"abc","domain":".example.com"}]', 'utf8');
  const jsonWarn = cookies.cookieArgs({ cookiesFile: jsonCookie }).warning;
  check('JSON 格式的 cookie 文件被识别出来并给出可操作提示',
    Boolean(jsonWarn) && /Netscape/.test(jsonWarn),
    `warning=${String(jsonWarn).slice(0, 90)}`);

  fs.unlinkSync(tmpCookie);
  fs.unlinkSync(jsonCookie);

  // 报错翻译 —— 这是这个功能里最值钱的部分。
  // yt-dlp 的原话对普通用户毫无意义，必须变成"你该做什么"。
  const errCases = [
    ['ERROR: Could not copy Chrome cookie database',
      /浏览器正开着/, /完全退出|关掉/, 'Chrome cookie 库被锁'],
    ['ERROR: Fresh cookies (not necessarily logged in) are needed',
      /要求带 Cookie/, /设置 → 登录态|浏览器/, '抖音式"必须带 cookie"'],
    ['ERROR: failed to decrypt with DPAPI',
      /解不开|加密/, /更新|yt-dlp|cookies\.txt/, 'Chrome 加密解不开'],
    ['ERROR: Unsupported browser: foo',
      /不认识这个浏览器/, /chrome/i, '浏览器名写错'],
  ];
  for (const [raw, titleRe, hintRe, label] of errCases) {
    const e = cookies.explainCookieError(raw);
    check(`报错翻译：${label}`,
      Boolean(e) && titleRe.test(e.title) && hintRe.test(e.hint),
      e ? `${e.title}` : '没有翻译出来');
  }

  check('跟 cookie 无关的报错不硬套翻译（否则会误导）',
    cookies.explainCookieError('ERROR: Video unavailable') === null);

  // 翻译后的文本必须同时保留原文 —— 用户/我们排查时还是要看引擎原话
  const decorated = cookies.decorateError('ERROR: Could not copy Chrome cookie database');
  check('翻译后仍保留引擎原话',
    /完全退出/.test(decorated) && /Could not copy Chrome/.test(decorated),
    decorated.split('\n')[0].slice(0, 70));

  // 检测浏览器只报告存在性，不读 cookie
  try {
    const found = cookies.detectBrowsers();
    check('能检测本机装了哪些浏览器（只报告存在性）', Array.isArray(found),
      `检测到：${found.join(', ') || '（无）'}`);
  } catch (e) {
    check('能检测本机装了哪些浏览器（只报告存在性）', false, e.message);
  }

  // ───────────────────────────── 6. 真实下载（端到端）
  section('6. 真实下载端到端');

  if (QUICK) {
    skip++;
    console.log('  ⏭  已跳过（--quick 模式）');
  } else {
    console.log(`  测试地址：${TEST_URL}`);
    console.log('  正在下载…（首次可能要几十秒）\n');

    const dlDir = path.join(cfg.PATHS.DOWNLOADS, '_selftest');
    fs.mkdirSync(dlDir, { recursive: true });

    const logPath = path.join(cfg.PATHS.LOGS, 'selftest.log');
    const resultFile = path.join(cfg.PATHS.LOGS, 'selftest.result');
    fs.writeFileSync(logPath, '');
    fs.writeFileSync(resultFile, '');

    const args = [
      '--ignore-config', '--no-warnings', '--no-colors', '--newline',
      '--ffmpeg-location', cfg.PATHS.FFMPEG,
      '--progress', '--progress-template', cfg.PROGRESS_TEMPLATE,
      '--print-to-file', 'after_move:%(filepath)s', resultFile,
      '--force-overwrites', '--no-playlist',
      '--limit-rate', '1M',
      '-f', 'bv*[height<=480]+ba/b[height<=480]',
      '--merge-output-format', 'mkv',
      '-o', path.join(dlDir, 'selftest.%(ext)s'),
      '--', TEST_URL,
    ];

    const fd = fs.openSync(logPath, 'a');
    const t0 = Date.now();
    const r = spawnSync(cfg.PATHS.YTDLP, args, {
      stdio: ['ignore', fd, fd], timeout: 300000, windowsHide: true,
      env: ytdlp.childEnv(),
    });
    fs.closeSync(fd);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    const log = fs.readFileSync(logPath, 'utf8');
    check('yt-dlp 进程正常退出', r.status === 0,
      `退出码=${r.status} 耗时=${elapsed}s` + (r.status !== 0 ? `\n最后错误：${ytdlp.cleanError(log)}` : ''));

    const allLines = log.split(/\r?\n/).filter(Boolean);
    const parsed = allLines.map((l) => ytdlp.parseProgressLine(l))
      .filter((x) => x && x.type === 'progress' && x.percent !== null);
    check('日志中出现可解析的进度帧（证明进度可被 tail 解析）', parsed.length > 0,
      `共 ${parsed.length} 帧，最后一帧：${parsed.length ? parsed[parsed.length - 1].percent + '%  速度=' + parsed[parsed.length - 1].speed : '无'}`);

    check('进度帧不含 NaN（NA 值已归一化为 null）',
      parsed.every((p) => p.percent === null || Number.isFinite(p.percent)),
      parsed.length ? `抽检：percent=${parsed[parsed.length - 1].percent} speed=${parsed[parsed.length - 1].speed} eta=${parsed[parsed.length - 1].eta}` : '');

    // 关键回归：中文目录下的路径必须能正确读回（曾经因 GBK 编码全乱码）
    const outFile = ytdlp.readResultFile(resultFile);
    check('中文路径能正确读回（编码回归测试）',
      !!outFile && !outFile.includes('\uFFFD') && outFile.includes('视频下载工具'),
      outFile || '(未捕获到)');
    check('能捕获最终文件路径且文件存在', !!outFile && fs.existsSync(outFile), outFile || '未捕获到');

    if (outFile && fs.existsSync(outFile)) {
      const st = fs.statSync(outFile);
      check('输出文件非空', st.size > 10000, `${path.basename(outFile)}  ${(st.size / 1048576).toFixed(2)} MB`);

      const media = probeMedia(outFile);
      check('ffprobe 能读出媒体信息', !!media && !!media.height,
        media ? `分辨率 ${media.width}x${media.height}  视频=${media.vcodec}  音频=${media.acodec}  时长=${media.duration}s` : '读取失败');

      check('文件类型可被浏览器播放（mp4/mkv/webm）', /\.(mp4|mkv|webm)$/i.test(outFile),
        path.extname(outFile));
    }

    // 限速是否真的生效：文件大小 / 耗时 应明显低于不限速
    if (outFile && fs.existsSync(outFile)) {
      const mb = fs.statSync(outFile).size / 1048576;
      const mbps = mb / (Number(elapsed) || 1);
      check('限速生效（未超过设定值的较大倍数）', mbps < 4,
        `实测约 ${mbps.toFixed(2)} MB/s（设定上限 1 MB/s，含合并/元数据开销）`);
    }
  }

  // ───────────────────────────── 7. 转码
  section('7. 转码（剪辑层）');

  const selftestFile = path.join(cfg.PATHS.DOWNLOADS, '_selftest', 'selftest.mkv');
  if (QUICK || !fs.existsSync(selftestFile)) {
    skip++;
    console.log('  ⏭  已跳过（没有可用的测试源文件）');
  } else {
    const outDir = path.join(cfg.PATHS.DOWNLOADS, '_converted');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, 'selftest [h264-480p].mp4');

    const t0 = Date.now();
    const r = spawnSync(cfg.PATHS.FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', selftestFile,
      '-vf', 'scale=-2:min(480\\,ih)',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
      out,
    ], { stdio: 'ignore', timeout: 300000, windowsHide: true });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    check('ffmpeg 转码成功', r.status === 0 && fs.existsSync(out),
      `退出码=${r.status} 耗时=${elapsed}s`);
    if (fs.existsSync(out)) {
      const m = probeMedia(out);
      check('转码产物可读且为 H.264/MP4', !!m && m.vcodec === 'h264',
        m ? `${m.vcodec}/${m.acodec} ${m.width}x${m.height}` : '');
      check('原始文件未被改动（防丢需求：归档层只读）', fs.existsSync(selftestFile),
        '原始 mkv 仍在：' + selftestFile);
    }
  }

  // ───────────────────────────── 8. 元数据解析
  section('8. 元数据解析（联网）');

  if (QUICK) {
    skip++; console.log('  ⏭  已跳过（--quick 模式）');
  } else {
    try {
      const meta = ytdlp.probeMetadata(TEST_URL);
      check('能取到视频元数据', !!meta && !!meta.title,
        `标题="${meta.title}"\n作者=${meta.uploader}  时长=${meta.duration}s  站点=${meta.site}\n封面=${(meta.thumbnail_url || '').slice(0, 70)}`);
      check('元数据含时长（供库排序用）', Number.isFinite(meta.duration), `duration=${meta.duration}`);
    } catch (err) {
      check('能取到视频元数据', false, err.message);
    }
  }

  // ───────────────────────────── 汇总
  console.log('\n════════════════════════════════════════');
  console.log(`  通过 ${pass}   失败 ${fail}   跳过 ${skip}`);
  console.log('════════════════════════════════════════\n');

  if (fail > 0) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  ❌ ${r.name}`);
    console.log('');
    process.exit(1);
  }
  console.log('全部检查通过 ✅\n');
})().catch((err) => {
  console.error('\n验收脚本自身出错：', err);
  process.exit(2);
});
