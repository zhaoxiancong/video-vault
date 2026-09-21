/**
 * 「我的库」页：搜索、筛选、网格/列表两种视图、播放入口。
 *
 * 筛选条件 persist 到 localStorage。理由很简单：用户筛到"某个 UP 主的、
 * 只看收藏"，刷新一下全归零，会很想打人。
 */

import { api, formatError } from '../api.js';
import {
  $, $$, el, replace, clear, fmtBytes, fmtDuration, fmtDate, debounce,
  STATUS_LABEL, STATUS_TONE,
} from '../dom.js';
import { state, savePrefs } from '../state.js';
import { toast, confirmDialog } from '../ui.js';

const PAGE = 60;

export function initLibraryView({ onPlay }) {
  const lib = state.prefs.library;

  // ---- 恢复筛选条件
  $('#libSearch').value = lib.q || '';
  $('#libStatus').value = lib.status || '';
  $('#libSort').value = lib.sort || 'created_desc';
  $('#libStarred').checked = Boolean(lib.starred);
  setLayout(lib.view || 'grid');

  // 搜索防抖：别每敲一个字打一次接口
  $('#libSearch').addEventListener('input', debounce(() => {
    savePrefs({ library: { q: $('#libSearch').value } });
    reload({ reset: true });
  }, 300));

  for (const [sel, key] of [['#libStatus', 'status'], ['#libSite', 'site'],
    ['#libUploader', 'uploader'], ['#libSort', 'sort']]) {
    $(sel).addEventListener('change', () => {
      savePrefs({ library: { [key]: $(sel).value } });
      reload({ reset: true });
    });
  }
  $('#libStarred').addEventListener('change', () => {
    savePrefs({ library: { starred: $('#libStarred').checked } });
    reload({ reset: true });
  });

  $('#libLayout').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-layout]');
    if (!btn) return;
    setLayout(btn.dataset.layout);
    savePrefs({ library: { view: btn.dataset.layout } });
  });

  $('#btnRefresh').addEventListener('click', () => reload({ reset: true }));

  $('#btnLoadMore').addEventListener('click', () => reload({ reset: false }));

  // 库里的动作（播放 / 收藏 / 备注 / 删除）走事件委托
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lib]');
    if (!btn) return;
    const card = btn.closest('[data-id]');
    if (!card) return;
    handleAction(btn.dataset.lib, Number(card.dataset.id), { onPlay, reload });
  });
}

function setLayout(view) {
  const grid = view !== 'list';
  $('#libGrid').hidden = !grid;
  $('#libList').hidden = grid;
  $$('#libLayout .seg-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.layout === (grid ? 'grid' : 'list'));
  });
}

/**
 * 拉数据。
 * @param {object} opts {reset:boolean} reset=true 回到第一页
 */
export async function reload({ reset = true } = {}) {
  const lib = state.prefs.library;
  const offset = reset ? 0 : state.library.rows.length;
  const qs = new URLSearchParams({
    q: lib.q || '', status: lib.status || '', site: lib.site || '',
    uploader: lib.uploader || '', sort: lib.sort || 'created_desc',
    limit: String(PAGE), offset: String(offset),
  });
  if (lib.starred) qs.set('starred', '1');

  try {
    const data = await api('GET', `/api/library?${qs}`);
    state.library = reset
      ? data
      : { total: data.total, rows: [...state.library.rows, ...data.rows] };
    renderLibrary();

    // 顺手刷一下筛选项（新下载的站点/作者要出现在下拉里）
    if (!state.facets || reset) await loadFacets();
  } catch (err) {
    toast(formatError(err), 'bad');
  }
}

async function loadFacets() {
  try {
    state.facets = await api('GET', '/api/facets');
    fillSelect('#libSite', state.facets.sites, state.prefs.library.site, '全部站点');
    fillSelect('#libUploader', state.facets.uploaders, state.prefs.library.uploader, '全部作者');
  } catch { /* 筛选项拿不到不影响主流程 */ }
}

function fillSelect(sel, rows, current, allLabel) {
  const node = $(sel);
  const opts = [el('option', { value: '', text: allLabel })];
  for (const r of rows || []) {
    opts.push(el('option', { value: r.v, text: `${r.v}（${r.n}）` }));
  }
  replace(node, opts);
  node.value = current || '';
}

export function renderLibrary() {
  const { rows, total } = state.library;
  const grid = $('#libGrid');
  const list = $('#libList');
  const empty = $('#libEmpty');

  $('#libStat').textContent = total ? `共 ${total} 条，显示 ${rows.length} 条` : '';

  if (!rows.length) {
    empty.hidden = false;
    clear(grid);
    clear(list);
    $('#loadMoreWrap').hidden = true;
    return;
  }
  empty.hidden = true;

  replace(grid, rows.map((v) => buildCard(v)));
  replace(list, rows.map((v) => buildRow(v)));
  $('#loadMoreWrap').hidden = rows.length >= total;
  setLayout(state.prefs.library.view || 'grid');
}

/** 缩略图节点：没有封面就放个占位（不要出现破图图标） */
function thumb(v, cls = 'card-thumb') {
  const hasLocal = Boolean(v.thumbnail_path);
  const hasRemote = Boolean(v.thumbnail_url);
  if (!hasLocal && !hasRemote) {
    return el('div', { class: `${cls} placeholder`, text: '无封面' });
  }
  return el('img', {
    class: cls,
    src: `/api/videos/${v.id}/thumb`,
    alt: '',
    loading: 'lazy',
    // 封面加载失败（外链失效等）就换成占位，别留一个破图
    onerror: (e) => {
      const ph = el('div', { class: `${cls} placeholder`, text: '无封面' });
      e.target.replaceWith(ph);
    },
  });
}

function buildCard(v) {
  return el('div', { class: 'card', dataset: { id: v.id } }, [
    el('div', { class: 'card-media' }, [
      thumb(v),
      v.duration ? el('span', { class: 'card-dur', text: fmtDuration(v.duration) }) : null,
      el('span', {
        class: `card-status tone-${STATUS_TONE[v.status] || 'muted'}`,
        text: STATUS_LABEL[v.status] || v.status,
      }),
    ]),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'card-title', title: v.title || '', text: v.title || '（无标题）' }),
      el('div', { class: 'card-sub', text: [v.uploader, v.site].filter(Boolean).join(' · ') || '—' }),
      el('div', { class: 'card-meta', text: [
        v.height ? `${v.height}p` : null,
        v.file_size ? fmtBytes(v.file_size) : null,
        fmtDate(v.created_at),
      ].filter(Boolean).join(' · ') }),
    ]),
    el('div', { class: 'card-actions' }, [
      v.status === 'done' && v.file_path
        ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', dataset: { lib: 'play' }, text: '播放' })
        : null,
      el('button', {
        class: 'btn btn-sm', type: 'button', dataset: { lib: 'star' },
        text: v.starred ? '★' : '☆', title: v.starred ? '取消收藏' : '收藏',
      }),
      el('button', { class: 'btn btn-sm', type: 'button', dataset: { lib: 'more' }, text: '更多' }),
    ]),
  ]);
}

function buildRow(v) {
  return el('div', { class: 'lrow', dataset: { id: v.id } }, [
    thumb(v, 'lrow-thumb'),
    el('div', { class: 'lrow-main' }, [
      el('div', { class: 'lrow-title', text: v.title || '（无标题）' }),
      el('div', { class: 'lrow-sub', text: [v.uploader, v.site].filter(Boolean).join(' · ') || '—' }),
    ]),
    el('div', { class: 'lrow-col', text: v.height ? `${v.height}p` : '—' }),
    el('div', { class: 'lrow-col', text: fmtBytes(v.file_size) }),
    el('div', { class: 'lrow-col', text: fmtDuration(v.duration) }),
    el('div', { class: 'lrow-col status' }, [
      el('span', {
        class: `qbadge tone-${STATUS_TONE[v.status] || 'muted'}`,
        text: STATUS_LABEL[v.status] || v.status,
      }),
    ]),
    // `wide` 是给日期列的：'2026-09-21 00:49' 比其它列长得多，窄了会被截断
    el('div', { class: 'lrow-col wide', text: fmtDate(v.created_at) }),
    el('div', { class: 'lrow-actions' }, [
      v.status === 'done' && v.file_path
        ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', dataset: { lib: 'play' }, text: '播放' })
        : null,
      el('button', {
        class: 'btn btn-sm', type: 'button', dataset: { lib: 'star' },
        text: v.starred ? '★' : '☆',
      }),
      el('button', { class: 'btn btn-sm', type: 'button', dataset: { lib: 'more' }, text: '更多' }),
    ]),
  ]);
}

// ---------------------------------------------------------------- 单条动作

async function handleAction(action, id, { onPlay, reload: reloadFn }) {
  const v = state.library.rows.find((r) => r.id === id);
  if (!v) return;

  try {
    if (action === 'play') return onPlay(id);

    if (action === 'star') {
      const res = await api('POST', `/api/videos/${id}/action`, { action: 'star' });
      /**
       * ⚠️ 服务端返回的是**权威值**，必须用它，不能在本地 `!v.starred` 翻转。
       *
       * 踩过的坑（用户报"收藏按钮点了没反应"）：本地那个 `v.starred` 可能**已经过期**
       * （别的页面/别的操作改过它），于是"本地翻转"和"服务端翻转"方向相反：
       * 服务端把它 false→true 并存库，本地却基于旧值又翻一次
       * （以为在翻转，实际是把 true 写回 false），紧接着 SSE 推来服务端的 true
       * 再把它翻回去 —— 5ms 内翻了两次，**净效果为零**，
       * 用户看到的就是"没反应"，而数据库里其实已经改了（界面与库不一致）。
       *
       * 用服务端返回值就没有这个问题：它不依赖本地状态，也不会出现双重翻转。
       */
      const fresh = res && res.video ? res.video : null;
      if (fresh && typeof fresh.starred === 'boolean') v.starred = fresh.starred;
      else v.starred = !v.starred;   // 万一服务端没回，退回乐观翻转
      renderLibrary();
      return;
    }

    if (action === 'more') return showMore(v, { onPlay, reload: reloadFn });
  } catch (err) {
    toast(formatError(err), 'bad');
  }
}

/** 「更多」菜单：备注、复制路径、复制链接、删除 */
async function showMore(v, { onPlay, reload: reloadFn }) {
  const modal = $('#modal');
  const close = () => { modal.hidden = true; };

  const body = el('div', { class: 'more-panel' }, [
    el('div', { class: 'more-meta' }, [
      el('div', { class: 'more-title', text: v.title || '（无标题）' }),
      el('div', { class: 'more-sub', text: [v.site, v.uploader, v.height ? `${v.height}p` : null,
        v.file_size ? fmtBytes(v.file_size) : null].filter(Boolean).join(' · ') }),
      v.file_path ? el('code', { class: 'more-path', text: v.file_path }) : null,
      v.error ? el('div', { class: 'more-error', text: v.error }) : null,
    ]),

    el('div', { class: 'more-group' }, [
      el('h4', { text: '备注' }),
      el('textarea', { id: 'noteBox', rows: 3, placeholder: '记点什么，比如"这段讲得好"', text: v.notes || '' }),
      el('button', {
        class: 'btn btn-sm', type: 'button', text: '保存备注',
        onclick: async () => {
          try {
            await api('POST', `/api/videos/${v.id}/action`, { action: 'notes', notes: $('#noteBox').value });
            toast('备注已保存');
            close();
          } catch (err) { toast(formatError(err), 'bad'); }
        },
      }),
    ]),

    el('div', { class: 'more-group' }, [
      el('h4', { text: '其它' }),
      el('div', { class: 'more-btns' }, [
        v.file_path ? el('button', {
          class: 'btn btn-sm', type: 'button', text: '复制文件路径',
          onclick: async () => {
            try { await navigator.clipboard.writeText(v.file_path); toast('路径已复制'); }
            catch { toast('复制失败，浏览器不允许', 'bad'); }
          },
        }) : null,
        el('button', {
          class: 'btn btn-sm', type: 'button', text: '复制原始链接',
          onclick: async () => {
            try { await navigator.clipboard.writeText(v.url); toast('链接已复制'); }
            catch { toast('复制失败，浏览器不允许', 'bad'); }
          },
        }),
        el('button', {
          class: 'btn btn-sm btn-danger', type: 'button', text: '删除记录',
          onclick: async () => {
            close();
            const pick = await confirmDialog({
              title: '删除这条记录',
              body: '默认只删列表记录，磁盘上的文件保留。',
              actions: [
                { label: '取消', value: null },
                { label: '只从列表删掉（保留文件）', value: 'keep', primary: true },
                { label: '记录和文件一起永久删除', value: 'purge', tone: 'danger' },
              ],
            });
            if (!pick) return;
            try {
              await api('DELETE', `/api/videos/${v.id}?keepFile=${pick === 'keep' ? '1' : '0'}`);
              toast(pick === 'keep' ? '已从列表删除，文件保留' : '已删除记录和文件');
              reloadFn({ reset: true });
            } catch (err) { toast(formatError(err), 'bad'); }
          },
        }),
      ]),
    ]),
  ]);

  replace(modal, el('div', { class: 'dialog dialog-wide' }, [
    el('h3', { text: '更多操作' }),
    body,
    el('div', { class: 'dialog-actions' }, [
      el('button', { class: 'btn btn-primary', type: 'button', text: '关闭', onclick: close }),
    ]),
  ]));
  modal.hidden = false;
  modal.onclick = (e) => { if (e.target === modal) close(); };
}
