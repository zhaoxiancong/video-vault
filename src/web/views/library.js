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

  // 工具栏的「全选」：作用于本屏看得见的那些（含分组模式下的所有分组）
  $('#libPickAll').addEventListener('change', () => {
    if ($('#libPickAll').checked) selectAllVisible();
    else clearVisible();
  });

  $('#libOnlyGroup').addEventListener('change', () => {
    savePrefs({ library: { onlyGroup: $('#libOnlyGroup').value } });
    clearPicked();
    reload({ reset: true });
  });

  $('#libLayout').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-layout]');
    if (!btn) return;
    savePrefs({ library: { view: btn.dataset.layout } });
    /**
     * ⚠️ 必须**重绘**，不能只切 hidden。
     *
     * 分组模式下内容是画进"当前视图对应的那个容器"的，所以换视图 = 内容要搬家。
     * 原来这里只切显隐，于是"先开分组再点列表"会白屏 ——
     * 内容还留在被隐藏的 #libGrid 里，而 #libList 是空的。
     * （另一半原因是分组分支曾经无条件画进 #libGrid，两处一起才构成白屏。）
     */
    renderLibrary();
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

  /** 键盘：Enter / Space 折叠（配合 grp-head 上的 role=button + tabindex） */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const head = e.target && e.target.closest ? e.target.closest('[data-grp]') : null;
    if (!head) return;
    // Space 默认会滚动页面，得拦一下，否则"按空格折叠"会顺手把页面滚走
    if (e.preventDefault) e.preventDefault();
    toggleGroup(head.dataset.grp);
  });

  $('#btnNewGroup').addEventListener('click', () => showGroupEditor(null));
  $('#btnManageGroups').addEventListener('click', () => showGroupManager());
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

  /**
   * 重置式刷新时**清掉选中**。
   *
   * 放在这里而不是只放在筛选控件的回调里：`reload({reset:true})` 是"数据换了"的
   * 统一信号，批量删除之后、别处删了记录之后也走它。不清的话批量条还写着
   * "已选 3 条"，再点一次收藏会打到已经不存在的 id 上（后端能容忍，
   * 但提示会是"影响了 0 条"，很让人困惑）。
   */
  if (reset) clearPicked();

  try {
    /**
     * 「只看某个分组」是**服务端筛选**（`groupId` 参数），
     * 两种展示模式下都生效。
     *
     * ⚠️ 这里曾经只把它存进偏好、从没发给接口 —— 于是"只看：待看"选了什么都不发生，
     *    而界面上又看不出哪里不对（下拉的值确实变了）。是审计时才发现的漏做。
     */
    const extra = new URLSearchParams();
    if (lib.starred) extra.set('starred', '1');
    if (lib.onlyGroup) extra.set('groupId', String(lib.onlyGroup));

    if (lib.by) {
      /**
       * 分组模式：**走服务端分组、忽略分页**。
       * 分组名后的条数必须是全量条数 —— 前端分页只拿得到当前页，
       * 自己归并出来的数字只能是"这一页里有多少条"，那是错的。
       */
      const qs = new URLSearchParams({ ...base, by: lib.by });
      for (const [k, v] of extra) qs.set(k, v);
      const data = await api('GET', `/api/library/grouped?${qs}`);
      state.library = { grouped: data, rows: [], total: data.total };
    } else {
      const qs = new URLSearchParams({ ...base, limit: String(PAGE), offset: String(offset) });
      for (const [k, v] of extra) qs.set(k, v);
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

/**
 * 当前列表里**看得见**的那些视频（平铺模式是全部行，分组模式是各组里的行）。
 *
 * 「全选」作用于它 —— 不是"筛选下的全部"：那个要单独点批量条上的
 * 「选中全部 N 条」，因为它可能包含还没加载出来的几百条。
 */
function visibleRows() {
  const grouped = state.library.grouped;
  if (state.prefs.library.by && grouped) return grouped.groups.flatMap((g) => g.rows);
  return state.library.rows || [];
}

function selectAllVisible() {
  for (const v of visibleRows()) picked.add(v.id);
  renderLibrary();
}

function clearVisible() {
  for (const v of visibleRows()) picked.delete(v.id);
  renderLibrary();
}

/** 「选中筛选下的全部」——要问后端（可能包含还没加载出来的） */
async function selectAllFiltered() {
  const lib = state.prefs.library;
  const qs = new URLSearchParams({
    q: lib.q || '', status: lib.status || '', site: lib.site || '',
    uploader: lib.uploader || '', sort: lib.sort || 'created_desc',
  });
  if (lib.starred) qs.set('starred', '1');
  if (lib.onlyGroup) qs.set('groupId', String(lib.onlyGroup));
  try {
    const r = await api('GET', `/api/library/ids?${qs}`);
    for (const id of r.ids) picked.add(id);
    renderLibrary();
    toast(r.truncated
      ? `已选中前 ${r.count} 条（筛选下共 ${r.total} 条，超出上限只选了前 ${r.cap} 条）`
      : `已选中 ${r.count} 条`, r.truncated ? 'warn' : '');
  } catch (err) {
    toast(formatError(err), 'bad');
  }
}

/**
 * 按"库里实际存在的行"重建勾选框状态。
 *
 * ⚠️ 必须**重建视觉**，不能只改旧的节点。`renderLibrary()` 会 `replace()` 重建 DOM，
 *    所以每次重绘后勾选框都是全新的、`checked` 全丢 —— 改旧节点等于白改。
 *    这也是"全选之后看不见任何勾"那类 bug 的来源。
 */
function syncPickBoxes() {
  const multi = $('#libMulti').checked;
  $('#libPickAllWrap').hidden = !multi;
  if (!multi) return;

  for (const box of $$('.pick')) {
    box.checked = picked.has(Number(box.dataset.pick));
  }

  const rows = visibleRows();
  const allOn = rows.length > 0 && rows.every((v) => picked.has(v.id));
  const someOn = rows.some((v) => picked.has(v.id));
  const all = $('#libPickAll');
  all.checked = allOn;
  // 部分选中给"不确定"态，否则空勾选框会让人以为什么都没选
  all.indeterminate = someOn && !allOn;
}

/**
 * 当前视图该用哪个容器（网格还是列表）。
 * **只在这里判断**，别在别处再判断一次 —— 那正是白屏 bug 的来源。
 */
function containersFor(view) {
  const grid = view === 'list' ? null : $('#libGrid');
  const list = view === 'list' ? $('#libList') : null;
  return { grid, list };
}

export function renderLibrary() {
  const lib = state.prefs.library;
  const view = lib.view || 'grid';
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
    renderGrouped(g.groups, view);
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
    setLayout(view);
    return;
  }
  empty.hidden = true;

  replace(grid, rows.map((v) => buildCard(v)));
  replace(list, rows.map((v) => buildRow(v)));
  $('#loadMoreWrap').hidden = rows.length >= total;
  setLayout(view);
  renderBulkBar();
}

/**
 * 画分组模式。
 *
 * ⚠️ 这里踩过一个让**整页白屏**的坑，修法值得记住：
 *
 * 原来这段是"无条件把分段渲染进 `#libGrid`，只按 view 选卡片/行的形状"，
 * 然后 `setLayout` 再把 `#libGrid` 藏起来（因为当前是列表视图）。
 * 结果两个入口都是白屏：
 *   · 先点「列表」再开分组 → 分段画进了被隐藏的 #libGrid
 *   · 先开分组再点「列表」→ 布局按钮只切 hidden、不重绘，同样白屏
 * 而**所有测试都在默认的网格视图下**，270 项全绿也挡不住 ——
 * 是独立评审用 DOM 探针实测才发现的。
 *
 * 现在容器在最上面按视图选一次（`grid` / `list` 只有一个是真节点），
 * 分段内部自己决定画卡片还是画行，`setLayout` 只负责切显隐。
 */
function renderGrouped(groups, view) {
  const grid = $('#libGrid');
  const list = $('#libList');
  const { grid: gridTarget, list: listTarget } = containersFor(view);

  if (gridTarget) {
    replace(grid, groups.map((g) => buildGroup(g, 'grid')));
    replace(list, []);
  } else {
    replace(list, groups.map((g) => buildGroup(g, 'list')));
    replace(grid, []);
  }
  setLayout(view);
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
    el('div', {
      class: 'grp-head',
      dataset: { grp: g.key },
      /**
       * 键盘可达性（评审 Minor）：原来它是个可点的 `div`，纯键盘用户折叠不了。
       * 加 `role=button` + `tabindex` + `aria-expanded`，并在 document 的委托里
       * 处理 Enter / Space（见 `initLibraryView`）。
       */
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(!collapsed),
      title: collapsed ? '展开这一组' : '收起这一组',
    }, [
      el('span', { class: 'grp-caret', text: collapsed ? '▶' : '▼' }),
      g.color ? el('span', { class: `grp-dot c-${g.color}` }) : null,
      el('span', { class: 'grp-name', text: g.name }),
      el('span', { class: 'grp-count', text: String(g.count) }),
      // 分组级全选：只作用于这一组。藏在标题最右边，不影响其它地方的点击（折叠）
      groupPickBox(g),
    ]),
    body,
  ]);
}

/**
 * 分组标题上的"全选本组"勾选框（多选模式下才出现）。
 *
 * 点它要**阻止冒泡** —— `grp-head` 整条是折叠开关，不拦住的话
 * "全选这一组"会顺手把这一组折叠起来，很烦。
 */
function groupPickBox(g) {
  if (!$('#libMulti').checked) return null;
  const ids = g.rows.map((v) => v.id);
  const box = el('input', {
    type: 'checkbox',
    class: 'grp-pick',
    dataset: { grppick: g.key },
    'aria-label': `选中「${g.name}」这一组的全部 ${g.count} 条`,
    title: g.count ? `选中这一组的 ${g.count} 条` : '这一组是空的',
  });
  box.disabled = ids.length === 0;
  box.checked = ids.length > 0 && ids.every((id) => picked.has(id));
  box.indeterminate = !box.checked && ids.some((id) => picked.has(id));
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    if (box.checked) for (const id of ids) picked.add(id);
    else for (const id of ids) picked.delete(id);
    renderLibrary();
  });
  return box;
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
  // 勾选框状态必须跟着每次重绘重建（DOM 被 replace 了，旧节点的 checked 全丢）
  syncPickBoxes();

  const bar = $('#libBulkBar');
  if (!$('#libMulti').checked) {
    bar.hidden = true;
    clear(bar);
    return;
  }

  const visible = visibleRows();
  const filteredTotal = state.library.grouped
    ? (state.library.grouped.total || 0)
    : (state.library.total || 0);
  const allVisibleOn = visible.length > 0 && visible.every((v) => picked.has(v.id));

  const opts = [el('option', { value: '', text: '加入分组…' })];
  for (const g of state.groups || []) {
    opts.push(el('option', { value: String(g.id), text: g.name }));
  }
  const sel = el('select', { class: 'bulk-pick' }, opts);
  sel.addEventListener('change', () => { if (sel.value) bulkGroupAdd(Number(sel.value)); });

  /**
   * 两个"全选"的区别要写在按钮文案里，否则用户分不清：
   *   · 「全选本屏」= 列表里**看得见**的这些
   *   · 「选中全部 N 条」= 当前**筛选下**的全部（含还没加载出来的）
   * 只有筛选下的条数比可见条数多时才显示后一个 —— 否则两个按钮做的事一样，
   * 多一个按钮只会让人犹豫。
   */
  const selectButtons = [];
  if (!allVisibleOn) {
    selectButtons.push(el('button', {
      class: 'btn btn-sm', type: 'button',
      text: `全选本屏 ${visible.length}`,
      title: `只选中当前列表里看得见的 ${visible.length} 条`,
      onclick: () => selectAllVisible(),
    }));
  }
  if (filteredTotal > visible.length) {
    selectButtons.push(el('button', {
      class: 'btn btn-sm', type: 'button',
      // 文案要短：长了会把这行挤到换行，版面上很难看。两者的区别靠 title 说清。
      text: `全选全部 ${filteredTotal}`,
      title: `选中当前筛选下的全部 ${filteredTotal} 条（包括还没加载出来的）`,
      onclick: () => selectAllFiltered(),
    }));
  }

  replace(bar, [
    el('span', { class: 'bulk-count', text: picked.size ? `已选 ${picked.size} 条` : '未选中' }),
    sel,
    ...selectButtons,
    el('button', { class: 'btn btn-sm', type: 'button', text: '收藏', onclick: () => bulkStar('star') }),
    el('button', { class: 'btn btn-sm', type: 'button', text: '取消收藏', onclick: () => bulkStar('unstar') }),
    el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '删除', onclick: () => bulkDelete() }),
    el('button', {
      class: 'btn btn-sm', type: 'button', text: '取消选择',
      onclick: () => { clearPicked(); renderLibrary(); },
    }),
  ]);
  bar.hidden = false;
}

/** 选中的那些视频（只能看到**已加载**的那部分，分组模式也认） */
function pickedVideos() {
  return visibleRows().filter((v) => picked.has(v.id));
}

/**
 * 批量删除。
 *
 * ⚠️ 这是**不可逆**操作，所以：
 *   · 弹框里先把"选中多少条、其中多少条有文件、合计多少空间"摆出来 ——
 *     用户点之前应该知道自己在删什么。
 *   · **默认选项是"只从列表删掉"**（安全的那一边）；连文件一起删是标红的第二选项，
 *     文案里直接写明"永久删除"。
 *
 * 注意：选中的可能包含**还没加载出来的**（用了「全选全部」），
 * `pickedVideos()` 只看得到已加载的那部分 —— 所以条数以 `picked.size` 为准，
 * 并且如实告诉用户"有 N 条还没加载出来，空间没算进去"。
 */
async function bulkDelete() {
  const total = picked.size;
  if (!total) { toast('还没有选中任何视频'); return; }

  const loaded = pickedVideos();
  const withFile = loaded.filter((v) => v.file_path);
  const bytes = withFile.reduce((a, v) => a + (v.file_size || 0), 0);
  const notLoaded = total - loaded.length;

  const lines = [`选中的 ${total} 条会从库里删掉。`];
  if (withFile.length) {
    lines.push(`其中 ${withFile.length} 条有本地文件${bytes ? `，合计 ${fmtBytes(bytes)}` : ''}。`);
  }
  if (notLoaded > 0) {
    lines.push(`（有 ${notLoaded} 条还没加载出来，文件大小没算进去。）`);
  }

  const pick = await confirmDialog({
    title: `删除选中的 ${total} 条`,
    body: lines.join('\n'),
    actions: [
      { label: '取消', value: null },
      { label: '只从列表删掉（保留文件）', value: 'keep', primary: true },
      { label: '连磁盘文件一起永久删除', value: 'purge', tone: 'danger' },
    ],
  });
  if (!pick) return;

  try {
    const r = await api('POST', '/api/videos/bulk-delete', {
      ids: [...picked],
      deleteFiles: pick === 'purge',
    });
    const bits = [`已删除 ${r.deleted} 条`];
    if (r.removedFiles) bits.push(`清理 ${r.removedFiles} 个文件`);
    if (r.freedBytes) bits.push(`释放 ${fmtBytes(r.freedBytes)}`);
    const skipped = (r.errors || []).length;
    if (skipped) bits.push(`${skipped} 条被跳过`);
    toast(bits.join(' · '), skipped ? 'warn' : '');
    clearPicked();
    await reload({ reset: true });
    await loadGroups();
  } catch (err) {
    toast(formatError(err), 'bad');
  }
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

// ---------------------------------------------------------------- 分组管理

/**
 * 可选的预设颜色。**只存 key 不存色值**（后端 `groups.color` 也是 key）——
 * 这样以后调色板变了，旧数据仍然是合法 key，不会留下一个没人认识的 `#a1b2c3`。
 */
const GROUP_COLORS = ['amber', 'blue', 'green', 'purple', 'red'];

/** 打开一个弹层（复用 #modal，与「更多」一致） */
function openModal(build) {
  const modal = $('#modal');
  const close = () => { modal.hidden = true; };
  replace(modal, build(close));
  modal.hidden = false;
  modal.onclick = (e) => { if (e.target === modal) close(); };
}

/**
 * 新建 / 编辑一个分组。
 * @param {object|null} g 传 null 是新建，传分组对象是编辑
 */
function showGroupEditor(g) {
  const isNew = !g;
  const nameBox = el('input', {
    type: 'text', id: 'groupName', maxlength: '40',
    placeholder: '比如：待看、教程、素材',
  });
  nameBox.value = g ? g.name : '';

  let color = (g && g.color) || GROUP_COLORS[0];
  const swatches = GROUP_COLORS.map((c) => {
    const b = el('button', {
      class: `swatch c-${c}${c === color ? ' is-on' : ''}`,
      type: 'button', title: c, dataset: { color: c },
    });
    b.addEventListener('click', () => {
      color = c;
      // 只切高亮，不重建节点（免得输入框里的字被清掉）
      $$('#groupColors .swatch').forEach((x) => x.classList.toggle('is-on', x.dataset.color === c));
    });
    return b;
  });

  const err = el('div', { class: 'form-error', hidden: true });

  const save = async () => {
    const name = nameBox.value.trim();
    if (!name) {
      err.textContent = '名字不能为空';
      err.hidden = false;
      return;
    }
    try {
      if (isNew) await api('POST', '/api/groups', { name, color });
      else await api('PATCH', `/api/groups/${g.id}`, { name, color });
      toast(isNew ? `已建立分组「${name}」` : '已保存');
      await loadGroups();
      await reload({ reset: true });
      $('#modal').hidden = true;
    } catch (e) {
      // 409 重名在这里会带上后端写好的中文说明，直接显示
      err.textContent = formatError(e);
      err.hidden = false;
    }
  };

  openModal((close) => el('div', { class: 'dialog' }, [
    el('h3', { text: isNew ? '新建分组' : `编辑「${g.name}」` }),
    el('label', { class: 'field' }, [el('span', { text: '名字' }), nameBox]),
    el('div', { class: 'field' }, [
      el('span', { text: '颜色' }),
      el('div', { class: 'swatches', id: 'groupColors' }, swatches),
    ]),
    err,
    el('div', { class: 'dialog-actions' }, [
      el('button', { class: 'btn', type: 'button', text: '取消', onclick: close }),
      el('button', { class: 'btn btn-primary', type: 'button', text: isNew ? '建立' : '保存', onclick: save }),
    ]),
  ]));
}

/** 分组列表：改名 / 换色 / 删除（含 0 条的分组 —— 刚建的也要能看见） */
function showGroupManager() {
  const rows = (state.groups || []).map((g) => el('div', { class: 'gm-row', dataset: { gid: String(g.id) } }, [
    el('span', { class: `grp-dot c-${g.color}` }),
    el('span', { class: 'gm-name', text: g.name }),
    el('span', { class: 'gm-count', text: `${g.count} 条` }),
    el('span', { class: 'toolbar-spacer' }),
    el('button', {
      class: 'btn btn-sm', type: 'button', text: '编辑',
      onclick: () => showGroupEditor(g),
    }),
    el('button', {
      class: 'btn btn-sm btn-danger', type: 'button', text: '删除',
      onclick: () => confirmDeleteGroup(g),
    }),
  ]));

  openModal((close) => el('div', { class: 'dialog dialog-wide' }, [
    el('h3', { text: '管理分组' }),
    rows.length
      ? el('div', { class: 'gm-list' }, rows)
      : el('p', { class: 'muted', text: '还没有任何分组。点「＋ 新建分组」建一个。' }),
    el('div', { class: 'dialog-actions' }, [
      el('button', { class: 'btn btn-primary', type: 'button', text: '关闭', onclick: close }),
    ]),
  ]));
}

/**
 * 删除分组前的确认（用户要求"弹框让我选"）。
 *
 * ⚠️ 两个选项的文案**必须写清 purge 不删磁盘文件** ——
 * 后端那个 `purge` 删的是**库记录**，磁盘上的视频文件仍在。
 * 只写"一起删除"会让用户以为文件也没了，而文件是他辛苦下的。
 * 默认选中"只解散"（安全的那一边）。
 */
async function confirmDeleteGroup(g) {
  const pick = await confirmDialog({
    title: `删除分组「${g.name}」`,
    body: `这个分组里有 ${g.count} 条视频。`,
    actions: [
      { label: '取消', value: null },
      { label: '只解散分组，视频回到「未分组」', value: 'detach', primary: true },
      { label: '删分组和里面的库记录（磁盘文件保留）', value: 'purge', tone: 'danger' },
    ],
  });
  if (!pick) return;

  /**
   * ⚠️ `purge` 要**再确认一次**（spec §3.2/§5.4 两处都要求了）。
   *
   * 它删的是**库记录**，而且是不可逆的，还会**波及别的分组** ——
   * 多对多之下，这些视频可能同时属于其它分组，删掉记录它们会从那边一起消失。
   * 第一版把这一步省了（只做一次确认框），评审指出了这个偏离。
   */
  if (pick === 'purge' && g.count > 0) {
    const sure = await confirmDialog({
      title: `确认删除这 ${g.count} 条库记录？`,
      body: [
        `删掉之后，这 ${g.count} 条视频会从所有分组里消失（不只是「${g.name}」）。`,
        '磁盘上的视频文件会保留。这个操作不能撤销。',
      ].join('\n'),
      actions: [
        { label: '我再想想', value: null, primary: true },
        { label: `确认删除这 ${g.count} 条记录`, value: 'purge', tone: 'danger' },
      ],
    });
    if (sure !== 'purge') return;
  }

  try {
    const r = await api('DELETE', `/api/groups/${g.id}?mode=${pick}`);
    toast(pick === 'purge'
      ? `已删除分组和 ${r.removedVideos} 条库记录（磁盘文件保留）`
      : '已解散分组，视频回到「未分组」');
    // 如果当前正在"只看"这个分组，清掉这个筛选，否则会看着一个不存在的分组
    if (String(state.prefs.library.onlyGroup || '') === String(g.id)) {
      savePrefs({ library: { onlyGroup: '' } });
    }
    await loadGroups();
    await reload({ reset: true });
    $('#modal').hidden = true;
  } catch (err) {
    toast(formatError(err), 'bad');
  }
}
