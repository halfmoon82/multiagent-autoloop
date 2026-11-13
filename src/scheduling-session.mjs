import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, '..');
export const DEFAULT_ADAPTER_PATH = path.join(REPOSITORY_ROOT, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');
export const DEFAULT_SCHEDULING_PROMPT = [
  '你是 Multiagent Autoloop 控制台仓库中的调度会话。',
  `工作目录固定为 ${REPOSITORY_ROOT}。`,
  '请先阅读 README.md、AGENTS.md、docs/architecture.md、docs/scheduling-contract.md 和相关测试，了解当前项目边界。',
  '然后检查当前调度状态，整理：1）正在运行/等待重试/待调度处理的事项；2）建议的处理顺序；3）真正需要用户决策的问题。',
  '不要修改文件，不要执行部署，不要改变真实调度规则；需要授权或不可逆操作时只列出等待用户决策。'
].join('\n');

export class SchedulingSessionError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'SchedulingSessionError';
    this.status = status;
  }
}

const safeMessage = error => String(error?.message || error || '未知错误').replace(/[\r\n]+/g, ' ');
const statusLabel = status => ({ initializing: '初始化中', running: '运行中', idle: '待命', error: '异常', closing: '关闭中', closed: '已关闭' })[status] || status;

function toPublicSession(record) {
  return {
    id: record.id,
    sessionId: record.sessionId,
    agent: record.agent,
    cwd: record.cwd,
    status: record.status,
    statusText: statusLabel(record.status),
    prompt: record.prompt,
    stopReason: record.stopReason,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function summarizeUpdate(update) {
  if (!update || typeof update !== 'object') return '收到会话更新';
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') return '正在输出调度分析';
  if (update.sessionUpdate === 'tool_call') return '正在调用工具';
  if (update.sessionUpdate === 'plan') return '正在更新计划';
  return '收到会话更新';
}

export class SchedulingSessionManager {
  constructor({ cwd = REPOSITORY_ROOT, adapterPath = DEFAULT_ADAPTER_PATH, spawnFn = spawn, maxSessions = 3, now = () => new Date() } = {}) {
    this.cwd = path.resolve(cwd);
    this.adapterPath = adapterPath;
    this.spawnFn = spawnFn;
    this.maxSessions = maxSessions;
    this.now = now;
    this.sessions = new Map();
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(toPublicSession);
  }

  async start({ prompt = DEFAULT_SCHEDULING_PROMPT } = {}) {
    const text = String(prompt || '').trim();
    if (!text) throw new SchedulingSessionError('请填写调度处理说明');
    if (text.length > 4000) throw new SchedulingSessionError('调度处理说明不能超过 4000 字');
    if (this.sessions.size >= this.maxSessions) throw new SchedulingSessionError(`最多同时开启 ${this.maxSessions} 个调度会话`);
    if (this.spawnFn === spawn && !existsSync(this.adapterPath)) throw new SchedulingSessionError('找不到 Codex ACP 适配器，请先运行 npm ci', { status: 500 });

    const child = this.spawnFn(process.execPath, [this.adapterPath], {
      cwd: this.cwd,
      env: { ...process.env, NO_BROWSER: process.env.NO_BROWSER || '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    if (!child?.stdin || !child?.stdout || !child?.stderr) throw new SchedulingSessionError('无法启动 Codex ACP 适配器', { status: 500 });

    const record = {
      id: randomUUID(),
      sessionId: null,
      agent: 'Codex ACP',
      cwd: this.cwd,
      status: 'initializing',
      prompt: text,
      stopReason: null,
      error: null,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      child,
      connection: null,
      promptTurn: null,
    };
    this.sessions.set(record.id, record);

    const touch = note => { record.updatedAt = this.now().toISOString(); return note; };
    const acpClient = client({ name: 'autoloop-console' })
      .onRequest(methods.client.session.requestPermission, async () => {
        touch('permission');
        return { outcome: { outcome: 'cancelled' } };
      })
      .onNotification(methods.client.session.update, notification => {
        touch(summarizeUpdate(notification.update));
      });

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const connection = acpClient.connect(stream);
    record.connection = connection;
    connection.closed.then(() => {
      if (!this.sessions.has(record.id)) return;
      if (record.status !== 'closing' && record.status !== 'closed') {
        record.status = child.exitCode === 0 ? 'closed' : 'error';
        if (record.status === 'error' && !record.error) record.error = 'Codex ACP 进程已退出';
        record.updatedAt = this.now().toISOString();
      }
    }).catch(() => {});

    try {
      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'multiagent-autoloop-console', title: 'Multiagent Autoloop 控制台', version: '0.1.0' },
      });
      record.agent = initialized.agentInfo?.title || initialized.agentInfo?.name || record.agent;

      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: this.cwd,
        mcpServers: [],
      });
      if (!session?.sessionId) throw new SchedulingSessionError('Codex ACP 没有返回会话 ID', { status: 502 });
      record.sessionId = session.sessionId;
      record.status = 'idle';

      record.promptTurn = connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text }],
      });
      record.status = 'running';
      record.updatedAt = this.now().toISOString();
      record.promptTurn.then(response => {
        record.status = 'idle';
        record.stopReason = response.stopReason;
        record.updatedAt = this.now().toISOString();
      }).catch(error => {
        record.status = 'error';
        record.error = safeMessage(error);
        record.updatedAt = this.now().toISOString();
      });
      return toPublicSession(record);
    } catch (error) {
      record.status = 'error';
      record.error = safeMessage(error);
      this.#destroyRecord(record);
      throw new SchedulingSessionError(`开启调度会话失败：${record.error}`, { status: 502 });
    }
  }

  async close(id) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    record.status = 'closing';
    record.updatedAt = this.now().toISOString();
    if (record.sessionId) {
      try { await record.connection.agent.request(methods.agent.session.cancel, { sessionId: record.sessionId }); } catch {}
      try { await record.connection.agent.request(methods.agent.session.close, { sessionId: record.sessionId }); } catch {}
    }
    this.#destroyRecord(record);
    return toPublicSession({ ...record, status: 'closed', updatedAt: this.now().toISOString() });
  }

  dispose() {
    for (const record of this.sessions.values()) this.#destroyRecord(record);
  }

  #destroyRecord(record) {
    this.sessions.delete(record.id);
    try { record.connection?.close(); } catch {}
    try { record.child?.kill('SIGTERM'); } catch {}
  }
}
