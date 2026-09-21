#!/usr/bin/env node
'use strict';
/**
 * 前端类名对账 —— 纯静态，不需要浏览器。
 *
 * ══════════════════════════════════════════════════════════════════
 *  这个检查是为一个真实事故写的：
 *
 *  重构把前端从 `app/frontend/` 搬到 `src/web/` 时换了一套类名
 *  （`.q-top`→`.qmain`、`.card-thumb` 从容器变图片、……），
 *  **但 styles.css 没跟着改**。后果是队列页、库卡片、列表视图、
 *  对话框、提交报告**整块没有任何样式**。
 *
 *  而当时所有测试都是绿的：`check-frontend.js` 只查 #id 和 import 路径，
 *  DOM 垫片没有 CSS 级联，`test/run.js` 根本不渲染。
 *  换句话说 —— **只有真实浏览器看得见，而真实浏览器此前从没跑起来过**。
 *
 *  这个文件把"渲染出来的类名必须能在样式表里找到"变成一条静态检查，
 *  让没有浏览器的会话也能挡住同一类错误。
 * ══════════════════════════════════════════════════════════════════
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'src', 'web');

/**
 * 有意不加样式的类。**每一条都要写清理由** ——
 * 白名单是最容易变成"什么都往里塞"的东西，塞满了这个检查就废了。
 *
 * 注意：**旧类名不需要写在这里**。这个检查只看"前端实际渲染出来的类名"
 * （从 src/web 的源码里抽），废弃的旧类名没人渲染，自然不会进来。
 * 第一版我在这里列了四十来条旧类名，纯属噪音 —— 已经删掉。
 */
const INTENTIONAL = new Map([
  ['in', 'toast 的入场动画钩子，只用来触发 CSS 过渡（样式挂在 .toast 上）'],
  ['is-active', '状态类，样式成对写在 .view/.tab/.seg-btn 的组合选择器里'],
  ['is-url', '状态类，样式写在 .qname.is-url 之类的组合选择器里'],
  ['muted', '状态类，样式写在 .rep-row.muted 之类的组合选择器里'],
  ['ok', '状态类，样式写在 .qbadge.tone-ok / .rep-row.ok 之类的组合选择器里'],
  ['warn', '状态类，样式写在 .rep-row.warn 之类的组合选择器里'],
  ['bad', '状态类，样式写在 .rep-row.bad 之类的组合选择器里'],
  ['placeholder', '占位状态，样式写在 .card-thumb.placeholder 之类的组合选择器里'],
  ['is-error', '状态类，样式写在 .qmeta.is-error 上'],
]);

// ---------------------------------------------------------------- 收集

/** CSS 里出现的类选择器（整份文件扫 `.foo`） */
const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');
const cssClasses = new Set([...css.matchAll(/\.(-?[_A-Za-z][\w-]*)/g)].map((m) => m[1]));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/**
 * 前端源码里"静态写死"的类名。
 *
 * 只取没有 `${}` 插值的部分 —— 带插值的（`qbadge tone-${tone}`）没法静态求值，
 * 硬报只会制造假警报，而假警报会训练人忽略这个检查。
 * 拼出来的类由 CLASS_RE + DYN_PREFIX 兜住。
 */

/**
 * 合法的类名长这样。用严格模式而不是"按空格切"：
 * 第一版按空格切，把 `const { class: cls, ... }` 这种**解构参数**切成了
 * `.cls,` / `.v;` 之类的假类名，报出一堆假警报。
 */
const CLASS_RE = /^-?[_a-zA-Z][\w-]*$/;

/** 模板拼出来的类前缀（`tone-${x}` → tone-ok / tone-bad…，这些在样式表里都有） */
const DYN_PREFIX = /^tone-$/;

/**
 * 去掉注释再抽取。
 *
 * 不去注释会误报：`dom.js` 的 JSDoc 里有个示例 `el('div', {class:'row'}, ...)`，
 * 第一版把它当成了"真的渲染了一个 .row"。**假警报比漏报更糟** ——
 * 它会训练人忽略这个检查，而漏掉的那次才是真出事的时候。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')     // /* ... */
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))  // // ...（避开 http:// 和字符串里的 //）
    .join('\n');
}

const used = new Map(); // cls -> Set('文件:行')
const files = walk(WEB);

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const src = f.endsWith('.html') ? raw : stripComments(raw);
  const rel = path.relative(ROOT, f);
  src.split('\n').forEach((line, i) => {
    const add = (cls) => {
      if (!cls || !CLASS_RE.test(cls)) return;
      if (!used.has(cls)) used.set(cls, new Set());
      used.get(cls).add(`${rel}:${i + 1}`);
    };

    // 模板字符串里的类：把 ${...} 换成空前缀标记，再逐词判定
    //   `qbadge tone-${tone}`  → ['qbadge', 'tone-'] （后者由 DYN_PREFIX 认）
    //   `card-thumb placeholder` → ['card-thumb', 'placeholder']
    for (const m of line.matchAll(/class(?:Name)?\s*[:=]\s*`([^`]*)`/g)) {
      for (const part of m[1].split(/\$\{[^}]*\}/)) {
        for (const cls of part.trim().split(/\s+/)) add(cls);
      }
    }
    // 普通字符串字面量里的类：class: 'a b' / class="a b"
    for (const m of line.matchAll(/class(?:Name)?\s*[:=]\s*['"]([^'"]*)['"]/g)) {
      for (const cls of m[1].trim().split(/\s+/)) add(cls);
    }
    // classList.add/toggle/remove('x')
    for (const m of line.matchAll(/classList\.(?:add|toggle|remove)\(\s*['"]([\w-]+)['"]/g)) add(m[1]);
  });
}

// ---------------------------------------------------------------- 判定

const problems = [];

for (const [cls, where] of used) {
  if (cssClasses.has(cls) || INTENTIONAL.has(cls)) continue;
  if (DYN_PREFIX.test(cls)) continue;   // 模板拼出来的前缀，样式表里有对应规则
  problems.push({ cls, where: [...where].slice(0, 3) });
}

// ---------------------------------------------------------------- 输出

console.log('');
if (problems.length) {
  console.log(`  ✘ ${problems.length} 个类名在样式表里找不到任何规则（渲染出来会没有样式）：\n`);
  for (const p of problems) {
    console.log(`     .${p.cls}`);
    console.log(`        用在 ${p.where.join(', ')}`);
  }
  console.log('\n  修法二选一：给 styles.css 补规则，或把它加进本文件的 INTENTIONAL 并写明理由。');
  console.log('  ⚠️ 别随手往 INTENTIONAL 里塞：塞满了这个检查就等于没有。\n');
  process.exit(1);
}

console.log(`  ✔ ${used.size} 个渲染出来的类名都能在 styles.css 里找到规则`);
console.log(`    （另有 ${INTENTIONAL.size} 条白名单，每条都写了理由）`);
console.log(`    ⚠️ 这个检查挡的是"类名错配"——它曾经让整个队列页和库卡片没有样式，`);
console.log(`       而当时所有测试都是绿的。真实浏览器里的样子请跑 tools/screenshot.js 看。\n`);
