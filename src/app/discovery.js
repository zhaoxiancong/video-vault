'use strict';
/**
 * 爬取任务的生命周期。
 *
 * 职责边界（跟 downloader/scheduler 的分工一致）：
 *   · crawler.js  只负责"怎么抓"
 *   · 这个文件    负责任务本身：串行、等待窗口、把结果落库、对外广播事件
 *
 * ══ 20 秒兜底的确切语义（spec 3.2）══
 *
 * **不是"跑到一半切换模式"**，而是：爬取一开始就在后台跑，`run()` 只负责
 * 最多等 `syncWaitMs`：
 *
 *   窗口内完成 → 返回 {status:'done', items...}
 *   超过窗口   → 返回 {status:'running', runId}，而爬取**继续跑到底并入库**
 *
 * 这个设计的三个好处：
 *   1. 没有"半路交接"的状态机 —— 那种代码最容易出竞态
 *   2. 客户端断开（关浏览器）不影响爬取完成，所以"关掉明天回来接着挑"自动成立
 *   3. 快站（实测 1.1 秒）走同步路径，用户感觉是即时出结果
 *
 * 串行：一次只跑一个爬取。并发爬同一个站是最容易被风控的行为，
 * 而且 spec 的纪律里写明了"串行"。
 */

const { EventEmitter } = require('node:events');
const { AppError } = require('../domain/errors');

/**
 * @param {object} deps
 * @param {object} deps.repo      仓储（startCrawlRun / finishCrawlRun / insertCandidates / refreshLibraryFlags）
 * @param {object} deps.crawler   createCrawler() 的产物
 * @param {number} [deps.syncWaitMs] 同步等待窗口，默认 20 秒（测试里注入小值）
 * @param {Function} [deps.broadcast] 广播函数（server.js 注入 SSE）
 */
function createDiscovery({ repo, crawler, syncWaitMs = 20000, broadcast = null } = {}) {
  const emitter = new EventEmitter();
  let stopped = false;

  /** 运行中的爬取：runId → {status, path, itemCount, error, hint, items, paging, note} */
  const runs = new Map();

  /**
   * 串行队列。
   *
   * 用一条 promise 链而不是"锁 + 等待"：链天然保证顺序，且前一个失败
   * 不会卡住后面（catch 掉再往后接）。
   */
  let chain = Promise.resolve();

  function enqueue(fn) {
    const next = chain.then(fn, fn);
    // 链条本身不能因为某个任务失败而断掉
    chain = next.then(() => undefined, () => undefined);
    return next;
  }

  function emit(payload) {
    if (stopped) return;                      // stop() 之后不再发事件
    emitter.emit('crawl', payload);
    if (broadcast) broadcast('crawl', payload);
  }

  /**
   * 把一次爬取真正跑完（无论调用方还在不在等）。
   * @returns {Promise<object>} 该次爬取的终态
   */
  async function execute(runId, url) {
    const state = { runId, url, status: 'running', path: null, itemCount: 0, paging: [], note: null };
    runs.set(runId, state);

    try {
      const result = await crawler.analyzeSource(url);
      const { inserted } = repo.insertCandidates(runId, result.items, url);
      repo.refreshLibraryFlags();

      state.status = 'done';
      state.path = result.path;
      state.title = result.title;
      state.site = result.site;
      state.itemCount = inserted;
      state.paging = result.paging || [];
      state.note = result.note;
      state.items = result.items;

      repo.finishCrawlRun(runId, {
        status: 'done',
        path: result.path,
        site: result.site,
        title: result.title,
        itemCount: inserted,
        paging: result.paging || [],
        note: result.note,
      });
      emit({ runId, status: 'done', path: result.path, itemCount: inserted, url, paging: state.paging, note: result.note });
    } catch (e) {
      // 面向用户的失败都应当是 AppError（带 hint）；别的异常也要如实落库，
      // 否则用户只会看到"没有任何反应"。
      const message = e instanceof AppError ? e.message : String((e && e.message) || e);
      const hint = e instanceof AppError ? (e.hint || '') : '';

      state.status = 'failed';
      state.error = message;
      state.hint = hint;

      repo.finishCrawlRun(runId, { status: 'failed', error: hint ? `${message} —— ${hint}` : message });
      emit({ runId, status: 'failed', error: message, hint, url });
    }
    return state;
  }

  /**
   * 发起一次爬取。
   *
   * @returns {Promise<{runId:number, status:'done'|'running'|'failed', ...}>}
   *          永远 resolve —— 失败也以 `status:'failed'` 的形式返回，
   *          因为调用方（HTTP 层）需要把它映射成 400/502 而不是 500。
   */
  async function run(url) {
    if (stopped) {
      return { status: 'failed', error: '服务正在关闭，已停止接受新的爬取。', hint: '重启服务后再试。' };
    }

    const runId = repo.startCrawlRun({ url });
    emit({ runId, status: 'running', url });

    // 排队执行 —— 注意：**不 await 整条链**，而是跟"等待窗口"赛跑
    const done = enqueue(() => execute(runId, url));

    const timeout = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), syncWaitMs);
      // 别让这个定时器把进程吊住（Node 里 unref 过就不会）
      if (typeof t.unref === 'function') t.unref();
    });

    const raced = await Promise.race([done, timeout]);

    if (raced) {
      // 窗口内跑完了
      return {
        runId,
        status: raced.status,
        path: raced.path,
        title: raced.title,
        site: raced.site,
        itemCount: raced.itemCount,
        paging: raced.paging,
        note: raced.note,
        error: raced.error,
        hint: raced.hint,
        items: raced.items,
      };
    }

    // 还没跑完 —— 返回 runId 让前端订阅 SSE。
    // 关键：**不取消 `done`** —— 它会自己跑完并入库。
    return { runId, status: 'running' };
  }

  /** 查一次爬取的当前状态（SSE 断线时前端兜底用） */
  function get(runId) {
    const s = runs.get(Number(runId));
    if (!s) return { runId: Number(runId), status: 'unknown' };
    return {
      runId: s.runId,
      status: s.status,
      path: s.path || null,
      title: s.title || null,
      site: s.site || null,
      itemCount: s.itemCount || 0,
      paging: s.paging || [],
      note: s.note || null,
      error: s.error || null,
      hint: s.hint || null,
    };
  }

  /** 清干净：停掉在飞的请求、不再发事件。挂到 app.shutdown 上。 */
  function stop() {
    stopped = true;
    try { crawler.stop(); } catch { /* 忽略 */ }
    emitter.removeAllListeners();
    runs.clear();
  }

  return {
    run,
    get,
    stop,
    on: (...a) => emitter.on(...a),
    off: (...a) => emitter.off(...a),
  };
}

module.exports = { createDiscovery };
