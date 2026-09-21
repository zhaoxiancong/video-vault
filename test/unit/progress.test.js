'use strict';
/**
 * 进度与阶段解析测试 —— 这个文件里全是"撞了墙才定下来"的规则。
 *
 * 最值钱的两组：
 *   1. **NA 值**：yt-dlp 的模板在字段不可用时输出裸 `NA`，
 *      这是为什么最终选了管道分隔而不是 JSON（坑 4）。
 *   2. **下载阶段 vs 后处理阶段**：ThumbnailsConvertor 会在下载**之前**跑，
 *      把它当成"进入后处理"会让进度条整场卡在 99%（坑 9）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const p = require('../../src/infra/progress');

// ---------------------------------------------------------------- 管道解析

test('正常的下载进度帧', () => {
  const ev = p.parsePipeLine('VVP|  0.5%|1024|223779|68430.4|3|NA|NA');
  assert.equal(ev.type, 'progress');
  assert.equal(ev.percent, 0.5);
  assert.equal(ev.downloaded, 1024);
  assert.equal(ev.total, 223779);
  assert.equal(ev.speed, 68430.4);
  assert.equal(ev.eta, 3);
});

test('NA 必须变成 null，不能是 NaN（Number("NA") === NaN 会污染整个前端）', () => {
  const ev = p.parsePipeLine('VVP|NA|NA|NA|NA|NA|NA|NA');
  assert.equal(ev.percent, null);
  assert.equal(ev.speed, null);
  assert.equal(ev.eta, null);
  assert.equal(ev.fragment, null);
  assert.equal(ev.fragmentCount, null);
  // 关键：不能出现 NaN
  for (const [k, v] of Object.entries(ev)) {
    if (k === 'type') continue;
    assert.ok(v === null || Number.isFinite(v), `${k} 是 ${v}，不该出现 NaN`);
  }
});

test('格式号是 NA 时其他字段照常解析（这正是选管道格式的理由）', () => {
  // 用 JSON 模板时，裸 NA 会让整行变成非法 JSON，什么都读不到
  const ev = p.parsePipeLine('VVP| 42.0%|500|1000|1024|10|NA|NA');
  assert.equal(ev.percent, 42);
  assert.equal(ev.downloaded, 500, '同一条帧里的其他字段必须完好');
});

test('百分比缺失时用字节数自己算', () => {
  const ev = p.parsePipeLine('VVP|NA|500|1000|1024|10|NA|NA');
  assert.equal(ev.percent, 50);
});

test('后处理帧（2 字段）', () => {
  const ev = p.parsePipeLine('VVP|Merger|started');
  assert.equal(ev.type, 'postprocess');
  assert.equal(ev.stage, 'Merger');
  assert.equal(ev.status, 'started');
});

test('字段数不对的帧返回 null，不抛异常', () => {
  assert.equal(p.parsePipeLine('VVP|a|b|c'), null);
  assert.equal(p.parsePipeLine('VVP|'), null);
  assert.equal(p.parsePipeLine('别的行'), null);
});

// ---------------------------------------------------------------- 空值归一

test('num() 把各种"空"统一成 null', () => {
  assert.equal(p.num('NA'), null);
  assert.equal(p.num(''), null);
  assert.equal(p.num(null), null);
  assert.equal(p.num(undefined), null);
  assert.equal(p.num('0'), 0, '0 是有效值，不能当成空');
  assert.equal(p.num('12.5'), 12.5);
  assert.equal(p.num('abc'), null);
});

// ---------------------------------------------------------------- 行解析

test('裸管道帧（真实输出形态，模板的路由标记不出现）', () => {
  const ev = p.parseProgressLine('VVP|  1.0%|100|1000|500|9|NA|NA');
  assert.equal(ev.type, 'progress');
});

test('带 download: 前缀的也认（兼容）', () => {
  const ev = p.parseProgressLine('download:VVP|  1.0%|100|1000|500|9|NA|NA');
  assert.equal(ev.type, 'progress');
});

test('识别我们自己的标记行', () => {
  assert.equal(p.parseProgressLine('VVAULT_META:abc|Youtube').type, 'meta');
  assert.equal(p.parseProgressLine('VVAULT_FILE:D:\\a b\\c.mkv').path, 'D:\\a b\\c.mkv');
  assert.equal(p.parseProgressLine('VVAULT_POST:Merger').stage, 'Merger');
});

test('识别 yt-dlp 的普通行', () => {
  assert.equal(p.parseProgressLine('[download] Destination: a.mkv').type, 'destination');
  assert.equal(p.parseProgressLine('[download] a.mkv has already been downloaded').type, 'already');
  assert.equal(p.parseProgressLine('ERROR: 出错了').type, 'error');
  assert.equal(p.parseProgressLine('[Merger] Merging formats').type, 'stage');
  assert.equal(p.parseProgressLine('随便一行日志').type, 'log');
});

test('空行返回 null', () => {
  assert.equal(p.parseProgressLine(''), null);
  assert.equal(p.parseProgressLine('   '), null);
  assert.equal(p.parseProgressLine(null), null);
});

// ---------------------------------------------------------------- 后处理判据（坑 9）

test('POST_STAGE_RE 只认真正的后处理器', () => {
  for (const s of ['Merger', 'ExtractAudio', 'VideoConvertor', 'VideoRemuxer', 'Fixup']) {
    assert.equal(p.POST_STAGE_RE.test(s), true, `${s} 应该是真正的后处理`);
  }
});

test('ThumbnailsConvertor 与 Metadata 不算"进入后处理"（这是坑 9 的核心）', () => {
  // 它们会在**下载开始之前**就跑一次。如果把它们当成后处理，
  // 进度条会从开场被钉死在 99%，而真实下载从 0.1% 走到 99.4%。
  assert.equal(p.POST_STAGE_RE.test('ThumbnailsConvertor'), false);
  assert.equal(p.POST_STAGE_RE.test('Metadata'), false);
});

// ---------------------------------------------------------------- 错误清洗（坑 10）

test('错误清洗不会把进度帧当成错误信息', () => {
  // 曾经的 bug：cleanError 取"最后一行"，而进度帧恰好排在最后，
  // 于是数据库里的 error 字段变成 "VVP|100.0%|21039208|..."
  const log = [
    '[download] 100% of 21.04MiB',
    'VVP|100.0%|21039208|21039208|1024|0|NA|NA',
    'VVAULT_META:abc|Youtube',
    'Deleting original file a.f137.mp4',
  ].join('\n');
  const err = p.cleanError(log);
  assert.doesNotMatch(err, /^VVP\|/, '不能返回进度帧');
  assert.doesNotMatch(err, /VVAULT_/);
});

test('有 ERROR 行时优先取它', () => {
  const log = [
    '[download] 50% of 10MiB',
    'ERROR: This video is unavailable',
    'VVP|100.0%|1|1|1|0|NA|NA',
  ].join('\n');
  assert.match(p.cleanError(log), /This video is unavailable/);
});

test('笼统的 "ERROR: Postprocessing:" 要取它后面那行（真正原因在那）', () => {
  const log = [
    'ERROR: Postprocessing: ',
    'Error opening output files: Invalid argument',
  ].join('\n');
  const err = p.cleanError(log);
  assert.match(err, /Invalid argument/, '真正的原因在 Postprocessing 的下一行');
});

test('没有 ERROR 行时挑看起来像报错的那行', () => {
  const log = [
    '[download] Destination: a.mkv',
    'WARNING: unable to extract something',
    'some trailing noise',
  ].join('\n');
  assert.match(p.cleanError(log), /unable to extract/);
});

test('cleanError 对空输入返回空串，不抛异常', () => {
  assert.equal(p.cleanError(''), '');
  assert.equal(p.cleanError(null), '');
});

test('错误信息长度有上限（不把整个日志灌进数据库）', () => {
  const log = `ERROR: ${'x'.repeat(2000)}`;
  assert.ok(p.cleanError(log).length <= 500);
});

// ---------------------------------------------------------------- 模板本身

test('进度模板用管道分隔，且带 yt-dlp 的路由标记', () => {
  assert.match(p.PROGRESS_TEMPLATE, /^download:VVP\|/);
  assert.match(p.POSTPROCESS_TEMPLATE, /^postprocess:VVP\|/);
  // 绝不能退回 JSON 模板 —— 那就是被 NA 咬的根源
  assert.doesNotMatch(p.PROGRESS_TEMPLATE, /%\(.*\)j/, '不能用 j 转换（NA 时输出裸 NA）');
});
