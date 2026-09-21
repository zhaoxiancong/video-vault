#!/usr/bin/env node
'use strict';
/**
 * 静态检查：抓"调用了未定义的函数"这类低级但致命的错误。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要它（真实事故）
 * ══════════════════════════════════════════════════════════════════════
 * 我删调试代码时漏删了一处 trace() 调用，于是 _start() 一进 try 就抛
 * ReferenceError，被 catch 吞掉后变成 "解析失败: trace is not defined" ——
 * **所有新任务全部下载失败**，而且报错信息完全看不出真正原因。
 * `node --check` 只查语法，抓不到；接口测试也没覆盖到那个分支。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 原理（踩过坑之后才定下来的）
 * ══════════════════════════════════════════════════════════════════════
 * 一开始我用"正则剥掉注释和字符串再分析"，结果在 CRLF + 引号嵌套下
 * 一次吞掉了 frontend/app.js 两万字符的代码 —— **正则无法可靠模拟 JS 词法**。
 *
 * 现在的做法分两步，都不依赖"手写解析器"：
 *   1. 用正则把"看起来像函数调用"的名字全部捞出来（宁可多捞，不追求精确）
 *   2. 把源码包进一个函数体编译，逐个用 `typeof <名字> !== 'undefined'` 探测。
 *      没声明的名字会抛 ReferenceError —— 这是**语言本身**给的判定，绝对可靠。
 *
 * 注意：只编译不执行，所以文件里的 require 不会真的加载任何东西。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * 要检查哪些目录。
 *
 * `src/` 是后端（CommonJS，有 require/module 这些 Node 全局）。
 * ⚠️ **不要检查 `src/web/`** —— 那是浏览器端的 ES 模块，用的是
 *    `import`/`export`，这个 linter 的判定模型（CommonJS + 全局名单）
 *    对它不适用，会把合法的 import 全报成"未定义"。
 *    前端有独立的检查器：`node tools/check-frontend.js`。
 */
const SCAN_DIRS = ['src', 'tools', 'test'];
const SKIP_DIRS = new Set(['node_modules', 'web', 'fixtures']);

const files = [];
(function walk(d) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) { walk(f); continue; }
    // 只查我们自己写的代码；下划线开头的是临时调试脚本
    if (/\.js$/.test(e.name) && !/^_/.test(e.name)) files.push(f);
  }
})(ROOT);

// 只保留 SCAN_DIRS 下的
const inScope = files.filter((f) => {
  const rel = path.relative(ROOT, f);
  return SCAN_DIRS.some((d) => rel.startsWith(d + path.sep)) && !rel.includes(`${path.sep}web${path.sep}`);
});
files.length = 0;
files.push(...inScope);

const GLOBALS = new Set([
  // 语言/宿主全局
  'Object', 'Array', 'String', 'Number', 'Boolean', 'JSON', 'Math', 'Date', 'Buffer',
  'Promise', 'Error', 'TypeError', 'RangeError', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'RegExp', 'Symbol', 'BigInt', 'Proxy', 'Reflect', 'Function', 'ArrayBuffer',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'DataView', 'SharedArrayBuffer', 'Atomics',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'eval',
  'require', 'module', 'exports', 'console', 'process', 'globalThis', '__dirname', '__filename',
  'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File', 'URL',
  'URLSearchParams', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'performance', 'crypto', 'WebSocket', 'EventSource',
  'Intl', 'WebAssembly', 'navigator', 'location', 'window', 'document', 'localStorage',
  // 浏览器 API（uitest.js 里的代码是在页面上下文执行的）
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'confirm',
  'prompt', 'alert', 'matchMedia', 'history', 'screen', 'CSS', 'Node', 'Element',
  // 关键字
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'class',
  'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'finally', 'throw',
  'async', 'await', 'yield', 'super', 'this', 'import', 'export', 'default', 'case',
  'break', 'continue', 'instanceof', 'null', 'true', 'false', 'undefined',
]);

let problems = 0;
let checked = 0;

/**
 * 明确不算"可疑未定义调用"的词。
 * 主要是 SQL 关键字 —— 本项目 SQL 都写在多行模板字符串里，
 * 形如 `... WHERE status IN (?,?,?)`，行首匹配时很容易被当成函数调用。
 */
const SKIP_WORDS = new Set([
  'values', 'value', 'select', 'from', 'where', 'insert', 'update', 'delete', 'into',
  'table', 'conflict', 'count', 'sum', 'max', 'min', 'group', 'order', 'limit',
  'pragma', 'create', 'index', 'join', 'set', 'on', 'as', 'and', 'or', 'not', 'null',
  'datetime', 'table_info', 'foreign_keys', 'journal_mode', 'autoincrement', 'exists',
  'unique', 'coalesce', 'primary', 'key', 'references', 'cascade', 'default', 'text',
  'integer', 'real', 'blob', 'if', 'case', 'when', 'then', 'else', 'end', 'distinct',
]);

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const normalized = src.replace(/\r\n?/g, '\n');

  // 第 1 步：捞出"像函数调用"的名字。
  //
  // ⚠️ 设计取舍（踩了很多坑之后定的）：
  //    · 不做代码剥离 —— 曾用正则剥注释/字符串，在 CRLF + 引号嵌套下吞掉两万字符代码。
  //    · 只认"行首调用" —— 也就是语句开头的 `foo(`。这正是漏删调试代码的形状
  //      （`trace('...')` 单独一行），而 SQL 模板串里的 `... IN (`、Windows 路径
  //      字符串里的 `Files(`、`get concurrency()` 访问器都自然被排除了。
  //    · 赋值右值也收（`const x = foo(...)`），因为漏导入的调用常出现在这里。
  const candidates = new Set();
  const lines = normalized.split('\n');

  /** 收集"行首调用"（以及赋值右值调用）—— 这正是漏导入/漏删调试代码的形状 */
  const collectLineStart = (text) => {
    const found = new Set();
    for (const raw of text.split('\n')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // 跳过注释行
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      // 行首调用：foo(...) / await foo(...) / return foo(...)
      let m = trimmed.match(/^(?:await\s+|return\s+|void\s+)?([A-Za-z_$][\w$]*)\s*\(/);
      if (m) { found.add(m[1]); continue; }
      // 赋值右值：const x = foo(...) / let [a,b] = foo(...)
      m = trimmed.match(/^(?:const|let|var)\s+[^=]+=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/);
      if (m) { found.add(m[1]); continue; }
    }
    return found;
  };

  const lineStartCalls = collectLineStart(normalized);
  for (const n of lineStartCalls) candidates.add(n);

  /**
   * 剔除"方法名"—— 链式调用 `.foo(` 里的 foo 不是被调用的函数。
   *
   * ⚠️ 这里修的是一个真实盲区（原实现用全局匹配，见下）：
   *    原实现直接 `for (const mm of normalized.matchAll(/\.\s*(\w+)\s*\(/g)) candidates.delete(mm[1])`，
   *    **全局**匹配的后果是：文件里任何地方出现 `.path.join(`，就会把 `path`
   *    从候选里删掉。于是 `scheduler.js` 漏写 `require('node:path')` 却用了
   *    `path.extname()`，linter 一声不吭，直到运行时炸 "path is not defined"。
   *
   *    修法：**已经在行首被当成调用收集过的名字，不因为"别处有 .foo(" 而被删掉。**
   *    这样既保留了原有的降噪能力（`path.join` 里的 join 会被删），
   *    又不会把 `path` 这种真正被调用的标识符误删。
   *
   *    （试过"只认前面不是点的调用"，但那会把模板串 `${b(x)}` 里的 b 也当成
   *      独立调用，误报一堆 —— 还是这个"保护已知调用名"的办法更准。）
   */
  for (const mm of normalized.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (lineStartCalls.has(mm[1])) continue;   // 它在别处是独立调用，不能删
    candidates.delete(mm[1]);
  }
  // 排除函数声明本身
  for (const mm of normalized.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) candidates.delete(mm[1]);
  for (const mm of normalized.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) candidates.delete(mm[1]);
  // 访问器 get foo() / set foo() 不是调用
  for (const mm of normalized.matchAll(/\b(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(/g)) candidates.delete(mm[1]);
  // 类方法定义 `foo(...) {` 也不是"未定义调用"（isDeclared 已能识别，这里只是提前减噪）
  // ⚠️ 参数里可能有解构（`resume(id, { force = false } = {})`），所以不能排除花括号，
  //    只要求"该行以 `) {` 结尾"。用 [^;] 排除含分号的调用行。
  for (const mm of normalized.matchAll(/^[ \t]*(?:async\s+|static\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{\s*$/gm)) {
    candidates.delete(mm[1]);
  }
  // 统一做一次大小写无关的跳过词过滤
  for (const c of [...candidates]) {
    if (SKIP_WORDS.has(c.toLowerCase())) candidates.delete(c);
  }

  /**
   * 第 1b 步：**"用了某个模块却没 require 它"**。
   *
   * ⚠️ 为什么需要这一步 —— 一个真实的漏网案例：
   *    `src/app/scheduler.js` 里用了 `path.extname(filePath)`，但重构时忘了写
   *    `const path = require('node:path')`。第一版 linter 抓不到，因为它的候选
   *    只来自"行首调用" `foo(`，而 `path` **从来不是被调用的那个**
   *    （被调用的是 `extname`）。运行时才炸 "path is not defined"。
   *
   *    教训：只检查"函数调用"的 linter，看不见"忘了 import 一个模块"这类错误 ——
   *    而那恰恰是重构时最容易犯的错之一。
   *
   * 为什么只查已知的 Node 内置模块名，而不是扫描所有裸标识符：
   *    试过"扫所有 `name.` 引用"，结果把注释和字符串里的 `AGENTS.md`、`github.com`、
   *    `yt-dlp.exe`、`System.Text` 全报成未定义 —— 29 个文件误报。
   *    裸标识符扫描需要真正的解析器，正则做不到。
   *    只认内置模块名就没有这个问题：名字是有限且明确的，命中即真问题。
   */
  const NODE_BUILTINS = [
    'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'crypto',
    'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
    'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
    'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'test',
    'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
    'worker_threads', 'zlib', 'sqlite', 'sea',
  ];
  for (const mod of NODE_BUILTINS) {
    // 这个文件里有没有用 `mod.something`
    const used = new RegExp(`(^|[^.\\w$])${mod}\\s*\\.\\s*[A-Za-z_$]`).test(normalized);
    if (!used) continue;
    // 有没有 require 进来 / 解构出来 / 当参数收到
    const required = new RegExp(
      `require\\(\\s*['"]node:${mod}['"]|require\\(\\s*['"]${mod}['"]`
      + `|\\b(?:const|let|var)\\s+${mod}\\b`
      + `|\\([^)]*\\b${mod}\\b[^)]*\\)\\s*(?:=>|\\{)`,   // 函数参数里有它
    ).test(normalized);
    if (!required) candidates.add(mod);
  }

  // 统一做一次大小写无关的跳过词过滤
  for (const c of [...candidates]) {
    if (SKIP_WORDS.has(c.toLowerCase())) candidates.delete(c);
  }

  // 调试开关：VAULT_LINT_DEBUG=1 时打印候选收集与被排除的每一步，
  // 用来排查"为什么这个未定义调用没被抓到"（这个 linter 自己就调试过好几轮）
  if (process.env.VAULT_LINT_DEBUG) {
    console.log(`\n[debug] ${rel}`);
    console.log('  候选:', [...candidates].join(', ') || '(空)');
  }

  if (!candidates.size) { checked++; continue; }

  // 第 2 步：逐个确认"有没有被声明过"。
  //
  // 为什么不用 vm 编译探测：JS 里"使用未声明标识符"是**运行期** ReferenceError，
  // 编译期不报错，所以"只编译不执行"探测不出来。而真的执行源码又会触发 require
  // 和各种副作用。结论：老老实实做正向的声明查找最可靠 —— 关键是**不要做代码剥离**，
  // 只做"某个模式是否存在"的匹配，就不会被引号/换行坑到。
  const realMissing = [...candidates].filter((name) =>
    !GLOBALS.has(name) && !SKIP_WORDS.has(name.toLowerCase()) && !isDeclared(normalized, name));

  checked++;
  if (realMissing.length) {
    problems++;
    console.log(`  ❌ ${rel}`);
    for (const n of realMissing) {
      // 内置模块名的话，问题不是"调用了未定义函数"，而是"忘了 require"
      if (NODE_BUILTINS.includes(n)) {
        console.log(`       用了 ${n}.xxx，但没看到 require('node:${n}')`);
        continue;
      }
      const ln = normalized.split('\n').findIndex((l) =>
        new RegExp(`(^|[^.\\w$'"])${n}\\s*\\(`).test(l)) + 1;
      console.log(`       第 ${ln} 行附近：调用了未定义的 ${n}()`);
    }
  }
}

/**
 * 判断 name 在源码里有没有被声明过。
 * 覆盖：函数声明（含 async）、类、var/let/const、解构、函数参数、import。
 * 这一层只做"是否存在声明"的正向查找，不做代码剥离，所以不会被引号/换行坑到。
 */
function isDeclared(src, name) {
  const n = name.replace(/\$/g, '\\$');
  const patterns = [
    new RegExp(`(?:async\\s+)?function\\s+${n}\\b`),          // function foo / async function foo
    new RegExp(`\\bclass\\s+${n}\\b`),                          // class Foo
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`),              // const foo
    new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\b${n}\\b`),    // const { foo } = ...
    new RegExp(`\\([^)]*\\b${n}\\b[^)]*\\)\\s*(?:=>|\\{)`),      // 函数参数
    new RegExp(`\\b${n}\\s*[,)]\\s*(?:=>|\\{)`),                 // 单参数箭头函数 x =>
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=`),             // const foo = ...
    // ⚠️ 类方法：必须要求"参数列表之后紧跟 { 或 换行+{"。
    //    曾经只写 `^\s*(?:async\s+)?name\s*\(`，结果把**函数调用行**
    //    （形如 `        trace('x');`，同样以缩进+名字+左括号开头）误判成方法声明，
    //    导致 linter 完全抓不到漏删的调试调用 —— 这是它自己的一个真 bug。
    //    判别关键：方法声明是 `name(...) {`，调用是 `name(...);`。
    //
    // ⚠️ 参数里允许出现花括号与裸对象：`startCrawlRun({ url }) { ... }` 这种
    //    **对象方法简写**很常见（测试里的假对象几乎都这么写）。原来写成
    //    `[^;{}]*` 会把这类定义漏掉、误报成"调用了未定义函数"。
    //    要害仍然由结尾的 `)\s*\{` 把住：调用行是 `name(...);`，不会匹配到。
    //    两边的判别标准要保持一致（下面的候选过滤也是 `)\s*\{\s*$`）。
    new RegExp(`^[ \\t]*(?:async\\s+|static\\s+|get\\s+|set\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`, 'm'),
    new RegExp(`\\bimport\\s+${n}\\b`),
    new RegExp(`\\bimport\\s*\\{[^}]*\\b${n}\\b`),
    new RegExp(`\\b${n}\\s*:\\s*(?:async\\s*)?(?:\\(|function)`), // 对象属性 foo: function / foo: () =>
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=\\s*(?:async\\s*)?\\(?[^)]*\\)?\\s*=>`),
  ];
  return patterns.some((re) => re.test(src));
}

console.log(`\n  已检查 ${checked} 个文件`);
if (problems === 0) {
  console.log('  ✅ 没有发现"调用了未定义函数"的问题\n');
  process.exit(0);
}
console.log(`  ⚠️ 发现 ${problems} 个文件有未定义引用\n`);
process.exit(1);
