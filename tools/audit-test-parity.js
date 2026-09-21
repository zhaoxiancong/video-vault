'use strict';
/**
 * 一次性审计脚本：老测试套件的断言在新套件里有没有对应覆盖。
 *
 * 起因：重构目标里写了"111 项一条不丢"，但我其实**没有严格核对过**。
 * 老套件是 selftest(111) + e2e(24) + uitest(24)，新套件是 92 项 ——
 * 数量对不上不代表丢了覆盖（老套件里有大量重复断言），但必须真查一遍。
 *
 * 做法：把老套件里每个 check('名字') 的第一参数抽出来，按关键词分组，
 * 再到新套件里搜同类关键词，人工判断是否覆盖。输出一份清单供核对。
 *
 * 用法：node tools/audit-test-parity.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/**
 * 跑一条 git 命令，用 **fd 重定向**把输出拿回来。
 * 受限沙箱里 `spawnSync(..., {encoding})` 默认走管道，会直接 EPERM。
 */
function gitText(args) {
  const out = path.join(os.tmpdir(), `vv-git-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  const fd = fs.openSync(out, 'w');
  try {
    const r = spawnSync('git', ['-C', ROOT, ...args], {
      stdio: ['ignore', fd, fd], timeout: 60000, windowsHide: true,
    });
    if (r.error) throw new Error(`git ${args[0]} 起不来：${r.error.message}`);
    fs.closeSync(fd);
    return fs.readFileSync(out, 'utf8');
  } finally {
    try { fs.closeSync(fd); } catch { /* 已经关过了 */ }
    try { fs.unlinkSync(out); } catch { /* 忽略 */ }
  }
}

/**
 * 找到「重构前的基线快照」那个提交。
 *
 * ⚠️ 这里**刻意不写死 SHA**。原先写的是 `0804305`，吃过一次亏：
 *    那个 SHA 只在当时那次历史里成立，一旦重写历史（例如从历史里清掉
 *    不该提交的文件）它就失效 —— 而失效的表现是 `git show` 返回空字符串，
 *    脚本于是报告"老套件 0 项"，看起来像"新套件全覆盖"，**是一条假绿**。
 *    改成按提交标题找，并且找不到就**报错退出**，不静默降级。
 */
let baselineSha = null;
function findBaseline() {
  if (baselineSha) return baselineSha;
  const hit = gitText(['log', '--all', '--format=%H\t%s'])
    .split('\n')
    .find((l) => /基线快照/.test(l));
  if (!hit) {
    throw new Error('git 历史里找不到「重构前的基线快照」提交 —— 取不回老套件就没法对照，宁可报错也不给假绿');
  }
  baselineSha = hit.split('\t')[0];
  return baselineSha;
}

/** 老套件从 git 历史里取（它们随 app/ 一起删掉了） */
function oldSuite(name) {
  const sha = findBaseline();
  const text = gitText(['show', `${sha}:app/${name}`]);
  if (!text.trim()) {
    throw new Error(`取回的 app/${name} 是空的（基线提交 ${sha.slice(0, 8)} 里没有这个文件）`);
  }
  return text;
}

/**
 * 抽出 check(...) 的第一个参数（一个字符串字面量）。
 * 只取字面量：模板串/变量名（循环里的）抽不出来，但那些通常是同类重复。
 */
function extractCheckNames(src) {
  const names = [];
  for (const m of src.matchAll(/\bcheck\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    names.push(m[2]);
  }
  return names;
}

/** 新套件里的测试名 */
function newTestNames() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\btest\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        out.push({ file: path.relative(ROOT, f), name: m[2] });
      }
    }
  };
  walk(path.join(ROOT, 'test'));
  return out;
}

/** 主题关键词 → 该主题在新套件里可能的说法 */
const TOPICS = [
  ['目录与引擎', ['引擎', 'yt-dlp', 'ffmpeg', '引擎现状', '二进制', 'health']],
  ['数据库/仓储', ['仓储', '数据库', '白名单', '事务', '去重', '隔离', 'insertVideo', 'listVideos']],
  ['进度解析', ['进度', 'NA', '管道', 'VVP', '后处理', '错误清洗', 'cleanError']],
  ['参数构造', ['参数', 'commonArgs', 'cookieArgs', '清晰度', '合并', 'embed', '输出路径']],
  ['历史 bug 回归', ['回归', '坑', '曾经', '分片', '损坏', '状态机', '转换']],
  ['链接分类', ['分类', '归一化', '抖音', 'playlist', 'classify']],
  ['真实下载', ['真实下载', '下载完成', 'Range', '播放']],
  // 转码主题已移除（用户要求去掉这个功能，见 2026-09-21 那次移除）
  ['元数据', ['元数据', 'probe', '标题', '时长']],
  ['文件可搬移/路径自愈', ['自愈', '搬移', '路径', '移动']],
  ['破坏性操作安全', ['破坏', '保留文件', 'keepFile', '清空']],
  ['HTTP 接口', ['接口', '404', '405', '400', '校验', 'SSE', '静态']],
  ['前端/UI', ['前端', '#id', 'import', 'innerHTML', 'module', '遮挡']],
  ['错误翻译', ['错误翻译', '报错', 'hint', '可操作']],
];

(async () => {
  console.log('\n════════ 老/新测试覆盖对照 ════════\n');

  const oldAll = [];
  for (const f of ['selftest.js', 'e2e.js', 'uitest.js']) {
    const names = extractCheckNames(oldSuite(f));
    console.log(`  ${f.padEnd(14)} 抽出 ${String(names.length).padStart(3)} 个字面量断言名`);
    oldAll.push(...names.map((n) => ({ suite: f, name: n })));
  }
  console.log(`  ${'合计'.padEnd(14)} ${oldAll.length} 条\n`);

  const fresh = newTestNames();
  console.log(`  新套件 test() 共 ${fresh.length} 项\n`);

  const freshBlob = fresh.map((t) => t.name).join('\n');

  console.log('  按主题看覆盖情况：\n');
  const uncovered = [];
  for (const [topic, keys] of TOPICS) {
    const oldHits = oldAll.filter((o) => keys.some((k) => o.name.includes(k)));
    const newHits = fresh.filter((t) => keys.some((k) => t.name.includes(k)));
    const mark = newHits.length === 0 && oldHits.length > 0 ? '  ← 新套件里没有对应项!' : '';
    console.log(`  【${topic}】老 ${String(oldHits.length).padStart(3)} 条 → 新 ${String(newHits.length).padStart(2)} 项${mark}`);
    if (newHits.length === 0 && oldHits.length > 0) {
      uncovered.push({ topic, samples: oldHits.slice(0, 6).map((o) => o.name) });
    }
  }

  console.log('');
  if (uncovered.length) {
    console.log('  ⚠️ 这些主题老套件测了、新套件似乎没测：\n');
    for (const u of uncovered) {
      console.log(`    【${u.topic}】`);
      for (const s of u.samples) console.log(`       · ${s}`);
    }
  } else {
    console.log('  每个主题在新套件里都能找到对应项（关键词层面）。');
  }

  // 把老断言按主题列出来，方便人工核对（新套件项数少的主题优先看）
  console.log('\n  ── 老套件断言（按主题，供人工核对）──\n');
  for (const [topic, keys] of TOPICS) {
    const oldHits = [...new Set(oldAll.filter((o) => keys.some((k) => o.name.includes(k))).map((o) => o.name))];
    if (!oldHits.length) continue;
    const newHits = fresh.filter((t) => keys.some((k) => t.name.includes(k)));
    console.log(`  ### ${topic}   老 ${oldHits.length} / 新 ${newHits.length}`);
    for (const n of oldHits) console.log(`    - ${n}`);
    console.log('');
  }

  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
