// 调度会话存档：写穿 JSON 到 <AGENT_AUTOLOOP_HOME>/console-sessions/，
// 控制台重启后会话留档可回溯、可一键继续。只接受 UUID 文件名，加载做形状校验。
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export class ArchiveError extends Error {
  constructor(message, { status = 400 } = {}) { super(message); this.name = 'ArchiveError'; this.status = status; }
}

export const CONTINUATION_TURNS = 10;
const ARCHIVE_VERSION = 1;
const MAX_MESSAGE_BYTES = 4096;
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SESSION_KINDS = ['normal', 'scheduling', 'design'];
const iso = value => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);
const text = (value, max) => String(value ?? '').slice(0, max);
const collectionOf = (items, emptyReason) => ({
  items, empty: items.length === 0, reason: items.length ? null : emptyReason,
});

function normalizeRecord(input) {
  if (!input || typeof input !== 'object') throw new ArchiveError('存档内容不是对象');
  const id = String(input.id || '');
  if (!ID_PATTERN.test(id)) throw new ArchiveError(`存档 id 非法：${id || '空'}`);
  const messages = Array.isArray(input.messages) ? input.messages.map(message => ({
    role: message.role === 'user' ? 'user' : 'agent',
    text: text(message.text, MAX_MESSAGE_BYTES),
    at: iso(message.at) || new Date(0).toISOString(),
  })) : [];
  return {
    version: ARCHIVE_VERSION,
    id,
    kind: SESSION_KINDS.includes(input.kind) ? input.kind : 'scheduling',
    project: text(input.project, 500),
    agent: text(input.agent, 120) || 'Codex ACP',
    prompt: text(input.prompt, 4000),
    continuedFrom: ID_PATTERN.test(input.continuedFrom || '') ? input.continuedFrom : null,
    messages,
    createdAt: iso(input.createdAt) || new Date().toISOString(),
    updatedAt: iso(input.updatedAt) || new Date().toISOString(),
    closedAt: iso(input.closedAt),
    endStatus: ['active', 'closed', 'error', 'interrupted'].includes(input.endStatus) ? input.endStatus : 'interrupted',
    truncated: input.truncated === true,
  };
}

function truncateMessages(record) {
  const encoded = JSON.stringify(record.messages);
  if (Buffer.byteLength(encoded) <= MAX_ARCHIVE_BYTES) return record;
  const messages = [...record.messages];
  while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages)) > MAX_ARCHIVE_BYTES) messages.shift();
  return { ...record, messages, truncated: true };
}

export class SessionArchive {
  // retention 参数仅作兼容保留：已完成历史默认折叠、可查看，绝不按保留条数自动删除（2026-11-16 已确认决策 7）。
  constructor(root, { retention = null, now = () => new Date() } = {}) {
    this.root = root ? path.join(root, 'console-sessions') : null;
    this.retention = retention;
    this.now = now;
  }

  #file(id) {
    if (!ID_PATTERN.test(String(id || ''))) throw new ArchiveError('会话存档不存在', { status: 404 });
    return path.join(this.root, `${id}.json`);
  }

  #write(record) {
    if (!this.root) throw new ArchiveError('未配置运行目录，无法存档');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = this.#file(record.id);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }

  async save(input) {
    this.#write(truncateMessages(normalizeRecord(input)));
  }

  async read(id) {
    let raw;
    try { raw = readFileSync(this.#file(id), 'utf8'); }
    catch { throw new ArchiveError('会话存档不存在', { status: 404 }); }
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new ArchiveError('该存档文件已损坏'); }
    return normalizeRecord(data);
  }

  // markActive 仅在控制台启动恢复时开启：把上次异常退出留下的 active 标为 interrupted 并写回；
  // 日常列表查询必须关闭，否则在册会话的存档会每个轮询周期被翻转重写。
  async loadAllDetailed({ markActive = false } = {}) {
    const sessions = [];
    const errors = [];
    if (!this.root) return { sessions, errors };
    let files;
    try { files = readdirSync(this.root).filter(name => name.endsWith('.json') && ID_PATTERN.test(name.replace(/\.json$/, ''))); }
    catch { return { sessions, errors }; }
    for (const name of files) {
      const id = name.replace(/\.json$/, '');
      try {
        const record = normalizeRecord(JSON.parse(readFileSync(path.join(this.root, name), 'utf8')));
        if (markActive && record.endStatus === 'active') {
          record.endStatus = 'interrupted';
          record.updatedAt = this.now().toISOString();
          try { this.#write(record); } catch { /* 写回失败只影响标记，不影响展示 */ }
        }
        sessions.push(record);
      } catch (error) {
        errors.push(`${name}：${error.message}`);
      }
    }
    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { sessions, errors };
  }


  // 组装"继续调度"的首轮提示词：最近 N 轮转录 + 续跑指令。
  async buildContinuation(id) {
    const record = await this.read(id);
    const turns = record.messages.slice(-CONTINUATION_TURNS);
    const transcript = turns.map(message => `【${message.role === 'user' ? '主人' : '调度会话'}】${message.text}`).join('\n');
    return [
      `【会话续跑】这是此前调度会话（${record.id.slice(0, 8)}，项目 ${record.project}）的最近 ${turns.length} 条记录。`,
      '请阅读本仓库 AGENTS.md 等资料后接着推进：先简要汇报上次中断时的状态与下一步计划，再继续执行。',
      record.prompt ? `【首轮调度说明】\n${record.prompt}` : '',
      transcript ? `【最近转录】\n${transcript}` : '',
    ].filter(Boolean).join('\n\n');
  }
}

// 移动端已归档会话视图模型（DAG 节点 sessions）：纯投影 helper，只读、不写存档、不创建会话。
// 缺失值留空、不编造转录或停止原因；上游文本全程是纯字符串，由调用方安全渲染。
const ARCHIVE_KIND_LABELS = { normal: '普通会话', scheduling: '调度会话', design: '设计会话' };
export const ARCHIVE_END_STATUS_LABELS = Object.freeze({
  active: '进行中', closed: '已停止', error: '异常中断', interrupted: '异常中断',
});
const archiveEndStatusLabel = value => ARCHIVE_END_STATUS_LABELS[value] || '未知';
const archiveProjectLabel = value => {
  const text = String(value ?? '').trim().replace(/[/\\]+$/, '');
  if (!text) return '';
  return text.split(/[/\\]/).filter(Boolean).pop() || text;
};
const validArchive = record => record && typeof record === 'object' && !Array.isArray(record)
  && ID_PATTERN.test(String(record.id || ''));

export function mobileArchiveSummaries(records = []) {
  return (Array.isArray(records) ? records : []).filter(validArchive).map(record => {
    const project = String(record.project ?? '').trim();
    const messages = Array.isArray(record.messages) ? record.messages : [];
    return {
      id: record.id,
      shortId: record.id.slice(0, 8),
      kind: SESSION_KINDS.includes(record.kind) ? record.kind : 'scheduling',
      kindLabel: ARCHIVE_KIND_LABELS[record.kind] || ARCHIVE_KIND_LABELS.scheduling,
      project,
      projectLabel: archiveProjectLabel(project),
      transcriptCount: messages.length,
      endStatus: String(record.endStatus ?? '').trim() || null,
      endStatusLabel: archiveEndStatusLabel(record.endStatus),
      closedAt: iso(record.closedAt),
      continuedFrom: ID_PATTERN.test(record.continuedFrom || '') ? record.continuedFrom : null,
      truncated: record.truncated === true,
    };
  });
}

// 只读转录：role 只映射成展示名，文本逐字保留，调用方用 textContent 渲染。
export function mobileArchiveTranscript(record) {
  if (!validArchive(record)) return {
    id: null, empty: true, reason: '会话存档不存在或数据缺失', readOnly: true,
    messages: collectionOf([], '会话存档不存在或数据缺失'),
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
    projectLabel: archiveProjectLabel(project),
    kindLabel: ARCHIVE_KIND_LABELS[record.kind] || ARCHIVE_KIND_LABELS.scheduling,
    endStatus: String(record.endStatus ?? '').trim() || null,
    endStatusLabel: archiveEndStatusLabel(record.endStatus),
    transcriptCount: messages.length,
    readOnly: true,
    messages: collectionOf(messages, '暂无转录记录'),
  };
}

// 恢复上下文：通过既有 continue 端点「新建会话 + 注入最近 N 轮」，原存档记录始终保留。
export function mobileRestoreContext(record) {
  if (!validArchive(record)) return { originalId: null, keepsOriginal: true, injectedTurns: 0, command: null };
  const turns = Array.isArray(record.messages) ? record.messages.length : 0;
  return {
    originalId: record.id,
    continuedFrom: record.id,
    kind: SESSION_KINDS.includes(record.kind) ? record.kind : 'scheduling',
    project: String(record.project ?? '').trim(),
    keepsOriginal: true,
    injectedTurns: Math.min(CONTINUATION_TURNS, turns),
    command: `POST /api/scheduling-sessions/${record.id}/continue`,
  };
}
