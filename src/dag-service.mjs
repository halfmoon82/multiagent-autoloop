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

// 计划可选高风险动作：优先用计划显式声明的 optionalHighRiskActions，未声明时不开放任何高风险动作（默认关闭）。
// 每项附产品语言的 title/benefit/cost 与 selectedByDefault=false，供授权确认页逐项呈现。
function optionalActionOptions(loaded) {
  const declared = loaded.optionalHighRiskActions ?? loaded.plan?.optionalHighRiskActions ?? [];
  const pool = HIGH_RISK_ACTIONS.filter(id => declared.includes(id));
  return pool.map(id => ({ id, ...HIGH_RISK_ACTION_INFO[id], selectedByDefault: false }));
}

// 节点记录只存 Hub 轮次号（hubRun）。/v1/state 首页只含最近 ~60 轮：已完成节点的轮次早已翻出首页，
// 只读首页就会让这些节点丢执行 Agent / Token / 模型。按缺失的轮次号用 ?before=<id+1> 定向取回
// （中台 runs 只增不删），去重复用同一页、每次请求限页数，取不到的保持缺失、界面如实写未上报。
export const HUB_RUN_LOOKUP_MAX_PAGES = 12;
export async function collectHubRuns(fetchState, wantedIds, { maxPages = HUB_RUN_LOOKUP_MAX_PAGES } = {}) {
  const byId = new Map();
  const absorb = state => { for (const run of Array.isArray(state?.runs) ? state.runs : []) { const id = Number(run?.id); if (Number.isInteger(id) && !byId.has(id)) byId.set(id, run); } };
  const missing = () => [...new Set(wantedIds)].filter(id => Number.isInteger(id) && !byId.has(id)).sort((a, b) => b - a);
  let pages = 0;
  try { absorb(await fetchState(null)); pages += 1; } catch { return [...byId.values()]; }   // Hub 不可达：原样返回，不让详情页 502
  while (pages < maxPages) {
    const need = missing();
    if (!need.length) break;
    // 最新的缺失轮次优先：一页覆盖其前约 60 轮，同页内的更老轮次顺带取回。
    let state;
    try { state = await fetchState(need[0] + 1); } catch { break; }
    pages += 1;
    const before = byId.size;
    absorb(state);
    if (byId.size === before && !byId.has(need[0])) { byId.set(need[0], null); }   // 该轮次不存在：占位避免死循环，不入结果
  }
  return [...byId.values()].filter(Boolean);
}

// hubRunsById：/v1/state 的 runs（按 Hub 轮次号）。节点记录只存轮次号，执行 Agent 与自报 Token/费用
// 只在 Hub 轮次上；按轮次号补到节点记录上供界面显示。查不到（翻页外、Hub 不可达）保持原样，界面如实写未上报。
// models：{ [执行者 id]: 模型 }——每个执行者自己的模型（分档执行者命令里带 --model），缺失才退回宿主默认标签。
// 通道分两类如实标注，避免把终态当成暂时缺数据：
// - UNREPORTABLE_USAGE_ADAPTERS：跑模型但协议不带用量（acp）。2026-11-19 实测：workbuddy 的 ACP 协议帧无用量
//   字段，但 --print stream-json 模式每条消息都带 usage_update（input/output/cache tokens + credits）——
//   数据在进程内部，ACP 桥接层丢了。上游 plugins/acp/bridge.ts 补上后可从集合移除 acp。仅对 workbuddy 宿主
//   实测过，其他 ACP 宿主未逐一验证（宁保守）。界面写「该执行者不上报用量」。
// - NO_MODEL_ADAPTERS：不跑模型的通道（command/delivery/desktop/dsh/feishu/github/gitlab/webhook），
//   与 platform-models.mjs NON_AI_USES 同口径。界面写「不需要模型」。前端 status-sections.mjs 有一份
//   同集合，改动时两边同步。
export const UNREPORTABLE_USAGE_ADAPTERS = new Set(['acp']);
export const NO_MODEL_ADAPTERS = new Set(['command', 'delivery', 'desktop', 'dsh', 'feishu', 'github', 'gitlab', 'webhook']);
export function withHubUsage(detail, hubRuns = [], models = {}, adapters = {}) {
  const byId = new Map((Array.isArray(hubRuns) ? hubRuns : []).map(item => [Number(item?.id), item]));
  return {
    ...detail,
    nodeRuns: (detail?.nodeRuns || []).map(nodeRun => {
      const hubRun = Number.isInteger(nodeRun?.hub?.hubRun) ? byId.get(nodeRun.hub.hubRun) : null;
      const agent = String(hubRun?.agent || '').trim();
      if (!agent) return nodeRun;
      const usage = hubRun.usage && typeof hubRun.usage === 'object' && !Array.isArray(hubRun.usage) ? hubRun.usage : null;
      const adapter = String(adapters[agent] || '');
      const unreportable = !usage && UNREPORTABLE_USAGE_ADAPTERS.has(adapter);
      const noModel = !usage && !unreportable && NO_MODEL_ADAPTERS.has(adapter);
      return { ...nodeRun, agent, model: models[agent] || '未配置', ...(usage ? { usage } : {}), ...(unreportable ? { usageUnreportable: true } : {}), ...(noModel ? { usageNoModel: true } : {}) };
    }),
  };
}

// 移动端只读摘要（Spec §8.2）：从根 run 真实字段投影项目 DAG 进度与执行授权范围。
// 只读、不重算 digest、不改写 schema 1/2 授权快照；缺失字段留 null/空数组，不编造进度、模型或费用。
// 旧 run 的 schema 1 授权记录一律原样读取，避免任何摘要公式变动影响既有 run。
export function mobileDagSummaries(runs = []) {
  const list = Array.isArray(runs) ? runs : [];
  return list.map(run => {
    const raw = run && typeof run === 'object' && !Array.isArray(run) ? run : {};
    const grant = raw.authorizationSnapshot && typeof raw.authorizationSnapshot === 'object' && !Array.isArray(raw.authorizationSnapshot)
      ? raw.authorizationSnapshot : null;
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    const runId = String(raw.runId ?? '').trim();
    if (!runId) return null;
    return {
      runId,
      project: String(raw.project ?? '').trim() || null,
      planId: String(raw.planId ?? '').trim() || null,
      status: String(raw.status ?? '').trim() || null,
      createdAt: String(raw.createdAt ?? '').trim() || null,
      remoteUrl: String(raw.remoteUrl ?? grant?.remoteUrl ?? '').trim() || null,
      nodeCount: nodes.length,
      files: [...new Set(nodes.flatMap(node => (Array.isArray(node?.contract?.files) ? node.contract.files.map(String) : [])))],
      planDigest: String(grant?.planDigest ?? raw.planDigest ?? '').trim() || null,
      allowedActions: Array.isArray(grant?.allowedActions) ? [...grant.allowedActions].map(String).sort() : [],
      deniedActions: [...DENIED_ACTIONS],
      authorizationPresent: Boolean(grant),
    };
  }).filter(Boolean);
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
    list: () => {
      const runs = store.listRuns().filter(run => run.nodeId === ROOT_NODE);
      const summaries = new Map(mobileDagSummaries(runs).map(summary => [summary.runId, summary]));
      return runs.map(run => ({ ...run, mobileSummary: summaries.get(String(run.runId)) || null }));
    },
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
        confirm: body.confirm, nodeId: ROOT_NODE, role: 'dev', nodes: loaded.nodes, designBaseline: loaded.designBaseline || null, remoteUrl: mirror?.remoteUrl ?? remoteUrl, mirrorPath: mirror?.mirrorPath ?? null, baseBranch: mirror?.baseBranch ?? null, baseCommit: mirror?.baseCommit ?? null,
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
