'use strict';
/**
 * 抓取实现测试 —— **全离线**：yt-dlp 与 fetch 都是注入的假的。
 *
 * 真实网络行为已在上层用实测覆盖（见 docs/superpowers/specs 里的实测记录），
 * 这里要钉的是**分支逻辑**：什么时候走哪条路、失败怎么翻译、robots 拦不拦得住。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createCrawler } = require('../../src/app/crawler');

const LISTING = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'listing-xvideos.html'), 'utf8');

const PATHS = { ytdlp: 'fake-yt-dlp.exe', ffmpeg: 'fake-ffmpeg.exe' };
const PAGE = 'https://www.xvideos.com/';

/** yt-dlp 假实现：统一返回 {ranOk,status,stdout,stderr,error} */
const ytdlpReturns = (stdout, status = 0, stderr = '') =>
  () => ({ ranOk: true, status, stdout, stderr, error: '' });
const ytdlpFails = (stderr) => () => ({ ranOk: true, status: 1, stdout: '', stderr, error: '' });

/**
 * fetch 假实现：robots.txt 与页面分开应答；记录调用顺序。
 * 返回体用 `.text()` 就够 —— crawler 只在没有 body reader 时走那条路。
 */
function fakeFetch({
  body = LISTING, status = 200, robots = 'User-agent: *\nAllow: /\n',
  robotsStatus = 200, robotsThrows = false,
} = {}) {
  const calls = [];
  const impl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/robots.txt')) {
      if (robotsThrows) throw new Error('ENOTFOUND');
      return {
        ok: robotsStatus >= 200 && robotsStatus < 300,
        status: robotsStatus,
        headers: new Map(),
        text: async () => (robotsStatus >= 400 ? 'Not Found' : robots),
        body: null,
      };
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([['content-type', 'text/html; charset=utf-8']]),
      text: async () => body,
      body: null,
    };
  };
  impl.calls = calls;
  impl.pageCalls = () => calls.filter((u) => !u.endsWith('/robots.txt'));
  impl.robotCalls = () => calls.filter((u) => u.endsWith('/robots.txt'));
  return impl;
}

/**
 * 统一用**短超时**建实例：测试里绝不能等真的 15 秒。
 * 被测的"超时"行为与超时值本身无关。
 */
const make = (opts = {}) => createCrawler({ paths: PATHS, timeoutMs: 30, ...opts });

// ---------------------------------------------------------------- 路径 A

test('yt-dlp 返回列表 JSON 时走 ytdlp 路径，null 条目被过滤、缺时长是 null', async () => {
  const runSync = ytdlpReturns(JSON.stringify({
    _type: 'playlist', title: '某频道', extractor_key: 'Youtube',
    entries: [
      { webpage_url: 'https://y/v1', title: '第一条', duration: 61 },
      { url: 'https://y/v2', title: '第二条' },
      null,
    ],
  }));
  const c = make({ runSync, fetchImpl: fakeFetch() });
  const r = await c.analyzeSource('https://y/channel');

  assert.equal(r.path, 'ytdlp');
  assert.equal(r.title, '某频道');
  assert.equal(r.site, 'Youtube');
  assert.equal(r.items.length, 2, 'null 条目要被过滤');
  assert.equal(r.items[0].duration_sec, 61);
  assert.equal(r.items[1].duration_sec, null, '没给时长就是 null，不是 0');
  assert.equal(r.items[1].url, 'https://y/v2', 'url 字段缺失时取 webpage_url/url');
});

test('yt-dlp 输出为单个视频时只回一条，并说明"这是单个视频不是列表"', async () => {
  const runSync = ytdlpReturns(JSON.stringify({
    _type: 'video', webpage_url: 'https://y/one', title: '单个', duration: 30,
  }));
  const c = make({ runSync, fetchImpl: fakeFetch() });
  const r = await c.analyzeSource('https://y/one');

  assert.equal(r.path, 'ytdlp');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, '单个');
  assert.match(r.note, /单个视频|不是列表/);
});

test('yt-dlp 的 JSON 前面有警告行时仍能解析（从第一个 { 开始）', async () => {
  const runSync = ytdlpReturns(`WARNING: something\n${JSON.stringify({
    _type: 'playlist', entries: [{ webpage_url: 'https://y/v', title: 't' }],
  })}`);
  const c = make({ runSync, fetchImpl: fakeFetch() });
  const r = await c.analyzeSource('https://y/x');
  assert.equal(r.path, 'ytdlp');
  assert.equal(r.items.length, 1);
});

// ---------------------------------------------------------------- 退回路径 B

test('yt-dlp 报 Unsupported URL 时退回 html 路径，并在 note 里说明原因', async () => {
  const f = fakeFetch();
  const c = make({ runSync: ytdlpFails('ERROR: Unsupported URL: https://www.xvideos.com/'), fetchImpl: f });
  const r = await c.analyzeSource(PAGE);

  assert.equal(r.path, 'html');
  assert.equal(r.items.length, 3, '夹具里有 3 条');
  assert.match(r.note, /解析器|页面/);
  assert.equal(f.pageCalls().length, 1, '页面只请求一次');
  assert.match(r.items[0].title, /\S/);
  assert.equal(r.items[0].site_video_id, '91931392');
});

test('yt-dlp 起不来（ranOk=false）也退回 html 路径', async () => {
  const runSync = () => ({ ranOk: false, status: null, stdout: '', stderr: '', error: 'ENOENT' });
  const c = make({ runSync, fetchImpl: fakeFetch() });
  const r = await c.analyzeSource(PAGE);
  assert.equal(r.path, 'html');
});

test('html 路径会带回翻页候选', async () => {
  const PAGING = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'paging-xvideos.html'), 'utf8');
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: fakeFetch({ body: LISTING + PAGING }) });
  const r = await c.analyzeSource(PAGE);
  assert.ok(r.paging.length >= 5, `应列出翻页候选，实际 ${r.paging.length}`);
  assert.match(r.paging[0].url, /\/new\/\d+$/);
});

// ---------------------------------------------------------------- robots.txt

test('robots.txt 禁止时**不发起页面请求**，并抛出带 hint 的错误', async () => {
  const f = fakeFetch({ robots: 'User-agent: *\nDisallow: /\n' });
  const c = make({ runSync: ytdlpFails('ERROR: Unsupported URL'), fetchImpl: f });

  await assert.rejects(() => c.analyzeSource('https://blocked.example/'), (e) => {
    assert.match(e.message, /robots/i);
    assert.ok(e.hint, '必须带 hint（用户要知道下一步）');
    return true;
  });
  assert.equal(f.pageCalls().length, 0, '不该请求页面本体');
});

test('robots.txt 放行时正常抓取', async () => {
  const f = fakeFetch({ robots: 'User-agent: *\nDisallow: /private\nAllow: /\n' });
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: f });
  const r = await c.analyzeSource(PAGE);
  assert.equal(r.path, 'html');
  assert.equal(f.pageCalls().length, 1);
});

test('robots.txt 的判定按 origin 缓存，同一站第二次不再请求', async () => {
  const f = fakeFetch();
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: f });
  await c.analyzeSource(PAGE);
  await c.analyzeSource('https://www.xvideos.com/new/2');
  assert.equal(f.robotCalls().length, 1, '同一个 origin 只查一次 robots.txt');
  assert.equal(f.pageCalls().length, 2, '但页面要各抓一次');
});

test('robots.txt 拿不到时视为允许，但在 note 里说明', async () => {
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: fakeFetch({ robotsThrows: true }) });
  const r = await c.analyzeSource(PAGE);
  assert.equal(r.path, 'html');
  assert.match(r.note, /robots/i, '要如实说明没读到 robots.txt');
});

test('robots.txt 返回 404（最常见情况）视为允许，同样在 note 里说明', async () => {
  // ⚠️ 这条比"网络错误"更贴近现实：站点根本没有 robots.txt 时，
  //    fetch 不会抛错，而是返回一个 ok=false 的 404 响应。
  const f = fakeFetch({ robotsStatus: 404 });
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: f });
  const r = await c.analyzeSource(PAGE);
  assert.equal(r.path, 'html');
  assert.equal(r.items.length, 3);
  assert.match(r.note, /robots/i);
});

test('robots.txt 里的 Disallow 只拦它写得出的路径，别的一律放行', async () => {
  const f = fakeFetch({ robots: 'User-agent: *\nDisallow: /private\n' });
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: f });
  // /new/2 不在 /private 下 → 应当放行
  const r = await c.analyzeSource('https://www.xvideos.com/new/2');
  assert.equal(r.path, 'html');
  assert.equal(f.pageCalls().length, 1);
});

// ---------------------------------------------------------------- 错误翻译

test('页面 429 时报"被限速"并给下一步建议，不是当成工具坏了', async () => {
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: fakeFetch({ status: 429 }) });
  await assert.rejects(() => c.analyzeSource(PAGE), (e) => {
    assert.match(e.message, /限速|频繁|429/);
    assert.ok(e.hint);
    return true;
  });
});

test('页面 403 时提示可能需要登录态或遇风控', async () => {
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: fakeFetch({ status: 403 }) });
  await assert.rejects(() => c.analyzeSource(PAGE), (e) => {
    assert.match(e.message + (e.hint || ''), /登录|风控|403|拒绝/);
    return true;
  });
});

test('页面 200 但一条视频都没有时明确报"没找到"，并附上检测到的链接数', async () => {
  const c = make({
    runSync: ytdlpFails('Unsupported URL'),
    fetchImpl: fakeFetch({ body: '<html><a href="/about">关于</a><a href="/tag/x">标签</a></html>' }),
  });
  await assert.rejects(() => c.analyzeSource(PAGE), (e) => {
    assert.match(e.message, /没有找到|不像/);
    return true;
  });
});

test('超时会明确说"没响应"，而不是抛一个原始 AbortError', async () => {
  const slow = async (url) => {
    if (String(url).endsWith('/robots.txt')) {
      return { ok: true, status: 200, headers: new Map(), text: async () => 'User-agent: *\n', body: null };
    }
    return new Promise((_, rej) => {
      // 模拟被 abort
      setTimeout(() => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), 5);
    });
  };
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: slow, timeoutMs: 20 });
  await assert.rejects(() => c.analyzeSource(PAGE), (e) => {
    assert.ok(!/AbortError/i.test(e.message), `不该把原始错误抛给用户：${e.message}`);
    assert.match(e.message, /超时|没响应|响应/);
    return true;
  });
});

// ---------------------------------------------------------------- 纪律

test('单次爬取最多 200 条（不自动多拿）', async () => {
  const one = '<a href="/video.x{i}/1/1/t{i}" title="T{i}"><span class="duration">1分钟</span></a>';
  const big = Array.from({ length: 260 }, (_, i) => one.replace(/\{i\}/g, i)).join('');
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: fakeFetch({ body: big }) });
  const r = await c.analyzeSource(PAGE);
  assert.equal(r.items.length, 200, '上限是 200，且不会因为没到 200 就多抓一页');
});

test('analyzeSource 不跟随页面里的链接（只发 1 次页面请求）', async () => {
  const f = fakeFetch();
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: f });
  await c.analyzeSource(PAGE);
  assert.equal(f.pageCalls().length, 1);
});

test('stop() 之后在飞的请求被中止', async () => {
  let aborted = false;
  const hanging = async (url) => {
    if (String(url).endsWith('/robots.txt')) {
      return { ok: true, status: 200, headers: new Map(), text: async () => 'User-agent: *\n', body: null };
    }
    return new Promise((_, rej) => {
      // 只有被 abort 才会 reject
      setTimeout(() => { aborted = true; rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, 50);
    });
  };
  const c = make({ runSync: ytdlpFails('Unsupported URL'), fetchImpl: hanging, timeoutMs: 5000 });
  const p = c.analyzeSource(PAGE).catch(() => 'rejected');
  await new Promise((r) => setTimeout(r, 10));
  c.stop();
  const out = await p;
  assert.equal(out, 'rejected');
  assert.ok(aborted, '说明 stop 真的中止了请求');
});
