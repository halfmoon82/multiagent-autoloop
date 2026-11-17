// DAG 控制器：无模型，每次 tick 读 run.json → 推进节点 → 派发。只做授权快照内动作。
// 依赖全部注入（store/hub/rt/wip/publisher），便于离线测试。
import { readyNodes, validateDag } from './dag.mjs';
import { MAX_SLOTS, MAX_ATTEMPTS, QUARANTINE_AFTER_MS, isTerminal, ROOT_NODE } from './dag-run.mjs';
import { seg } from './dag-slots.mjs';

const HUB_TERMINAL = new Set(['done', 'cancelled', 'failed', 'nothing']);
const SUCCESS = new Set(['done', 'accepted', 'merged']);
const msg = error => String(error?.message || error).replace(/[\r\n]+/g, ' ');
const defaultApproach = ({ run }) => ({ reason: `第 ${run.attempt} 次失败，换模型重派`, model: 'fallback' });

// blockedEvidence({ root, nodeId, run, node }) → { blocked:boolean, detail? }（或 Boolean）。
// 注入式：默认保守（始终仍阻塞），由运行时接线提供真实证据源（Hub 卡片/授权卡/前置节点/PR 状态）。
const alwaysBlocked = async () => ({ blocked: true });

export function createController({ store, rootRunId, hub, rt, wip, publisher, now = Date.now, chooseApproach = defaultApproach, baseRef = 'origin/main', blockedEvidence = alwaysBlocked } = {}) {
  const loadRoot = () => store.getRun(rootRunId);
  const nodeList = root => (root.nodes || []).filter(node => node.id !== ROOT_NODE);
  const latest = (root, nodeId, role) => store.listRuns()
    .filter(r => r.project === root.project && r.planId === root.planId && r.nodeId === nodeId && r.role === role)
    .reduce((best, r) => !best || r.generation > best.generation || (r.generation === best.generation && r.attempt > best.attempt) ? r : best, null);
  const persist = (root, st) => store.updateRun(root.runId, { publish: { nodes: st.nodes, approachChanges: st.approachChanges } });

  function load(root) {
    const saved = root.publish?.nodes || {};
    const nodes = {};
    for (const node of nodeList(root)) {
      nodes[node.id] = saved[node.id] || { state: 'pending', slot: null, branch: `feat/dag-${seg(root.runId)}-${seg(node.id)}`, model: null, todo: null };
    }
    return { nodes, approachChanges: root.publish?.approachChanges || [] };
  }

  const usedSlots = (root, st, except) => {
    const used = new Set(store.listRuns().filter(r => r.project === root.project && r.slot != null && !isTerminal(r.status)).map(r => r.slot));
    for (const [id, n] of Object.entries(st.nodes)) if (id !== except && n.slot != null) used.add(n.slot);
    return used;
  };
  const freeSlot = (root, st, except) => { const used = usedSlots(root, st, except); for (let s = 1; s <= MAX_SLOTS; s++) if (!used.has(s)) return s; return null; };

  const prompt = (root, id, run, n) => [
    `DAG 节点 ${id}（${run.role}，generation ${run.generation}，attempt ${run.attempt}）。`,
    `slot=${n.slot} worktree=${rt.slotPath(n.slot)} branch=${n.branch}`,
    `expectedAdvanceId=${run.expectedAdvanceId}（回执必须逐字一致，只从本事件 detail 读取，不得猜测）`,
    `节点契约：${JSON.stringify((root.nodes.find(x => x.id === id) || {}).contract || {})}`,
  ].join('\n');

  async function send(root, id, run, n) {
    const res = await hub.dispatch({ run, slot: n.slot, worktree: rt.slotPath(n.slot), branch: n.branch, expectedAdvanceId: run.expectedAdvanceId, model: n.model, prompt: prompt(root, id, run, n) });
    store.updateRun(run.runId, { hub: { hubRunId: res.hubRunId } });
  }
  async function start(root, st, id, run, slot, { prepare }) {
    const n = st.nodes[id]; n.slot = slot;
    if (prepare) await rt.prepare({ slot, nodeId: id, branch: n.branch, base: baseRef });
    const claimed = store.claim(run.runId, { slot });
    await send(root, id, claimed, n);
  }

  async function releaseNodeSlot(root, st, id) {
    const n = st.nodes[id]; if (n.slot == null) return true;
    for (const role of ['dev', 'review']) {
      const run = latest(root, id, role);
      if (!run || run.slot !== n.slot) continue;
      // fail closed：存活 run 若从未拿到 hubRunId（send 未成功），无法证明 Hub 侧终态，不得放槽位。
      if (!isTerminal(run.status) && !run.hub?.hubRunId) return false;
      if (!run.hub?.hubRunId) continue;
      // slot-release 前置：该槽位最近 Hub run 必须已终态；执行前再查一次。
      if (!HUB_TERMINAL.has((await hub.getRun(run.hub.hubRunId)).status)) return false;
    }
    const last = latest(root, id, 'dev');
    await wip.releaseSlotWorktree(rt, { slot: n.slot, nodeId: id, attempt: last?.attempt || 1 });
    n.slot = null; return true;
  }

  async function gate(root, st, id, reason) { const n = st.nodes[id]; n.state = 'gated'; n.todo = null; n.gateReason = reason; await releaseNodeSlot(root, st, id); }

  // 失败计数：累计 3 次先换打法（保存 WIP、换模型），换打法后仍满 3 次才 gate。
  async function failure(root, st, id, run, reason, { newSlot = false } = {}) {
    const n = st.nodes[id];
    if (run.attempt >= MAX_ATTEMPTS && run.generation > 1) return gate(root, st, id, reason);
    if (run.attempt >= MAX_ATTEMPTS) {
      const approach = await chooseApproach({ nodeId: id, run });
      if (n.slot != null) await wip.saveWip(rt, { slot: n.slot, nodeId: id, attempt: run.attempt });
      st.approachChanges.push({ nodeId: id, generation: run.generation + 1, reason: approach.reason, model: approach.model ?? null });
      n.model = approach.model ?? n.model; n.todo = { kind: 'retry', reason: 'change-approach', newSlot };
    } else n.todo = { kind: 'retry', reason, newSlot };
    n.state = 'dev';
  }

  async function onDone(root, st, id, run) {
    const n = st.nodes[id];
    if (!SUCCESS.has(run.outcome)) return failure(root, st, id, run.role === 'dev' ? run : latest(root, id, 'dev'), `outcome:${run.outcome}`);
    if (run.role === 'dev') {
      const ctx = { nodeId: id, slot: n.slot, branch: n.branch, worktree: rt.slotPath(n.slot), runId: root.runId };
      const pr = await publisher.commitPr(ctx);
      store.registerPr(root.runId, id, pr.prUrl); n.prUrl = pr.prUrl; n.commit = pr.commit;
      const ver = await publisher.verify({ ...ctx, commit: pr.commit });
      n.tests = ver.tests ?? null;
      if (ver.slotStateChanged) { n.state = 'blocked'; n.blockedRole = 'dev'; n.blockedReason = 'verify-changed-slot'; await releaseNodeSlot(root, st, id); return; }
      if (!ver.ok) return failure(root, st, id, run, 'verify-failed');
      n.state = 'review'; n.todo = { kind: 'review' }; return;
    }
    if (run.slotStateChanged) { n.state = 'blocked'; n.blockedRole = 'review'; n.blockedReason = 'review-changed-slot'; await releaseNodeSlot(root, st, id); return; }
    const merged = await publisher.merge({ nodeId: id, prUrl: n.prUrl, commit: n.commit, runId: root.runId });
    store.markPrMerged(root.runId, n.prUrl, { mergeCommit: merged.mergeCommit });
    await publisher.baseline({ nodeId: id, mergeCommit: merged.mergeCommit });
    n.state = 'accepted'; n.mergeCommit = merged.mergeCommit;
    await releaseNodeSlot(root, st, id);
  }

  async function advanceNode(root, st, id) {
    const n = st.nodes[id];
    if (!['dev', 'review'].includes(n.state) || n.todo) return;
    const run = latest(root, id, n.state); if (!run) return;
    if (run.status === 'claimed') {
      if (!run.hub?.hubRunId) return send(root, id, run, n); // 上次派发中断，补发
      const h = await hub.getRun(run.hub.hubRunId);
      if (h.status === 'unknown') { store.markUnknown(run.runId, { at: now() }); return; }
      if (h.status === 'queued' && run.attempt >= MAX_ATTEMPTS) { await hub.cancel(run.hub.hubRunId); store.cancel(run.runId, { reason: 'attempts-exhausted' }); return failure(root, st, id, run, 'queued-attempts'); }
      // Hub run 已终态却没有合法 advance：按一次失败尝试计数（attempt 即累计次数）。
      if (HUB_TERMINAL.has(h.status)) { store.cancel(run.runId, { reason: 'attempts-exhausted' }); return failure(root, st, id, run, 'no-valid-advance'); }
    } else if (run.status === 'unknown') {
      if (now() - run.unknownSince < QUARANTINE_AFTER_MS) return;
      if (!run.quarantine) store.quarantineSlot(run.runId, { now: now() });
      return failure(root, st, id, run, 'quarantine', { newSlot: true });
    } else if (run.status === 'done') return onDone(root, st, id, run);
    else if (run.status === 'blocked_unknown') { n.state = 'blocked'; n.blockedRole = run.role; n.blockedReason = 'blocked_unknown'; await releaseNodeSlot(root, st, id); }
    else if (run.status === 'abandoned') { n.todo = { kind: 'retry', reason: 'abandoned', newSlot: true, role: run.role }; n.state = run.role; }
    else if (run.status === 'cancelled') return failure(root, st, id, run, 'cancelled');
  }

  // 以新 attempt 重派某角色。review 角色从节点已提交的 commit 起步（不重跑开发）；
  // 换槽位时 review 用一次性分支名，避免与旧槽位已检出的 PR 分支冲突。
  async function reattempt(root, st, id, role, reason, newSlot) {
    const n = st.nodes[id]; let slot = n.slot;
    if (newSlot || slot == null) { slot = freeSlot(root, st, id); if (slot == null) return false; }
    const stamp = now().toString(36);
    const prepBranch = role === 'dev' ? (newSlot || n.slot == null ? `${n.branch.replace(/-att[0-9a-z]+$/, '')}-att${stamp}` : n.branch) : `${n.branch}-rv${stamp}`;
    if (role === 'dev') n.branch = prepBranch;
    const prev = latest(root, id, role);
    let run;
    try {
      run = store.createAttempt(prev.runId, { reason });
    } catch (error) {
      // 复活/重派用 blocked-resolved 但 attempt 已满 3：状态机拒绝并要求换打法。
      // 自动升级 gate（等待人工决策）并清空待办，避免下一 tick 同一错误空转重试。
      if (error?.code === 'CHANGE_APPROACH_REQUIRED') {
        await gate(root, st, id, `auto-escalated: ${msg(error)}`);
        return true;
      }
      throw error;
    }
    n.todo = null; n.state = role; n.blockedRole = null; n.blockedReason = null; n.slot = slot;
    await rt.prepare({ slot, nodeId: id, branch: prepBranch, base: role === 'dev' ? baseRef : n.commit });
    await send(root, id, store.claim(run.runId, { slot }), n);
    return true;
  }

  async function runTodo(root, st, id) {
    const n = st.nodes[id]; const todo = n.todo;
    if (todo.kind === 'review') {
      const prev = latest(root, id, 'review');
      const run = prev ? store.createAttempt(prev.runId, { reason: prev.attempt >= MAX_ATTEMPTS ? 'change-approach' : 'rework-cycle' }) : store.createNodeRun(root.runId, { nodeId: id, role: 'review' });
      n.todo = null; await start(root, st, id, run, n.slot, { prepare: false }); return;
    }
    const role = todo.role || 'dev';
    if (todo.kind === 'revive') {
      const prev = latest(root, id, role);
      if (todo.reason === 'change-approach') {
        const approach = await chooseApproach({ nodeId: id, run: prev });
        n.model = approach.model ?? n.model;
        st.approachChanges.push({ nodeId: id, generation: prev.generation + (prev.attempt >= MAX_ATTEMPTS ? 1 : 0), reason: approach.reason, model: approach.model ?? null });
      }
      await reattempt(root, st, id, role, todo.reason, true); return;
    }
    const reason = todo.reason === 'change-approach' || (role === 'review' && latest(root, id, role).attempt >= MAX_ATTEMPTS) ? 'change-approach' : 'retry';
    if (role === 'dev' && todo.newSlot === false) { // 原槽位重试：保持分支与槽位
      const run = store.createAttempt(latest(root, id, 'dev').runId, { reason });
      n.todo = null; n.state = 'dev'; await start(root, st, id, run, n.slot, { prepare: false }); return;
    }
    await reattempt(root, st, id, role, reason, Boolean(todo.newSlot));
  }

  // 周期复查 blocked_unknown 的阻塞证据：证据消失即写入 blocked-resolved 复活待办，
  // 由 runTodo 下一阶段以新 attempt 重派——无需 gate、无需用户介入（设计文档 67 行）。
  async function reviewBlocked(root, st) {
    for (const id of Object.keys(st.nodes)) {
      const n = st.nodes[id];
      if (n.state !== 'blocked' || n.todo) continue;
      const run = latest(root, id, n.blockedRole || 'dev');
      if (!run || run.status !== 'blocked_unknown') continue;
      let decision;
      try { decision = await blockedEvidence({ root, nodeId: id, run, node: n }); }
      catch (error) { n.lastError = `复查阻塞证据失败：${msg(error)}`; continue; }
      const blocked = typeof decision === 'boolean' ? decision : decision?.blocked;
      if (blocked === false) {
        const detail = typeof decision === 'object' && decision ? (decision.detail ?? decision.evidence ?? '') : '';
        n.todo = {
          kind: 'revive', reason: 'blocked-resolved', role: n.blockedRole || 'dev',
          evidence: String(detail).slice(0, 500), at: now(), auto: true,
        };
      }
    }
  }

  async function dispatchReady(root, st) {
    const view = nodeList(root).map(node => ({ ...node, status: st.nodes[node.id].state === 'accepted' ? 'done' : st.nodes[node.id].state === 'pending' ? 'pending' : 'running' }));
    if (!validateDag(view).valid) return;
    const blockedIds = Object.entries(st.nodes).filter(([, n]) => ['blocked', 'gated'].includes(n.state)).map(([id]) => id);
    for (const node of readyNodes(view, { blockedIds })) {
      const slot = freeSlot(root, st, node.id); if (slot == null) break;
      const n = st.nodes[node.id];
      const run = store.createNodeRun(root.runId, { nodeId: node.id, role: 'dev' });
      n.state = 'dev'; await start(root, st, node.id, run, slot, { prepare: true });
    }
  }

  async function cancelStep(root, st) {
    for (const id of Object.keys(st.nodes)) {
      const n = st.nodes[id]; if (['accepted', 'cancelled'].includes(n.state) && n.slot == null) continue;
      for (const role of ['dev', 'review']) {
        const run = latest(root, id, role); if (!run || isTerminal(run.status) || run.status === 'unknown') continue;
        if (run.hub?.hubRunId) {
          if (!HUB_TERMINAL.has((await hub.getRun(run.hub.hubRunId)).status)) { await hub.cancel(run.hub.hubRunId); if (!HUB_TERMINAL.has((await hub.getRun(run.hub.hubRunId)).status)) continue; }
        }
        store.cancel(run.runId, { reason: 'dag-cancel' });
      }
      const live = ['dev', 'review'].map(role => latest(root, id, role)).filter(r => r && !isTerminal(r.status));
      if (!live.length && await releaseNodeSlot(root, st, id)) n.state = n.state === 'accepted' ? 'accepted' : 'cancelled';
    }
    const left = store.listRuns().some(r => r.project === root.project && r.runId !== root.runId && r.slot != null && !isTerminal(r.status));
    if (!left && Object.values(st.nodes).every(n => n.slot == null)) store.finishRoot(root.runId, 'cancelled');
  }

  const snapshot = (root = loadRoot()) => {
    const st = load(root); const slots = {};
    for (const [id, n] of Object.entries(st.nodes)) if (n.slot != null) slots[n.slot] = id;
    return { runId: root.runId, status: root.status, nodes: st.nodes, slots, approachChanges: st.approachChanges, capacity: MAX_SLOTS };
  };

  return {
    snapshot: () => snapshot(),
    cancel() { store.updateRun(rootRunId, { publish: { cancelRequested: true } }); },
    // blocked 节点复活入口：阻塞源消失（Hub 证据/用户确认）后由调度方/控制台调用，下一 tick 以新 attempt 重派。
    revive(nodeId, reason, { evidence = '' } = {}) {
      if (!['blocked-resolved', 'change-approach'].includes(reason)) throw new Error('revive reason 只能是 blocked-resolved 或 change-approach');
      const root = loadRoot(); const st = load(root); const n = st.nodes[nodeId];
      if (!n || n.state !== 'blocked') throw new Error(`节点 ${nodeId} 不在 blocked 状态，无法复活`);
      if (root.publish?.cancelRequested || isTerminal(root.status)) throw new Error('DAG 已取消/终结，不得复活节点');
      n.todo = { kind: 'revive', reason, role: n.blockedRole || 'dev', evidence: String(evidence).slice(0, 500), at: now() };
      persist(root, st); return { nodeId, reason };
    },
    async releaseNode(nodeId) { const root = loadRoot(); const st = load(root); try { return await releaseNodeSlot(root, st, nodeId); } finally { persist(root, st); } },
    async tick() {
      const root = loadRoot(); if (isTerminal(root.status)) return snapshot(root);
      const st = load(root);
      try {
        if (root.publish?.cancelRequested) await cancelStep(root, st);
        else {
          for (const id of Object.keys(st.nodes)) { try { await advanceNode(root, st, id); st.nodes[id].lastError = null; } catch (error) { st.nodes[id].lastError = msg(error); } }
          try { await reviewBlocked(root, st); } catch (error) { st.lastError = msg(error); }
          for (const id of Object.keys(st.nodes)) if (st.nodes[id].todo) { try { await runTodo(root, st, id); } catch (error) { st.nodes[id].lastError = msg(error); } }
          try { await dispatchReady(root, st); } catch (error) { st.lastError = msg(error); }
          if (Object.values(st.nodes).length && Object.values(st.nodes).every(n => n.state === 'accepted')) store.finishRoot(root.runId, 'done');
        }
      } finally { persist(root, st); }
      return snapshot(loadRoot());
    },
  };
}
