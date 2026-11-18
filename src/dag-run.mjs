// DAG run 状态机核心：创建/授权快照、状态迁移、advance 回执校验、失败计数、
// 槽位占用/隔离/释放判定、publish PR 关闭校验、run.json 原子持久化。
// 纯逻辑 + 可注入存储目录；不执行进程操作、不调用模型、不访问 Hub。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ALLOWED_ACTIONS = Object.freeze([
  'worktree', 'run-tests', 'push-branch', 'create-pr',
  'independent-review', 'rework-p0-p2', 'squash-merge', 'close-superseded-pr',
]);
export const DENIED_ACTIONS = Object.freeze(['deploy', 'release', 'production-write', 'credentials', 'external-communication']);
// 可选高风险动作与 DENIED_ACTIONS 同源；每项用产品语言写明收益与代价（Spec §5.3-5.5）。
export const HIGH_RISK_ACTIONS = DENIED_ACTIONS;
export const HIGH_RISK_ACTION_INFO = Object.freeze({
  deploy: { title: '部署', benefit: '把已合并的改动发布到运行环境，让目标用户尽快用到新版本', cost: '一旦出错会影响线上服务，需要有人值守并备好回滚方案' },
  release: { title: '发布', benefit: '按既定节奏对外发布一个新版本，便于统一管理变更', cost: '发布窗口内需盯盘，版本兼容问题会影响所有使用者' },
  'production-write': { title: '生产数据写入', benefit: '直接修正或迁移线上数据，省去人工逐条操作', cost: '误写会污染真实数据且大多不可逆，必须可验证、可回滚' },
  credentials: { title: '凭据', benefit: '让流程在受控范围内自动获取所需访问权限', cost: '凭据泄露或扩散会带来安全与合规风险，需最小权限并定期轮换' },
  'external-communication': { title: '对外通信', benefit: '自动向客户或合作方同步结果，减少人工传达', cost: '误发会造成误导或隐私外泄，发出前往往需要人工确认措辞' },
});
// 授权记录 schema：1 为历史格式（digest 必须逐字保留），2 为轻量执行授权记录。
export const GRANT_SCHEMA = 2;
export const ROOT_NODE = '__root__';
export const MAX_SLOTS = 5;
export const MAX_ATTEMPTS = 3;
export const MAX_GENERATION = 10;
export const QUARANTINE_AFTER_MS = 15 * 60 * 1000;
export const SLOT_RELEASE_MIN_OFFLINE_MS = 24 * 3600 * 1000;

export const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'abandoned', 'blocked_unknown']);
export const isTerminal = status => TERMINAL_STATUSES.has(status);

// 主链 queued → claimed → done/cancelled；异常路径 unknown/blocked_unknown/abandoned。
const LEGAL_TRANSITIONS = {
  queued: ['claimed', 'cancelled', 'unknown', 'blocked_unknown'],
  claimed: ['done', 'cancelled', 'unknown', 'blocked_unknown'],
  unknown: ['abandoned', 'blocked_unknown'],
};

export function transition(run, to) {
  if (!run || typeof run.status !== 'string') throw new Error('非法状态迁移：run 缺少当前状态');
  if (!(LEGAL_TRANSITIONS[run.status] || []).includes(to)) {
    throw new Error(`非法状态迁移：${run.status} → ${to}（迁移非法即报错，不静默纠正）`);
  }
  return { ...run, status: to, updatedAt: new Date().toISOString() };
}

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};
const sha256 = value => createHash('sha256').update(value).digest('hex');

// 快照摘要覆盖 planDigest、授权动作、目标仓库与合并策略；动作顺序归一保证稳定。
// schema 1 走历史公式，逐字兼容已创建的旧 run（如 dagrun-mwklgr10-e4c17e57）；
// schema 2 追加标准动作/可选高风险动作/修订号，digest 覆盖全部授权字段，动作顺序归一。
export function snapshotDigest(snapshot) {
  const { project, repo, mergeStrategy, planDigest, allowedActions } = snapshot || {};
  if (snapshot && snapshot.schema === GRANT_SCHEMA) {
    const { standardActions = [], optionalGrants = [], revision = 1 } = snapshot;
    return sha256(canonical({
      schema: GRANT_SCHEMA, project: project ?? null, repo: repo ?? null, mergeStrategy: mergeStrategy ?? null,
      planDigest: planDigest ?? null, standardActions, optionalGrants, allowedActions: allowedActions ?? [], revision,
    }));
  }
  return sha256(canonical({ project: project ?? null, repo: repo ?? null, mergeStrategy: mergeStrategy ?? null, planDigest: planDigest ?? null, allowedActions: allowedActions ?? [] }));
}

// 轻量执行授权记录（schema 2）：标准动作自动继承，高风险动作默认关闭，
// 仅当「计划声明 + 本轮明确勾选」才写入 optionalGrants。每项带产品语言的收益/代价。
export function buildGrantRecord({ project, repo, mergeStrategy, planDigest, confirmedActionIds, selectedOptionalActions = [], planOptionalActions = [], revision = 1 }) {
  const standardActions = [...new Set(confirmedActionIds)].sort();
  for (const action of standardActions) {
    if (typeof action !== 'string' || !text(action)) throw new DagRunError('BAD_INPUT', '标准授权动作必须是字符串');
    if (HIGH_RISK_ACTIONS.includes(action)) throw new DagRunError('ACTION_DENIED', `标准动作 "${action}" 不能混入高风险动作`);
    if (!ALLOWED_ACTIONS.includes(action)) throw new DagRunError('ACTION_NOT_ALLOWED', `授权动作 "${action}" 不在白名单，整体拒绝`);
  }
  for (const action of selectedOptionalActions) {
    if (!HIGH_RISK_ACTIONS.includes(action)) throw new DagRunError('ACTION_NOT_ALLOWED', `可选动作 "${action}" 不在高风险目录，整体拒绝`);
    if (!planOptionalActions.includes(action)) throw new DagRunError('ACTION_NOT_IN_PLAN', `可选高风险动作 "${action}" 未被计划声明，整体拒绝`);
  }
  const optionalGrants = [...new Set(selectedOptionalActions)].sort();
  const allowedActions = [...new Set([...standardActions, ...optionalGrants])].sort();
  const record = {
    schema: GRANT_SCHEMA, project: text(project), repo: repo == null ? null : text(repo), mergeStrategy: text(mergeStrategy) || 'squash',
    planDigest: text(planDigest), standardActions, optionalGrants, allowedActions, revision, createdAt: new Date().toISOString(),
  };
  return { ...record, digest: snapshotDigest(record) };
}

// 旧版构造器保留给历史调用；新 run 一律走 buildGrantRecord。
export function buildAuthorizationSnapshot({ project, repo, mergeStrategy, planDigest, confirmedActionIds }) {
  const allowedActions = [...new Set(confirmedActionIds)].sort();
  const snapshot = {
    schema: 1, project: text(project), repo: repo == null ? null : text(repo), mergeStrategy: text(mergeStrategy) || 'squash',
    planDigest: text(planDigest), allowedActions, createdAt: new Date().toISOString(),
  };
  return { ...snapshot, digest: snapshotDigest(snapshot) };
}

// 执行层动作裁定：digest 不一致 fail closed；高风险动作须显式选中才放行。
export function canExecuteAction(snapshot, action) {
  if (!snapshotIntact(snapshot)) return { ok: false, reason: 'GRANT_INCONSISTENT' };
  const info = HIGH_RISK_ACTION_INFO[action];
  if (HIGH_RISK_ACTIONS.includes(action)) {
    const selected = (snapshot.optionalGrants || []).includes(action);
    return selected
      ? { ok: true, reason: 'SELECTED', title: info?.title, benefit: info?.benefit, cost: info?.cost }
      : { ok: false, reason: 'HIGH_RISK_NOT_SELECTED', title: info?.title };
  }
  if (!ALLOWED_ACTIONS.includes(action)) return { ok: false, reason: 'UNKNOWN_ACTION' };
  return (snapshot.allowedActions || []).includes(action)
    ? { ok: true, reason: 'STANDARD' }
    : { ok: false, reason: 'ACTION_NOT_GRANTED' };
}

// 摘要不一致的诊断：给出可诊断原因与修复入口；schema2 且字段结构完整才允许重建。
export function grantDiagnostic(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { intact: false, repairable: false, reason: 'MISSING', message: '授权记录缺失，无法校验，fail closed' };
  }
  if (snapshotIntact(snapshot)) return { intact: true, repairable: false, reason: 'OK' };
  const structured = snapshot.schema === GRANT_SCHEMA
    && Array.isArray(snapshot.standardActions) && Array.isArray(snapshot.optionalGrants) && Array.isArray(snapshot.allowedActions)
    && typeof snapshot.digest === 'string';
  if (structured) return { intact: false, repairable: true, reason: 'DIGEST_MISMATCH', message: '授权记录摘要不一致（字段结构完整），暂停相关写入；可通过 rebuildGrant 重建摘要，不永久砖化 DAG' };
  return { intact: false, repairable: false, reason: 'UNSTRUCTURED', message: '授权记录摘要不一致且字段结构损坏，无法安全重建，fail closed' };
}

// 授权修订：实际计划或动作范围扩大才形成新修订；未变化则沿用原记录（attempt 继承不重新授权）。
export function reconcileGrant(prevGrant, { confirmedActionIds, selectedOptionalActions = [], planOptionalActions = [] } = {}) {
  const standard = confirmedActionIds || (prevGrant?.standardActions ?? prevGrant?.allowedActions ?? []);
  const optional = [...new Set(selectedOptionalActions)].sort();
  const sameStandard = JSON.stringify([...new Set(standard)].sort()) === JSON.stringify(prevGrant?.standardActions ?? []);
  const sameOptional = JSON.stringify(optional) === JSON.stringify(prevGrant?.optionalGrants ?? []);
  if (sameStandard && sameOptional) return { changed: false, grant: prevGrant };
  const grant = buildGrantRecord({
    project: prevGrant?.project, repo: prevGrant?.repo, mergeStrategy: prevGrant?.mergeStrategy, planDigest: prevGrant?.planDigest,
    confirmedActionIds: standard, selectedOptionalActions: optional, planOptionalActions, revision: (prevGrant?.revision ?? 1) + 1,
  });
  return { changed: true, grant, reason: 'SCOPE_EXPANDED' };
}

const DONE_OUTCOMES = new Set(['done', 'accepted', 'merged']);
const FAIL_OUTCOMES = new Set(['rework', 'failed']);
const RECEIPT_STRING_FIELDS = ['advanceId', 'runId', 'nodeId', 'role'];

function detailMalformed(detail) {
  if (detail === undefined || detail === null) return false;
  if (typeof detail !== 'object' || Array.isArray(detail)) return true;
  return Object.values(detail).some(value => {
    if (value === null) return false;
    const type = typeof value;
    return !(type === 'string' || type === 'number' || type === 'boolean' || Array.isArray(value));
  });
}

// advance 回执判定（纯函数）：逐字校验 advanceId、runId/nodeId/role、generation/attempt 与 detail 形态。
export function evaluateAdvance(run, receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { verdict: 'invalid', reason: 'receipt-type', failureCounted: true };
  }
  for (const field of RECEIPT_STRING_FIELDS) {
    if (typeof receipt[field] !== 'string' || !receipt[field].trim()) {
      return { verdict: 'invalid', reason: `receipt-field:${field}`, failureCounted: true };
    }
  }
  if (!Number.isInteger(receipt.generation) || !Number.isInteger(receipt.attempt)) {
    return { verdict: 'invalid', reason: 'receipt-field:generation/attempt', failureCounted: true };
  }
  if (isTerminal(run.status)) {
    // done 后没有合法 advance 通道：任何回执按一次失败尝试计数；其余终态（cancelled/abandoned/
    // blocked_unknown）的晚到回执作废但不再计数——失败已在进入终态时计过。
    return run.status === 'done'
      ? { verdict: 'invalid', reason: 'no-expected-advance', failureCounted: true }
      : { verdict: 'stale', reason: 'terminal-run', failureCounted: false };
  }
  if (receipt.runId !== run.runId || receipt.nodeId !== run.nodeId || receipt.role !== run.role) {
    return { verdict: 'invalid', reason: 'id-mismatch', failureCounted: true };
  }
  // 回执必须逐字一致；期望 id 缺失（未派发/已消费）或伪造一律无效并计失败。
  if (!run.expectedAdvanceId || receipt.advanceId !== run.expectedAdvanceId) {
    return { verdict: 'invalid', reason: 'advance-id-mismatch', failureCounted: true };
  }
  // 换打法后旧 run 晚到回执因 attempt/generation 不符作废，不重复计数。
  if (receipt.generation !== run.generation || receipt.attempt !== run.attempt) {
    return { verdict: 'stale', reason: 'attempt-mismatch', failureCounted: false };
  }
  if (typeof receipt.outcome !== 'string' || (!DONE_OUTCOMES.has(receipt.outcome) && !FAIL_OUTCOMES.has(receipt.outcome))) {
    return { verdict: 'invalid', reason: 'malformed-outcome', failureCounted: true, nextStatus: 'blocked_unknown' };
  }
  if (detailMalformed(receipt.detail)) {
    return { verdict: 'invalid', reason: 'malformed-detail', failureCounted: true, nextStatus: 'blocked_unknown' };
  }
  return { verdict: 'apply', failureCounted: FAIL_OUTCOMES.has(receipt.outcome), nextStatus: 'done' };
}

// slot-release 判定（纯函数，fail closed）：只有 unknown，或 claimed 且 worker 离线，
// 持续超 24 小时且带进程组核实依据才允许；证据缺失一律拒绝。
export function evaluateSlotRelease(run, evidence = {}) {
  if (!evidence || typeof evidence !== 'object') return { allowed: false, reason: 'missing-evidence' };
  const now = Number.isFinite(evidence.now) ? evidence.now : Date.now();
  if (run.status === 'queued') return { allowed: false, reason: 'run-active' };
  if (run.status === 'claimed' && evidence.workerOnline !== false) return { allowed: false, reason: 'worker-online' };
  if (run.status !== 'unknown' && !(run.status === 'claimed' && evidence.workerOnline === false)) {
    return { allowed: false, reason: 'not-releaseable' };
  }
  const offlineSince = run.status === 'unknown' ? (run.unknownSince ?? evidence.offlineSince) : evidence.offlineSince;
  if (!Number.isFinite(offlineSince)) return { allowed: false, reason: 'missing-evidence' };
  if (now - offlineSince < SLOT_RELEASE_MIN_OFFLINE_MS) return { allowed: false, reason: 'within-24h-grace' };
  if (evidence.processGroupVerified !== true) return { allowed: false, reason: 'missing-verification' };
  return { allowed: true };
}

// publish 只能关闭 run.json 中登记且属于同一 runId/nodeId 的 PR（纯判定）。
// 快照 digest 不一致（被篡改）一律拒绝，fail closed。
export function snapshotIntact(snapshot) {
  return Boolean(snapshot) && typeof snapshot.digest === 'string' && snapshot.digest === snapshotDigest(snapshot);
}

export function canClosePr(run, nodeId, prUrl) {
  if (!snapshotIntact(run.authorizationSnapshot)) return { ok: false, reason: 'snapshot-digest-mismatch' };
  const pr = (run.prs || []).find(entry => entry.prUrl === prUrl);
  if (!pr || pr.nodeId !== nodeId) return { ok: false, reason: 'pr-not-registered' };
  if ((run.authorizationSnapshot?.allowedActions || []).includes('close-superseded-pr')) return { ok: true, pr };
  return { ok: false, reason: 'pr-action-not-authorized' };
}

const text = value => String(value ?? '').trim();
const iso = () => new Date().toISOString();
const newRunId = () => `dagrun-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

export class DagRunError extends Error {
  constructor(code, message) { super(message); this.name = 'DagRunError'; this.code = code; }
}

export function createRunStore({ directory } = {}) {
  if (!directory || typeof directory !== 'string') throw new DagRunError('BAD_STORE', 'createRunStore 需要注入存储目录');
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const runFile = runId => path.join(directory, `${runId}.json`);
  let tmpCounter = 0;
  // 每 run 互斥锁（仅进程内）：locked 是本进程内存 Set，只能防同一进程内的重入/并发推进，
  // 防不了跨进程竞态。跨进程一致性靠 saveRun 的原子写（tmp + rename）与 advance 的
  // expectedAdvanceId 乐观校验（回执必须逐字匹配，过期/重复回执作废）；未引入文件锁。
  const locked = new Set();
  const withRunLock = (runId, fn) => {
    if (locked.has(runId)) throw new DagRunError('RUN_LOCKED', `run ${runId} 正被另一控制器推进，请稍后重试`);
    locked.add(runId);
    try { return fn(); } finally { locked.delete(runId); }
  };

  const loadFile = file => {
    let raw;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { throw new DagRunError('CORRUPT_STATE', `run 状态文件损坏（blocked_unknown 语义）：${error.message}`); }
    if (!raw || typeof raw !== 'object' || !text(raw.runId)) throw new DagRunError('CORRUPT_STATE', 'run 状态文件损坏：缺少 runId');
    if (!snapshotIntact(raw.authorizationSnapshot)) {
      const diag = grantDiagnostic(raw.authorizationSnapshot);
      throw new DagRunError('CORRUPT_STATE', `run ${raw.runId} 授权快照 digest 校验失败（${diag.reason}）：${diag.message}`);
    }
    return raw;
  };
  const getRun = runId => loadFile(runFile(text(runId)));
  const saveRun = run => {
    const target = runFile(run.runId);
    const tmp = path.join(directory, `.${run.runId}.json.tmp-${process.pid}-${tmpCounter++}`);
    writeFileSync(tmp, JSON.stringify({ ...run, updatedAt: iso() }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, target);
    return getRun(run.runId);
  };
  const listRuns = () => {
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter(name => name.endsWith('.json') && !name.startsWith('.'))
      // 与 getRun 一致 fail closed：损坏文件直接抛 CORRUPT_STATE，不得让损坏 run 从槽位占用/查重中消失。
      .map(name => loadFile(path.join(directory, name)));
  };
  const nodeKey = run => `${run.project}${run.planId}${run.nodeId}:${run.role}`;
  const currentRunFor = (project, planId, nodeId, role) => {
    const candidates = listRuns().filter(run => run.project === project && run.planId === planId && run.nodeId === nodeId && run.role === role);
    if (!candidates.length) return null;
    return candidates.reduce((best, run) => (run.generation > best.generation || (run.generation === best.generation && run.attempt > best.attempt)) ? run : best);
  };

  const validateCreateInput = input => {
    if (!input || typeof input !== 'object') throw new DagRunError('BAD_INPUT', '创建 run 需要输入对象');
    if (input.confirm !== true) throw new DagRunError('CONFIRM_REQUIRED', '创建 run 必须 confirm=true（执行授权以确认页为准）');
    for (const field of ['project', 'planId', 'planDigest', 'nodeId']) {
      if (!text(input[field])) throw new DagRunError('BAD_INPUT', `创建 run 缺少 ${field}`);
    }
    if (!['dev', 'review'].includes(input.role)) throw new DagRunError('BAD_INPUT', `role 必须是 dev/review：${input.role}`);
    const ids = input.confirmedActionIds;
    if (!Array.isArray(ids) || !ids.length) throw new DagRunError('BAD_INPUT', 'confirmedActionIds 至少确认一个授权动作');
    for (const id of ids) {
      if (typeof id !== 'string' || !text(id)) throw new DagRunError('BAD_INPUT', '授权动作必须是字符串');
      if (HIGH_RISK_ACTIONS.includes(id)) {
        throw new DagRunError('ACTION_DENIED', `授权动作 "${id}" 是高风险动作，须经计划声明并单独勾选，不能混入标准动作`);
      }
      if (!ALLOWED_ACTIONS.includes(id)) throw new DagRunError('ACTION_NOT_ALLOWED', `授权动作 "${id}" 不在白名单，整体拒绝`);
    }
  };

  const store = {
    directory,
    getRun,
    listRuns,

    slotUsage(project) {
      return listRuns().filter(run => run.project === project && run.slot != null && !isTerminal(run.status)).length;
    },

    createRun(rawInput) {
      validateCreateInput(rawInput);
      // 入口先归一 project/planId：查重、落盘、快照共用同一归一值，避免带空白输入绕过 CONFLICT。
      const input = { ...rawInput, project: text(rawInput.project), planId: text(rawInput.planId) };
      // 活跃 run 查重键为纯 project 级（设计文档「每项目最多一个活跃 DAG」）：同项目存在任何
      // 非终态 run 即拒绝创建，与 planId 是否相同无关；DAG 内并行/重派走 createAttempt，不受此限。
      const active = listRuns().find(run => run.project === input.project && !isTerminal(run.status));
      if (active) throw new DagRunError('CONFLICT', `项目 ${input.project} 已存在活跃 run ${active.runId}（planId ${active.planId}，状态 ${active.status}），每项目最多一个活跃 DAG，409`);
      const snapshot = buildGrantRecord({ ...input, planOptionalActions: input.planOptionalActions ?? input.selectedOptionalActions ?? [] });
      return saveRun({
        schema: GRANT_SCHEMA, runId: newRunId(), project: text(input.project), planId: text(input.planId),
        planDigest: text(input.planDigest), nodeId: text(input.nodeId), role: input.role,
        generation: 1, attempt: 1, status: 'queued', slot: null, expectedAdvanceId: null,
        failures: 0, outcome: null, prs: [], appliedAdvance: null, supersededBy: null,
        unknownSince: null, quarantine: false, nodes: Array.isArray(input.nodes) ? input.nodes : [],
        authorizationSnapshot: snapshot, designBaseline: input.designBaseline ? JSON.parse(JSON.stringify(input.designBaseline)) : null, remoteUrl: text(input.remoteUrl) || null, createdAt: iso(), updatedAt: iso(),
      });
    },

    claim(runId, { slot, expectedAdvanceId } = {}) {
      return withRunLock(runId, () => {
        const run = getRun(runId);
        if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) {
          throw new DagRunError('BAD_SLOT', `槽位必须是 1-${MAX_SLOTS} 的整数：${slot}`);
        }
        if (run.status === 'claimed' && run.slot === slot) return run; // 重复 claim 幂等
        const moved = transition(run, 'claimed');
        const holder = listRuns().find(other => other.project === run.project && other.slot === slot && !isTerminal(other.status));
        if (holder) throw new DagRunError('SLOT_UNAVAILABLE', `槽位 ${slot} 已被活跃 run ${holder.runId} 占用（每 DAG 开发与审阅合计最多 ${MAX_SLOTS} 路）`);
        return saveRun({
          ...moved, slot,
          expectedAdvanceId: expectedAdvanceId || `${run.runId}:${run.nodeId}:${run.role}:${run.generation}:${run.attempt}`,
        });
      });
    },

    markUnknown(runId, { at } = {}) {
      return withRunLock(runId, () => {
        const run = getRun(runId);
        // 只在首次进入 unknown 时记 unknownSince，重复调用不刷新（观察期从首次起算）。
        if (run.status === 'unknown' && Number.isFinite(run.unknownSince)) return run;
        if (run.status === 'unknown') return saveRun({ ...run, unknownSince: Number.isFinite(at) ? at : Date.now() });
        return saveRun({ ...transition(run, 'unknown'), unknownSince: Number.isFinite(at) ? at : Date.now() });
      });
    },

    quarantineSlot(runId, { now } = {}) {
      return withRunLock(runId, () => {
        const run = getRun(runId);
        if (run.status !== 'unknown') throw new DagRunError('NOT_UNKNOWN', `仅 unknown run 可隔离槽位，当前状态 ${run.status}`);
        if (!Number.isFinite(run.unknownSince)) throw new DagRunError('MISSING_EVIDENCE', 'unknownSince 证据缺失，fail closed 不隔离');
        const at = Number.isFinite(now) ? now : Date.now();
        if (at - run.unknownSince < QUARANTINE_AFTER_MS) throw new DagRunError('WITHIN_GRACE', `unknown 未满 15 分钟观察期，不隔离槽位`);
        return saveRun({ ...run, quarantine: true });
      });
    },

    evaluateSlotRelease: (run, evidence) => evaluateSlotRelease(run, evidence),

    releaseSlot(runId, evidence = {}) {
      return withRunLock(runId, () => {
        const run = getRun(runId);
        const decision = evaluateSlotRelease(run, evidence);
        if (!decision.allowed) throw new DagRunError('RELEASE_DENIED', `slot-release 被拒绝：${decision.reason}（fail closed）`);
        // claimed 且 worker 离线（已通过 evaluateSlotRelease）直接 abandoned；unknown 走常规迁移表。
        const released = run.status === 'claimed' ? { ...run, status: 'abandoned', updatedAt: iso() } : transition(run, 'abandoned');
        return saveRun({ ...released, quarantine: false, unknownSince: null });
      });
    },

    cancel(runId, { reason } = {}) {
      return withRunLock(runId, () => {
        const run = getRun(runId);
        const moved = transition(run, 'cancelled'); // unknown 不可取消：迁移表直接报错
        // cancelled 计一次失败；但同一 run 因 attempts=3 换打法而取消时，失败已逐次计过，不重复计数。
        const failures = run.failures + (reason === 'attempts-exhausted' ? 0 : 1);
        return saveRun({ ...moved, failures, cancelReason: reason ?? null });
      });
    },

    createAttempt(prevRunId, { reason } = {}) {
      return withRunLock(prevRunId, () => {
        const prev = getRun(prevRunId);
        const current = currentRunFor(prev.project, prev.planId, prev.nodeId, prev.role);
        if (current && current.runId !== prev.runId) {
          throw new DagRunError('STALE_RUN', `节点 ${prev.nodeId}:${prev.role} 已有更新的 run ${current.runId}，旧 run 不得再派生 attempt`);
        }
        // 已被用户/控制器取消的 run 不得再派生活跃 attempt；仅 attempts-exhausted 取消（换打法路径）可继续。
        if (prev.status === 'cancelled' && prev.cancelReason !== 'attempts-exhausted') {
          throw new DagRunError('RUN_CANCELLED', `run ${prev.runId} 已取消（${prev.cancelReason ?? '无原因'}），不得再派生 attempt`);
        }
        // 2026-11-16 b7 教训入契约：blocked_unknown 复活必须注明原因。done 在此状态机语义是
        // 「本轮回合结束」（rework 回执同样落 done 并由调度方 createAttempt 重派），不得拦截；
        // abandoned 维持既有「不拦截、由调度方判断」口径。blocked_unknown 是唯一异常终态，
        // 无原因的静默复活会重演旧串行链「blocked 贴纸没人撕」的交接缺口。
        if (prev.status === 'blocked_unknown' && !['blocked-resolved', 'change-approach'].includes(reason)) {
          throw new DagRunError('REVIVE_REASON_REQUIRED', 'blocked_unknown run 复活必须注明原因：blocked-resolved（阻塞证据已消失，同打法重试）或 change-approach（换打法）');
        }
        // R10 契约：同一任务累计满 3 次（attempt >= MAX_ATTEMPTS）必须换打法。
        const needNewGeneration = prev.attempt >= MAX_ATTEMPTS;
        if (needNewGeneration && reason !== 'change-approach') {
          throw new DagRunError('CHANGE_APPROACH_REQUIRED', `同一任务累计已满 ${MAX_ATTEMPTS} 次，必须换打法（change-approach：换模型/换 Agent/拆小任务）再重派`);
        }
        const generation = needNewGeneration ? prev.generation + 1 : prev.generation;
        if (generation > MAX_GENERATION) throw new DagRunError('GENERATION_LIMIT', `generation 超过上限 ${MAX_GENERATION}，节点转 gate`);
        const attempt = needNewGeneration ? 1 : prev.attempt + 1;
        return saveRun({
          schema: 1, runId: newRunId(), project: prev.project, planId: prev.planId,
          planDigest: prev.planDigest, nodeId: prev.nodeId, role: prev.role,
          generation, attempt, status: 'queued', slot: null, expectedAdvanceId: null,
          failures: 0, outcome: null, prs: [], appliedAdvance: null, supersededBy: null,
          unknownSince: null, quarantine: false, nodes: prev.nodes,
          authorizationSnapshot: prev.authorizationSnapshot, designBaseline: prev.designBaseline || null, remoteUrl: prev.remoteUrl || null,
          supersedes: prev.runId, attemptReason: reason ?? null,
          revivedFrom: ['blocked_unknown'].includes(prev.status) ? prev.runId : null,
          reviveReason: ['blocked_unknown'].includes(prev.status) ? (reason ?? null) : null,
          createdAt: iso(), updatedAt: iso(),
        });
      });
    },

    advance(runId, receipt) {
      return withRunLock(runId, () => {
        const run = getRun(runId);
        // 重复 advance 幂等：同 id 重放返回相同结果，不重复计数。口径：仅成功回执（apply）会写入
        // appliedAdvance，因此只有成功回执的重放返回 duplicate；失败/无效回执重放因 expectedAdvanceId
        // 已不匹配或 run 已终态，按 stale/invalid 处理，不会二次生效（invalid 的失败计数每次回执计一次）。
        if (run.appliedAdvance && receipt && typeof receipt === 'object' && receipt.advanceId === run.appliedAdvance.advanceId) {
          return { verdict: 'duplicate', failures: run.failures, result: run.appliedAdvance.result };
        }
        const current = currentRunFor(run.project, run.planId, run.nodeId, run.role);
        if (current && current.runId !== run.runId) {
          return { verdict: 'stale', reason: 'superseded-run', failures: run.failures };
        }
        const decision = evaluateAdvance(run, receipt);
        const next = { ...run };
        if (decision.failureCounted) next.failures = run.failures + 1;
        if (decision.verdict === 'apply') {
          next.status = 'done';
          next.outcome = receipt.outcome;
          next.expectedAdvanceId = null;
          next.appliedAdvance = {
            advanceId: receipt.advanceId,
            result: { outcome: receipt.outcome, detail: receipt.detail ?? {}, receivedAt: iso() },
          };
        } else if (decision.nextStatus) {
          next.status = decision.nextStatus;
          next.expectedAdvanceId = null;
        }
        const saved = saveRun(next);
        return { verdict: decision.verdict, reason: decision.reason, failureCounted: decision.failureCounted, failures: saved.failures, result: next.appliedAdvance?.result };
      });
    },

    // 控制器为同一 DAG 的其他节点派生 run：继承根 run 的授权快照，不受“每项目一个活跃 DAG”限制。
    createNodeRun(rootRunId, { nodeId, role } = {}) {
      const root = getRun(rootRunId);
      if (!text(nodeId)) throw new DagRunError('BAD_INPUT', '缺少 nodeId');
      if (!['dev', 'review'].includes(role)) throw new DagRunError('BAD_INPUT', `role 必须是 dev/review：${role}`);
      if (currentRunFor(root.project, root.planId, nodeId, role)) throw new DagRunError('NODE_EXISTS', `节点 ${nodeId}:${role} 的 run 已存在`);
      return saveRun({
        schema: 1, runId: newRunId(), project: root.project, planId: root.planId,
        planDigest: root.planDigest, nodeId, role, generation: 1, attempt: 1, status: 'queued',
        slot: null, expectedAdvanceId: null, failures: 0, outcome: null, prs: [], appliedAdvance: null,
        supersededBy: null, unknownSince: null, quarantine: false, nodes: root.nodes,
        authorizationSnapshot: root.authorizationSnapshot, designBaseline: root.designBaseline || null, remoteUrl: root.remoteUrl || null, rootRunId: root.rootRunId || root.runId,
        createdAt: iso(), updatedAt: iso(),
      });
    },

    // 只允许写 publish 子对象（提交/测试/PR/WIP 引用等运行记录），状态与授权字段不可经此修改。
    updateRun(runId, patch = {}) {
      return withRunLock(runId, () => {
        const bad = Object.keys(patch).filter(key => !['publish', 'hub'].includes(key));
        if (bad.length) throw new DagRunError('FIELD_NOT_ALLOWED', `updateRun 不允许修改字段：${bad.join(',')}`);
        const run = getRun(runId);
        return saveRun({ ...run, publish: { ...(run.publish || {}), ...(patch.publish || {}) }, hub: { ...(run.hub || {}), ...(patch.hub || {}) } });
      });
    },

    // 根 run（DAG 本身）终结：不走节点迁移表，仅允许 done/cancelled，且只作用于根 run。
    finishRoot(runId, status) {
      return withRunLock(runId, () => {
        const run = getRun(runId);
        if (run.nodeId !== ROOT_NODE) throw new DagRunError('NOT_ROOT', `${runId} 不是 DAG 根 run`);
        if (!['done', 'cancelled'].includes(status)) throw new DagRunError('BAD_INPUT', `根 run 只能终结为 done/cancelled：${status}`);
        if (isTerminal(run.status)) return run;
        return saveRun({ ...run, status });
      });
    },

    markPrMerged(runId, prUrl, { mergeCommit } = {}) {
      return withRunLock(runId, () => {
        const run = getRun(runId);
        const pr = (run.prs || []).find(entry => entry.prUrl === prUrl);
        if (!pr) throw new DagRunError('PR_NOT_REGISTERED', `PR ${prUrl} 未登记`);
        if (pr.state === 'merged') return pr;
        const prs = run.prs.map(entry => entry.prUrl === prUrl ? { ...entry, state: 'merged', mergeCommit: mergeCommit ?? null, mergedAt: iso() } : entry);
        return saveRun({ ...run, prs }).prs.find(entry => entry.prUrl === prUrl);
      });
    },

    registerPr(runId, nodeId, prUrl) {
      return withRunLock(runId, () => {
        const run = getRun(runId);
        if (!text(prUrl)) throw new DagRunError('BAD_INPUT', 'prUrl 不能为空');
        const existing = (run.prs || []).find(entry => entry.prUrl === prUrl);
        if (existing) return existing; // 幂等登记
        const pr = { prUrl, nodeId, state: 'open', registeredAt: iso() };
        return saveRun({ ...run, prs: [...(run.prs || []), pr] }).prs.find(entry => entry.prUrl === prUrl);
      });
    },

    // 授权记录摘要不一致的可诊断重建：仅当 schema2 字段结构完整才重算 digest（剥离越权写入），
    // 重写 run.json 后恢复可读写，不永久砖化 DAG。结构损坏的记录拒绝重建（fail closed）。
    rebuildGrant(runId) {
      return withRunLock(runId, () => {
        const target = runFile(text(runId));
        let raw;
        try { raw = JSON.parse(readFileSync(target, 'utf8')); }
        catch (error) { throw new DagRunError('CORRUPT_STATE', `run 状态文件损坏，无法重建：${error.message}`); }
        const diag = grantDiagnostic(raw.authorizationSnapshot);
        if (diag.intact) return { rebuilt: false, authorizationSnapshot: raw.authorizationSnapshot };
        if (!diag.repairable) throw new DagRunError('GRANT_UNREPAIRABLE', diag.message);
        const grant = raw.authorizationSnapshot;
        const standardActions = [...new Set(grant.standardActions)].sort();
        const optionalGrants = [...new Set(grant.optionalGrants)].filter(a => HIGH_RISK_ACTIONS.includes(a)).sort();
        const allowedActions = [...new Set([...standardActions, ...optionalGrants])].sort();
        const rebuilt = { ...grant, standardActions, optionalGrants, allowedActions, revision: grant.revision ?? 1 };
        delete rebuilt.digest;
        rebuilt.digest = snapshotDigest(rebuilt);
        const saved = saveRun({ ...raw, authorizationSnapshot: rebuilt });
        return { rebuilt: true, authorizationSnapshot: saved.authorizationSnapshot };
      });
    },

    publishClosePr(runId, nodeId, prUrl, { supersededBy } = {}) {
      return withRunLock(runId, () => {
        const run = getRun(runId);
        const check = canClosePr(run, nodeId, prUrl);
        if (!check.ok) {
          const code = check.reason === 'pr-not-registered' ? 'PR_NOT_REGISTERED' : 'PR_ACTION_NOT_AUTHORIZED';
          const message = check.reason === 'pr-not-registered'
            ? `PR ${prUrl} 未在 run.json 登记或不属于 runId/nodeId，publish 一律拒绝外链 PR`
            : '快照未授权 close-superseded-pr 动作，publish 不得关闭 PR';
          throw new DagRunError(code, message);
        }
        if (check.pr.state === 'closed') return check.pr; // 重复关闭幂等
        const prs = run.prs.map(entry => entry.prUrl === prUrl
          ? {
              ...entry, state: 'closed',
              closedNote: supersededBy ? `superseded-by ${supersededBy}` : 'closed-by-publish',
              supersededBy: supersededBy ?? null, closedAt: iso(),
            }
          : entry);
        return saveRun({ ...run, prs }).prs.find(entry => entry.prUrl === prUrl);
      });
    },
  };
  return store;
}
