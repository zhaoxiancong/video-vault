/**
 * 轻提示 + 确认框。
 *
 * 确认框是**故意**不替换成浏览器原生 confirm 的：删除这类操作要显示
 * 具体会删什么（文件保不保留），原生的两按钮对话框说不清。
 */

import { $, el, replace } from './dom.js';

/** 右下角飘一条提示 */
export function toast(message, kind = '') {
  const host = $('#toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}` }, String(message));
  host.append(node);
  // 入场动画（浏览器会在下一帧应用 class）
  requestAnimationFrame(() => node.classList.add('in'));
  setTimeout(() => {
    node.classList.remove('in');
    setTimeout(() => node.remove(), 250);
  }, kind === 'bad' ? 6000 : 3000);
}

/**
 * 确认框。
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string|Node} opts.body
 * @param {Array<{label:string, value:any, tone?:string, primary?:boolean}>} opts.actions
 * @returns {Promise<any>} 选中的 value；按 ESC / 点遮罩返回 null
 */
export function confirmDialog({ title, body, actions }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    const close = (value) => {
      modal.hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };

    const box = el('div', { class: 'dialog' }, [
      el('h3', { text: title }),
      typeof body === 'string' ? el('p', { class: 'dialog-body', text: body }) : body,
      el('div', { class: 'dialog-actions' }, actions.map((a) => el('button', {
        class: `btn ${a.primary ? 'btn-primary' : ''} ${a.tone === 'danger' ? 'btn-danger' : ''}`,
        type: 'button',
        text: a.label,
        onclick: () => close(a.value),
      }))),
    ]);

    replace(modal, box);
    modal.hidden = false;
    document.addEventListener('keydown', onKey);
    // 点遮罩 = 取消
    modal.onclick = (e) => { if (e.target === modal) close(null); };
    const first = box.querySelector('.btn-primary') || box.querySelector('.btn');
    if (first) first.focus();
  });
}
