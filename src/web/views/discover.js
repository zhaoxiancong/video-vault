/**
 * 「找视频」页：粘网址 → 抓取 → 关键字筛选 → 勾选入队。
 *
 * 两个刻意的设计：
 *
 * 1. **关键字是纯本地过滤**（复用 `app/crawl-parse.js` 的 filterCandidates）。
 *    不重新请求网络，所以敲字是即时响应的；而且筛选规则只有一份实现，
 *    前端与后端不会各写一套然后慢慢漂移。
 *
 * 2. **翻页 = 用那个地址再抓一次**（spec 3.5）。不替换当前结果，
 *    所以"第 1 页"和"第 2 页"的候选都在库里，可以来回挑。
 *
 * 所有文本走 textContent（`el()` 天然如此）—— 候选标题来自别人家的网页，
 * 里面完全可能有尖括号。
 */

import { api, formatError } from '../api.js';
import { $, $$, el, replace, fmtDuration, fmtDate } from '../dom.js';
import { state, savePrefs } from '../state.js';
import { toast } from '../ui.js';

const PAGE = 200;

/**
 * 关键字筛选（本地）。
 *
 * ⚠️ 为什么不 import 后端的 `src/app/crawl-parse.js`：
 *    静态服务的根是 `src/web/`，浏览器**取不到** `src/app/` 下的文件
 *    （而且那是 CommonJS，浏览器也不认）。
 *
 * ⚠️ 为什么选"再写一份小实现"而不是"加个接口让后端筛"：
 *    本地过滤才能做到敲字即时响应（不重新请求）。代价是规则有两份实现 ——
 *    所以这里**刻意保持精简**，只保留"空格分词 = AND、-词 = 排除"，
 *    与后端 `filterCandidates` 同名同语义，改一处务必改另一处。
 *    后端的 `/api/candidates?q=` 也走同一套语义（给刷新页面用）。
 */
function filterCandidates(items, query) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query == null ? '' : query).trim();
  if (!q) return list.slice();

  const include = [];
  const exclude = [];
  for (const t of q.split(/\s+/).filter(Boolean)) {
    if (t.length > 1 && t.startsWith('-')) exclude.push(t.slice(1).toLowerCase());
    else if (t !== '-') include.push(t.toLowerCase());
  }

  return list.filter((it) => {
    const title = String((it && it.title) || '').toLowerCase();
    if (include.some((t) => !title.includes(t))) return false;
    if (exclude.some((t) => title.includes(t))) return false;
    return true;
  });
}

/** 当前页面上的候选（本地过滤就作用在这上面） */
let rows = [];
let total = 0;
let offset = 0;
let currentRunId = null;
/** 勾选状态：id → true。翻页/重抓会清空 */
const picked = new Set();

export function initDiscoverView() {
  const saved = state.prefs.discover || {};
  if (saved.url) $('#discUrl').value = saved.url;
  $('#discOnlyNew').checked = Boolean(saved.onlyNew);

  $('#btnCrawl').addEventListener('click', () => startCrawl());
  $('#discUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startCrawl();
  });
  // 关键字筛选是**本地**的，所以不需要防抖请求
  $('#discFilter').addEventListener('input', () => renderList());
  $('#discOnlyNew').addEventListener('change', () => {
    savePrefs({ discover: { ...(state.prefs.discover || {}), onlyNew: $('#discOnlyNew').checked } });
    loadCandidates({ reset: true });
  });
  $('#btnDiscRefresh').addEventListener('click', () => loadCandidates({ reset: true }));
  $('#btnDiscAdd').addEventListener('click', () => addPicked());
  $('#btnDiscMore').addEventListener('click', () => loadCandidates({ reset: false }));

  // 翻页按钮是动态生成的，用事件委托
  $('#discPaging').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page-url]');
    if (btn) startCrawl(btn.dataset.pageUrl);
  });

  // 打开页面时把已有的候选拉出来（服务端持久化过，关掉浏览器也在）
  loadCandidates({ reset: true });
}

/** 界面用：被 SSE 或别处调用 */
export function onCrawlEvent(e) {
  if (!e) return;
  if (e.status === 'running') {
    showStatus(`正在抓取…${e.url ? `（${e.url}）` : ''}`);
    return;
  }
  if (e.status === 'failed') {
    showStatus(`${e.error || '抓取失败'}${e.hint ? ` —— ${e.hint}` : ''}`, 'bad');
    toast(e.error || '抓取失败', 'bad');
    return;
  }
  // done：候选已经入库了，直接重新拉
  loadCandidates({ reset: true });
}

// ---------------------------------------------------------------- 抓取

async function startCrawl(urlOverride) {
  const url = (urlOverride || $('#discUrl').value || '').trim();
  if (!url) {
    toast('先粘一个网址进来', 'bad');
    $('#discUrl').focus();
    return;
  }
  if (urlOverride) $('#discUrl').value = urlOverride;
  savePrefs({ discover: { ...(state.prefs.discover || {}), url } });

  const btn = $('#btnCrawl');
  btn.disabled = true;
  btn.textContent = '抓取中…';
  showStatus('正在抓取…（先试 yt-dlp，不行就解析页面）');

  try {
    const r = await api('POST', '/api/crawl', { url });

    if (r.status === 'running') {
      // 202：超过 20 秒转后台了，进度走 SSE
      showStatus('这个站有点慢，已转后台继续抓 —— 结果出来会自动显示。');
      return;
    }

    currentRunId = r.runId;
    showStatus(describeResult(r));
    showPaging(r.paging || []);
    picked.clear();
    await loadCandidates({ reset: true, runId: r.runId });
  } catch (err) {
    showStatus(formatError(err), 'bad');
    toast(formatError(err), 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = '从网站找';
  }
}

/** 把爬取结果翻译成一句人话 —— 走了哪条路是用户判断"为什么没缩略图"的依据 */
function describeResult(r) {
  const where = r.path === 'ytdlp' ? 'yt-dlp 解析' : '页面解析';
  const bits = [`走了 ${where}`, `找到 ${r.itemCount} 条`];
  if (r.title) bits.push(r.title);
  if (r.note) bits.push(r.note);
  return bits.join(' · ');
}

function showStatus(text, tone = '') {
  const box = $('#discStatus');
  replace(box, el('span', { text }));
  box.className = `disc-status${tone ? ` ${tone}` : ''}`;
  box.hidden = false;
}

function showPaging(paging) {
  const box = $('#discPaging');
  if (!paging || !paging.length) {
    box.hidden = true;
    replace(box, []);
    return;
  }
  replace(box, [
    el('span', { class: 'disc-paging-label', text: '翻页：' }),
    ...paging.map((p) => el('button', {
      class: 'btn btn-sm',
      type: 'button',
      dataset: { pageUrl: p.url },
      text: p.label,
      title: p.url,
    })),
  ]);
  box.hidden = false;
}

// ---------------------------------------------------------------- 候选列表

async function loadCandidates({ reset = true, runId = undefined } = {}) {
  if (reset) offset = 0;
  const qs = new URLSearchParams({
    limit: String(PAGE),
    offset: String(offset),
  });
  if (runId !== undefined && runId !== null) qs.set('runId', String(runId));
  else if (currentRunId) qs.set('runId', String(currentRunId));
  if ($('#discOnlyNew').checked) qs.set('onlyNew', '1');

  try {
    const data = await api('GET', `/api/candidates?${qs}`);
    rows = reset ? data.rows : [...rows, ...data.rows];
    total = data.total;
    offset = rows.length;
    renderList();
  } catch (err) {
    // 候选拉不到不该把页面搞崩：给一句提示就够了
    showStatus(`候选列表读取失败：${formatError(err)}`, 'bad');
  }
}

export function renderList() {
  const list = $('#discList');
  const panel = $('#discListPanel');
  const empty = $('#discEmpty');

  const visible = filterCandidates(rows, $('#discFilter').value);
  $('#discCount').textContent = `共 ${total} 条，当前显示 ${visible.length} 条`;
  $('#discMoreWrap').hidden = rows.length >= total;

  if (!rows.length) {
    panel.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  panel.hidden = false;

  replace(list, visible.map((c) => buildRow(c)));
  updateAddButton();
}

function buildRow(c) {
  const dur = c.duration_sec == null
    ? '?'
    : fmtDuration(c.duration_sec);   // 时长缺失显示 ?，不是 0:00

  const tag = c.added
    ? el('span', { class: 'disc-tag ok', text: '已加入队列' })
    : (c.in_library
      ? el('span', { class: 'disc-tag muted', text: '已在库' })
      : el('span', { class: 'disc-tag new', text: '＋新' }));

  const box = el('input', {
    type: 'checkbox',
    class: 'disc-pick',
    dataset: { pick: String(c.id) },
    'aria-label': `选择 ${c.title || c.url}`,
  });
  box.checked = picked.has(c.id);
  box.addEventListener('change', () => {
    if (box.checked) picked.add(c.id); else picked.delete(c.id);
    updateAddButton();
  });

  return el('div', { class: 'disc-row', dataset: { id: String(c.id) } }, [
    el('label', { class: 'disc-check' }, [box]),
    el('span', { class: 'disc-dur', text: dur }),
    el('div', { class: 'disc-main' }, [
      el('div', { class: 'disc-title', text: c.title || c.url, title: c.title || '' }),
      el('div', { class: 'disc-url', text: c.url }),
    ]),
    el('div', { class: 'disc-meta' }, [
      tag,
      el('span', { class: 'disc-date', text: fmtDate(c.created_at) }),
    ]),
  ]);
}

function updateAddButton() {
  const btn = $('#btnDiscAdd');
  const n = picked.size;
  btn.disabled = n === 0;
  btn.textContent = n ? `加入下载队列（${n}）` : '加入下载队列';
}

// ---------------------------------------------------------------- 入队

async function addPicked() {
  const ids = [...picked];
  if (!ids.length) return;

  const btn = $('#btnDiscAdd');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/candidates/action', { action: 'add', ids });
    const parts = [`已加入 ${r.added} 个`];
    if (r.skipped) parts.push(`跳过 ${r.skipped} 个（库里已有）`);
    if (r.retried) parts.push(`重新排队 ${r.retried} 个`);
    if (r.errors && r.errors.length) parts.push(`出错 ${r.errors.length} 个`);
    toast(parts.join(' · '), r.errors && r.errors.length ? 'warn' : '');

    picked.clear();
    // 重新拉：入队后 in_library / added 都变了，界面要跟着变
    await loadCandidates({ reset: true });
  } catch (err) {
    toast(formatError(err), 'bad');
  } finally {
    updateAddButton();
  }
}
