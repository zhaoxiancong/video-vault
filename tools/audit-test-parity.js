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

/** 老套件从 git 历史里取（它们随 app/ 一起删掉了） */
function oldSuite(name) {
  const out = path.join(os.tmpdir(), `old-${name}-${Date.now()}.js`);
  const fd = fs.openSync(out, 'w');
  spawnSync('git', ['-C', ROOT, 'show', `0804305:app/${name}`], {
    stdio: ['ignore', fd, fd], timeout: 60000, windowsHide: true,
  });
  fs.closeSync(fd);
  const text = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);
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
  ['转码', ['转码', 'preset', 'ffmpeg']],
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
