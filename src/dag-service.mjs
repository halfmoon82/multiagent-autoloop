// 控制台 DAG 服务：创建/列表/详情/取消/slot-release。服务端生成授权快照；证据缺失 fail closed。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_SLOTS, ROOT_NODE, createRunStore, isTerminal } from './dag-run.mjs';
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
export function createDagService({ root, store: injected, storeDirectory, hubEvidence = async () => ({}), now = Date.now } = {}) {
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
      // 审计命令文件先落盘再释放：控制器据此把 Hub run 标 abandoned。
      const dir = path.join(root, 'dag-commands'); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${now()}-${holder.runId}-slot-${slot}.json`), JSON.stringify({
        command: 'slot-release', rootRunId: id, runId: holder.runId, slot, evidence, note: String(body.note || '').slice(0, 500), at: new Date(now()).toISOString(),
      }, null, 2));
      return wrap(() => store.releaseSlot(holder.runId, evidence));
    },
  };
}
