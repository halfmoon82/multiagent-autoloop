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
const DEFAULT_PROJECT_LINE = project => `你负责的项目标识是 ${project}；事件 subject 遵循 <owner>-<repo> 约定，目标代码在该项目自己的隔离工作区执行。`;

export const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

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
    project: record.project,
    prompt: record.prompt,
    stopReason: record.stopReason,
    error: record.error,
    messages: record.messages.map(message => ({ ...message })),
    liveText: record.liveText,
    busy: record.status === 'running',
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

  async start({ prompt = DEFAULT_SCHEDULING_PROMPT, project } = {}) {
    const projectId = this.#validateProject(project);
    const text = this.#validatePrompt(`${DEFAULT_PROJECT_LINE(projectId)}\n${String(prompt ?? '')}`);
    if (this.sessions.size >= this.maxSessions) throw new SchedulingSessionError(`最多同时开启 ${this.maxSessions} 个调度会话`);
    if (this.spawnFn === spawn && !existsSync(this.adapterPath)) throw new SchedulingSessionError('找不到 Codex ACP 适配器，请先运行 npm ci', { status: 500 });

    const child = this.spawnFn(process.execPath, [this.adapterPath], {
      cwd: this.cwd,
      env: { ...process.env, NO_BROWSER: process.env.NO_BROWSER || '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    if (!child?.stdin || !child?.stdout || !child?.stderr) throw new SchedulingSessionError('无法启动 Codex ACP 适配器', { status: 500 });
    let stderrTail = '';
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-4096); });

    const record = {
      id: randomUUID(),
      sessionId: null,
      agent: 'Codex ACP',
      cwd: this.cwd,
      status: 'initializing',
      project: projectId,
      prompt: text,
      stopReason: null,
      error: null,
      messages: [],
      liveText: '',
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
        const update = notification?.params?.update || {};
        touch(summarizeUpdate(update));
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          record.liveText += update.content.text;
        }
      });

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const connection = acpClient.connect(stream);
    record.connection = connection;
    connection.closed.then(() => {
      if (!this.sessions.has(record.id)) return;
      if (record.status !== 'closing' && record.status !== 'closed') {
        record.status = child.exitCode === 0 ? 'closed' : 'error';
        if (record.status === 'error' && !record.error) {
        record.error = 'Codex ACP 进程已退出';
        const tail = stderrTail.trim();
        if (tail) console.error(`[scheduling-session] adapter stderr:\n${tail}`);
      }
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

      this.#pushMessage(record, 'user', text);
      this.#runTurn(record, text);
      return toPublicSession(record);
    } catch (error) {
      record.status = 'error';
      record.error = safeMessage(error);
      this.#destroyRecord(record);
      throw new SchedulingSessionError(`开启调度会话失败：${record.error}`, { status: 502 });
    }
  }

  async send(id, text) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    if (['closing', 'closed'].includes(record.status)) throw new SchedulingSessionError('会话已关闭，请开启新会话', { status: 409 });
    if (record.status === 'error') throw new SchedulingSessionError('会话处于异常状态，请关闭后重新开启', { status: 409 });
    if (record.status !== 'idle') throw new SchedulingSessionError('Agent 正在回复，请等这轮结束再发送', { status: 409 });
    const message = this.#validatePrompt(text);
    this.#pushMessage(record, 'user', message);
    this.#runTurn(record, message);
    return toPublicSession(record);
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

  #validateProject(project) {
    const text = String(project ?? '').trim();
    if (!text) throw new SchedulingSessionError('请填写项目标识（如 owner/repo）');
    if (!PROJECT_PATTERN.test(text)) throw new SchedulingSessionError('项目标识只能包含字母、数字和 . _ / -，不能含空格');
    return text;
  }

  #validatePrompt(prompt) {
    const text = String(prompt ?? '').trim();
    if (!text) throw new SchedulingSessionError('请填写发送内容');
    if (text.length > 4000) throw new SchedulingSessionError('发送内容不能超过 4000 字');
    return text;
  }

  #pushMessage(record, role, text) {
    record.messages.push({ role, text, at: this.now().toISOString() });
    record.updatedAt = this.now().toISOString();
  }

  #runTurn(record, text) {
    record.liveText = '';
    record.promptTurn = record.connection.agent.request(methods.agent.session.prompt, {
      sessionId: record.sessionId,
      prompt: [{ type: 'text', text }],
    });
    record.status = 'running';
    record.updatedAt = this.now().toISOString();
    record.promptTurn.then(response => {
      const reply = record.liveText.trim();
      record.liveText = '';
      if (reply) this.#pushMessage(record, 'agent', reply);
      record.status = 'idle';
      record.stopReason = response.stopReason;
      record.updatedAt = this.now().toISOString();
    }).catch(error => {
      record.liveText = '';
      record.status = 'error';
      record.error = safeMessage(error);
      record.updatedAt = this.now().toISOString();
    });
  }

  #destroyRecord(record) {
    this.sessions.delete(record.id);
    try { record.connection?.close(); } catch {}
    try { record.child?.kill('SIGTERM'); } catch {}
  }
}
