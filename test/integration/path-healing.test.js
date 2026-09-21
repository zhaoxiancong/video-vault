'use strict';
/**
 * 路径自愈测试 —— 这是**数据安全**相关的功能，值得单独一个文件。
 *
 * 背景：库里存的是绝对路径。用户把整个工具目录挪到别处（换盘、换电脑、
 * 放 U 盘）之后，服务本身还能起来（路径都从 __dirname 推导），
 * 但库里每条记录都指向旧位置 —— 封面空白、播放 404、转码找不到源文件。
 *
 * `healPaths()` 负责启动时把"旧根 + 相对片段"改写成"当前根 + 同一相对片段"。
 *
 * ⚠️ 这个功能一旦写错，代价是**用户的库被改坏**，所以边界必须钉死：
 *    · 只认本项目自己的 `downloads/` 和 `data/` 作锚点
 *    · 用户自定义的外部下载目录**绝对不能被误改**
 *    · 已经在正确位置的不动
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, ensureDirs } = require('../../src/infra/config');
const { createDatabase } = require('../../src/infra/database');

/**
 * 造一个"旧位置"和一个"新位置"，模拟项目被搬走。
 * @returns {{oldRoot, newRoot, seedOld}}
 */
function makeMovedProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-heal-'));
  const oldRoot = path.join(base, '旧位置', '项目');
  const newRoot = path.join(base, '新位置', '项目');

  // 旧位置：建出 downloads/ 和 data/（healPaths 要求这两个子目录存在才认）
  fs.mkdirSync(path.join(oldRoot, 'downloads', 'Youtube', 'jawed'), { recursive: true });
  fs.mkdirSync(path.join(oldRoot, 'data'), { recursive: true });

  // 新位置：只有目录结构（文件"已经跟着搬过去了"）
  fs.mkdirSync(path.join(newRoot, 'downloads', 'Youtube', 'jawed'), { recursive: true });
  fs.mkdirSync(path.join(newRoot, 'data'), { recursive: true });

  return {
    base, oldRoot, newRoot,
    cleanup() { fs.rmSync(base, { recursive: true, force: true }); },
  };
}

/** 在"旧位置"建库并写入一条指向旧路径的记录 */
function seedOld(project, { filePath, downloadDir = null }) {
  const cfg = loadConfig({
    root: project.oldRoot,
    data: path.join(project.oldRoot, 'data'),
    downloads: path.join(project.oldRoot, 'downloads'),
  });
  ensureDirs(cfg);
  const repo = createDatabase(cfg);
  repo.runMigrations();                       // 建表
  const v = repo.insertVideo({
    url: 'https://example.com/v1',
    title: '测试视频',
    status: 'done',
    file_path: filePath,
    thumbnail_path: `${project.oldRoot}\\data\\thumbs\\1.jpg`,
    log_path: `${project.oldRoot}\\data\\logs\\video-1.log`,
    transcoded_path: `${project.oldRoot}\\downloads\\_converted\\x [h264].mp4`,
  });
  if (downloadDir) repo.setSettings({ downloadDir });
  repo.close();
  return v.id;
}

/** 在"新位置"打开同一个库（数据库文件已经跟着搬过去了） */
function openNew(project, { downloadsOverride = null } = {}) {
  const cfg = loadConfig({
    root: project.newRoot,
    data: path.join(project.newRoot, 'data'),
    ...(downloadsOverride ? { downloads: downloadsOverride } : {}),
  });
  const repo = createDatabase(cfg);
  return { cfg, repo };
}

test('项目被搬走后，库里的绝对路径自动修正到新位置', () => {
  const p = makeMovedProject();
  try {
    const id = seedOld(p, { filePath: `${p.oldRoot}\\downloads\\Youtube\\jawed\\a.mkv` });

    // 把数据库文件"搬到"新位置（模拟整个文件夹被移动）
    fs.copyFileSync(
      path.join(p.oldRoot, 'data', 'vault.db'),
      path.join(p.newRoot, 'data', 'vault.db'),
    );

    const { repo } = openNew(p);
    const mig = repo.runMigrations();

    const v = repo.getVideo(id);
    assert.ok(v.file_path.startsWith(p.newRoot),
      `file_path 应该被修正到新根，实际：${v.file_path}`);
    assert.match(v.file_path, /downloads[\\/]Youtube[\\/]jawed[\\/]a\.mkv$/,
      '相对片段必须保持不变，只换根目录');
    assert.match(v.thumbnail_path, /data[\\/]thumbs[\\/]1\.jpg$/, '缩略图路径也要修');
    assert.match(v.log_path, /data[\\/]logs[\\/]video-1\.log$/, '日志路径也要修');
    assert.match(v.transcoded_path, /_converted/, '转码产物路径也要修');

    assert.ok(mig.pathsHealed, '迁移结果里要报告修了几条');
    assert.equal(mig.pathsHealed.file_path, 1);
    repo.close();
  } finally { p.cleanup(); }
});

test('路径自愈会修正 settings.downloadDir', () => {
  const p = makeMovedProject();
  try {
    seedOld(p, {
      filePath: `${p.oldRoot}\\downloads\\a.mkv`,
      downloadDir: `${p.oldRoot}\\downloads`,
    });
    fs.copyFileSync(
      path.join(p.oldRoot, 'data', 'vault.db'),
      path.join(p.newRoot, 'data', 'vault.db'),
    );

    const { repo } = openNew(p);
    repo.runMigrations();
    assert.equal(repo.getSettings().downloadDir, `${p.newRoot}\\downloads`);
    repo.close();
  } finally { p.cleanup(); }
});

test('在当前（未移动）位置运行迁移不会误改路径', () => {
  const p = makeMovedProject();
  try {
    const id = seedOld(p, { filePath: `${p.oldRoot}\\downloads\\a.mkv` });

    // 直接就在旧位置打开（没有"搬走"这回事）
    const cfg = loadConfig({
      root: p.oldRoot,
      data: path.join(p.oldRoot, 'data'),
      downloads: path.join(p.oldRoot, 'downloads'),
    });
    const repo = createDatabase(cfg);
    const mig = repo.runMigrations();

    assert.equal(repo.getVideo(id).file_path, `${p.oldRoot}\\downloads\\a.mkv`,
      '已经在正确位置就不该动它');
    assert.equal(mig.pathsHealed, null, '没有需要修的东西时不该报告');
    repo.close();
  } finally { p.cleanup(); }
});

test('路径自愈只认本项目自己的子目录 —— 不误伤用户自定义的外部下载目录', () => {
  const p = makeMovedProject();
  try {
    // 用户把片子放到了 D:\Media（跟项目无关的外部路径）
    fs.mkdirSync(path.join(p.base, 'external', 'Media'), { recursive: true });
    const external = path.join(p.base, 'external', 'Media', 'my.mkv');
    const id = seedOld(p, { filePath: external });

    fs.copyFileSync(
      path.join(p.oldRoot, 'data', 'vault.db'),
      path.join(p.newRoot, 'data', 'vault.db'),
    );

    const { repo } = openNew(p);
    repo.runMigrations();
    assert.equal(repo.getVideo(id).file_path, external,
      '外部路径里没有 downloads/ 或 data/ 锚点，绝不能被改写');
    repo.close();
  } finally { p.cleanup(); }
});

test('新根下缺少 downloads/ 时不动（证明不了归属就保守拒绝）', () => {
  const p = makeMovedProject();
  try {
    const id = seedOld(p, { filePath: `${p.oldRoot}\\downloads\\a.mkv` });
    fs.copyFileSync(
      path.join(p.oldRoot, 'data', 'vault.db'),
      path.join(p.newRoot, 'data', 'vault.db'),
    );
    // 把新根的 downloads/ 删掉 —— 此时"新根下确实存在该子目录"这个前提不成立
    fs.rmSync(path.join(p.newRoot, 'downloads'), { recursive: true, force: true });

    const { repo } = openNew(p);
    repo.runMigrations();
    assert.equal(repo.getVideo(id).file_path, `${p.oldRoot}\\downloads\\a.mkv`,
      '新根下没有 downloads/ 就不该改写（否则可能指向不存在的位置）');
    repo.close();
  } finally { p.cleanup(); }
});

test('相对路径 / 空路径不会被误处理', () => {
  const p = makeMovedProject();
  try {
    const cfg = loadConfig({
      root: p.oldRoot,
      data: path.join(p.oldRoot, 'data'),
      downloads: path.join(p.oldRoot, 'downloads'),
    });
    ensureDirs(cfg);
    const repo = createDatabase(cfg);
    repo.runMigrations();
    const v = repo.insertVideo({
      url: 'https://example.com/rel', title: '相对路径', status: 'done',
      file_path: 'downloads\\rel.mkv',      // 相对路径
    });
    // 再来一条空 file_path
    const v2 = repo.insertVideo({ url: 'https://example.com/none', title: '无路径', status: 'done' });

    assert.doesNotThrow(() => repo.runMigrations(), '对异常输入不能抛');
    assert.equal(repo.getVideo(v.id).file_path, 'downloads\\rel.mkv', '相对路径不该被改');
    assert.equal(repo.getVideo(v2.id).file_path, null);
    repo.close();
  } finally { p.cleanup(); }
});

test('工具目录可以整体复制到别处并且数据可用（真实的搬移场景）', () => {
  const p = makeMovedProject();
  try {
    // 造一个真的视频文件放在旧位置
    const realFile = path.join(p.oldRoot, 'downloads', 'Youtube', 'jawed', 'real.mkv');
    fs.writeFileSync(realFile, Buffer.alloc(2048));
    const id = seedOld(p, { filePath: realFile });

    // 把整个 data/ 和 downloads/ 复制到新位置
    fs.cpSync(path.join(p.oldRoot, 'data'), path.join(p.newRoot, 'data'), { recursive: true });
    fs.cpSync(path.join(p.oldRoot, 'downloads'), path.join(p.newRoot, 'downloads'), { recursive: true });

    const { repo } = openNew(p);
    repo.runMigrations();
    const v = repo.getVideo(id);
    assert.ok(fs.existsSync(v.file_path),
      `搬移后 file_path 应该指向真实存在的文件：${v.file_path}`);
    assert.equal(fs.readFileSync(v.file_path).length, 2048);
    repo.close();
  } finally { p.cleanup(); }
});
