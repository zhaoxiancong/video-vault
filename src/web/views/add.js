/**
 * 「添加下载」页：粘链接、选参数、看提交报告。
 *
 * 表单内容会 persist 到 localStorage —— 用户粘了二十个链接、刷新了一下页面
 * 发现全没了，是会骂人的。
 */

import { api, formatError } from '../api.js';
import {
  $, el, replace, clear, fmtBytes, fmtDuration, debounce, safeStorage,
} from '../dom.js';
import { state, savePrefs } from '../state.js';
import { toast } from '../ui.js';

const QUALITIES = [
  ['best', '最高可用'], ['2160p', '4K (2160p)'], ['1440p', '2K (1440p)'],
  ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p'], ['360p', '360p'],
  ['worst', '最小体积'],
];

const RATES = [[0, '不限速（最快）'], [10, '10 MB/s'], [5, '5 MB/s'], [2, '2 MB/s'], [1, '1 MB/s']];

export function initAddView({ onSubmitted }) {
  const form = state.prefs.addForm;

  // ---- 恢复上次填的内容
  $('#urlBox').value = form.urls || '';
  $('#optKind').value = form.kind || 'video';
  $('#optQuality').value = form.quality || 'best';
  $('#optRate').value = String(form.rate ?? 0);
  $('#optForceList').checked = Boolean(form.forcePlaylist);

  const collect = () => ({
    urls: $('#urlBox').value,
    kind: $('#optKind').value,
    quality: $('#optQuality').value,
    rate: Number($('#optRate').value),
    forcePlaylist: $('#optForceList').checked,
  });

  // 边填边存（防抖，不然每敲一个字写一次 localStorage）
  const persist = debounce(() => savePrefs({ addForm: collect() }), 300);
  for (const id of ['#urlBox', '#optKind', '#optQuality', '#optRate', '#optForceList']) {
    $(id).addEventListener('input', persist);
    $(id).addEventListener('change', persist);
  }

  // 仅音频时隐藏清晰度（它没有意义）
  const syncKind = () => {
    $('#fieldQuality').style.display = $('#optKind').value === 'audio' ? 'none' : '';
  };
  $('#optKind').addEventListener('change', syncKind);
  syncKind();

  // 限速写进后端设置，对**后续所有任务**生效。
  // 它是"下载速度"最大的变量，所以放在这里直接可调，不用翻到设置页。
  $('#optRate').addEventListener('change', async () => {
    try {
      await api('PATCH', '/api/settings', { rateLimitMB: Number($('#optRate').value) });
    } catch (err) {
      toast(`限速没保存成功：${formatError(err)}`, 'bad');
    }
  });

  // ---- 提交
  $('#btnAdd').addEventListener('click', async () => {
    const f = collect();
    const urls = f.urls.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    if (!urls.length) {
      toast('先粘几个链接进来', 'bad');
      $('#urlBox').focus();
      return;
    }

    const btn = $('#btnAdd');
    btn.disabled = true;
    btn.textContent = `提交中…（${urls.length} 个）`;
    try {
      const report = await api('POST', '/api/videos', {
        urls,
        kind: f.kind,
        quality: f.quality,
        forcePlaylist: f.forcePlaylist,
      });
      renderReport(report);
      toast(`已加入 ${report.added.length} 个任务`, report.errors.length ? 'warn' : '');
      if (onSubmitted) onSubmitted(report);
    } catch (err) {
      toast(formatError(err), 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = '加入下载队列';
    }
  });

  renderReport(state.prefs.lastReport);
}

/** 清空提交表单（提交成功后调用更符合直觉？—— 不，保留内容更安全，用户可能想改一个再提交） */
export function clearAddForm() {
  $('#urlBox').value = '';
  savePrefs({ addForm: { ...state.prefs.addForm, urls: '' } });
}

/**
 * 渲染上一次的提交报告。
 *
 * 四种结果分开列，不能混成一句"成功"：
 * 新增 / 跳过（库里已有）/ 重试（原来失败的）/ 出错
 */
export function renderReport(report) {
  const panel = $('#reportPanel');
  const body = $('#reportBody');
  if (!report) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const sections = [];

  if (report.renamed && report.renamed.length) {
    sections.push(section('已自动识别为视频地址', report.renamed.map((r) => el('div', { class: 'rep-row' }, [
      el('span', { class: 'rep-note', text: r.note || '地址已归一化' }),
      el('code', { class: 'rep-url', text: r.to }),
    ]))));
  }

  const line = (label, tone, items, render) => {
    if (!items.length) return null;
    return section(`${label}（${items.length}）`, items.map((it) => el('div', { class: `rep-row ${tone}` }, render(it))));
  };

  const parts = [
    line('新增', 'ok', report.added || [], (a) => [
      el('span', { class: 'rep-title', text: a.title || '（标题待解析）' }),
      el('code', { class: 'rep-url', text: a.url }),
    ]),
    line('库里已有，跳过', 'muted', report.skipped || [], (s) => [
      el('span', { class: 'rep-title', text: s.title || s.url }),
      el('span', { class: 'rep-note', text: s.reason }),
    ]),
    line('原来是失败/暂停，已重新排队', 'warn', report.retried || [], (r) => [
      el('span', { class: 'rep-title', text: r.title || r.url }),
    ]),
    line('出错', 'bad', report.errors || [], (e) => [
      el('span', { class: 'rep-title', text: e.error }),
      e.hint ? el('span', { class: 'rep-note', text: e.hint }) : null,
      el('code', { class: 'rep-url', text: e.url }),
    ]),
  ].filter(Boolean);

  if (report.playlists && report.playlists.length) {
    for (const p of report.playlists) {
      parts.push(el('div', { class: 'rep-playlist' }, [
        el('strong', { text: `播放列表：${p.title || p.url}` }),
        el('span', {
          class: 'rep-note',
          text: `共 ${p.count} 个，新增 ${p.added}，跳过 ${p.skipped}`,
        }),
      ]));
    }
  }

  sections.push(...parts);

  if (!sections.length) {
    replace(body, el('div', { class: 'empty', text: '这次没有产生任何变化。' }));
  } else {
    replace(body, sections);
  }

  const summary = `新增 ${(report.added || []).length} · 跳过 ${(report.skipped || []).length}`
    + ` · 重试 ${(report.retried || []).length} · 出错 ${(report.errors || []).length}`;
  replace(body, [el('div', { class: 'rep-summary', text: summary }), ...sections]);

  savePrefs({ lastReport: report });
}

function section(title, children) {
  return el('div', { class: 'rep-section' }, [
    el('h4', { class: 'rep-h', text: title }),
    ...children,
  ]);
}

/** 让别处（比如队列面板）也能顺手清掉报告 */
export function hideReport() {
  $('#reportPanel').hidden = true;
  savePrefs({ lastReport: null });
}
