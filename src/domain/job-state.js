'use strict';
/**
 * 任务状态机 —— 把"哪些状态转换是合法的"变成一处可读、可测的定义。
 *
 * 重构前，状态是散落在 queue.js 各处的字符串字面量：
 *   `db.updateVideo(id, { status: STATUS.DOWNLOADING })` 出现在七八个地方，
 *   没有任何一处说明"queued 能不能直接跳到 done"、"canceled 之后还能不能 resume"。
 *   结果是这个项目**真的**踩了坑 13：调度器在 `_start()` 的第一个 await 之后
 *   才迁移状态，于是 await 让出控制权时任务还是 queued，被反复捞起来启动，
 *   堆内存每秒涨 50MB，几分钟后 OOM 崩溃。
 *
 *   那次事故的本质不是"忘了写一行"，而是**状态迁移没有唯一入口**，
 *   所以没人能一眼看出"这个时刻状态还是旧值"。
 *
 * 现在：每一次状态变更都走 `transition()`，它只允许表里列出的转换。
 * 非法转换直接抛错（开发期立刻暴露），而不是悄悄写进库里留下一个诡异状态。
 */

const { STATUS } = require('../infra/config');

/**
 * 合法转换表：from → 允许到达的 to 集合。
 *
 * 设计原则：**这张表是从现有代码的实际行为反推出来的，不是拍脑袋定的。**
 * 做法是把老代码里每一处 `updateVideo({status})` 都找出来逐个核对
 * （queue.js 有 13 处、server.js 有 2 处），确保不落下任何一条真实路径 ——
 * 否则重构就会悄悄变成"顺手改行为"。
 *
 * 核对时抓到一条容易漏的：`resume(id, {force:true})` 会让任务从
 * **任意状态**（包括 downloading、done）直接回到 queued，
 * 于是 queued → downloading 也是一条真实路径（见下面 QUEUED 一组）。
 * 如果只凭"queued 应该先 parsing"想当然，这条就会被误杀。
 */
const TRANSITIONS = Object.freeze({
  // 刚入库，等调度器捞；也包括"重新下载"后的回炉
  [STATUS.QUEUED]: [
    STATUS.PARSING,
    STATUS.DOWNLOADING,  // ← 真实路径：没有解析阶段时直接开下
    STATUS.CANCELED,     // 排队时被取消
    STATUS.PAUSED,       // 关站/崩溃后被 recoverStale 修正
    STATUS.FAILED,       // 启动阶段就失败（比如 spawn 抛错）
  ],

  // 正在解析元数据
  [STATUS.PARSING]: [
    STATUS.DOWNLOADING,
    STATUS.PAUSED,       // 用户暂停
    STATUS.CANCELED,
    STATUS.FAILED,
    STATUS.QUEUED,
  ],

  // 正在下载
  [STATUS.DOWNLOADING]: [
    STATUS.PROCESSING,   // 下载完，进入合并/抽音频
    STATUS.DONE,         // 没有后处理步骤时直接完成
    STATUS.PAUSED,
    STATUS.CANCELED,
    STATUS.FAILED,
    STATUS.QUEUED,       // 损坏重下：重新排回队列
  ],

  // 后处理（合并 / 抽音频）
  [STATUS.PROCESSING]: [
    STATUS.DONE,
    STATUS.PAUSED,
    STATUS.CANCELED,
    STATUS.FAILED,
    STATUS.QUEUED,
  ],

  // 终态。done / canceled 不再自己动，但界面有「重新下载」按钮，
  // 所以要允许它们被送回队列。
  [STATUS.DONE]: [
    STATUS.QUEUED,
    STATUS.DOWNLOADING,  // force 重下
    STATUS.PAUSED,
    STATUS.CANCELED,
  ],

  [STATUS.CANCELED]: [
    STATUS.QUEUED,
    STATUS.DOWNLOADING,  // force 重下
    STATUS.PARSING,
    STATUS.PAUSED,
  ],

  // 失败和暂停都可以「继续」或「重试」
  [STATUS.FAILED]: [
    STATUS.QUEUED,
    STATUS.DOWNLOADING,
    STATUS.PARSING,
    STATUS.PAUSED,
    STATUS.CANCELED,
    STATUS.DONE,         // 极端情况：进程其实成功了但收尾判失败，后来修正
  ],

  [STATUS.PAUSED]: [
    STATUS.QUEUED,
    STATUS.DOWNLOADING,
    STATUS.PARSING,
    STATUS.PROCESSING,
    STATUS.CANCELED,
    STATUS.FAILED,
    STATUS.DONE,
  ],
});

/** 终态：不会再自己往前走的状态 */
const TERMINAL = Object.freeze([STATUS.DONE, STATUS.FAILED, STATUS.CANCELED, STATUS.PAUSED]);

/** 这个状态是不是"正在占用队列槽位" */
function isActive(status) {
  return status === STATUS.QUEUED || status === STATUS.PARSING
    || status === STATUS.DOWNLOADING || status === STATUS.PROCESSING;
}

/** 是不是终态（暂停算终态：它不会自己恢复，必须用户点继续） */
function isTerminal(status) {
  return TERMINAL.includes(status);
}

/** 这次转换合不合法 */
function canTransition(from, to) {
  if (from === to) return true;            // 幂等写入（重复广播）不算错
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** 状态是不是这个应用认识的值 */
function isKnownStatus(status) {
  return Object.values(STATUS).includes(status);
}

/**
 * 一次非法的状态转换。
 * 单独一个错误类型，方便上层区分"这是程序 bug"和"这是业务失败"。
 */
class InvalidTransitionError extends Error {
  constructor(from, to, context = '') {
    const hint = !isKnownStatus(to)
      ? `目标状态「${to}」根本不是合法状态`
      : `从「${from}」不能直接到「${to}」`;
    super(`非法状态转换：${hint}${context ? `（${context}）` : ''}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
    this.context = context;
  }
}

/**
 * 校验并返回新状态。
 *
 * @param {string} from 当前状态
 * @param {string} to   想变成的状态
 * @param {object} [opts]
 * @param {string} [opts.context]  出错时附加的说明（哪个任务、哪一步）
 * @param {boolean} [opts.strict]  true = 抛错；false = 只回报不中断
 * @param {(msg:string)=>void} [opts.onWarn]
 * @returns {string} 校验通过的目标状态
 * @throws {InvalidTransitionError} 仅在 strict 模式下
 */
function transition(from, to, opts = {}) {
  const { context = '', strict = isStrict(), onWarn } = opts;

  if (!isKnownStatus(to)) {
    const err = new InvalidTransitionError(from, to, context);
    if (strict) throw err;
    report(err, onWarn);
    return to;
  }
  if (canTransition(from, to)) return to;

  const err = new InvalidTransitionError(from, to, context);
  if (strict) throw err;
  report(err, onWarn);
  // 非严格模式放行：**生产环境不能因为一次意外的状态转换就让下载崩掉**。
  // 但要留下痕迹 —— 静默放行等于把这个检查废掉。
  return to;
}

/**
 * 默认的严格度：由环境变量控制。
 *
 * 为什么默认不抛错：这张转换表是从现有行为反推的，我们可能漏掉某条真实路径。
 * 在生产里"未知路径 → 抛异常 → 下载失败"代价太高；
 * 而"未知路径 → 打一条警告 → 继续跑"既能保住服务，又能让我们发现漏网之鱼。
 *
 * 测试里把 VAULT_STRICT_STATE=1 打开，漏掉的路径就会变成红色测试。
 */
function isStrict() {
  const v = process.env.VAULT_STRICT_STATE;
  return v === '1' || v === 'true';
}

/** 报告一次意外转换（去重，避免刷屏） */
const reported = new Set();
function report(err, onWarn) {
  if (onWarn) { onWarn(err.message); return; }
  const key = `${err.from}→${err.to}`;
  if (reported.has(key)) return;
  reported.add(key);
  // eslint-disable-next-line no-console
  console.warn(`[状态机] ${err.message}`);
}

/** 这个状态在界面上该怎么叫（唯一一处中文名，前端也用它） */
const LABELS = Object.freeze({
  [STATUS.QUEUED]: '排队中',
  [STATUS.PARSING]: '解析中',
  [STATUS.DOWNLOADING]: '下载中',
  [STATUS.PROCESSING]: '处理中',
  [STATUS.DONE]: '已完成',
  [STATUS.FAILED]: '失败',
  [STATUS.PAUSED]: '已暂停',
  [STATUS.CANCELED]: '已取消',
});

function label(status) {
  return LABELS[status] || status || '未知';
}

module.exports = {
  TRANSITIONS,
  TERMINAL,
  LABELS,
  isActive,
  isTerminal,
  isKnownStatus,
  canTransition,
  transition,
  isStrict,
  label,
  InvalidTransitionError,
};
