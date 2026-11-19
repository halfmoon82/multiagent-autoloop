import test from 'node:test';
import assert from 'node:assert/strict';
import { mkNode, setup } from './dag-fakes.mjs';
import { designContractDigest } from '../src/design-baseline.mjs';

const six = () => ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map(id => mkNode(id));
// 驱动一个节点从开发回执到 accepted（两个 tick）。
async function accept(s, id) {
  s.claimAll(); s.receipt(id, 'dev', 'done'); await s.ctl.tick();
  s.claimAll(); s.receipt(id, 'review', 'accepted'); await s.ctl.tick();
}

test('6 个 ready 先派 5 个槽位，一个节点 accepted 后补第 6 个', async () => {
  const s = setup(six());
  await s.ctl.tick();
  assert.equal(s.hub.dispatched.length, 5);
  assert.deepEqual(s.hub.dispatched.map(d => d.slot).sort(), [1, 2, 3, 4, 5]);
  await s.ctl.tick(); assert.equal(s.hub.dispatched.length, 5, '重复 tick 不重复派发');
  await accept(s, 'n1');
  assert.ok(s.hub.last('n6'), '空出名额后补派 n6');
  assert.equal(s.hub.last('n6').slot, s.hub.last('n1').slot, '复用被释放的槽位');
  assert.deepEqual(s.publisher.calls.filter(c => c[0] === 'merge').map(c => c[1]), ['n1']);
});

test('并行审阅：n1 开发完成即进入审阅，不等 n2', async () => {
  const s = setup(six());
  await s.ctl.tick(); s.claimAll();
  s.receipt('n1', 'dev', 'done'); await s.ctl.tick();
  const review = s.hub.last('n1', 'review');
  assert.ok(review); assert.equal(review.slot, s.hub.last('n1').slot, '审阅在节点同一槽位');
  assert.equal(s.runOf('n2').status, 'claimed', 'n2 不受影响');
  assert.deepEqual(s.publisher.calls.map(c => c[0]).slice(0, 2), ['commitPr', 'verify']);
});

test('单节点失联：unknown 不可取消，15 分钟后隔离槽位，节点以新 attempt 换槽继续', async () => {
  const s = setup(six().slice(0, 2));
  await s.ctl.tick(); s.claimAll();
  const first = s.hub.last('n1'); const run1 = s.runOf('n1');
  s.hub.set(first.id, { status: 'unknown' });
  await s.ctl.tick();
  assert.equal(s.runOf('n1').status, 'unknown');
  assert.equal(s.hub.dispatched.length, 2, '观察期内不重复派发');
  s.clock.t += 16 * 60 * 1000; await s.ctl.tick();
  assert.equal(s.store.getRun(run1.runId).quarantine, true);
  assert.ok(!s.hub.cancelled.includes(first.id), 'unknown 不可取消');
  const retry = s.hub.last('n1');
  assert.notEqual(retry.id, first.id); assert.notEqual(retry.slot, first.slot, '不重派到隔离槽位');
  assert.equal(s.runOf('n1').attempt, 2);
  // 旧 run 晚到回执作废
  const late = s.store.advance(run1.runId, { advanceId: run1.expectedAdvanceId, runId: run1.runId, nodeId: 'n1', role: 'dev', generation: 1, attempt: 1, outcome: 'done' });
  assert.equal(late.verdict, 'stale');
});

test('1 个隔离 + 多 ready：隔离槽位仍占名额，不被复用', async () => {
  const s = setup(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'].map(id => mkNode(id)));
  await s.ctl.tick(); s.claimAll();
  const slot1 = s.hub.last('n1').slot;
  s.hub.set(s.hub.last('n1').id, { status: 'unknown' }); await s.ctl.tick();
  s.clock.t += 16 * 60 * 1000; await s.ctl.tick();
  for (const id of ['n2', 'n3', 'n4', 'n5']) await accept(s, id);
  const after = s.hub.dispatched.slice(5);
  assert.ok(after.every(d => d.slot !== slot1), '后续派发从不使用隔离槽位');
  assert.ok(after.some(d => d.run.nodeId === 'n8'));
  assert.ok(!s.hub.last('n9'), '1 个隔离 + 4 个运行 = 5，n9 等待');
});

test('blocked 隔离：blocked_unknown 的硬依赖后代暂停，无关节点继续', async () => {
  const s = setup([mkNode('a'), mkNode('b', ['a']), mkNode('c')]);
  await s.ctl.tick(); s.claimAll();
  s.receipt('a', 'dev', 'weird-outcome');
  assert.equal(s.runOf('a').status, 'blocked_unknown');
  await s.ctl.tick();
  assert.ok(!s.hub.last('b'), '后代暂停');
  await accept(s, 'c');
  assert.equal(s.ctl.snapshot().nodes.c.state, 'accepted');
  assert.equal(s.ctl.snapshot().nodes.a.state, 'blocked');
});

test('3 次失败先换打法（generation+1，记录原因与 WIP），换打法仍失败才 gate', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick();
  for (let i = 0; i < 3; i++) { s.claimAll(); s.receipt('a', 'dev', 'rework'); await s.ctl.tick(); }
  assert.equal(s.runOf('a').generation, 2, '第 3 次失败后换打法而非 gate');
  assert.equal(s.ctl.snapshot().nodes.a.state, 'dev');
  assert.ok(s.store.getRun(s.root.runId).publish.approachChanges.length === 1);
  assert.ok(s.wip.calls.some(c => c[0] === 'save'), '换打法前保存 WIP');
  for (let i = 0; i < 3; i++) { s.claimAll(); s.receipt('a', 'dev', 'rework'); await s.ctl.tick(); }
  assert.equal(s.ctl.snapshot().nodes.a.state, 'gated');
  assert.deepEqual(s.ctl.snapshot().slots, {}, 'gate 后槽位释放');
});

test('同节点失败重派保留槽位与改动（不触发 release）', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll();
  const slot = s.hub.last('a').slot;
  s.receipt('a', 'dev', 'failed'); await s.ctl.tick();
  assert.equal(s.runOf('a').attempt, 2);
  assert.equal(s.hub.last('a').slot, slot);
  assert.ok(!s.wip.calls.some(c => c[0] === 'release'));
});

// ---- #54 重启恢复回归：控制器进程重建后只靠 run.json 恢复 ----
import { createController } from '../src/dag-controller.mjs';
const restart = s => createController({ store: s.store, rootRunId: s.root.runId, hub: s.hub, rt: s.rt, wip: s.wip, publisher: s.publisher, now: () => s.clock.t });

test('unknown 后控制器重启：仍隔离并换槽恢复，旧晚到回执不覆盖 successor', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll();
  const first = s.runOf('a'); const oldReceipt = { advanceId: first.expectedAdvanceId, runId: first.runId, nodeId: 'a', role: 'dev', generation: 1, attempt: 1, outcome: 'done' };
  s.hub.set(first.hub.hubRunId, { status: 'unknown' });
  await s.ctl.tick();
  assert.equal(s.runOf('a').status, 'unknown');
  const dispatchedBefore = s.hub.dispatched.length;
  s.clock.t += 16 * 60 * 1000;
  const ctl2 = restart(s);                       // 模拟控制台重启
  await ctl2.tick();
  const next = s.runOf('a');
  assert.equal(next.attempt, 2, '重启后以新 attempt 恢复');
  assert.notEqual(next.slot, first.slot, '隔离原槽，换槽');
  assert.equal(s.hub.dispatched.length, dispatchedBefore + 1, '只补发一次，不重复派发');
  const late = s.store.advance(first.runId, oldReceipt);
  assert.equal(late.verdict, 'stale');
  assert.equal(s.runOf('a').attempt, 2);
  assert.notEqual(s.runOf('a').status, 'done', '旧回执不得覆盖 successor');
  await restart(s).tick();                       // 重复 tick 幂等
  assert.equal(s.hub.dispatched.length, dispatchedBefore + 1);
});

test('崩溃在 createNodeRun 与节点状态落盘之间：重启后收养既有 run，不抛 NODE_EXISTS 死锁、不重复建 run', async () => {
  const s = setup([mkNode('a')]);
  s.store.createNodeRun(s.root.runId, { nodeId: 'a', role: 'dev' }); // 崩溃遗留：run 已存在，节点仍 pending
  const ctl2 = restart(s);
  await ctl2.tick();
  assert.equal(ctl2.snapshot().nodes.a.state, 'dev');
  assert.equal(s.store.listRuns().filter(r => r.nodeId === 'a').length, 1);
  assert.equal(s.hub.dispatched.length, 1, '收养后补发一次');
  assert.ok(s.runOf('a').hub?.hubRunId);
});

test('Hub 已终态但回执未消费：重启对账时补处理合法回执；畸形回执保留 WIP 路径不砖化', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll();
  const run = s.runOf('a');
  const good = { advanceId: run.expectedAdvanceId, runId: run.runId, nodeId: 'a', role: 'dev', generation: 1, attempt: 1, outcome: 'done' };
  const realGet = s.hub.getRun.bind(s.hub);
  s.hub.getRun = async id => ({ ...(await realGet(id)), status: 'done', receipts: [{ malformed: true }, good] });
  await restart(s).tick();
  assert.equal(s.runOf('a').status, 'done', '合法回执被补消费');
  assert.ok(s.publisher.calls.some(c => c[0] === 'commitPr'), '进入发布流程');
  assert.ok(s.runOf('a').failures >= 1, '畸形回执计一次失败而非吞掉');
});

const designBaseline = () => ({
  designDigest: 'a'.repeat(64), manifestPath: 'docs/design/demo/design-manifest.json',
  manifest: { schema: 1, designId: 'demo', artifacts: [{ path: 'docs/design/demo/reference.png', sha256: 'b'.repeat(64) }], surfaces: [{ id: 'overview', route: '/', viewports: ['1440x900'], states: ['normal'], interactions: ['open'], referencePaths: ['docs/design/demo/reference.png'] }] },
  readOnlyPaths: ['docs/design/demo/design-manifest.json', 'docs/design/demo/reference.png'],
});

test('设计合同校验在占槽前按节点隔离，其他 ready 节点照常派发', async () => {
  const bad = mkNode('bad-ui'); bad.contract.design = { surfaceIds: ['missing'] };
  const good = mkNode('good-backend');
  const s = setup([bad, good], { designBaseline: designBaseline() });
  await s.ctl.tick();
  assert.ok(s.hub.last('good-backend'), '无关节点不得被坏 UI 合同阻断');
  assert.equal(s.hub.last('bad-ui'), undefined);
  assert.equal(s.rt.events.some(e => e[0] === 'prepare' && e[2] === 'bad-ui'), false);
  assert.equal(s.runOf('bad-ui'), undefined, '合同失败前不得创建节点 run');
  assert.match(s.ctl.snapshot().nodes['bad-ui'].lastError, /surface/);
});

test('UI worker 收到冻结的设计摘要与定向合同，新稿对象变化不影响旧 run', async () => {
  const ui = mkNode('ui'); ui.contract.design = { surfaceIds: ['overview'], states: ['normal'] };
  const backend = mkNode('backend');
  const baseline = designBaseline(); const s = setup([ui, backend], { designBaseline: baseline });
  await s.ctl.tick();
  const prompt = s.hub.last('ui').prompt;
  assert.match(prompt, /a{64}/);
  assert.match(prompt, /设计合同/);
  assert.match(prompt, /overview/);
  assert.doesNotMatch(s.hub.last('backend').prompt, /设计基线/);
  baseline.designDigest = 'c'.repeat(64);
  await s.ctl.tick();
  assert.match(s.hub.last('ui').prompt, /a{64}/, 'run 快照不得随外部新稿变化');
});

test('UI 证据丢失但 SHA 未变：自动补验并重新 review，不直接 merge', async () => {
  const ui = mkNode('ui'); ui.contract.design = { surfaceIds: ['overview'], states: ['normal'], interactions: ['open'] };
  const baseline = designBaseline(); const s = setup([ui], { designBaseline: baseline });
  s.publisher.verify = async input => {
    s.publisher.calls.push(['verify', input.nodeId]);
    return {
      ok: true, tests: { exitCode: 0 },
      designEvidence: { commit: input.commit, designDigest: baseline.designDigest, contractDigest: designContractDigest({ designDigest: baseline.designDigest, contract: ui.contract.design }), checks: [{ ok: true }] },
    };
  };
  await s.ctl.tick(); s.claimAll(); s.receipt('ui', 'dev', 'done'); await s.ctl.tick();
  assert.ok(s.hub.last('ui', 'review'));
  assert.match(s.hub.last('ui', 'review').prompt, /设计验证证据/);
  const snapshot = s.ctl.snapshot(); snapshot.nodes.ui.designEvidence = null;
  s.store.updateRun(s.root.runId, { publish: { nodes: snapshot.nodes, approachChanges: snapshot.approachChanges } });
  s.receipt('ui', 'review', 'accepted'); await s.ctl.tick();
  assert.equal(s.publisher.calls.filter(c => c[0] === 'verify').length, 2);
  assert.equal(s.publisher.calls.some(c => c[0] === 'merge'), false);
  assert.equal(s.runOf('ui', 'review').attempt, 2, '补验后必须重新独立审阅');
  s.receipt('ui', 'review', 'accepted'); await s.ctl.tick();
  assert.equal(s.publisher.calls.filter(c => c[0] === 'merge').length, 1);
});

test('设计 runner 设施抛错不计 worker 失败，下一 tick 同 attempt 自动重试', async () => {
  const ui = mkNode('ui'); ui.contract.design = { surfaceIds: ['overview'] };
  const s = setup([ui], { designBaseline: designBaseline() });
  const originalVerify = s.publisher.verify; let fail = true;
  s.publisher.verify = async input => {
    if (fail) throw new Error('browser unavailable');
    return { ok: true, tests: { exitCode: 0 }, designEvidence: { commit: input.commit, designDigest: 'a'.repeat(64), contractDigest: designContractDigest({ designDigest: 'a'.repeat(64), contract: ui.contract.design }), checks: [{ ok: true }] } };
  };
  await s.ctl.tick(); s.claimAll(); s.receipt('ui', 'dev', 'done'); await s.ctl.tick();
  assert.equal(s.runOf('ui', 'dev').attempt, 1);
  assert.equal(s.runOf('ui', 'dev').failures, 0);
  assert.match(s.ctl.snapshot().nodes.ui.lastError, /browser unavailable/);
  fail = false; await s.ctl.tick();
  assert.ok(s.hub.last('ui', 'review'));
  assert.equal(s.runOf('ui', 'dev').attempt, 1);
});

test('崩溃收养路径把 prepare 返回的实际 base commit 传给 commitPr', async () => {
  const s = setup([mkNode('a')]);
  s.store.createNodeRun(s.root.runId, { nodeId: 'a', role: 'dev' });
  const realPrepare = s.rt.prepare.bind(s.rt);
  s.rt.prepare = async input => ({ ...(await realPrepare(input)), baseCommit: 'frozen-abc' });
  let commitBase = null;
  s.publisher.commitPr = async input => {
    commitBase = input.base;
    return { prUrl: `https://x/pr/${input.nodeId}`, commit: `sha-${input.nodeId}` };
  };
  await s.ctl.tick();
  s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick();
  assert.equal(commitBase, 'frozen-abc', '崩溃收养不得把 origin/main 传给 scope 检查');
});

test('prepare base is persisted to the server-side root run before Hub dispatch', async () => {
  const ui = mkNode('a');
  const s = setup([ui]);
  const realPrepare = s.rt.prepare.bind(s.rt);
  s.rt.prepare = async input => ({ ...(await realPrepare(input)), baseCommit: 'f'.repeat(40) });
  await s.ctl.tick();
  assert.ok(s.hub.last('a'));
  const root = s.store.getRun(s.root.runId);
  assert.equal(root.publish.nodes.a.prepareBase, 'f'.repeat(40));
});

test('claimed crash window without a server-frozen base does not redispatch', async () => {
  const s = setup([mkNode('a')]);
  const run = s.store.createNodeRun(s.root.runId, { nodeId: 'a', role: 'dev' });
  s.store.claim(run.runId, { slot: 1 });
  await s.ctl.tick();
  assert.equal(s.hub.last('a'), undefined);
  assert.match(s.ctl.snapshot().nodes.a.lastError, /冻结 prepare base/);
});

test('轮询在途节点时记下 Hub 轮次号，供界面查执行 Agent 与用量', async () => {
  const s = setup([mkNode('n1')]);
  await s.ctl.tick();
  const sent = s.hub.last('n1');
  s.hub.set(sent.id, { status: 'claimed', hubRun: 4242 });
  await s.ctl.tick();
  assert.equal(s.runOf('n1').hub.hubRun, 4242);
});

test('审阅占位：他人占位时合并暂缓，节点保持待合并且记录原因；占位释放后下一 tick 自动合并', async () => {
  const s = setup([mkNode('n1')]);
  await s.ctl.tick();
  let claimed = true;
  const realMerge = s.publisher.merge.bind(s.publisher);
  s.publisher.merge = async a => {
    if (claimed) { const e = new Error('PR 正被 codex-9f94e800 审阅占位，暂缓合并'); e.code = 'REVIEW_CLAIMED'; throw e; }
    return realMerge(a);
  };
  s.claimAll(); s.receipt('n1', 'dev', 'done'); await s.ctl.tick();
  s.claimAll(); s.receipt('n1', 'review', 'accepted'); await s.ctl.tick();
  const st = () => s.ctl.snapshot().nodes.n1;
  assert.notEqual(st().state, 'accepted');
  assert.match(st().lastError || '', /审阅占位/);
  assert.notEqual(st().state, 'blocked', '占位不是失败，不能卡成 blocked');
  claimed = false;
  await s.ctl.tick();
  assert.equal(st().state, 'accepted');
  assert.equal(st().lastError, null);
});

test('审阅通过后 PR 被变基（head 变化）：不合并旧 SHA，改在新 head 补跑测试并重审后再合并', async () => {
  const s = setup([mkNode('a')]);
  const devSha = 'a'.repeat(40), rebased = 'b'.repeat(40);
  s.publisher.commitPr = async a => { s.publisher.calls.push(['commitPr', a.nodeId]); return { prUrl: 'https://x/pr/a', commit: devSha }; };
  s.publisher.fetchHead = async a => { s.publisher.calls.push(['fetchHead', a.nodeId]); return rebased; };
  let firstMerge = true;
  s.publisher.merge = async a => {
    s.publisher.calls.push(['merge', a.nodeId, a.commit]);
    if (firstMerge) { firstMerge = false; const error = new Error('远端 PR head 与已审 SHA 不一致'); error.code = 'HEAD_MISMATCH'; error.head = rebased; throw error; }
    return { mergeCommit: 'm-a' };
  };
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick();
  s.claimAll(); s.receipt('a', 'review', 'accepted'); await s.ctl.tick();
  // 第一次合并被拒：不落 accepted，commit 切到新 head，并挂起重审待办。
  let node = s.ctl.snapshot().nodes.a;
  assert.equal(node.state, 'review', '变基后回到审阅阶段而不是 accepted');
  assert.equal(node.commit, rebased, '审阅基准切到 PR 当前 head');
  assert.ok(s.hub.last('a', 'review'), '重审已派发');
  const prepares = s.rt.events.filter(e => e[0] === 'prepare' && e[2] === 'a');
  assert.equal(prepares.at(-1)[3], rebased, '重审槽位从新 head 起步');
  assert.equal(s.runOf('a', 'review').attempt, 2, '重审以新 attempt 进行');
  assert.ok(s.publisher.calls.some(c => c[0] === 'fetchHead'), '重审前先从远端取回变基后的 head');
  // 新 head 上必须补跑测试，再交给独立审阅裁决。
  s.claimAll(); s.receipt('a', 'review', 'accepted'); await s.ctl.tick();
  node = s.ctl.snapshot().nodes.a;
  assert.equal(node.state, 'accepted');
  const verifies = s.publisher.calls.filter(c => c[0] === 'verify');
  assert.equal(verifies.length, 2, '开发后 + 变基后各跑一次测试');
  assert.deepEqual(s.publisher.calls.filter(c => c[0] === 'merge').map(c => c[2]), [devSha, rebased], '第二次合并用新 head');
});

test('head 变化的错误不带合法 SHA：不采纳，按普通错误继续报（防止自造 SHA 绕过）', async () => {
  const s = setup([mkNode('a')]);
  s.publisher.commitPr = async a => ({ prUrl: 'https://x/pr/a', commit: 'a'.repeat(40) });
  s.publisher.merge = async a => { s.publisher.calls.push(['merge', a.nodeId, a.commit]); const error = new Error('bad head'); error.code = 'HEAD_MISMATCH'; error.head = 'not-a-sha'; throw error; };
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick();
  s.claimAll(); s.receipt('a', 'review', 'accepted'); await s.ctl.tick();
  const node = s.ctl.snapshot().nodes.a;
  assert.equal(node.state, 'review');
  assert.notEqual(node.commit, 'not-a-sha');
  assert.match(node.lastError || '', /bad head|不一致/, '错误仍出现在节点 lastError，交由卡住巡检');
});

test('变基重审的第 3 次尝试排队等待时不按“排队满次”取消，避免退回开发重做', async () => {
  const s = setup([mkNode('a')]);
  const sha = c => c.repeat(40);
  s.publisher.commitPr = async a => { s.publisher.calls.push(['commitPr', a.nodeId]); return { prUrl: 'https://x/pr/a', commit: sha('a') }; };
  const heads = ['b', 'c'].map(sha);
  let merges = 0;
  s.publisher.merge = async a => {
    s.publisher.calls.push(['merge', a.nodeId, a.commit]);
    if (merges < 2) { const error = new Error('head 变化'); error.code = 'HEAD_MISMATCH'; error.head = heads[merges]; merges += 1; throw error; }
    return { mergeCommit: 'm-a' };
  };
  s.publisher.fetchHead = async a => { s.publisher.calls.push(['fetchHead', a.nodeId]); return heads[Math.min(merges, 2) - 1]; };
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick();
  s.claimAll(); s.receipt('a', 'review', 'accepted'); await s.ctl.tick(); // 合并被拒（head=b）
  await s.ctl.tick(); // 释放+取回+重审 attempt 2
  s.claimAll(); s.receipt('a', 'review', 'accepted'); await s.ctl.tick(); // 补测后合并再被拒（head=c）
  await s.ctl.tick(); // 重审 attempt 3 派发（不 claim，保持 queued）
  const review = s.runOf('a', 'review');
  assert.equal(review.attempt, 3);
  assert.equal(review.attemptReason, 'rebase-review');
  await s.ctl.tick(); // 旧逻辑会在这里以 queued-attempts 取消并退回 dev
  assert.ok(!s.hub.cancelled.length, '重审队列等待不应被取消');
  assert.equal(s.hub.runs.get(s.hub.last('a', 'review').id).status, 'queued', 'Hub 侧仍是排队中');
  assert.equal(s.ctl.snapshot().nodes.a.state, 'review');
  assert.equal(s.runOf('a', 'dev').attempt, 1, '没有退回开发重做');
  // worker 接单后仍可完成审阅并合并
  s.claimAll(); s.receipt('a', 'review', 'accepted'); await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.state, 'accepted');
});

// ---- 2026-11-19 device-binding 卡住回归 ----
test('变基重审后审阅被取消：开发原槽位重试不得继承审阅基准（否则永远没有提交可发）', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll();
  s.receipt('a', 'dev', 'done'); await s.ctl.tick(); // 发布 → 派发审阅
  const review1 = s.runOf('a', 'review');
  assert.ok(review1);
  // 审阅通过，但远端 PR head 在审阅后被变基
  const rebasedHead = 'b'.repeat(40);
  s.publisher.fetchHead = async () => rebasedHead;
  s.publisher.merge = async () => { const error = new Error('远端 PR head 与已审 SHA 不一致'); error.code = 'HEAD_MISMATCH'; error.head = rebasedHead; throw error; };
  s.receipt('a', 'review', 'accepted');
  await s.ctl.tick();
  let n = s.store.getRun(s.root.runId).publish.nodes.a;
  assert.equal(n.commit, rebasedHead, '变基后以新 head 为审阅基准');
  // 下一轮走变基重审：释放槽位 + 在新 head prepare → prepareBase 被记成节点 commit
  await s.ctl.tick();
  n = s.store.getRun(s.root.runId).publish.nodes.a;
  assert.equal(n.prepareBase, rebasedHead);
  // 重审排队满次被取消，控制器退回开发重试
  const review2 = s.runOf('a', 'review');
  s.hub.set(review2.hub.hubRunId, { status: 'cancelled' });
  s.store.cancel(review2.runId, { reason: 'attempts-exhausted' });
  await s.ctl.tick();
  n = s.store.getRun(s.root.runId).publish.nodes.a;
  assert.notEqual(n.prepareBase, n.commit, '开发重试不得拿“等于节点提交”的审阅基准当基底');
  // 夹具控制器未注入 baseRef，默认基底是 origin/main（线上运行时为 refs/heads/<baseBranch>）。
  assert.equal(n.prepareBase, 'origin/main', '必须释放审阅槽位并在冻结基底重新 prepare');
  assert.equal(s.runOf('a', 'dev').attempt, 2);
  assert.ok(s.wip.calls.some(c => c[0] === 'release'), '换基底前按纪律释放槽位（WIP 保全）');
  assert.ok(s.hub.last('a'), '开发重试必须真正派发出去');
});

test('开发回执 done 但没有任何提交：按失败尝试重派，不原地重复抛错', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll();
  s.publisher.commitPr = async () => { const error = new Error('节点 a 没有任何提交可发 PR'); error.code = 'NOTHING_TO_PUBLISH'; throw error; };
  s.receipt('a', 'dev', 'done');
  await s.ctl.tick();
  assert.equal(s.runOf('a', 'dev').attempt, 2, '无提交属于一次失败尝试，必须换 attempt 重派');
  assert.ok(s.hub.last('a'), '重派开发而不是把同一个 done run 每轮重抛');
  assert.equal(s.ctl.snapshot().nodes.a.lastError, null, '已转为失败重试，不再记同一错误');
});

test('派发提示带逐字 advance 回执模板（缺 detail 会被 Hub 判 malformed）', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick();
  const dev = s.hub.last('a');
  const devRun = s.runOf('a');
  assert.match(dev.prompt, /"type":"dag\.node\.advance"/);
  assert.ok(dev.prompt.includes(`"advanceId":"${devRun.expectedAdvanceId}"`), '回执模板必须逐字带 expectedAdvanceId');
  assert.match(dev.prompt, /"runId":"[^"]+"/);
  assert.match(dev.prompt, /"nodeId":"a"/);
  assert.match(dev.prompt, /"role":"dev"/);
  assert.match(dev.prompt, /"generation":1,"attempt":1/);
  assert.match(dev.prompt, /"outcome":"done"/);
  s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick();
  const review = s.hub.last('a', 'review');
  const reviewRun = s.runOf('a', 'review');
  assert.match(review.prompt, /"type":"dag\.auto\.review\.advance"/);
  assert.ok(review.prompt.includes(`"advanceId":"${reviewRun.expectedAdvanceId}"`));
  assert.match(review.prompt, /"role":"review"/);
  assert.match(review.prompt, /"outcome":"accepted"/);
});
