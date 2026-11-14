import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, '..');
export const DEFAULT_ADAPTER_PATH = path.join(REPOSITORY_ROOT, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');


export const DEFAULT_SCHEDULING_PROMPT = `你是 Multiagent Autoloop 控制台仓库中的调度会话，工作目录固定为 ${REPOSITORY_ROOT}（只读了解调度契约用）。`;

export function buildSchedulingPrompt({ project, projectContext } = {}) {
  return [
    `你负责调度的项目：${project}。`,
    `【项目资料】\n${projectContext || '未找到该项目资料，先阅读本仓库文档建立上下文。'}`,
    `【任务】按顺序：`,
    `1）你现在的会话工作目录就是被调度项目的仓库（${project}）：阅读本仓库的 AGENTS.md、README.md 与 docs/ 建立项目上下文（边界、命令、约定）。`,
    `2）调度控制台契约文档在 ${REPOSITORY_ROOT}/README.md 与 ${REPOSITORY_ROOT}/docs/（绝对路径只读，重点是 docs/scheduling-contract.md 的事件链契约）。`,
    `3）通过控制台 API（http://127.0.0.1:50761，仅本机）检查该项目相关的调度状态（规则、轮次、卡片），整理：正在运行/等待重试/待调度处理的事项、建议的处理顺序、真正需要用户决策的问题。`,
    `4）目标项目的代码改动仍在该项目自己的隔离 worktree 中由派发 worker 执行；本会话只读诊断与协调，不直接改项目文件。需要授权或不可逆操作时只列出等待用户决策。`,
  ].join('\n');
}

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

  async start({ prompt, project, projectContext } = {}) {
    const projectId = this.#validateProject(project);
    const composed = prompt ? `${buildSchedulingPrompt({ project: projectId, projectContext })}\n\n【本次附加说明】\n${prompt}` : buildSchedulingPrompt({ project: projectId, projectContext });
    const text = this.#validatePrompt(composed, 64000);
    const duplicate = [...this.sessions.values()].find(session => session.project === projectId);
    if (duplicate) throw new SchedulingSessionError(`项目 ${projectId} 已有进行中的调度会话（${duplicate.id.slice(0, 8)}），请先关闭再开启`);
    if (this.sessions.size >= this.maxSessions) throw new SchedulingSessionError(`最多同时开启 ${this.maxSessions} 个调度会话`);
    if (this.spawnFn === spawn && !existsSync(this.adapterPath)) throw new SchedulingSessionError('找不到 Codex ACP 适配器，请先运行 npm ci', { status: 500 });

    const sessionCwd = this.#projectCwd(projectId);
    const child = this.spawnFn(process.execPath, [this.adapterPath], {
      cwd: sessionCwd,
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
      cwd: sessionCwd,
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
        cwd: sessionCwd,
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

  #projectCwd(project) {
    try {
      if (existsSync(project) && statSync(project).isDirectory() && existsSync(path.join(project, '.git'))) return path.resolve(project);
    } catch { /* 回退控制台工作目录 */ }
    return this.cwd;
  }

  #validateProject(project) {
    const text = String(project ?? '').trim();
    if (!text) throw new SchedulingSessionError('请选择被调度的项目');
    if (/[\x00-\x1f\x7f]/.test(text)) throw new SchedulingSessionError('项目标识不能包含控制字符');
    return text;
  }

  #validatePrompt(prompt, max = 4000) {
    const text = String(prompt ?? '').trim();
    if (!text) throw new SchedulingSessionError('请填写发送内容');
    if (text.length > max) throw new SchedulingSessionError(`发送内容不能超过 ${max} 字`);
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
