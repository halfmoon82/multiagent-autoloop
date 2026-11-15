// 调度会话存档：写穿 JSON 到 <AGENT_AUTOLOOP_HOME>/console-sessions/，
// 控制台重启后会话留档可回溯、可一键继续。只接受 UUID 文件名，加载做形状校验。
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export class ArchiveError extends Error {
  constructor(message, { status = 400 } = {}) { super(message); this.name = 'ArchiveError'; this.status = status; }
}

export const CONTINUATION_TURNS = 10;
const ARCHIVE_VERSION = 1;
const MAX_MESSAGE_BYTES = 4096;
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const iso = value => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);
const text = (value, max) => String(value ?? '').slice(0, max);

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
  constructor(root, { retention = 20, now = () => new Date() } = {}) {
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
    this.#prune();
  }

  #prune() {
    let files;
    try { files = readdirSync(this.root).filter(name => ID_PATTERN.test(name.replace(/\.json$/, '')) && name.endsWith('.json')); }
    catch { return; }
    if (files.length <= this.retention) return;
    const dated = files.map(name => {
      try { return { name, at: JSON.parse(readFileSync(path.join(this.root, name), 'utf8')).createdAt || '' }; }
      catch { return { name, at: '' }; }
    }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    for (const { name } of dated.slice(this.retention)) {
      try { unlinkSync(path.join(this.root, name)); } catch { /* 清理失败不阻断 */ }
    }
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
