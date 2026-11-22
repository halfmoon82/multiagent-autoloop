// 浏览器侧投影：把 /api/scheduling-sessions 与 /api/session-archives 的真实响应转成
// buildSessionList/buildArchiveDetail 所需的普通对象。口径与 src/scheduling-session.mjs、
// src/session-archive.mjs 的同名 helper 一致（测试守门），不在此重复业务判定。
// 纯函数、不触碰浏览器全局、不依赖 node: 内置模块；上游文本原样保留，由调用方安全渲染。

import { collection } from '../../core/contract.mjs';
import { SESSION_KINDS, END_STATUS_LABELS, RESTORE_INJECTED_TURNS } from './contract.mjs';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_STATUS_LABELS = Object.freeze({
  initializing: '初始化中', running: '运行中', idle: '待命', error: '异常',
  unknown: '待复核', closing: '关闭中', closed: '已关闭',
});
const statusLabel = value => SESSION_STATUS_LABELS[value] || value;
// 列表标题：调度/设计会话的 prompt 会被系统拼装（注入“本轮完整资料”、加“项目：”前缀），
// 直接截断会得到一堵无法辨认的文本墙。取用户真正的第一句话：剥“项目：”前缀行、
// 截掉上下文注入段、取首行、压空白、45 字截断。
export function compactSessionTitle(prompt) {
  let text = String(prompt ?? '').replace(/\r/g, '');
  // 上下文注入 trailer 有固定形态，锚定完整前缀防止误伤用户原文里碰巧出现的短语。
  const injected = text.indexOf('本轮完整资料（项目规则、状态快照与上一轮结论）：');
  if (injected > 0) text = text.slice(0, injected);
  text = text.replace(/^项目：[^\n]*\n/, '').trim();
  // 设计会话的 prompt 被整体改写为角色设定（"你是 <路径> 上的设计会话，负责……\n【协作方式】…\n【本次附加说明】\n<用户原话>"），
  // 用户原话在【本次附加说明】段；优先取它，其次取"负责"后的职责描述，都比角色抬头更能辨认这条会话。
  const designNote = /【本次附加说明】\s*([\s\S]+)$/.exec(text);
  const designRole = /上的设计会话，负责(.+)$/s.exec(text);
  const body = (designNote ? designNote[1] : designRole ? designRole[1] : text).trim();
  const firstLine = (body.split('\n').find(line => line.trim()) || '').trim().replace(/\s+/g, ' ');
  if (!firstLine) return '会话';
  return firstLine.length > 45 ? `${firstLine.slice(0, 45)}…` : firstLine;
}
// MM-DD HH:MM（本地时间感知的精简格式；坏时间戳返回空串，不编造）。
const shortStamp = value => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '';
  const d = new Date(parsed);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const iso = value => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);
const shortProjectLabel = value => {
  const text = String(value ?? '').trim().replace(/[/\\]+$/, '');
  if (!text) return '';
  return text.split(/[/\\]/).filter(Boolean).pop() || text;
};
const archiveEndStatusLabel = value => END_STATUS_LABELS[value] || '未知';
const validArchive = record => record && typeof record === 'object' && !Array.isArray(record)
  && ID_PATTERN.test(String(record.id || ''));

// 活跃会话：真实字段，缺失留空；非法类型回退调度会话，无提示词回退通用标题。
export function mobileSessionSummaries(sessions = []) {
  return (Array.isArray(sessions) ? sessions : [])
    .filter(session => session && typeof session === 'object' && !Array.isArray(session)
      && typeof session.id === 'string' && session.id.length > 0)
    .map(session => {
      const kind = SESSION_KINDS.includes(session.kind) ? session.kind : 'scheduling';
      const project = String(session.project ?? '').trim();
      return {
        id: session.id,
        kind,
        kindLabel: ({ normal: '普通会话', scheduling: '调度会话', design: '设计会话' })[kind],
        title: compactSessionTitle(session.prompt),
        updatedLabel: shortStamp(session.updatedAt) || shortStamp(session.createdAt),
        // 详情视图要显示完整首轮提示词与在线转录；只放行 role/text/at 三个展示字段。
        prompt: String(session.prompt ?? '').trim(),
        liveText: typeof session.liveText === 'string' ? session.liveText : '',
        messages: (Array.isArray(session.messages) ? session.messages : []).map(message => ({
          role: String(message?.role ?? ''),
          text: String(message?.text ?? ''),
          at: String(message?.at ?? ''),
        })),
        project,
        projectLabel: shortProjectLabel(project),
        status: String(session.status ?? '').trim() || null,
        statusLabel: statusLabel(session.status),
        agent: String(session.agent ?? '').trim() || null,
        model: session.model ?? null,
        continuedFrom: session.continuedFrom ?? null,
        createdAt: String(session.createdAt ?? '').trim() || null,
        updatedAt: String(session.updatedAt ?? '').trim() || null,
        queue: (Array.isArray(session.queue) ? session.queue : (Array.isArray(session.queued) ? session.queued : []))
          .filter(item => item && typeof item.id === 'string' && item.id)
          .map(item => ({ id: item.id, text: String(item.text ?? ''), at: String(item.at ?? '') })),
        queuedCount: Number.isInteger(session.queuedCount) ? session.queuedCount : 0,
        busy: session.busy === true,
      };
    });
}

// 已归档摘要：条数/停止原因/截断/续跑来源都取真实字段。
export function mobileArchiveSummaries(records = []) {
  return (Array.isArray(records) ? records : []).filter(validArchive).map(record => {
    const project = String(record.project ?? '').trim();
    const messages = Array.isArray(record.messages) ? record.messages : [];
    return {
      id: record.id,
      shortId: record.id.slice(0, 8),
      title: compactSessionTitle(record.prompt),
      kind: SESSION_KINDS.includes(record.kind) ? record.kind : 'scheduling',
      kindLabel: ({ normal: '普通会话', scheduling: '调度会话', design: '设计会话' })[record.kind] || '调度会话',
      project,
      projectLabel: shortProjectLabel(project),
      transcriptCount: messages.length,
      endStatus: String(record.endStatus ?? '').trim() || null,
      endStatusLabel: archiveEndStatusLabel(record.endStatus),
      closedAt: iso(record.closedAt),
      continuedFrom: ID_PATTERN.test(record.continuedFrom || '') ? record.continuedFrom : null,
      truncated: record.truncated === true,
    };
  });
}

// 只读转录：role 只映射展示名，文本逐字保留。
export function mobileArchiveTranscript(record) {
  if (!validArchive(record)) return {
    id: null, empty: true, reason: '会话存档不存在或数据缺失', readOnly: true,
    messages: collection([], '会话存档不存在或数据缺失'),
  };
  const project = String(record.project ?? '').trim();
  const messages = (Array.isArray(record.messages) ? record.messages : []).map(message => ({
    role: message?.role === 'user' ? '主人' : '会话',
    text: String(message?.text ?? ''),
    at: iso(message?.at) || '',
  }));
  return {
    id: record.id,
    shortId: record.id.slice(0, 8),
    project,
    projectLabel: shortProjectLabel(project),
    kindLabel: ({ normal: '普通会话', scheduling: '调度会话', design: '设计会话' })[record.kind] || '调度会话',
    endStatus: String(record.endStatus ?? '').trim() || null,
    endStatusLabel: archiveEndStatusLabel(record.endStatus),
    transcriptCount: messages.length,
    readOnly: true,
    messages: collection(messages, '暂无转录记录'),
  };
}

// 恢复上下文：注入轮数取「实际存在轮数」与服务端上限的较小值，原记录保留。
export function mobileRestoreContext(record) {
  if (!validArchive(record)) return { originalId: null, keepsOriginal: true, injectedTurns: 0, command: null };
  const turns = Array.isArray(record.messages) ? record.messages.length : 0;
  return {
    originalId: record.id,
    continuedFrom: record.id,
    kind: SESSION_KINDS.includes(record.kind) ? record.kind : 'scheduling',
    project: String(record.project ?? '').trim(),
    keepsOriginal: true,
    injectedTurns: Math.min(RESTORE_INJECTED_TURNS, turns),
    command: `POST /api/scheduling-sessions/${record.id}/continue`,
  };
}
