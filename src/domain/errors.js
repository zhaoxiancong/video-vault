'use strict';
/**
 * 错误分类：把"引擎吐了一堆英文"翻译成"用户该做什么"。
 *
 * 这个模块存在的理由是项目里一条实测出来的教训：
 * **失败信息必须能指导下一步动作。**
 *
 * 历史上踩过的坑：
 *   - 抖音报 `Fresh cookies (not necessarily logged in) are needed` ——
 *     用户完全不知道下一步该干嘛
 *   - 粘了个列表页，yt-dlp 只回一句 `Unsupported URL` —— 用户以为工具坏了（坑 15）
 *   - 删调试代码漏了一处，报 `解析失败: trace is not defined` ——
 *     表面是解析失败，实际是**所有下载都挂了**（坑 14）
 *
 * 所以现在任何面向用户的失败都必须带上 `hint`（怎么解决）。
 * `hint` 不许为空 —— 有测试钉住这一条。
 */

/**
 * 所有面向用户的失败的基类。
 *
 * `message` 给人看（中文，说明发生了什么）
 * `hint`    给人看（中文，说明下一步做什么）—— 必填
 * `kind`    给程序看（稳定的英文标识，前端可以据此决定 UI）
 * `cause`   原始错误，排错用，不直接展示
 */
class AppError extends Error {
  constructor(message, { hint = '', kind = 'app', cause = null, status = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.hint = hint;
    this.kind = kind;
    this.cause = cause;
    this.httpStatus = status;
  }

  /** 存进数据库 error 字段的形式：主因 + 怎么办 */
  toUserText() {
    return this.hint ? `${this.message} —— ${this.hint}` : this.message;
  }

  toJSON() {
    return {
      kind: this.kind,
      message: this.message,
      hint: this.hint,
      raw: this.cause ? String(this.cause.message || this.cause).slice(0, 400) : undefined,
    };
  }
}

/** 参数/输入不合法（用户填错了） */
class ValidationError extends AppError {
  constructor(message, opts = {}) {
    super(message, { kind: 'validation', status: 400, ...opts });
  }
}

/** 找不到东西 */
class NotFoundError extends AppError {
  constructor(message, opts = {}) {
    super(message, { kind: 'not-found', status: 404, hint: opts.hint || '它可能已经被删掉了。', ...opts });
  }
}

/** 引擎（yt-dlp / ffmpeg）不可用或调用失败 */
class EngineError extends AppError {
  constructor(message, opts = {}) {
    super(message, { kind: 'engine', status: 500, ...opts });
  }
}

/**
 * 站点/引擎回复的失败 —— 这一个才是用户日常最常撞见的。
 * 带上 `category` 让上层能做统计，也方便以后加"自动重试"策略。
 */
class ProviderError extends AppError {
  constructor(message, { category = 'other', ...opts } = {}) {
    super(message, { kind: 'provider', status: 502, ...opts });
    this.category = category;
  }
}

/**
 * 失败分类表。
 *
 * 每一条都是**真的撞见过**才写进来的，不是穷举想象。
 *
 * ⚠️ **顺序有意义：靠前的先匹配，所以更具体的必须排在更笼统的前面。**
 *    这条被测试抓到过一次：`ERROR: ffmpeg not found` 本来应该匹配
 *    "引擎缺失"，但因为它排在 `HTTP Error 404|Not Found` 后面，
 *    被那条笼统的规则先吃掉了 —— 用户看到的是"地址不存在"，
 *    而真正的问题是 ffmpeg 没装。
 *    所以：**引擎缺失、cookie 相关这类"具体到某个组件"的规则排最前面。**
 */
const RULES = [
  // ── 引擎缺失（最具体，排最前）
  {
    category: 'ffmpeg-missing',
    test: /ffmpeg (is )?(not|wasn't) (found|installed)|ffmpeg-location|Postprocessing: ffmpeg|ffmpeg.*No such file/i,
    title: '找不到 ffmpeg',
    hint: '引擎文件缺失。跑一次 `node tools/bootstrap-engine.js` 把它装回来。',
  },
  {
    category: 'ytdlp-missing',
    test: /yt-dlp.*(not found|ENOENT)|spawn .*yt-dlp.*ENOENT/i,
    title: '找不到 yt-dlp',
    hint: '引擎文件缺失。跑一次 `node tools/bootstrap-engine.js` 把它装回来。',
  },

  // ── 登录态（也都比笼统的 HTTP 错误具体）
  {
    category: 'cookies-browser-locked',
    test: /Could not copy (Chrome|.*?) ?cookie database/i,
    title: '浏览器正开着，Cookie 数据库被锁住了',
    hint: '把 Chrome（或你选的那个浏览器）完全退出再试一次。'
      + '如果不想关浏览器，改用导出的 cookies.txt：装一个"Get cookies.txt"类插件，'
      + '导出后在「设置 → 登录态」里选「用 cookies.txt 文件」。',
  },
  {
    category: 'cookies-required',
    test: /Fresh cookies \(not necessarily logged in\) are needed/i,
    title: '这个站点要求带 Cookie 才能解析',
    hint: '在「设置 → 登录态」里选一个浏览器（如 chrome），或者指定自己导出的 cookies.txt。'
      + '抖音这类站即使不登录也要求有 Cookie，所以随便配一个通常就能过。',
  },
  {
    category: 'cookies-decrypt-failed',
    test: /failed to decrypt|decrypt.*cookie|DPAPI/i,
    title: '解不开浏览器的 Cookie（Chrome 新版加密变了）',
    hint: '这是 yt-dlp 与 Chrome 版本之间的已知摩擦。两个办法：'
      + '① 把 yt-dlp 更新到最新版；② 改用导出的 cookies.txt，绕开浏览器解密。',
  },
  {
    category: 'cookies-unsupported-browser',
    test: /Unsupported browser/i,
    title: 'yt-dlp 不认识这个浏览器',
    hint: '可用的浏览器见「设置 → 登录态」的下拉列表。',
  },
  {
    category: 'cookies-bad-format',
    test: /does not look like a Netscape|Netscape format/i,
    title: '这个 cookie 文件格式不对',
    hint: 'yt-dlp 只认 Netscape 格式的 cookies.txt（每行 7 个 TAB 分隔字段）。'
      + '浏览器插件默认导出的 JSON 不行，导出时请选 cookies.txt 格式。',
  },

  // ── 站点侧的具体原因
  {
    category: 'unsupported-url',
    test: /Unsupported URL/i,
    title: '这个地址引擎不认',
    hint: '如果粘的是页面地址而不是某个视频的地址，请点进具体那个视频再复制。'
      + '（分类列表页、站点首页这类地址 yt-dlp 不支持）',
  },
  {
    category: 'video-unavailable',
    test: /This video (?:is )?(?:not available|unavailable|may be deleted)|Video unavailable|has been removed|已删除|不存在/i,
    title: '这个视频取不到了',
    hint: '多数情况是视频本身被删了、被设为私密、或者有地区限制 —— 不一定是工具的问题。'
      + '可以换一个地址试试，确认工具本身是好的。',
  },
  {
    category: 'geo-restricted',
    test: /geo.?restrict|not available in your (country|region)/i,
    title: '这个视频在你所在的地区看不了',
    hint: '站点做了地区限制，需要对应地区的网络环境。',
  },
  {
    category: 'age-restricted',
    test: /Sign in to confirm your age|age.?restricted|inappropriate for some users/i,
    title: '这个视频有年龄限制，需要登录',
    hint: '在「设置 → 登录态」里配上 Cookie（选一个你登录过该站的浏览器）。',
  },
  {
    category: 'members-only',
    test: /members[- ]only|paid|premium|VIP|仅限会员|大会员/i,
    title: '这是会员专属内容',
    hint: '需要该站点的会员账号登录态。在「设置 → 登录态」里配上 Cookie。',
  },
  {
    category: 'corrupt-media',
    test: /Invalid data found when processing input|moov atom not found|corrupt/i,
    title: '下到的文件是坏的',
    hint: '通常是下载被中断留下了半截分片。重下一次一般就好（工具也会自动试一次）。',
  },
  {
    category: 'disk-full',
    test: /No space left|ENOSPC|disk full/i,
    title: '磁盘空间不够了',
    hint: '清理一下下载目录所在的分区，或者到「设置」里把下载目录换到空间更大的盘。',
  },
  {
    category: 'permission',
    test: /EACCES|EPERM|Access is denied|Permission denied/i,
    title: '文件没权限读写',
    hint: '确认下载目录没有被别的程序占用，也不是系统保护目录。',
  },

  // ── 笼统的网络/HTTP 类（排在这些之后）
  {
    category: 'rate-limited',
    test: /HTTP Error 429|Too Many Requests|rate.?limit/i,
    title: '被站点限流了',
    hint: '等一会儿再试，或者到「设置」里把「并发任务数」「分片并发数」调低、'
      + '并开启每任务限速，让流量看起来更像正常看片。',
  },
  {
    category: 'forbidden',
    test: /HTTP Error 403|Forbidden/i,
    title: '站点拒绝了这次请求',
    hint: '可能需要登录态（见「设置 → 登录态」），也可能是站点风控。'
      + '降低并发、稍后再试通常有用。',
  },
  {
    category: 'not-found',
    test: /HTTP Error 404|Not Found/i,
    title: '地址不存在',
    hint: '确认链接没有拼错、视频没有被删。',
  },
  {
    category: 'network',
    test: /Unable to download|Connection (refused|reset)|timed? ?out|getaddrinfo|ENOTFOUND|ECONNRESET|Temporary failure in name resolution/i,
    title: '网络连不上',
    hint: '检查网络和代理设置。如果用了代理，确认目标站点走了代理。',
  },
  {
    category: 'postprocessing',
    test: /Postprocessing:/i,
    title: '下载完成了，但后处理失败',
    hint: '多数是合并或嵌入封面时出的问题。看下面的引擎原话，'
      + '常见原因是封面格式 ffmpeg 不支持（工具会自动跳过嵌入，不会让任务失败）。',
  },
];

/**
 * 把引擎原始输出分类。
 *
 * @param {string} raw 引擎输出（已经过 cleanError 清洗）
 * @returns {{category,title,hint}|null} null = 认不出来，调用方自己兜底
 */
function classify(raw) {
  const text = String(raw || '');
  if (!text) return null;
  for (const r of RULES) {
    if (r.test.test(text)) {
      return { category: r.category, title: r.title, hint: r.hint };
    }
  }
  return null;
}

/**
 * 从引擎输出造一个 ProviderError。
 * 认不出来的时候也不能给一个空 hint —— 兜底提示要告诉用户"去哪看细节"。
 */
function fromEngineOutput(raw, { url = '', cause = null } = {}) {
  const text = String(raw || '').trim();
  const hit = classify(text);

  if (hit) {
    return new ProviderError(hit.title, {
      category: hit.category,
      hint: hit.hint,
      cause: cause || text,
      // 原始信息保留下来，排错时价值很高
      rawText: text,
    });
  }

  return new ProviderError(text || '下载失败', {
    category: 'other',
    hint: '打开该任务的「日志」看引擎的完整输出，那里通常有更具体的原因。',
    cause,
  });
}

/** 这个错误是不是"值得自动重试一次"（比如网络抖动、半截文件） */
const RETRYABLE = new Set(['network', 'corrupt-media', 'rate-limited', 'forbidden']);
function isRetryable(err) {
  return Boolean(err && err.category && RETRYABLE.has(err.category));
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  EngineError,
  ProviderError,
  RULES,
  RETRYABLE,
  classify,
  fromEngineOutput,
  isRetryable,
};
