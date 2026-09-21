'use strict';
/**
 * 错误分类测试。
 *
 * 这些规则每一条都对应一次真实撞见的失败。测试的价值在于钉住
 * **"hint 不能为空"** —— 一条没有"下一步该做什么"的报错，
 * 对用户等于没有报错（这是这个项目反复吃过的亏）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const errors = require('../../src/domain/errors');

/** 真实撞见过的报错原文 → 期望的分类 */
const CASES = [
  ['ERROR: Could not copy Chrome cookie database',
    'cookies-browser-locked', /浏览器正开着/, /完全退出|关掉/],
  ['ERROR: Fresh cookies (not necessarily logged in) are needed',
    'cookies-required', /要求带 Cookie/, /登录态|浏览器/],
  ['ERROR: failed to decrypt with DPAPI',
    'cookies-decrypt-failed', /解不开|加密/, /yt-dlp|cookies\.txt/],
  ['ERROR: Unsupported browser: foo',
    'cookies-unsupported-browser', /不认识这个浏览器/, /浏览器/],
  ['ERROR: Unsupported URL: https://www.xvideos.com/best/2026-08',
    'unsupported-url', /地址引擎不认/, /点进具体|视频的地址/],
  ['ERROR: This video is unavailable',
    'video-unavailable', /取不到/, /被删|地区|工具本身/],
  ['ERROR: Sign in to confirm your age',
    'age-restricted', /年龄限制/, /登录态|Cookie/],
  ['ERROR: This video is members-only',
    'members-only', /会员/, /登录态|Cookie/],
  ['ERROR: HTTP Error 429: Too Many Requests',
    'rate-limited', /限流/, /并发|限速|等一会儿/],
  ['ERROR: HTTP Error 403: Forbidden',
    'forbidden', /拒绝/, /登录态|并发|风控/],
  ['ERROR: HTTP Error 404: Not Found',
    'not-found', /不存在/, /拼错|删/],
  ['ERROR: Unable to download webpage: Connection refused',
    'network', /网络连不上/, /网络|代理/],
  ['ERROR: Invalid data found when processing input',
    'corrupt-media', /坏的/, /重下/],
  ['ERROR: ffmpeg not found',
    'ffmpeg-missing', /找不到 ffmpeg/, /bootstrap-engine/],
  ['ERROR: Postprocessing: ',
    'postprocessing', /后处理失败/, /封面|日志|原因/],
];

test('真实报错原文都能被正确分类，且带可操作的 hint', () => {
  for (const [raw, category, titleRe, hintRe] of CASES) {
    const e = errors.fromEngineOutput(raw);
    assert.equal(e.category, category, `「${raw}」分类错了，得到 ${e.category}`);
    assert.match(e.message, titleRe, `「${raw}」的标题不对：${e.message}`);
    assert.match(e.hint, hintRe, `「${raw}」的 hint 不对：${e.hint}`);
  }
});

test('任何分类结果的 hint 都不许为空（这是本模块存在的理由）', () => {
  for (const [raw] of CASES) {
    const e = errors.fromEngineOutput(raw);
    assert.ok(e.hint && e.hint.length > 5, `「${raw}」的 hint 太短或为空`);
  }
});

test('认不出来的报错也要给 hint（告诉用户去哪看细节）', () => {
  const e = errors.fromEngineOutput('ERROR: 某个从没见过的新错误');
  assert.equal(e.category, 'other');
  assert.ok(e.hint.length > 5, '兜底也得给 hint');
  assert.match(e.hint, /日志/, '兜底 hint 应该指向日志');
  // 原文要保留 —— 排查时最需要的就是引擎原话
  assert.match(e.message, /从没见过的新错误/);
});

test('跟 cookie 无关的报错不会被硬套上 cookie 的翻译', () => {
  const cls = errors.classify('ERROR: Video unavailable');
  assert.notEqual(cls.category, 'cookies-required');
});

test('toUserText 把主因和下一步拼在一起', () => {
  const e = errors.fromEngineOutput('ERROR: Could not copy Chrome cookie database');
  const text = e.toUserText();
  assert.match(text, /浏览器正开着/);
  assert.match(text, /完全退出/);
  assert.match(text, /——/, '应该用破折号把"发生了什么"和"怎么办"分开');
});

test('toJSON 的 raw 字段会被截断（防止把超长日志灌进响应）', () => {
  const e = errors.fromEngineOutput(`ERROR: ${'x'.repeat(5000)}`);
  const j = e.toJSON();
  assert.ok(!j.raw || j.raw.length <= 400, `raw 没截断：${j.raw && j.raw.length}`);
});

test('可重试分类的判定', () => {
  assert.equal(errors.isRetryable(errors.fromEngineOutput('ERROR: Connection reset')), true);
  assert.equal(errors.isRetryable(errors.fromEngineOutput('ERROR: HTTP Error 429')), true);
  assert.equal(errors.isRetryable(errors.fromEngineOutput('ERROR: This video is unavailable')), false);
  assert.equal(errors.isRetryable(null), false);
});

test('ValidationError / NotFoundError 带正确的 HTTP 状态码', () => {
  assert.equal(new errors.ValidationError('x').httpStatus, 400);
  assert.equal(new errors.NotFoundError('x').httpStatus, 404);
  // NotFoundError 即便不传 hint 也要有一句默认的
  assert.ok(new errors.NotFoundError('记录不存在').hint.length > 0);
});
