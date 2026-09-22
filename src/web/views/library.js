/**
 * 「我的库」页：搜索、筛选、网格/列表两种视图、分组展示、多选批量操作、播放入口。
 *
 * 筛选与展示偏好 persist 到 localStorage。理由很简单：用户筛到"某个 UP 主的、
 * 只看收藏"，刷新一下全归零，会很想打人。
 *
 * ⚠️ 两种"分组"要分清，别混：
 *   · **展示维度**（`prefs.library.by`）：`''` / `'site'` / `'group'` —— 决定列表**怎么分段**
 *   · **快捷筛选**（`prefs.library.onlyGroup`）：只看**某一个**自定义分组
 *   它们互不冲突（可以"按站点分段"同时"只看：待看"）。
 */

import { api, formatError } from '../api.js';
import {
  $, $$, el, replace, clear, fmtBytes, fmtDuration, fmtDate, debounce,
  STATUS_LABEL, STATUS_TONE,
} from '../dom.js';
import { state, savePrefs } from '../state.js';
import { toast, confirmDialog } from '../ui.js';

const PAGE = 60;

/**
 * 多选状态。**只在内存里**，换筛选/换分组维度就清空 ——
 * 否则会出现"选中的东西在当前视图里看不见了"，那种状态最容易误操作。
 */
const picked = new Set();

export function initLibraryView({ onPlay }) {
  const lib = state.prefs.library;

  // ---- 恢复筛选条件
  $('#libSearch').value = lib.q || '';
  $('#libStatus').value = lib.status || '';
  $('#libSort').value = lib.sort || 'created_desc';
  $('#libStarred').checked = Boolean(lib.starred);
  $('#libGroupBy').value = lib.by || '';
  $('#libMulti').checked = Boolean(lib.multi);
  setLayout(lib.view || 'grid');

  // 搜索防抖：别每敲一个字打一次接口
  $('#libSearch').addEventListener('input', debounce(() => {
    savePrefs({ library: { q: $('#libSearch').value } });
    clearPicked();
    reload({ reset: true });
  }, 300));

  for (const [sel, key] of [['#libStatus', 'status'], ['#libSite', 'site'],
    ['#libUploader', 'uploader'], ['#libSort', 'sort']]) {
    $(sel).addEventListener('change', () => {
      savePrefs({ library: { [key]: $(sel).value } });
      clearPicked();
      reload({ reset: true });
    });
  }
  $('#libStarred').addEventListener('change', () => {
    savePrefs({ library: { starred: $('#libStarred').checked } });
    clearPicked();
    reload({ reset: true });
  });

  // 展示维度：切换后重新分组，所以必须先清掉多选
  $('#libGroupBy').addEventListener('change', () => {
    savePrefs({ library: { by: $('#libGroupBy').value } });
    clearPicked();
    reload({ reset: true });
  });

  $('#libMulti').addEventListener('change', () => {
    savePrefs({ library: { multi: $('#libMulti').checked } });
    clearPicked();
    renderLibrary();
  });

  $('#libOnlyGroup').addEventListener('change', () => {
    savePrefs({ library: { onlyGroup: $('#libOnlyGroup').value } });
    clearPicked();
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

  // 分组标题折叠也走委托（分组是动态渲染的，不能逐个挂监听）
  document.addEventListener('click', (e) => {
    const head = e.target.closest('[data-grp]');
    if (!head) return;
    toggleGroup(head.dataset.grp);
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
  const base = {
    q: lib.q || '', status: lib.status || '', site: lib.site || '',
    uploader: lib.uploader || '', sort: lib.sort || 'created_desc',
  };

  try {
    if (lib.by) {
      /**
       * 分组模式：**走服务端分组、忽略分页**。
       * 分组名后的条数必须是全量条数 —— 前端分页只拿得到当前页，
       * 自己归并出来的数字只能是"这一页里有多少条"，那是错的。
       */
      const qs = new URLSearchParams({ ...base, by: lib.by });
      if (lib.starred) qs.set('starred', '1');
      const data = await api('GET', `/api/library/grouped?${qs}`);
      state.library = { grouped: data, rows: [], total: data.total };
    } else {
      const qs = new URLSearchParams({ ...base, limit: String(PAGE), offset: String(offset) });
      if (lib.starred) qs.set('starred', '1');
      const data = await api('GET', `/api/library?${qs}`);
      state.library = reset
        ? { ...data, grouped: null }
        : { total: data.total, rows: [...state.library.rows, ...data.rows], grouped: null };
    }
    renderLibrary();

    // 顺手刷一下筛选项（新下载的站点/作者要出现在下拉里）
    if (!state.facets || reset) await loadFacets();
    if (reset || !state.groups) await loadGroups();
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

/**
 * 自定义分组清单（下拉要用，**含 0 条的** —— 刚建的空分组如果"消失"，
 * 用户会以为没建成）。
 */
export async function loadGroups() {
  try {
    state.groups = (await api('GET', '/api/groups')).groups || [];
  } catch {
    state.groups = [];
  }
  const sel = $('#libOnlyGroup');
  const opts = [el('option', { value: '', text: '只看：全部分组' })];
  for (const g of state.groups) {
    opts.push(el('option', { value: String(g.id), text: `只看：${g.name}（${g.count}）` }));
  }
  replace(sel, opts);
  sel.value = state.prefs.library.onlyGroup || '';
  // 一个自定义分组都没有时这一项没意义，藏起来（但"＋新建"入口要留着）
  sel.hidden = state.groups.length === 0;
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

// ---------------------------------------------------------------- 折叠状态

/**
 * 哪些分组是收起的。存 localStorage（`prefs.library.collapsed`）——
 * 这是**显示偏好，不是数据**，不该写进库。
 */
function collapsedMap() {
  const lib = state.prefs.library;
  if (!lib.collapsed || typeof lib.collapsed !== 'object') lib.collapsed = {};
  return lib.collapsed;
}

function toggleGroup(key) {
  const map = collapsedMap();
  if (map[key]) delete map[key]; else map[key] = true;
  savePrefs({ library: { collapsed: map } });
  renderLibrary();
}

// ---------------------------------------------------------------- 多选

function clearPicked() {
  picked.clear();
}

export function renderLibrary() {
  const lib = state.prefs.library;
  const grid = $('#libGrid');
  const list = $('#libList');
  const empty = $('#libEmpty');

  // ---- 分组模式：服务端已经分好了，这里只负责画
  if (lib.by && state.library.grouped) {
    const g = state.library.grouped;
    $('#libStat').textContent = g.truncated
      ? `共 ${g.total} 条 · 只分组了前 ${g.cap} 条`
      : `共 ${g.total} 条 · ${g.groups.length} 个分组`;
    // 已经全量拿回来了，不该再给"加载更多"
    $('#loadMoreWrap').hidden = true;
    empty.hidden = g.groups.length > 0;
    replace(grid, g.groups.map((grp) => buildGroup(grp, lib.view || 'grid')));
    replace(list, []);
    setLayout(lib.view || 'grid');
    renderBulkBar();
    return;
  }

  // ---- 平铺模式
  const { rows, total } = state.library;
  $('#libStat').textContent = total ? `共 ${total} 条，显示 ${rows.length} 条` : '';

  if (!rows.length) {
    empty.hidden = false;
    clear(grid);
    clear(list);
    $('#loadMoreWrap').hidden = true;
    renderBulkBar();
    return;
  }
  empty.hidden = true;

  replace(grid, rows.map((v) => buildCard(v)));
  replace(list, rows.map((v) => buildRow(v)));
  $('#loadMoreWrap').hidden = rows.length >= total;
  setLayout(lib.view || 'grid');
  renderBulkBar();
}

/** 一个分组段：可折叠的标题 + 内容 */
function buildGroup(g, view) {
  const collapsed = Boolean(collapsedMap()[g.key]);

  const body = el('div', { class: 'grp-body', hidden: collapsed });
  if (!g.rows.length) {
    body.append(el('div', { class: 'grp-empty', text: '这个分组还是空的' }));
  } else if (view === 'list') {
    for (const row of g.rows) body.append(buildRow(row));
  } else {
    const inner = el('div', { class: 'grid' });
    for (const row of g.rows) inner.append(buildCard(row));
    body.append(inner);
  }

  return el('div', { class: 'grp' }, [
    el('div', { class: 'grp-head', dataset: { grp: g.key } }, [
      el('span', { class: 'grp-caret', text: collapsed ? '▶' : '▼' }),
      g.color ? el('span', { class: `grp-dot c-${g.color}` }) : null,
      el('span', { class: 'grp-name', text: g.name }),
      el('span', { class: 'grp-count', text: String(g.count) }),
    ]),
    body,
  ]);
}

/** 多选模式下的勾选框；不在多选模式时返回 null（调用方直接放进 children，null 会被忽略） */
function pickBox(v) {
  if (!$('#libMulti').checked) return null;
  const box = el('input', {
    type: 'checkbox',
    class: 'pick',
    dataset: { pick: String(v.id) },
    'aria-label': `选择 ${v.title || v.url}`,
  });
  box.checked = picked.has(v.id);
  box.addEventListener('change', () => {
    if (box.checked) picked.add(v.id); else picked.delete(v.id);
    renderBulkBar();
  });
  return box;
}

/**
 * 多选工具栏：**只在多选模式且有选中时出现**。
 * 用 textContent 建节点（不拼 innerHTML），跟这个文件其它地方一致。
 */
function renderBulkBar() {
  const bar = $('#libBulkBar');
  if (!$('#libMulti').checked || !picked.size) {
    bar.hidden = true;
    clear(bar);
    return;
  }

  const opts = [el('option', { value: '', text: '加入分组…' })];
  for (const g of state.groups || []) {
    opts.push(el('option', { value: String(g.id), text: g.name }));
  }
  const sel = el('select', { class: 'bulk-pick' }, opts);
  sel.addEventListener('change', () => { if (sel.value) bulkGroupAdd(Number(sel.value)); });

  replace(bar, [
    el('span', { class: 'bulk-count', text: `已选 ${picked.size} 条` }),
    sel,
    el('button', { class: 'btn btn-sm', type: 'button', text: '收藏', onclick: () => bulkStar('star') }),
    el('button', { class: 'btn btn-sm', type: 'button', text: '取消收藏', onclick: () => bulkStar('unstar') }),
    el('button', {
      class: 'btn btn-sm', type: 'button', text: '取消选择',
      onclick: () => { clearPicked(); renderLibrary(); },
    }),
  ]);
  bar.hidden = false;
}

async function bulkGroupAdd(groupId) {
  try {
    const r = await api('POST', '/api/videos/group-action', { ids: [...picked], add: [groupId] });
    const skipped = (r.errors || []).length;
    toast(`已加入 ${r.added} 条${skipped ? `（${skipped} 条被跳过）` : ''}`);
    clearPicked();
    await loadGroups();
    await reload({ reset: true });
  } catch (err) {
    toast(formatError(err), 'bad');
  }
}

/** 批量收藏：**一次请求**，不是循环发 N 个 */
async function bulkStar(action) {
  try {
    const r = await api('POST', '/api/videos/bulk-action', { ids: [...picked], action });
    toast(action === 'star' ? `已收藏 ${r.affected} 条` : `已取消收藏 ${r.affected} 条`);
    clearPicked();
    await reload({ reset: true });
  } catch (err) {
    toast(formatError(err), 'bad');
  }
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
      pickBox(v),
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
  // 只调一次：pickBox 会挂 change 监听，调两次就挂两个（重复处理同一次勾选）
  const box = pickBox(v);
  return el('div', { class: 'lrow', dataset: { id: v.id } }, [
    box ? el('label', { class: 'pick-wrap' }, [box]) : null,
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
  // 分组模式下 rows 是空的，视频在 groups[].rows 里 —— 两处都要能找到
  const v = state.library.rows.find((r) => r.id === id)
    || (state.library.grouped
      ? state.library.grouped.groups.flatMap((g) => g.rows).find((r) => r.id === id)
      : null);
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
