// DAG 控制器：无模型，每次 tick 读 run.json → 推进节点 → 派发。只做授权快照内动作。
// 依赖全部注入（store/hub/rt/wip/publisher），便于离线测试。
import { readyNodes, validateDag } from './dag.mjs';
import { assertNodeDesignSnapshot, designContractDigest } from './design-baseline.mjs';
import { MAX_SLOTS, MAX_ATTEMPTS, QUARANTINE_AFTER_MS, isTerminal, ROOT_NODE, DagRunError } from './dag-run.mjs';
import { seg } from './dag-slots.mjs';
import { nodeTier } from './dag-tier.mjs';
import { closeoutSupersededRuns } from './dag-stall.mjs';

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

// 节点状态视图与 revive 请求共用：控制台 API 只写待办（不直接迁移节点状态），
// 控制器下一 tick 的 runTodo 才真正 createAttempt 重派。
// blocked / gated 都可被调度会话复活：gated 节点必然已尝试满次（change-approach 是唯一出口），
// revive reason 映射规则——blocked 用 blocked-resolved/change-approach；gated 用 gated-resolved/change-approach，
// 且 gated-resolved 内部也映射为 change-approach（换新代重派，与审阅底线的失败留痕一致）。
const REVIVE_REASONS = { blocked: ['blocked-resolved', 'change-approach'], gated: ['gated-resolved', 'change-approach'] };
export function reviveNode(store, root, nodeId, reason, { evidence = '', at = Date.now() } = {}) {
  const st = loadNodeStates(root);
  const n = st.nodes[String(nodeId)];
  const allowed = n ? REVIVE_REASONS[n.state] || [] : [];
  if (!allowed.includes(reason)) {
    throw new DagRunError('REVIVE_REASON_REQUIRED',
      `节点 ${nodeId} 当前状态 ${n?.state ?? '不存在'}，revive reason 只能是：${allowed.join('、') || '（此状态不可复活）'}`);
  }
  if (root.publish?.cancelRequested || isTerminal(root.status)) throw new DagRunError('DAG_TERMINAL', 'DAG 已取消/终结，不得复活节点');
  // gated 节点尝试必已满次，只有换打法才能出新 attempt；外部传的 gated-resolved 语义等价于换打法，内部统一记 change-approach。
  const effectiveReason = n.state === 'gated' ? 'change-approach' : reason;
  const role = n.state === 'gated' ? (n.gatedRole || 'dev') : (n.blockedRole || 'dev');
  n.todo = { kind: 'revive', reason: effectiveReason, role, evidence: String(evidence).slice(0, 500), at };
  store.updateRun(root.runId, { publish: { nodes: st.nodes, approachChanges: st.approachChanges } });
  return { nodeId: String(nodeId), reason };
}

export function createController({ store, rootRunId, hub, rt, wip, publisher, now = Date.now, chooseApproach = defaultApproach, baseRef = 'origin/main', blockedEvidence = alwaysBlocked, log = console.log } = {}) {
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
      ...(rt.sharedDepsLinked?.(n.slot) ? ['依赖：槽位 node_modules 已软链到控制器共享依赖缓存（按锁文件管理），直接使用，不要运行 npm ci/npm install；如节点确需改依赖，照常改 package.json 与锁文件并在回执 tests 里说明，下次 prepare 会按新锁文件换用对应缓存。'] : []),
      `expectedAdvanceId=${run.expectedAdvanceId}（回执必须逐字一致，只从本事件 detail 读取，不得猜测）`,
      `节点契约：${JSON.stringify(node.contract || {})}`,
    ];
    // 回执模板写进派发提示：worker 只看到契约与 expectedAdvanceId 时容易漏掉 detail，
    // 中台解析出空 detail 会被判 malformed，Hub run 终态却没有合法 advance，节点白跑一轮（2026-11-19 device-binding review）。
    // 模板必须逐字可被 evaluateAdvance 接受：runId 用节点 run（不是根 run），detail 只用字符串/数字/布尔/数组。
    // 通过与不通过两版模板都给（2026-11-22 PR #243/#245 事故：只给通过模板，审阅不通过的 worker
    // 自造 rejected/changes_requested 被判 malformed-outcome → 整轮作废）。两版都逐字可被 evaluateAdvance 接受。
    const receiptOk = run.role === 'dev'
      ? '"outcome":"done","detail":{"prUrl":"<真实 PR 链接>","commit":"<真实提交 SHA>","tests":"<真实测试结论>"}'
      : '"outcome":"accepted","detail":{"pr":0,"head":"<审阅的真实提交 SHA>","p0":0,"p1":0,"p2":0,"p3":0,"tests":"<真实测试结论>"}';
    const receiptFail = run.role === 'dev'
      ? '"outcome":"failed","detail":{"tests":"<失败原因与已跑测试结论>"}'
      : '"outcome":"rework","detail":{"pr":0,"head":"<审阅的真实提交 SHA>","p0":0,"p1":0,"p2":0,"p3":0,"tests":"<真实测试结论>"}';
    const receiptLine = detail => `{"events":[{"id":"${run.expectedAdvanceId}","type":"dag.node.advance","subject":"dag-${seg(id)}","summary":"一句话结论","detail":{"advanceId":"${run.expectedAdvanceId}","runId":"${run.runId}","nodeId":"${id}","role":"${run.role}","generation":${run.generation},"attempt":${run.attempt},${detail}}}]}`;
    lines.push(
      '回执（写在最后一条消息的 agent-autoloop 代码块）：结构逐字照抄下方 JSON，尖括号占位符与数字计数必须换成真实值，字段不得省略或改名。达成照第一版；不通过/做不到照第二版：',
      receiptLine(receiptOk),
      receiptLine(receiptFail),
      run.role === 'dev'
        ? 'outcome 只能是：done（交付完成）或 failed（做不到，tests 里写原因）。'
        : 'outcome 只能是：accepted（无 P0–P2，可合并）或 rework（有 P0–P2 需返工，分级计数写真实值）；不得写 rejected、changes_requested 等其他值。',
    );
    if (design) lines.push(
      `设计基线：${root.designBaseline.designDigest}（冻结于本 DAG；不得读取新稿替代）`,
      `设计合同：${JSON.stringify(node.contract.design)}`,
      '设计基线、参考图与验证器只读；不得自行修改基线或阈值，不得要求用户中途做工程选择。',
    );
    if (design && run.role === 'review') lines.push('证据不完整、checks 失败、knownDeviations 非空或真实渲染偏离合同时必须 rework；不得宣称设计验收通过。设施故障只报告并重建证据，不得转成 blocked/gated。');
    const warnings = n.warnings ? Object.entries(n.warnings).map(([kind, value]) => `${kind}: ${Array.isArray(value) ? value.join(', ') : value}`).join('；') : '';
    if (warnings) lines.push(`本节点已上报警示（只作参考，不阻断）：${warnings}`);
    if (design && run.role === 'review') lines.push(`设计验证证据：${JSON.stringify(n.designEvidence ? { commit: n.designEvidence.commit, designDigest: n.designEvidence.designDigest, contractDigest: n.designEvidence.contractDigest, checks: n.designEvidence.checks, captures: n.designEvidence.captures || n.designEvidence.artifacts || [], visualDiffs: n.designEvidence.visualDiffs || [], knownDeviations: n.designEvidence.knownDeviations || [] } : null)}`);
    if (run.attemptReason) lines.push(`本次重派原因：${run.attemptReason}`);
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
      const hubRun = await hub.getRun(run.hub.hubRunId);
      if (!HUB_TERMINAL.has(hubRun.status)) return false;
      // Hub 已终态但 store 里这条 run 还非终态（回执丢了/没收下）：先照回执收敛，收不动就带原因取消。
      // 否则 store.claim 与 usedSlots 都按「非终态 run」算占用，槽位看着空了却拿不回来（2026-11-19 device-binding）。
      if (!isTerminal(run.status)) {
        for (const receipt of hubRun.receipts || []) { try { store.advance(run.runId, receipt); } catch { /* 无效回执按无合法回执处理 */ } }
        if (!isTerminal(store.getRun(run.runId).status)) store.cancel(run.runId, { reason: 'hub-terminal-slot-release' });
      }
    }
    const last = latest(root, id, 'dev');
    await wip.releaseSlotWorktree(rt, { slot: n.slot, nodeId: id, attempt: last?.attempt || 1 });
    n.slot = null; return true;
  }

  async function gate(root, st, id, reason) { const n = st.nodes[id]; n.gatedRole = n.state === 'review' ? 'review' : 'dev'; n.state = 'gated'; n.todo = null; n.gateReason = reason; n.gateAt = now(); await releaseNodeSlot(root, st, id); }

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
  const designDeviation = (root, id, n) => {
    const node = root.nodes.find(item => item.id === id);
    if (!node?.contract?.design || !designEvidenceCurrent(root, id, n)) return false;
    const evidence = n.designEvidence;
    return (Array.isArray(evidence.checks) && evidence.checks.some(check => check.ok === false)) || (Array.isArray(evidence.knownDeviations) && evidence.knownDeviations.length > 0);
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
    if (designDeviation(root, id, n)) {
      // 设计未通过是正常实现返工，不是异常门禁。即使 reviewer 误判 accepted 也不能合并。
      return failure(root, st, id, latest(root, id, 'dev'), 'design-deviation');
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
      if (error?.code === 'DESIGN_DEVIATION') return failure(root, st, id, latest(root, id, 'dev'), 'design-deviation');
      if (error?.code === 'DESIGN_EVIDENCE_INCOMPLETE') {
        // merge 只做最后一道身份防线；清掉旧证据后下一 tick 自动补验并重审，不原地重试合并。
        n.designEvidence = null; n.state = 'review'; n.todo = null;
        n.lastError = `设计证据待重建：${msg(error)}`;
        return;
      }
      if (error?.code === 'HEAD_MISMATCH' && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(head)) {
        n.commit = head; n.rebasedTo = head; n.state = 'review'; n.todo = { kind: 'review', rebase: true };
        n.warnings = { ...(n.warnings || {}), rebasedHead: head };
        return;
      }
      throw error;
    }
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
      // queued 只代表 worker 还没接单（WorkBuddy 一次只跑一个任务，排队是常态），不是失败：无论第几次尝试
      // 都不取消、不 gate，等 worker 接单或 Hub 给出终态再裁决（2026-11-19 device-binding 两次事故：
      // 变基重审、开发重试均在排队时被误判“排队满次”）。真实卡死由 dag-stall 巡检兜底，不在此内联判断。
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
    const reason = todo.reason === 'change-approach' || (role === 'review' && latest(root, id, role).attempt >= MAX_ATTEMPTS) ? 'change-approach' : (todo.reason || 'retry');
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

  // 只在需要调度会话动手时叫醒：blocked、gated，以及整条链完成（根 run 变 done）。
  // dev/review/accepted 是控制器自己的推进，叫醒只会让调度会话空转一轮（2026-11-19 实测 17 次里大半空转）。
  // 瞬时错误仍归卡住巡检；claimed 过久、持续报错、gated 过久也由卡住巡检兜底。
  const PROGRESS_WAKE = new Set(['blocked', 'gated']);
  const snapshot = (root = loadRoot(), progress = []) => {
    const st = load(root); const slots = {};
    for (const [id, n] of Object.entries(st.nodes)) if (n.slot != null) slots[n.slot] = id;
    return { runId: root.runId, status: root.status, nodes: st.nodes, slots, approachChanges: st.approachChanges, capacity: MAX_SLOTS, progress };
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
      const before = Object.fromEntries(Object.entries(st.nodes).map(([id, n]) => [id, { error: n.lastError, since: n.errorSince, count: n.errorCount, state: n.state }]));
      try {
        if (root.publish?.cancelRequested) await cancelStep(root, st);
        else {
          // 先清再推进：advanceNode 自己写入的 lastError（未抛出的拒绝补发等）要保留，才能累计成卡住。
          for (const id of Object.keys(st.nodes)) { st.nodes[id].lastError = null; try { await advanceNode(root, st, id); } catch (error) { st.nodes[id].lastError = msg(error); } }
          try { await reviewBlocked(root, st); } catch (error) { st.lastError = msg(error); }
          for (const id of Object.keys(st.nodes)) if (st.nodes[id].todo) { try { await runTodo(root, st, id); } catch (error) { st.nodes[id].lastError = msg(error); } }
          // 已验收节点在合并那一刻若 Hub run 还没落终态，onDone 里的 releaseNodeSlot 会被 fail-closed 拒绝；
          // accepted 节点之后不再走 advanceNode，没有这一步就会永久占着槽位（2026-11-19 device-binding）。
          for (const [id, n] of Object.entries(st.nodes)) {
            if (n.state !== 'accepted' || n.slot == null) continue;
            try {
              // 释放被拒（Hub 还没终态）不能静默：写进 lastError 让卡住巡检在阈值后唤醒调度方，
              // 否则 root 因为「槽位没还干净」一直不收尾，却没有任何告警源看得见。
              if (!(await releaseNodeSlot(root, st, id)) && n.slot != null) n.lastError = `已验收节点 ${id} 槽位 ${n.slot} 待释放：Hub run 尚未终态，下一轮重试`;
            } catch (error) { n.lastError = msg(error); }
          }
          try { await dispatchReady(root, st); } catch (error) { st.lastError = msg(error); }
          // 收尾要等槽位都还干净：最后一个节点验收时若补释放被拒，root 一终结就再没有 tick 来补。
          if (Object.values(st.nodes).length && Object.values(st.nodes).every(n => n.state === 'accepted' && n.slot == null)) store.finishRoot(root.runId, 'done');
        }
        // 链终结（done 或 cancelled）后收掉遗留的非终态孤儿 run——派发中途失败、已被更新的
        // attempt 取代却永远停在 queued 的旧 run。只动被取代的，不碰活着的；否则占"每项目一条活跃 DAG"名额。
        if (isTerminal(loadRoot().status)) closeoutSupersededRuns(store, root.runId, { log });
      } finally { trackPersistentErrors(st, before, now()); persist(root, st); }
      const progress = [];
      const at = now();
      for (const [id, n] of Object.entries(st.nodes)) {
        const prev = before[id] || {};
        // at 让「返工后再次进入同一状态」得到不同的事件 ID；同一份快照重投时 at 不变，仍然幂等。
        if (n.state !== prev.state && PROGRESS_WAKE.has(n.state)) progress.push({ nodeId: id, from: prev.state ?? null, to: n.state, at });
      }
      // 整条链完成：本轮 finishRoot 把根 run 从非终态变成 done。终态后 tick 直接返回，所以只会出现这一次。
      if (!isTerminal(root.status) && loadRoot().status === 'done') progress.push({ nodeId: ROOT_NODE, from: root.status, to: 'done', at });
      return snapshot(loadRoot(), progress);
    },
  };
}
