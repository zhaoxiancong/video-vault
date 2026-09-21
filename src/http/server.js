'use strict';
/**
 * HTTP 服务端 —— 组合根（composition root）之一。
 *
 * 这个文件只做三件事：**建立依赖 → 注册路由 → 监听端口**。
 * 它自己不含任何业务逻辑、不写 SQL、不碰子进程。
 *
 * ⚠️ 跟重构前最大的区别：所有依赖都是**显式传进去**的。
 *    以前靠 `require('./lib/db')` 这种模块级单例，加载顺序和副作用纠缠在一起，
 *    想换个数据目录跑测试都做不到。现在传入什么，就是什么。
 */

const http = require('node:http');
const { URL } = require('node:url');

const { createRouter, json } = require('./router');
const { serveStatic, serveFile, createSseHub } = require('./static-and-sse');
const { slim } = require('./views');
const { AppError } = require('../domain/errors');

const videoRoutes = require('./routes/videos');
const libraryRoutes = require('./routes/library');
const settingsRoutes = require('./routes/settings');
const discoverRoutes = require('./routes/discover');

/**
 * @param {object} ctx 依赖集合
 * @param {object} ctx.config
 * @param {object} ctx.repo
 * @param {object} ctx.scheduler
 * @param {object} ctx.downloader
 * @param {object} ctx.urldiag
 * @param {object} ctx.migrations
 * @param {string[]} [ctx.dupMerged]
 */
function createServer(ctx) {
  const { config, repo, scheduler } = ctx;

  const router = createRouter();
  const sse = createSseHub();

  /**
   * 广播中心。
   *
   * 调度器发的是领域对象，出站前统一过 slim()。
   * 这一步很重要：`log_path` 之类的本机绝对路径不该出现在给浏览器的响应里。
   */
  const broadcast = (event, data) => sse.broadcast(event, data);
  const ctxWithBroadcast = {
    ...ctx,
    broadcast,
    serveFile,
    settings: () => repo.getSettings(),
  };

  // 调度器的事件 → SSE
  scheduler.on('progress', (v) => broadcast('progress', slim(v)));
  scheduler.on('queue', (snap) => broadcast('queue', snap));
  scheduler.on('notice', (n) => broadcast('notice', n));

  // 爬取任务的事件 → SSE（与上面完全同构）。
  // 慢站超过 20 秒时会返回 202，前端靠这个事件看进度。
  if (ctx.discovery) {
    ctx.discovery.on('crawl', (e) => broadcast('crawl', e));
  }

  // 注册路由。每个文件各自管一片，互不干扰。
  libraryRoutes.register(router, ctxWithBroadcast);
  settingsRoutes.register(router, ctxWithBroadcast);
  // videos 会把"唯一的入队实现"返回出来，供 discover 复用 ——
  // 候选入队因此走的是和"粘链接"完全相同的那条路。
  const { addUrls } = videoRoutes.register(router, ctxWithBroadcast);
  discoverRoutes.register(router, { ...ctxWithBroadcast, addUrls });

  /**
   * 兜底：把内部异常翻译成 HTTP 响应。
   *
   * 约定：`AppError` 系（领域里定义的失败）带 `hint`，直接给用户看；
   * 其它异常一律当 500，**但也要带上原始 message** —— 这个工具是自用的，
   * 藏起真实原因只会让排查更难。
   */
  function errorResponse(res, err) {
    if (err instanceof AppError) {
      return json(res, err.httpStatus || 400, {
        error: err.message,
        hint: err.hint || '',
        kind: err.kind,
      });
    }
    const status = err && err.status ? err.status : 500;
    return json(res, status, {
      error: err && err.message ? err.message : '服务器内部错误',
      hint: status >= 500 ? '这是程序自身的问题，日志里可能有更多信息。' : '',
      kind: 'internal',
    });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;

    try {
      // ---- 静态资源 ----
      // 前端是原生 ES 模块，浏览器要按 text/javascript 加载（见 static-and-sse 的 MIME）
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        return serveStatic(res, config.paths.frontend, 'index.html');
      }
      if (req.method === 'GET' && p.startsWith('/static/')) {
        return serveStatic(res, config.paths.frontend, p.slice('/static/'.length));
      }

      // ---- SSE ----
      if (req.method === 'GET' && p === '/api/stream') {
        return sse.open(req, res, { initial: () => scheduler.snapshot() });
      }

      // ---- API ----
      const hit = router.match(req.method, p);
      if (hit && hit.methodMismatch) {
        return json(res, 405, {
          error: `${req.method} 不支持这个路径`,
          hint: '路径存在，但请求方法不对。',
        });
      }
      if (hit && hit.handler) {
        return await hit.handler(req, res, hit.params, u);
      }

      return json(res, 404, { error: `无此路由: ${req.method} ${p}` });
    } catch (err) {
      // 连接已经被客户端关掉时写响应会抛 —— 别让它冒到 unhandledRejection
      if (res.headersSent) return undefined;
      return errorResponse(res, err);
    }
  });

  /** 优雅关闭：先停调度器（清定时器、杀子进程），再关连接。**不调它进程退不出来。** */
  function shutdown({ timeoutMs = 1500 } = {}) {
    scheduler.stop();
    // ⚠️ 爬取也要在这里收掉：它持有在飞的 fetch（AbortController）与事件监听器。
    //    不收的话进程退不出来 —— 这是这个项目反复强调过的一类问题。
    if (ctx.discovery) ctx.discovery.stop();
    sse.stop();
    return new Promise((resolve) => {
      const done = () => resolve();
      server.close(done);
      setTimeout(done, timeoutMs);
    });
  }

  return { server, router, sse, broadcast, shutdown };
}

module.exports = { createServer };
