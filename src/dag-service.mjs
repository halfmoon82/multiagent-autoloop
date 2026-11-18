// 控制台 DAG 服务：创建/列表/详情/取消/slot-release。服务端生成授权快照；证据缺失 fail closed。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ALLOWED_ACTIONS, DENIED_ACTIONS, HIGH_RISK_ACTIONS, HIGH_RISK_ACTION_INFO, MAX_SLOTS, ROOT_NODE, createRunStore, isTerminal } from './dag-run.mjs';
import { reviveNode } from './dag-controller.mjs';
import { seg } from './dag-slots.mjs';
import { parallelShape } from './dag.mjs';
import { loadNativePlan } from './dag-plan.mjs';
import { checkCapabilities, checkInitialization } from './vibe-adapter.mjs';
import { createPlanDigest, loadVibePlan } from './vibe-plan.mjs';
import { defaultGit } from './git-safe.mjs';
import { ensureMirror } from './dag-mirror.mjs';

export class DagServiceError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'DagServiceError'; this.status = status; }
}
const CODE_STATUS = { CONFLICT: 409, RELEASE_DENIED: 409, CORRUPT_STATE: 500 };
const wrap = fn => { try { return fn(); } catch (error) {
  if (error instanceof DagServiceError) throw error;
  if (error?.name === 'DagRunError') throw new DagServiceError(error.message, CODE_STATUS[error.code] || (error.code === 'ENOENT' ? 404 : 400));
  if (error?.code === 'ENOENT') throw new DagServiceError('run 不存在', 404);
  throw error;
}; };

// 计划加载：原生 plans 目录优先，旧 vibe 计划作为兼容回退；两者都失败时给可读错误。
// 原生失败不写盘、不要求 .vibe，失败原因只在回退也失败时才暴露。
function loadPlan(project, planId) {
  try { return loadNativePlan({ projectRoot: project, planId }); }
  catch (nativeError) {
    try { return loadVibePlan({ projectRoot: project, planId }); }
    catch (vibeError) {
      throw new DagServiceError(`无法加载计划：原生（${nativeError.message}）；vibe（${vibeError.message}）`);
    }
  }
}

// 计划级共享文件（package.json 等）：每个节点都可改。挂在 contract.sharedFiles 而不是 files，
// 这样节点间的写范围校验仍按各自目录判定；publish 的范围校验单独把 sharedFiles 算进来。
function withSharedFiles(nodes, shared = []) {
  const extra = Array.isArray(shared) ? shared.filter(item => typeof item === 'string' && item.trim()) : [];
  if (!extra.length) return nodes;
  return nodes.map(node => ({
    ...node,
    contract: { ...(node.contract || {}), sharedFiles: [...extra] },
  }));
}

// 计划可选高风险动作：优先用计划显式声明的 optionalHighRiskActions，未声明时不开放任何高风险动作（默认关闭）。
// 每项附产品语言的 title/benefit/cost 与 selectedByDefault=false，供授权确认页逐项呈现。
function optionalActionOptions(loaded) {
  const declared = loaded.optionalHighRiskActions ?? loaded.plan?.optionalHighRiskActions ?? [];
  const pool = HIGH_RISK_ACTIONS.filter(id => declared.includes(id));
  return pool.map(id => ({ id, ...HIGH_RISK_ACTION_INFO[id], selectedByDefault: false }));
}

// hubEvidence({ run }) → { workerOnline?, offlineSince? }：来自 Hub“接单程序没连上”卡片；默认无证据即 fail closed。
export function createDagService({ root, store: injected, storeDirectory, hubEvidence = async () => ({}), now = Date.now,
  log = console.error, writeAudit = (dir, name, content) => writeFileSync(path.join(dir, name), content) } = {}) {
  // 存储惰性创建：控制台启动不碰磁盘，root 不可写时只有 DAG 接口报错，不影响其它功能。
  let lazy = injected || null;
  const storeProxy = new Proxy({}, { get: (_, key) => { lazy ||= createRunStore({ directory: storeDirectory }); const value = lazy[key]; return typeof value === 'function' ? value.bind(lazy) : value; } });
  const store = storeProxy;
  const getRoot = id => {
    const run = wrap(() => store.listRuns()).find(item => item.runId === String(id));
    if (!run || run.nodeId !== ROOT_NODE) throw new DagServiceError('DAG run 不存在', 404);
    return run;
  };
  return {
    list: () => store.listRuns().filter(run => run.nodeId === ROOT_NODE),
    get(id) {
      const run = getRoot(id);
      return { run, nodeRuns: store.listRuns().filter(r => r.project === run.project && r.planId === run.planId && r.nodeId !== ROOT_NODE) };
    },
    // 授权确认页数据源：只读加载已发布计划；planDigest 与 create() 同口径，确认页直接回传。
    async preview(project, planId) {
      const loaded = loadPlan(project, String(planId || ''));
      const shape = parallelShape(loaded.nodes);
      const waveOf = new Map();
      (shape.parallelWaves || []).forEach((wave, index) => wave.forEach(id => waveOf.set(id, index + 1)));
      const lastWave = (shape.parallelWaves || []).length + 1;
      return {
        project, remoteUrl: await (async () => { try { return String(await defaultGit(project, ['remote', 'get-url', 'origin'])).trim() || null; } catch { return null; } })(), planId: loaded.planId,
        planDigest: createPlanDigest({ ...loaded, authorizationSnapshot: null }),
        title: String(loaded.plan.title || loaded.plan.name || loaded.planId),
        maxParallel: MAX_SLOTS, mergeStrategy: 'squash',
        nodes: loaded.nodes.map(node => ({
          id: node.id, title: String(node.title || node.id), dependsOn: [...(node.depends_on || [])],
          files: node.id === 'integration-review' || node.integration_review ? [] : [...(node.contract?.files || [])],
          wave: waveOf.get(node.id) ?? lastWave, integrationReview: node.id === 'integration-review' || Boolean(node.integration_review),
        })),
        allowedActions: [...ALLOWED_ACTIONS], deniedActions: [...DENIED_ACTIONS],
        optionalActions: optionalActionOptions(loaded),
      };
    },
    // 接入预检：只读，如实返回，且只检查这条计划真正会走的路径。
    // 原生计划（docs/dag-plans/<planId>.json）不读 .vibe，因此不要求规划环境或 vibe 能力记录；
    // 只有回退到 vibe 计划时才查初始化与能力记录（能力记录由真实 Codex 会话 vibe attest 留下，服务端不代写）。
    preflight(project, planId = '') {
      const checks = [];
      const id = String(planId ?? '').trim();
      if (id) {
        try {
          loadNativePlan({ projectRoot: project, planId: id });
          checks.push({ id: 'plan-source', label: '计划来源', ok: true, message: `原生计划 docs/dag-plans/${id}.json：走审批与派发，不依赖 vibe 规划环境` });
          return { project, planId: id, source: 'native', checks };
        } catch { /* 原生计划不可用：按兼容路径检查 vibe */ }
      }
      const init = checkInitialization({ projectRoot: project });
      checks.push({ id: 'initialized', label: '规划环境已初始化', ok: init.ok, message: init.ok ? '.vibe/state.json 存在' : init.error.message });
      const caps = checkCapabilities({ projectRoot: project, now: now() });
      checks.push({ id: 'capabilities', label: 'Codex 能力记录', ok: caps.ok, message: caps.ok ? '能力记录有效' : `${caps.error.message}。${caps.error.remediation || ''}` });
      return { project, planId: id || null, source: 'vibe', checks };
    },
    async create(body, project) {
      const loaded = loadPlan(project, String(body.planId || ''));
      if (createPlanDigest({ ...loaded, authorizationSnapshot: null }) !== body.planDigest) throw new DagServiceError('planDigest 与服务端计划不一致，计划已变化需重新确认');
      // 计划未声明的高风险动作即便勾选也不写入：planOptionalActions 作为授权白名单交给 store 校验。
      const planOptionalActions = optionalActionOptions(loaded).map(a => a.id);
      // run 创建时冻结用户确认的 remote URL；之后 worker 改 remote.origin.url/insteadOf 不影响 push 目标。
      let remoteUrl = String(body.remoteUrl ?? '').trim() || null;
      if (!remoteUrl) {
        try { remoteUrl = String(await defaultGit(project, ['remote', 'get-url', 'origin'])).trim() || null; }
        catch { remoteUrl = null; }
      }
      let mirror = null;
      if (remoteUrl) mirror = await ensureMirror({ root, remoteUrl, baseBranch: 'main' });
      return wrap(() => store.createRun({
        project, planId: loaded.planId, planDigest: body.planDigest, confirmedActionIds: body.confirmedActionIds,
        selectedOptionalActions: body.selectedOptionalActions ?? [], planOptionalActions,
        confirm: body.confirm, nodeId: ROOT_NODE, role: 'dev', nodes: withSharedFiles(loaded.nodes, loaded.sharedFiles), designBaseline: loaded.designBaseline || null, remoteUrl: mirror?.remoteUrl ?? remoteUrl, mirrorPath: mirror?.mirrorPath ?? null, baseBranch: mirror?.baseBranch ?? null, baseCommit: mirror?.baseCommit ?? null,
      }));
    },
    cancel(id) {
      const run = getRoot(id);
      if (isTerminal(run.status)) return run;
      return wrap(() => store.updateRun(id, { publish: { cancelRequested: true, cancelRequestedAt: new Date(now()).toISOString() } }));
    },
    // blocked 复活入口：只写节点待办（授权快照由 createAttempt 逐字继承），控制器下一 tick 执行；
    // evidence 同时写入待办与审计命令文件，便于事后核实谁、以何依据复活了哪个节点。
    revive(id, nodeId, body = {}) {
      const dagRun = getRoot(id);
      const evidence = String(body.evidence ?? body.detail ?? '').slice(0, 500);
      const result = wrap(() => reviveNode(store, dagRun, nodeId, body.reason, { evidence, at: now() }));
      const dir = path.join(root, 'dag-commands');
      try {
        mkdirSync(dir, { recursive: true });
        writeAudit(dir, `${now()}-${dagRun.runId}-revive-${seg(String(nodeId))}.json`, JSON.stringify({
          command: 'revive', rootRunId: id, nodeId: String(nodeId), reason: body.reason, evidence,
          at: new Date(now()).toISOString(),
        }, null, 2));
      } catch (error) {
        log(`[dag] revive 审计写入失败（复活待办已落盘但无审计留痕）：rootRunId=${id} nodeId=${nodeId}：${error.message}`);
      }
      return result;
    },
    async slotRelease(id, slotRaw, body = {}) {
      const rootRun = getRoot(id);
      const slot = typeof slotRaw === 'number' ? slotRaw : /^[1-9][0-9]*$/.test(String(slotRaw)) ? Number(slotRaw) : NaN;
      if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) throw new DagServiceError(`slot 只能是 1-${MAX_SLOTS}`);
      const holder = store.listRuns().find(r => r.project === rootRun.project && r.slot === slot && !isTerminal(r.status));
      if (!holder) throw new DagServiceError(`槽位 ${slot} 没有活跃 run，无需释放`, 404);
      const hub = (await hubEvidence({ run: holder })) || {};
      const evidence = { now: now(), workerOnline: hub.workerOnline, offlineSince: hub.offlineSince, processGroupVerified: body.processGroupVerified === true };
      const decision = store.evaluateSlotRelease(holder, evidence);
      if (!decision.allowed) throw new DagServiceError(`slot-release 被拒绝：${decision.reason}（fail closed）`, 409);
      // 释放成功后再写审计文件：被拒绝/失败的释放不留下“已执行”的假审计；控制器据此把 Hub run 标 abandoned。
      const released = wrap(() => store.releaseSlot(holder.runId, evidence));
      // 槽位已经释放，审计写失败（磁盘满/只读）不能把已执行动作回成 5xx——否则调用方重试会得到 404。
      // 留一行日志标出「已释放但无审计」，由运维据 runId 补核。
      const dir = path.join(root, 'dag-commands');
      try {
        mkdirSync(dir, { recursive: true });
        writeAudit(dir, `${now()}-${holder.runId}-slot-${slot}.json`, JSON.stringify({
          command: 'slot-release', rootRunId: id, runId: holder.runId, slot, evidence, note: String(body.note || '').slice(0, 500), at: new Date(now()).toISOString(),
        }, null, 2));
      } catch (error) {
        log(`[dag] slot-release 审计写入失败（槽位已释放但无审计留痕，请据 runId 补核）：rootRunId=${id} runId=${holder.runId} slot=${slot}：${error.message}`);
      }
      return released;
    },
  };
}
