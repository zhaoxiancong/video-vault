'use strict';
/* ══════════════════════════════════════════════════════════════════
   Video Vault 前端逻辑（原生 JS，无框架）

   两个刻意的设计决定：
   1. 进度更新走「原地改 DOM」而不是重绘整个队列。
      SSE 每秒会推多次进度，重绘会让进度条闪烁、日志展开被收起。
   2. 队列任务的状态变化才触发重绘（增删任务 / 状态跳变）。
   ══════════════════════════════════════════════════════════════════ */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  view: 'add',
  health: null,
  presets: [],
  queue: new Map(),        // id -> 活动任务
  queueOrder: [],
  history: [],             // 最近结束的任务（服务端来的，刷新后仍在）
  counts: null,
  historyOpen: false,      // "最近任务"是否展开
  loggedOpen: new Set(),   // 展开了日志的任务 id
  library: [],
  libraryTotal: 0,
  layout: 'grid',
  filters: { q: '', status: '', site: '', uploader: '', starred: false, sort: 'created_desc' },
  offset: 0,
  limit: 60,
  loading: false,
  player: { id: null, source: 'original' },
};

// ───────────────────────────────────────────── 本机偏好持久化

/**
 * 为什么要持久化：服务端的队列和数据库本来就是持久的，
 * 但前端把"你填的东西"全放在内存里，一刷新就没了 —— 体验很割裂：
 * 队列还在跑，表单却空了，用户会以为任务丢了。
 *
 * 只存"用户的偏好和输入"，不存服务端数据（那些以服务端为准）。
 */
const STORE_KEY = 'vault.prefs.v1';

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function savePrefs(patch) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch { /* 隐私模式下 localStorage 可能不可用，静默忽略 */ }
}

/** 收集添加页上所有用户选择，供保存 */
function collectAddForm() {
  return {
    urlBox: $('#urlBox').value,
    kind: $('#optKind').value,
    quality: $('#optQuality').value,
    rate: $('#optRate').value,
    forceList: $('#optForceList').checked,
  };
}

/** 表单有任何变化就存一次（含文本框，用防抖避免每敲一个字写一次） */
let saveFormTimer = null;
function scheduleSaveForm() {
  clearTimeout(saveFormTimer);
  saveFormTimer = setTimeout(() => savePrefs({ addForm: collectAddForm() }), 300);
}

/** 页面加载时恢复表单 */
function restoreAddForm() {
  const p = loadPrefs();
  const f = p.addForm;
  if (!f) return;

  if (typeof f.urlBox === 'string') $('#urlBox').value = f.urlBox;
  if (f.kind) $('#optKind').value = f.kind;
  if (f.quality) $('#optQuality').value = f.quality;
  if (f.rate) $('#optRate').value = f.rate;
  if (typeof f.forceList === 'boolean') $('#optForceList').checked = f.forceList;

  // 恢复依赖项：选"仅音频"时清晰度要隐藏（否则会出现不该显示的控件）
  $('#fieldQuality').style.display = $('#optKind').value === 'audio' ? 'none' : '';

  // 恢复上次的提交报告（否则刷新后"我刚才提交了什么"也看不到了）
  if (p.lastReport) renderReport(p.lastReport);
}

/** 库页的布局与筛选也记住 */
function saveLibraryPrefs() {
  savePrefs({ layout: state.layout, filters: state.filters });
}

function restoreLibraryPrefs() {
  const p = loadPrefs();
  if (p.layout === 'grid' || p.layout === 'list') {
    state.layout = p.layout;
    $$('#libLayout .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.layout === p.layout));
    $('#libGrid').hidden = p.layout !== 'grid';
    $('#libList').hidden = p.layout === 'grid';
  }
  if (p.filters && typeof p.filters === 'object') {
    state.filters = { ...state.filters, ...p.filters };
    $('#libSearch').value = state.filters.q || '';
    $('#libStatus').value = state.filters.status || '';
    $('#libSort').value = state.filters.sort || 'created_desc';
    $('#libStarred').checked = !!state.filters.starred;
  }
}

// ───────────────────────────────────────────── 通用工具

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    setTimeout(() => el.remove(), 320);
  }, kind === 'bad' ? 6000 : 3200);
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function fmtSpeed(n) {
  if (!n) return '';
  return fmtBytes(n) + '/s';
}

function fmtDuration(sec) {
  if (!sec && sec !== 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtEta(sec) {
  if (!sec && sec !== 0) return '';
  sec = Math.round(sec);
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分`;
  return `${Math.floor(sec / 3600)} 时 ${Math.round((sec % 3600) / 60)} 分`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(s) {
  if (!s) return '';
  return String(s).slice(0, 10);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

const STATUS_TEXT = {
  queued: '排队中', parsing: '解析中', downloading: '下载中',
  processing: '处理中', done: '已完成', failed: '失败',
  paused: '已暂停', canceled: '已取消',
};

// ───────────────────────────────────────────── 视图切换

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  switchView(btn.dataset.view);
});

function switchView(name) {
  state.view = name;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + name));
  if (name === 'library' && !state.library.length) loadLibrary({ reset: true });
  if (name === 'settings') { loadHealth(); renderPresets(); }
}

// ───────────────────────────────────────────── 引擎自检 / 设置

async function loadHealth() {
  try {
    const h = await api('GET', '/api/health');
    state.health = h;

    const dot = $('#engineDot'), txt = $('#engineText');
    if (h.ok) {
      dot.className = 'dot dot-ok';
      txt.textContent = `引擎就绪 · 并发 ${h.settings.concurrency}`;
    } else {
      dot.className = 'dot dot-bad';
      txt.textContent = '引擎缺失，请检查 tools/bin';
    }

    $('#hintDir').textContent = h.downloads;

    $('#setDir').value = h.settings.downloadDir;
    $('#setConcurrency').value = h.settings.concurrency;
    $('#setRate').value = h.settings.rateLimitMB;
    $('#setFrag').value = h.settings.fragmentConcurrency;
    $('#setRetries').value = h.settings.retries;
    $('#setOrganize').checked = h.settings.organizeByUploader !== false;
    // 登录态（二期）
    const cb = $('#setCookieBrowser');
    // 下拉里没有的值（比如用户手改过配置）就补进去，别让界面显示成"不用"
    const wantBrowser = h.settings.cookiesFromBrowser || '';
    if (cb && wantBrowser && ![...cb.options].some((o) => o.value === wantBrowser)) {
      cb.insertAdjacentHTML('beforeend', `<option value="${esc(wantBrowser)}">${esc(wantBrowser)}</option>`);
    }
    if (cb && document.activeElement !== cb) cb.value = wantBrowser;
    const cf = $('#setCookieFile');
    if (cf && document.activeElement !== cf) cf.value = h.settings.cookiesFile || '';
    // 添加页的限速下拉跟设置保持一致（正在操作时不打断用户）
    const rt = $('#optRate');
    if (rt && document.activeElement !== rt) rt.value = String(h.settings.rateLimitMB || 0);

    const e = h.engines;
    $('#healthBody').innerHTML = `
      <dt>yt-dlp</dt><dd>${e.ytdlp.ok ? esc(e.ytdlp.version) : '❌ ' + esc(e.ytdlp.error || '不可用')}</dd>
      <dt>yt-dlp 路径</dt><dd>${esc(e.ytdlp.path)}</dd>
      <dt>ffmpeg</dt><dd>${e.ffmpeg.ok ? '✅ ' + esc(e.ffmpeg.version.split(' ').slice(0, 3).join(' ')) : '❌ ' + esc(e.ffmpeg.error || '不可用')}</dd>
      <dt>下载目录</dt><dd>${esc(h.downloads)}</dd>`;

    const ih = $('#interruptHint');
    if (h.queuedInterrupted > 0) {
      ih.hidden = false;
      ih.innerHTML = `上次有 <b>${h.queuedInterrupted}</b> 个任务没跑完（已暂停/失败）。
        到「添加下载」页点「全部继续」即可接着下，已下载的部分不会重来。`;
    } else {
      ih.hidden = true;
    }
  } catch (err) {
    $('#engineDot').className = 'dot dot-bad';
    $('#engineText').textContent = '无法连接服务';
  }
}

async function renderPresets() {
  if (!state.presets.length) {
    state.presets = await api('GET', '/api/transcode-presets');
  }
  $('#presetList').innerHTML = state.presets
    .map((p) => `<dt>${esc(p.label)}</dt><dd>.${esc(p.ext)}</dd>`).join('');
}

$('#btnSaveSettings').addEventListener('click', async () => {
  try {
    const next = await api('PATCH', '/api/settings', {
      downloadDir: $('#setDir').value.trim(),
      concurrency: Number($('#setConcurrency').value),
      rateLimitMB: Number($('#setRate').value),
      fragmentConcurrency: Number($('#setFrag').value),
      retries: Number($('#setRetries').value),
      organizeByUploader: $('#setOrganize').checked,
      cookiesFromBrowser: $('#setCookieBrowser') ? $('#setCookieBrowser').value : '',
      cookiesFile: $('#setCookieFile') ? $('#setCookieFile').value.trim() : '',
    });
    const hint = $('#saveHint');
    // 登录态配错了要当场说 —— 不要等下一次下载失败才发现。
    // 用 textContent 而不是 innerHTML：提示里可能带用户填的路径，
    // 而且这个项目有过"星号被当 Markdown 显示出来"的先例。
    if (next && next._warning) {
      hint.textContent = '已保存，但：' + next._warning;
      hint.style.color = 'var(--warn, #b8860b)';
    } else {
      hint.textContent = '已保存 ✓';
      hint.style.color = '';
    }
    setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 6000);
    loadHealth();
  } catch (err) { toast('保存失败：' + err.message, 'bad'); }
});

// ───────────────────────────────────────────── 登录态测试

if ($('#btnTestCookies')) {
  $('#btnTestCookies').addEventListener('click', async () => {
    const btn = $('#btnTestCookies');
    const hint = $('#cookieHint');
    const box = $('#cookieResult');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '测试中…（最多 30 秒）';
    hint.textContent = '';
    try {
      // 带上界面上当前填的值测 —— 用户想要的是"我现在填的这套能不能用"，
      // 而不是"上次保存的那套"。所以先存再测，保证两者一致。
      await api('PATCH', '/api/settings', {
        cookiesFromBrowser: $('#setCookieBrowser').value,
        cookiesFile: $('#setCookieFile').value.trim(),
      });
      const r = await api('POST', '/api/cookies/test', {});
      box.hidden = false;
      box.className = 'cookie-result ' + (r.ok ? 'ok' : 'bad');
      // 全部用 textContent 逐节点填，不用 innerHTML —— hint 里有引擎原话，
      // 里面可能带尖括号，拼进 HTML 会被吃掉或注入
      box.textContent = '';
      const title = document.createElement('div');
      title.className = 'cookie-result-title';
      title.textContent = (r.ok ? '✅ ' : '⚠️ ') + r.title;
      const hintEl = document.createElement('div');
      hintEl.className = 'cookie-result-hint';
      hintEl.textContent = r.hint || '';
      box.append(title, hintEl);
      if (r.raw && !r.ok) {
        const raw = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = '引擎原始输出';
        const pre = document.createElement('pre');
        pre.className = 'cookie-raw';
        pre.textContent = r.raw;
        raw.append(sum, pre);
        box.append(raw);
      }
      if (r.sample) {
        const sm = document.createElement('div');
        sm.className = 'cookie-result-hint';
        sm.textContent = '测试解析到的标题：' + r.sample;
        box.append(sm);
      }
    } catch (err) {
      toast('测试失败：' + err.message, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

// ───────────────────────────────────────────── 添加下载

$('#optKind').addEventListener('change', (e) => {
  $('#fieldQuality').style.display = e.target.value === 'audio' ? 'none' : '';
});

// 限速是"下载速度"最大的变量，所以放在添加页直接可调，不用翻到设置页。
// 改动即时写进后端，对后续所有任务生效。
$('#optRate').addEventListener('change', async (e) => {
  const v = Number(e.target.value);
  try {
    await api('PATCH', '/api/settings', { rateLimitMB: v });
    toast(v === 0 ? '已设为不限速' : '已限速 ' + v + ' MB/s', 'ok');
    loadHealth();
  } catch (err) { toast('设置限速失败：' + err.message, 'bad'); }
});

$('#urlBox').addEventListener('paste', () => {
  // 粘贴后自动去掉首尾空行，省一次手动清理
  setTimeout(() => {
    const box = $('#urlBox');
    const lines = box.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length) box.value = lines.join('\n');
    scheduleSaveForm();
  }, 0);
});

// 添加页所有输入都持久化：刷新后你填的东西还在。
// （服务端的队列本来就是持久的，前端却把输入丢光，体验很割裂）
$('#urlBox').addEventListener('input', scheduleSaveForm);
$('#optKind').addEventListener('change', scheduleSaveForm);
$('#optQuality').addEventListener('change', scheduleSaveForm);
$('#optRate').addEventListener('change', scheduleSaveForm);
$('#optForceList').addEventListener('change', scheduleSaveForm);

$('#btnAdd').addEventListener('click', async () => {
  const raw = $('#urlBox').value.trim();
  if (!raw) { toast('先粘个链接进来', 'bad'); return; }

  const btn = $('#btnAdd');
  btn.disabled = true;
  btn.textContent = '解析中…';

  try {
    const report = await api('POST', '/api/videos', {
      urls: raw,
      kind: $('#optKind').value,
      quality: $('#optQuality').value,
      forcePlaylist: $('#optForceList').checked,
    });
    renderReport(report);
    // 报告也存下来，刷新后还能看到"我刚提交了什么"
    savePrefs({ lastReport: report });
    $('#urlBox').value = '';
    scheduleSaveForm();
    const n = report.added.length;
    const s = report.skipped.length;
    if (n) toast(`已加入 ${n} 个任务${s ? `，跳过 ${s} 个（库里已有）` : ''}`, 'ok');
    else if (s) toast(`${s} 个链接库里已经有了，没有重复下载`, '');
    if (report.errors.length) toast(`${report.errors.length} 个链接解析失败，见下方结果`, 'bad');

    refreshQueue();
    if (state.view === 'library') loadLibrary({ reset: true });
  } catch (err) {
    toast('提交失败：' + err.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = '加入下载队列';
  }
});

function renderReport(rep) {
  const panel = $('#reportPanel');
  const body = $('#reportBody');
  const parts = [];

  // 先说明链接被纠正过（例如抖音的 ?modal_id= 地址 → 规范视频地址），
  // 否则用户会疑惑"我粘的不是这个地址"
  for (const r of rep.renamed || []) {
    parts.push(`<div class="report-line"><span class="skip">↻</span>
      <span>已自动识别为视频地址：<br>
      <span class="muted">${esc(r.from)}</span><br>→ ${esc(r.to)}</span></div>`);
  }

  for (const p of rep.playlists) {
    parts.push(`<div class="report-line"><span class="ok">▶</span>
      <span>播放列表《${esc(p.title)}》共 ${p.count} 个，新增 <b>${p.added}</b> 个${p.skipped ? `，跳过 ${p.skipped} 个` : ''}</span></div>`);
  }
  for (const a of rep.added) {
    if (a.playlist) continue;
    parts.push(`<div class="report-line"><span class="ok">✓</span><span>${esc(a.title || a.url)}</span></div>`);
  }
  for (const r of rep.retried || []) {
    parts.push(`<div class="report-line"><span class="ok">↻</span>
      <span>库里已有失败记录，已重新加入下载：${esc(r.title || r.url)}</span></div>`);
  }

  for (const s of rep.skipped) {
    parts.push(`<div class="report-line"><span class="skip">•</span>
      <span>库里已有：${esc(s.title || s.url)}</span></div>`);
  }
  for (const e of rep.errors) {
    parts.push(`<div class="report-line"><span class="err">✕</span>
      <span>${esc(e.url)}<br><span class="muted">${esc(e.error)}</span></span></div>`);
  }

  body.innerHTML = parts.join('') || '<div class="empty">没有新增任何任务。</div>';
  panel.hidden = false;
}

// ───────────────────────────────────────────── 队列渲染

function refreshQueue() {
  api('GET', '/api/queue?history=20').then((snap) => {
    // 服务端只回活动任务；把本地已知的活动任务对齐过去
    const live = new Set(snap.running.map((r) => r.id));
    for (const id of [...state.queue.keys()]) {
      if (!live.has(id) && state.queue.get(id)._active) state.queue.delete(id);
    }
    for (const r of snap.running) {
      state.queue.set(r.id, { ...(state.queue.get(r.id) || {}), ...r, _active: true });
    }
    state.queueOrder = [...state.queue.keys()];
    // 最近结束的任务：服务端持久保存的，刷新后仍在（这是"刷新就空了"的主要修复）
    state.history = Array.isArray(snap.history) ? snap.history : [];
    state.counts = snap.counts || null;
    renderQueue();
    renderHistory();
    updateTabCount();
  }).catch(() => {});
}

function updateTabCount() {
  const c = state.counts;
  const total = c ? (Number(c.done) || 0) + (Number(c.failed) || 0)
    + (Number(c.paused) || 0) + (Number(c.canceled) || 0) : 0;
  $('#tabLibCount').textContent = state.libraryTotal || total || 0;
}

function renderQueue() {
  const ids = state.queueOrder.filter((id) => state.queue.has(id));
  const list = $('#queueList');
  $('#queueEmpty').hidden = ids.length > 0;
  updateTabCount();

  if (!ids.length) { list.innerHTML = ''; return; }

  // 只做「增删 + 状态跳变」的整表重绘；纯进度变化走 patchQueue
  const html = ids.map((id) => queueItemHtml(state.queue.get(id))).join('');
  if (list.dataset.sig !== ids.join(',') + '|' + ids.map((i) => state.queue.get(i).status).join(',')) {
    list.innerHTML = html;
    list.dataset.sig = ids.join(',') + '|' + ids.map((i) => state.queue.get(i).status).join(',');
    // 恢复已展开的日志
    for (const id of state.loggedOpen) loadLogInto(id);
  }
  patchQueue();
}

/**
 * 渲染"最近任务"（已完成/失败/暂停/取消）。
 *
 * 这些数据来自服务端数据库，本来就是持久的 —— 之前只回活动任务，
 * 导致用户刷新后看到空队列，以为任务全丢了。
 * 每条都带"删除"入口（可选只删记录或连文件一起删）。
 */
function renderHistory() {
  const host = $('#historyList');
  if (!host) return;
  const rows = state.history || [];
  const c = state.counts || {};

  $('#historyEmpty').hidden = rows.length > 0;
  $('#historyList').hidden = !state.historyOpen;

  const summary = [
    c.done ? `完成 ${c.done}` : '',
    c.failed ? `失败 ${c.failed}` : '',
    c.paused ? `暂停 ${c.paused}` : '',
    c.canceled ? `取消 ${c.canceled}` : '',
  ].filter(Boolean).join(' · ');
  $('#historySummary').textContent = summary || '暂无记录';
  $('#btnHistoryToggle').textContent = state.historyOpen ? '收起' : '展开';

  if (!state.historyOpen) { host.innerHTML = ''; return; }

  host.innerHTML = rows.map((v) => {
    const st = v.status || '';
    const title = v.title || v.url || ('#' + v.id);
    const bits = [];
    if (v.file_size) bits.push(fmtBytes(v.file_size));
    if (v.height) bits.push(v.height + 'p');
    if (v.duration) bits.push(fmtDuration(v.duration));
    if (v.finished_at) bits.push(String(v.finished_at).replace('T', ' ').slice(5, 16));
    if (v.uploader) bits.push(v.uploader);
    if (v.error) bits.push(v.error);

    const canPlay = st === 'done' && v.file_path;
    return `<div class="qitem" data-s="${st}" data-id="${v.id}" data-hist="1">
      <div class="q-top">
        <span class="q-title ${v.title ? '' : 'is-url'}">${esc(title)}</span>
        <span class="q-badge s-${st}">${STATUS_TEXT[st] || st}</span>
      </div>
      <div class="q-meta">
        <span class="q-msg">${esc(bits.join(' · '))}</span>
        <span class="grow"></span>
        <span class="q-actions">
          ${canPlay ? `<button class="link-btn" data-act="play" data-id="${v.id}">播放</button>` : ''}
          ${['failed', 'canceled', 'paused'].includes(st)
            ? `<button class="link-btn" data-act="resume" data-id="${v.id}">重新下载</button>` : ''}
          ${st === 'failed' ? `<button class="link-btn" data-act="log" data-id="${v.id}">日志</button>` : ''}
          <button class="link-btn btn-danger" data-act="remove" data-id="${v.id}">删除</button>
        </span>
      </div>
      <div class="q-log" hidden></div>
    </div>`;
  }).join('');
}

function queueItemHtml(v) {
  const st = v.status || 'queued';
  const pct = Math.max(0, Math.min(100, Number(v.progress) || 0));
  const title = v.title || v.url || ('#' + v.id);
  const isUrl = !v.title;
  const stageText = v.stage && st !== 'done' ? v.stage : '';

  const meta = [];
  if (st === 'downloading' || st === 'processing') {
    if (v.speed) meta.push(fmtSpeed(v.speed));
    if (v.eta) meta.push('剩余 ' + fmtEta(v.eta));
    meta.push(pct.toFixed(1) + '%');
  } else if (st === 'done') {
    if (v.file_size) meta.push(fmtBytes(v.file_size));
    if (v.height) meta.push(v.height + 'p');
    if (v.duration) meta.push(fmtDuration(v.duration));
  } else if (v.error) {
    meta.push(esc(v.error));
  }
  if (stageText) meta.push(esc(stageText));
  if (v.uploader) meta.push(esc(v.uploader));

  const actions = [];
  if (['downloading', 'parsing', 'queued'].includes(st)) {
    actions.push(`<button class="link-btn" data-act="pause" data-id="${v.id}">暂停</button>`);
  }
  if (['paused', 'failed', 'canceled'].includes(st)) {
    actions.push(`<button class="link-btn" data-act="resume" data-id="${v.id}">继续</button>`);
  }
  // 只有真正在跑的任务才需要"取消"；已结束的直接给"删除"
  if (['downloading', 'parsing', 'queued', 'processing'].includes(st)) {
    actions.push(`<button class="link-btn" data-act="cancel" data-id="${v.id}">取消</button>`);
  }
  if (st === 'done') {
    actions.push(`<button class="link-btn" data-act="play" data-id="${v.id}">播放</button>`);
  }
  actions.push(`<button class="link-btn" data-act="log" data-id="${v.id}">${state.loggedOpen.has(v.id) ? '收起日志' : '日志'}</button>`);
  // 删除：任何状态都能删（在跑的会先停掉）
  actions.push(`<button class="link-btn btn-danger" data-act="remove" data-id="${v.id}">删除</button>`);

  return `<div class="qitem" data-s="${st}" data-id="${v.id}">
    <div class="q-top">
      <span class="q-title ${isUrl ? 'is-url' : ''}">${esc(title)}</span>
      <span class="q-badge s-${st}">${STATUS_TEXT[st] || st}</span>
    </div>
    <div class="q-bar"><div class="q-fill" style="width:${pct}%"></div></div>
    <div class="q-meta">
      <span class="q-msg">${meta.join(' · ')}</span>
      <span class="grow"></span>
      <span class="q-actions">${actions.join('')}</span>
    </div>
    <div class="q-log" hidden></div>
  </div>`;
}

/** 只更新进度条与文字，不动 DOM 结构 */
function patchQueue() {
  for (const [id, v] of state.queue) {
    const el = $(`.qitem[data-id="${id}"]`);
    if (!el) continue;
    const pct = Math.max(0, Math.min(100, Number(v.progress) || 0));
    const fill = $('.q-fill', el);
    if (fill) fill.style.width = pct + '%';

    const bits = [];
    if (v.status === 'downloading' || v.status === 'processing') {
      if (v.speed) bits.push(fmtSpeed(v.speed));
      if (v.eta) bits.push('剩余 ' + fmtEta(v.eta));
      bits.push(pct.toFixed(1) + '%');
    } else if (v.status === 'done') {
      if (v.file_size) bits.push(fmtBytes(v.file_size));
      if (v.height) bits.push(v.height + 'p');
    } else if (v.error) {
      bits.push(v.error);
    }
    if (v.stage && v.status !== 'done') bits.push(v.stage);
    const msg = $('.q-msg', el);
    if (msg && bits.length) msg.textContent = bits.join(' · ');
  }
}

/**
 * 队列 + 最近任务的统一点击处理。
 *
 * 关键点是"删除"必须问清要不要连文件一起删：
 * 一个误点就永久删掉下载好的视频是不可接受的（这些文件可能来之不易）。
 * 默认选项刻意设成**保留文件** —— 直接回车不会毁数据。
 */
async function handleItemClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;

  if (act === 'log') {
    const item = btn.closest('.qitem');
    const logEl = $('.q-log', item);
    if (state.loggedOpen.has(id)) {
      state.loggedOpen.delete(id);
      logEl.hidden = true;
      btn.textContent = '日志';
    } else {
      state.loggedOpen.add(id);
      logEl.hidden = false;
      btn.textContent = '收起日志';
      loadLogInto(id);
    }
    return;
  }
  if (act === 'play') { openPlayer(id); return; }

  if (act === 'remove') { await removeVideo(id); return; }

  try {
    const r = await api('POST', `/api/videos/${id}/action`, { action: act });
    if (r && r.video) {
      // 就地更新，避免整表重绘导致日志收起
      const known = state.queue.get(id);
      if (known) Object.assign(known, r.video);
    }
    refreshQueue();
    loadHealth();
  } catch (err) { toast('操作失败：' + err.message, 'bad'); }
}

/** 删除一条记录：先问是否连文件一起删，默认保留文件 */
async function removeVideo(id) {
  const v = [...state.queue.values()].find((x) => x.id === id)
    || (state.history || []).find((x) => x.id === id);
  const name = (v && (v.title || v.url)) || ('#' + id);
  const short = name.length > 50 ? name.slice(0, 47) + '…' : name;
  const size = v && v.file_size ? `（${fmtBytes(v.file_size)}）` : '';

  // 注意：prompt 里"直接回车"会选中默认值，所以默认值必须是**最安全**的那个。
  const pick = window.prompt(
    `删除「${short}」${size}\n\n`
    + ' 1 = 只从列表删掉，文件保留在磁盘上（默认，安全）\n'
    + ' 2 = 记录和文件一起永久删除（不可恢复）\n'
    + ' 0 = 取消',
    '1'
  );
  if (pick === null || pick.trim() === '0' || pick.trim() === '') return;

  const delFile = pick.trim() === '2';
  if (delFile) {
    const sure = window.confirm(
      `确定要永久删除磁盘文件吗？\n\n${name}\n${v && v.file_path ? v.file_path : '(路径未知)'}\n\n此操作不可恢复。`
    );
    if (!sure) { toast('已取消，什么都没删'); return; }
  }

  try {
    await api('DELETE', `/api/videos/${id}${delFile ? '' : '?keepFile=1'}`);
    state.queue.delete(id);
    state.loggedOpen.delete(id);
    toast(delFile ? '记录和文件已删除' : '记录已删除，文件保留', 'ok');
    refreshQueue();
    if (state.view === 'library') loadLibrary({ reset: true });
  } catch (err) { toast('删除失败：' + err.message, 'bad'); }
}

$('#queueList').addEventListener('click', handleItemClick);
$('#historyList').addEventListener('click', handleItemClick);

// 最近任务的展开/收起与"清空已完成记录"
$('#btnHistoryToggle').addEventListener('click', () => {
  state.historyOpen = !state.historyOpen;
  savePrefs({ historyOpen: state.historyOpen });
  renderHistory();
});

$('#btnClearDone').addEventListener('click', async () => {
  const c = state.counts || {};
  const n = Number(c.done) || 0;
  if (!n) { toast('没有已完成的记录'); return; }
  if (!window.confirm(
    `清空 ${n} 条「已完成」的列表记录？\n\n`
    + '只删列表记录，磁盘上的视频文件都会保留。\n'
    + '（想连文件一起删，请用每条记录右侧的「删除」按钮）'
  )) return;
  try {
    const r = await api('POST', '/api/queue/action', { action: 'clearFinished' });
    toast(`已清空 ${r.affected} 条记录，文件未删除`, 'ok');
    refreshQueue();
    if (state.view === 'library') loadLibrary({ reset: true });
  } catch (err) { toast('清空失败：' + err.message, 'bad'); }
});

async function loadLogInto(id) {
  const el = $(`.qitem[data-id="${id}"] .q-log`);
  if (!el) return;
  try {
    const data = await api('GET', `/api/videos/${id}/log`);
    el.textContent = (data.lines || []).join('\n').trim() || '（暂无日志）';
    el.scrollTop = el.scrollHeight;
  } catch { el.textContent = '（读取日志失败）'; }
}

$('.panel-actions').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-bulk]');
  if (!btn) return;
  try {
    const r = await api('POST', '/api/queue/action', { action: btn.dataset.bulk });
    toast(`已处理 ${r.affected} 个任务`, 'ok');
    refreshQueue();
    loadHealth();
  } catch (err) { toast('操作失败：' + err.message, 'bad'); }
});

// ───────────────────────────────────────────── 库

let searchTimer = null;
$('#libSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.q = $('#libSearch').value.trim();
    saveLibraryPrefs();
    loadLibrary({ reset: true });
  }, 260);
});

for (const [sel, key] of [['#libStatus', 'status'], ['#libSite', 'site'],
                          ['#libUploader', 'uploader'], ['#libSort', 'sort']]) {
  $(sel).addEventListener('change', () => {
    state.filters[key] = $(sel).value;
    saveLibraryPrefs();
    loadLibrary({ reset: true });
  });
}
$('#libStarred').addEventListener('change', () => {
  state.filters.starred = $('#libStarred').checked;
  saveLibraryPrefs();
  loadLibrary({ reset: true });
});

$('#libLayout').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  state.layout = btn.dataset.layout;
  $$('#libLayout .seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  saveLibraryPrefs();
  renderLibrary();
});

$('#btnRefresh').addEventListener('click', () => { loadLibrary({ reset: true }); loadFacets(); });

async function loadFacets() {
  try {
    const f = await api('GET', '/api/facets');
    const fillSel = (sel, rows, keepAll) => {
      const cur = $(sel).value;
      $(sel).innerHTML = `<option value="">${keepAll}</option>` +
        rows.map((r) => `<option value="${esc(r.v)}">${esc(r.v)} (${r.n})</option>`).join('');
      if (cur) $(sel).value = cur;
    };
    fillSel('#libSite', f.sites, '全部站点');
    fillSel('#libUploader', f.uploaders, '全部作者');
    $('#tabLibCount').textContent = f.totals.count_all || 0;
  } catch {}
}

async function loadLibrary({ reset = false, more = false } = {}) {
  if (state.loading) return;
  if (reset) { state.offset = 0; state.library = []; }

  state.loading = true;
  const f = state.filters;
  const params = new URLSearchParams({
    q: f.q, status: f.status, site: f.site, uploader: f.uploader,
    sort: f.sort, limit: String(state.limit), offset: String(state.offset),
  });
  if (f.starred) params.set('starred', '1');

  try {
    const data = await api('GET', '/api/library?' + params.toString());
    state.library = reset || !more ? data.rows : state.library.concat(data.rows);
    state.libraryTotal = data.total;
    state.offset = state.library.length;
    renderLibrary();
    loadFacets();
  } catch (err) {
    toast('读取库失败：' + err.message, 'bad');
  } finally {
    state.loading = false;
  }
}

function renderLibrary() {
  const rows = state.library;
  $('#libEmpty').hidden = rows.length > 0;
  $('#libStat').textContent = rows.length
    ? `共 ${state.libraryTotal} 条，显示 ${rows.length} 条`
    : '';
  $('#tabLibCount').textContent = state.libraryTotal;

  const isGrid = state.layout === 'grid';
  $('#libGrid').hidden = !isGrid;
  $('#libList').hidden = isGrid;

  if (isGrid) $('#libGrid').innerHTML = rows.map(cardHtml).join('');
  else $('#libList').innerHTML = rows.map(rowHtml).join('');

  $('#loadMoreWrap').hidden = rows.length >= state.libraryTotal;
}

function mediaTags(v) {
  const tags = [];
  if (v.kind === 'audio') tags.push('<span class="tag warn">音频</span>');
  if (v.height) tags.push(`<span class="tag">${v.height}p</span>`);
  if (v.container) tags.push(`<span class="tag">${esc(v.container.toUpperCase())}</span>`);
  if (v.vcodec && v.vcodec !== 'none') tags.push(`<span class="tag">${esc(v.vcodec)}</span>`);
  if (v.file_size) tags.push(`<span class="tag">${fmtBytes(v.file_size)}</span>`);
  if (v.status === 'done' && v.transcoded_path) tags.push('<span class="tag ok">已转码</span>');
  if (v.status !== 'done') tags.push(`<span class="tag bad">${STATUS_TEXT[v.status] || v.status}</span>`);
  if (v.notes) tags.push('<span class="tag">有备注</span>');
  return tags.join('');
}

function cardHtml(v) {
  const title = v.title || v.url;
  const thumb = v.id ? `/api/videos/${v.id}/thumb` : '';
  const style = thumb ? `style="background-image:url('${thumb}')"` : '';
  return `<div class="card" data-id="${v.id}">
    <div class="card-thumb" data-act="play" data-id="${v.id}" ${style}>
      ${thumb ? '' : '<span class="ph">🎬</span>'}
      <span class="play">▶</span>
      ${v.kind === 'audio' ? '<span class="card-kind">MP3</span>' : ''}
      ${v.duration ? `<span class="card-dur">${fmtDuration(v.duration)}</span>` : ''}
      <button class="card-star ${v.starred ? 'on' : ''}" data-act="star" data-id="${v.id}" title="收藏">★</button>
    </div>
    <div class="card-body">
      <div class="card-title" title="${esc(title)}">${esc(title)}</div>
      <div class="card-sub">${esc(v.uploader || '未知作者')}${v.site ? ' · ' + esc(v.site) : ''}${v.upload_date ? ' · ' + esc(fmtDate(v.upload_date)) : ''}</div>
      <div class="card-tags">${mediaTags(v)}</div>
      <div class="card-actions">
        <button class="btn btn-sm" data-act="play" data-id="${v.id}">播放</button>
        <button class="btn btn-sm" data-act="menu" data-id="${v.id}">更多</button>
      </div>
    </div>
  </div>`;
}

function rowHtml(v) {
  const title = v.title || v.url;
  const thumb = v.id ? `/api/videos/${v.id}/thumb` : '';
  return `<div class="row" data-id="${v.id}">
    <div class="row-thumb" data-act="play" data-id="${v.id}" style="background-image:url('${thumb}')"></div>
    <div class="row-main">
      <div class="row-title" title="${esc(title)}">${esc(title)}</div>
      <div class="row-sub">${esc(v.uploader || '未知作者')} · ${esc(v.site || '')} · ${mediaTags(v).replace(/<[^>]+>/g, ' ').trim()}</div>
    </div>
    <div class="row-actions">
      <button class="btn btn-sm" data-act="play" data-id="${v.id}">播放</button>
      <button class="btn btn-sm" data-act="menu" data-id="${v.id}">更多</button>
    </div>
  </div>`;
}

// 库的点击（网格 + 列表共用一个委托）
for (const sel of ['#libGrid', '#libList']) {
  $(sel).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.act;
    if (act === 'play') return openPlayer(id);
    if (act === 'star') {
      await api('POST', `/api/videos/${id}/action`, { action: 'star' });
      loadLibrary({ more: true, reset: false });
      return;
    }
    if (act === 'menu') return openMenu(id);
  });
}

$('#btnLoadMore').addEventListener('click', () => loadLibrary({ more: true }));

// ───────────────────────────────────────────── 单条操作菜单（用原生 prompt/confirm 保持零依赖）

async function openMenu(id) {
  const v = state.library.find((x) => x.id === id) ||
            [...state.queue.values()].find((x) => x.id === id);
  if (!v) return;

  const lines = [
    `标题：${v.title || v.url}`,
    `作者：${v.uploader || '未知'}    站点：${v.site || '—'}`,
    `状态：${STATUS_TEXT[v.status] || v.status}    进度：${(v.progress || 0).toFixed(1)}%`,
  ];
  if (v.duration) lines.push(`时长：${fmtDuration(v.duration)}`);
  if (v.file_size) lines.push(`体积：${fmtBytes(v.file_size)}`);
  if (v.file_path) lines.push(`文件：${v.file_path}`);
  if (v.transcoded_path) lines.push(`转码产物：${v.transcoded_path}`);
  if (v.error) lines.push(`错误：${v.error}`);
  lines.push('');
  lines.push('可选操作（输入序号）：');
  lines.push(' 1 = 备注');
  lines.push(' 2 = 转码（剪辑用）');
  lines.push(' 3 = 复制文件路径');
  lines.push(' 4 = 删除记录（保留文件）');
  lines.push(' 5 = 删除记录并删除文件');
  lines.push(' 6 = 重试 / 继续下载');
  lines.push(' 0 = 什么都不做');

  const pick = window.prompt(lines.join('\n'), '0');
  if (pick === null || pick === '0' || pick === '') return;

  try {
    if (pick === '1') {
      const notes = window.prompt('备注：', v.notes || '');
      if (notes === null) return;
      await api('POST', `/api/videos/${id}/action`, { action: 'notes', notes });
      toast('备注已保存', 'ok');
    } else if (pick === '2') {
      await renderPresets();
      const list = state.presets.map((p, i) => ` ${i + 1} = ${p.label}  (.${p.ext})`).join('\n');
      const sel = window.prompt('选择转码预设：\n' + list, '1');
      if (!sel) return;
      const preset = state.presets[Number(sel) - 1];
      if (!preset) { toast('序号无效', 'bad'); return; }
      await api('POST', `/api/videos/${id}/transcode`, { preset: preset.key });
      toast('已开始转码，完成后会有「已转码」标记', 'ok');
    } else if (pick === '3') {
      try { await navigator.clipboard.writeText(v.file_path || ''); toast('已复制路径', 'ok'); }
      catch { window.prompt('手动复制：', v.file_path || ''); }
    } else if (pick === '4') {
      if (!window.confirm('从库里删除这条记录？磁盘上的文件会保留。')) return;
      await api('DELETE', `/api/videos/${id}?keepFile=1`);
      toast('记录已删除，文件保留', 'ok');
    } else if (pick === '5') {
      if (!window.confirm('删除记录并永久删除磁盘文件？此操作不可恢复。')) return;
      await api('DELETE', `/api/videos/${id}`);
      toast('记录与文件已删除', 'ok');
    } else if (pick === '6') {
      await api('POST', `/api/videos/${id}/action`, { action: 'resume' });
      toast('已加入队列', 'ok');
      refreshQueue();
    }
    loadLibrary({ reset: true });
  } catch (err) { toast('操作失败：' + err.message, 'bad'); }
}

// ───────────────────────────────────────────── 播放器

async function openPlayer(id) {
  let v = state.library.find((x) => x.id === id) ||
          [...state.queue.values()].find((x) => x.id === id);
  if (!v) { try { v = await api('GET', `/api/videos/${id}/refresh`); } catch {} }
  if (!v) { v = { id, title: '视频 #' + id }; }

  state.player.id = id;
  state.player.source = 'original';
  $('#playerTitle').textContent = v.title || v.url || ('#' + id);

  const sel = $('#playerSource');
  sel.innerHTML = '<option value="original">原始文件</option>' +
    (v.transcoded_path ? '<option value="transcoded">转码产物</option>' : '');
  sel.value = 'original';

  updatePlayerSrc(id, 'original');

  const meta = [];
  if (v.uploader) meta.push('作者：' + v.uploader);
  if (v.site) meta.push('站点：' + v.site);
  if (v.duration) meta.push('时长：' + fmtDuration(v.duration));
  if (v.height) meta.push(v.height + 'p');
  if (v.file_size) meta.push(fmtBytes(v.file_size));
  if (v.file_path) meta.push('文件：' + v.file_path);
  $('#playerMeta').textContent = meta.join('　·　');

  $('#playerModal').hidden = false;
}

function updatePlayerSrc(id, source) {
  const url = `/api/videos/${id}/file?source=${source}`;
  const player = $('#player');
  player.src = url;
  $('#playerDownload').href = url;
}

$('#playerSource').addEventListener('change', (e) => {
  updatePlayerSrc(state.player.id, e.target.value);
});

$('#playerClose').addEventListener('click', closePlayer);
$('#playerModal').addEventListener('click', (e) => {
  if (e.target.id === 'playerModal') closePlayer();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#playerModal').hidden) closePlayer();
});

function closePlayer() {
  const p = $('#player');
  p.pause();
  p.removeAttribute('src');
  p.load();
  $('#playerModal').hidden = true;
}

// ───────────────────────────────────────────── SSE 实时更新

function connectSSE() {
  const es = new EventSource('/api/stream');
  let lastLiveCount = -1;   // 用来检测"有任务结束"，从而刷新最近任务

  es.addEventListener('progress', (e) => {
    const v = JSON.parse(e.data);
    const known = state.queue.get(v.id);
    if (known) {
      const statusChanged = known.status !== v.status;
      Object.assign(known, v);
      if (statusChanged) {
        known._active = !['done', 'failed', 'canceled', 'paused'].includes(v.status);
        renderQueue();
      } else {
        patchQueue();
      }
    } else if (['queued', 'parsing', 'downloading', 'processing'].includes(v.status)) {
      state.queue.set(v.id, { ...v, _active: true });
      state.queueOrder = [...state.queue.keys()];
      renderQueue();
    }
    // 库页面：完成的任务直接就地更新那张卡
    if (state.view === 'library') {
      const idx = state.library.findIndex((x) => x.id === v.id);
      if (idx >= 0) {
        state.library[idx] = { ...state.library[idx], ...v };
        if (v.status === 'done') { renderLibrary(); loadFacets(); }
      }
    }
  });

  es.addEventListener('queue', (snap) => {
    const live = new Set(snap.running.map((r) => r.id));
    for (const r of snap.running) {
      const known = state.queue.get(r.id);
      if (known) Object.assign(known, r);
      else state.queue.set(r.id, { ...r, _active: true });
    }
    for (const [id, item] of [...state.queue]) {
      if (item._active && !live.has(id)) {
        // 任务已结束，从活动队列移除（最近任务里还能看到）
        state.queue.delete(id);
        state.loggedOpen.delete(id);
      }
    }
    state.queueOrder = [...state.queue.keys()];
    renderQueue();
    // 有任务离开活动队列 = 它刚结束，需要刷新"最近任务"把它带过来
    if (snap.running.length !== lastLiveCount) {
      lastLiveCount = snap.running.length;
      refreshQueue();
    }
  });

  es.addEventListener('library', () => {
    refreshQueue();   // 删除/清空后历史与计数要跟着更新
    if (state.view === 'library') loadLibrary({ reset: true });
  });

  es.addEventListener('settings', () => loadHealth());

  es.onerror = () => {
    $('#engineDot').className = 'dot dot-bad';
    $('#engineText').textContent = '与服务断开，重连中…';
  };
  es.onopen = () => loadHealth();
}

// ───────────────────────────────────────────── 启动

(async function init() {
  // 先恢复本机偏好与上次填的表单/报告：
  // 服务端的队列和库是持久的，前端不该一刷新就把用户输入清空。
  restoreLibraryPrefs();
  restoreAddForm();
  const prefs = loadPrefs();
  state.historyOpen = !!prefs.historyOpen;

  await loadHealth();
  refreshQueue();
  connectSSE();
})();
