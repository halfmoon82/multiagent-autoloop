// DAG 节点卡住发现：控制器记录持续报错，无模型巡检把超阈值的卡住交给调度会话。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkNode, setup } from './dag-fakes.mjs';
import { ROOT_NODE } from '../src/dag-run.mjs';
import { findDagStalls, findDagGated, findDagClaimedStalls, CLAIMED_STALL_THRESHOLD_MS, buildStallEvent, sweepDagStalls, createDagStallSweeper, STALL_THRESHOLD_MS } from '../src/dag-stall.mjs';

const pushFails = s => { s.publisher.commitPr = async () => { throw new Error("git push failed: could not read Username for 'https://github.com': terminal prompts disabled"); }; };
const toReview = async s => { await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done'); };
const rootRuns = s => s.store.listRuns().filter(run => run.nodeId === ROOT_NODE);

test('控制器：同一错误连续出现时保留首次时间并累计次数，恢复后清空', async () => {
  const s = setup([mkNode('a')]);
  await toReview(s); pushFails(s);
  await s.ctl.tick();
  const first = s.ctl.snapshot().nodes.a;
  assert.match(first.lastError, /could not read Username/);
  assert.equal(first.errorSince, s.clock.t);
  assert.equal(first.errorCount, 1);
  const since = s.clock.t;
  s.clock.t += 60_000; await s.ctl.tick();
  s.clock.t += 60_000; await s.ctl.tick();
  const later = s.ctl.snapshot().nodes.a;
  assert.equal(later.errorSince, since, '同一错误不重置首次时间');
  assert.equal(later.errorCount, 3);
  s.publisher.commitPr = async () => { throw new Error('另一个错误'); };
  s.clock.t += 60_000; await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.errorSince, s.clock.t, '换了错误就重新计时');
  assert.equal(s.ctl.snapshot().nodes.a.errorCount, 1);
  delete s.publisher.commitPr; s.publisher.commitPr = async a => ({ prUrl: `https://x/pr/${a.nodeId}`, commit: 'sha' });
  s.clock.t += 60_000; await s.ctl.tick();
  const ok = s.ctl.snapshot().nodes.a;
  assert.equal(ok.lastError, null);
  assert.equal(ok.errorSince, undefined);
  assert.equal(ok.errorCount, undefined);
});

test('巡检：未到阈值不报；超过阈值报出节点、项目与错误原文', async () => {
  const s = setup([mkNode('a'), mkNode('b')]);
  await toReview(s); pushFails(s);
  await s.ctl.tick();
  assert.deepEqual(findDagStalls(rootRuns(s), { now: s.clock.t + STALL_THRESHOLD_MS - 1 }), []);
  const stalls = findDagStalls(rootRuns(s), { now: s.clock.t + STALL_THRESHOLD_MS });
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].nodeId, 'a');
  assert.equal(stalls[0].project, '/proj');
  assert.equal(stalls[0].runId, s.root.runId);
  assert.match(stalls[0].error, /could not read Username/);
});

test('巡检：终态 DAG 不报', async () => {
  const s = setup([mkNode('a')]);
  await toReview(s); pushFails(s); await s.ctl.tick();
  s.store.finishRoot(s.root.runId, 'cancelled');
  assert.deepEqual(findDagStalls(rootRuns(s), { now: s.clock.t + STALL_THRESHOLD_MS * 10 }), []);
});

test('控制器：推进步骤自己写入的错误（未抛出）不被同轮清空，能累计成卡住', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick();
  // 模拟派发中断：节点 run 已 claimed 但中台从未接单（无 hubRunId），且丢了冻结 prepare base
  const run = s.runOf('a');
  assert.equal(run.status, 'claimed');
  s.store.updateRun(run.runId, { hub: { hubRunId: undefined } });
  const root = s.store.getRun(s.root.runId);
  delete root.publish.nodes.a.prepareBase;
  s.store.updateRun(s.root.runId, { publish: { nodes: root.publish.nodes } });
  await s.ctl.tick();
  const since = s.clock.t;
  s.clock.t += 60_000; await s.ctl.tick();
  const n = s.ctl.snapshot().nodes.a;
  assert.match(n.lastError || '', /prepare base/);
  assert.equal(n.errorSince, since);
  assert.equal(n.errorCount, 2);
});

test('巡检：正在取消的 DAG 不报旧错误', async () => {
  const s = setup([mkNode('a')]);
  await toReview(s); pushFails(s); await s.ctl.tick();
  s.store.updateRun(s.root.runId, { publish: { cancelRequested: true } });
  assert.deepEqual(findDagStalls(rootRuns(s), { now: s.clock.t + STALL_THRESHOLD_MS * 10 }), []);
});

test('事件：发往调度会话通道，同一次卡住事件 ID 稳定，错误里的凭证被抹掉', () => {
  const stall = { runId: 'dagrun-x', planId: 'p1', project: '/proj', nodeId: 'a', since: 1000, count: 7,
    error: 'push https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r.git failed; token gho_ABCDEFGHIJKLMNOPQRSTUV1234567890ab' };
  const event = buildStallEvent(stall);
  assert.equal(event.type, 'scheduling.message');
  assert.equal(event.subject, 'scheduling:dag-stall:dagrun-x');
  assert.equal(event.id, 'console:dag-stall:dagrun-x:a:1000');
  assert.equal(buildStallEvent({ ...stall, count: 9 }).id, event.id, '次数变化不产生新事件');
  assert.doesNotMatch(event.id + event.subject, /\s/);
  const detail = JSON.parse(event.detail);
  assert.equal(detail.project, '/proj');
  assert.match(detail.text, /dagrun-x/);
  assert.match(detail.text, /本轮结束/);
  assert.doesNotMatch(event.detail, /ghp_|gho_|bot:/);
  assert.ok(Buffer.byteLength(event.detail) <= 4000);
});

test('巡检器：从 dag-runs 目录读真实文件，用来源密钥投到 /v1/events，重复 tick 不重投', async () => {
  const s = setup([mkNode('a')]);
  await toReview(s); pushFails(s); await s.ctl.tick();
  const calls = [];
  const hub = async (config, url, opts) => { calls.push({ url, opts }); return { event: 42 }; };
  const realNow = Date.now; Date.now = () => s.clock.t + STALL_THRESHOLD_MS;
  try {
    const sweeper = createDagStallSweeper({ config: { root: '/unused' }, directory: s.directory, hub, log: () => {} });
    await sweeper.tick(); await sweeper.tick();
  } finally { Date.now = realNow; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/events');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.auth, 'source');
  assert.equal(calls[0].opts.body.type, 'scheduling.message');
});

test('sweep：只为新卡住发一次事件；发送失败下轮重试', async () => {
  const s = setup([mkNode('a')]);
  await toReview(s); pushFails(s); await s.ctl.tick();
  const posted = []; let fail = true; const sent = new Set();
  const post = async event => { if (fail) throw new Error('hub down'); posted.push(event); return { event: 1 }; };
  const now = s.clock.t + STALL_THRESHOLD_MS;
  const r1 = await sweepDagStalls({ runs: rootRuns(s), post, sent, now });
  assert.equal(posted.length, 0); assert.equal(r1.errors.length, 1);
  fail = false;
  await sweepDagStalls({ runs: rootRuns(s), post, sent, now });
  await sweepDagStalls({ runs: rootRuns(s), post, sent, now: now + 60_000 });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].id, `console:dag-stall:${s.root.runId}:a:${s.clock.t}`);
});

test('findDagGated：gated 节点超过阈值才报，有 gateAt 用 gateAt，没有按已达阈值处理', () => {
  const now = 1_000_000_000_000;
  const run = { runId: 'r1', nodeId: ROOT_NODE, status: 'running', project: '/p', planId: 'p1', publish: { nodes: {
    fresh: { state: 'gated', gateAt: now - 1000, gateReason: 'x' },
    old: { state: 'gated', gateAt: now - STALL_THRESHOLD_MS - 1, gateReason: 'y' },
    legacy: { state: 'gated', gateReason: 'z' },
    busy: { state: 'gated', gateAt: 0, gateReason: 'w', todo: { kind: 'revive' } },
  } } };
  const gated = findDagGated([run], { now });
  assert.deepEqual(gated.map(s => s.nodeId).sort(), ['legacy', 'old']);
  assert.equal(gated.find(s => s.nodeId === 'old').since, now - STALL_THRESHOLD_MS - 1);
});

test('sweep：gated 节点也唤醒调度会话，事件走同一去重通道', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick();
  // 满 3 次失败 → 换打法再满 3 次 → gate（等待人工决策）
  for (let g = 0; g < 2; g++) for (let i = 0; i < 3; i++) { s.claimAll(); s.receipt('a', 'dev', 'failed'); await s.ctl.tick(); }
  assert.equal(s.ctl.snapshot().nodes.a.state, 'gated');
  const posted = []; const sent = new Set();
  const post = async event => { posted.push(event); return { event: 1 }; };
  await sweepDagStalls({ runs: rootRuns(s), post, sent, now: s.clock.t + STALL_THRESHOLD_MS });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'scheduling.message');
  assert.match(JSON.parse(posted[0].detail).text, /a（状态 gated）/);
});

test('gated 节点受控复活：调度会话修好后 revive 回 dev/review，不留在死胡同', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick();
  for (let g = 0; g < 2; g++) for (let i = 0; i < 3; i++) { s.claimAll(); s.receipt('a', 'dev', 'failed'); await s.ctl.tick(); }
  assert.equal(s.ctl.snapshot().nodes.a.state, 'gated');
  // gated 状态下 revive 的 reason 走 gated-resolved（内部必须换打法，因为尝试已满）
  s.ctl.revive('a', 'gated-resolved', { evidence: '调度会话已修好根因' });
  await s.ctl.tick();
  const n = s.ctl.snapshot().nodes.a;
  assert.equal(n.state, 'dev');
  assert.equal(s.runOf('a').generation, 3, '换新代');
  assert.equal(s.runOf('a').attemptReason, 'change-approach');
  assert.ok(s.hub.last('a'), '已重新派发');
});

test('gated 拒绝 blocked-resolved 复活（与 blocked 的语义区分）', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick();
  for (let g = 0; g < 2; g++) for (let i = 0; i < 3; i++) { s.claimAll(); s.receipt('a', 'dev', 'failed'); await s.ctl.tick(); }
  assert.equal(s.ctl.snapshot().nodes.a.state, 'gated');
  assert.throws(() => s.ctl.revive('a', 'blocked-resolved'), /REVIVE_REASON_REQUIRED|只能是/);
});

test('queued 超时巡检：节点已派发但 worker 未接单超阈值 → 告警给调度会话', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll(); // 派发并被 worker 接单 → claimed，但 worker 不回执
  assert.equal(s.runOf('a').status, 'claimed');
  // 未达阈值不报（now 只比 since 晚 1ms）
  assert.deepEqual(findDagClaimedStalls(s.store.listRuns(), { now: Date.now() + 1 }), []);
  // 超阈值报
  const stalled = findDagClaimedStalls(s.store.listRuns(), { now: Date.now() + CLAIMED_STALL_THRESHOLD_MS });
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].nodeId, 'a');
  assert.equal(stalled[0].state, 'dev');
  assert.match(stalled[0].error, /claimed.*未回执/);
  // 同一 since 只报一次
  const posted = []; const sent = new Set();
  const post = async e => { posted.push(e); return { event: 1 }; };
  await sweepDagStalls({ runs: s.store.listRuns(), post, sent, now: Date.now() + CLAIMED_STALL_THRESHOLD_MS });
  await sweepDagStalls({ runs: s.store.listRuns(), post, sent, now: Date.now() + CLAIMED_STALL_THRESHOLD_MS });
  const stallPosts = posted.filter(e => e.id.includes('dag-stall'));
  assert.equal(stallPosts.length, 1, '同一 since 只报一次');
  assert.match(JSON.parse(stallPosts[0].detail).text, /控制器不会自动重试/);
});

test('queued 超时巡检：终态/新 run 不误报', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick();
  // dev run 已 done（终态），review run claimed 未达阈值 → 都不报
  assert.equal(s.runOf('a').status, 'done');
  assert.equal(s.runOf('a', 'review').status, 'claimed');
  assert.deepEqual(findDagClaimedStalls(s.store.listRuns(), { now: Date.now() + 1000 }), [], '终态+未达阈值不报');
});
