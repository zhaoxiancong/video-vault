'use strict';
/**
 * 启动脚本的中文提示 —— 单独放在这里，**不要写回 启动.cmd**。
 *
 * 为什么：`cmd.exe` 用系统 ANSI 代码页解析 .cmd 文件，而 `chcp 65001` 只改变输出。
 * 于是 .cmd 里出现多字节 UTF-8 字符时会被拆错，cmd 把中文提示当成命令去执行。
 * 实测过的症状是每一行中文都报
 *     '<乱码>' is not recognized as an internal or external command
 * 而且服务根本起不来。所以 启动.cmd / 启动.ps1 里只允许 ASCII，
 * 中文一律由这个 Node 脚本打印（Node 读 UTF-8 文件没有任何问题）。
 *
 * 用法：node tools/launcher-banner.js <banner|engine|failed|ready|portbusy|nobrowser>
 */

const MODES = {
  banner: () => [
    '',
    '  ============================================',
    '     视频下载工具  Video Vault',
    '  ============================================',
    '',
    '  正在启动，稍后会自动打开浏览器...',
    '  关闭本窗口即停止工具（未完成的任务会保留，下次可继续）',
    '',
  ],
  engine: () => ['', '  首次运行：正在准备下载引擎（约 344MB，只需一次）...', ''],
  failed: () => ['', '  引擎准备失败，请看上面的提示。', ''],
  portbusy: () => ['', '  服务 30 秒内没有就绪。常见原因：端口 8787 已被占用。', ''],
  ready: () => ['', '  已就绪。关闭本窗口即停止工具。', ''],
  nobrowser: () => ['  服务 30 秒内没有就绪，跳过打开浏览器。'],
};

const mode = process.argv[2] || 'banner';
const fn = MODES[mode];
if (!fn) {
  console.error(`未知的模式：${mode}（可用：${Object.keys(MODES).join(' / ')}）`);
  process.exit(2);
}
console.log(fn().join('\n'));
