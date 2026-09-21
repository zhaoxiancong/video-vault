'use strict';
/**
 * 库查询 / 队列快照 / 引擎自检 —— 只读接口。
 *
 * 这些接口都是"读一次、回一次"，没有任何副作用（除了 /api/queue 会顺手
 * 把崩溃残留的任务标成 paused，那是 scheduler 的职责）。
 */

const { json } = require('../router');
const { slimHistoryRow, slimPage } = require('../views');

/** 允许的排序方式（写死：不接受前端传任意 SQL 片段） */
const SORTS = ['created_desc', 'created_asc', 'title_asc', 'size_desc', 'duration_desc'];

function register(router, ctx) {
  const { repo, scheduler, downloader, config, migrations, dupMerged } = ctx;

  // ---------------------------------------------------------------- 引擎自检

  router.get('/api/health', (req, res) => {
    const info = downloader.binaryInfo();
    return json(res, 200, {
      ok: info.ytdlp.ok,
      engines: info,
      // 上次没跑完的任务数：界面据此提示「上次有 N 个任务没跑完」
      queuedInterrupted: repo.countByStatus('paused') + repo.countByStatus('failed'),
      settings: repo.getSettings(),
      downloads: config.paths.downloads,
      version: require('../../../package.json').version,
      // 调度器的内存并发状态。**只读诊断**：`ghosts` 非空说明有槽位泄漏
      // （内存里占着槽位、库里却没有对应的进行中任务）—— 那会让新任务永远排队。
      scheduler: scheduler.diagnostics ? scheduler.diagnostics() : undefined,
    });
  });

  // ---------------------------------------------------------------- 队列快照

  /**
   * 队列快照 + 最近历史。
   *
   * 为什么要带历史：服务端的队列和库本来就是持久的，但如果只回活动任务，
   * 用户刷新页面就觉得"什么都没了"。把最近结束的任务一起回过去，
   * 刷新后仍能看到刚下完/失败的任务，并能直接删掉。
   */
  router.get('/api/queue', (req, res, params, url) => {
    const limit = Math.min(100, Number(url.searchParams.get('history') || 20));
    const snap = scheduler.snapshot();

    const history = repo.raw.prepare(
      `SELECT id,title,url,status,progress,kind,site,uploader,error,
              file_path,file_size,duration,height,container,finished_at,
              thumb_embed_ok
       FROM videos
       WHERE status IN ('done','failed','canceled','paused')
       ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC
       LIMIT ?`,
    ).all(limit).map(slimHistoryRow);

    const counts = repo.raw.prepare(
      `SELECT
         SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) AS paused,
         SUM(CASE WHEN status='canceled' THEN 1 ELSE 0 END) AS canceled
       FROM videos`,
    ).get();

    return json(res, 200, { ...snap, history, counts });
  });

  // ---------------------------------------------------------------- 库查询

  router.get('/api/library', (req, res, params, url) => {
    const sortRaw = url.searchParams.get('sort') || 'created_desc';
    const page = repo.listVideos({
      q: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || '',
      site: url.searchParams.get('site') || '',
      uploader: url.searchParams.get('uploader') || '',
      starred: url.searchParams.get('starred') === '1',
      // 白名单：排序字段拼进 SQL 的 ORDER BY，绝不能直接信前端
      sort: SORTS.includes(sortRaw) ? sortRaw : 'created_desc',
      limit: Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 200))),
      offset: Math.max(0, Number(url.searchParams.get('offset') || 0)),
    });
    return json(res, 200, slimPage(page));
  });

  router.get('/api/facets', (req, res) => {
    return json(res, 200, repo.facets());
  });

  /** 启动时做过哪些迁移 —— 界面/日志里能回看，排错时有用 */
  router.get('/api/migrations', (req, res) => {
    const out = { ...(migrations || {}) };
    if (dupMerged && dupMerged.length) out.duplicatesMerged = dupMerged;
    return json(res, 200, out);
  });
}

module.exports = { register, SORTS };
