'use strict';
/**
 * HTTP 端到端集成测试：模拟用户真实操作路径。
 *   1. 健康检查
 *   2. 通过 POST /api/videos 提交一个视频链接
 *   3. 轮询 /api/library 直到任务完成（或超时）
 *   4. 验证入库信息完整（标题/作者/时长/文件/封面）
 *   5. 验证 /api/videos/:id/file 支持 Range（网页播放器拖进度条的前提）
 *   6. 验证 /api/videos/:id/log 能取到日志
 * 用法：先启动 server.js，再 node e2e.js
 */

const BASE = process.env.VAULT_BASE || 'http://127.0.0.1:8787';
const TEST_URL = process.env.VAULT_TEST_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

let pass = 0, fail = 0;
function check(name, ok, evidence) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
  if (evidence) String(evidence).split('\n').forEach((l) => console.log(`       ${l}`));
}

async function j(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  console.log('\n════════ HTTP 端到端集成测试 ════════\n');
  console.log('目标服务:', BASE);

  // ── 1. 健康检查
  console.log('\n── 1. 健康检查 ──');
  const h = await j('GET', '/api/health');
  check('GET /api/health 返回 200', h.status === 200);
  check('yt-dlp 与 ffmpeg 均可用', h.data.engines.ytdlp.ok && h.data.engines.ffmpeg.ok,
    `yt-dlp=${h.data.engines.ytdlp.version}  ffmpeg=${h.data.engines.ffmpeg.ok ? '可用' : '不可用'}`);

  // ── 2. 提交下载
  console.log('\n── 2. 提交下载任务 ──');
  console.log('   链接:', TEST_URL);
  const add = await j('POST', '/api/videos', { urls: TEST_URL, kind: 'video', quality: '360p' });
  check('POST /api/videos 返回 202', add.status === 202, `实际 ${add.status}`);
  const added = add.data.added || [];
  const skipped = add.data.skipped || [];
  check('任务已加入队列（或识别为库里已有）', added.length + skipped.length > 0,
    added.length ? `新增 id=${added[0].id}` : `已存在 id=${skipped[0].id}`);

  let id = added.length ? added[0].id : (skipped.length ? skipped[0].id : null);
  if (!id) {
    console.log('\n无法获得任务 id，测试中止');
    process.exit(1);
  }

  // 如果已存在且已完成，先重置为排队，确保走完整流程
  const existing = await j('GET', `/api/videos/${id}/refresh`).catch(() => null);
  if (existing && existing.data && existing.data.status === 'done') {
    console.log(`   （id=${id} 之前已完成，重跑下载以验证完整流程）`);
    await j('POST', `/api/videos/${id}/action`, { action: 'retry' });
  } else {
    await j('POST', `/api/videos/${id}/action`, { action: 'resume' });
  }

  // ── 3. 等待完成，同时观察状态变化（验证队列真的在推进）
  console.log('\n── 3. 等待任务完成（观察状态机）──');
  const seen = new Set();
  let final = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const lib = await j('GET', `/api/library?q=&limit=500`);
    const row = (lib.data.rows || []).find((r) => r.id === id);
    if (row) {
      if (!seen.has(row.status)) { seen.add(row.status); console.log(`       [${((Date.now() - t0) / 1000).toFixed(1)}s] 状态 → ${row.status}  ${(row.progress || 0).toFixed(1)}%`); }
      if (['done', 'failed', 'canceled', 'paused'].includes(row.status)) { final = row; break; }
    }
    await sleep(1200);
  }

  check('任务在超时前进入终态', !!final, final ? `最终状态 = ${final.status}` : '超时未完成');
  if (!final) { console.log('\n测试中止'); process.exit(1); }

  // ── 4. 入库信息完整性
  console.log('\n── 4. 入库信息完整性 ──');
  check('任务成功完成', final.status === 'done', `status=${final.status}${final.error ? '  error=' + final.error : ''}`);
  check('标题已入库', !!final.title, `title="${final.title}"`);
  check('作者已入库', !!final.uploader, `uploader=${final.uploader}`);
  check('时长已入库', !!final.duration, `duration=${final.duration}s`);
  check('文件路径已入库且是中文路径可读', !!final.file_path && final.file_path.includes('视频下载工具'),
    final.file_path || '(空)');
  check('文件体积已入库', !!final.file_size, `${(final.file_size / 1048576).toFixed(2)} MB`);
  check('分辨率已入库（ffprobe 生效）', !!final.height, `${final.width}x${final.height} ${final.vcodec}/${final.acodec}`);
  check('容器格式已入库', !!final.container, `.${final.container}`);

  // ── 5. 封面图
  console.log('\n── 5. 封面缩略图 ──');
  const th = await fetch(`${BASE}/api/videos/${id}/thumb`, { redirect: 'manual' });
  check('封面接口有响应（200 本地图 或 302 回源）', th.status === 200 || th.status === 302,
    `HTTP ${th.status}  Content-Type=${th.headers.get('content-type') || '-'}`);

  // ── 6. 视频流 + Range 支持
  console.log('\n── 6. 视频流与 Range 支持（网页拖进度条的前提）──');
  const full = await fetch(`${BASE}/api/videos/${id}/file`);
  check('GET 文件返回 200', full.status === 200, `Content-Type=${full.headers.get('content-type')}  Length=${full.headers.get('content-length')}`);
  check('声明支持 Range', full.headers.get('accept-ranges') === 'bytes', `Accept-Ranges=${full.headers.get('accept-ranges')}`);
  await full.arrayBuffer();

  const ranged = await fetch(`${BASE}/api/videos/${id}/file`, { headers: { Range: 'bytes=100-999' } });
  check('Range 请求返回 206', ranged.status === 206,
    `HTTP ${ranged.status}  Content-Range=${ranged.headers.get('content-range')}`);
  const buf = Buffer.from(await ranged.arrayBuffer());
  check('Range 返回的字节数正确（900 字节）', buf.length === 900, `实际 ${buf.length} 字节`);

  // ── 7. 日志接口
  console.log('\n── 7. 日志接口（排错用）──');
  const lg = await j('GET', `/api/videos/${id}/log`);
  check('能取到 yt-dlp 原始日志', lg.status === 200 && Array.isArray(lg.data.lines) && lg.data.lines.length > 0,
    `共 ${lg.data && lg.data.lines ? lg.data.lines.length : 0} 行`);

  // ── 8. 搜索与筛选
  console.log('\n── 8. 库搜索与筛选 ──');
  const key = (final.title || '').slice(0, 6);
  const srch = await j('GET', `/api/library?q=${encodeURIComponent(key)}`);
  check('按标题关键词能搜到', (srch.data.rows || []).some((r) => r.id === id),
    `关键词 "${key}" 命中 ${srch.data.total} 条`);
  const byStatus = await j('GET', `/api/library?status=done`);
  check('按状态筛选能筛到', (byStatus.data.rows || []).some((r) => r.id === id),
    `status=done 共 ${byStatus.data.total} 条`);
  const byUp = await j('GET', `/api/library?uploader=${encodeURIComponent(final.uploader || '')}`);
  check('按作者筛选能筛到', (byUp.data.rows || []).some((r) => r.id === id),
    `uploader=${final.uploader} 共 ${byUp.data.total} 条`);
  const facets = await j('GET', '/api/facets');
  check('筛选项统计包含该站点与作者',
    (facets.data.sites || []).some((s) => s.v === final.site) &&
    (facets.data.uploaders || []).some((u) => u.v === final.uploader),
    `站点数 ${(facets.data.sites || []).length}，作者数 ${(facets.data.uploaders || []).length}`);

  // ── 9. 去重
  console.log('\n── 9. 重复提交去重 ──');
  const dup = await j('POST', '/api/videos', { urls: TEST_URL });
  check('重复链接不会重复入库', (dup.data.skipped || []).length === 1 && (dup.data.added || []).length === 0,
    `skipped=${(dup.data.skipped || []).length}  added=${(dup.data.added || []).length}`);

  // ── 汇总
  console.log('\n════════════════════════════════════════');
  console.log(`  通过 ${pass}   失败 ${fail}`);
  console.log('════════════════════════════════════════\n');
  console.log(`  测试条目 id=${id}  标题="${final.title}"`);
  console.log(`  文件：${final.file_path}\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => { console.error('\n测试脚本出错：', err); process.exit(2); });
