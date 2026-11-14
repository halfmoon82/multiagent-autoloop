import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, '..');
export const DEFAULT_ADAPTER_PATH = path.join(REPOSITORY_ROOT, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');
export const HUB_TOOLS_PATH = path.join(REPOSITORY_ROOT, 'src', 'mcp', 'hub-tools.mjs');

// 调度会话挂载的只读 MCP server：stdio JSON-RPC，数据来自 Autoloop Hub。
// env 最小透传（ACP stdio MCP 无 cwd 字段，脚本用绝对路径，工作目录无影响）。
// 注意：owner key 只经 AGENT_AUTOLOOP_HOME/config.json 在 MCP 子进程内读取，绝不进入这里的参数。
export function buildHubMcpServer() {
  return {
    name: 'autoloop-hub',
    command: process.execPath,
    args: [HUB_TOOLS_PATH],
    env: [{ name: 'AGENT_AUTOLOOP_HOME', value: process.env.AGENT_AUTOLOOP_HOME || '' }],
  };
}


export const DEFAULT_SCHEDULING_PROMPT = `你是 Multiagent Autoloop 控制台仓库中的调度会话，工作目录固定为 ${REPOSITORY_ROOT}（只读了解调度契约用）。`;

export function buildSchedulingPrompt({ project, projectContext, consoleContext, writableDir } = {}) {
  return [
    `你负责调度的项目：${project}。`,
    writableDir ? `【可写范围】事件链扫描等调度脚本请用文件编辑写入 ${writableDir}（仅该目录内编辑自动批准；shell 执行、目录外写入、网络请求一律拒绝）。` : '【可写范围】本会话只读，无写权限。',
    `【项目资料】\n${projectContext || '未找到该项目资料，先阅读本仓库文档建立上下文。'}`,
    `【调度契约】\n${consoleContext || '未找到调度控制台资料。'}`,
    `【任务】按顺序：`,
    `1）你现在的会话工作目录就是被调度项目的仓库（${project}）：阅读本仓库的 AGENTS.md、README.md 与 docs/ 建立项目上下文（边界、命令、约定）。`,
    `2）以上【调度契约】是调度方必须遵守的规则与方法（事件链不变量、模型派发、重试与升级纪律、控制台信息契约）；沙箱若拦截外部文件读取，以【调度契约】正文为准。`,
    `3）调用 autoloop-hub MCP 工具（list_rules/list_runs/list_cards）查询该项目相关调度状态（规则、轮次、卡片），整理：正在运行/等待重试/待调度处理的事项、建议的处理顺序、真正需要用户决策的问题。自愈闭环：诊断出可自愈的问题并修复、做最小验证后，用 resume_rule/run_rule 恢复或重触发对应规则；按调度契约重试纪律，同一原因最多重试 3 次，满 3 次必须换打法（改派 Agent、换模型、拆小任务或改无模型脚本），替代方式穷尽仍失败才升级给用户。若工具不可用，可用控制台 API（http://127.0.0.1:50761，仅本机）兜底读取同一状态（沙箱可能拦截命令行 HTTP 请求，优先走 MCP 工具）。`,
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
    writableDir: record.writableDir,
    prompt: record.prompt,
    stopReason: record.stopReason,
    error: record.error,
    messages: record.messages.map(message => ({ ...message })),
    liveText: record.liveText,
    busy: record.status === 'running',
    queuedCount: (record.queue || []).filter(item => item !== null).length,
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
  constructor({ cwd = REPOSITORY_ROOT, adapterPath = DEFAULT_ADAPTER_PATH, spawnFn = spawn, maxSessions = 3, writableDir = null, now = () => new Date() } = {}) {
    this.cwd = path.resolve(cwd);
    this.writableDir = writableDir ? path.resolve(writableDir) : null;
    this.adapterPath = adapterPath;
    this.spawnFn = spawnFn;
    this.maxSessions = maxSessions;
    this.now = now;
    this.sessions = new Map();
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(toPublicSession);
  }

  async start({ prompt, project, projectContext, consoleContext } = {}) {
    const projectId = this.#validateProject(project);
    const base = buildSchedulingPrompt({ project: projectId, projectContext, consoleContext, writableDir: this.writableDir });
    const composed = prompt ? `${base}\n\n【本次附加说明】\n${prompt}` : base;
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
      writableDir: this.writableDir,
      prompt: text,
      queue: [],
      interruptRequested: false,
      stopReason: null,
      error: null,
      messages: [],
      liveText: '',
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      child,
      connection: null,
      promptTurn: null,
      closed: false,
    };
    this.sessions.set(record.id, record);

    const touch = note => { record.updatedAt = this.now().toISOString(); return note; };
    const acpClient = client({ name: 'autoloop-console' })
      .onRequest(methods.client.session.requestPermission, async request => {
        touch('permission');
        return { outcome: this.#decidePermission(request?.params) };
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
      record.closed = true;
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
        mcpServers: [buildHubMcpServer()],
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

  async send(id, text, { interrupt = false } = {}) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    if (['closing', 'closed'].includes(record.status)) throw new SchedulingSessionError('会话已关闭，请开启新会话', { status: 409 });
    if (record.status === 'error') throw new SchedulingSessionError('会话处于异常状态，请关闭后重新开启', { status: 409 });
    const raw = String(text ?? '').trim();
    if (record.status === 'idle') {
      const message = this.#validatePrompt(raw);
      this.#pushMessage(record, 'user', message);
      this.#runTurn(record, message);
      return toPublicSession(record);
    }
    // 运行中/初始化中：与 Codex 输入体验一致——默认排队跟进，interrupt 取消当前轮。
    if (interrupt) {
      if (record.status === 'initializing') throw new SchedulingSessionError('会话初始化中，请稍候再试（打断只在运行中可用）', { status: 409 });
      record.queue.unshift(raw || null); // null = 仅停止本轮，不发新消息
      record.interruptRequested = true;
      record.updatedAt = this.now().toISOString();
      try { await record.connection?.agent?.request(methods.agent.session.cancel, { sessionId: record.sessionId }); } catch { /* 连接断开时由 promptTurn 收尾 */ }
      return toPublicSession(record);
    }
    const message = this.#validatePrompt(raw);
    const pendingMessages = record.queue.filter(item => item !== null).length;
    if (pendingMessages >= 10) throw new SchedulingSessionError('排队消息过多（最多 10 条），请等本轮结束', { status: 429 });
    record.queue.push(message);
    record.updatedAt = this.now().toISOString();
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

  #insideWritableDir(target) {
    if (!target) return false;
    let root;
    try { root = realpathSync(this.writableDir); } catch { return false; }
    try {
      if (lstatSync(target).isSymbolicLink()) return false;
      const resolved = realpathSync(target);
      return resolved === root || resolved.startsWith(root + path.sep);
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
      try {
        const resolved = path.join(realpathSync(path.dirname(target)), path.basename(target));
        return resolved === root || resolved.startsWith(root + path.sep);
      } catch { return false; }
    }
  }

  #decidePermission(params) {
    const toolCall = params?.toolCall || {};
    if (!this.writableDir || toolCall.kind !== 'edit') return { outcome: 'cancelled' };
    const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
    if (!locations.length) return { outcome: 'cancelled' };
    const inside = locations.every(location => this.#insideWritableDir(String(location?.path || '')));
    if (!inside) return { outcome: 'cancelled' };
    const allow = (params.options || []).find(option => option?.kind === 'allow_once');
    return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
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
    if (text.length > max) throw new SchedulingSessionError(`发送内容不能超过 ${max} 字（当前 ${text.length} 字）`);
    return text;
  }

  #pushMessage(record, role, text) {
    record.messages.push({ role, text, at: this.now().toISOString() });
    record.updatedAt = this.now().toISOString();
  }

  #runTurn(record, text) {
    record.liveText = '';
    record.status = 'running';
    record.updatedAt = this.now().toISOString();
    record.promptTurn = record.connection.agent.request(methods.agent.session.prompt, {
      sessionId: record.sessionId,
      prompt: [{ type: 'text', text }],
    });
    const finish = (reply, stopReason, error) => {
      const interrupted = record.interruptRequested;
      record.liveText = '';
      record.interruptRequested = false;
      if (error && !(interrupted && !record.closed)) {
        record.status = 'error';
        record.error = safeMessage(error);
      } else {
        record.status = 'idle';
        record.stopReason = error ? 'interrupted' : stopReason;
        if (reply && !interrupted) this.#pushMessage(record, 'agent', reply);
      }
      record.updatedAt = this.now().toISOString();
      this.#drainQueue(record);
    };
    record.promptTurn.then(response => {
      const interrupted = response?.stopReason && response.stopReason !== 'end_turn';
      finish(interrupted ? '' : record.liveText.trim(), response?.stopReason, null);
    }).catch(error => finish('', null, error));
  }

  #drainQueue(record) {
    while (record.status === 'idle' && record.queue.length) {
      const next = record.queue.shift();
      if (next === null) continue; // 纯打断标记：消费后继续排后续消息
      this.#pushMessage(record, 'user', next);
      this.#runTurn(record, next);
      break;
    }
  }

  #destroyRecord(record) {
    this.sessions.delete(record.id);
    try { record.connection?.close(); } catch {}
    try { record.child?.kill('SIGTERM'); } catch {}
  }
}
