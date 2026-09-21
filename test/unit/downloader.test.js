'use strict';
/**
 * 下载参数与引擎行为测试。
 *
 * 这一批是从**老套件里补回来的** —— 我做完重构时声称"111 项一条不丢"，
 * 但用量化对照（tools/audit-test-parity.js）一查，【参数构造】这一块
 * 老套件有 9 条断言、新套件只剩 2 条，是掉得最多的一类。
 *
 * 这些断言看着琐碎，但每一条背后都有代价：
 *   · 合并容器必须是 mkv —— 设成 mp4 会让 YouTube 高清（vp9/av1 + opus）
 *     直接合并失败（README 坑 5）
 *   · 限速参数要真的进命令行 —— 老代码有过"设了但没生效"的问题
 *   · cookie 参数默认一个都不带 —— 隐私底线
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, withDefaults, DEFAULT_SETTINGS } = require('../../src/infra/config');
const { createDownloader } = require('../../src/app/downloader');

const APP_ROOT = path.resolve(__dirname, '..', '..');

/** 造一个下载器（数据目录用临时的，避免污染用户库） */
function freshDownloader() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-dl-'));
  const config = loadConfig({
    root: APP_ROOT,                       // 真实 root：这样 tools/bin 里的引擎可达
    data: path.join(tmp, 'data'),
    downloads: path.join(tmp, 'downloads'),
  });
  fs.mkdirSync(config.paths.downloads, { recursive: true });
  fs.mkdirSync(config.paths.data, { recursive: true });
  return {
    dl: createDownloader(config),
    config,
    tmp,
    settings: (patch) => withDefaults({ ...patch }, config),
    cleanup() { fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

/** 取某个参数后面跟的值 */
function valueAfter(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const has = (args, flag) => args.includes(flag);

// ---------------------------------------------------------------- 通用参数

test('每次调用都带上的基础参数（可预期的行为）', () => {
  const ctx = freshDownloader();
  try {
    const args = ctx.dl.commonArgs(ctx.settings({}), '/tmp/r.txt');
    // --ignore-config 很重要：不读用户的全局 yt-dlp 配置，行为才可预期
    assert.ok(has(args, '--ignore-config'), '必须忽略用户全局配置');
    assert.ok(has(args, '--no-playlist'), '单视频任务默认只下一个');
    assert.ok(has(args, '--no-warnings'));
    assert.ok(has(args, '--no-mtime'), '不要用远端时间覆盖本地文件时间');
    assert.ok(has(args, '--no-colors'));
  } finally { ctx.cleanup(); }
});

test('进度模板是管道分隔格式（避开 NA 破坏 JSON 的坑）', () => {
  const ctx = freshDownloader();
  try {
    const args = ctx.dl.commonArgs(ctx.settings({}), null);
    const tmpls = args.filter((a, i) => args[i - 1] === '--progress-template');
    assert.ok(tmpls.length >= 2, '下载进度和后处理进度各一个模板');
    for (const t of tmpls) {
      assert.match(t, /VVP\|/, `模板必须是管道分隔：${t}`);
      assert.doesNotMatch(t, /%\([^)]*\)j/, '不能用 j 转换 —— NA 时会输出裸 NA，JSON 就废了');
    }
  } finally { ctx.cleanup(); }
});

test('中文路径安全：最终文件路径走 --print-to-file，绝不走 stdout', () => {
  const ctx = freshDownloader();
  try {
    const resultFile = path.join(ctx.tmp, 'r.txt');
    const args = ctx.dl.commonArgs(ctx.settings({}), resultFile);
    const i = args.indexOf('--print-to-file');
    assert.ok(i >= 0, '必须用 --print-to-file');
    assert.equal(args[i + 1], 'after_move:%(filepath)s', '要在移动完成后打印最终路径');
    assert.equal(args[i + 2], resultFile);
  } finally { ctx.cleanup(); }
});

// ---------------------------------------------------------------- 限速 / 分片并发

test('限速为 0 时不加 --limit-rate（默认不限速）', () => {
  const ctx = freshDownloader();
  try {
    const args = ctx.dl.commonArgs(ctx.settings({ rateLimitMB: 0 }), null);
    assert.equal(valueAfter(args, '--limit-rate'), undefined, '不限速时不该出现这个参数');
  } finally { ctx.cleanup(); }
});

test('限速参数已注入（>0 时真的进了命令行）', () => {
  const ctx = freshDownloader();
  try {
    const args = ctx.dl.commonArgs(ctx.settings({ rateLimitMB: 3 }), null);
    assert.equal(valueAfter(args, '--limit-rate'), '3M');
  } finally { ctx.cleanup(); }
});

test('分片并发数进了命令行（HLS/DASH 提速靠它）', () => {
  const ctx = freshDownloader();
  try {
    const on = ctx.dl.commonArgs(ctx.settings({ fragmentConcurrency: 8 }), null);
    assert.equal(valueAfter(on, '--concurrent-fragments'), '8');

    // 为 1 时不加 —— 单分片并发没意义，还会多传个参数
    const off = ctx.dl.commonArgs(ctx.settings({ fragmentConcurrency: 1 }), null);
    assert.equal(valueAfter(off, '--concurrent-fragments'), undefined);
  } finally { ctx.cleanup(); }
});

test('重试次数透传到两个重试参数', () => {
  const ctx = freshDownloader();
  try {
    const args = ctx.dl.commonArgs(ctx.settings({ retries: 5 }), null);
    assert.equal(valueAfter(args, '--retries'), '5');
    assert.equal(valueAfter(args, '--fragment-retries'), '5');
  } finally { ctx.cleanup(); }
});

// ---------------------------------------------------------------- 登录态（隐私底线）

test('没配置时不带任何 cookie 参数（不偷读浏览器）', () => {
  const ctx = freshDownloader();
  try {
    const args = ctx.dl.commonArgs(ctx.settings({}), null);
    assert.ok(!has(args, '--cookies'), '不能出现 --cookies');
    assert.ok(!has(args, '--cookies-from-browser'), '不能出现 --cookies-from-browser');
  } finally { ctx.cleanup(); }
});

test('配了浏览器才生成 --cookies-from-browser', () => {
  const ctx = freshDownloader();
  try {
    const args = ctx.dl.commonArgs(ctx.settings({ cookiesFromBrowser: 'chrome' }), null);
    assert.equal(valueAfter(args, '--cookies-from-browser'), 'chrome');
  } finally { ctx.cleanup(); }
});

test('配了文件就用文件，且优先于浏览器', () => {
  const ctx = freshDownloader();
  try {
    const cookieFile = path.join(ctx.tmp, 'cookies.txt');
    fs.writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tsid\tv\n');
    const args = ctx.dl.commonArgs(
      ctx.settings({ cookiesFromBrowser: 'chrome', cookiesFile: cookieFile }), null,
    );
    assert.equal(valueAfter(args, '--cookies'), cookieFile);
    assert.ok(!has(args, '--cookies-from-browser'), '文件优先时不该再带浏览器参数');
  } finally { ctx.cleanup(); }
});

test('配置有问题时不静默跳过 —— 记下来给上层（takeCookieNote）', () => {
  const ctx = freshDownloader();
  try {
    // 不存在的 cookie 文件
    ctx.dl.commonArgs(ctx.settings({ cookiesFile: path.join(ctx.tmp, '不存在.txt') }), null);
    const note = ctx.dl.takeCookieNote();
    assert.ok(note, '必须留下提示，否则用户以为登录态开了、其实没开');
    assert.match(note, /不存在/);

    // 取一次就清空，避免粘到下一次下载上
    assert.equal(ctx.dl.takeCookieNote(), null);
  } finally { ctx.cleanup(); }
});

// ---------------------------------------------------------------- 下载参数

test('合并容器设为 mkv（兼容 vp9/opus，设成 mp4 会让高清合并失败）', () => {
  const ctx = freshDownloader();
  try {
    const args = ctx.dl.buildDownloadArgs({ url: 'https://x/1', kind: 'video', quality: 'best' }, ctx.settings({}), {});
    assert.equal(valueAfter(args, '--merge-output-format'), 'mkv');
  } finally { ctx.cleanup(); }
});

test('清晰度映射到正确的 -f 表达式', () => {
  const ctx = freshDownloader();
  try {
    const cases = [
      ['best', /bv\*\+ba/],
      ['1080p', /height<=1080/],
      ['720p', /height<=720/],
      ['worst', /wv\*\+wa/],
    ];
    for (const [q, re] of cases) {
      const args = ctx.dl.buildDownloadArgs({ url: 'https://x/1', kind: 'video', quality: q }, ctx.settings({}), {});
      assert.match(valueAfter(args, '-f'), re, `清晰度 ${q} 的 -f 不对`);
    }
  } finally { ctx.cleanup(); }
});

test('未知清晰度退回 best，不崩', () => {
  const ctx = freshDownloader();
  try {
    const args = ctx.dl.buildDownloadArgs(
      { url: 'https://x/1', kind: 'video', quality: '不存在的档位' }, ctx.settings({}), {},
    );
    assert.equal(valueAfter(args, '-f'), ctx.dl.QUALITY_MAP.best);
  } finally { ctx.cleanup(); }
});

test('仅音频：抽音频 + 不带清晰度后缀', () => {
  const ctx = freshDownloader();
  try {
    const s = ctx.settings({ audioFormat: 'mp3' });
    const args = ctx.dl.buildDownloadArgs({ url: 'https://x/1', kind: 'audio' }, s, {});
    assert.ok(has(args, '-x'), '要抽音频');
    assert.equal(valueAfter(args, '--audio-format'), 'mp3');
    assert.ok(!has(args, '--merge-output-format'), '音频不需要合并容器');

    // 命名不该带 [1080p...] 后缀
    const tmpl = ctx.dl.outtmpl(s, 'audio');
    assert.doesNotMatch(tmpl, /\[%\(height\)s/, '音频文件名不该带清晰度后缀');
  } finally { ctx.cleanup(); }
});

test('输出路径按 站点/作者/标题 [高度p格式号].ext 组织', () => {
  const ctx = freshDownloader();
  try {
    const withUploader = ctx.dl.outtmpl(ctx.settings({ organizeByUploader: true }), 'video');
    assert.match(withUploader, /%\(extractor_key\)s/);
    assert.match(withUploader, /%\(uploader\|unknown\)s/);
    assert.match(withUploader, /\[%\(height\)sp%\(format_id\)s\]/);

    const noUploader = ctx.dl.outtmpl(ctx.settings({ organizeByUploader: false }), 'video');
    assert.doesNotMatch(noUploader, /uploader/, '关掉之后不该再按作者建子目录');
  } finally { ctx.cleanup(); }
});

test('输出路径用设置里的下载目录（用户改了就跟着改）', () => {
  const ctx = freshDownloader();
  try {
    const custom = path.join(ctx.tmp, '我的下载');
    const s = ctx.settings({ downloadDir: custom });
    assert.ok(ctx.dl.outtmpl(s, 'video').startsWith(custom));
  } finally { ctx.cleanup(); }
});

test('续传时加 --no-overwrites（不覆盖已完成的文件）', () => {
  const ctx = freshDownloader();
  try {
    const s = ctx.settings({});
    const resume = ctx.dl.buildDownloadArgs({ url: 'https://x/1', kind: 'video' }, s, { resume: true });
    assert.ok(has(resume, '--continue'));
    assert.ok(has(resume, '--no-overwrites'), '续传必须不覆盖');
    assert.ok(has(resume, '--part'), '要保留 .part 以便下次接着下');

    const fresh = ctx.dl.buildDownloadArgs({ url: 'https://x/1', kind: 'video' }, s, { resume: false });
    assert.ok(has(fresh, '--continue'));
    assert.ok(!has(fresh, '--no-overwrites'));
  } finally { ctx.cleanup(); }
});

test('URL 前有 -- 分隔符（防止地址被当成参数解析）', () => {
  const ctx = freshDownloader();
  try {
    const args = ctx.dl.buildDownloadArgs({ url: 'https://x/1', kind: 'video' }, ctx.settings({}), {});
    const sep = args.indexOf('--');
    assert.ok(sep >= 0, '必须有 -- 分隔符');
    assert.equal(args[sep + 1], 'https://x/1');
    assert.equal(sep, args.length - 2, 'URL 必须是最后一个参数');
  } finally { ctx.cleanup(); }
});

test('嵌入封面只在明确要求时才加（封面格式不支持会让任务失败，是加分项不是必需项）', () => {
  const ctx = freshDownloader();
  try {
    const s = ctx.settings({});
    const withThumb = ctx.dl.buildDownloadArgs({ url: 'https://x/1', kind: 'video' }, s, { embedThumbnail: true });
    assert.ok(has(withThumb, '--embed-thumbnail'));
    assert.equal(valueAfter(withThumb, '--convert-thumbnails'), 'jpg');

    const without = ctx.dl.buildDownloadArgs({ url: 'https://x/1', kind: 'video' }, s, { embedThumbnail: false });
    assert.ok(!has(without, '--embed-thumbnail'), '不要求时不能加');
  } finally { ctx.cleanup(); }
});

test('元数据嵌入是默认行为', () => {
  const ctx = freshDownloader();
  try {
    const args = ctx.dl.buildDownloadArgs({ url: 'https://x/1', kind: 'video' }, ctx.settings({}), {});
    assert.ok(has(args, '--embed-metadata'));
  } finally { ctx.cleanup(); }
});

// ---------------------------------------------------------------- 引擎可用性

test('引擎自检报告 yt-dlp 与 ffmpeg 的状态', () => {
  const ctx = freshDownloader();
  try {
    const info = ctx.dl.binaryInfo();
    assert.ok(info.ytdlp, '要有 ytdlp 报告');
    assert.ok(info.ffmpeg, '要有 ffmpeg 报告');
    assert.equal(typeof info.ytdlp.ok, 'boolean');
    assert.ok(info.ytdlp.path.includes('yt-dlp'), '报告里要带路径，方便排查');

    if (info.ytdlp.ok) assert.match(info.ytdlp.version, /\d{4}\.\d{2}\.\d{2}/, 'yt-dlp 版本形如 2026.08.19');
  } finally { ctx.cleanup(); }
});

test('yt-dlp 用的是目录式分发（不是 onefile —— onefile 在受限沙箱里自解包会失败）', () => {
  const ctx = freshDownloader();
  try {
    assert.ok(fs.existsSync(ctx.config.paths.ytdlp), `找不到 ${ctx.config.paths.ytdlp}`);
    const internal = path.join(path.dirname(ctx.config.paths.ytdlp), '_internal');
    assert.ok(fs.existsSync(internal),
      '缺少同级 _internal 目录 —— 这是单文件版，会在 %TEMP% 自解包然后失败（README 坑 2）');
  } finally { ctx.cleanup(); }
});

test('引擎缺失时 probeBinary 报告"进程没能启动"而不是假装成功', () => {
  const ctx = freshDownloader();
  try {
    const { probeBinary } = require('../../src/infra/subprocess');
    const r = probeBinary(path.join(ctx.tmp, '不存在的.exe'), ['--version']);
    assert.equal(r.ok, false);
    assert.ok(r.error, '要给原因');
  } finally { ctx.cleanup(); }
});
