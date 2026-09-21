'use strict';
/**
 * 转码服务 —— 对应「当剪辑素材用」这个真实需求。
 *
 * 核心约定：**原始文件永不改动，产物另存 `_converted/`。**
 *
 * 这条约定是被"三个需求互相冲突"逼出来的（防丢要"原始别动"，
 * 剪素材要"统一格式"，建库要"能检索"）：归档层 / 工作层 / 检索层三者分开，
 * 互不干扰。你剪坏了转码文件，原始文件还在。
 */

const fs = require('node:fs');
const path = require('node:path');

const { spawnToFile } = require('../infra/subprocess');
const { readTail } = require('../infra/subprocess');

/**
 * 转码预设。
 * 剪辑场景最常要的是「统一成 H.264 + MP4」——任何剪辑软件都能直接吃。
 */
const TRANSCODE_PRESETS = Object.freeze({
  'copy-mp4': {
    label: '仅换容器（秒完成，不重编码）',
    ext: 'mp4',
    args: (out) => ['-c', 'copy', '-movflags', '+faststart', out],
  },
  'h264-1080p': {
    label: 'H.264 1080p（剪辑友好，通用）',
    ext: 'mp4',
    args: (out) => [
      '-vf', 'scale=-2:min(1080\\,ih)', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out,
    ],
  },
  'h264-720p': {
    label: 'H.264 720p（体积小）',
    ext: 'mp4',
    args: (out) => [
      '-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'medium', '-crf', '22',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out,
    ],
  },
  'h265-1080p': {
    label: 'H.265 1080p（更小，但对老设备不友好）',
    ext: 'mp4',
    args: (out) => [
      '-vf', 'scale=-2:min(1080\\,ih)', '-c:v', 'libx265', '-preset', 'medium', '-crf', '24',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out,
    ],
  },
  'audio-mp3': {
    label: '抽音频为 MP3（当播客听）',
    ext: 'mp3',
    args: (out) => ['-vn', '-c:a', 'libmp3lame', '-q:a', '2', out],
  },
});

/** 预设列表（给前端渲染下拉框） */
function presetList() {
  return Object.entries(TRANSCODE_PRESETS).map(([name, p]) => ({
    name, label: p.label, ext: p.ext,
  }));
}

/**
 * @param {object} config
 * @param {object} deps {repo, media, settings}
 */
function createTranscodeService(config, deps) {
  const { paths } = config;
  const { repo, media } = deps;

  /** 正在跑的转码：videoId → {child, outPath, presetName} */
  const running = new Map();

  function activeCount() {
    return running.size;
  }

  function isRunning(videoId) {
    return running.has(videoId);
  }

  /** 算输出路径：`_converted/<原标题> [预设名].<ext>` */
  function outputPathFor(video, presetName) {
    const preset = TRANSCODE_PRESETS[presetName];
    const base = path.basename(video.file_path, path.extname(video.file_path));
    const outDir = path.join(deps.downloadDir(), '_converted');
    return path.join(outDir, `${base} [${presetName}].${preset.ext}`);
  }

  /**
   * 启动转码。
   *
   * @param {object} video 库里的记录（必须有 file_path）
   * @param {string} presetName
   * @param {object} [hooks] {onDone, onFail} —— 由上层接广播
   * @returns {{outPath:string, logPath:string}}
   * @throws {ValidationError} 预设名不对 / 源文件不存在 / ffmpeg 缺失
   */
  function start(video, presetName, hooks = {}) {
    const { ValidationError, EngineError } = require('../domain/errors');
    const preset = TRANSCODE_PRESETS[presetName];
    if (!preset) {
      throw new ValidationError(`未知转码预设：${presetName}`, {
        hint: `可用的预设：${Object.keys(TRANSCODE_PRESETS).join(' / ')}`,
      });
    }
    if (!fs.existsSync(paths.ffmpeg)) {
      throw new EngineError('ffmpeg 不可用，无法转码', {
        hint: '引擎文件缺失，跑一次 `node tools/bootstrap-engine.js` 把它装回来。',
      });
    }
    if (!video.file_path || !fs.existsSync(video.file_path)) {
      throw new ValidationError('原始文件不存在，无法转码', {
        hint: '它可能被手动移动或删除了。可以到「我的库」里重新下载。',
      });
    }
    if (running.has(video.id)) {
      throw new ValidationError('这个任务已经在转码中了', { hint: '等它跑完再试。' });
    }

    const outPath = outputPathFor(video, presetName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const logPath = path.join(paths.logs, `transcode-${video.id}.log`);

    const args = ['-y', '-hide_banner', '-i', video.file_path, ...preset.args(outPath), outPath];
    const { child } = spawnToFile(paths.ffmpeg, args, { logPath });

    running.set(video.id, { child, outPath, presetName });
    repo.updateVideo(video.id, { transcode_status: 'running', transcode_preset: presetName });
    if (hooks.onStart) hooks.onStart(video.id);

    child.on('close', (code) => {
      running.delete(video.id);
      if (code === 0 && fs.existsSync(outPath)) {
        repo.updateVideo(video.id, { transcode_status: 'done', transcoded_path: outPath });
        if (hooks.onDone) hooks.onDone({ id: video.id, preset: presetName, path: outPath });
      } else {
        const err = readTail(logPath, 2000).trim().split(/\r?\n/).pop() || `ffmpeg 退出码 ${code}`;
        repo.updateVideo(video.id, {
          transcode_status: 'failed',
          error: `转码失败: ${err}`.slice(0, 500),
        });
        if (hooks.onFail) hooks.onFail(video.id);
      }
    });

    child.on('error', (err) => {
      running.delete(video.id);
      repo.updateVideo(video.id, {
        transcode_status: 'failed',
        error: `转码进程启动失败: ${err.message}`.slice(0, 500),
      });
      if (hooks.onFail) hooks.onFail(video.id);
    });

    return { outPath, logPath };
  }

  /** 停掉所有转码（关站时调用，否则进程退不出来） */
  function stopAll() {
    const { killTree } = require('../infra/subprocess');
    const ids = [...running.keys()];
    for (const id of ids) {
      const t = running.get(id);
      if (t && t.child && t.child.pid) killTree(t.child.pid);
    }
    running.clear();
    return ids.length;
  }

  return {
    TRANSCODE_PRESETS,
    presetList,
    start,
    stopAll,
    activeCount,
    isRunning,
    outputPathFor,
    /** 供测试断言 —— 生产代码别用 */
    _running: running,
  };
}

module.exports = { createTranscodeService, TRANSCODE_PRESETS, presetList };
