// 会话页面纯视图模型（Spec §8.2.4 / §8.2.6 / DAG 节点 sessions）：
// 会话列表（类型筛选/搜索/当前会话/新建入口/已归档与历史）、新建会话与语义分类推荐、
// 已归档会话的只读查看与恢复。输入是后端投影后的普通对象，输出是可安全渲染的普通对象。
// 每个列表都是 collection（空时带明确 reason）；任何状态、模型、转录都只取真实字段。
// 本节点只读展示 + 生成恢复请求，不启动会话、不写存档、不发请求，调用方负责执行并回传结果。

import { collection } from '../../core/contract.mjs';
import {
  SESSION_KINDS, SESSION_KIND_FILTERS, sessionKindLabel, RESTORE_INJECTED_TURNS,
} from './contract.mjs';

const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const matchesQuery = (session, query) => {
  if (!query) return true;
  const haystack = [session?.title, session?.project, session?.projectLabel, session?.kindLabel]
    .map(value => String(value ?? '').toLowerCase()).join(' ');
  return haystack.includes(query.toLowerCase());
};

// 会话列表：类型筛选 + 搜索作用于列表；当前会话单列，新建入口与已归档折叠区齐备。
// 数据缺失时整页 ready=false，各集合显示明确空态，绝不编造会话条目。
export function buildSessionList(snapshot = {}, options = {}) {
  const src = object(snapshot);
  const sessionsAvailable = Array.isArray(src.sessions);
  const archivesAvailable = Array.isArray(src.archives);
  const sessionReason = '会话数据缺失，未读取到会话列表';
  const sessionError = String(src.sessionsError || '').trim() || sessionReason;
  const archiveReason = '归档数据缺失，未读取到已归档会话';
  const allSessions = sessionsAvailable ? src.sessions : [];
  const archives = archivesAvailable ? src.archives : [];
  const kind = SESSION_KIND_FILTERS.some(item => item.id === options.kind) ? options.kind : 'all';
  const query = String(options.query ?? '').trim();
  const filtered = allSessions.filter(session =>
    (kind === 'all' || session?.kind === kind) && matchesQuery(session, query));
  const current = src.currentId && sessionsAvailable
    ? (allSessions.find(session => session?.id === src.currentId) ?? null)
    : null;

  return {
    id: 'sessions', title: '会话',
    ready: sessionsAvailable,
    error: sessionsAvailable ? null : sessionError,
    kindFilter: { selected: kind, options: SESSION_KIND_FILTERS },
    query,
    current,
    sessions: collection(filtered, sessionsAvailable ? '暂无会话' : sessionReason),
    newSession: {
      available: sessionsAvailable,
      action: 'create-session',
      hint: '选择项目并输入首轮提示词后创建会话',
    },
    archived: {
      collapsed: true,
      count: archives.length,
      expandAction: 'toggle-archived',
      ...collection(archives, archivesAvailable ? '暂无已归档会话' : archiveReason),
    },
  };
}

// 新建会话表单：语义分类推荐来自 /api/session-classify 的结果（调用方传入），默认采用推荐、
// 用户可手动覆盖；推荐缺失时不编造。首轮提示词与项目是提交前提。
export function buildNewSessionForm({ projects = [], prompt = '', classification = null, selectedKind = null } = {}) {
  const options = (Array.isArray(projects) ? projects : [])
    .filter(item => item && typeof item.id === 'string' && item.id.length > 0)
    .map(item => ({ id: item.id, label: String(item.label || item.id) }));
  const cleanPrompt = String(prompt ?? '');
  const classified = object(classification);
  const recommendation = SESSION_KINDS.includes(classified.kind)
    ? { kind: classified.kind, label: sessionKindLabel(classified.kind), reason: String(classified.reason ?? '').trim() }
    : null;
  const chosen = SESSION_KINDS.includes(selectedKind) ? selectedKind : (recommendation?.kind || 'normal');

  return {
    projectOptions: collection(options, '暂无可选项目'),
    prompt: cleanPrompt,
    recommendation,
    selectedKind: chosen,
    kindOptions: SESSION_KINDS.map(kind => ({
      id: kind,
      label: sessionKindLabel(kind),
      recommended: kind === recommendation?.kind,
      selected: kind === chosen,
    })),
    canSubmit: cleanPrompt.trim().length > 0 && options.length > 0,
    action: 'create-session',
    hint: recommendation?.reason || '输入首轮提示词后自动推荐会话类型，可手动修改',
  };
}

// 只读详情：接受 mobileArchiveTranscript 的输出，补上恢复入口；转录保持原样，不改写文本。
export function buildArchiveDetail(transcript = null) {
  const src = object(transcript);
  if (!src.id) {
    return {
      id: null, empty: true, reason: '会话存档不存在或数据缺失', readOnly: true,
      messages: collection([], '会话存档不存在或数据缺失'),
      restore: { action: 'restore-session', available: false, keepsOriginal: true },
    };
  }
  return {
    id: src.id,
    shortId: src.shortId || String(src.id).slice(0, 8),
    project: src.project || null,
    projectLabel: src.projectLabel || '未识别',
    kindLabel: src.kindLabel || null,
    endStatus: src.endStatus || null,
    endStatusLabel: src.endStatusLabel || '未知',
    transcriptCount: src.transcriptCount || 0,
    readOnly: true,
    messages: src.messages && Array.isArray(src.messages.items)
      ? src.messages : collection([], '暂无转录记录'),
    restore: {
      action: 'restore-session',
      available: true,
      keepsOriginal: true,
      injectedTurns: RESTORE_INJECTED_TURNS,
    },
  };
}

// 恢复请求：走既有 continue 端点（服务端用存档转录新建会话并注入最近 N 轮），不在此发起请求。
export function buildRestoreRequest(record = null) {
  const id = String(record?.id ?? '').trim();
  return {
    method: 'POST',
    path: id ? `/api/scheduling-sessions/${encodeURIComponent(id)}/continue` : null,
    body: null,
    originalId: id || null,
    available: Boolean(id),
    keepsOriginal: true,
    injectedTurns: RESTORE_INJECTED_TURNS,
    note: `恢复创建新会话并注入最近 ${RESTORE_INJECTED_TURNS} 轮转录，原记录保留`,
  };
}

// 恢复结果回填：无论成功或失败都不从归档列表删除原记录——失败带 restoreError，成功带 restoredTo。
export function applyRestoreResult(archiveCollection, recordId, result = {}) {
  const col = archiveCollection && Array.isArray(archiveCollection.items)
    ? archiveCollection
    : collection([], '暂无已归档会话');
  const ok = result.ok === true;
  const items = col.items.map(item => (item?.id === recordId ? {
    ...item,
    restoreError: ok ? null : String(result.error || '恢复失败，原记录已保留'),
    restoredTo: ok ? (result.newSessionId || null) : null,
  } : item));
  return { ...col, items, empty: false, reason: null };
}
