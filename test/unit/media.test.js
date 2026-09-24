'use strict';
/**
 * 媒体工具测试 —— 主要是 `findNewest()` 的中间分片回归。
 *
 * 这里钉住的是一个**真实踩过的 bug**，现象极其误导：
 *
 *   下载完全成功（日志里 Merger / Metadata / MoveFiles 全部 finished、零 ERROR），
 *   但任务最终被标成「文件损坏且重下仍失败」。
 *
 *   根因：`findNewest()` 的兜底把 yt-dlp 的**中间分片** `.f269.mp4`
 *   当成了成品 —— 分片只有一条流，ffprobe 读不出时长/分辨率，
 *   于是 `isPlayable()` 判"不合格"，`finish()` 把文件删掉并触发重下，
 *   下一次又挑中另一个分片……直到重试上限。
 *
 *   而真正的成品一直好好躺在同一个目录里。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../../src/infra/config');
const { createMediaTools, isFragment, FRAGMENT_RE } = require('../../src/infra/media');
const { skipWithout } = require('../helpers/engines');

function freshMedia() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-media-'));
  const config = loadConfig({
    // ⚠️ root 必须是**真实的项目根**，这样 tools/bin/ffprobe.exe 才可达。
    //    一开始这里传了 tmp 当 root，于是 paths.ffprobe 指向不存在的位置，
    //    isPlayable 走了"没有 ffprobe"的分支 —— 测试测的根本不是想测的东西。
    //    数据目录和下载目录才用临时的，保证不碰用户数据。
    root: path.resolve(__dirname, '..', '..'),
    data: path.join(tmp, 'data'),
    downloads: path.join(tmp, 'downloads'),
  });
  fs.mkdirSync(config.paths.downloads, { recursive: true });
  fs.mkdirSync(config.paths.data, { recursive: true });
  return {
    media: createMediaTools(config),
    config,
    dir: config.paths.downloads,
    tmp,
    cleanup() { fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

const touch = (p, size = 2048) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
  return p;
};

// ---------------------------------------------------------------- 分片识别

test('认得出 yt-dlp 的中间分片', () => {
  const cases = [
    '标题 [1080p137+251].f137.mp4',
    '标题 [1080p137+251].f251.webm',
    'Me at the zoo [144p269+233].f269.mp4',
    'x.f300.m4a',
    'x.f22',
  ];
  for (const c of cases) {
    assert.equal(isFragment(c), true, `${c} 应该被认成分片`);
  }
});

test('正常成品不会被误认成分片', () => {
  const cases = [
    '标题 [1080p137+251].mkv',
    'Me at the zoo [240p395+251].mkv',
    '只是名字里有f.mp4',
    'f137.mp4',              // 数字在 f 后面但没有前导点 → 不是 yt-dlp 的分片形态
    '视频.mp4',
  ];
  for (const c of cases) {
    assert.equal(isFragment(c), false, `${c} 不该被认成分片`);
  }
});

// ---------------------------------------------------------------- findNewest（回归核心）

test('findNewest 必须跳过中间分片（这就是那个"永远失败"的 bug）', () => {
  const ctx = freshMedia();
  try {
    // 模拟真实场景：目录里同时有分片和合并后的成品，
    // 而且分片的 mtime **更新**（更容易被"取最新"挑中）
    const product = touch(path.join(ctx.dir, 'Youtube', 'jawed', 'Me at the zoo [144p269+233].mkv'));
    const frag = touch(path.join(ctx.dir, 'Youtube', 'jawed', 'Me at the zoo [144p269+233].f269.mp4'));

    const later = new Date(Date.now() + 10000);
    fs.utimesSync(frag, later, later);       // 分片更新
    const earlier = new Date(Date.now() - 10000);
    fs.utimesSync(product, earlier, earlier);

    const found = ctx.media.findNewest(ctx.dir, { since: Date.now() - 60000 });
    assert.equal(found, product, '兜底必须挑成品，不能挑分片');
    assert.notEqual(found, frag);
  } finally { ctx.cleanup(); }
});

test('只有分片时 findNewest 返回 null（宁可找不到，也不要拿分片当成品）', () => {
  const ctx = freshMedia();
  try {
    touch(path.join(ctx.dir, 'a', 'x [1080p137+251].f137.mp4'));
    touch(path.join(ctx.dir, 'a', 'x [1080p137+251].f251.webm'));
    const found = ctx.media.findNewest(ctx.dir, { since: Date.now() - 60000 });
    assert.equal(found, null, '找不到成品就该返回 null，让上层继续走别的分支');
  } finally { ctx.cleanup(); }
});

test('findNewest 的 allowFragments 开关能显式放行（给排查用）', () => {
  const ctx = freshMedia();
  try {
    const frag = touch(path.join(ctx.dir, 'a.f137.mp4'));
    assert.equal(ctx.media.findNewest(ctx.dir, { since: Date.now() - 60000 }), null);
    assert.equal(
      ctx.media.findNewest(ctx.dir, { since: Date.now() - 60000, allowFragments: true }),
      frag,
    );
  } finally { ctx.cleanup(); }
});

test('findNewest 的 since 能过滤掉旧文件', () => {
  const ctx = freshMedia();
  try {
    const old = touch(path.join(ctx.dir, 'old.mkv'));
    const past = new Date(Date.now() - 3600000);
    fs.utimesSync(old, past, past);
    assert.equal(ctx.media.findNewest(ctx.dir, { since: Date.now() - 60000 }), null);
    assert.equal(ctx.media.findNewest(ctx.dir, { since: 0 }), old);
  } finally { ctx.cleanup(); }
});

test('findNewest 挑最新的成品', () => {
  const ctx = freshMedia();
  try {
    const a = touch(path.join(ctx.dir, 'a.mkv'));
    const b = touch(path.join(ctx.dir, 'b.mp4'));
    fs.utimesSync(a, new Date(Date.now() - 30000), new Date(Date.now() - 30000));
    fs.utimesSync(b, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    assert.equal(ctx.media.findNewest(ctx.dir, { since: Date.now() - 60000 }), b);
  } finally { ctx.cleanup(); }
});

// ---------------------------------------------------------------- isPlayable

test('isPlayable 对不存在的路径、空文件、小于 1KB 都返回 false（不需要 ffprobe）', () => {
  const ctx = freshMedia();
  try {
    assert.equal(ctx.media.isPlayable(path.join(ctx.dir, 'nope.mkv')), false);

    const empty = path.join(ctx.dir, 'empty.mkv');
    fs.writeFileSync(empty, '');
    assert.equal(ctx.media.isPlayable(empty), false, '空文件');

    const tiny = path.join(ctx.dir, 'tiny.mkv');
    fs.writeFileSync(tiny, Buffer.alloc(100));
    assert.equal(ctx.media.isPlayable(tiny), false, '小于 1KB');
  } finally { ctx.cleanup(); }
});

/**
 * 这一条**必须**有真 ffprobe 才有意义。
 *
 * "文件存在"不等于"文件完整"这句话，只有 ffprobe 真的读过这个文件才算验证过；
 * 没有 ffprobe 时 `isPlayable()` 走的是"没验过"分支返回 false —— 结论碰巧也是
 * false，但那是**蒙对的**。让它照跑，就等于用假绿掩盖"完整性校验根本没生效"。
 */
test('isPlayable 对垃圾内容返回 false（要真 ffprobe 才作数）',
  { skip: skipWithout('ffprobe') }, () => {
    const ctx = freshMedia();
    try {
      const junk = path.join(ctx.dir, 'junk.mkv');
      fs.writeFileSync(junk, Buffer.alloc(5000, 0x41));
      assert.equal(ctx.media.isPlayable(junk), false, '"文件存在"不等于"文件完整"');
    } finally { ctx.cleanup(); }
  });

test('inspect() 会说明判断依据，而不是只给个布尔',
  { skip: skipWithout('ffprobe') }, () => {
  const ctx = freshMedia();
  try {
    const junk = path.join(ctx.dir, 'junk.mkv');
    fs.writeFileSync(junk, Buffer.alloc(5000, 0x41));
    const r = ctx.media.inspect(junk);
    assert.equal(r.ok, false);
    assert.equal(r.verified, true, '这条结论是实测出来的');
    assert.match(r.reason, /ffprobe/, `原因应该指向实际发生了什么：${r.reason}`);
  } finally { ctx.cleanup(); }
});

/**
 * 抽封面：**带嵌入封面的文件必须能抽出封面**。
 *
 * 这条是补一个真 bug：`grabThumbnail` 原来的参数是
 *     `-map 0:v -map -0:V -frames:v 1 …`
 * 而 `-map 0:v` 会把**附加封面流**（attached_pic，mkv/mp4 里的 mjpeg）也算进来，
 * `-map -0:V` 又把它排除掉 —— 这类文件就变成"没有任何流可输出"，
 * ffmpeg 报 `Output file does not contain any stream` 并**失败**。
 *
 * 讽刺的是：**恰恰是那些带着封面的文件抽不出封面**（实测 129 个文件里
 * 有 15 个中招），而没有嵌入封面的反而正常。
 */
test('grabThumbnail：带嵌入封面的视频也要能抽出封面（要真 ffmpeg）',
  { skip: skipWithout('ffmpeg') }, () => {
    const ctx = freshMedia();
    try {
      const ffmpeg = ctx.config.paths.ffmpeg;
      const src = path.join(ctx.dir, 'clip.mkv');
      const cover = path.join(ctx.dir, 'cover.jpg');
      const { runSync } = require('../../src/infra/subprocess');

      // ① 一段真视频（1 秒彩条）
      let r = runSync(ffmpeg, [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src,
      ], { timeout: 60000 });
      assert.equal(r.status, 0, '造视频失败：' + String(r.stderr).slice(0, 200));

      // ② 一张真封面（jsdelivr 的覆盖率报告图？不 —— 用 ffmpeg 自己生成一张）
      r = runSync(ffmpeg, [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:size=320x240', '-frames:v', '1', cover,
      ], { timeout: 60000 });
      assert.equal(r.status, 0, '造封面失败');

      // ③ 把封面**嵌进视频**（这正是 yt-dlp 的 --embed-thumbnail 做的事）
      r = runSync(ffmpeg, [
        '-y', '-v', 'error', '-i', src, '-i', cover,
        '-map', '0', '-map', '1', '-c', 'copy', '-disposition:v:1', 'attached_pic',
        src.replace('.mkv', '-withcover.mkv'),
      ], { timeout: 60000 });
      assert.equal(r.status, 0, '嵌封面失败：' + String(r.stderr).slice(0, 200));
      const withCover = src.replace('.mkv', '-withcover.mkv');

      // 确认这个文件**真的带上了**第二条视频流（封面），否则这条测试就没测到点子上。
      // ⚠️ 注意：**mkv 里的封面流不带 `attached_pic` 标记**（实测是 0），
      //    mp4 里才带。原来这条断言要求 attached_pic=1，于是 mkv 用例直接不过 ——
      //    而"mkv 里不标"正是那个 bug 的成因。所以这里只要求"有两条视频流"。
      const probe = runSync(ctx.config.paths.ffprobe, [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', withCover,
      ], { timeout: 60000 });
      const streams = JSON.parse(probe.stdout).streams || [];
      const vids = streams.filter((s) => s.codec_type === 'video');
      assert.ok(vids.length >= 2,
        `这个文件必须有"正片 + 封面"两条视频流才测得到那个 bug，实际流：${streams.map((s) => s.codec_type + '/' + s.codec_name).join(', ')}`);

      // ④ 抽封面 —— 修之前这里会失败（"Output file does not contain any stream"）
      const thumb = ctx.media.grabThumbnail({ id: 999, thumbnail_url: null }, withCover);
      assert.ok(thumb, '带嵌入封面的文件也必须能抽出封面');
      assert.ok(fs.existsSync(thumb), '抽出来的文件要真的在磁盘上');
      assert.ok(fs.statSync(thumb).size > 0, '而且不能是 0 字节');
      assert.match(path.basename(thumb), /^999\.jpg$/, '命名规则：{id}.jpg');
    } finally { ctx.cleanup(); }
  });

test('没有 ffprobe 时如实报告"没验过"，而不是假装验过了', () => {
  const ctx = freshMedia();
  try {
    // 造一个 ffprobe 不存在的 config
    const noProbe = createMediaTools({
      ...ctx.config,
      paths: { ...ctx.config.paths, ffprobe: path.join(ctx.tmp, '不存在的-ffprobe.exe') },
    });
    const f = path.join(ctx.dir, 'something.mkv');
    fs.writeFileSync(f, Buffer.alloc(5000, 0x41));

    const r = noProbe.inspect(f);
    // 策略是"采信但记下来" —— 关键是 verified 必须是 false，不能骗上层说验过了
    assert.equal(r.verified, false, '没 ffprobe 时 verified 必须是 false');
    assert.match(r.reason, /无法实测|没有 ffprobe/, `要说清没验过：${r.reason}`);
  } finally { ctx.cleanup(); }
});

test('isPlayable 对 null / 空串安全', () => {
  const ctx = freshMedia();
  try {
    assert.equal(ctx.media.isPlayable(null), false);
    assert.equal(ctx.media.isPlayable(''), false);
    assert.equal(ctx.media.isPlayable(undefined), false);
  } finally { ctx.cleanup(); }
});

// ---------------------------------------------------------------- cleanupFormatFiles

test('cleanupFormatFiles 只删同名分片，绝不误删别的成品', () => {
  const ctx = freshMedia();
  try {
    const dir = path.join(ctx.dir, 'site', 'author');
    const final = touch(path.join(dir, 'My Video [1080p137+251].mkv'));
    const frag1 = touch(path.join(dir, 'My Video [1080p137+251].f137.mp4'));
    const frag2 = touch(path.join(dir, 'My Video [1080p137+251].f251.webm'));
    const other = touch(path.join(dir, '别的视频 [720p].mkv'));
    const sibling = touch(path.join(dir, 'My Video [1080p137+251] 续集.f137.mp4'));

    const removed = ctx.media.cleanupFormatFiles(ctx.dir, {}, final);

    assert.equal(fs.existsSync(final), true, '成品必须留着');
    assert.equal(fs.existsSync(other), true, '别的视频必须留着');
    assert.equal(fs.existsSync(sibling), true, '同前缀但不同标题的不能删');
    assert.equal(fs.existsSync(frag1), false, '同名分片该删');
    assert.equal(fs.existsSync(frag2), false, '同名分片该删');
    assert.equal(removed, 2);
  } finally { ctx.cleanup(); }
});

// ---------------------------------------------------------------- removePartials

test('removePartials 只删半截文件，不动成品', () => {
  const ctx = freshMedia();
  try {
    const dir = path.join(ctx.dir, 'site');
    const done = touch(path.join(dir, 'done.mkv'));
    const part = touch(path.join(dir, 'doing.mkv.part'));
    const ytdl = touch(path.join(dir, 'doing.ytdl'));

    ctx.media.removePartials(ctx.dir, {});

    assert.equal(fs.existsSync(done), true, '成品不能被删');
    assert.equal(fs.existsSync(part), false);
    assert.equal(fs.existsSync(ytdl), false);
  } finally { ctx.cleanup(); }
});

test('removePartials 对不存在的目录不抛异常', () => {
  const ctx = freshMedia();
  try {
    assert.doesNotThrow(() => ctx.media.removePartials(path.join(ctx.dir, '不存在'), {}));
  } finally { ctx.cleanup(); }
});
