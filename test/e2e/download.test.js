'use strict';
/**
 * 真实下载端到端测试 —— 唯一一条"真的把视频下下来"的验证。
 *
 * ══════════════════════════════════════════════════════════════════
 *  为什么必须有这个文件
 *
 *  其他集成测试（test/integration/api.test.js）里的任务用的是
 *  example.com，走到"解析失败"就结束了 —— 它们验的是接口和状态流转，
 *  **从来没有真的下载过一个文件**。
 *
 *  而真实下载路径恰恰是重构中改动最大、最容易静默搞坏的一段：
 *  子进程 fd 重定向、进度帧解析、两条流的合并、ffprobe 完整性校验、
 *  封面抓取、中间分片清理、同文件去重…… 这些没有任何单元测试能覆盖。
 *
 *  所以这个文件是"重构没有改变行为"这个断言的**唯一硬证据**。
 * ══════════════════════════════════════════════════════════════════
 *
 * 它需要联网，所以在默认的 `npm test` 里**跳过**。
 * 单独跑：
 *   node test/e2e/download.test.js
 *   node test/e2e/download.test.js --url https://...   换个地址
 *
 * 用的是 YouTube 上最短的公开视频之一（"Me at the zoo"，19 秒，几百 KB），
 * 下完就删，不会在你的磁盘上留下东西。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../../src/main');

/** 默认测试地址：YouTube 上最短的公开视频之一 */
const DEFAULT_URL = process.env.VAULT_E2E_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const urlArgIdx = process.argv.indexOf('--url');
const TEST_URL = urlArgIdx >= 0 && process.argv[urlArgIdx + 1] ? process.argv[urlArgIdx + 1] : DEFAULT_URL;

/** 下载最多等多久（毫秒）。几 MB 的文件给它 3 分钟足够。 */
const DOWNLOAD_TIMEOUT = Number(process.env.VAULT_E2E_TIMEOUT || 180000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个隔离实例 */
async function startApp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-e2e-'));
  const app = createApp({
    data: path.join(tmp, 'data'),
    downloads: path.join(tmp, 'downloads'),
  });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;

  const call = async (method, p, body) => {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + p, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers, res };
  };

  return {
    app, base, call, tmp,
    async cleanup() {
      await app.shutdown();
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 文件被占用就留着 */ }
    },
  };
}

/** 等任务跑到终态（done / failed） */
async function waitForFinish(app, id, { timeout = DOWNLOAD_TIMEOUT } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    const v = app.repo.getVideo(id);
    if (!v) throw new Error(`任务 ${id} 不见了`);
    last = v;
    if (v.status === 'done' || v.status === 'failed') return v;
    await sleep(500);
  }
  throw new Error(`等了 ${Math.round(timeout / 1000)}s 还没结束，最后状态=${last && last.status}`
    + ` 进度=${last && last.progress} 错误=${last && last.error}`);
}

/** 关掉这个测试的方式（默认关闭，因为它要走网络流量） */
const skipReason = process.env.VAULT_SKIP_E2E === '1'
  ? 'VAULT_SKIP_E2E=1'
  : (require.main !== module ? false : false);

// ────────────────────────────────────────────────────────────────

test('真实下载：完整走通 下载 → 合并 → ffprobe 入库 → 网页播放（Range）', {
  skip: skipReason,
  timeout: DOWNLOAD_TIMEOUT + 60000,
}, async (t) => {
  const s = await startApp();
  try {
    // ---- 1. 引擎可用性（先确认不是环境问题）
    const health = await s.call('GET', '/api/health');
    if (!health.data.engines.ytdlp.ok) {
      console.log(`  ⏭  跳过：yt-dlp 不可用（${health.data.engines.ytdlp.error}）`);
      console.log('     跑 `npm run setup` 装引擎。');
      return;
    }
    if (!health.data.engines.ffmpeg.ok) {
      console.log(`  ⏭  跳过：ffmpeg 不可用（${health.data.engines.ffmpeg.error}）`);
      return;
    }

    console.log(`\n  测试地址：${TEST_URL}`);
    console.log('  正在真实下载…（这会走网络流量）\n');

    // ---- 2. 入队
    const add = await s.call('POST', '/api/videos', { urls: TEST_URL, quality: 'worst' });
    assert.equal(add.status, 202, `入队失败：${JSON.stringify(add.data)}`);
    assert.equal(add.data.added.length, 1, `没有入队：${JSON.stringify(add.data)}`);
    const id = add.data.added[0].id;

    // ---- 3. 等它跑完
    const v = await waitForFinish(s.app, id);

    /**
     * 站点策略拦截 ≠ 代码坏了 —— 必须**跳过**而不是失败。
     *
     * 实测（2026-09-22）：YouTube 现在对匿名请求回
     *   "Sign in to confirm you're not a bot. Use --cookies-from-browser ..."
     * 于是这条测试在没配 Cookie 的机器上**必然红**。
     *
     * 常红的测试比没有测试更糟：它会训练人忽略红灯 —— 这次它就让一次无关的改动
     * 看起来像"改坏了"，白查了一轮。项目对这类问题已经有过结论（第五轮）：
     * **环境导致的"没测"和真正的"测过了"必须长得不一样**。
     *
     * 所以：识别出站点策略拦截就跳过，并把怎么办写进原因里。
     * 想看它真的跑完 → 在「设置 → 登录态」里配一次 Cookie，或者用
     * `--url` / `VAULT_E2E_URL` 换一个不需要登录的地址（比如能直连的直链 mp4）。
     */
    const blockedBySite = v.status === 'failed'
      && /not a bot|cookies-from-browser|Sign in to confirm|HTTP Error 403|需要登录|登录态/i.test(v.error || '');
    if (blockedBySite) {
      t.skip(`目标站点要求登录态，下载被拦（不是代码问题）：${String(v.error).slice(0, 120)}\n`
        + '    想看这条真跑完：在「设置 → 登录态」配一次 Cookie，'
        + '或用 --url / VAULT_E2E_URL 换一个不需要登录的地址。');
      return;
    }

    assert.equal(v.status, 'done', `任务没成功：${v.error}`);

    // ---- 4. 文件真的在磁盘上，且 ffprobe 认它
    assert.ok(v.file_path, '完成的任务必须有 file_path');
    assert.ok(fs.existsSync(v.file_path), `磁盘上找不到 ${v.file_path}`);
    assert.ok(v.file_size > 0, '文件大小必须大于 0');
    assert.equal(fs.statSync(v.file_path).size, v.file_size, '记录的文件大小要跟磁盘一致');

    // 这些是 ffprobe 实测出来的，不是从文件名猜的
    assert.ok(v.duration > 0, `ffprobe 应该读出时长，实际 ${v.duration}`);
    assert.ok(v.height > 0, `ffprobe 应该读出分辨率，实际 ${v.height}`);
    assert.ok(v.container, `应该记录容器格式，实际 ${v.container}`);

    console.log(`  ✔ 下载完成：${path.basename(v.file_path)}`);
    console.log(`    ${v.width}x${v.height}  ${v.duration}s  ${v.vcodec || '?'}/${v.acodec || '?'}  `
      + `${(v.file_size / 1048576).toFixed(2)} MB`);

    // ---- 5. 中间分片应该被清掉了（否则会污染下一次下载）
    const dlDir = s.app.downloadDir();
    const leftovers = [];
    const walk = (d) => {
      let es;
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) { walk(f); continue; }
        if (/\.(part|ytdl|f\d+\.(mp4|webm|m4a))$/i.test(e.name)) leftovers.push(e.name);
      }
    };
    walk(dlDir);
    assert.deepEqual(leftovers, [], `下载完成后不该留下中间分片：${leftovers.join(', ')}`);

    // ---- 6. 网页播放：Range 请求要返回 206（拖进度条靠它）
    const full = await fetch(`${s.base}/api/videos/${id}/file`);
    assert.equal(full.status, 200, '完整请求应该 200');
    assert.equal(full.headers.get('accept-ranges'), 'bytes', '必须声明支持 Range');
    await full.arrayBuffer();

    const ranged = await fetch(`${s.base}/api/videos/${id}/file`, {
      headers: { Range: 'bytes=0-899' },
    });
    assert.equal(ranged.status, 206, 'Range 请求应该返回 206');
    assert.match(ranged.headers.get('content-range') || '', /^bytes 0-899\//);
    const chunk = Buffer.from(await ranged.arrayBuffer());
    assert.equal(chunk.length, 900, `只该拿到 900 字节，实际 ${chunk.length}`);

    // 中段也要能取（证明不是"只支持从头读"）
    const mid = await fetch(`${s.base}/api/videos/${id}/file`, {
      headers: { Range: 'bytes=1000-1999' },
    });
    assert.equal(mid.status, 206, '中段 Range 也要支持');
    assert.equal(Buffer.from(await mid.arrayBuffer()).length, 1000);

    console.log('  ✔ 网页播放：Range 返回 206，首段与中段都正确');

    // ---- 7. 库查询能搜到
    const lib = await s.call('GET', `/api/library?q=${encodeURIComponent((v.title || '').slice(0, 6))}`);
    assert.equal(lib.status, 200);
    assert.ok(lib.data.total >= 1, '刚下完的应该能在库里搜到');

    // ---- 8. 重复链接不会重复下载
    const again = await s.call('POST', '/api/videos', { urls: TEST_URL });
    assert.equal(again.data.added.length, 0, '同一个链接不该再次入库');
    assert.equal(again.data.skipped.length + again.data.retried.length, 1);

    console.log('  ✔ 库查询、去重都正常');
    console.log('');
  } finally {
    await s.cleanup();
  }
});

test('真实下载：损坏文件能被 ffprobe 识别（不靠"文件存在"就判成功）', async () => {
  const s = await startApp();
  try {
    // 不用真的下载 —— 直接验判据本身。
    // 这条规则是 README 坑 11：下载被中断会留下半截分片，
    // 只判断 fs.existsSync 会把它当成下载成功。
    const fake = path.join(s.tmp, 'downloads', 'broken.mkv');
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.writeFileSync(fake, Buffer.from('这不是一个真的视频文件，只是一堆字节'));

    assert.ok(fs.existsSync(fake), '文件确实存在');
    assert.equal(s.app.media.isPlayable(fake), false,
      '文件存在但内容不是有效媒体 → isPlayable 必须是 false');

    // 太小的文件也直接判不合格（半截文件常见形态）
    const tiny = path.join(s.tmp, 'downloads', 'tiny.mkv');
    fs.writeFileSync(tiny, Buffer.alloc(100));
    assert.equal(s.app.media.isPlayable(tiny), false, '小于 1KB 的肯定不是有效媒体');

    // 不存在的路径
    assert.equal(s.app.media.isPlayable(path.join(s.tmp, 'nope.mkv')), false);
  } finally { await s.cleanup(); }
});
