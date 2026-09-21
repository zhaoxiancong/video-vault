/**
 * 前端入口 —— 组装所有视图，接上 SSE。
 *
 * 这个文件只做**接线**：把 DOM 事件、视图模块、API 连起来。
 * 任何具体的渲染或业务逻辑都应该在 views/ 里。
 *
 * 注意：`type="module"` 的脚本天然是 deferred 的，所以这里可以
 * 直接在顶层操作 DOM，不需要再包一层 DOMContentLoaded。
 */

import { api, formatError, connectStream } from './api.js';
import { $, $$, el, replace } from './dom.js';
import { state, savePrefs } from './state.js';
import { toast } from './ui.js';

import { initAddView } from './views/add.js';
import {
  initQueueView, bindQueueActions, refreshQueue, renderQueue,
  onProgress, onQueueSnapshot, showLog, setConnected,
} from './views/queue.js';
import { initLibraryView, reload as reloadLibrary, renderLibrary } from './views/library.js';
import {
  initSettingsView, fillSettings, renderEngineStatus, renderPresets,
} from './views/settings.js';
import { initPlayer, openPlayer } from './views/player.js';

// ---------------------------------------------------------------- 接线

const goLibrary = () => reloadLibrary({ reset: true });

function boot() {
  initAddView({ onSubmitted: () => { refreshQueue(); } });
  initQueueView({ onPlay: (id) => openPlayer(id) });
  bindQueueActions({
    onPlay: (id) => openPlayer(id),
    onViewLog: (id) => showLog(id),
    onDeleted: () => goLibrary(),
  });
  initLibraryView({ onPlay: (id, src) => openPlayer(id, src) });
  initSettingsView();
  initPlayer();

  // 标签页切换
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) switchView(btn.dataset.view);
  });
  switchView(state.prefs.tab || 'add');

  connect();
  loadHealth();
  refreshQueue();
  goLibrary();
}

function switchView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  savePrefs({ tab: name });

  // 切到库页时刷新一次（别的操作可能改了数据）
  if (name === 'library') reloadLibrary({ reset: true });
}

// ---------------------------------------------------------------- 数据加载

async function loadHealth() {
  try {
    const h = await api('GET', '/api/health');
    state.health = h;

    const dot = $('#engineDot');
    const txt = $('#engineText');
    if (h.ok) {
      dot.className = 'dot dot-ok';
      txt.textContent = `引擎就绪 · yt-dlp ${String(h.engines.ytdlp.version).slice(0, 10)}`;
    } else {
      dot.className = 'dot dot-bad';
      txt.textContent = '引擎缺失，请检查 tools/bin';
    }
    $('#hintDir').textContent = h.downloads;

    fillSettings(h.settings);
    renderEngineStatus();

    // 添加页的限速下拉跟设置保持一致（正在操作时不打断用户）
    const rt = $('#optRate');
    if (rt && document.activeElement !== rt) rt.value = String(h.settings.rateLimitMB || 0);

    // 转码预设
    if (!state.presets) {
      state.presets = await api('GET', '/api/transcode-presets');
    }
    renderPresets(state.presets);
  } catch {
    $('#engineDot').className = 'dot dot-bad';
    $('#engineText').textContent = '无法连接服务';
  }
}

/**
 * 接上 SSE 实时推送。
 *
 * 断线由浏览器自动重连，但**重连后必须重新拉一次全量状态** ——
 * 断线期间发生的变化是收不到的，光靠增量会一直显示旧数据。
 */
function connect() {
  connectStream({
    queue: (snap) => onQueueSnapshot(snap),
    progress: (v) => {
      onProgress(v);
      // 库页里同一条记录的进度也要跟着变
      const row = state.library.rows.find((r) => r.id === v.id);
      if (row) {
        Object.assign(row, v);
        if (state.prefs.tab === 'library') renderLibrary();
      }
    },
    notice: (n) => toast(n.message, 'warn'),
    settings: (s) => fillSettings(s),
    library: () => goLibrary(),
    connected: () => {
      setConnected(true);
      // 重连成功 → 补一次全量，把断线期间漏掉的补回来
      loadHealth();
      refreshQueue();
      goLibrary();
    },
    disconnected: () => setConnected(false),
  });
}

// 页面从后台切回前台时也补一次（后台标签页的 SSE 可能被节流）
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshQueue();
    if (state.prefs.tab === 'library') reloadLibrary({ reset: true });
  }
});

// ---------------------------------------------------------------- 启动

try {
  boot();
  // 给 body 打个标记，表示"入口模块被浏览器成功加载并执行完了"。
  // 用途：UI 冒烟测试靠它区分"模块没加载"和"加载了但渲染不对"——
  // 这两种故障的排查方向完全不同。
  document.body.dataset.booted = '1';
} catch (err) {
  // 启动阶段就崩了的话，一定要让用户看见 —— 否则就是一片空白的页面
  document.body.append(el('div', { class: 'boot-error' }, [
    el('h2', { text: '界面启动失败' }),
    el('p', { text: formatError(err) }),
    el('pre', { text: err && err.stack ? err.stack : String(err) }),
  ]));
}
