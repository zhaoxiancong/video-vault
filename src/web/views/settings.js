/**
 * 「设置」页：下载参数、登录态、引擎状态。
 *
 * 登录态的「测试」按钮是这一页最值钱的东西 —— 它**真的**拿一个需要登录态的
 * 地址跑一次解析，而不是只回一句"已配置"。原因：cookie 会过期、会被浏览器锁住、
 * 格式可能不对，这些都只有真跑一次才暴露。设置页写"已保存"毫无说服力，
 * 用户想知道的是"现在到底能不能下"。
 */

import { api, formatError } from '../api.js';
import { $, el, replace, clear } from '../dom.js';
import { state } from '../state.js';
import { toast } from '../ui.js';

export function initSettingsView() {
  $('#btnSaveSettings').addEventListener('click', save);
  $('#btnTestCookies').addEventListener('click', testCookies);
  $('#cookiesWhat').addEventListener('click', openCookieHelp);
}

/** 把服务端的设置填进表单 */
export function fillSettings(settings) {
  if (!settings) return;
  const set = (id, val) => {
    const n = $(id);
    // 正在输入的框不要抢用户的编辑
    if (n && document.activeElement !== n) n.value = val ?? '';
  };
  set('#setDir', settings.downloadDir);
  set('#setConcurrency', settings.concurrency);
  set('#setRate', settings.rateLimitMB);
  set('#setFrag', settings.fragmentConcurrency);
  set('#setRetries', settings.retries);
  $('#setOrganize').checked = settings.organizeByUploader !== false;

  // 登录态
  const cb = $('#setCookieBrowser');
  const want = settings.cookiesFromBrowser || '';
  // 下拉里没有的值（用户手改过配置）就补进去，别让界面显示成"不用"
  if (cb && want && ![...cb.options].some((o) => o.value === want)) {
    cb.append(el('option', { value: want, text: want }));
  }
  if (cb && document.activeElement !== cb) cb.value = want;
  set('#setCookieFile', settings.cookiesFile);
}

async function save() {
  const btn = $('#btnSaveSettings');
  const hint = $('#saveHint');
  btn.disabled = true;
  try {
    const next = await api('PATCH', '/api/settings', {
      downloadDir: $('#setDir').value.trim(),
      concurrency: Number($('#setConcurrency').value),
      rateLimitMB: Number($('#setRate').value),
      fragmentConcurrency: Number($('#setFrag').value),
      retries: Number($('#setRetries').value),
      organizeByUploader: $('#setOrganize').checked,
      cookiesFromBrowser: $('#setCookieBrowser').value,
      cookiesFile: $('#setCookieFile').value.trim(),
    });

    // 配置有问题（比如 cookies.txt 路径不存在）要**当场**说，用 textContent
    // 而不是 innerHTML —— 提示里会带用户填的路径
    if (next && next._warning) {
      hint.textContent = `已保存，但：${next._warning}`;
      hint.style.color = 'var(--amber)';
      toast('设置已保存，但有一处需要处理', 'warn');
    } else {
      hint.textContent = '已保存 ✓';
      hint.style.color = '';
      toast('设置已保存');
    }
    setTimeout(() => { hint.textContent = ''; hint.style.color = ''; }, 6000);
    state.health = await api('GET', '/api/health');
    renderEngineStatus();
  } catch (err) {
    toast(formatError(err), 'bad');
    hint.textContent = formatError(err);
    hint.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

async function testCookies() {
  const btn = $('#btnTestCookies');
  const box = $('#cookieResult');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '测试中…（最多 30 秒）';

  try {
    // 带上界面上**当前填的值**测 —— 用户想知道的是"我现在填的这套能不能用"，
    // 而不是"上次保存的那套"
    const r = await api('POST', '/api/cookies/test', {
      cookiesFromBrowser: $('#setCookieBrowser').value,
      cookiesFile: $('#setCookieFile').value.trim(),
    });
    renderCookieResult(r);
  } catch (err) {
    toast(formatError(err), 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/**
 * 渲染登录态自检结果。
 *
 * 全程用 el()/textContent 建节点，不拼 innerHTML —— `r.raw` 是引擎原话，
 * 里面可能带尖括号，拼进 HTML 会被吃掉或注入。
 */
function renderCookieResult(r) {
  const box = $('#cookieResult');
  box.hidden = false;
  box.className = `cookie-result ${r.ok ? 'ok' : 'bad'}`;

  const children = [
    el('div', { class: 'cookie-result-title', text: `${r.ok ? '✅' : '⚠️'} ${r.title || ''}` }),
  ];
  if (r.hint) children.push(el('div', { class: 'cookie-result-hint', text: r.hint }));
  if (r.sample) {
    children.push(el('div', { class: 'cookie-result-hint', text: `测试解析到的标题：${r.sample}` }));
  }
  if (r.raw && !r.ok) {
    children.push(el('details', {}, [
      el('summary', { text: '引擎原始输出' }),
      el('pre', { class: 'cookie-raw', text: r.raw }),
    ]));
  }
  replace(box, children);
}

/** Cookie 帮助：怎么写、放哪、格式要求 */
function openCookieHelp() {
  const modal = $('#modal');
  const close = () => { modal.hidden = true; };
  replace(modal, el('div', { class: 'dialog dialog-wide' }, [
    el('h3', { text: '登录态（Cookie）怎么配' }),
    el('div', { class: 'help-body' }, [
      el('h4', { text: '方式一：读浏览器登录态（最省事）' }),
      el('p', { text: '在上面选你平时登录那个站用的浏览器。注意：读浏览器 Cookie 需要那个浏览器完全退出 —— 浏览器开着时它的数据库被锁住，读不到（工具会明确告诉你这一点）。' }),

      el('h4', { text: '方式二：用 cookies.txt 文件（更稳）' }),
      el('p', { text: '装一个「Get cookies.txt」类浏览器扩展，登录目标站后导出，导出格式选 Netscape / cookies.txt。然后在上面填文件的绝对路径。' }),
      el('p', { class: 'warn-text', text: '注意：扩展默认导出的 JSON 格式引擎不认，必须选 cookies.txt 格式。仓库里的 cookies.sample.txt 有格式说明。' }),

      el('h4', { text: '两种都填了会怎样' }),
      el('p', { text: '文件优先。因为显式指定文件说明你清楚自己在做什么。' }),

      el('h4', { text: '隐私' }),
      el('p', { text: '默认不读任何 Cookie，必须由你显式开启。Cookie 内容不写日志、不入库、不回显 —— 诊断信息里只有"哪个来源、有没有读到"，没有内容本身。' }),
    ]),
    el('div', { class: 'dialog-actions' }, [
      el('button', { class: 'btn btn-primary', type: 'button', text: '知道了', onclick: close }),
    ]),
  ]));
  modal.hidden = false;
  modal.onclick = (e) => { if (e.target === modal) close(); };
}

/** 引擎状态 + 中断提示 */
export function renderEngineStatus() {
  const h = state.health;
  if (!h) return;
  const e = h.engines;

  replace($('#healthBody'), [
    el('dt', { text: 'yt-dlp' }),
    el('dd', { text: e.ytdlp.ok ? e.ytdlp.version : `❌ ${e.ytdlp.error || '不可用'}` }),
    el('dt', { text: 'yt-dlp 路径' }),
    el('dd', { text: e.ytdlp.path }),
    el('dt', { text: 'ffmpeg' }),
    el('dd', { text: e.ffmpeg.ok ? `✅ ${String(e.ffmpeg.version).split(' ').slice(0, 3).join(' ')}` : `❌ ${e.ffmpeg.error || '不可用'}` }),
    el('dt', { text: '下载目录' }),
    el('dd', { text: h.downloads }),
    el('dt', { text: '版本' }),
    el('dd', { text: h.version || '—' }),
  ]);

  const ih = $('#interruptHint');
  if (h.queuedInterrupted > 0) {
    ih.hidden = false;
    replace(ih, [
      '上次有 ', el('b', { text: String(h.queuedInterrupted) }),
      ' 个任务没跑完（已暂停/失败）。到「添加下载」页点「全部继续」即可接着下，已下载的部分不会重来。',
    ]);
  } else {
    ih.hidden = true;
  }

  // 引擎不完整时给一句能照做的提示
  if (!e.ytdlp.ok || !e.ffmpeg.ok) {
    toast('引擎不完整：跑 `node tools/bootstrap-engine.js` 把它装回来', 'bad');
  }
}
