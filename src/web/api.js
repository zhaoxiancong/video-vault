/**
 * 与后端说话的唯一入口。
 * 所有请求都从这里走 —— 组件里不许直接 fetch，否则错误处理各写一套。
 */

/**
 * 一次 API 调用。
 *
 * 后端失败时会回 `{error, hint, kind}`。**hint 是给用户看的下一步**，
 * 所以要把它拼进错误信息里 —— 只显示 "400 Bad Request" 对用户毫无价值。
 */
export async function api(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    // 网络层失败：最常见的原因是服务停了
    const err = new Error('连不上本地服务');
    err.hint = '服务可能已经停止了。重新启动工具（双击 启动.cmd）再试。';
    err.cause = e;
    throw err;
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.hint = (data && data.hint) || '';
    err.kind = (data && data.kind) || 'http';
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 把错误格式化成一行给用户看的话 */
export function formatError(err) {
  if (!err) return '未知错误';
  return err.hint ? `${err.message} —— ${err.hint}` : err.message;
}

/**
 * 建立 SSE 连接，接收服务端推送。
 *
 * 断线由浏览器自动重连（这是选 SSE 而不是 WebSocket 的原因之一），
 * 但重连后要重新拉一次全量状态 —— 断线期间的变化是收不到的。
 */
export function connectStream(handlers = {}) {
  const es = new EventSource('/api/stream');

  es.addEventListener('queue', (e) => handlers.queue && handlers.queue(JSON.parse(e.data)));
  es.addEventListener('progress', (e) => handlers.progress && handlers.progress(JSON.parse(e.data)));
  es.addEventListener('notice', (e) => handlers.notice && handlers.notice(JSON.parse(e.data)));
  es.addEventListener('settings', (e) => handlers.settings && handlers.settings(JSON.parse(e.data)));
  es.addEventListener('library', (e) => handlers.library && handlers.library(JSON.parse(e.data)));

  es.addEventListener('error', () => {
    if (handlers.disconnected) handlers.disconnected();
  });
  es.addEventListener('open', () => {
    if (handlers.connected) handlers.connected();
  });

  return es;
}
