'use strict';
/**
 * 应用入口 —— 组合根（composition root）。
 *
 * **整个程序里唯一一处"知道所有模块、并把它们接起来"的地方。**
 * 别的地方只接受注入进来的依赖，不自己去 require 单例。
 *
 * 这样做的直接好处：测试可以调用 `createApp({data: 临时目录})`，
 * 起一个**完全隔离**的实例 —— 过去做不到，测试只能操作用户的真实数据库
 * （历史上因此误删过 7 条记录）。
 *
 * 也顺带让 `src/infra/config.js` 的路径推导不会跑偏：本文件在 src/ 下，
 * 所以应用根目录是它的上一级。
 */

const path = require('node:path');

const { loadConfig, ensureDirs, withDefaults } = require('./infra/config');
const { createDatabase } = require('./infra/database');
const { createMediaTools } = require('./infra/media');
const urldiag = require('./infra/urldiag');
const { createDownloader } = require('./app/downloader');
const { createScheduler } = require('./app/scheduler');
const { createTranscodeService } = require('./app/transcode');
const { createCrawler } = require('./app/crawler');
const { createDiscovery } = require('./app/discovery');
const { createServer } = require('./http/server');

/** 应用根目录 = src/ 的上一级（里面有 tools/、downloads/、data/） */
const APP_ROOT = path.resolve(__dirname, '..');

/**
 * 建立一整套依赖，返回可用的应用对象。
 *
 * @param {object} [overrides] 覆盖项（测试用）
 * @param {string} [overrides.root]      应用根目录
 * @param {string} [overrides.data]      数据目录（把库/日志/封面隔离到临时目录）
 * @param {string} [overrides.downloads] 下载目录
 * @param {number} [overrides.port]
 * @param {string} [overrides.host]
 * @param {boolean} [overrides.silent]   不打印启动横幅
 */
function createApp(overrides = {}) {
  const config = loadConfig({ root: APP_ROOT, ...overrides });
  ensureDirs(config);

  const repo = createDatabase(config, { strict: overrides.strictDb });

  // 迁移 + 启动清理。这些以前散在 server.js 顶部，现在集中在组合根，
  // 一眼能看出"启动时到底做了哪些写操作"。
  const migrations = repo.runMigrations();

  // 清理"指向同一个文件"的重复记录。
  // 触发场景：用 rebuild-library 从磁盘重建过库（占位 local:// URL），
  // 之后用户把原始链接重新粘一次补元数据 → 同一文件出现两条记录。
  const dupGroups = repo.findDuplicateFiles();
  const dupMerged = [];
  for (const g of dupGroups) {
    const ids = String(g.ids).split(',').map(Number);
    for (const id of ids) {
      try {
        const r = repo.dedupeByFile(id);
        if (r) { dupMerged.push(`保留 id=${r.kept}，清理 ${r.removed} 条`); break; }
      } catch { /* 单条失败不影响启动 */ }
    }
  }

  const media = createMediaTools(config);
  const downloader = createDownloader(config, { fetchImpl: overrides.fetchImpl });

  /** 已合并默认值的设置。每次读都从库里拿，这样界面改了立刻生效。 */
  const settings = () => withDefaults(repo.getSettings(), config);
  /** 实际生效的下载目录（用户可能改过） */
  const downloadDir = () => settings().downloadDir;

  const scheduler = createScheduler(config, { repo, downloader, media, settings, downloadDir, urldiag });
  const transcode = createTranscodeService(config, { repo, media, settings, downloadDir });

  // 「从网站找视频」：抓取实现 + 任务生命周期。
  // crawler 与 discovery 分开，是为了让抓取逻辑能脱离服务器单独测
  // （给个 URL 或假 fetch 就能测，不需要起 HTTP）。
  const crawler = overrides.crawler || createCrawler({
    paths: config.paths,
    fetchImpl: overrides.fetchImpl,
  });
  const discovery = overrides.discovery || createDiscovery({
    repo, crawler,
    syncWaitMs: overrides.syncWaitMs,     // 测试里注入小值，绝不等真 20 秒
  });

  const http = createServer({
    config, repo, scheduler, transcode, downloader, urldiag, migrations, dupMerged, discovery,
  });

  // 启动时把上次没跑完的任务标成 paused —— **手动点继续才续，不偷偷跑流量**
  scheduler.recoverStale();

  return {
    config, repo, scheduler, transcode, downloader, media, urldiag,
    server: http.server, router: http.router,
    migrations, dupMerged,
    settings, downloadDir,
    listen: (port = config.port, host = config.host) => new Promise((resolve) => {
      http.server.listen(port, host, () => resolve(http.server.address()));
    }),
    shutdown: async () => {
      await http.shutdown();
      repo.close();
    },
  };
}

/** 打印启动横幅（把这些信息放控制台上，用户排错时第一步就能看到） */
function printBanner(app) {
  const { config, downloader, repo, migrations, dupMerged } = app;
  const health = downloader.binaryInfo();
  const s = repo.getSettings();

  console.log('');
  console.log('  ╭──────────────────────────────────────────────────────────╮');
  console.log('  │  视频下载工具 Video Vault 已启动                          │');
  console.log('  ╰──────────────────────────────────────────────────────────╯');
  console.log(`  界面地址   http://${config.host}:${config.port}`);
  console.log(`  下载目录   ${config.paths.downloads}`);
  console.log(`  数据库     ${config.paths.db}`);
  console.log(`  yt-dlp     ${health.ytdlp.ok ? health.ytdlp.version : `❌ ${health.ytdlp.error}`}`);
  console.log(`  ffmpeg     ${health.ffmpeg.ok ? '可用' : `❌ ${health.ffmpeg.error}`}`);
  console.log(`  并发/限速  ${s.concurrency} 个 / ${s.rateLimitMB ? `${s.rateLimitMB} MB/s` : '不限速'}`);

  if (migrations.columnsAdded && migrations.columnsAdded.length) {
    console.log(`  [迁移]     已为数据库补充字段：${migrations.columnsAdded.join(', ')}`);
  }
  if (migrations.rateLimitMB && migrations.rateLimitMB.from !== migrations.rateLimitMB.to) {
    const to = migrations.rateLimitMB.to === 0 ? '不限速' : `${migrations.rateLimitMB.to} MB/s`;
    console.log(`  [迁移]     限速 ${migrations.rateLimitMB.from} MB/s → ${to}（可在设置或添加页改）`);
  }
  if (migrations.pathsHealed) {
    const parts = Object.entries(migrations.pathsHealed)
      .filter(([, v]) => v && v !== 0)
      .map(([k, v]) => (typeof v === 'object' ? `${k} → ${v.to}` : `${k} ${v} 条`));
    console.log(`  [迁移]     检测到工具目录被移动，已自动修正：${parts.join('，')}`);
  }
  if (dupMerged && dupMerged.length) {
    console.log(`  [清理]     合并 ${dupMerged.length} 组重复记录（同一文件被记了多条）：${dupMerged.join('；')}`);
  }

  // 引擎缺失时给一句可照做的提示，而不是让用户自己对着一堆报错猜
  if (!health.ytdlp.ok || !health.ffmpeg.ok) {
    console.log('');
    console.log('  ⚠️  引擎不完整 —— 跑一次 `node tools/bootstrap-engine.js` 把它装回来。');
  }
  console.log('');
}

/** 命令行入口 */
async function main() {
  const app = createApp();

  // Ctrl+C：先把任务标暂停（未完成的文件保留），再关服务
  let closing = false;
  const onSignal = async () => {
    if (closing) return;
    closing = true;
    console.log('\n  收到中断，正在暂停下载任务…');
    const n = app.scheduler.pauseAll();
    console.log(`  已暂停 ${n} 个任务，未完成的文件保留，下次可手动继续。`);
    await app.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  await app.listen();
  printBanner(app);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n启动失败：${err.message}\n`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { createApp, printBanner, APP_ROOT };
