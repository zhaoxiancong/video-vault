/**
 * 通用小工具：格式化、DOM 取值、事件绑定。
 *
 * 这个模块里最重要的一条是 `esc()` 和 `el()` 的存在理由：
 *
 *   **绝不把用户/引擎来的文本拼进 innerHTML。**
 *
 * 这个项目踩过两次同类的坑：
 *   1. 提示文案里写了 Markdown 的 `**粗体**`，前端用 textContent 显示，
 *      星号原样露出来了 —— 因为当时忘了"前端不解析 Markdown"这件事。
 *   2. 引擎的原始报错里可能带尖括号（`<...>`），拼进 HTML 会被吃掉或注入。
 *
 * 所以约定：**需要插值的文本，一律用 el()/textContent 建节点。**
 * `esc()` 只留给"确实要拼 HTML 字符串"的少数地方（比如图标），
 * 而且它必须保持严格。
 */

/** HTML 转义。只在不得不拼 HTML 时用 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `$('#id')` —— 少打几个字 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * 建 DOM 节点。文本一律走 textContent，天然免疫注入。
 *
 *   el('div', {class:'row'}, [el('span', {}, '标题')])
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;          // 调用方自负责任
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** 清空一个节点（比 innerHTML='' 更明确，也不会触发重解析） */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 替换节点的全部内容 */
export function replace(node, children) {
  clear(node);
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ---------------------------------------------------------------- 格式化

export function fmtBytes(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function fmtSpeed(n) {
  if (!n) return '';
  return `${fmtBytes(n)}/s`;
}

export function fmtDuration(sec) {
  if (!sec && sec !== 0) return '—';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

export function fmtEta(sec) {
  if (!sec && sec !== 0) return '';
  if (sec < 60) return `剩 ${Math.round(sec)} 秒`;
  if (sec < 3600) return `剩 ${Math.round(sec / 60)} 分`;
  return `剩 ${(sec / 3600).toFixed(1)} 小时`;
}

export function fmtDate(s) {
  if (!s) return '—';
  // 服务端存的是 'YYYY-MM-DD HH:MM:SS' 本地时间，直接显示，别做时区转换
  return String(s).replace('T', ' ').slice(0, 16);
}

/** 状态 → 界面文案与配色 */
export const STATUS_LABEL = {
  queued: '排队中',
  parsing: '解析中',
  downloading: '下载中',
  processing: '处理中',
  done: '已完成',
  failed: '失败',
  paused: '已暂停',
  canceled: '已取消',
};

export const STATUS_TONE = {
  done: 'ok',
  failed: 'bad',
  paused: 'warn',
  canceled: 'muted',
  downloading: 'active',
  processing: 'active',
  parsing: 'active',
  queued: 'muted',
};

/** 防抖：输入框搜索用，别每敲一个字就打一次接口 */
export function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** 只允许在本地存储里存 JSON（LocalStorage 会抛，比如隐私模式下配额为 0） */
export function safeStorage(key, value) {
  try {
    if (value === undefined) {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }
    localStorage.setItem(key, JSON.stringify(value));
    return value;
  } catch {
    return null;   // 存不了就算了，不能因为偏好存不下就让界面挂掉
  }
}
