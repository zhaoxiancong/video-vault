'use strict';
/**
 * 子进程执行 —— 全项目**唯一**一处 spawn 的地方。
 *
 * ⚠️ 这个模块存在的首要理由是一条硬约束：
 *
 *   **子进程的输出必须走文件描述符重定向，不能走管道。**
 *
 * 这是实测撞出来的（README 坑 1）：受限沙箱会拒绝管道 stdio，直接抛 EPERM。
 * 更麻烦的是**沙箱策略是会话级、会变的** —— 同一段代码在放宽权限的会话里
 * 用 `stdio:'pipe'` 一切正常，换个受限会话就全挂。所以不能靠"我这儿能跑"来判断。
 *
 * 而且它失败的方式很阴：`spawnSync` 抛 EPERM 后如果调用方只读 `r.stdout`，
 * 拿到的是空字符串 —— 看起来像"命令没输出"，实际是**命令根本没跑起来**。
 * 项目里因此出现过两次静默故障：
 *   - 静态检查报"失败"，其实是子进程起不来（把环境问题显示成代码问题）
 *   - 所有下载静默失败，报错是 `trace is not defined`（坑 14）
 *
 * 所以这里统一封装：跑完返回 `{status, signal, stdout, stderr, error, timedOut}`，
 * 并且**明确区分"命令失败了"和"命令没跑起来"**（前者 status 非 0，后者 error 非空）。
 *
 * 副产品（其实很有用）：每个任务的完整原始输出都留在日志文件里，排错极方便。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

/**
 * 子进程环境。
 *
 * ⚠️ PYTHONUTF8 / PYTHONIOENCODING 不是可有可无的（README 坑 3）：
 *    中文 Windows 上子进程用 fd 重定向写文件时，默认按系统 ANSI 代码页（GBK）编码，
 *    于是日志里的中文路径全变乱码（...\20260920_??Ƶ????\...），导致
 *    `fs.existsSync()` 永远失败、**文件永远收不了尾**。
 *    强制 UTF-8 之后路径才不会坏。
 */
function childEnv(extra = {}) {
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONLEGACYWINDOWSSTDIO: '0',
    ...extra,
  };
}

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** 临时文件名的统一前缀，方便一眼看出是残留 */
let tmpSeq = 0;
function tmpPath(tag) {
  tmpSeq += 1;
  return path.join(os.tmpdir(), `vault-${tag}-${process.pid}-${Date.now()}-${tmpSeq}.log`);
}

/**
 * 跑一个"短命令"并把标准输出拿回来（版本号、ffprobe 探测、元数据）。
 *
 * 实现要点：输出通过 **fd 重定向到临时文件**，跑完读文件。
 * 不用管道，原因见文件头的说明。
 *
 * @param {string} exe
 * @param {string[]} args
 * @param {object} [opts]
 * @param {number} [opts.timeout] 硬超时（毫秒）。**必须有默认值**，不允许无限挂起。
 * @param {object} [opts.env]
 * @returns {{status:number|null, signal:string|null, stdout:string, stderr:string,
 *            error:string|null, timedOut:boolean, ranOk:boolean}}
 */
function runSync(exe, args, { timeout = 120000, env = childEnv(), cwd = undefined } = {}) {
  const outFile = tmpPath('out');
  let fd;
  const started = Date.now();
  try {
    fd = fs.openSync(outFile, 'w');
    const r = spawnSync(exe, args, {
      stdio: ['ignore', fd, fd],   // ← 关键：fd 而不是 pipe
      timeout,
      windowsHide: true,
      env,
      cwd,
    });
    fs.closeSync(fd);
    fd = null;

    const stdout = safeRead(outFile);
    const bootErr = r.error ? (r.error.code || r.error.message) : null;
    const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');

    return {
      status: r.status,
      signal: r.signal,
      stdin: '',
      stdout,
      stderr: '',            // fd 模式下 stderr 也进了 stdout，不再区分
      error: bootErr,
      timedOut,
      // ranOk = "这个进程真的跑起来了并有退出码"，跟"成功"是两件事
      ranOk: !bootErr && r.status !== null,
      ms: Date.now() - started,
    };
  } catch (e) {
    return {
      status: null, signal: null, stdin: '', stdout: '', stderr: '',
      error: `${e.code || 'EXEC'}: ${e.message}`,
      timedOut: false, ranOk: false, ms: Date.now() - started,
    };
  } finally {
    if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
    try { fs.unlinkSync(outFile); } catch { /* 留着也无害 */ }
  }
}

/**
 * 起一个"长命令"（下载、转码），输出**追加**到调用方指定的日志文件。
 *
 * 返回 child 句柄和日志路径；调用方通过 tail 日志文件拿进度。
 * 刻意不解析 stdout —— 那个职责在 infra/progress.js。
 *
 * @param {string} exe
 * @param {string[]} args
 * @param {object} opts
 * @param {string} opts.logPath 日志文件（会先清空）
 * @param {object} [opts.env]
 * @param {string} [opts.cwd]
 * @returns {{child:import('node:child_process').ChildProcess, logPath:string, pid:number|undefined}}
 */
function spawnToFile(exe, args, { logPath, env = childEnv(), cwd = undefined } = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '');          // 清空旧日志，避免读到上次的进度
  const fd = fs.openSync(logPath, 'a');

  const child = spawn(exe, args, {
    stdio: ['ignore', fd, fd],            // ← 同样：fd 而非 pipe
    windowsHide: true,
    env,
    cwd,
    detached: false,
  });
  // 父进程这一侧的句柄要立刻关掉，否则日志文件的写入端永远不释放，
  // 出现"进程已退出但最后几行还没落盘"的竞态
  fs.closeSync(fd);

  return { child, logPath, pid: child.pid };
}

/** 检查一个可执行文件是否存在（顺手给出可操作的提示） */
function assertExecutable(exe, { hint = '' } = {}) {
  if (fs.existsSync(exe)) return true;
  const { EngineError } = require('../domain/errors');
  throw new EngineError(`找不到可执行文件：${exe}`, {
    hint: hint || '引擎文件缺失，跑一次 `node tools/bootstrap-engine.js` 把它装回来。',
  });
}

/**
 * 探测一个二进制能不能用，返回版本号。
 * 用于 /api/health 和启动自检。
 */
function probeBinary(exe, args) {
  if (!fs.existsSync(exe)) {
    return { ok: false, version: '', error: '文件不存在', path: exe };
  }
  const r = runSync(exe, args, { timeout: 20000 });
  const firstLine = (r.stdout || '').split(/\r?\n/)[0] || '';
  if (r.error) {
    return { ok: false, version: '', error: `${r.error}（进程没能启动）`, path: exe };
  }
  return {
    ok: r.status === 0,
    version: firstLine,
    error: r.status === 0 ? '' : firstLine || `退出码 ${r.status}`,
    path: exe,
  };
}

/** 优雅地结束一棵进程树（Windows 上 child.kill 杀不掉孙进程） */
function killTree(pid, { spawnSync: sync = spawnSync } = {}) {
  if (!pid) return;
  try {
    sync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 15000,
    });
  } catch {
    // taskkill 不可用时退回 Node 自己的 kill（至少能杀掉直接子进程）
    try { process.kill(pid); } catch { /* 已经退出了 */ }
  }
}

/** 读文件尾部若干字节（进度轮询用；大日志不能整个读进内存） */
function readTail(file, maxBytes = 4000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

module.exports = {
  childEnv,
  runSync,
  spawnToFile,
  probeBinary,
  assertExecutable,
  killTree,
  readTail,
  safeRead,
  tmpPath,
};
