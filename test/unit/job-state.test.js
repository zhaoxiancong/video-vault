'use strict';
/**
 * 状态机测试。
 *
 * 这里钉住的是**从老代码里逐个核对出来的真实转换路径**。
 * 如果哪天有人改了状态机却漏了某条真实路径，这些测试会红 ——
 * 而不是等到线上某个任务卡在诡异状态才发现。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const js = require('../../src/domain/job-state');
const { STATUS } = require('../../src/infra/config');

test('28 条真实转换路径全部合法（从老代码逐个核对出来的）', () => {
  const real = [
    // 这是把老代码里每一处 updateVideo({status}) 找出来核对的结果
    ['queued', 'downloading', '_start 直接开下'],
    ['queued', 'parsing', '调度器进入解析'],
    ['queued', 'paused', 'recoverStale 修正崩溃残留'],
    ['queued', 'canceled', '排队时被取消'],
    ['parsing', 'downloading', '解析完成'],
    ['downloading', 'processing', '进入后处理'],
    ['downloading', 'done', '无后处理步骤'],
    ['downloading', 'paused', '用户暂停'],
    ['downloading', 'canceled', '用户取消'],
    ['downloading', 'failed', '下载失败'],
    ['downloading', 'queued', '损坏后自动重下'],
    ['processing', 'done', '收尾完成'],
    ['processing', 'paused', '暂停'],
    ['processing', 'canceled', '取消'],
    ['processing', 'failed', '后处理失败'],
    ['paused', 'queued', '点继续'],
    ['paused', 'downloading', 'force 继续'],
    ['paused', 'canceled', '取消'],
    ['paused', 'failed', '失败'],
    ['failed', 'queued', '重试'],
    ['failed', 'paused', '标记中断'],
    ['failed', 'canceled', '取消'],
    ['canceled', 'queued', '重新下载'],
    ['canceled', 'downloading', 'force 重下'],
    ['done', 'queued', '重新下载'],
    ['done', 'downloading', 'force 重下'],
    ['done', 'paused', '标记中断'],
    ['done', 'canceled', '删除前'],
  ];

  const rejected = real.filter(([from, to]) => !js.canTransition(from, to));
  assert.deepEqual(rejected, [], `这些真实路径被状态机误杀了：${JSON.stringify(rejected)}`);
});

test('真正非法的转换必须被拦住', () => {
  // 这几条在任何真实流程里都不会出现，出现就说明有 bug
  const illegal = [
    ['queued', 'processing'],   // 必须先经过 downloading（line 232 无条件写 downloading）
    ['queued', 'done'],         // 不能跳过下载直接完成
    ['parsing', 'done'],        // 解析完必须开下
    ['canceled', 'done'],       // 取消了的任务不会自己变成完成
    ['done', 'failed'],         // 完成了不会自己变失败
  ];
  for (const [from, to] of illegal) {
    assert.equal(js.canTransition(from, to), false, `${from} → ${to} 本该被拦住`);
  }
});

test('同一个状态写两次算合法（重复广播不该报错）', () => {
  assert.equal(js.canTransition('downloading', 'downloading'), true);
  assert.equal(js.canTransition('done', 'done'), true);
});

test('非严格模式放行但会报告（生产环境不能因为意外转换就崩）', () => {
  const warnings = [];
  const got = js.transition('queued', 'processing', {
    strict: false, context: '测试', onWarn: (m) => warnings.push(m),
  });
  assert.equal(got, 'processing', '非严格模式下应该放行');
  assert.equal(warnings.length, 1, '必须留下痕迹，静默放行等于把检查废掉');
  assert.match(warnings[0], /非法状态转换/);
});

test('严格模式对非法转换抛错', () => {
  assert.throws(
    () => js.transition('queued', 'processing', { strict: true }),
    (err) => {
      assert.equal(err.name, 'InvalidTransitionError');
      assert.equal(err.from, 'queued');
      assert.equal(err.to, 'processing');
      return true;
    },
  );
});

test('未知状态名一律拒绝（拼错状态名是最容易犯的错）', () => {
  assert.equal(js.isKnownStatus('downloading'), true);
  assert.equal(js.isKnownStatus('download'), false);
  assert.equal(js.isKnownStatus(''), false);
  assert.throws(
    () => js.transition('queued', 'donwloading', { strict: true }),   // 故意的拼错
    /根本不是合法状态/,
  );
});

test('isActive / isTerminal 的判定', () => {
  for (const s of ['queued', 'parsing', 'downloading', 'processing']) {
    assert.equal(js.isActive(s), true, `${s} 应该算活动状态`);
  }
  assert.equal(js.isActive('done'), false);
  assert.equal(js.isActive('paused'), false);

  for (const s of ['done', 'failed', 'canceled', 'paused']) {
    assert.equal(js.isTerminal(s), true, `${s} 应该算终态`);
  }
  // 暂停算终态：它不会自己恢复，必须用户点继续
  assert.equal(js.isTerminal('paused'), true);
});

test('每个状态都有中文标签（界面上不能出现裸英文状态名）', () => {
  for (const s of Object.values(STATUS)) {
    assert.ok(js.label(s), `${s} 缺中文标签`);
    assert.notEqual(js.label(s), s, `${s} 的中文标签不能就是它自己`);
  }
});

test('TERMINAL 常量和服务端用的状态集合一致', () => {
  assert.deepEqual([...js.TERMINAL].sort(), ['canceled', 'done', 'failed', 'paused']);
});
