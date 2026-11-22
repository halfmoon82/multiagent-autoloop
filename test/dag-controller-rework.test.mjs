// PR #52 返工回归：blocked 复活、无 hubRunId 槽位 fail closed、abandoned review 原 commit 重派、verify 改槽位。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkNode, setup } from './dag-fakes.mjs';

async function blockDev(s, id = 'a') {
  await s.ctl.tick(); s.claimAll();
  await s.blockNow(id, 'dev'); // 存量 blocked_unknown 注入（回执韧性后状态机不再产生）
  await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes[id].state, 'blocked');
}

test('blocked 复活：blocked-resolved 以同节点新 attempt 重派，完成后根 run done 且项目锁释放', async () => {
  const s = setup([mkNode('a')]);
  await blockDev(s);
  assert.throws(() => s.ctl.revive('a', 'whatever'), /reason/);
  assert.equal(s.ctl.snapshot().nodes.a.slot, null);
  s.ctl.revive('a', 'blocked-resolved', { evidence: 'Hub 卡片已消除' });
  await s.ctl.tick();
  const run = s.runOf('a');
  assert.equal(run.attempt, 2); assert.equal(run.attemptReason, 'blocked-resolved');
  assert.equal(run.status, 'claimed'); assert.equal(s.ctl.snapshot().nodes.a.state, 'dev');
  s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick();
  s.claimAll(); s.receipt('a', 'review', 'accepted'); await s.ctl.tick();
  assert.equal(s.store.getRun(s.root.runId).status, 'done');
  assert.equal(s.store.slotUsage('/proj'), 0);
});

test('blocked 复活：change-approach 换模型并留痕；复活前节点仍可取消', async () => {
  const s = setup([mkNode('a'), mkNode('b')]);
  await blockDev(s);
  s.ctl.revive('a', 'change-approach'); await s.ctl.tick();
  assert.equal(s.runOf('a').attemptReason, 'change-approach');
  assert.ok(s.ctl.snapshot().approachChanges.some(c => c.nodeId === 'a'));
  const t = setup([mkNode('a')]);
  await blockDev(t); t.ctl.cancel(); await t.ctl.tick();
  assert.equal(t.store.getRun(t.root.runId).status, 'cancelled');
});

test('blocked 的 review 复活：新槽位从原 commit 重派审阅，不重跑开发', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick(); s.claimAll();
  await s.blockNow('a', 'review'); await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.state, 'blocked');
  s.ctl.revive('a', 'blocked-resolved'); await s.ctl.tick();
  assert.equal(s.runOf('a', 'review').attempt, 2);
  assert.equal(s.hub.dispatched.filter(d => d.run.role === 'dev').length, 1, '没有重跑开发');
  assert.ok(s.rt.events.some(e => e[0] === 'prepare' && e[3] === 'sha-a'), '以原 commit 为基准准备槽位');
});

test('releaseNode：同槽位存在无 hubRunId 的存活 run 时 fail closed，不放槽位', async () => {
  const s = setup([mkNode('a')]);
  s.hub.dispatch = async () => { throw new Error('hub down'); };
  await s.ctl.tick();
  assert.equal(s.runOf('a').status, 'claimed'); assert.ok(!s.runOf('a').hub?.hubRunId);
  assert.equal(await s.ctl.releaseNode('a'), false);
  assert.equal(s.wip.calls.filter(c => c[0] === 'release').length, 0);
  assert.equal(s.store.slotUsage('/proj'), 1);
});

test('abandoned 的 review run 以原 commit 重派审阅（不退回 dev）；abandoned dev 仍重派 dev', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick(); s.claimAll();
  const rv = s.runOf('a', 'review'); s.hub.set(s.hub.last('a', 'review').id, { status: 'unknown' }); await s.ctl.tick();
  s.store.releaseSlot(rv.runId, { now: s.clock.t + 25 * 3600e3, offlineSince: s.clock.t - 1, workerOnline: false, processGroupVerified: true });
  await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.state, 'review');
  assert.equal(s.runOf('a', 'review').attempt, 2);
  assert.equal(s.hub.dispatched.filter(d => d.run.role === 'dev').length, 1);
  assert.equal(s.publisher.calls.filter(c => c[0] === 'commitPr').length, 1);
});

test('verify 改动了槽位状态（slotStateChanged）→ 节点 blocked，不进入审阅', async () => {
  const s = setup([mkNode('a')]);
  s.publisher.verify = async () => ({ ok: true, tests: { exitCode: 0 }, slotStateChanged: true });
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.state, 'blocked');
  assert.ok(!s.hub.last('a', 'review'));
});
