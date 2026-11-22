// #54 接线：revive 触发 CHANGE_APPROACH_REQUIRED 时自动升级 gate，避免 tick 空转重试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkNode, setup } from './dag-fakes.mjs';

// 推到 attempt=3 的存量 blocked_unknown：两次 failed 重派后，第三次以旧 run 注入阻塞（回执韧性后状态机不再产生）。
async function blockAtThirdAttempt(s) {
  for (let i = 0; i < 2; i++) {
    await s.ctl.tick(); s.claimAll();
    s.receipt('a', 'dev', 'failed');
    await s.ctl.tick();
  }
  s.claimAll();
  await s.blockNow('a', 'dev');
  await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.state, 'blocked');
  assert.equal(s.runOf('a').attempt, 3);
}

test('手动 revive 满 3 次触发 CHANGE_APPROACH_REQUIRED：自动升级 gate，后续 tick 不空转', async () => {
  const s = setup([mkNode('a')]);
  await blockAtThirdAttempt(s);
  const dispatched = s.hub.dispatched.length;
  const slot = s.ctl.snapshot().nodes.a.slot;
  assert.equal(slot, null, 'blocked 时已释放槽位');

  s.ctl.revive('a', 'blocked-resolved');
  await s.ctl.tick();
  const snap = s.ctl.snapshot().nodes.a;
  assert.equal(snap.state, 'gated', '自动升级为等待人工决策');
  assert.match(snap.gateReason, /换打法|auto-escalated/);
  assert.equal(snap.todo, null, '待办清空，不再复读');
  assert.deepEqual(s.ctl.snapshot().slots, {}, '升级 gate 后槽位释放');

  await s.ctl.tick(); await s.ctl.tick();
  assert.equal(s.hub.dispatched.length, dispatched, '后续 tick 不空转重试');
  assert.equal(s.ctl.snapshot().nodes.a.state, 'gated');
});

test('自动复查在满 3 次时同样自动升级 gate', async () => {
  let evidence = { blocked: true };
  const s = setup([mkNode('a')], { blockedEvidence: async () => evidence });
  await blockAtThirdAttempt(s);
  evidence = { blocked: false };
  await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.state, 'gated');
  assert.match(s.ctl.snapshot().nodes.a.gateReason, /换打法|auto-escalated/);
});

test('revive change-approach 在满 3 次时换打法（generation+1），不误升级 gate', async () => {
  const s = setup([mkNode('a')], { chooseApproach: () => ({ reason: '换模型 K3', model: 'k3' }) });
  await blockAtThirdAttempt(s);
  s.ctl.revive('a', 'change-approach');
  await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.state, 'dev');
  assert.equal(s.runOf('a').generation, 2);
  assert.equal(s.runOf('a').attemptReason, 'change-approach');
  assert.ok(s.ctl.snapshot().approachChanges.some(c => c.nodeId === 'a'));
});
