// 产物浏览状态机（Spec §8.2.5 / §8.3 / DAG 节点 artifacts）：纯逻辑，无隐藏模块状态。
// 双入口（全局管理页 / 会话内产物）、只读预览、可读错误；会话内进入时完整保留待回答组返回态。
// 每次转移返回新对象；无变化时返回原对象，避免无谓重渲染。

import {
  ARTIFACT_ENTRY_POINTS, ARTIFACT_LAYOUTS, ARTIFACT_ERRORS, artifactKindLabel,
} from './contract.mjs';

const str = value => String(value ?? '');
const arr = value => (Array.isArray(value) ? value : []);
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => (isObject(value) ? JSON.parse(JSON.stringify(value)) : null);

function extOf(p) {
  const name = str(p).split(/[\\/]/).pop() || '';
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

// 产物元数据归一化：会话/任务/路径必须齐备，供列表卡直接渲染；不读文件内容。
export function createArtifact(raw = {}, { sessionId, task } = {}) {
  const source = isObject(raw) ? raw : {};
  const relPath = str(source.path);
  const name = str(source.name || relPath.split(/[\\/]/).pop() || relPath);
  const ext = extOf(relPath || name);
  return {
    id: str(source.id || `${str(sessionId ?? source.sessionId)}:${relPath}`),
    path: relPath,
    name,
    sessionId: str(sessionId ?? source.sessionId),
    task: str(task ?? source.task),
    size: Math.max(0, num(source.size)),
    at: str(source.at),
    ext,
    kindLabel: artifactKindLabel(ext),
    readOnly: true,
  };
}

export function createArtifactBrowser({
  id = '', entry = 'global', layout = 'phone', sessionId = '',
  artifacts = [], selectedId = null, opened = false,
  listScrollTop = 0, readerScrollTop = 0, returnState = null, error = null,
} = {}) {
  return {
    id: str(id),
    entry: ARTIFACT_ENTRY_POINTS.includes(entry) ? entry : 'global',
    layout: ARTIFACT_LAYOUTS.includes(layout) ? layout : 'phone',
    sessionId: str(sessionId),
    // 全局产物页的每条产物自带所属会话；会话内入口才用浏览器会话 id 兜底。
    artifacts: arr(artifacts).map(artifact => createArtifact(artifact, {
      sessionId: isObject(artifact) && artifact.sessionId != null ? artifact.sessionId : sessionId,
      task: isObject(artifact) ? artifact.task : undefined,
    })),
    selectedId: selectedId == null ? null : str(selectedId),
    opened: Boolean(opened),
    listScrollTop: num(listScrollTop),
    readerScrollTop: num(readerScrollTop),
    returnState: clone(returnState),
    error: error == null ? null : str(error),
  };
}

// 按浏览器 id 建独立实例，互不共享状态（不同会话/卡片的产物浏览隔离）。
export function createArtifactBrowsers(browsers = []) {
  const registry = {};
  for (const raw of arr(browsers)) {
    const browser = createArtifactBrowser(raw);
    if (browser.id) registry[browser.id] = browser;
  }
  return registry;
}

// 进入产物浏览：会话入口带上待回答组返回态（副本），全局入口不带会话返回态。
export function openArtifacts(browser, { entry, sessionId, returnState } = {}) {
  if (!isObject(browser)) return browser;
  const next = entry === undefined ? browser.entry : entry;
  if (!ARTIFACT_ENTRY_POINTS.includes(next)) return browser;
  if (next === 'session') {
    const restored = clone(returnState) || browser.returnState;
    return {
      ...browser, entry: 'session', sessionId: str(sessionId ?? browser.sessionId),
      returnState: restored, opened: false, error: null,
    };
  }
  return { ...browser, entry: 'global', sessionId: '', returnState: null, opened: false, error: null };
}

export const openFromSession = (browser, opts = {}) => openArtifacts(browser, { ...opts, entry: 'session' });
export const openFromGlobal = browser => openArtifacts(browser, { entry: 'global' });

// 打开单个产物：不存在给可读错误，不外泄路径；有效则选中进入只读预览。
// 折叠布局只更新阅读侧（selectedId），左侧列表与滚动位置不动。
export function selectArtifact(browser, artifactId) {
  if (!isObject(browser)) return browser;
  const target = str(artifactId);
  if (!arr(browser.artifacts).some(artifact => artifact.id === target)) {
    return { ...browser, selectedId: null, opened: false, error: ARTIFACT_ERRORS.missing };
  }
  if (browser.selectedId === target && browser.opened === true && browser.error === null) return browser;
  return { ...browser, selectedId: target, opened: true, error: null };
}

// 逐级返回：手机从阅读回到列表，保留列表位置；折叠屏收起阅读侧。
export function closeReader(browser) {
  if (!isObject(browser) || browser.opened === false) return browser;
  return { ...browser, opened: false };
}

// 全局产物页：按会话与关键字过滤，不虚构不存在的产物。
export function filterArtifacts(browser, { query = '', sessionId = '' } = {}) {
  if (!isObject(browser)) return [];
  const q = str(query).trim().toLowerCase();
  const sid = str(sessionId);
  return arr(browser.artifacts).filter(artifact => {
    if (sid && artifact.sessionId !== sid) return false;
    if (!q) return true;
    return [artifact.name, artifact.path, artifact.task, artifact.sessionId]
      .some(field => str(field).toLowerCase().includes(q));
  });
}

export function setListScrollTop(browser, top) {
  if (!isObject(browser)) return browser;
  const value = num(top);
  if (browser.listScrollTop === value) return browser;
  return { ...browser, listScrollTop: value };
}

export function setReaderScrollTop(browser, top) {
  if (!isObject(browser)) return browser;
  const value = num(top);
  if (browser.readerScrollTop === value) return browser;
  return { ...browser, readerScrollTop: value };
}

export function setError(browser, message) {
  if (!isObject(browser)) return browser;
  const readable = str(message).trim() || ARTIFACT_ERRORS.missingState;
  if (browser.error === readable) return browser;
  return { ...browser, error: readable, opened: false };
}

export function clearError(browser) {
  if (!isObject(browser) || browser.error === null) return browser;
  return { ...browser, error: null };
}

// 返回会话：交回进入前保留的返回态（草稿/滚动逐字一致），并收起阅读侧。
// 全局入口没有会话可返回，return 为 null。
export function backFromArtifacts(browser) {
  if (!isObject(browser)) return { state: browser, return: null };
  const state = { ...browser, opened: false, selectedId: null, error: null };
  const canReturn = browser.entry === 'session' && isObject(browser.returnState);
  return {
    state,
    return: canReturn
      ? { sessionId: browser.sessionId, entry: 'session', restore: clone(browser.returnState) }
      : null,
  };
}

// 快照为可 JSON 化的纯数据；旋转/折叠后逐字段恢复，返回态不丢。
export function snapshotBrowser(browser) {
  return isObject(browser) ? JSON.parse(JSON.stringify(browser)) : createArtifactBrowser();
}

export function restoreBrowser(snapshot) {
  if (!isObject(snapshot)) return createArtifactBrowser();
  return createArtifactBrowser(snapshot);
}
