import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { appendFileSync } from 'node:fs';
import { decideByKind, mergeCall } from './session-permission.mjs';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { SessionArchive } from './session-archive.mjs';
import { listArtifacts, readArtifact } from './artifacts.mjs';
import { buildOpenItemsTasks } from './scheduling-prompt-open-items.mjs';
import { prepareSessionCodexHome, defaultUserCodexHome } from './session-codex-home.mjs';
import { HubSchedulingSessionAdapter, HubSchedulingError, HUB_SCHEDULING_AGENT_LABEL, HUB_RECONCILE_INTERVAL_MS, schedulingSubject, schedulingEventId, mapHubStateToStatus, numericEventId, readHubRun } from './hub-scheduling-session.mjs';
import { buildSchedulingContext, contextTrailer, composeTurnText, prevAgentFrom, hasOpenCardsFor, snapshotLinesFrom, isBareContinuation, exchangesFrom, HANDOVER_ROUNDS } from './scheduling-context.mjs';
import { readFinalMessage } from './run-output.mjs';
import { ROOT_NODE } from './dag-run.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, '..');
export const DEFAULT_ADAPTER_PATH = path.join(REPOSITORY_ROOT, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');
export const HUB_TOOLS_PATH = path.join(REPOSITORY_ROOT, 'src', 'mcp', 'hub-tools.mjs');

// 调度会话挂载的只读 MCP server：stdio JSON-RPC，数据来自 Autoloop Hub。
// env 最小透传（ACP stdio MCP 无 cwd 字段，脚本用绝对路径，工作目录无影响）。
// 注意：owner key 只经 AGENT_AUTOLOOP_HOME/config.json 在 MCP 子进程内读取，绝不进入这里的参数。
export const SESSION_KIND_LABELS = { normal: '普通会话', scheduling: '调度会话', design: '设计会话' };
const SESSION_KINDS = Object.keys(SESSION_KIND_LABELS);

// 设计会话专用引导提示词：收敛 PRD/Spec/DAG，不复用调度会话的派发 worker 文案。
export function buildDesignPrompt({ project } = {}) {
  return [
    `你是 ${project} 上的设计会话，负责把产品需求收敛为可评审的 PRD、Spec 与可并行执行的 DAG。`,
    '【协作方式】原生 Codex Plan Mode + 只读沙箱：只读取代码与文档、提问和出方案，不得直接修改文件或执行写命令；需求确认前不进入实现。',
    '【产出约定】需求闭合后以约定 JSON 块输出 product-spec（背景、成功标准、非目标、验收命令），控制台据此计算 specDigest；主人确认后再拆解 DAG 与执行范围。',
    '【边界】本会话只做规划与设计：不执行实现、不触碰部署、不修改真实调度规则；实现由后续事件链按授权快照派发。',
  ].join('\n');
}

// 普通会话分支纪律：作为首轮的独立提示块送达，用户输入保持逐字；机械约束在权限层（session-permission.mjs）。
export const BRANCH_DISCIPLINE_PROMPT = [
  '【分支纪律】',
  '- 不直推 main/master 等受保护分支；任何改动先建分支：热修复走 fix/<topic> 分支，或在独立 worktree（git worktree add .worktrees/<名> -b fix/<topic>）里做。',
  '- 单个 issue 的闭环：读 issue → 建分支 → 改代码 → 跑测试 → 提交 → git push -u origin <分支> → gh pr create 开 PR → 等 reviewer 闭环 → 仅在用户明确授权后合并。',
  '- 禁止 force push、禁止删除远端分支；文件编辑与命令工作目录限本项目工作区。以上由控制台权限层强制，违反的请求会被拒绝并记入审计。',
].join('\n');

export function buildHubMcpServer() {
  return {
    name: 'autoloop-hub',
    command: process.execPath,
    args: [HUB_TOOLS_PATH],
    env: [{ name: 'AGENT_AUTOLOOP_HOME', value: process.env.AGENT_AUTOLOOP_HOME || '' }],
  };
}


// 调度会话指引用户在控制台操作时用的入口文字：只写界面上真实存在、任何状态下都能到达的路径。
// CONSOLE_DAG_ENTRY_LABELS 由契约测试逐个对照 public/ 里的真实按钮文字，界面改名时测试会红。
export const CONSOLE_DAG_ENTRY_LABELS = Object.freeze(['总览', '项目任务进度', '新建 DAG（执行授权）', '读取计划与预检', '确认并进入事件链']);
export const CONSOLE_DAG_ENTRY_TEXT = '需要用户在控制台创建 DAG（执行授权）时，只按这条路径指引：「总览」→「项目任务进度」面板右上角「新建 DAG（执行授权）」→ 选项目、填计划编号 →「读取计划与预检」→ 勾选确认框 →「确认并进入事件链」。不要编造其他界面路径；不确定某个按钮在哪时如实说不确定，不要猜。';

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
    `【控制台入口】${CONSOLE_DAG_ENTRY_TEXT}`,
    `【工具】autoloop-hub MCP 工具：list_rules（规则与暂停状态）、list_runs（最近轮次与失败原因）、list_cards（待处理卡片）、resume_rule / pause_rule / run_rule（受控写：自愈恢复与重触发；run_rule 同规则 10 分钟冷却）；read_console_doc（按白名单路径读取控制台文档全文）。`,
    `【控制台文档索引】需要调度契约/架构细节时用 read_console_doc 按需读取（提示词不内联全文，以工具读到的磁盘内容为准）：`,
    `- AGENTS.md —— 控制台仓库总规则`,
    `- README.md —— 控制台概述`,
    `- docs/scheduling-contract.md —— 调度契约全文（调度方职责、模型派发规则、事件链不变量、自愈与升级纪律）；派发 worker、选择模型或调整调度行为前必读`,
    `- docs/architecture.md —— 控制台架构与模块边界`,
    ...buildOpenItemsTasks({ project }),
  ].join('\n');
}

export class SchedulingSessionError extends Error {
  constructor(message, { status = 400, conflict = null } = {}) {
    super(message);
    this.name = 'SchedulingSessionError';
    this.status = status;
    // 同项目同类型已有会话：带上已有会话的标识，界面据此给出「继续旧会话 / 关闭旧会话并新建」。
    this.conflict = conflict;
  }
}

const safeMessage = error => String(error?.message || error || '未知错误').replace(/[\r\n]+/g, ' ');
const statusLabel = status => ({ initializing: '初始化中', running: '运行中', idle: '待命', error: '异常', unknown: '待复核', closing: '关闭中', closed: '已关闭' })[status] || status;

// #96：只有带正整数 lastEventId 的 console-sessions/<id>.hub.json 旁车才算 Hub 形态。
// 旧 ACP 存档天然没有旁车；被 #94 误写出的 lastEventId:null 旁车同样不算合法形态。
// 不按 createdAt 猜时间界——有无合法旁车即可区分。
const hasHubShape = hub => Number.isSafeInteger(hub?.lastEventId) && hub.lastEventId > 0;
// #102：终态标记只落在既有 .hub.json 旁车；closed:true 一经落盘即不可回退。
const isHubTerminal = record => record.status === 'closing' || record.status === 'closed';

function toPublicSession(record) {
  const view = {
    id: record.id,
    kind: record.kind || 'scheduling',
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
    queuedCount: (record.queue || []).length,
    queued: (record.queue || []).map(item => ({ id: item.id, text: item.text, at: item.at })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  // Hub 原生调度会话暴露事项/run 标识供控制台总览映射；ACP 会话保持既有字段不变。
  if (record.hub) {
    view.hubSubject = record.hub.subject;
    view.hubRunId = record.hub.runId || null;
  }
  return view;
}

function summarizeUpdate(update) {
  if (!update || typeof update !== 'object') return '收到会话更新';
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') return '正在输出调度分析';
  if (update.sessionUpdate === 'tool_call') return '正在调用工具';
  if (update.sessionUpdate === 'plan') return '正在更新计划';
  return '收到会话更新';
}

export class SchedulingSessionManager {
  constructor({ cwd = REPOSITORY_ROOT, adapterPath = DEFAULT_ADAPTER_PATH, spawnFn = spawn, maxSessions = 3, writableDir = null, archiveRoot = null, now = () => new Date(), settleMs = 1500, codexHomeDir = null, userCodexHome = null, hubScheduling, hubReconcileMs = HUB_RECONCILE_INTERVAL_MS } = {}) {
    this.cwd = path.resolve(cwd);
    this.writableDir = writableDir ? path.resolve(writableDir) : null;
    // §6：kind=scheduling 走 Hub 事项/run/resume，绝不派生私有 ACP；normal/design 始终走 ACP。
    // 显式注入适配器（生产装配或测试）优先；false 保留旧 ACP 语义。
    // 缺省且为真实 ACP 默认装配（未注入假 spawnFn/adapterPath）时自动启用 Hub——本机服务由
    // createConsoleServer 以默认装配创建，因此生产自动走 Hub；注入假适配器的单元测试不受影响。
    const realAcpDefaults = spawnFn === spawn && adapterPath === DEFAULT_ADAPTER_PATH;
    this.hubScheduling = hubScheduling === false ? null
      : hubScheduling && typeof hubScheduling.postTurn === 'function' ? hubScheduling
        : realAcpDefaults ? new HubSchedulingSessionAdapter() : null;
    // #100：前端轮询 list() 时活跃 Hub 会话的最小对账间隔（默认 ≥5s）。
    this.hubReconcileMs = hubReconcileMs;
    this.adapterPath = adapterPath;
    this.spawnFn = spawnFn;
    this.maxSessions = maxSessions;
    this.now = now;
    this.sessions = new Map();
    // 会话存档：写穿到运行目录，重启后留档可继续；不可用时降级为纯内存。
    this.archive = archiveRoot ? new SessionArchive(archiveRoot) : null;
    // 运行目录（AGENT_AUTOLOOP_HOME）：资料文件、dag-runs、rules.json、worker/runs 都在这里；
    // 不同于存档目录 archive.root（= <运行目录>/console-sessions，只放会话存档与旁车）。
    this.runtimeRoot = archiveRoot ? path.resolve(archiveRoot) : null;
    this.archiveWarned = false;
    // 打断后轮次收尾的等待窗口：cancel 是通知无回执，稍等再续跑队列，避开适配器取消中状态
    this.settleMs = settleMs;
    this.bootMarked = false;
    // 会话专用 CODEX_HOME：默认放在运行目录 <archiveRoot>/codex-home；无运行目录时放系统临时目录。
    this.codexHomeDir = codexHomeDir ? path.resolve(codexHomeDir) : path.join(archiveRoot || path.join(tmpdir(), 'autoloop-console'), 'codex-home');
    this.userCodexHome = userCodexHome;
    this.auditFile = archiveRoot ? path.join(archiveRoot, 'permission-audit.jsonl') : null;
    this.auditWarned = false;
  }

  list() {
    const sessions = [...this.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // #100：前端轮询时顺带对活跃 Hub 会话做节流对账。只更新记录状态，不改 list 的同步返回形状。
    this.#reconcileActiveHubSessions(sessions);
    return sessions.map(toPublicSession);
  }

  // #100：与前端轮询对齐的节流对账。每次 list() 扫描活跃 Hub 会话，仅在超过 hubReconcileMs
  // 时发起一次异步 readStatus；失败单会话就地降级为 unknown+可读原因，不影响整表、不冒到调用方。
  // 终态（done/failed 映射的 idle/error）不再轮询，保证节流不会把最终态刷回待复核。
  #reconcileActiveHubSessions(sessions) {
    if (!this.hubScheduling?.readStatus) return;
    const nowMs = Date.now();
    for (const record of sessions) {
      const hub = record.hub;
      if (!hub?.lastEventId) continue;
      if (!['unknown', 'running'].includes(record.status)) continue;
      if (Number.isFinite(hub.lastReconcileAt) && nowMs - hub.lastReconcileAt < this.hubReconcileMs) continue;
      hub.lastReconcileAt = nowMs;
      void this.#reconcileHubRun(record, hub.lastEventId).catch(error => {
        if (this.sessions.get(record.id) !== record) return;
        record.status = 'unknown';
        record.error = `Hub 状态待复核：${safeMessage(error)}`;
        record.updatedAt = this.now().toISOString();
        this.#persist(record);
      });
    }
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

  // #92 控制台重启：从 console-sessions 存档恢复调度会话视图，逐个用存档里的数字
  // lastEventId 调 GET /v1/events 对账；不恢复私有进程、不读不存在的 /v1/matters。
  // Hub 失败要可见（抛错给启动脚本记录），无存档/无凭据不算错误但状态如实标待复核。
  async restoreFromHub() {
    if (!this.hubScheduling?.readStatus || !this.archive) return;
    await this.#ensureBootMarked();
    const { sessions: archived } = await this.archive.loadAllDetailed();
    const failures = [];
    for (const item of archived) {
      if (item.kind !== 'scheduling' || this.sessions.has(item.id)) continue;
      const hub = this.#readHubState(item.id);
      // #96：无合法 Hub 旁车的是 ACP 时代旧存档。它只属于历史区——不恢复成活跃/
      // 待复核视图、不参与 (project,kind) 查重、更不补写旁车。直接跳过即不进入 sessions。
      if (!hasHubShape(hub)) continue;
      // #102：已 close 的会话旁车带 closed:true——只进历史区，不复活、不参与查重与名额、不对账。
      // 旧旁车无该字段按未关处理（向后兼容）。
      if (hub.closed === true) continue;
      const nowIso = this.now().toISOString();
      const record = {
        id: item.id,
        kind: 'scheduling',
        sessionId: item.id,
        agent: HUB_SCHEDULING_AGENT_LABEL,
        cwd: this.#projectCwd(item.project),
        status: 'unknown',
        project: item.project || '未识别',
        writableDir: null,
        continuedFrom: item.continuedFrom || null,
        prompt: item.prompt || '',
        queue: [],
        interruptRequested: false,
        stopReason: item.endStatus === 'interrupted' ? 'interrupted' : null,
        error: null,
        messages: Array.isArray(item.messages) ? item.messages.map(message => ({ ...message })) : [],
        liveText: '',
        createdAt: item.createdAt || nowIso,
        updatedAt: nowIso,
        child: null,
        connection: null,
        closed: false,
        hub: {
          sessionId: item.id,
          subject: hub.subject || schedulingSubject(item.id),
          turn: Number.isInteger(hub.turn) && hub.turn > 0 ? hub.turn : 1,
          lastEventId: hub.lastEventId,
          runId: hub.runId ?? null,
          summaryEventId: Number.isInteger(hub.summaryEventId) ? hub.summaryEventId : null,
          lastAgent: typeof hub.lastAgent === 'string' && hub.lastAgent ? hub.lastAgent : null,
          lastState: null,
        },
      };
      // 先把视图放进列表，再对账；这样 Hub 失败时会话仍在列表、状态为待复核。
      this.sessions.set(record.id, record);
      if (record.hub.lastEventId) {
        try {
          await this.#reconcileHubRun(record, record.hub.lastEventId, { throwOnError: true });
        } catch (error) {
          record.error = `Hub 状态待复核：${safeMessage(error)}`;
          record.status = 'unknown';
          failures.push(`${item.id}：${safeMessage(error)}`);
        }
      }
      this.#persist(record);
    }
    if (failures.length) throw new HubSchedulingError(`部分调度会话状态待复核：${failures.join('；')}`);
  }

  // 用存档转录新建会话续跑（ACP 无法跨进程重连，只能新建）。
  async continueSession(id) {
    if (!this.archive) throw new SchedulingSessionError('会话存档不可用（未配置运行目录）', { status: 503 });
    let record;
    try { record = await this.archive.read(id); }
    catch (error) { throw new SchedulingSessionError(`无法继续该会话：${error.message}`, { status: error.status || 400 }); }
    const prompt = await this.archive.buildContinuation(id);
    return this.start({ kind: record.kind || 'scheduling', prompt, project: record.project, continuedFrom: record.id });
  }

  async start({ kind = 'scheduling', prompt, project, continuedFrom = null } = {}) {
    const sessionKind = SESSION_KINDS.includes(kind) ? kind : 'scheduling';
    const projectId = this.#validateProject(project);
    const base = sessionKind === 'design'
      ? buildDesignPrompt({ project: projectId })
      : sessionKind === 'scheduling'
        ? buildSchedulingPrompt({ project: projectId, writableDir: this.writableDir })
        : '';
    // normal：prompt 逐字等于用户输入，不组装任何额外提示词；其余 kind 在基础提示词后附用户说明。
    const composed = sessionKind === 'normal'
      ? String(prompt ?? '').trim()
      : prompt ? `${base}\n\n【本次附加说明】\n${prompt}` : base;
    const text = this.#validatePrompt(composed, 64000);
    const duplicate = [...this.sessions.values()].find(session => session.project === projectId && (session.kind || 'scheduling') === sessionKind);
    if (duplicate) throw new SchedulingSessionError(`项目 ${projectId} 已有进行中的${SESSION_KIND_LABELS[sessionKind]}（${duplicate.id.slice(0, 8)}），请先关闭再开启`, { status: 409, conflict: { sessionId: duplicate.id, kind: sessionKind, project: projectId } });
    if (this.sessions.size >= this.maxSessions) throw new SchedulingSessionError(`最多同时开启 ${this.maxSessions} 个会话`);
    // §6：调度会话从首轮起进入 Hub，绝不派生私有 ACP 进程；normal/design 保持既有 ACP 语义。
    // Hub 路径：护栏/任务说明（base）进本轮资料文件，事件正文只放用户原话，避免 4000 码点预算截掉用户需求。
    if (sessionKind === 'scheduling' && this.hubScheduling) {
      const userText = String(prompt ?? '').trim() || '按调度会话护栏开局：读 open 事项并汇报处理清单。';
      return this.#startHubSession({ projectId, text: this.#validatePrompt(userText, 64000), guide: base, continuedFrom });
    }
    if (this.spawnFn === spawn && !existsSync(this.adapterPath)) throw new SchedulingSessionError('找不到 Codex ACP 适配器，请先运行 npm ci', { status: 500 });

    const sessionCwd = this.#projectCwd(projectId);
    // fail closed：专用 CODEX_HOME 准备失败就不启动，绝不回退到继承全局 approval_policy 的环境。
    let codexHome;
    try { codexHome = prepareSessionCodexHome({ targetDir: this.codexHomeDir, userCodexHome: this.userCodexHome || defaultUserCodexHome() }); }
    catch (error) { throw new SchedulingSessionError(`无法准备会话专用 CODEX_HOME：${safeMessage(error)}`, { status: 500 }); }
    const child = this.spawnFn(process.execPath, [this.adapterPath], {
      cwd: sessionCwd,
      env: { ...process.env, NO_BROWSER: process.env.NO_BROWSER || '1', CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    if (!child?.stdin || !child?.stdout || !child?.stderr) throw new SchedulingSessionError('无法启动 Codex ACP 适配器', { status: 500 });
    let stderrTail = '';
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-4096); });

    const record = {
      id: randomUUID(),
      kind: sessionKind,
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
      knownCalls: new Map(),
    };
    this.sessions.set(record.id, record);

    const touch = note => { record.updatedAt = this.now().toISOString(); return note; };
    const acpClient = client({ name: 'autoloop-console' })
      .onRequest(methods.client.session.requestPermission, async request => {
        touch('permission');
        return { outcome: this.#decidePermission(request?.params, record) };
      })
      .onNotification(methods.client.session.update, notification => {
        const update = notification?.params?.update || {};
        touch(summarizeUpdate(update));
        if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.toolCallId) {
          record.knownCalls.set(update.toolCallId, mergeCall(record.knownCalls.get(update.toolCallId), update));
          if (record.knownCalls.size > 500) record.knownCalls.delete(record.knownCalls.keys().next().value);
        }
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
        mcpServers: sessionKind === 'scheduling' ? [buildHubMcpServer()] : [],
      });
      if (!session?.sessionId) throw new SchedulingSessionError('Codex ACP 没有返回会话 ID', { status: 502 });
      record.sessionId = session.sessionId;
      // 设计会话：首个 prompt 前必须完成 read-only + 原生 Plan Mode 并核验，任一失败即创建失败，不降级。
      if (sessionKind === 'design') await this.#applyDesignGuards(record);
      else await this.#applySandboxMode(record, sessionKind === 'normal' ? 'workspace-write' : 'read-only');
      record.status = 'idle';

      this.#pushMessage(record, 'user', text);
      this.#runTurn(record, text, sessionKind === 'normal' ? [BRANCH_DISCIPLINE_PROMPT] : []);
      return toPublicSession(record);
    } catch (error) {
      record.status = 'error';
      record.error = safeMessage(error);
      this.#destroyRecord(record);
      const openLabel = { normal: '开启普通会话失败', scheduling: '开启调度会话失败', design: '开启会话失败（设计会话，已按只读 + Plan Mode 要求关闭）' }[sessionKind] || '开启会话失败';
      throw new SchedulingSessionError(`${openLabel}：${record.error}`, { status: 502 });
    }
  }

  // §6.3 start：生成 subject、投递首个事件，返回 Hub 支持的会话视图；失败保留输入且不派生进程。
  // #92 POST 只提供数字 event id；status/runId 一律经 GET /v1/events/<id> 的 runs[0] 派生。
  // Hub 事件 detail 上限 4000 码点：完整资料（护栏、项目 AGENTS.md、契约、状态快照、上一轮结论、未收尾）
  // 落盘到运行目录 <AGENT_AUTOLOOP_HOME>/scheduling-context/，正文只放用户原话 + 一行「先读它」；以序列化后的 detail 为准截断。
  // hubState：本轮共享的一份 /v1/state（读一次给快照、上一轮执行者用），缺省时快照降级为空。
  async #hubTurnText(record, turn, text, { hubState = null } = {}) {
    const lastSummary = [...(record.messages || [])].reverse().find(message => message.role === 'agent')?.text || '';
    const subject = record.hub?.subject ?? schedulingSubject(record.id);
    // 上一轮执行者以旁车记录为准（轮次结束时记下）；旧会话没有记录时再从 /v1/state 当前页找，找不到不编造。
    const prevAgent = record.hub?.lastAgent || (hubState ? prevAgentFrom(hubState, subject) : null);
    // 护栏每轮都进资料文件：换执行者后新会话没有历史，只能靠资料重建；重启恢复的记录按项目重新生成。
    const guide = record.guide || buildSchedulingPrompt({ project: record.project, writableDir: this.writableDir });
    const file = await buildSchedulingContext({
      root: this.runtimeRoot, sessionId: record.id, turn, project: record.project, lastSummary, prevAgent,
      guide, userText: text, providers: this.#snapshotProviders(hubState, record.project),
      // 交接段：本轮消息尚未写进转录，配出来的最后一轮就是「上一轮」。
      exchanges: exchangesFrom(record.messages, { rounds: HANDOVER_ROUNDS }),
    }).catch(() => null);
    return composeTurnText({ text, trailer: contextTrailer(file), project: record.project });
  }

  // 本轮读一次 /v1/state；读不到返回 null（调用方据此降级，绝不当成「没有未收尾事项」）。
  async #readHubSnapshot() {
    if (typeof this.hubScheduling?.readState !== 'function') return null;
    try { return await this.hubScheduling.readState(); } catch { return null; }
  }

  // 规则名 → cwd：/v1/state 的 lines 不带 cwd，从运行目录 rules.json 对出（读不到返回空表，只影响排序）。
  #ruleCwds() {
    if (!this.runtimeRoot) return new Map();
    try {
      const rules = JSON.parse(readFileSync(path.join(this.runtimeRoot, 'rules.json'), 'utf8'))?.rules || [];
      return new Map(rules.filter(rule => rule?.name).map(rule => [rule.name, String(rule.cwd || '')]));
    } catch { return new Map(); }
  }

  // 状态快照的四个 provider：规则/轮次/卡片来自本轮共享的 /v1/state，DAG 读运行目录 dag-runs/*.json 的根 run（本项目）。
  // 任何一节失败只影响该行，不阻断资料落盘。
  #snapshotProviders(hubState, project = '') {
    const root = this.runtimeRoot;
    const lines = hubState ? snapshotLinesFrom(hubState, { project, ruleCwds: this.#ruleCwds() }) : { rules: [], runs: [], cards: [] };
    return {
      rules: () => lines.rules,
      runs: () => lines.runs,
      cards: () => lines.cards,
      dag: async () => {
        if (!root) return [];
        const dir = path.join(root, 'dag-runs');
        let names = [];
        // 只看最近修改的 50 份记录：dag-runs 随时间增长，每轮全量同步解析会越来越慢。
        try {
          names = readdirSync(dir).filter(n => n.endsWith('.json'))
            .map(name => { try { return { name, at: statSync(path.join(dir, name)).mtimeMs }; } catch { return null; } })
            .filter(Boolean).sort((a, b) => b.at - a.at).slice(0, 50).map(item => item.name);
        } catch { return []; }
        const rows = [];
        for (const name of names) {
          try {
            const raw = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
            if (raw.nodeId !== ROOT_NODE || !raw.runId) continue;
            if (project && raw.project && raw.project !== project) continue;
            rows.push({ at: String(raw.updatedAt || raw.createdAt || ''), text: `${raw.runId}｜${raw.planId || ''}｜${raw.status || ''}` });
          } catch { /* 单条损坏不影响其余 */ }
        }
        return rows.sort((a, b) => b.at.localeCompare(a.at)).map(row => row.text);
      },
    };
  }

  async #startHubSession({ projectId, text: rawText, guide = '', continuedFrom }) {
    const id = randomUUID();
    const turn = 1;
    const text = await this.#hubTurnText({ id, project: projectId, messages: [], guide }, turn, rawText);
    let result;
    try {
      result = await this.hubScheduling.postTurn({ sessionId: id, turn, project: projectId, text });
    } catch (error) {
      throw new SchedulingSessionError(`开启调度会话失败：${safeMessage(error)}`, { status: error.status || 502 });
    }
    const eventId = numericEventId(result);
    const nowIso = this.now().toISOString();
    const subject = schedulingSubject(id);
    const record = {
      id,
      kind: 'scheduling',
      sessionId: id,
      agent: HUB_SCHEDULING_AGENT_LABEL,
      cwd: this.#projectCwd(projectId),
      status: 'unknown',
      project: projectId,
      writableDir: null,
      continuedFrom,
      prompt: text,
      queue: [],
      interruptRequested: false,
      stopReason: null,
      error: null,
      messages: [],
      liveText: '',
      createdAt: nowIso,
      updatedAt: nowIso,
      child: null,
      connection: null,
      closed: false,
      hub: {
        sessionId: id,
        subject,
        turn,
        lastEventId: eventId,
        runId: null,
        summaryEventId: null,
        lastState: null,
      },
    };
    this.sessions.set(record.id, record);
    // 先记用户消息再对账：worker 结论追加在用户消息之后，转录顺序才正确。
    this.#pushMessage(record, 'user', rawText);
    await this.#reconcileHubRun(record, eventId);
    return toPublicSession(record);
  }

  // §6.3 send：向同一 subject 发新事件；重复 id 幂等；失败保留输入，不回退 ACP。
  async #sendToHub(record, raw, { interrupt }) {
    if (interrupt) {
      record.interruptRequested = true;
      try {
        let runId = record.hub.runId;
        if (!runId) {
          if (!record.hub.lastEventId) throw new Error('没有可用的事件 id，无法确认已打断');
          const payload = await this.hubScheduling.readStatus({ eventId: record.hub.lastEventId });
          runId = readHubRun(payload)?.runId || null;
        }
        if (!runId) throw new Error('取不到正在运行的 run 标识，无法确认已打断');
        record.hub.runId = runId;
        await this.hubScheduling.cancelRun(runId);
      } catch (error) {
        record.interruptRequested = false;
        throw new SchedulingSessionError(`打断 Hub run 失败：${safeMessage(error)}`, { status: 502 });
      }
      record.interruptRequested = false;
      record.status = 'idle';
      record.stopReason = 'interrupted';
      record.updatedAt = this.now().toISOString();
      this.#persist(record);
      return toPublicSession(record);
    }
    const message = this.#validatePrompt(raw);
    const turn = record.hub.turn + 1;
    const hubState = await this.#readHubSnapshot();
    const messageText = await this.#hubTurnText(record, turn, message, { hubState });
    let result;
    try {
      result = await this.hubScheduling.postTurn({ sessionId: record.hub.sessionId, turn, project: record.project, text: messageText });
    } catch (error) {
      // 输入保留：不记入转录、不推进轮次，让调用方/界面保留草稿可重试。
      throw new SchedulingSessionError(`发送失败：${safeMessage(error)}（内容已保留，请重试）`, { status: error.status || 502 });
    }
    record.hub.turn = turn;
    record.hub.lastEventId = numericEventId(result);
    record.status = 'unknown';
    record.stopReason = null;
    this.#pushMessage(record, 'user', message);
    // 队列项各成一条 Hub 事件；投递失败则留回队首，不丢消息。
    while (record.queue.length) {
      const next = record.queue[0];
      const queuedTurn = record.hub.turn + 1;
      try {
        const queuedText = await this.#hubTurnText(record, queuedTurn, next.text, { hubState });
        const queuedResult = await this.hubScheduling.postTurn({ sessionId: record.hub.sessionId, turn: queuedTurn, project: record.project, text: queuedText });
        record.queue.shift();
        record.hub.turn = queuedTurn;
        record.hub.lastEventId = numericEventId(queuedResult);
        this.#pushMessage(record, 'user', next.text);
      } catch (error) {
        record.error = safeMessage(error);
        break;
      }
    }
    await this.#reconcileHubRun(record, record.hub.lastEventId);
    return toPublicSession(record);
  }

  async send(id, text, { interrupt = false } = {}) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    if (['closing', 'closed'].includes(record.status)) throw new SchedulingSessionError('会话已关闭，请开启新会话', { status: 409 });
    if (record.status === 'error') throw new SchedulingSessionError('会话处于异常状态，请关闭后重新开启', { status: 409 });
    const raw = String(text ?? '').trim();
    // B4 空上下文守卫：只拦「继续/已解决」这类续接话术，且仅当确实没有可续接的东西——
    // 转录里没有 worker 结论、首轮 run 不在进行中、Hub 同事项也没有未收尾卡片。
    // 先比正则再读 Hub（不是续接话术不花一次请求）；读 Hub 失败按「有上下文」放行，宁可放过不误拦。
    if (record.hub && !['closing', 'closed'].includes(record.status) && isBareContinuation(raw)) {
      const hasAgentTurn = (record.messages || []).some(m => m.role === 'agent');
      const runActive = ['running', 'unknown'].includes(record.status);
      if (!hasAgentTurn && !runActive) {
        const hubState = await this.#readHubSnapshot();
        const hasHubOpen = hubState === null || hasOpenCardsFor(hubState, record.hub.subject);
        if (!hasHubOpen) {
          this.#pushMessage(record, 'user', raw);
          this.#pushMessage(record, 'agent', '没有可续接的上下文：这一轮还没有 worker 结论，也没有未收尾事项。请说明要继续哪件事（贴任务名/卡片号/需求一句话），我再发事件。');
          this.#persist(record);
          return toPublicSession(record);
        }
      }
    }
    // 设计会话拒绝斜杠命令（至少 /plan 必须拦截），防止借命令切换模式；排队与打断入口同样在此统一拦截。
    if ((record.kind || 'scheduling') === 'design' && raw.startsWith('/')) {
      throw new SchedulingSessionError('设计会话不接受斜杠命令（防止切换模式），请用自然语言描述需求', { status: 400 });
    }
    if (record.hub) return this.#sendToHub(record, raw, { interrupt });
    if (record.status === 'idle') {
      const message = this.#validatePrompt(raw);
      this.#pushMessage(record, 'user', message);
      this.#runTurn(record, message);
      return toPublicSession(record);
    }
    // 运行中/初始化中：与 Codex 输入体验一致——默认排队跟进，interrupt 取消当前轮。
    if (interrupt) {
      if (record.status === 'initializing') throw new SchedulingSessionError('会话初始化中，请稍候再试（打断只在运行中可用）', { status: 409 });
      // 与 Codex 原生 Stop 一致：纯停止本轮；不读取文本（调用方草稿留在客户端），不动队列。
      // 注意：text 在此分支被有意忽略——控制台前端传空串；带文本调用属于旧 API 约定，不再送达。
      // 轮次收尾后队列自动续跑（finish 里按 settleMs 延迟 drain），不需要任何手动恢复
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
    const next = this.#validatePrompt(String(text ?? '').trim());
    if ((record.kind || 'scheduling') === 'design' && next.startsWith('/')) {
      throw new SchedulingSessionError('设计会话不接受斜杠命令（防止切换模式），请用自然语言描述需求', { status: 400 });
    }
    item.text = next;
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

  async clearQueued(id) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    if (['closing', 'closed'].includes(record.status)) throw new SchedulingSessionError('会话已关闭，请开启新会话', { status: 409 });
    record.queue = [];
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
    record.updatedAt = this.now().toISOString();
    // 原生 _session/steering（codex-acp 2.6）：运行中把消息注入当前轮，agent 立即看到，不打断、不新开轮
    if (record.status === 'running' && record.connection?.agent) {
      try {
        await record.connection.agent.request('_session/steering', { sessionId: record.sessionId, prompt: [{ type: 'text', text: item.text }] });
        // 与 drain 路径对齐：steered 消息进转录并写穿存档，会话界面与续跑留档不断档
        this.#pushMessage(record, 'user', item.text);
        this.#persist(record);
        return toPublicSession(record);
      } catch (error) {
        // 轮次恰好结束 / 适配器不支持 steering：退回队首路径，等当前轮收尾后自动续跑（finish 内 drain）
        if (!/no active turn to steer|method not found/i.test(String(error?.message || error))) {
          // 恢复队列项再报错：消息不能丢（传输层失败时适配器可能已收到，重试由用户决定）
          record.queue.unshift(item);
          throw new SchedulingSessionError(`steer in 失败：${safeMessage(error)}`, { status: 502 });
        }
      }
    }
    // settle 窗口内（打断后定时器未到期）steer 立即开轮是有意取舍：steer 的语义就是"马上送达"，
    // 残余风险（适配器仍在取消中）由 finish 的 error 分支兜底为用户可见的错误态
    record.queue.unshift({ id: randomUUID(), text: item.text, at: this.now().toISOString() });
    this.#drainQueue(record);
    return toPublicSession(record);
  }

  async listSessionArtifacts(id) {
    const record = this.sessions.get(String(id || ''));
    if (!record) throw new SchedulingSessionError('调度会话不存在', { status: 404 });
    try {
      return listArtifacts(record.cwd);
    } catch (error) {
      throw new SchedulingSessionError(`产物目录不可读：${safeMessage(error)}`, { status: 404 });
    }
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
    if (record.hub) {
      // §6.3 close：停止新事件；Hub run 在 Hub 侧继续，不杀本地进程、也不在此取消 run。
      // #102：先把终态写进既有旁车——写失败抛可诊断错误且内存完全不变（与磁盘一致），
      // 绝不出现「内存已关、磁盘仍活跃」导致重启复活。写成功后再落写穿存档并移出活跃表。
      this.#persistHubState({ ...record, status: 'closed' }, { throwOnError: true });
      record.status = 'closed';
      record.updatedAt = this.now().toISOString();
      this.#persist(record);
      this.sessions.delete(record.id);
      return toPublicSession(record);
    }
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

  // 设计会话护栏：read-only（经 #applySandboxMode）+ 原生 Plan Mode，逐个核验返回的 configOptions。
  async #applyDesignGuards(record) {
    await this.#applySandboxMode(record, 'read-only');
    const plan = await record.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: record.sessionId, configId: 'collaboration_mode', value: 'plan' });
    const planOptions = Array.isArray(plan?.configOptions) ? plan.configOptions : [];
    if (!planOptions.some(option => option.id === 'collaboration_mode' && option.currentValue === 'plan')) throw new Error('无法将协作模式设置为 plan');
  }

  // 沙箱模式机械化：调度=read-only，普通=workspace-write；设置并核验失败即拒绝创建，不降级。
  // codex-acp@2.6.0 的 session/set_mode 成功响应按协议是空对象（SDK 声明 emptyObjectResponse），无法从响应自核验；
  // 故随后用等价的 session/set_config_option(configId='mode') 复读——适配器内同样走 applyModeChange，幂等——
  // 并核验其响应 configOptions 中 mode 的落账值；set_mode 或复读核验任一失败即拒绝创建，不降级。
  async #applySandboxMode(record, modeId) {
    await record.connection.agent.request(methods.agent.session.setMode, { sessionId: record.sessionId, modeId });
    const applied = await record.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: record.sessionId, configId: 'mode', value: modeId });
    const options = Array.isArray(applied?.configOptions) ? applied.configOptions : [];
    if (!options.some(option => option.id === 'mode' && option.currentValue === modeId)) throw new Error(`无法将会话设置为 ${modeId} 模式`);
  }

  // 按 kind 的权限矩阵裁定（逻辑见 session-permission.mjs），每次裁定写审计留痕。
  #decidePermission(params, record = null) {
    const kind = record?.kind || 'scheduling';
    let decision;
    try {
      decision = decideByKind({ kind, params, known: record?.knownCalls?.get(params?.toolCall?.toolCallId), workspace: record?.cwd, writableDir: this.writableDir });
    } catch (error) {
      decision = { allow: false, reason: `裁定异常：${safeMessage(error)}`, optionId: null, toolKind: null, command: '', paths: [], title: '' };
    }
    this.#auditPermission(record, params, decision);
    return decision.allow ? { outcome: 'selected', optionId: decision.optionId } : { outcome: 'cancelled' };
  }

  #auditPermission(record, params, decision) {
    const entry = {
      at: this.now().toISOString(), kind: record?.kind || 'scheduling', project: record?.project, session: record?.id,
      toolCallId: params?.toolCall?.toolCallId, toolKind: decision.toolKind, title: decision.title, command: decision.command,
      paths: decision.paths, decision: decision.allow ? 'allowed' : 'denied', reason: decision.reason,
    };
    if (!decision.allow) console.error(`[permission] 拒绝 ${entry.kind}/${entry.toolKind || 'unknown'}：${entry.reason}`);
    if (!this.auditFile) return;
    try { appendFileSync(this.auditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); }
    catch { if (!this.auditWarned) { this.auditWarned = true; console.error('[permission] 审计日志写入失败'); } }
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
      kind: record.kind || 'scheduling',
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
    if (record.hub) this.#persistHubState(record);
  }

  // #92 Hub 恢复凭据旁车：通用存档 normalizeRecord 只保留固定字段，数字 event id / turn
  // 必须写穿到 console-sessions 才能在重启后逐个 readStatus 对账（不改 session-archive.mjs）。
  // #102：旁车同时承载 close 终态（closed:true）；终态 sticky，且可按需抛错（终态写入失败不得静默）。
  #persistHubState(record, { throwOnError = false } = {}) {
    if (!this.archive?.root) return;
    // #96：没有合法数字 lastEventId 就不写旁车，杜绝给旧存档伪造 Hub 形态。
    if (!hasHubShape(record.hub)) return;
    const file = path.join(this.archive.root, `${record.id}.hub.json`);
    let existing = null;
    try { existing = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 无旁车或不可读：按新写处理 */ }
    const payload = {
      sessionId: record.hub.sessionId,
      subject: record.hub.subject,
      turn: record.hub.turn,
      lastEventId: record.hub.lastEventId,
      runId: record.hub.runId ?? null,
      summaryEventId: record.hub.summaryEventId ?? null,
      lastAgent: record.hub.lastAgent ?? null,
    };
    if (existing?.closed === true || isHubTerminal(record)) payload.closed = true;
    try {
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      if (throwOnError) throw new SchedulingSessionError(`关闭调度会话失败：终态写入失败（${safeMessage(error)}）`, { status: 500 });
      if (!this.archiveWarned) { this.archiveWarned = true; console.error(`[scheduling-session] Hub 恢复凭据写入失败：${safeMessage(error)}`); }
    }
  }

  #readHubState(id) {
    if (!this.archive?.root) return null;
    try { return JSON.parse(readFileSync(path.join(this.archive.root, `${id}.hub.json`), 'utf8')); }
    catch { return null; }
  }

  // #92 经 GET /v1/events/<数字 id> 的 runs[0] 对账 status/runId。
  // throwOnError=true 用于恢复路径（失败要可见）；其余路径如实标 unknown/待复核并保留输入。
  async #reconcileHubRun(record, eventId, { throwOnError = false } = {}) {
    if (!eventId || !this.hubScheduling?.readStatus) return null;
    // #100：记下本次对账时刻，供 list() 的节流判断；失败路径同样计时，避免抖动时反复打 Hub。
    if (record.hub) record.hub.lastReconcileAt = Date.now();
    let payload;
    try {
      payload = await this.hubScheduling.readStatus({ eventId });
    } catch (error) {
      if (throwOnError) throw error;
      record.status = 'unknown';
      record.error = `Hub 状态待复核：${safeMessage(error)}`;
      record.updatedAt = this.now().toISOString();
      this.#persist(record);
      return null;
    }
    const run = readHubRun(payload);
    if (!run) {
      record.status = 'unknown';
      record.updatedAt = this.now().toISOString();
      this.#persist(record);
      return null;
    }
    // worker 结论回显到会话转录：同一事件只追加一次，重启/重复对账不重复。
    // 中台 summary 只是最后一条消息的第一行；轮次结束后优先从本机执行目录读回完整回复，读不到才退回 summary。
    const finished = run.state === 'done' || run.state === 'nothing';
    const terminal = finished || run.state === 'cancelled';
    if (finished && record.hub.summaryEventId !== Number(eventId)) {
      const full = run.runId ? readFinalMessage({ root: this.runtimeRoot, runId: run.runId }) : null;
      const reply = full || (run.summary ? String(run.summary) : '');
      if (reply) {
        record.hub.summaryEventId = Number(eventId);
        this.#pushMessage(record, 'agent', reply);
      }
    }
    // 本轮执行者：/v1/events 不带 agent，刚结束的轮次在 /v1/state 当前页里找。找不到（读失败、已翻页）就清空，
    // 让下一轮退回现场查找，绝不让上上一轮的旧值冒充上一轮。只在本事件仍是会话最新事件时才记。
    let agent = null;
    if (terminal && record.hub.lastEventId === Number(eventId)) {
      const state = await this.#readHubSnapshot();
      agent = (Array.isArray(state?.runs) ? state.runs : []).find(item => Number(item?.id) === Number(run.runId))?.agent || null;
    }
    // 等待期间用户可能已发出下一轮：旧事件的对账不得覆盖新一轮的 runId/状态（否则新一轮不再被轮询、打断也会打错轮）。
    if (record.hub.lastEventId !== Number(eventId)) {
      this.#persist(record);
      return run;
    }
    if (terminal) record.hub.lastAgent = agent;
    if (run.runId) record.hub.runId = run.runId;
    record.hub.lastState = run.state ?? null;
    record.status = mapHubStateToStatus(run.state);
    if (typeof record.error === 'string' && record.error.startsWith('Hub 状态待复核')) record.error = null;
    record.updatedAt = this.now().toISOString();
    this.#persist(record);
    return run;
  }

  #runTurn(record, text, extraBlocks = []) {
    record.liveText = '';
    record.status = 'running';
    record.updatedAt = this.now().toISOString();
    record.promptTurn = record.connection.agent.request(methods.agent.session.prompt, {
      sessionId: record.sessionId,
      prompt: [{ type: 'text', text }, ...extraBlocks.map(block => ({ type: 'text', text: block }))],
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
      if ((record.kind || 'scheduling') === 'design' && !error && !interrupted) {
        // 契约：每轮结束后重复 set 并读取 configOptions 核验仍为 read-only + plan，不一致置 error。
        this.#applyDesignGuards(record).catch(guardError => {
          if (record.status === 'error' || record.closed) return;
          record.status = 'error';
          record.error = `设计会话模式漂移：${safeMessage(guardError)}`;
          record.updatedAt = this.now().toISOString();
          this.#persist(record);
        });
      }
      // 被打断的轮次收尾后，给适配器一段取消窗口再续跑队列；正常结束的轮次立即续跑
      if (interrupted) {
        setTimeout(() => {
          try { this.#drainQueue(record); } catch (error) { record.status = 'error'; record.error = safeMessage(error); }
        }, this.settleMs);
      } else this.#drainQueue(record);
    };
    record.promptTurn.then(response => {
      const interrupted = response?.stopReason && response.stopReason !== 'end_turn';
      finish(interrupted ? '' : record.liveText.trim(), response?.stopReason, null);
    }).catch(error => finish('', null, error));
  }

  #drainQueue(record) {
    // 队列项恒为对象（null 纯打断标记随"打断=纯停止"语义已退役，不再入队）
    while (record.status === 'idle' && record.queue.length) {
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
