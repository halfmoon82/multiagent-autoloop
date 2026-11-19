// 产物浏览视图模型（Spec §8.2.5 / §8.3 / DAG 节点 artifacts）：
// 把状态机投影成「入口 + 列表 + 只读预览 + 返回态」的普通对象，供全局产物页与会话流统一装配。
// 不读文件、不发请求、不拼接 HTML；上游文本原样以字符串返回，由调用方用 textContent 安全渲染。

import {
  artifactEntryLabel, artifactLayoutLabel, ARTIFACT_MOBILE_READ_ONLY,
  ARTIFACT_SHARE_READ_ONLY, ARTIFACT_FILE_TOUCH_TARGET_DP,
} from './contract.mjs';

const str = value => String(value ?? '');
const arr = value => (Array.isArray(value) ? value : []);
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function sizeText(size) {
  const bytes = Math.max(0, num(size));
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function artifactRow(artifact, selectedId) {
  return {
    id: str(artifact?.id),
    name: str(artifact?.name),
    path: str(artifact?.path),
    sessionId: str(artifact?.sessionId),
    sessionLabel: str(artifact?.sessionId) || '未归属会话',
    taskLabel: str(artifact?.task) || '未标注任务',
    sizeText: sizeText(artifact?.size),
    at: str(artifact?.at),
    kindLabel: str(artifact?.kindLabel),
    readOnly: ARTIFACT_MOBILE_READ_ONLY,
    selected: str(artifact?.id) === str(selectedId),
  };
}

export function buildArtifactBrowserBinding(browser) {
  const source = isObject(browser) ? browser : {};
  const rows = arr(source.artifacts).map(artifact => artifactRow(artifact, source.selectedId));
  const selected = rows.find(row => row.selected) || null;
  return {
    id: str(source.id),
    entry: str(source.entry || 'global'),
    entryLabel: artifactEntryLabel(source.entry),
    layout: str(source.layout || 'phone'),
    layoutLabel: artifactLayoutLabel(source.layout),
    sessionId: str(source.sessionId),
    artifacts: rows,
    count: rows.length,
    selected,
    pane: source.layout === 'fold' ? 'dual' : 'stack',
    listScrollTop: num(source.listScrollTop),
    readerScrollTop: num(source.readerScrollTop),
    error: source.error == null ? null : str(source.error),
    returnAvailable: Boolean(source.returnState),
    readOnly: ARTIFACT_MOBILE_READ_ONLY,
    shareReadOnly: ARTIFACT_SHARE_READ_ONLY,
    touchTargetDp: ARTIFACT_FILE_TOUCH_TARGET_DP,
  };
}
