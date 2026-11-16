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
export function snapshotDigest(snapshot) {
  const { project, repo, mergeStrategy, planDigest, allowedActions } = snapshot || {};
  return sha256(canonical({ project: project ?? null, repo: repo ?? null, mergeStrategy: mergeStrategy ?? null, planDigest: planDigest ?? null, allowedActions: allowedActions ?? [] }));
}

export function buildAuthorizationSnapshot({ project, repo, mergeStrategy, planDigest, confirmedActionIds }) {
  // 与 run 字段同口径（text() 归一），digest 数据源统一，避免带空白输入导致读取时 digest 失配。
  const allowedActions = [...new Set(confirmedActionIds)].sort();
  const snapshot = {
    schema: 1, project: text(project), repo: repo == null ? null : text(repo), mergeStrategy: text(mergeStrategy) || 'squash',
    planDigest: text(planDigest), allowedActions, createdAt: new Date().toISOString(),
  };
  return { ...snapshot, digest: snapshotDigest(snapshot) };
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

class DagRunError extends Error {
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
    if (!snapshotIntact(raw.authorizationSnapshot)) throw new DagRunError('CORRUPT_STATE', `run ${raw.runId} 授权快照 digest 校验失败（被篡改或缺失），fail closed`);
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
      if (DENIED_ACTIONS.includes(id)) {
        throw new DagRunError('ACTION_DENIED', `授权动作 "${id}" 属于永远拒绝范围（deploy/release/生产写入/凭据/对外通信），出现即整体拒绝`);
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
      const snapshot = buildAuthorizationSnapshot(input);
      return saveRun({
        schema: 1, runId: newRunId(), project: text(input.project), planId: text(input.planId),
        planDigest: text(input.planDigest), nodeId: text(input.nodeId), role: input.role,
        generation: 1, attempt: 1, status: 'queued', slot: null, expectedAdvanceId: null,
        failures: 0, outcome: null, prs: [], appliedAdvance: null, supersededBy: null,
        unknownSince: null, quarantine: false, nodes: Array.isArray(input.nodes) ? input.nodes : [],
        authorizationSnapshot: snapshot, createdAt: iso(), updatedAt: iso(),
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
        const released = transition(run, 'abandoned');
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
          authorizationSnapshot: prev.authorizationSnapshot,
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
