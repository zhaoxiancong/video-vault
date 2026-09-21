'use strict';
/**
 * 「从网站找视频」路由：发起爬取、查状态、候选列表、批量入队。
 *
 * 每个处理函数只做三件事：**校验参数 → 调服务 → 返回视图**。
 * 抓取逻辑在 `app/crawler.js`，任务生命周期在 `app/discovery.js`，这里不碰。
 *
 * ⚠️ 一个刻意的设计（见 spec 3.4）：`POST /api/crawl` 在爬取完成时**不返回候选条目**，
 *    只返回 runId 与元信息；候选一律走 `GET /api/candidates?runId=` 取。理由：
 *    这样 200 与 202 两种响应**同形**，前端只写一套逻辑；而且 200 条候选不会
 *    被塞进 POST 响应里再传一遍。
 */

const { json, readJsonBody } = require('../router');
const { ValidationError, NotFoundError } = require('../../domain/errors');

/** 允许的动作名（写死，拼错时不要静默无事发生） */
const ACTIONS = ['add'];

function register(router, ctx) {
  const { repo, discovery } = ctx;

  // ---------------------------------------------------------------- 发起爬取

  /**
   * 起一次爬取。
   *
   * 200 = 窗口内跑完了；202 = 转后台（前端订阅 SSE 看进度，结果照样入库）。
   * 失败映射成 400（地址问题）或 502（目标站问题）而不是 500 ——
   * 「AppError 带 hint」的那些失败是**可预期的**，不是程序 bug。
   */
  router.post('/api/crawl', async (req, res) => {
    const body = await readJsonBody(req);
    const url = body && typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      throw new ValidationError('没有提供网址', { hint: '把要抓的页面地址粘进来，一行一个。' });
    }
    if (url.length > 2048) {
      throw new ValidationError('网址太长了', { hint: '正常的网页地址不会超过 2048 个字符。' });
    }

    const r = await discovery.run(url);

    if (r.status === 'failed') {
      // 抓取失败：把 domain 层翻译好的 message/hint 原样给用户
      const status = /限速|429|拒绝|403/.test(r.error || '') ? 502 : 400;
      return json(res, status, { error: r.error, hint: r.hint || '', kind: 'crawl' });
    }

    if (r.status === 'running') {
      return json(res, 202, { runId: r.runId, status: 'running', url });
    }

    return json(res, 200, {
      runId: r.runId,
      status: 'done',
      url,
      path: r.path,
      title: r.title || null,
      site: r.site || null,
      itemCount: r.itemCount || 0,
      paging: r.paging || [],
      note: r.note || null,
    });
  });

  // ---------------------------------------------------------------- 查状态

  /** SSE 断线时前端兜底用：问一次当前状态 */
  router.get('/api/crawl/:id', (req, res, params) => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('爬取 id 不合法', { hint: 'id 应该是正整数。' });
    }
    const state = discovery.get(id);
    if (state.status === 'unknown') {
      // 进程重启过、或者 id 根本不存在 —— 查库里的记录也能给个答复
      const row = repo.getCrawlRun(id);
      if (!row) throw new NotFoundError('找不到这次爬取记录');
      return json(res, 200, {
        runId: id,
        status: row.status,
        path: row.path,
        itemCount: row.item_count,
        paging: safeJson(row.paging_json),
        note: row.note,
        error: row.error,
      });
    }
    return json(res, 200, state);
  });

  // ---------------------------------------------------------------- 候选列表

  /**
   * 候选列表。关键字过滤**也在这里做**（服务端 LIKE）——
   * 这样刷新页面/换设备也能带着筛选条件拿到同样结果。
   * 前端另有一层本地实时过滤（`crawl-parse.filterCandidates`），两层用的是同一套语义。
   */
  router.get('/api/candidates', (req, res, params, url) => {
    const sp = url.searchParams;
    const limit = Math.min(500, Math.max(1, Number(sp.get('limit') || 200)));
    const offset = Math.max(0, Number(sp.get('offset') || 0));
    const runIdRaw = sp.get('runId');

    const out = repo.listCandidates({
      q: sp.get('q') || '',
      onlyNew: sp.get('onlyNew') === '1',
      runId: runIdRaw ? Number(runIdRaw) : null,
      limit,
      offset,
    });
    return json(res, 200, out);
  });

  // ---------------------------------------------------------------- 批量入队

  /**
   * 批量把候选加入下载队列。
   *
   * ⚠️ **复用 lib 层的"按 URL 入库 + 唤醒队列"那条路**，不自己往 videos 表插行 ——
   *    否则会绕过去重、URL 归一化和队列唤醒（Review Focus 5）。
   *    这里通过 ctx 拿到的 `addUrls` 就是那个入口（由 videoRoutes 暴露）。
   */
  router.post('/api/candidates/action', async (req, res) => {
    const body = await readJsonBody(req);
    const action = String((body && body.action) || '');
    if (!ACTIONS.includes(action)) {
      throw new ValidationError(`不认识的动作：${action || '(空)'}`, {
        hint: `目前只支持：${ACTIONS.join(', ')}`,
      });
    }

    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) {
      throw new ValidationError('没有选中任何候选', { hint: '先勾选几条再点加入下载队列。' });
    }

    const picked = repo.getCandidatesByIds(ids);
    if (!picked.length) throw new NotFoundError('选中的候选都不存在了，可能已经清理过');

    if (!ctx.addUrls) {
      throw new ValidationError('入队入口不可用', { hint: '这是程序内部装配问题，请报告。' });
    }

    const report = await ctx.addUrls(picked.map((c) => c.url), {});
    repo.markCandidatesAdded(picked.map((c) => c.id));
    // 入队之后必须重算在库标记 —— 否则用户刚点完"加入下载队列"，
    // 列表上这条还显示"＋新"，会让人以为没生效。
    repo.refreshLibraryFlags();

    return json(res, 200, {
      requested: ids.length,
      added: report.added ? report.added.length : 0,
      skipped: report.skipped ? report.skipped.length : 0,
      retried: report.retried ? report.retried.length : 0,
      errors: report.errors || [],
    });
  });
}

/** paging_json 可能是坏的（手工改过库），别让列表接口因此 500 */
function safeJson(text) {
  if (!text) return [];
  try { return JSON.parse(text); } catch { return []; }
}

module.exports = { register };
