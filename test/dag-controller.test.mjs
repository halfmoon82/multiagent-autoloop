import test from 'node:test';
import assert from 'node:assert/strict';
import { mkNode, setup } from './dag-fakes.mjs';

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
