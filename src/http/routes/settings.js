'use strict';
/**
 * 设置与登录态路由。
 *
 * 设置接口有一条**必须守住**的语义：未知的键要**明确报错**，不能静默忽略。
 * 重构前 `setSettings()` 只接受已知键、其余悄悄丢掉 —— 前端把字段名拼错一个字母，
 * 用户看到"已保存 ✓"，实际上什么都没存，而且没有任何地方会告诉他。
 */

const { json, readJsonBody } = require('../router');
const { validate } = require('../validate');
const cookies = require('../../app/cookies');
const { ValidationError } = require('../../domain/errors');
const { DEFAULT_SETTINGS } = require('../../infra/config');

/**
 * 设置项的校验规则。
 * 只有列在这里的键可以被写 —— 白名单同时挡住了"前端乱塞字段"和"拼错字段名"。
 */
const SETTINGS_SCHEMA = {
  downloadDir: { type: 'string', maxLength: 1000 },
  concurrency: { type: 'number', integer: true, min: 1, max: 6 },
  rateLimitMB: { type: 'number', min: 0, max: 200 },
  fragmentConcurrency: { type: 'number', integer: true, min: 1, max: 16 },
  retries: { type: 'number', integer: true, min: 0, max: 10 },
  organizeByUploader: { type: 'boolean' },
  audioFormat: { type: 'string', enum: ['mp3', 'm4a', 'opus', 'flac', 'wav'] },
  videoContainer: { type: 'string', enum: ['mp4', 'mkv'] },
  embedThumbnail: { type: 'boolean' },
  transcodeTarget: { type: 'string', maxLength: 40 },
  deletePartOnCancel: { type: 'boolean' },
  cookiesFromBrowser: { type: 'string', maxLength: 30 },
  cookiesFile: { type: 'string', maxLength: 1000 },
};

/** 每个设置的说明，直接给前端用来渲染提示文案（避免两处维护） */
const SETTINGS_DOCS = {
  concurrency: { label: '并发任务数', hint: '同时下几个。调高会更容易被站点风控。' },
  rateLimitMB: { label: '每任务限速 (MB/s，0=不限)', hint: '想降低被风控概率再开。开着它下大文件时它会是唯一瓶颈。' },
  fragmentConcurrency: { label: '分片并发数', hint: '单个任务内部并行分片数，对 HLS/DASH 流提速明显。' },
  retries: { label: '失败重试次数', hint: '' },
  organizeByUploader: { label: '按「站点 / 作者」建子目录', hint: '' },
  cookiesFromBrowser: {
    label: '读取浏览器登录态',
    hint: '读浏览器 Cookie 需要那个浏览器**完全退出** —— 浏览器开着时它的数据库被锁住，读不到。',
  },
  cookiesFile: {
    label: 'cookies.txt 文件',
    hint: '优先级高于浏览器。必须是 Netscape 格式（浏览器插件导出时选 cookies.txt，JSON 引擎不认）。',
  },
};

function register(router, ctx) {
  const { repo, broadcast, scheduler } = ctx;

  // ---------------------------------------------------------------- 读设置

  router.get('/api/settings', (req, res) => {
    return json(res, 200, {
      ...repo.getSettings(),
      _docs: SETTINGS_DOCS,
      _keys: Object.keys(SETTINGS_SCHEMA),
    });
  });

  // ---------------------------------------------------------------- 写设置

  router.patch('/api/settings', async (req, res) => {
    const body = await readJsonBody(req);

    // 严格模式：出现 schema 外的键直接报错。
    // 这是"静默忽略"和"明确报错"的分界线 —— 见文件头的说明。
    const patch = validate(body, SETTINGS_SCHEMA, { strict: true });

    if (!Object.keys(patch).length) {
      throw new ValidationError('没有任何可保存的设置项', {
        hint: `可以设置的是：${Object.keys(SETTINGS_SCHEMA).join(', ')}`,
      });
    }

    // 登录态的值要额外校验：配错了要**当场**告诉用户，
    // 而不是等他下一次下载失败时才发现
    const warnings = [];
    if (patch.cookiesFromBrowser !== undefined) {
      const b = String(patch.cookiesFromBrowser || '').trim().toLowerCase();
      if (b && b !== 'none' && !cookies.BROWSERS.includes(b)) {
        throw new ValidationError(`不认识的浏览器「${b}」`, {
          hint: `支持：${cookies.BROWSERS.join(' / ')}`,
        });
      }
      patch.cookiesFromBrowser = b === 'none' ? '' : b;
    }
    if (patch.cookiesFile !== undefined && String(patch.cookiesFile || '').trim()) {
      const w = cookies.cookieArgs({ cookiesFile: patch.cookiesFile }).warning;
      if (w) warnings.push(w);
    }

    const next = repo.setSettings(patch);
    broadcast('settings', next);
    // 并发数变了要立刻重新调度（用户调高并发后当然希望马上生效）
    scheduler.kick();

    const payload = { ...next, _docs: SETTINGS_DOCS, _keys: Object.keys(SETTINGS_SCHEMA) };
    if (warnings.length) payload._warning = warnings.join('；');
    return json(res, 200, payload);
  });

  // ---------------------------------------------------------------- 登录态

  /** 报告本机装了哪些浏览器 + 当前配置状态。**只报告，不读 cookie 内容。** */
  router.get('/api/cookies/status', (req, res) => {
    const cur = repo.getSettings();
    return json(res, 200, {
      installed: cookies.detectBrowsers(),
      supported: cookies.BROWSERS,
      settings: {
        cookiesFromBrowser: cur.cookiesFromBrowser || '',
        cookiesFile: cur.cookiesFile || '',
      },
      effective: cookies.cookieArgs(cur),
    });
  });

  /**
   * 真跑一次解析，验证 Cookie 现在到底能不能用。
   *
   * 为什么要真跑：设置页写"已配置"毫无说服力，用户要知道的是"现在能不能下"。
   * 而 cookie 失效（登录过期）、被锁、格式不对，都只有真跑一次才暴露。
   */
  router.post('/api/cookies/test', async (req, res) => {
    const body = await readJsonBody(req).catch(() => ({}));
    const cur = repo.getSettings();
    // 允许带一份临时的设置来测（"我现在填的这套能不能用"），
    // 但不落库 —— 用户还没点保存呢
    const probeSettings = { ...cur, ...validate(body, SETTINGS_SCHEMA) };
    const result = await cookies.testCookies(probeSettings, {
      probeWithArgs: ctx.downloader.probeWithArgs,
    });
    return json(res, 200, result);
  });
}

module.exports = { register, SETTINGS_SCHEMA, SETTINGS_DOCS };
