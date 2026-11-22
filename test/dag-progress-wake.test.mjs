// DAG 状态变化唤醒（无模型）：只在需要调度会话动手的变化时才叫醒——blocked、gated、整条链完成。
// 正常推进（dev/review/accepted）控制器自己会往下走，叫醒只会让调度会话空转一轮（2026-11-19 实测 17 次里大半空转）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkNode, setup } from './dag-fakes.mjs';
import { ROOT_NODE } from '../src/dag-run.mjs';
import { buildProgressEvent, createProgressNotifier } from '../src/dag-stall.mjs';

const wakeOf = snap => (snap.progress || []).map(p => `${p.nodeId}:${p.to}`);
const rootRuns = s => s.store.listRuns().filter(run => run.nodeId === ROOT_NODE);

// 推到 blocked：存量 blocked_unknown 注入（回执韧性后状态机不再产生该终态）。
async function blockDev(s, id = 'a') {
  await s.ctl.tick(); s.claimAll();
  await s.blockNow(id, 'dev');
  return s.ctl.tick();
}
// 推到整条链完成：每个节点 dev done → review accepted。
async function finishAll(s, ids) {
  await s.ctl.tick(); s.claimAll();
  for (const id of ids) s.receipt(id, 'dev', 'done');
  await s.ctl.tick(); s.claimAll();
  for (const id of ids) s.receipt(id, 'review', 'accepted');
  return s.ctl.tick();
}

test('正常推进不叫醒：派发进 dev、dev 完成进 review 都没有 progress', async () => {
  const s = setup([mkNode('a'), mkNode('b')]);
  const first = await s.ctl.tick();
  assert.deepEqual(wakeOf(first), [], '派发进 dev 是控制器自己的动作，不叫醒');
  s.claimAll(); s.receipt('a', 'dev', 'done');
  const second = await s.ctl.tick();
  assert.deepEqual(wakeOf(second), [], 'dev 完成进 review 不叫醒');
});

test('节点验收（accepted）不叫醒', async () => {
  const s = setup([mkNode('a'), mkNode('b', ['a'])]);
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done');
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'review', 'accepted');
  const snap = await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.state, 'accepted');
  assert.deepEqual(wakeOf(snap), [], '验收后控制器会放行后续节点，不需要调度会话');
});

test('blocked 叫醒；同状态不重复报', async () => {
  const s = setup([mkNode('a')]);
  const snap = await blockDev(s);
  assert.equal(s.ctl.snapshot().nodes.a.state, 'blocked');
  assert.deepEqual(wakeOf(snap), ['a:blocked']);
  const again = await s.ctl.tick();
  assert.deepEqual(wakeOf(again), [], '仍是 blocked，不再报');
});

test('gated 叫醒（等待人工决策）', async () => {
  const s = setup([mkNode('a')]);
  for (let i = 0; i < 2; i++) { await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'failed'); await s.ctl.tick(); }
  s.claimAll();
  await s.blockNow('a', 'dev');
  await s.ctl.tick();
  s.ctl.revive('a', 'blocked-resolved');
  const snap = await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.state, 'gated');
  assert.ok(wakeOf(snap).includes('a:gated'));
});

test('整条链完成叫醒一次：progress 里带 __root__:done，之后不再报', async () => {
  const s = setup([mkNode('a')]);
  const snap = await finishAll(s, ['a']);
  assert.equal(s.store.getRun(s.root.runId).status, 'done');
  assert.deepEqual(wakeOf(snap), ['__root__:done']);
  const after = await s.ctl.tick();
  assert.deepEqual(wakeOf(after), [], '终态后 tick 直接返回，不再报');
});

test('事件发往调度会话通道并去敏；通知方按事件 ID 去重', async () => {
  const posted = []; const sent = new Set();
  const s = setup([mkNode('a')]);
  const snap = await blockDev(s);
  const ev = buildProgressEvent(rootRuns(s)[0], snap);
  assert.equal(ev.type, 'scheduling.message');
  assert.match(ev.id, /^console:dag-progress:/);
  assert.equal(ev.subject, `scheduling:dag:${s.root.runId}`);
  assert.doesNotMatch(ev.id + ev.subject, /\s/);
  // 同一批 progress 重复调用生成同一 ID（幂等）；不同批变化生成不同 ID。
  assert.equal(buildProgressEvent(rootRuns(s)[0], snap).id, ev.id);
  const other = buildProgressEvent(rootRuns(s)[0], { ...snap, progress: [{ nodeId: 'a', from: 'dev', to: 'gated', at: 1 }] });
  assert.notEqual(other.id, ev.id, '状态变化不同则事件 ID 不同');
  const notify = createProgressNotifier({ post: async e => posted.push(e), sent });
  await notify(rootRuns(s)[0], snap);
  await notify(rootRuns(s)[0], snap);
  assert.equal(posted.length, 1);
});

test('同一节点两次进入 blocked（中间被复活），事件 ID 不同，各唤醒一次', async () => {
  const s = setup([mkNode('a')]);
  const first = await blockDev(s);
  assert.deepEqual(wakeOf(first), ['a:blocked']);
  s.clock.t += 60_000;
  s.ctl.revive('a', 'blocked-resolved');
  await s.ctl.tick(); s.claimAll();
  await s.blockNow('a', 'dev');
  s.clock.t += 60_000;
  const second = await s.ctl.tick();
  assert.deepEqual(wakeOf(second), ['a:blocked']);
  const sent = new Set(); const posted = [];
  const notify = createProgressNotifier({ post: async e => posted.push(e), sent });
  await notify(rootRuns(s)[0], first); await notify(rootRuns(s)[0], second);
  assert.equal(posted.length, 2, '两次都要唤醒');
});

test('通知投递失败只记日志，不影响 tick 结果', async () => {
  const s = setup([mkNode('a')]);
  const notify = createProgressNotifier({ post: async () => { throw new Error('hub down'); }, log: () => {} });
  const snap = await blockDev(s);
  await assert.doesNotReject(() => notify(rootRuns(s)[0], snap));
});
