'use strict';
/**
 * 登录态（Cookie）支持 —— 二期第一项。
 *
 * 背景：有些站点不登录就下不动。
 *  - 抖音：没有 Cookie 一律报 `Fresh cookies (not necessarily logged in) are needed`
 *  - B 站：1080P+ / 番剧 / 会员内容需要登录态
 *  - 部分 YouTube 年龄限制内容同理
 *
 * 设计上有三个刻意的选择：
 *
 * 1. **两种来源都支持。** 读浏览器（`--cookies-from-browser`）最省事，但有两个现实问题：
 *    浏览器开着时 cookie 数据库被锁；Chrome 新版本的加密方式 yt-dlp 未必跟得上。
 *    所以同时支持用户自己导出的 `cookies.txt` 作为兜底。
 *
 * 2. **把 yt-dlp 的报错翻译成人话。** yt-dlp 的原话对普通用户毫无意义
 *    （`Could not copy Chrome cookie database` 不会告诉用户"把浏览器关掉再试"）。
 *    这和 `lib/urldiag.js` 是同一个思路：失败信息必须能指导下一步动作。
 *
 * 3. **Cookie 是隐私。** 不打印内容、不写进日志、不进数据库。
 *    诊断输出里只出现"哪个来源、有没有读到、读到了几条"。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ytdlp = require('./ytdlp');

/** yt-dlp 支持的浏览器名（写死是有意的：传错了 yt-dlp 会直接报错退出） */
const BROWSERS = ['chrome', 'edge', 'firefox', 'brave', 'chromium', 'opera', 'vivaldi', 'safari', 'whale'];

/**
 * 把设置翻译成 yt-dlp 的 cookie 参数。
 * 没有配置就返回空数组 —— 绝不"猜一个默认浏览器"：
 * 偷偷读用户浏览器 cookie 是不可接受的，必须是用户显式要的。
 *
 * @param {object} settings
 * @returns {{args: string[], source: string, detail: string, warning: string|null}}
 */
function cookieArgs(settings = {}) {
  const browser = String(settings.cookiesFromBrowser || '').trim().toLowerCase();
  const file = String(settings.cookiesFile || '').trim();

  // 文件优先于浏览器：用户显式指定了文件，说明他知道自己在干什么
  if (file) {
    const resolved = path.isAbsolute(file) ? file : path.resolve(file);
    if (!fs.existsSync(resolved)) {
      return {
        args: [],
        source: 'file',
        detail: resolved,
        warning: `Cookie 文件不存在：${resolved}`,
      };
    }
    return {
      args: ['--cookies', resolved],
      source: 'file',
      detail: resolved,
      warning: validateCookieFile(resolved),
    };
  }

  if (browser && browser !== 'none') {
    if (!BROWSERS.includes(browser)) {
      return {
        args: [],
        source: 'browser',
        detail: browser,
        warning: `不认识的浏览器「${browser}」，支持：${BROWSERS.join(' / ')}`,
      };
    }
    return {
      args: ['--cookies-from-browser', browser],
      source: 'browser',
      detail: browser,
      warning: null,
    };
  }

  return { args: [], source: 'none', detail: '', warning: null };
}

/**
 * 粗查 cookies.txt 是不是 Netscape 格式。
 * 不做严格解析 —— 只要能看出"这不像 cookie 文件"就够了，
 * 精确校验交给 yt-dlp（它才是权威）。
 */
function validateCookieFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').slice(0, 4096);
    if (!text.trim()) return '这个文件是空的';
    if (/^# (HTTP Cookie File|Netscape)/im.test(text)) return null;
    // Netscape 格式的每行是 7 个 tab 分隔字段
    const looksRight = text.split(/\r?\n/)
      .some((l) => l.trim() && !l.startsWith('#') && l.split('\t').length >= 6);
    if (!looksRight) {
      return '这个文件看起来不是 Netscape 格式的 cookies.txt。'
        + '浏览器插件导出的 JSON 格式 yt-dlp 不认，请用「导出为 Netscape/cookies.txt」的插件。';
    }
    return null;
  } catch (e) {
    return `读不了这个文件：${e.message}`;
  }
}

/** 找出用户机器上实际装了哪些浏览器（只报告，不读 cookie） */
function detectBrowsers() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const candidates = {
    chrome: [path.join(local, 'Google', 'Chrome', 'User Data')],
    edge: [path.join(local, 'Microsoft', 'Edge', 'User Data')],
    firefox: [path.join(roaming, 'Mozilla', 'Firefox', 'Profiles')],
    brave: [path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    chromium: [path.join(local, 'Chromium', 'User Data')],
    opera: [path.join(roaming, 'Opera Software', 'Opera Stable')],
    vivaldi: [path.join(local, 'Vivaldi', 'User Data')],
  };
  const found = [];
  for (const [name, dirs] of Object.entries(candidates)) {
    if (dirs.some((d) => { try { return fs.existsSync(d); } catch { return false; } })) found.push(name);
  }
  return found;
}

/**
 * 把 yt-dlp 的 cookie 相关报错翻译成人话。
 *
 * yt-dlp 的原话对用户毫无意义。这个函数把"它说了什么"变成"你该做什么"。
 * 返回 null 表示这条报错跟 cookie 无关，交给别的处理。
 *
 * @returns {{title:string, hint:string, kind:string}|null}
 */
function explainCookieError(raw) {
  const t = String(raw || '');
  if (!t) return null;

  if (/Could not copy Chrome cookie database/i.test(t)
    || /could not copy .* cookie database/i.test(t)) {
    return {
      kind: 'browser-locked',
      title: '浏览器正开着，Cookie 数据库被锁住了',
      hint: '把 Chrome（或你选的那个浏览器）完全退出再试一次。'
        + '如果不想关浏览器，改用导出的 cookies.txt：装一个"Get cookies.txt"类插件，'
        + '导出后在「设置 → 登录态」里选「用 cookies.txt 文件」。',
    };
  }

  if (/Fresh cookies \(not necessarily logged in\) are needed/i.test(t)) {
    return {
      kind: 'cookies-required',
      title: '这个站点要求带 Cookie 才能解析',
      hint: '在「设置 → 登录态」里选一个浏览器（如 chrome），或者指定自己导出的 cookies.txt。'
        + '抖音这类站即使不登录也要求有 Cookie，所以随便配一个通常就能过。',
    };
  }

  if (/cookies? (are )?(not )?(available|found)|no cookies/i.test(t) && /cookie/i.test(t)) {
    return {
      kind: 'no-cookies',
      title: '没读到有效的 Cookie',
      hint: '确认选对了浏览器（你平时用哪个登录就选哪个），并且那个浏览器里确实登录过这个站。',
    };
  }

  if (/failed to decrypt|decrypt.*cookie|DPAPI/i.test(t)) {
    return {
      kind: 'decrypt-failed',
      title: '解不开浏览器的 Cookie（Chrome 新版加密变了）',
      hint: '这是 yt-dlp 与 Chrome 版本之间的已知摩擦。两个办法：'
        + '① 把 yt-dlp 更新到最新版（见 README 第 11 节）；'
        + '② 改用导出的 cookies.txt，绕开浏览器解密。',
    };
  }

  if (/Unsupported browser|unsupported.*browser/i.test(t)) {
    return {
      kind: 'bad-browser',
      title: 'yt-dlp 不认识这个浏览器',
      hint: `可用的是：${BROWSERS.join(' / ')}。`,
    };
  }

  if (/cookies\.txt|Netscape format|does not look like a Netscape/i.test(t)) {
    return {
      kind: 'bad-file',
      title: '这个 cookie 文件格式不对',
      hint: 'yt-dlp 只认 Netscape 格式的 cookies.txt（每行 7 个 tab 分隔字段）。'
        + '浏览器插件默认导出的 JSON 不行，导出时请选 cookies.txt 格式。',
    };
  }

  return null;
}

/** 失败提示：如果这条错误能翻译，就把翻译附在原文后面 */
function decorateError(raw) {
  const e = explainCookieError(raw);
  if (!e) return raw;
  return `${e.title} —— ${e.hint}\n（引擎原话：${String(raw).slice(0, 200)}）`;
}

/**
 * 实测 Cookie 到底能不能用 —— 真的拿一个需要登录态的地址跑一次解析。
 *
 * 为什么值得真跑一次：设置页上写"已配置"毫无说服力。用户需要知道的是
 * **现在能不能下**。而 cookie 失效（登录过期）、被锁、格式不对，都只有
 * 真跑一次才暴露。
 *
 * 刻意做得很轻：只解析元数据、只取第一个格式、不下任何东西、30 秒硬超时。
 */
async function testCookies(settings = {}, {
  url = 'https://www.douyin.com/video/7671972624104197391',
  timeout = 30000,
} = {}) {
  const c = cookieArgs(settings);

  if (c.source === 'none') {
    return {
      ok: false,
      configured: false,
      source: 'none',
      title: '还没配置登录态',
      hint: '有些站点（抖音、B 站高清、会员内容）必须带 Cookie 才能下载。'
        + '在上面选一个浏览器，或者指定自己导出的 cookies.txt。',
    };
  }

  if (c.warning) {
    // 配置本身就有问题，不用浪费一次网络请求
    return {
      ok: false,
      configured: true,
      source: c.source,
      detail: c.detail,
      title: '配置有问题',
      hint: c.warning,
    };
  }

  const result = ytdlp.probeWithArgs(url, c.args, { timeout });
  const raw = `${result.error || ''}`;

  if (result.ok) {
    return {
      ok: true,
      configured: true,
      source: c.source,
      detail: c.detail,
      title: '登录态可用',
      hint: c.source === 'browser'
        ? `已经从 ${c.detail} 读到 Cookie，解析测试地址成功。`
        : 'cookies.txt 读到了，解析测试地址成功。',
      sample: result.title || '',
    };
  }

  const explained = explainCookieError(raw);
  return {
    ok: false,
    configured: true,
    source: c.source,
    detail: c.detail,
    title: explained ? explained.title : '带 Cookie 解析仍然失败',
    hint: explained ? explained.hint : (raw.slice(0, 300) || '引擎没有给出原因'),
    raw: raw.slice(0, 400),
  };
}

module.exports = {
  BROWSERS,
  cookieArgs,
  validateCookieFile,
  detectBrowsers,
  explainCookieError,
  decorateError,
  testCookies,
};
