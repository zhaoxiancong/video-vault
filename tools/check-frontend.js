#!/usr/bin/env node
'use strict';
/**
 * 前端一致性检查 —— 纯静态，不需要浏览器。
 *
 * 检查三件事，都是"没有构建步骤"这种架构下最容易静默出错的地方：
 *
 *  1. **JS 引用的 #id 在 HTML 里存在吗**
 *     前端拆成多个模块后，`$('#someId')` 拼错一个字母不会报错，只会
 *     在运行时抛 "Cannot read properties of null"。这个检查把它变成一条
 *     构建期（其实是测试期）错误。
 *
 *  2. **HTML 里定义了但没人用的 id**
 *     通常意味着改名改了一半，或者删代码时漏删了 DOM。
 *
 *  3. **模块之间的 import 路径对不对**
 *     相对路径写错在浏览器里是 404，控制台里只有一条 Failed to fetch
 *     dynamically imported module，不指向具体哪个文件。
 *
 * 用法：node tools/check-frontend.js
 * 退出码非 0 表示有问题（可以挂到 CI 上）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'src', 'web');

/** 递归收集 .js */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

let problems = 0;
const ok = [];

function fail(msg) {
  problems += 1;
  console.log(`  ✘ ${msg}`);
}

// ---------------------------------------------------------------- 1 & 2

const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/id=["']([^"']+)["']/g)].map((m) => m[1]));
const jsFiles = walk(WEB);

/** id → 引用它的文件 */
const usedIds = new Map();
/**
 * 每个文件里出现的 $('#someid')。
 *
 * ⚠️ 要排除 $(id, root) 这种**参数名**写法 —— dom.js 里的 $ 定义本身长这样，
 *    第一版正则把它当成了"引用了一个叫 id 的元素"，报出一条假警报。
 *    假警报会训练人忽略这个检查，所以这里用标识符黑名单挡住。
 */
const NOT_AN_ID = new Set(['id', 'sel', 'selector', 'name', 'key', 'tag']);
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\$\$?\('#([A-Za-z0-9_-]+)'\)/g)) {
    const id = m[1];
    if (NOT_AN_ID.has(id)) continue;
    if (!usedIds.has(id)) usedIds.set(id, new Set());
    usedIds.get(id).add(path.relative(ROOT, f));
  }
}

/**
 * 由 JS 动态创建、不在 HTML 里的 id 白名单。
 * 每个都要写清楚为什么 —— 白名单是最容易变成"什么都往里塞"的东西。
 */
const DYNAMIC = new Set([
  // 「更多」面板里的备注输入框，随对话框一起建出来
  'noteBox',
]);

for (const [id, files] of usedIds) {
  if (htmlIds.has(id) || DYNAMIC.has(id)) continue;
  fail(`JS 引用了 #${id}，但 HTML 里没有这个 id（引用处：${[...files].join(', ')}）`);
}
if (!problems) ok.push(`${usedIds.size} 个 #id 引用全部能在 index.html 里找到（或已在动态白名单里）`);

const unused = [...htmlIds].filter((id) => !usedIds.has(id) && !DYNAMIC.has(id));
if (unused.length) {
  // 只提示不算错 —— 有些 id 是给 CSS/测试用的
  console.log(`  ! HTML 里这些 id 没有被任何 JS 引用（可能是残留，也可能只给 CSS 用）：${unused.join(', ')}`);
}

// ---------------------------------------------------------------- 3

/** 解析 import 路径，确认文件真的存在 */
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*from\s*['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (!spec.startsWith('.')) {
      fail(`${rel} 引用了非相对路径 "${spec}" —— 前端没有打包器，只能从 ./ 或 ../ 开始`);
      continue;
    }
    const target = path.resolve(path.dirname(f), spec);
    if (!fs.existsSync(target)) {
      fail(`${rel} 引用了 "${spec}"，但这个文件不存在（解析为 ${path.relative(ROOT, target)}）`);
    }
  }
}
if (!problems) ok.push('所有 import 路径都指向真实存在的文件');

// ---------------------------------------------------------------- 4

/**
 * 前端不许用 innerHTML 拼可变文本。
 *
 * 这个项目踩过：提示文案里写了 Markdown 的 `**粗体**`，前端用 textContent
 * 显示时星号原样露出来了。反过来，把引擎原话（可能带尖括号）拼进 innerHTML
 * 则会吃掉内容甚至注入。所以约定是：**需要插值的文本一律用 el()/textContent**。
 *
 * 这里只拦"模板字符串插值进 innerHTML"这一种最危险的写法。
 */
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (/\.innerHTML\s*=/.test(line) && /`/.test(line) && /\$\{/.test(line)) {
      fail(`${rel}:${i + 1} 用模板字符串给 innerHTML 赋值 —— 可变文本必须走 el()/textContent`);
    }
  });
}
if (!problems) ok.push('没有"把可变文本拼进 innerHTML"的写法');

// ---------------------------------------------------------------- 5

/** index.html 必须用 type="module" 加载入口 */
if (!/<script\s+type="module"[^>]*src="\/static\/app\.js"/.test(html)) {
  fail('index.html 没有用 type="module" 加载 /static/app.js —— 拆成 ES 模块后就跑不起来了');
} else {
  ok.push('index.html 用 type="module" 加载入口');
}

// ---------------------------------------------------------------- 6

/**
 * index.html 里引的资源必须真的存在。
 *
 * 这个检查是因为一个真实的坑：图标没声明时，浏览器会自己去要 `/favicon.ico`
 * 拿到 404，控制台留一条 error —— 而 `test/ui/smoke.js` 的「没有运行时报错」
 * 把任何 console error 都算失败，于是那条 UI 冒烟测试**在任何机器上必然报 1 项失败**。
 * 它只在有权限跑 Chrome 的会话里才暴露；而浏览器不是随时能起的。
 *
 * 所以这里把"声明的资源存不存在"变成一条纯静态检查：**没有浏览器也能挡住**。
 * 只查 `/static/` 下的引用 —— 别的路径不归 serveStatic 管，查了是假警报。
 */
for (const m of html.matchAll(/<link\b[^>]*>/g)) {
  const tag = m[0];
  const href = (tag.match(/href=["']([^"']+)["']/) || [])[1];
  // 只关心图标类声明；样式表和脚本各有自己的检查，重复报会让人忽略这个检查
  if (!href || !/rel=["'](?:icon|shortcut icon|apple-touch-icon)["']/.test(tag)) continue;
  if (!href.startsWith('/static/')) continue;
  const target = path.join(WEB, href.slice('/static/'.length).split('?')[0]);
  if (!fs.existsSync(target)) {
    fail(`index.html 声明了图标 ${href}，但文件不存在（解析为 ${path.relative(ROOT, target)}）`
      + ' —— 浏览器会退回去请求 /favicon.ico 拿到 404，UI 冒烟测试会因此失败');
  }
}
if (!problems) ok.push('index.html 声明的图标文件真实存在（浏览器不会再去要 /favicon.ico）');

// ---------------------------------------------------------------- 汇总

console.log('');
for (const s of ok) console.log(`  ✔ ${s}`);
console.log('');
if (problems) {
  console.log(`  ${problems} 个问题需要修。\n`);
  process.exit(1);
}
console.log('  前端一致性检查通过。\n');
