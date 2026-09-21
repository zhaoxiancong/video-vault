'use strict';
/**
 * 静态资源与 SSE（服务端推送）。
 *
 * 这两块放一起是因为它们都是"长连接/流式"的响应，跟那些一问一答的 JSON 接口
 * 处理方式完全不同：不能走统一的 try/catch + json() 那条路。
 */

const fs = require('node:fs');
const path = require('node:path');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // ⚠️ 前端拆成 ES 模块后，这个 MIME **必须是** text/javascript 或
  //    application/javascript。类型不对浏览器会直接拒绝加载模块
  //    （报 "Failed to load module script"），而且报错信息不怎么指向真正原因。
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
});

/**
 * 提供一个目录下的静态文件。
 *
 * 安全点：必须防目录穿越。`/static/../../data/vault.db` 这种请求
 * 在拼完路径后要能识别出"跑到 baseDir 外面去了"。
 */
function serveStatic(res, baseDir, relPath) {
  // 去掉查询串、解码、规范化
  const clean = decodeURIComponent(String(relPath).split('?')[0]);
  const full = path.resolve(baseDir, clean);
  const base = path.resolve(baseDir);

  // 目录穿越防线：解析后的绝对路径必须仍在 baseDir 内。
  // 用 resolve 而不是 join —— join 会保留 `..`，比较就失效了。
  if (full !== base && !full.startsWith(base + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('禁止访问');
  }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('文件不存在');
    }
    const ext = path.extname(full).toLowerCase();
    // 前端代码还在改，别让浏览器缓存住（否则"我改了怎么没生效"）
    const noCache = ['.html', '.js', '.mjs', '.css'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': noCache ? 'no-cache' : 'max-age=86400',
    });
    fs.createReadStream(full).pipe(res);
  });
}

/** 提供一个文件（带 Range 支持，网页播放器拖进度条要靠它） */
function serveFile(res, req, filePath, { contentType } = {}) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '磁盘上找不到该文件' }));
  }
  const st = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = contentType || (ext === '.mp4' || ext === '.m4a' ? 'video/mp4'
    : ext === '.webm' ? 'video/webm'
      : ext === '.mkv' ? 'video/x-matroska'
        : ext === '.mp3' ? 'audio/mpeg'
          : ext === '.opus' ? 'audio/ogg'
            : 'application/octet-stream');

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
    });
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
  });
  return fs.createReadStream(filePath).pipe(res);
}

/**
 * SSE（Server-Sent Events）广播中心。
 *
 * 为什么用 SSE 而不是 WebSocket：进度是**单向**推送，SSE 用普通 HTTP 就能做，
 * 不用握手、不用额外的库、断线浏览器会自动重连。够用就别复杂化。
 */
function createSseHub({ keepAliveMs = 15000 } = {}) {
  const clients = new Set();

  function open(req, res, { initial } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);

    if (initial && typeof initial === 'function') {
      const snapshot = initial();
      if (snapshot !== undefined) send(res, 'queue', snapshot);
    }

    // 心跳：中间有代理时，长时间没数据会被掐断连接
    const ka = setInterval(() => {
      try { res.write(': ka\n\n'); } catch { /* 连接已经没了，close 会清理 */ }
    }, keepAliveMs);

    req.on('close', () => {
      clearInterval(ka);
      clients.delete(res);
    });
  }

  function send(res, event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* 客户端断了，下次广播时会被清理 */ }
  }

  function broadcast(event, data) {
    for (const res of clients) send(res, event, data);
  }

  function stop() {
    for (const res of clients) {
      try { res.end(); } catch { /* 忽略 */ }
    }
    clients.clear();
  }

  return { open, broadcast, stop, count: () => clients.size };
}

module.exports = { serveStatic, serveFile, createSseHub, MIME };
