// 控制器测试夹具：真实 run 存储 + 内存假 Hub/槽位/发布器，离线。
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunStore, ALLOWED_ACTIONS, ROOT_NODE } from '../src/dag-run.mjs';
import { createController } from '../src/dag-controller.mjs';

export const mkNode = (id, deps = []) => ({
  id, depends_on: deps, status: 'pending',
  contract: { input: 'i', output: 'o', error_behavior: 'e', acceptance_example: 'a', files: [`src/${id}.mjs`] },
});

export class FakeHub {
  constructor() { this.runs = new Map(); this.dispatched = []; this.cancelled = []; this.n = 0; }
  async dispatch(req) { const id = ++this.n; this.runs.set(id, { status: 'queued', workerOnline: true }); this.dispatched.push({ id, ...req }); return { hubRunId: id }; }
  async getRun(id) { return { ...(this.runs.get(id) || { status: 'unknown' }) }; }
  async cancel(id) { this.cancelled.push(id); const r = this.runs.get(id); if (r && ['queued', 'claimed'].includes(r.status)) r.status = 'cancelled'; return {}; }
  set(id, patch) { Object.assign(this.runs.get(id), patch); }
  last(nodeId, role = 'dev') { return [...this.dispatched].reverse().find(d => d.run.nodeId === nodeId && d.run.role === role); }
}

export function fakeRt(project = '/proj') {
  let state = {}; const events = [];
  return {
    project, runId: 'r', events, slotPath: slot => `${project}/.worktrees/dag-r-slot-${slot}`,
    loadState: () => JSON.parse(JSON.stringify(state)), saveState: next => { state = JSON.parse(JSON.stringify(next)); },
    // 与真实槽位运行时同一 fail-closed 复用语义：同节点复用槽位必须 base/branch 完全一致。
    async prepare(a) {
      const prev = state[a.slot];
      if (prev?.nodeId === a.nodeId && (prev.base !== a.base || prev.branch !== a.branch)) {
        const error = new Error(`槽位 ${a.slot} 状态与请求的 base/branch 不一致，拒绝复用`); error.code = 'SLOT_STATE_MISMATCH'; throw error;
      }
      state[a.slot] = { nodeId: a.nodeId, base: a.base, branch: a.branch, baseCommit: a.base };
      events.push(['prepare', a.slot, a.nodeId, a.base]);
      // 与真实运行时一致：prepare 返回解析后的冻结 base commit，控制器据此判断“槽位是否可原样重试”。
      return { ...a, reused: Boolean(prev), baseCommit: a.base };
    },
    async dirty() { return false; },
  };
}
export const fakeWip = () => { const calls = []; return { calls, async saveWip(rt, a) { calls.push(['save', a]); return `refs/dag-wip/${a.nodeId}/${a.attempt}`; }, async releaseSlotWorktree(rt, a) { calls.push(['release', a]); const state = rt.loadState(); delete state[a.slot]; rt.saveState(state); return { wipRef: `refs/dag-wip/${a.nodeId}/${a.attempt}` }; } }; };
export const fakePublisher = () => { const calls = []; return {
  calls,
  async commitPr(a) { calls.push(['commitPr', a.nodeId]); return { prUrl: `https://x/pr/${a.nodeId}`, commit: `sha-${a.nodeId}` }; },
  async verify(a) { calls.push(['verify', a.nodeId]); return { ok: true, tests: { exitCode: 0 } }; },
  async merge(a) { calls.push(['merge', a.nodeId, a.commit]); return { mergeCommit: `m-${a.nodeId}` }; },
  async baseline() { calls.push(['baseline']); return {}; },
}; };

export function setup(nodes, { chooseApproach, blockedEvidence, designBaseline = null } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'dag-ctl-'));
  const store = createRunStore({ directory });
  const root = store.createRun({ project: '/proj', planId: 'p1', planDigest: 'd', confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true, nodeId: ROOT_NODE, role: 'dev', nodes, designBaseline });
  const hub = new FakeHub(); const rt = fakeRt(); const wip = fakeWip(); const publisher = fakePublisher();
  const clock = { t: 1_000_000_000_000 };
  const ctl = createController({ store, rootRunId: root.runId, hub, rt, wip, publisher, now: () => clock.t, chooseApproach, blockedEvidence });
  const runOf = (nodeId, role = 'dev') => store.listRuns().filter(r => r.nodeId === nodeId && r.role === role).sort((a, b) => a.generation - b.generation || a.attempt - b.attempt).at(-1);
  const receipt = (nodeId, role, outcome, over = {}) => {
    const run = runOf(nodeId, role);
    if (run.hub?.hubRunId) hub.set(run.hub.hubRunId, { status: 'done' });
    return store.advance(run.runId, { advanceId: run.expectedAdvanceId, runId: run.runId, nodeId, role, generation: run.generation, attempt: run.attempt, outcome, ...over });
  };
  const claimAll = () => { for (const d of hub.dispatched) if (hub.runs.get(d.id).status === 'queued') hub.set(d.id, { status: 'claimed' }); };
  // 存量 blocked_unknown 注入（2026-11-22 回执韧性：状态机 advance 不再产生该终态，控制器口径仍需覆盖旧 run）。
  // 只翻 run 文件、不动节点状态：下一轮 tick 的 advanceNode 走真实 blocked 分支（置 blocked+释放槽位），
  // 状态迁移与进度唤醒都按生产路径发生。
  const blockNow = async (nodeId, role = 'dev') => {
    const run = runOf(nodeId, role);
    if (!run) throw new Error(`blockNow：${nodeId}:${role} 没有 run 可注入`);
    // 生产里 blocked_unknown 回执到达时 Hub run 已终态：置终态让槽位释放的 fail-closed 核实通过。
    if (run.hub?.hubRunId) hub.set(run.hub.hubRunId, { status: 'done' });
    const file = path.join(directory, `${run.runId}.json`);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.status = 'blocked_unknown';
    data.expectedAdvanceId = null;
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    return run;
  };
  return { store, directory, root, hub, rt, wip, publisher, ctl, clock, runOf, receipt, claimAll, blockNow };
}
