/**
 * 全局状态 —— 一处可读的、集中管理的可变数据。
 *
 * 重构前这些散在 994 行单文件的各处：`state` 对象、`saveFormTimer`、
 * `searchTimer`、以及十几个直接读 DOM 当状态用的地方（比如"当前视图"是从
 * class 里反推的）。结果是"刷新后要恢复什么"永远说不清。
 *
 * 现在的约定：**界面上能看到的东西，都必须能从 state 推出来。**
 * 只有"用户正在输入、还没提交"的内容才留在 DOM 里，而它也会被
 * persist 到 localStorage。
 */

import { safeStorage } from './dom.js';

const PREF_KEY = 'videoVault.prefs.v2';

const defaultPrefs = () => ({
  // 添加页表单
  addForm: { urls: '', kind: 'video', quality: 'best', rate: 0, forcePlaylist: false },
  // 库页视图
  library: { view: 'grid', q: '', status: '', site: '', uploader: '', sort: 'created_desc', starred: false },
  // 最近任务面板是否展开
  historyOpen: false,
  // 上一次的提交报告
  lastReport: null,
  // 当前标签页
  tab: 'add',
});

function loadPrefs() {
  const saved = safeStorage(PREF_KEY);
  const base = defaultPrefs();
  if (!saved || typeof saved !== 'object') return base;
  // 与默认值深合并：以后加字段时老用户不会因为缺字段而崩
  return {
    ...base,
    ...saved,
    addForm: { ...base.addForm, ...(saved.addForm || {}) },
    library: { ...base.library, ...(saved.library || {}) },
  };
}

export const state = {
  /** 服务端信息（/api/health） */
  health: null,
  /** 队列快照 */
  queue: { active: 0, concurrency: 2, running: [], history: [], counts: {} },
  /** 库数据 */
  library: { rows: [], total: 0 },
  /** 筛选项计数 */
  facets: null,
  /** 登录态状态 */
  cookies: null,
  /** SSE 连接是否还活着 */
  connected: false,
  /** 用户偏好（持久化到 localStorage） */
  prefs: loadPrefs(),
};

/** 把偏好写回 localStorage。改动后要显式调用 —— 不做自动侦听（太魔法了） */
export function savePrefs(patch = {}) {
  state.prefs = {
    ...state.prefs,
    ...patch,
    addForm: { ...state.prefs.addForm, ...(patch.addForm || {}) },
    library: { ...state.prefs.library, ...(patch.library || {}) },
  };
  safeStorage(PREF_KEY, state.prefs);
  return state.prefs;
}

/** 测试用：清掉持久化 */
export function resetPrefs() {
  safeStorage(PREF_KEY, defaultPrefs());
  state.prefs = defaultPrefs();
}
