'use strict';
/**
 * 极简路由器 + 请求/响应工具。
 *
 * 为什么手写而不是引 Express/Fastify：
 *   这个应用一共二十来个路由，没有中间件生态需求，也没有多实例/插件需求。
 *   Express 会带来一条依赖链（30+ 个传递依赖）和一个"框架约定"的心智负担；
 *   而这个项目恰恰以"clone 下来就能跑"为卖点。手写一个 100 行的路由器，
 *   换来的是零依赖和完全可读的路由表。
 *
 * 但有三件事是**必须**做对的，手写也少不了：
 *   1. 路径参数（`/api/videos/:id/action`）
 *   2. 每个处理函数统一 try/catch，异常一定要变成 JSON 而不是崩掉服务
 *   3. 请求体大小上限（不然一个超大 POST 就能把内存打满）
 */

const MAX_BODY = 2 * 1024 * 1024;   // 2MB：设置/链接列表都用不了这么多

/** 标准 JSON 响应 */
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** 读 JSON 请求体，带大小上限 */
function readJsonBody(req, { limit = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error(`请求体太大（超过 ${Math.round(limit / 1024)}KB）`);
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch {
        const err = new Error('请求体不是合法的 JSON');
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * 把 `/api/videos/:id/action` 这样的模板编译成正则。
 * 只支持 `:name` 一种语法 —— 够用，而且不会有意外行为。
 */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (!seg.startsWith(':')) {
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      names.push(seg.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { re: new RegExp(`^${source}$`), names };
}

function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const { re, names } = compile(pattern);
    routes.push({ method, pattern, re, names, handler });
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    patch: (p, h) => add('PATCH', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),

    /**
     * 找到匹配的路由。
     * 返回 `{handler, params}`；路径匹配但方法不符时返回 `{methodMismatch:true}`
     * —— 这一点很重要：否则前端会收到一个莫名其妙的 404，
     * 而真正的问题只是方法写错了。
     */
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params, pattern: r.pattern };
      }
      return pathMatched ? { methodMismatch: true } : null;
    },

    /** 路由表（启动时打日志、也方便测试断言） */
    list: () => routes.map((r) => `${r.method} ${r.pattern}`),
  };
}

module.exports = { createRouter, json, readJsonBody, MAX_BODY, compile };
