// DAG 控制器：无模型，每次 tick 读 run.json → 推进节点 → 派发。只做授权快照内动作。
// 依赖全部注入（store/hub/rt/wip/publisher），便于离线测试。
import { readyNodes, validateDag } from './dag.mjs';
import { assertNodeDesignSnapshot, designContractDigest } from './design-baseline.mjs';
import { MAX_SLOTS, MAX_ATTEMPTS, QUARANTINE_AFTER_MS, isTerminal, ROOT_NODE, DagRunError } from './dag-run.mjs';
import { seg } from './dag-slots.mjs';
import { nodeTier } from './dag-tier.mjs';

export const HUB_TERMINAL = new Set(['done', 'cancelled', 'failed', 'nothing']);
const SUCCESS = new Set(['done', 'accepted', 'merged']);
const msg = error => String(error?.message || error).replace(/[\r\n]+/g, ' ');

// 持续报错记账：一轮内可能先清空再写入 lastError，所以只在轮末与上一轮比较。
// 同一错误保留首次时间、累计次数；换了错误重新计时；没有错误就清掉。卡住巡检（dag-stall.mjs）只读这两个字段。
function trackPersistentErrors(st, before, at) {
  for (const [id, n] of Object.entries(st.nodes)) {
    const prev = before[id] || {};
    if (!n.lastError) { delete n.errorSince; delete n.errorCount; continue; }
    if (n.lastError === prev.error && prev.since != null) { n.errorSince = prev.since; n.errorCount = (prev.count || 1) + 1; }
    else { n.errorSince = at; n.errorCount = 1; }
  }
}
// 成本优先：首派用节点最便宜可行档，换打法默认升一档（light→standard→heavy），不直接上最贵模型。
const defaultApproach = ({ run }) => ({ reason: `第 ${run.attempt} 次失败，升一档模型重派`, tierBump: 1 });

// blockedEvidence({ root, nodeId, run, node }) → { blocked:boolean, detail? }（或 Boolean）。
// 注入式：默认保守（始终仍阻塞），由运行时接线提供真实证据源（Hub 卡片/授权卡/前置节点/PR 状态）。
const alwaysBlocked = async () => ({ blocked: true });

// 节点状态视图与 revive 请求共用：控制台 API 只写待办（不直接迁移节点状态），
// 控制器下一 tick 的 runTodo 才真正 createAttempt 重派。
export function loadNodeStates(root) {
  const saved = root.publish?.nodes || {};
  const nodes = {};
  for (const node of (root.nodes || []).filter(item => item.id !== ROOT_NODE)) {
    nodes[node.id] = saved[node.id] || { state: 'pending', slot: null, branch: `feat/dag-${seg(root.runId)}-${seg(node.id)}`, model: null, todo: null };
  }
  return { nodes, approachChanges: root.publish?.approachChanges || [] };
}

// blocked 复活唯一通道：reason 仅接受 blocked-resolved / change-approach；
// evidence 写入 node todo 留痕（根 run publish.nodes 持久化），授权快照逐字继承由 createAttempt 保证。
export function reviveNode(store, root, nodeId, reason, { evidence = '', at = Date.now() } = {}) {
  if (!['blocked-resolved', 'change-approach'].includes(reason)) {
    throw new DagRunError('REVIVE_REASON_REQUIRED', 'revive reason 只能是 blocked-resolved 或 change-approach');
  }
  const st = loadNodeStates(root);
  const n = st.nodes[String(nodeId)];
  if (!n || n.state !== 'blocked') throw new DagRunError('NODE_NOT_BLOCKED', `节点 ${nodeId} 不在 blocked 状态，无法复活`);
  if (root.publish?.cancelRequested || isTerminal(root.status)) throw new DagRunError('DAG_TERMINAL', 'DAG 已取消/终结，不得复活节点');
  n.todo = { kind: 'revive', reason, role: n.blockedRole || 'dev', evidence: String(evidence).slice(0, 500), at };
  store.updateRun(root.runId, { publish: { nodes: st.nodes, approachChanges: st.approachChanges } });
  return { nodeId: String(nodeId), reason };
}

export function createController({ store, rootRunId, hub, rt, wip, publisher, now = Date.now, chooseApproach = defaultApproach, baseRef = 'origin/main', blockedEvidence = alwaysBlocked } = {}) {
  const loadRoot = () => store.getRun(rootRunId);
  const nodeList = root => (root.nodes || []).filter(node => node.id !== ROOT_NODE);
  const latest = (root, nodeId, role) => store.listRuns()
    .filter(r => r.project === root.project && r.planId === root.planId && r.nodeId === nodeId && r.role === role)
    .reduce((best, r) => !best || r.generation > best.generation || (r.generation === best.generation && r.attempt > best.attempt) ? r : best, null);
  const persist = (root, st) => store.updateRun(root.runId, { publish: { nodes: st.nodes, approachChanges: st.approachChanges } });

  const load = root => loadNodeStates(root);

  const usedSlots = (root, st, except) => {
    const used = new Set(store.listRuns().filter(r => r.project === root.project && r.slot != null && !isTerminal(r.status)).map(r => r.slot));
    for (const [id, n] of Object.entries(st.nodes)) if (id !== except && n.slot != null) used.add(n.slot);
    return used;
  };
  const freeSlot = (root, st, except) => { const used = usedSlots(root, st, except); for (let s = 1; s <= MAX_SLOTS; s++) if (!used.has(s)) return s; return null; };

  const prompt = (root, id, run, n) => {
    const node = root.nodes.find(x => x.id === id) || {};
    const design = assertNodeDesignSnapshot(root, node).design;
    const lines = [
      `DAG 节点 ${id}（${run.role}，generation ${run.generation}，attempt ${run.attempt}）。`,
      `slot=${n.slot} worktree=${rt.slotPath(n.slot)} branch=${n.branch}`,
      `expectedAdvanceId=${run.expectedAdvanceId}（回执必须逐字一致，只从本事件 detail 读取，不得猜测）`,
      `节点契约：${JSON.stringify(node.contract || {})}`,
    ];
    // 回执模板写进派发提示：worker 只看到契约与 expectedAdvanceId 时容易漏掉 detail，
    // 中台解析出空 detail 会被判 malformed，Hub run 终态却没有合法 advance，节点白跑一轮（2026-11-19 device-binding review）。
    // detail 只允许字符串/数字/布尔/数组，嵌套对象会被判 malformed。
    const receiptType = run.role === 'dev' ? 'dag.node.advance' : 'dag.auto.review.advance';
    const receiptDetail = run.role === 'dev'
      ? `"outcome":"done","detail":{"prUrl":"<PR 链接>","commit":"<提交 SHA>","tests":"<测试结论>"}`
      : `"outcome":"accepted","detail":{"pr":<PR 号>,"head":"<审阅的提交 SHA>","p0":0,"p1":0,"p2":0,"p3":0,"tests":"<测试结论>"}`;
    lines.push(
      '回执（写在最后一条消息的 agent-autoloop 代码块；detail 必填，字段逐字照抄，不得省略或改名）：',
      `{"events":[{"id":"${run.expectedAdvanceId}","type":"${receiptType}","subject":"dag-${seg(id)}","summary":"一句话结论","detail":{"advanceId":"${run.expectedAdvanceId}","runId":"${root.runId}","nodeId":"${id}","role":"${run.role}","generation":${run.generation},"attempt":${run.attempt},${receiptDetail}}}]}`,
    );
    if (design) lines.push(
      `设计基线：${root.designBaseline.designDigest}（冻结于本 DAG；不得读取新稿替代）`,
      `设计合同：${JSON.stringify(node.contract.design)}`,
      '设计基线、参考图与验证器只读；如需改变设计语义，返回 DESIGN_CHANGE_REQUIRED，不得自行修改基线或阈值。',
    );
    const warnings = n.warnings ? Object.entries(n.warnings).map(([kind, value]) => `${kind}: ${Array.isArray(value) ? value.join(', ') : value}`).join('；') : '';
    if (warnings) lines.push(`本节点已上报警示（只作参考，不阻断）：${warnings}`);
    if (design && run.role === 'review') lines.push(`设计验证证据：${JSON.stringify(n.designEvidence ? { commit: n.designEvidence.commit, designDigest: n.designEvidence.designDigest, contractDigest: n.designEvidence.contractDigest, checks: n.designEvidence.checks, visualDiffs: n.designEvidence.visualDiffs || [] } : null)}`);
    return lines.join('\n');
  };

  const tierOf = (root, id, role, n) => nodeTier(root.nodes.find(x => x.id === id) || {}, role, { bump: n.tierBump || 0 });
  // 换打法留痕：记录本次换打法后该角色将使用的档位。
  const applyApproach = (root, st, id, approach, generation, role = 'dev') => {
    const n = st.nodes[id];
    n.model = approach.model ?? n.model;
    n.tierBump = (n.tierBump || 0) + Math.max(0, Number(approach.tierBump) || 0);
    st.approachChanges.push({ nodeId: id, generation, reason: approach.reason, model: approach.model ?? null, tier: tierOf(root, id, role, n) });
  };

  async function send(root, id, run, n) {
    n.tier = tierOf(root, id, run.role, n);
    const res = await hub.dispatch({ run, slot: n.slot, worktree: rt.slotPath(n.slot), branch: n.branch, expectedAdvanceId: run.expectedAdvanceId, model: n.model, tier: n.tier, prompt: prompt(root, id, run, n) });
    store.updateRun(run.runId, { hub: { hubRunId: res.hubRunId } });
  }
  async function start(root, st, id, run, slot, { prepare }) {
    assertNodeDesignSnapshot(root, root.nodes.find(node => node.id === id));
    const n = st.nodes[id]; n.slot = slot;
    if (prepare) {
      n.prepareBase = (await rt.prepare({ slot, nodeId: id, branch: n.branch, base: baseRef })).baseCommit;
      // 在 claim/派发前先把冻结 base 写入服务端 root run，崩溃恢复不依赖 slot 状态。
      persist(root, st);
    }
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
      applyApproach(root, st, id, approach, run.generation + 1);
      n.todo = { kind: 'retry', reason: 'change-approach', newSlot };
    } else n.todo = { kind: 'retry', reason, newSlot };
    n.state = 'dev';
  }

  const designEvidenceCurrent = (root, id, n) => {
    const node = root.nodes.find(item => item.id === id);
    if (!node?.contract?.design) return true;
    const evidence = n.designEvidence;
    // 只要求证据身份与当前 commit/设计基线一致；checks 结果只记录，不阻断。
    return Boolean(evidence && root.designBaseline
      && evidence.commit === n.commit && evidence.designDigest === root.designBaseline.designDigest
      && evidence.contractDigest === designContractDigest({ designDigest: root.designBaseline.designDigest, contract: node.contract.design }));
  };

  async function onDone(root, st, id, run) {
    const n = st.nodes[id];
    if (!SUCCESS.has(run.outcome)) return failure(root, st, id, run.role === 'dev' ? run : latest(root, id, 'dev'), `outcome:${run.outcome}`);
    if (run.role === 'dev') {
      const ctx = { nodeId: id, slot: n.slot, branch: n.branch, worktree: rt.slotPath(n.slot), runId: root.runId, base: n.prepareBase };
      let pr;
      try { pr = await publisher.commitPr(ctx); }
      catch (error) {
        if (error?.code === 'SENSITIVE_PATH') return failure(root, st, id, run, 'sensitive-path');
        // 开发回执 done 但没有任何提交：属于这一轮实现失败，按失败尝试重派/换打法，
        // 不能让同一个 done run 每 tick 重抛同一错误原地空转（2026-11-19 device-binding 卡住）。
        if (error?.code === 'NOTHING_TO_PUBLISH') return failure(root, st, id, run, 'nothing-to-publish');
        throw error;
      }
      store.registerPr(root.runId, id, pr.prUrl); n.prUrl = pr.prUrl; n.commit = pr.commit;
      if (pr.outOfScope?.length) n.warnings = { ...(n.warnings || {}), outOfScope: pr.outOfScope };
      const ver = await publisher.verify({ ...ctx, commit: pr.commit });
      n.tests = ver.tests ?? null; n.designEvidence = ver.designEvidence ?? null;
      if (ver.designEvidenceWarning) n.warnings = { ...(n.warnings || {}), designEvidence: ver.designEvidenceWarning };
      if (ver.slotStateChanged) { n.state = 'blocked'; n.blockedRole = 'dev'; n.blockedReason = 'verify-changed-slot'; await releaseNodeSlot(root, st, id); return; }
      if (!ver.ok) return failure(root, st, id, run, 'verify-failed');
      n.state = 'review'; n.todo = { kind: 'review' }; return;
    }
    if (run.slotStateChanged) { n.state = 'blocked'; n.blockedRole = 'review'; n.blockedReason = 'review-changed-slot'; await releaseNodeSlot(root, st, id); return; }
    if (!designEvidenceCurrent(root, id, n)) {
      // 同 SHA 证据丢失/失效：自动补验，并重新创建独立 review；不直接 merge，也不重新确认设计。
      const dev = latest(root, id, 'dev');
      const ctx = { nodeId: id, slot: n.slot, branch: n.branch, worktree: rt.slotPath(n.slot), runId: root.runId, commit: n.commit };
      const ver = await publisher.verify(ctx);
      n.tests = ver.tests ?? null; n.designEvidence = ver.designEvidence ?? null;
      if (ver.designEvidenceWarning) n.warnings = { ...(n.warnings || {}), designEvidence: ver.designEvidenceWarning };
      if (ver.slotStateChanged) { n.state = 'blocked'; n.blockedRole = 'dev'; n.blockedReason = 'verify-changed-slot'; await releaseNodeSlot(root, st, id); return; }
      if (!ver.ok) return failure(root, st, id, dev, 'verify-failed');
      n.todo = { kind: 'review' }; return;
    }
    // PR 在审阅后被变基/强推：审阅基准已不等于远端 head。绝不合并未审提交——
    // 在新 head 上补跑测试，下一阶段以新 attempt 重派独立审阅，通过后再合并同一 SHA。
    if (n.rebasedTo && n.rebasedTo === n.commit) {
      const ctx = { nodeId: id, slot: n.slot, branch: n.branch, worktree: rt.slotPath(n.slot), runId: root.runId, commit: n.commit };
      const ver = await publisher.verify({ ...ctx, commit: n.commit });
      n.tests = ver.tests ?? null; n.designEvidence = ver.designEvidence ?? null;
      if (ver.designEvidenceWarning) n.warnings = { ...(n.warnings || {}), designEvidence: ver.designEvidenceWarning };
      if (ver.slotStateChanged) { n.state = 'blocked'; n.blockedRole = 'dev'; n.blockedReason = 'verify-changed-slot'; await releaseNodeSlot(root, st, id); return; }
      if (!ver.ok) { delete n.rebasedTo; return failure(root, st, id, latest(root, id, 'dev'), 'verify-failed'); }
      delete n.rebasedTo;
    }
    let merged;
    try { merged = await publisher.merge({ nodeId: id, prUrl: n.prUrl, commit: n.commit, runId: root.runId, evidence: n.designEvidence }); }
    catch (error) {
      const head = String(error?.head ?? '');
      if (error?.code === 'HEAD_MISMATCH' && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(head)) {
        n.commit = head; n.rebasedTo = head; n.state = 'review'; n.todo = { kind: 'review', rebase: true };
        n.warnings = { ...(n.warnings || {}), rebasedHead: head };
        return;
      }
      throw error;
    }
    if (merged.designWarning) n.warnings = { ...(n.warnings || {}), designEvidence: merged.designWarning };
    store.markPrMerged(root.runId, n.prUrl, { mergeCommit: merged.mergeCommit });
    await publisher.baseline({ nodeId: id, mergeCommit: merged.mergeCommit });
    n.state = 'accepted'; n.mergeCommit = merged.mergeCommit;
    await releaseNodeSlot(root, st, id);
  }

  async function advanceNode(root, st, id, replayed = false) {
    const n = st.nodes[id];
    if (!['dev', 'review'].includes(n.state) || n.todo) return;
    const run = latest(root, id, n.state); if (!run) return;
    if (run.status === 'queued' || run.status === 'claimed') {
      if (!run.hub?.hubRunId) {
        // 派发中断补发：claimed 已备好槽位只补 send；queued 说明 prepare/send 抛错前
        // 状态机已落盘但 Hub 从未接单，必须重跑 prepare 再 claim+send，否则节点静默卡住。
        if (run.status === 'queued') {
          const prepared = await rt.prepare({ slot: n.slot, nodeId: id, branch: n.branch, base: n.prepareBase || baseRef });
          n.prepareBase = prepared.baseCommit; // queued 补发也冻结实际 SHA，不再传符号 ref 给 commitPr
          persist(root, st);
          return send(root, id, store.claim(run.runId, { slot: n.slot }), n);
        }
        if (!n.prepareBase) {
          n.lastError = 'claimed run 缺少服务端冻结 prepare base，拒绝补发';
          return;
        }
        return send(root, id, run, n);
      }
      const h = await hub.getRun(run.hub.hubRunId);
      // 记下 Hub 轮次号：/v1/events 不带执行者与用量，界面要按轮次号到 /v1/state 查执行 Agent 与 Token/费用。
      if (Number.isInteger(h.hubRun) && run.hub.hubRun !== h.hubRun) store.updateRun(run.runId, { hub: { hubRun: h.hubRun } });
      // Hub 侧带回的 DAG 回执（重启后补消费）：逐条交给状态机裁决，旧/重复/畸形回执由 advance 判 stale/duplicate/invalid，
      // 绝不在这里自行改状态；裁决后 run 已变化则按新状态重走一遍（至多一次，避免递归空转）。
      if (!replayed && Array.isArray(h.receipts) && h.receipts.length) {
        for (const receipt of h.receipts) store.advance(run.runId, receipt);
        if (store.getRun(run.runId).status !== run.status) return advanceNode(root, st, id, true);
      }
      if (h.status === 'unknown') { store.markUnknown(run.runId, { at: now() }); return; }
      // 变基重审是外部强推后的恢复路径，虽落在最大 attempt 上，但刚派发的 queued 只代表 worker 还没接单，
      // 不能按“排队满次”取消——否则会白丢一次已准备的重审并退回开发重做（2026-11-19 device-binding 事故）。
      if (h.status === 'queued' && run.attempt >= MAX_ATTEMPTS && run.attemptReason !== 'rebase-review') { await hub.cancel(run.hub.hubRunId); store.cancel(run.runId, { reason: 'attempts-exhausted' }); return failure(root, st, id, run, 'queued-attempts'); }
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
    // 记录 prepare 基准：queued 补发时重跑 prepare 必须沿用同一基准（review 用原 commit）。
    n.prepareBase = role === 'dev' ? null : n.commit;
    const prepared = await rt.prepare({ slot, nodeId: id, branch: prepBranch, base: n.prepareBase || baseRef });
    if (role === 'dev') n.prepareBase = prepared.baseCommit;
    persist(root, st);
    await send(root, id, store.claim(run.runId, { slot }), n);
    return true;
  }

  // 原槽位重试是否安全：槽位必须确实预置成本节点的开发分支，且冻结基准是“基底”而不是节点提交本身。
  // 审阅 prepare（变基重审）会把 prepareBase 记成节点 commit，泄漏给开发重试就永远没有提交可发。
  const devSlotReusable = (id, n) => {
    if (n.slot == null || !n.prepareBase) return false;
    if (n.commit && n.prepareBase === n.commit) return false;
    const slot = typeof rt.loadState === 'function' ? (rt.loadState() || {})[n.slot] : null;
    if (slot && (slot.nodeId !== id || slot.branch !== n.branch)) return false;
    return true;
  };

  async function runTodo(root, st, id) {
    const n = st.nodes[id]; const todo = n.todo;
    if (todo.kind === 'review') {
      if (todo.rebase) {
        // 变基重审：槽位记录绑定的是开发期的 branch/base，直接复用会被 fail closed 拒绝；
        // 先按既有纪律释放槽位（WIP 保全 + 清槽位状态），再从新 head prepare 一次性审阅分支。
        // 派发不成功时保留待办，避免以旧审阅结论直接进入合并。
        try {
          const released = await releaseNodeSlot(root, st, id);
          let prepared = false;
          if (released) {
            // 强推后的 head 往往只在远端：先取回控制器 mirror，再以取回的实际 head 作审阅基准。
            const head = await publisher.fetchHead({ nodeId: id, branch: n.branch });
            n.commit = head; n.rebasedTo = head;
            prepared = await reattempt(root, st, id, 'review', 'rebase-review', true);
          }
          if (!prepared) n.todo = { kind: 'review', rebase: true };
        } catch (error) {
          n.todo = { kind: 'review', rebase: true };
          throw error;
        }
        return;
      }
      const prev = latest(root, id, 'review');
      const run = prev ? store.createAttempt(prev.runId, { reason: prev.attempt >= MAX_ATTEMPTS ? 'change-approach' : 'rework-cycle' }) : store.createNodeRun(root.runId, { nodeId: id, role: 'review' });
      n.todo = null; await start(root, st, id, run, n.slot, { prepare: false }); return;
    }
    const role = todo.role || 'dev';
    if (todo.kind === 'revive') {
      const prev = latest(root, id, role);
      if (todo.reason === 'change-approach') {
        const approach = await chooseApproach({ nodeId: id, run: prev });
        applyApproach(root, st, id, approach, prev.generation + (prev.attempt >= MAX_ATTEMPTS ? 1 : 0), role);
      }
      await reattempt(root, st, id, role, todo.reason, true); return;
    }
    const reason = todo.reason === 'change-approach' || (role === 'review' && latest(root, id, role).attempt >= MAX_ATTEMPTS) ? 'change-approach' : 'retry';
    if (role === 'dev' && todo.newSlot === false) { // 原槽位重试：保持分支与槽位
      if (!devSlotReusable(id, n)) {
        // 槽位已被审阅 prepare 改成本节点的 commit 基准/审阅分支：直接复用会让 prepareBase == commit，
        // commitPr 永远报“没有任何提交可发 PR”。按纪律先释放（WIP 保全），再在冻结基底重新 prepare。
        const released = await releaseNodeSlot(root, st, id);
        if (!released) { n.lastError = '原槽位需重备但槽位暂不能安全释放（Hub run 未终态），下一轮再试'; return; }
        await reattempt(root, st, id, role, reason, true); return;
      }
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
      const n = st.nodes[node.id];
      try {
        // 设计快照错误按节点隔离，且必须早于收养、槽位、prepare、claim 与 Hub 操作。
        assertNodeDesignSnapshot(root, node);
        // 崩溃恢复：run 已存在而节点仍 pending 时收养，避免 NODE_EXISTS 死锁。
        const existing = latest(root, node.id, 'dev');
        if (existing) {
          const adopted = existing.slot ?? freeSlot(root, st, node.id); if (adopted == null) break;
          n.state = 'dev'; n.slot = adopted; n.prepareBase = null;
          await advanceNode(root, st, node.id); continue;
        }
        const slot = freeSlot(root, st, node.id); if (slot == null) break;
        const run = store.createNodeRun(root.runId, { nodeId: node.id, role: 'dev' });
        n.state = 'dev'; await start(root, st, node.id, run, slot, { prepare: true });
      } catch (error) { n.lastError = msg(error); }
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
      return reviveNode(store, loadRoot(), nodeId, reason, { evidence, at: now() });
    },
    async releaseNode(nodeId) { const root = loadRoot(); const st = load(root); try { return await releaseNodeSlot(root, st, nodeId); } finally { persist(root, st); } },
    async tick() {
      const root = loadRoot(); if (isTerminal(root.status)) return snapshot(root);
      const st = load(root);
      const before = Object.fromEntries(Object.entries(st.nodes).map(([id, n]) => [id, { error: n.lastError, since: n.errorSince, count: n.errorCount }]));
      try {
        if (root.publish?.cancelRequested) await cancelStep(root, st);
        else {
          // 先清再推进：advanceNode 自己写入的 lastError（未抛出的拒绝补发等）要保留，才能累计成卡住。
          for (const id of Object.keys(st.nodes)) { st.nodes[id].lastError = null; try { await advanceNode(root, st, id); } catch (error) { st.nodes[id].lastError = msg(error); } }
          try { await reviewBlocked(root, st); } catch (error) { st.lastError = msg(error); }
          for (const id of Object.keys(st.nodes)) if (st.nodes[id].todo) { try { await runTodo(root, st, id); } catch (error) { st.nodes[id].lastError = msg(error); } }
          try { await dispatchReady(root, st); } catch (error) { st.lastError = msg(error); }
          if (Object.values(st.nodes).length && Object.values(st.nodes).every(n => n.state === 'accepted')) store.finishRoot(root.runId, 'done');
        }
      } finally { trackPersistentErrors(st, before, now()); persist(root, st); }
      return snapshot(loadRoot());
    },
  };
}
