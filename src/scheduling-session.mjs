import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { SessionArchive } from './session-archive.mjs';
import { listArtifacts, readArtifact } from './artifacts.mjs';

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


export function buildSchedulingPrompt({ project, writableDir } = {}) {
  return [
    `你是 Multiagent Autoloop 的调度会话，负责项目 ${project} 的调度诊断与协调。你的会话工作目录就是该项目仓库。`,
    writableDir ? `【可写范围】事件链扫描等调度脚本请用文件编辑写入 ${writableDir}（仅该目录内编辑自动批准；shell 执行、目录外写入、网络请求一律拒绝）。` : '【可写范围】本会话只读，无写权限。',
    `【行为护栏——开局即生效，任何情况下不得违反】`,
    `1. 重试纪律：同一任务的执行尝试（含首次执行与换打法后的再执行）累计满 3 次仍失败，必须换打法（改派 Agent、换模型、拆小任务或改无模型脚本），禁止同一原因无限重试；每次再执行前先定位失败原因并写明失败原因与已尝试路径。`,
    `   所有替代方式穷尽仍失败的任务，挂起并在会话中升级给用户（这是工程问题唯一允许升级的出口）。`,
    `2. 升级最小门禁：只有两类问题才向用户提问——(a) 只有用户掌握的环境、key、凭据、授权；(b) 产品功能、个人隐私、财务、对他人会造成误会影响的产品决策。纯工程问题（实现选型与方案对比、worktree 绑定与新开、模型无额度需更换、环境变量补齐、脚本与状态修复、依赖与本地配置）由调度体系自行消化：你决定方案并组织派发（见第 6 条）且由你担责，不得升级给用户，禁止把工程方案包装成选项卡片，禁止对同一工程问题反复生成卡片催人。`,
    `3. 向用户列待决问题时必须遵守卡片陈述规则：产品语言背景、每个选项注明收益和代价。`,
    `4. 派发 worker 必须在项目仓库内先开独立 worktree 与分支（git worktree add .worktrees/<任务名> -b feat/<topic>，任务名 kebab-case ASCII），禁止在共享 checkout 直接开发。`,
    `5. 事件 subject 使用无空格的稳定 ASCII 标识；自然语言说明放 summary/detail。`,
    `6. 实现边界：琐碎自愈（本地调度脚本、配置、状态、规则的小修，见任务 2）由本会话直接做，不必派发；项目代码的实现一律通过独立 worker 会话执行（每个 worker 独立 worktree/分支/交付边界，模型选择见 docs/scheduling-contract.md 的模型派发规则）。禁止本会话亲自写项目代码，也禁止在本会话内派生子智能体/子会话代劳——那等同于本会话直接实施，同样违反本护栏。判别标准：worker 指按第 4 条开独立 worktree、有独立交付边界的正式派发；除此之外的一切子会话均属代劳。收到实现类需求时的标准动作：拆解任务 → 选择模型 → 按第 4 条开 worktree → 派发 worker → 审阅交付并合并结果。`,
    `【工具】autoloop-hub MCP 工具：list_rules（规则与暂停状态）、list_runs（最近轮次与失败原因）、list_cards（待处理卡片）、resume_rule / pause_rule / run_rule（受控写：自愈恢复与重触发；run_rule 同规则 10 分钟冷却）；read_console_doc（按白名单路径读取控制台文档全文）。`,
    `【控制台文档索引】需要调度契约/架构细节时用 read_console_doc 按需读取（提示词不内联全文，以工具读到的磁盘内容为准）：`,
    `- AGENTS.md —— 控制台仓库总规则`,
    `- README.md —— 控制台概述`,
    `- docs/scheduling-contract.md —— 调度契约全文（调度方职责、模型派发规则、事件链不变量、自愈与升级纪律）；派发 worker、选择模型或调整调度行为前必读`,
    `- docs/architecture.md —— 控制台架构与模块边界`,
    `【任务】按顺序：`,
    `1）你的工作目录就是该项目仓库（${project}）：阅读本仓库的 AGENTS.md、README.md 与 docs/ 建立项目上下文（边界、命令、约定）。项目文档以你读到的磁盘文件为准。`,
    `2）用 list_rules / list_runs / list_cards 查询该项目相关调度状态，整理：正在运行/等待重试/待调度处理的事项、建议的处理顺序、真正需要用户决策的问题。自愈闭环：诊断出可自愈的问题并修复（限本地调度脚本/配置/状态/规则，不动项目代码）、做最小验证后，用 resume_rule / run_rule 恢复或重触发对应规则，遵守上方重试纪律。若 MCP 工具不可用，可用控制台 API（http://127.0.0.1:50761，仅本机）兜底读取同一状态（沙箱可能拦截命令行 HTTP 请求，优先走 MCP 工具）。`,
    `3）目标项目的代码改动由派发 worker 在隔离 worktree 中执行；本会话只读诊断与协调，不直接改项目文件（实现边界见上方第 6 条）。需要授权或不可逆操作时只列出等待用户决策，且遵守上方卡片陈述规则。`,
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
    continuedFrom: record.continuedFrom || null,
    prompt: record.prompt,
    stopReason: record.stopReason,
    error: record.error,
    messages: record.messages.map(message => ({ ...message })),
    liveText: record.liveText,
    busy: record.status === 'running',
    queuePaused: !!record.queuePaused,
    queuedCount: (record.queue || []).length,
    queued: (record.queue || []).map(item => ({ id: item.id, text: item.text, at: item.at })),
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
  constructor({ cwd = REPOSITORY_ROOT, adapterPath = DEFAULT_ADAPTER_PATH, spawnFn = spawn, maxSessions = 3, writableDir = null, archiveRoot = null, now = () => new Date() } = {}) {
    this.cwd = path.resolve(cwd);
    this.writableDir = writableDir ? path.resolve(writableDir) : null;
    this.adapterPath = adapterPath;
    this.spawnFn = spawnFn;
    this.maxSessions = maxSessions;
    this.now = now;
    this.sessions = new Map();
    // 会话存档：写穿到运行目录，重启后留档可继续；不可用时降级为纯内存。
    this.archive = archiveRoot ? new SessionArchive(archiveRoot) : null;
    this.archiveWarned = false;
    this.bootMarked = false;
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(toPublicSession);
  }

  async #ensureBootMarked() {
    if (this.bootMarked || !this.archive) return;
    this.bootMarked = true;
    try { await this.archive.loadAllDetailed({ markActive: true }); }
    catch { this.bootMarked = false; }
  }

  // 已存档列表排除仍在内存活跃的会话：它们的真相在上面的活跃组，避免同一会话两处展示。
  async listArchived() {
    if (!this.archive) return [];
    await this.#ensureBootMarked();
    try {
      const { sessions } = await this.archive.loadAllDetailed();
      return sessions.filter(item => !this.sessions.has(item.id));
    } catch { return []; }
  }

  // 用存档转录新建会话续跑（ACP 无法跨进程重连，只能新建）。
  async continueSession(id) {
    if (!this.archive) throw new SchedulingSessionError('会话存档不可用（未配置运行目录）', { status: 503 });
    let record;
    try { record = await this.archive.read(id); }
    catch (error) { throw new SchedulingSessionError(`无法继续该会话：${error.message}`, { status: error.status || 400 }); }
    const prompt = await this.archive.buildContinuation(id);
    return this.start({ prompt, project: record.project, continuedFrom: record.id });
  }

  async start({ prompt, project, continuedFrom = null } = {}) {
    const projectId = this.#validateProject(project);
    const base = buildSchedulingPrompt({ project: projectId, writableDir: this.writableDir });
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
      continuedFrom,
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
        this.#persist(record);
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
      // 与 Codex 原生 Stop 一致：只停止本轮并让队列保持暂停；不读取文本（调用方草稿留在客户端），不动队列。
      // 注意：text 在此分支被有意忽略——控制台前端传空串；带文本调用属于旧 API 约定，不再送达
      record.queuePaused = true;
      record.interruptRequested = true; // cancel 引发的 prompt 拒绝按中断收尾，不算错误
      record.updatedAt = this.now().toISOString();
      try { await record.connection?.agent?.request(methods.agent.session.cancel, { sessionId: record.sessionId }); } catch { /* 连接断开时由 promptTurn 收尾 */ }
      return toPublicSession(record);
    }
    const message = this.#validatePrompt(raw);
    const pendingMessages = record.queue.length;
    if (pendingMessages >= 10) throw new SchedulingSessionError('排队消息过多（最多 10 条），请等本轮结束', { status: 429 });
    record.queue.push({ id: randomUUID(), text: message, at: this.now().toISOString() });
    record.updatedAt = this.now().toISOString();
    return toPublicSession(record);
  }

  async updateQueued(id, itemId, text) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    if (['closing', 'closed'].includes(record.status)) throw new SchedulingSessionError('会话已关闭，请开启新会话', { status: 409 });
    const item = record.queue.find(entry => entry.id === String(itemId || ''));
    if (!item) throw new SchedulingSessionError('队列消息不存在或已送达', { status: 404 });
    item.text = this.#validatePrompt(String(text ?? '').trim());
    item.at = this.now().toISOString();
    record.updatedAt = this.now().toISOString();
    return toPublicSession(record);
  }

  async moveQueued(id, itemId, direction) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    if (['closing', 'closed'].includes(record.status)) throw new SchedulingSessionError('会话已关闭，请开启新会话', { status: 409 });
    const index = record.queue.findIndex(entry => entry.id === String(itemId || ''));
    if (index === -1) throw new SchedulingSessionError('队列消息不存在或已送达', { status: 404 });
    const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : null;
    if (delta === null) throw new SchedulingSessionError('方向无效（只支持 up/down）', { status: 400 });
    const target = index + delta;
    if (target >= 0 && target < record.queue.length) [record.queue[index], record.queue[target]] = [record.queue[target], record.queue[index]];
    record.updatedAt = this.now().toISOString();
    return toPublicSession(record);
  }

  async resumeQueue(id) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    if (['closing', 'closed'].includes(record.status)) throw new SchedulingSessionError('会话已关闭，请开启新会话', { status: 409 });
    record.queuePaused = false;
    record.updatedAt = this.now().toISOString();
    this.#drainQueue(record);
    return toPublicSession(record);
  }

  async clearQueued(id) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    if (['closing', 'closed'].includes(record.status)) throw new SchedulingSessionError('会话已关闭，请开启新会话', { status: 409 });
    record.queue = [];
    record.queuePaused = false;
    record.updatedAt = this.now().toISOString();
    return toPublicSession(record);
  }

  async removeQueued(id, itemId) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    if (['closing', 'closed'].includes(record.status)) throw new SchedulingSessionError('会话已关闭，请开启新会话', { status: 409 });
    const index = record.queue.findIndex(item => item !== null && item.id === String(itemId || ''));
    if (index === -1) throw new SchedulingSessionError('队列消息不存在或已送达', { status: 404 });
    record.queue.splice(index, 1);
    record.updatedAt = this.now().toISOString();
    return toPublicSession(record);
  }

  async steerQueued(id, itemId) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    if (['closing', 'closed'].includes(record.status)) throw new SchedulingSessionError('会话已关闭，请开启新会话', { status: 409 });
    // 与 send(interrupt) 同一套状态前置校验：必须先拦下，避免消息已从队列摘除但发送被拒而丢失
    if (record.status === 'initializing') throw new SchedulingSessionError('会话初始化中，请稍候再试', { status: 409 });
    if (record.status === 'error') throw new SchedulingSessionError('会话处于异常状态，请关闭后重新开启', { status: 409 });
    const index = record.queue.findIndex(item => item.id === String(itemId || ''));
    if (index === -1) throw new SchedulingSessionError('队列消息不存在或已送达', { status: 404 });
    const [item] = record.queue.splice(index, 1);
    record.queuePaused = false; // sendNow 语义：被 steer 的消息立即送达，队列恢复跟进
    record.queue.unshift({ id: randomUUID(), text: item.text, at: this.now().toISOString() });
    record.interruptRequested = true; // cancel 引发的 prompt 拒绝按中断收尾，不算错误（与 send(interrupt) 同护）
    record.updatedAt = this.now().toISOString();
    try { await record.connection?.agent?.request(methods.agent.session.cancel, { sessionId: record.sessionId }); } catch { /* 连接断开时由 promptTurn 收尾 */ }
    this.#drainQueue(record);
    return toPublicSession(record);
  }

  async listSessionArtifacts(id) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    return listArtifacts(record.cwd);
  }

  async readSessionArtifact(id, relPath) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    try {
      return readArtifact(record.cwd, relPath);
    } catch (error) {
      throw new SchedulingSessionError(error.message, { status: /越界|不支持|过大/.test(error.message) ? 400 : 404 });
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
    record.updatedAt = this.now().toISOString();
    this.#persist(record);
    this.#destroyRecord(record);
    return toPublicSession({ ...record, status: 'closed', updatedAt: record.updatedAt });
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
    this.#persist(record);
  }

  #persist(record) {
    if (!this.archive) return;
    this.archive.save({
      id: record.id,
      project: record.project,
      agent: record.agent,
      prompt: record.prompt,
      continuedFrom: record.continuedFrom,
      messages: record.messages,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      closedAt: ['closing', 'closed'].includes(record.status) ? record.updatedAt : null,
      endStatus: ['closing', 'closed'].includes(record.status) ? 'closed' : record.status === 'error' ? 'error' : 'active',
    }).catch(() => {
      if (!this.archiveWarned) { this.archiveWarned = true; console.error('[scheduling-session] 会话存档写入失败，已降级为内存会话'); }
    });
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
      this.#persist(record);
      this.#drainQueue(record);
    };
    record.promptTurn.then(response => {
      const interrupted = response?.stopReason && response.stopReason !== 'end_turn';
      finish(interrupted ? '' : record.liveText.trim(), response?.stopReason, null);
    }).catch(error => finish('', null, error));
  }

  #drainQueue(record) {
    // 队列项恒为对象（null 纯打断标记随"打断=纯停止"语义已退役，不再入队）
    while (record.status === 'idle' && record.queue.length && !record.queuePaused) {
      const next = record.queue.shift();
      this.#pushMessage(record, 'user', next.text);
      this.#runTurn(record, next.text);
      break;
    }
  }

  #destroyRecord(record) {
    this.sessions.delete(record.id);
    try { record.connection?.close(); } catch {}
    try { record.child?.kill('SIGTERM'); } catch {}
  }
}
