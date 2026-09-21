/**
 * 队列面板：进行中的任务 + 最近任务历史。
 *
 * 两条渲染策略，**故意不一样**：
 *
 *  1. **进行中的任务**用「打补丁」而不是重建 DOM —— 进度每 400ms 推一次，
 *     整块重建会让进度条不停闪烁、按钮失去焦点、正在看的日志被折叠。
 *     这里只改变化的那几个节点。
 *
 *  2. **历史列表**整块重建 —— 它变化频率低（几百毫秒到几秒一次），
 *     重建的代码简单得多，不值当为它做补丁逻辑。
 *
 * 重构前这两条逻辑混在一个 280 行的 renderQueue/patchQueue 里，
 * 分不清哪段是补丁、哪段是重建。现在按"变化频率"拆开，规则就清楚了。
 */

import { api, formatError } from '../api.js';
import {
  $, $$, el, replace, clear, fmtBytes, fmtDuration, fmtEta, fmtSpeed, fmtDate,
  STATUS_LABEL, STATUS_TONE,
} from '../dom.js';
import { state, savePrefs } from '../state.js';
import { toast, confirmDialog } from '../ui.js';

export function initQueueView({ onPlay }) {
  $('#btnHistoryToggle').addEventListener('click', () => {
    const open = !state.prefs.historyOpen;
    savePrefs({ historyOpen: open });
    applyHistoryOpen(open);
  });
  applyHistoryOpen(state.prefs.historyOpen);

  // 批量操作
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (!btn) return;
    const action = btn.dataset.bulk;

    if (action === 'clearFinished') {
      // 说清"只清记录、不动文件"——用户最怕的就是误删视频
      const pick = await confirmDialog({
        title: '清空已完成记录',
        body: '这只会清掉列表里的记录，磁盘上的视频文件都会保留。',
        actions: [
          { label: '取消', value: null },
          { label: '清空记录（保留文件）', value: 'go', primary: true },
        ],
      });
      if (pick !== 'go') return;
    }

    btn.disabled = true;
    try {
      const r = await api('POST', '/api/queue/action', { action });
      toast(`已处理 ${r.affected} 个任务`, '');
      refreshQueue();
    } catch (err) {
      toast(formatError(err), 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  applyHistoryOpen(state.prefs.historyOpen);
}

function applyHistoryOpen(open) {
  const list = $('#historyList');
  const empty = $('#historyEmpty');
  $('#btnHistoryToggle').textContent = open ? '收起' : '展开';
  list.hidden = !open;
  if (!open) empty.hidden = true;
}

/** 拉一次队列快照（SSE 断了或刚打开页面时用） */
export async function refreshQueue() {
  try {
    const snap = await api('GET', `/api/queue?history=${state.prefs.historyOpen ? 50 : 20}`);
    state.queue = snap;
    renderQueue();
  } catch {
    setConnected(false);
  }
}

/** SSE 推来的增量：只更新受影响的那一条 */
export function onProgress(v) {
  const node = $(`#queueList [data-id="${v.id}"]`);
  if (node) {
    patchItem(node, v);
  } else {
    // 新任务出现在队列里 → 整块重排（顺序可能变）
    renderQueue();
  }
  // 历史里也可能有这条（刚结束）
  const h = $(`#historyList [data-id="${v.id}"]`);
  if (h) patchHistoryItem(h, v);
}

export function onQueueSnapshot(snap) {
  state.queue = { ...state.queue, ...snap };
  renderQueue();
}

// ---------------------------------------------------------------- 渲染

export function renderQueue() {
  const { running = [], history = [], counts = {} } = state.queue;
  renderActive(running);
  renderHistory(history, counts);
  updateTabCount(counts);
}

function renderActive(running) {
  const list = $('#queueList');
  const empty = $('#queueEmpty');

  if (!running.length) {
    empty.hidden = false;
    clear(list);
    return;
  }
  empty.hidden = true;

  // 已有节点尽量复用（按 id 对号），只增删差集 —— 避免整块重建导致的闪烁
  const existing = new Map($$('[data-id]', list).map((n) => [n.dataset.id, n]));
  const seen = new Set();

  for (const v of running) {
    const key = String(v.id);
    seen.add(key);
    let node = existing.get(key);
    if (!node) {
      node = buildItem(v);
      list.append(node);
    } else {
      patchItem(node, v);
    }
  }
  for (const [key, node] of existing) {
    if (!seen.has(key)) node.remove();
  }
}

/** 建一条队列项 */
function buildItem(v) {
  const node = el('div', { class: 'qitem', dataset: { id: v.id } }, [
    el('div', { class: 'qmain' }, [
      el('div', { class: 'qtitle' }, [
        el('span', { class: 'qname', text: v.title || '（解析中…）' }),
        el('span', { class: 'qbadge', 'data-role': 'status' }),
      ]),
      el('div', { class: 'qprogress' }, [
        el('div', { class: 'qbar', 'data-role': 'bar' }),
      ]),
      el('div', { class: 'qmeta', 'data-role': 'meta' }),
    ]),
    el('div', { class: 'qactions' }, [
      button('暂停', 'pause'), button('继续', 'resume'),
      button('取消', 'cancel'), button('看日志', 'log'),
      button('删除', 'delete', 'btn-danger'),
    ]),
  ]);
  patchItem(node, v);
  return node;
}

function button(label, action, extra = '') {
  return el('button', {
    class: `btn btn-sm ${extra}`,
    type: 'button',
    dataset: { action },
    text: label,
  });
}

/**
 * 只改变化的那几个节点。
 *
 * 注意：这里**不重建**任何子节点，只 setTextContent / setAttribute。
 * 重建会让进度条闪、按钮丢焦点。
 */
function patchItem(node, v) {
  const badge = node.querySelector('[data-role=status]');
  const bar = node.querySelector('[data-role=bar]');
  const meta = node.querySelector('[data-role=meta]');
  const name = node.querySelector('.qname');

  if (name.textContent !== (v.title || '（解析中…）')) {
    name.textContent = v.title || '（解析中…）';
  }

  const stage = v.stage || STATUS_LABEL[v.status] || v.status;
  badge.textContent = stage;
  badge.className = `qbadge tone-${STATUS_TONE[v.status] || 'muted'}`;

  const pct = Math.max(0, Math.min(100, Number(v.progress) || 0));
  bar.style.width = `${pct}%`;
  bar.className = `qbar tone-${STATUS_TONE[v.status] || 'muted'}`;

  const bits = [`${pct.toFixed(1)}%`];
  if (v.speed) bits.push(fmtSpeed(v.speed));
  if (v.eta) bits.push(fmtEta(v.eta));
  if (v.error) bits.push(v.error.slice(0, 120));
  const text = bits.join(' · ');
  if (meta.textContent !== text) {
    meta.textContent = text;
    meta.classList.toggle('is-error', Boolean(v.error));
  }

  // 暂停/继续按钮按状态启用
  const pause = node.querySelector('[data-action=pause]');
  const resume = node.querySelector('[data-action=resume]');
  const active = ['queued', 'parsing', 'downloading', 'processing'].includes(v.status);
  if (pause) pause.disabled = !active;
  if (resume) resume.disabled = active;
}

function patchHistoryItem(node, v) {
  const badge = node.querySelector('[data-role=status]');
  if (badge) {
    badge.textContent = STATUS_LABEL[v.status] || v.status;
    badge.className = `qbadge tone-${STATUS_TONE[v.status] || 'muted'}`;
  }
  const meta = node.querySelector('[data-role=meta]');
  if (meta && v.error) meta.textContent = v.error.slice(0, 160);
}

function renderHistory(history, counts) {
  const list = $('#historyList');
  const empty = $('#historyEmpty');
  const summary = $('#historySummary');

  const n = (k) => Number(counts[k] || 0);
  summary.textContent = `完成 ${n('done')} · 失败 ${n('failed')} · 暂停 ${n('paused')} · 取消 ${n('canceled')}`;

  if (!history.length) {
    empty.hidden = !state.prefs.historyOpen;
    empty.textContent = '还没有已结束的任务。';
    clear(list);
    return;
  }
  empty.hidden = true;

  // 历史整块重建：变化频率低，补丁逻辑不值得
  replace(list, history.map((v) => el('div', {
    class: 'qitem history', dataset: { id: v.id },
  }, [
    el('div', { class: 'qmain' }, [
      el('div', { class: 'qtitle' }, [
        el('span', { class: 'qname', text: v.title || v.url || '（无标题）' }),
        el('span', {
          class: `qbadge tone-${STATUS_TONE[v.status] || 'muted'}`,
          'data-role': 'status',
          text: STATUS_LABEL[v.status] || v.status,
        }),
      ]),
      el('div', { class: 'qmeta', 'data-role': 'meta', text: historyMeta(v) }),
    ]),
    el('div', { class: 'qactions' }, [
      v.status === 'done' && v.file_path
        ? el('button', { class: 'btn btn-sm', type: 'button', dataset: { action: 'play' }, text: '播放' })
        : null,
      el('button', { class: 'btn btn-sm', type: 'button', dataset: { action: 'resume' }, text: '重新下载' }),
      el('button', { class: 'btn btn-sm', type: 'button', dataset: { action: 'log' }, text: '看日志' }),
      el('button', { class: 'btn btn-sm btn-danger', type: 'button', dataset: { action: 'delete' }, text: '删除' }),
    ]),
  ])));
}

function historyMeta(v) {
  const bits = [];
  if (v.status === 'done') {
    if (v.file_size) bits.push(fmtBytes(v.file_size));
    if (v.duration) bits.push(fmtDuration(v.duration));
    if (v.height) bits.push(`${v.height}p`);
    if (v.container) bits.push(v.container);
  } else if (v.error) {
    bits.push(v.error.slice(0, 160));
  }
  if (v.finished_at) bits.push(fmtDate(v.finished_at));
  return bits.join(' · ') || '—';
}

function updateTabCount(counts) {
  const total = Number((counts && counts.done) || 0);
  $('#tabLibCount').textContent = String(total);
}

// ---------------------------------------------------------------- 单条动作

/** 队列里的按钮统一在这里处理（事件委托，避免每条都绑一遍） */
export function bindQueueActions({ onPlay, onViewLog, onDeleted }) {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const item = btn.closest('[data-id]');
    if (!item) return;

    const id = Number(item.dataset.id);
    const action = btn.dataset.action;
    if (!id) return;

    try {
      if (action === 'play') return onPlay(id);
      if (action === 'log') return onViewLog(id);

      if (action === 'delete') {
        // 默认「只从列表删掉」—— 下载好的视频来之不易，一个误点永久删掉是不可接受的
        const pick = await confirmDialog({
          title: '删除这条记录',
          body: '请选择删除方式。默认只删列表记录，磁盘上的文件保留。',
          actions: [
            { label: '取消', value: null },
            { label: '只从列表删掉（保留文件）', value: 'keep', primary: true },
            { label: '记录和文件一起永久删除', value: 'purge', tone: 'danger' },
          ],
        });
        if (!pick) return;

        if (pick === 'purge') {
          const again = await confirmDialog({
            title: '再确认一次',
            body: '这一步会**永久删除磁盘上的视频文件**，无法恢复。确定吗？',
            actions: [
              { label: '算了', value: null, primary: true },
              { label: '确定永久删除', value: 'yes', tone: 'danger' },
            ],
          });
          if (again !== 'yes') return;
        }
        await api('DELETE', `/api/videos/${id}?keepFile=${pick === 'keep' ? '1' : '0'}`);
        toast(pick === 'keep' ? '已从列表删除，文件保留' : '已删除记录和文件');
        if (onDeleted) onDeleted(id);
        refreshQueue();
        return;
      }

      // pause / resume / cancel
      const r = await api('POST', `/api/videos/${id}/action`, { action });
      if (r && r.ok === false) toast('这个操作当前不适用', 'warn');
    } catch (err) {
      toast(formatError(err), 'bad');
    }
  });
}

/** 看日志：弹一个小窗显示引擎原始输出 */
export async function showLog(id) {
  try {
    const r = await api('GET', `/api/videos/${id}/log`);
    const modal = $('#modal');
    replace(modal, el('div', { class: 'dialog dialog-wide' }, [
      el('h3', { text: `任务 ${id} 的引擎日志` }),
      el('pre', { class: 'logview', text: (r.lines || []).join('\n') || '（日志是空的）' }),
      el('div', { class: 'dialog-actions' }, [
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '关闭',
          onclick: () => { modal.hidden = true; },
        }),
      ]),
    ]));
    modal.hidden = false;
    modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; };
  } catch (err) {
    toast(formatError(err), 'bad');
  }
}

export function setConnected(up) {
  state.connected = up;
  const dot = $('#engineDot');
  const txt = $('#engineText');
  if (!up) {
    dot.className = 'dot dot-bad';
    txt.textContent = '与服务断开，正在重连…';
  }
}
