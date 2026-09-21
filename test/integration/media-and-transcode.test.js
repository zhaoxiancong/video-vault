'use strict';
/**
 * 媒体探测与转码测试 —— 用**真实的 ffmpeg 生成一个真视频**来测。
 *
 * 这一批也是从老套件里补回来的（老 selftest 的【元数据】9 条、【转码】4 条）。
 *
 * 为什么值得：转码是「当剪辑素材用」这个核心需求的实现路径，
 * 而它的产物（`_converted/` 里的文件）和**原始文件绝不能被动**这条约定，
 * 是三个需求互相冲突时定下来的关键设计。用假文件测不出来。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, ensureDirs } = require('../../src/infra/config');
const { createDatabase } = require('../../src/infra/database');
const { createMediaTools } = require('../../src/infra/media');
const { createTranscodeService, presetList, TRANSCODE_PRESETS } = require('../../src/app/transcode');
const { runSync } = require('../../src/infra/subprocess');
const { skipWithout } = require('../helpers/engines');

const APP_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 没 ffmpeg 时**整片跳过**（node:test 原生 skip，汇总里单独算"跳过"）。
 *
 * 以前这里是 `if (!f) { console.log('⏭'); return; }` —— 汇总显示"✔ 通过"，
 * 但断言一条都没跑。环境导致的"没测"必须和"测过了"在汇总里长得不一样，
 * 否则没引擎的机器上会有整片转码测试假绿。
 */
const noFFmpeg = skipWithout('ffmpeg');

function freshEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-media2-'));
  const config = loadConfig({
    root: APP_ROOT,                       // 真实 root，引擎可达
    data: path.join(tmp, 'data'),
    downloads: path.join(tmp, 'downloads'),
  });
  ensureDirs(config);
  const repo = createDatabase(config);
  repo.runMigrations();
  const media = createMediaTools(config);
  const transcode = createTranscodeService(config, {
    repo, media, downloadDir: () => config.paths.downloads,
  });
  return {
    config, repo, media, transcode, tmp,
    cleanup() { try { repo.close(); } catch { /* 忽略 */ } fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

/**
 * 用 ffmpeg 生成一个几秒钟的真视频（带音轨）。
 * 失败时返回 null，原因留在 `sampleError` 里 —— 跳过也要说清为什么。
 */
let sampleError = '';
function makeSampleVideo(dir, name = 'sample.mkv') {
  const out = path.join(dir, name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = runSync(path.join(APP_ROOT, 'tools', 'bin', 'ffmpeg.exe'), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest',
    out,
  ], { timeout: 120000 });
  if (r.status !== 0 || !fs.existsSync(out)) {
    sampleError = (r.error && r.error.message) || `ffmpeg 退出码 ${r.status}`;
    return null;
  }
  sampleError = '';
  return out;
}

// ---------------------------------------------------------------- 元数据探测

test('ffprobe 能读出真实媒体信息（分辨率/时长/编码）', { skip: noFFmpeg }, (t) => {
  const e = freshEnv();
  try {
    const f = makeSampleVideo(e.tmp);
    if (!f) return t.skip(`ffmpeg 在，但生成样片失败：${sampleError}`);

    const info = e.media.probe(f);
    assert.ok(info, 'probe 应该返回信息');
    assert.equal(info.width, 320, `宽度应为 320，实际 ${info.width}`);
    assert.equal(info.height, 240, `高度应为 240，实际 ${info.height}`);
    assert.ok(info.duration >= 1 && info.duration <= 4, `时长应约 2 秒，实际 ${info.duration}`);
    assert.equal(info.vcodec, 'h264');
    assert.equal(info.acodec, 'aac');
    assert.ok(info.file_size > 0);
    assert.ok(info.fps > 0, `要读出帧率，实际 ${info.fps}`);
  } finally { e.cleanup(); }
});

test('真实视频被判为可播放，垃圾文件不可播放', { skip: noFFmpeg }, (t) => {
  const e = freshEnv();
  try {
    const f = makeSampleVideo(e.tmp);
    if (!f) return t.skip(`ffmpeg 在，但生成样片失败：${sampleError}`);

    assert.equal(e.media.isPlayable(f), true, '真实视频应该可播放');

    const junk = path.join(e.tmp, 'junk.mkv');
    fs.writeFileSync(junk, Buffer.alloc(4096, 0x41));
    assert.equal(e.media.isPlayable(junk), false, '垃圾内容不可播放');

    assert.equal(e.media.isPlayable(path.join(e.tmp, '不存在.mkv')), false);
  } finally { e.cleanup(); }
});

test('探测出的元数据能入库，并且能按标题搜到', { skip: noFFmpeg }, (t) => {
  const e = freshEnv();
  try {
    const f = makeSampleVideo(e.tmp);
    if (!f) return t.skip(`ffmpeg 在，但生成样片失败：${sampleError}`);

    const info = e.media.probe(f);
    const v = e.repo.insertVideo({
      url: 'https://example.com/meta',
      title: '我的测试片子',
      status: 'done',
      file_path: f,
      file_size: info.file_size,
      duration: info.duration,
      width: info.width,
      height: info.height,
      vcodec: info.vcodec,
      acodec: info.acodec,
      container: 'mkv',
    });

    const back = e.repo.getVideo(v.id);
    assert.equal(back.title, '我的测试片子', '标题已入库');
    assert.equal(back.duration, info.duration, '时长已入库');
    assert.equal(back.height, 240, '分辨率已入库（ffprobe 生效）');
    assert.equal(back.width, 320);
    assert.equal(back.vcodec, 'h264');

    // 按标题搜到
    const found = e.repo.listVideos({ q: '测试片子' });
    assert.equal(found.total, 1, '应该能按标题关键词搜到');
    assert.equal(found.rows[0].id, v.id);

    // 按分辨率排序也用得上这些字段
    const sorted = e.repo.listVideos({ sort: 'duration_desc' });
    assert.equal(sorted.rows[0].id, v.id);
  } finally { e.cleanup(); }
});

// ---------------------------------------------------------------- 转码

test('转码预设清单完整（前端下拉框靠它）', () => {
  const list = presetList();
  assert.ok(list.length >= 5, `预设至少 5 个，实际 ${list.length}`);
  const keys = list.map((p) => p.name);
  for (const k of ['copy-mp4', 'h264-1080p', 'h264-720p', 'h265-1080p', 'audio-mp3']) {
    assert.ok(keys.includes(k), `缺少预设 ${k}`);
  }
  for (const p of list) {
    assert.ok(p.label && p.ext, `预设 ${p.name} 要有 label 和 ext`);
  }
});

test('ffmpeg 转码成功，产物可读且是 H.264/MP4', { skip: noFFmpeg }, async (t) => {
  const e = freshEnv();
  try {
    const src = makeSampleVideo(e.tmp);
    if (!src) return t.skip(`ffmpeg 在，但生成样片失败：${sampleError}`);

    const v = e.repo.insertVideo({
      url: 'https://example.com/tc', title: '待转码', status: 'done', file_path: src,
    });

    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('转码超时（60s）')), 60000);
      e.transcode.start(v, 'h264-720p', {
        onDone: (info) => { clearTimeout(t); resolve(info); },
        onFail: () => { clearTimeout(t); reject(new Error('转码报告失败')); },
      });
    });

    const info = await done;
    assert.ok(fs.existsSync(info.path), `转码产物应该存在：${info.path}`);
    assert.match(info.path, /_converted/, '产物必须另存在 _converted/ 子目录');
    assert.match(info.path, /\.mp4$/);

    const probe = e.media.probe(info.path);
    assert.ok(probe, '产物应该能被 ffprobe 读出');
    assert.equal(probe.vcodec, 'h264', `产物应是 H.264，实际 ${probe.vcodec}`);

    const rec = e.repo.getVideo(v.id);
    assert.equal(rec.transcode_status, 'done');
    assert.equal(rec.transcoded_path, info.path);
    assert.equal(rec.transcode_preset, 'h264-720p');
  } finally { e.cleanup(); }
});

test('转码绝不动原始文件（防丢需求：归档层只读）', { skip: noFFmpeg }, async (t) => {
  const e = freshEnv();
  try {
    const src = makeSampleVideo(e.tmp);
    if (!src) return t.skip(`ffmpeg 在，但生成样片失败：${sampleError}`);

    const before = fs.readFileSync(src);
    const beforeStat = fs.statSync(src);
    const v = e.repo.insertVideo({
      url: 'https://example.com/keep', title: '原始不许动', status: 'done', file_path: src,
    });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('转码超时')), 60000);
      e.transcode.start(v, 'copy-mp4', {
        onDone: () => { clearTimeout(t); resolve(); },
        onFail: () => { clearTimeout(t); reject(new Error('转码失败')); },
      });
    });

    assert.ok(fs.existsSync(src), '原始文件必须还在');
    assert.equal(fs.statSync(src).size, beforeStat.size, '原始文件大小不该变');
    assert.ok(fs.readFileSync(src).equals(before), '原始文件内容一个字节都不该变');
  } finally { e.cleanup(); }
});

test('未知预设被拒绝，并列出可用预设', { skip: noFFmpeg }, (t) => {
  const e = freshEnv();
  try {
    const src = makeSampleVideo(e.tmp);
    if (!src) return t.skip(`ffmpeg 在，但生成样片失败：${sampleError}`);
    const v = e.repo.insertVideo({ url: 'https://e/x', title: 'x', status: 'done', file_path: src });

    assert.throws(
      () => e.transcode.start(v, '不存在的预设'),
      (err) => {
        assert.match(err.message, /未知转码预设/);
        assert.match(err.hint || '', /copy-mp4|h264-1080p/, '提示里要列出可用预设');
        return true;
      },
    );
  } finally { e.cleanup(); }
});

/**
 * ⚠️ 这条也要 ffmpeg —— 看起来它只测"源文件没了"，其实不是。
 *
 * `transcode.start()` 的顺序是**先查 ffmpeg、再查源文件**（transcode.js:110 → :116），
 * 所以没有 ffmpeg 时抛的是"ffmpeg 不可用"，根本走不到"原始文件不存在"那条分支。
 * 硬跑这条断言必然失败，而失败原因跟它想测的东西毫无关系 —— 那是**假失败**。
 *
 * （不改 start() 的顺序：本轮要求行为完全不变。顺序本身可以再议，
 *   但"更具体的错误优先"属于行为变更，不该顺手塞进重构。）
 */
test('原始文件不存在时转码被拒绝（给可操作提示）', { skip: noFFmpeg }, () => {
  const e = freshEnv();
  try {
    const v = e.repo.insertVideo({
      url: 'https://e/missing', title: '源文件没了', status: 'done',
      file_path: path.join(e.tmp, '不存在.mkv'),
    });
    assert.throws(
      () => e.transcode.start(v, 'h264-720p'),
      (err) => {
        assert.match(err.message, /原始文件不存在/);
        assert.ok(err.hint, '要告诉用户怎么办');
        return true;
      },
    );
  } finally { e.cleanup(); }
});

test('同一个任务不会并发转码两次', { skip: noFFmpeg }, async (t) => {
  const e = freshEnv();
  try {
    const src = makeSampleVideo(e.tmp);
    if (!src) return t.skip(`ffmpeg 在，但生成样片失败：${sampleError}`);
    const v = e.repo.insertVideo({ url: 'https://e/dup', title: 'x', status: 'done', file_path: src });

    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('超时')), 60000);
      e.transcode.start(v, 'h264-720p', {
        onDone: () => { clearTimeout(t); resolve(); },
        onFail: () => { clearTimeout(t); reject(new Error('转码失败')); },
      });
    });

    // 立刻再起一次 —— 应该被拒
    assert.throws(() => e.transcode.start(v, 'h264-720p'), /已经在转码中/);

    await done;
  } finally { e.cleanup(); }
});

test('TRANSCODE_PRESETS 的每个预设都能构造出合法参数', () => {
  for (const [name, p] of Object.entries(TRANSCODE_PRESETS)) {
    const args = p.args('out.file');
    assert.ok(Array.isArray(args) && args.length, `${name} 要能构造参数`);
    assert.ok(args.includes('out.file'), `${name} 的参数里要包含输出路径`);
    assert.ok(p.label && p.ext, `${name} 要有 label 和 ext`);
  }
});
