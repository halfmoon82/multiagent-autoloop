// 控制台 DAG 服务：创建/列表/详情/取消/slot-release。服务端生成授权快照；证据缺失 fail closed。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ALLOWED_ACTIONS, DENIED_ACTIONS, MAX_SLOTS, ROOT_NODE, createRunStore, isTerminal } from './dag-run.mjs';
import { reviveNode } from './dag-controller.mjs';
import { seg } from './dag-slots.mjs';
import { parallelShape } from './dag.mjs';
import { checkCapabilities, checkInitialization } from './vibe-adapter.mjs';
import { createPlanDigest, loadVibePlan } from './vibe-plan.mjs';

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
    preview(project, planId) {
      let loaded;
      try { loaded = loadVibePlan({ projectRoot: project, planId: String(planId || '') }); }
      catch (error) { throw new DagServiceError(`无法加载计划：${error.message}`); }
      const shape = parallelShape(loaded.nodes);
      const waveOf = new Map();
      (shape.parallelWaves || []).forEach((wave, index) => wave.forEach(id => waveOf.set(id, index + 1)));
      const lastWave = (shape.parallelWaves || []).length + 1;
      return {
        project, planId: loaded.planId,
        planDigest: createPlanDigest({ ...loaded, authorizationSnapshot: null }),
        title: String(loaded.plan.title || loaded.plan.name || loaded.planId),
        maxParallel: MAX_SLOTS, mergeStrategy: 'squash',
        nodes: loaded.nodes.map(node => ({
          id: node.id, title: String(node.title || node.id), dependsOn: [...(node.depends_on || [])],
          files: node.id === 'integration-review' || node.integration_review ? [] : [...(node.contract?.files || [])],
          wave: waveOf.get(node.id) ?? lastWave, integrationReview: node.id === 'integration-review' || Boolean(node.integration_review),
        })),
        allowedActions: [...ALLOWED_ACTIONS], deniedActions: [...DENIED_ACTIONS],
      };
    },
    // 接入预检：只读，如实返回；能力记录必须由真实 Codex 会话 vibe attest 留下，这里不代写。
    preflight(project) {
      const checks = [];
      const init = checkInitialization({ projectRoot: project });
      checks.push({ id: 'initialized', label: '规划环境已初始化', ok: init.ok, message: init.ok ? '.vibe/state.json 存在' : init.error.message });
      const caps = checkCapabilities({ projectRoot: project, now: now() });
      checks.push({ id: 'capabilities', label: 'Codex 能力记录', ok: caps.ok, message: caps.ok ? '能力记录有效' : `${caps.error.message}。${caps.error.remediation || ''}` });
      return { project, checks };
    },
    create(body, project) {
      let loaded;
      try { loaded = loadVibePlan({ projectRoot: project, planId: String(body.planId || '') }); }
      catch (error) { throw new DagServiceError(`无法加载计划：${error.message}`); }
      if (createPlanDigest({ ...loaded, authorizationSnapshot: null }) !== body.planDigest) throw new DagServiceError('planDigest 与服务端计划不一致，计划已变化需重新确认');
      return wrap(() => store.createRun({
        project, planId: loaded.planId, planDigest: body.planDigest, confirmedActionIds: body.confirmedActionIds,
        confirm: body.confirm, nodeId: ROOT_NODE, role: 'dev', nodes: loaded.nodes,
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
