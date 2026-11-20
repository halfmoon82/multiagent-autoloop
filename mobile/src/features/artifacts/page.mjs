// 产物页装配接线（DAG 节点 ui-artifacts）：把产物浏览器状态机接成
// 「全局产物页 + 会话入口 + 手机单栈逐级返回 / 折叠双栏 + 原生下载」。
// 纯逻辑：不碰 DOM、不发请求、不拼接 HTML；副作用只描述成数据，由 pages/artifacts.mjs 的 mount 执行。
// Node 边界测试直接导入断言接线，浏览器加载走同一份代码。

import {
  createArtifactBrowser, openFromGlobal, openFromSession,
  selectArtifact, closeReader, backFromArtifacts, setError,
} from './browser.mjs';
import { buildArtifactBrowserBinding } from './views.mjs';
import { ARTIFACT_ERRORS } from './contract.mjs';

const str = value => String(value ?? '');
const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const arr = value => (Array.isArray(value) ? value : []);

export const ARTIFACT_PAGE = 'artifacts';
export const ARTIFACT_SESSION_PAGE = 'sessions';
export const ARTIFACT_READ_VIEW = 'artifact-read';

// 阅读视图登记项：供 ctx.hooks.pushView 登记，返回键据此逐级退出。
export function artifactReadView(browser) {
  const source = isObj(browser) ? browser : {};
  return {
    id: ARTIFACT_READ_VIEW,
    entry: str(source.entry || 'global'),
    sessionId: str(source.sessionId),
    artifactId: str(source.selectedId),
  };
}

// 原生下载 URL：基址必须 https（原生桥自行读取设备凭据并注入 x-device-token）。
// 只指向 GET /api/mobile/sessions/<sid>/download?path=<相对路径>，不返回可跳转的普通链接。
// 明文基址与坏 URL 一律拒绝，避免退化成不带令牌的普通跳转。
export function artifactDownloadUrl(base, sessionId, path) {
  const raw = str(base).trim();
  if (!/^https:\/\//i.test(raw)) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  parsed.pathname = `/api/mobile/sessions/${encodeURIComponent(str(sessionId))}/download`;
  parsed.search = '';
  parsed.hash = '';
  const rel = str(path).trim();
  if (rel) parsed.searchParams.set('path', rel);
  return parsed.toString();
}

// 页面渲染计划：状态机 → 列表行 / 阅读侧 / 双栏 / 返回可用 / 下载目标。
// 双栏时列表常驻，只按 opened/selectedId 刷新阅读侧。
export function artifactPagePlan(browser) {
  const source = isObj(browser) ? browser : {};
  const binding = buildArtifactBrowserBinding(source);
  const dualPane = binding.pane === 'dual';
  const readerVisible = Boolean(source.opened === true && binding.selected);
  const selected = binding.selected;
  return {
    ...binding,
    dualPane,
    readerVisible,
    listVisible: !readerVisible || dualPane,
    canReturn: binding.returnAvailable,
    download: selected
      ? { name: selected.name, path: selected.path, sessionId: binding.sessionId }
      : null,
  };
}

function withArtifacts(browser, list, layout) {
  return createArtifactBrowser({
    ...browser,
    artifacts: arr(list),
    ...(layout ? { layout } : {}),
  });
}

// 全局产物页入口：切到全局，装载产物集合，不携带会话返回态。
export function openGlobalArtifacts(browser, { artifacts = [], layout } = {}) {
  const next = withArtifacts(openFromGlobal(browser), artifacts, layout);
  return { browser: next, effects: [{ type: 'selectTab', page: ARTIFACT_PAGE }] };
}

// 会话内产物入口：切到会话，装载产物集合，完整保留待回答组返回态副本。
export function openSessionArtifacts(browser, { artifacts = [], sessionId, returnState, layout } = {}) {
  const next = withArtifacts(openFromSession(browser, { sessionId, returnState }), artifacts, layout);
  return { browser: next, effects: [{ type: 'selectTab', page: ARTIFACT_PAGE }] };
}

// 打开单个产物：有效则进入只读预览并登记阅读视图；缺失给可读错误，不登记。
export function openArtifactReader(browser, artifactId) {
  const next = selectArtifact(browser, artifactId);
  if (next.error || !next.opened) return { browser: next, effects: [] };
  return { browser: next, effects: [{ type: 'pushView', view: artifactReadView(next) }] };
}

// 返回键：阅读页先逐级 popView 收起阅读侧；无阅读栈时从会话入口退回会话并交回返回态。
export function backArtifactReader(browser) {
  const source = isObj(browser) ? browser : {};
  if (source.opened === true) {
    return { browser: closeReader(source), effects: [{ type: 'popView' }] };
  }
  const result = backFromArtifacts(source);
  const effects = [];
  if (result.return) {
    effects.push({ type: 'restoreSession', payload: result.return });
    effects.push({ type: 'selectTab', page: ARTIFACT_SESSION_PAGE });
  }
  return { browser: result.state, effects };
}

// 下载：只产出 download 副作用（url/name），由 mount 调 ctx.hooks.download 走原生桥。
// 无 HTTPS 基址或产物缺失给可读错误，用户可重试。
export function downloadArtifact(browser, artifactId, base) {
  const source = isObj(browser) ? browser : {};
  const artifact = arr(source.artifacts).find(item => str(item.id) === str(artifactId));
  if (!artifact) return { browser: setError(source, ARTIFACT_ERRORS.missing), effects: [] };
  const url = artifactDownloadUrl(base, artifact.sessionId, artifact.path);
  if (!url) {
    return { browser: setError(source, '下载需要安全连接（HTTPS），请重新连接后重试'), effects: [] };
  }
  return { browser: source, effects: [{ type: 'download', url, name: str(artifact.name) }] };
}
