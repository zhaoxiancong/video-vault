/**
 * 播放弹层。
 *
 * 服务端实现了 HTTP Range，所以拖动进度条是可用的（返回 206）。
 */

import { api, formatError } from '../api.js';
import { $, el, replace, fmtBytes, fmtDuration } from '../dom.js';
import { toast } from '../ui.js';
import { state } from '../state.js';

let current = null;

export function initPlayer() {
  $('#playerClose').addEventListener('click', closePlayer);
  $('#playerModal').addEventListener('click', (e) => {
    if (e.target === $('#playerModal')) closePlayer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#playerModal').hidden) closePlayer();
  });
}

/**
 * @param {number} id
 */
export async function openPlayer(id) {
  const v = state.library.rows.find((r) => r.id === id);
  current = id;

  const modal = $('#playerModal');
  $('#playerTitle').textContent = (v && v.title) || `任务 ${id}`;

  loadSource(id);
  renderMeta(v);
  modal.hidden = false;
}

function loadSource(id) {
  const player = $('#player');
  const url = `/api/videos/${id}/file`;
  player.src = url;
  $('#playerDownload').href = url;
  player.play().catch(() => {
    // 自动播放被浏览器拦掉是正常的，用户点一下就行 —— 不是错误，别弹提示
  });
}

function renderMeta(v) {
  if (!v) {
    replace($('#playerMeta'), []);
    return;
  }
  const bits = [
    v.site, v.uploader,
    v.height ? `${v.height}p` : null,
    v.fps ? `${v.fps}fps` : null,
    v.vcodec, v.acodec,
    v.file_size ? fmtBytes(v.file_size) : null,
    v.duration ? fmtDuration(v.duration) : null,
  ].filter(Boolean);
  replace($('#playerMeta'), [
    el('div', { class: 'pm-line', text: bits.join(' · ') }),
    v.file_path ? el('code', { class: 'pm-path', text: v.file_path }) : null,
  ]);
}

export function closePlayer() {
  const player = $('#player');
  try {
    player.pause();
    player.removeAttribute('src');
    player.load();   // 断掉连接，别让服务端一直挂着这个 Range 请求
  } catch { /* 忽略 */ }
  $('#playerModal').hidden = true;
  current = null;
}
