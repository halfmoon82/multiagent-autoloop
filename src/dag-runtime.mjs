// DAG 生产装配（Spec §7）：把无模型控制器接到真实的槽位 worktree、Hub 事件/run 与 gh。
// 控制台不嵌套创建 ACP worker：节点工作只经 Hub 事件（dag.<slug>.<role>）派发，由 Hub 规则/worker 执行。
// 只装配、不放权：publish/merge/close 等动作仍由授权快照在 dag-publish 层逐项门禁。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createController, HUB_TERMINAL } from './dag-controller.mjs';
import { createGhAdapter } from './dag-gh.mjs';
import { acquireControllerLock } from './dag-lock.mjs';
import { createPublisher } from './dag-publish.mjs';
import { ROOT_NODE, createRunStore, isTerminal } from './dag-run.mjs';
import { createSlotRuntime, seg } from './dag-slots.mjs';
import * as wip from './dag-wip.mjs';
import { hubRequest } from './hub.mjs';

export const MIN_POLL_MS = 5000;
const HUB_STATES = new Set(['queued', 'claimed', 'unknown', 'done', 'nothing', 'cancelled']);
const msg = error => String(error?.message || error).replace(/[\r\n]+/g, ' ');

// Hub 事件类型上限 64 字符：dag.<slug>.<role>；slug 超长时稳定哈希截短。
export function dagEventType(project, role) {
  let slug = seg(path.basename(String(project)));
  const room = 64 - `dag..${role}`.length;
  if (slug.length > room) slug = `${slug.slice(0, room - 9)}-${createHash('sha1').update(slug).digest('hex').slice(0, 8)}`;
  return `dag.${slug}.${role}`;
}

// Hub 适配：hubRunId 即 Hub 事件号；事件 id 由 runId 决定，重复派发由 Hub 按 id 去重（幂等，不重复执行）。
// getRun 从事件结果推导状态：没有 run=queued；有多个 run 取最新；Hub 不可达抛错（由控制器本轮记 lastError，不改状态）。
export function createHubAdapter({ config, request = hubRequest, project } = {}) {
  const outcome = eventNo => request(config, `/v1/events/${encodeURIComponent(eventNo)}`);
  const newest = out => [...(out?.runs || [])].sort((a, b) => b.run - a.run)[0] || null;
  return {
    async dispatch({ run, slot, worktree, branch, expectedAdvanceId, model, prompt }) {
      const detail = JSON.stringify({ runId: run.runId, nodeId: run.nodeId, role: run.role, generation: run.generation, attempt: run.attempt, slot, worktree, branch, expectedAdvanceId, model: model ?? null, prompt });
      if (detail.length > 4000) throw new Error('派发事件正文超过 4000 字符，拒绝截断派发');
      const res = await request(config, '/v1/events', { method: 'POST', body: {
        id: `dag:${run.runId}`, type: dagEventType(project || run.project, run.role), subject: `dag-${seg(run.nodeId)}`,
        summary: `DAG ${run.nodeId} ${run.role} g${run.generation}a${run.attempt}`.slice(0, 200), detail,
      } });
      if (!res || !Number.isInteger(res.event)) throw new Error('Hub 未返回事件号，派发未确认');
      return { hubRunId: res.event };
    },
    async getRun(eventNo) {
      let out;
      try { out = await outcome(eventNo); }
      catch (error) { if (error?.status === 404) return { status: 'unknown' }; throw error; }
      const hubRun = newest(out);
      if (!hubRun) return { status: 'queued' };
      const status = HUB_STATES.has(hubRun.state) ? hubRun.state : 'unknown';
      const receipts = (hubRun.events || []).filter(e => /\.advance$/.test(e?.type || '')).map(e => {
        try { return JSON.parse(e.detail); } catch { return { malformed: true }; }
      });
      return { status: status === 'nothing' ? 'done' : status, receipts, hubRun: hubRun.run };
    },
    async cancel(eventNo) {
      const out = await outcome(eventNo);
      for (const hubRun of out?.runs || []) {
        if (HUB_TERMINAL.has(hubRun.state === 'nothing' ? 'done' : hubRun.state) || hubRun.state === 'unknown') continue;
        await request(config, `/v1/runs/${encodeURIComponent(hubRun.run)}/cancel`, { method: 'POST', body: {} });
      }
      return {};
    },
  };
}

const defaultRunTests = cwd => new Promise(resolve => {
  execFile('npm', ['test'], { cwd, timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
    resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, tail: String(stdout).slice(-2000) });
  });
});

// blocked 证据复查（保守）：只有“从未派发”（没有 hubRunId，阻塞源是本地）且 Hub 可达时才认为证据消失；
// 已派发后回执畸形/失联的 blocked 保持阻塞，等人或明确的 revive，不会被静默放行。
export function createBlockedEvidence({ request, config }) {
  return async ({ run }) => {
    if (run.hub?.hubRunId) return { blocked: true };
    await request(config, '/v1/state');
    return { blocked: false, detail: '从未派发，Hub 可达，自动复活' };
  };
}

export async function createDagRuntime({ rootRun, config, store, request = hubRequest, gh, runTests = defaultRunTests, git, now = Date.now, chooseApproach } = {}) {
  const rt = createSlotRuntime({ project: rootRun.project, runId: rootRun.runId, ...(git ? { git } : {}) });
  await rt.ensureSlots();
  const adapter = gh || createGhAdapter({ cwd: rootRun.project });
  const publisher = createPublisher({ store, rootRunId: rootRun.runId, rt, gh: adapter, runTests });
  const hub = createHubAdapter({ config, request, project: rootRun.project });
  return createController({ store, rootRunId: rootRun.runId, hub, rt, wip, publisher, now, chooseApproach, blockedEvidence: createBlockedEvidence({ request, config }) });
}

// 启动接线：发现全部未终结 DAG，逐个恢复控制器并以有界频率轮询。单 DAG 单写入者（进程锁 + 本进程 in-flight 守卫）。
export function startDagControllers({ config, store, directory = path.join(config.root, 'dag-runs'), intervalMs = 15000, log = console.error, build = createDagRuntime, request = hubRequest, setIntervalFn = setInterval, clearIntervalFn = clearInterval, ...rest } = {}) {
  const runStore = store || createRunStore({ directory });
  const controllers = new Map(); // rootRunId → { ctl, lock } | { pending:true }
  let inflight = null; let stopped = false;
  const every = Math.max(MIN_POLL_MS, Number(intervalMs) || MIN_POLL_MS);

  async function adopt(rootRun) {
    if (controllers.has(rootRun.runId)) return;
    controllers.set(rootRun.runId, { pending: true });
    const lock = acquireControllerLock({ directory: runStore.directory || directory, runId: rootRun.runId });
    if (!lock.acquired) { controllers.delete(rootRun.runId); return; }
    try { controllers.set(rootRun.runId, { lock, ctl: await build({ rootRun, config, store: runStore, request, ...rest }) }); }
    catch (error) { lock.release(); controllers.delete(rootRun.runId); log(`[dag] 恢复控制器失败 ${rootRun.runId}：${msg(error)}`); }
  }

  // 同一时刻只跑一轮；重叠的调用复用在途那一轮（单写入者，重复 tick 幂等）。
  const tickOnce = () => (stopped ? Promise.resolve() : (inflight ||= runOnce().finally(() => { inflight = null; })));
  async function runOnce() {
    try {
      let roots;
      try { roots = runStore.listRuns().filter(run => run.nodeId === ROOT_NODE); }
      catch (error) { log(`[dag] 读取 dag-runs 失败（fail closed，本轮不推进）：${msg(error)}`); return; }
      for (const rootRun of roots) {
        if (isTerminal(rootRun.status)) { const held = controllers.get(rootRun.runId); held?.lock?.release(); controllers.delete(rootRun.runId); continue; }
        await adopt(rootRun);
        const held = controllers.get(rootRun.runId);
        if (!held?.ctl) continue;
        try { await held.ctl.tick(); } catch (error) { log(`[dag] tick 失败 ${rootRun.runId}：${msg(error)}`); }
      }
    } catch (error) { log(`[dag] 轮询异常：${msg(error)}`); }
  }

  const timer = setIntervalFn(() => { tickOnce(); }, every);
  timer?.unref?.();
  tickOnce();
  return {
    tickOnce,
    stop() { stopped = true; clearIntervalFn(timer); for (const { lock } of controllers.values()) lock?.release(); controllers.clear(); },
  };
}
