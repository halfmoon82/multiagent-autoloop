// #54 接线：控制器自动复查 blocked 证据，证据消失即自动复活（无需 gate/用户）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkNode, setup } from './dag-fakes.mjs';

// 存量 blocked_unknown 场景（2026-11-22 回执韧性后 advance 不再产生该终态，用注入模拟旧 run）。
async function blockDev(s) {
  await s.ctl.tick(); s.claimAll();
  await s.blockNow('a', 'dev');
  await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.state, 'blocked');
}

test('自动复查：证据仍在时不复活，不重复派发', async () => {
  let checks = 0;
  const s = setup([mkNode('a')], { blockedEvidence: async () => { checks++; return { blocked: true }; } });
  await blockDev(s);
  const before = s.hub.dispatched.length;
  await s.ctl.tick(); await s.ctl.tick();
  assert.ok(checks >= 2, 'blocked 节点应被周期复查');
  assert.equal(s.hub.dispatched.length, before, '证据仍在不得复活');
  assert.equal(s.runOf('a').status, 'blocked_unknown');
  assert.equal(s.ctl.snapshot().nodes.a.state, 'blocked');
});

test('自动复查：证据消失即以 blocked-resolved 自动复活，新 run 记录 revivedFrom', async () => {
  let evidence = { blocked: true };
  const s = setup([mkNode('a')], { blockedEvidence: async () => evidence });
  await blockDev(s);
  const first = s.runOf('a');
  evidence = { blocked: false, detail: 'Hub 阻塞卡片已消除' };
  await s.ctl.tick();
  const run = s.runOf('a');
  assert.equal(run.attempt, 2);
  assert.equal(run.attemptReason, 'blocked-resolved');
  assert.equal(run.revivedFrom, first.runId);
  assert.equal(s.ctl.snapshot().nodes.a.state, 'dev');
  assert.equal(s.runOf('a').status, 'claimed');
});

test('自动复查：布尔返回也支持（true=仍阻塞，false=证据消失）', async () => {
  let blocked = true;
  const s = setup([mkNode('a')], { blockedEvidence: async () => blocked });
  await blockDev(s);
  await s.ctl.tick();
  assert.equal(s.hub.dispatched.length, 1, '布尔 true 不复活');
  blocked = false;
  await s.ctl.tick();
  assert.equal(s.hub.dispatched.length, 2, '布尔 false 复活重派');
  assert.equal(s.runOf('a').attempt, 2);
});
