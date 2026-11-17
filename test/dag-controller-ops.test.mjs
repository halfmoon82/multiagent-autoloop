// 控制器：取消顺序、slot-release 等终态、两控制器互斥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkNode, setup } from './dag-fakes.mjs';
import { acquireControllerLock } from '../src/dag-lock.mjs';

test('取消：先取消 queued/claimed → 等终态 → slot-release 恢复 5 槽，根 run cancelled', async () => {
  const s = setup(['a', 'b', 'c'].map(id => mkNode(id)));
  await s.ctl.tick(); s.claimAll();
  s.ctl.cancel();
  await s.ctl.tick();
  assert.equal(s.hub.cancelled.length, 3);
  assert.equal(s.wip.calls.filter(c => c[0] === 'release').length, 3);
  assert.deepEqual(s.ctl.snapshot().slots, {});
  assert.equal(s.store.getRun(s.root.runId).status, 'cancelled');
  assert.equal(s.store.slotUsage('/proj'), 0, '5 槽全部恢复');
});

test('取消：Hub run 取消后仍未终态（worker 离线）时不 slot-release，等待', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll();
  const id = s.hub.last('a').id;
  s.hub.cancel = async hid => { s.hub.cancelled.push(hid); }; // 取消只留 cancel_at，状态不变
  s.ctl.cancel(); await s.ctl.tick();
  assert.equal(s.wip.calls.filter(c => c[0] === 'release').length, 0);
  assert.equal(s.store.getRun(s.root.runId).status, 'queued');
  s.hub.set(id, { status: 'cancelled' }); await s.ctl.tick();
  assert.equal(s.wip.calls.filter(c => c[0] === 'release').length, 1);
  assert.equal(s.store.getRun(s.root.runId).status, 'cancelled');
});

test('gate 后释放槽位恢复名额，被依赖后代暂停、无关节点继续', async () => {
  const s = setup([mkNode('a'), mkNode('b', ['a']), mkNode('c')]);
  s.ctl = s.ctl; await s.ctl.tick();
  const approach = [];
  for (let g = 0; g < 2; g++) for (let i = 0; i < 3; i++) { s.claimAll(); s.receipt('a', 'dev', 'failed'); await s.ctl.tick(); approach.push(i); }
  assert.equal(s.ctl.snapshot().nodes.a.state, 'gated');
  assert.ok(!Object.values(s.ctl.snapshot().slots).includes('a'));
  assert.ok(!s.hub.last('b'));
  s.claimAll(); s.receipt('c', 'dev', 'done'); await s.ctl.tick();
  assert.ok(s.hub.last('c', 'review'));
});

test('release 前 Hub run 非终态：放弃释放，等待下一轮', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick();
  s.claimAll(); s.receipt('a', 'review', 'accepted');
  const hid = s.hub.last('a', 'review').id; s.hub.set(hid, { status: 'claimed' }); // 恢复成 claimed
  await s.ctl.tick();
  assert.equal(s.wip.calls.filter(c => c[0] === 'release').length, 0);
  assert.equal(s.ctl.snapshot().nodes.a.state, 'accepted');
  assert.deepEqual(s.ctl.snapshot().slots, { 1: 'a' });
});

test('两控制器互斥：同 run 的进程锁只能一个持有；陈旧锁（死进程）可接管', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dag-lock-'));
  const a = acquireControllerLock({ directory: dir, runId: 'r1' });
  assert.equal(a.acquired, true);
  const b = acquireControllerLock({ directory: dir, runId: 'r1' });
  assert.equal(b.acquired, false); assert.match(b.reason, /已有控制器/);
  assert.equal(acquireControllerLock({ directory: dir, runId: 'r2' }).acquired, true, '不同 run 互不影响');
  a.release();
  assert.equal(acquireControllerLock({ directory: dir, runId: 'r1' }).acquired, true);
  const stale = acquireControllerLock({ directory: dir, runId: 'r9', pid: 2 ** 22 - 3 });
  assert.equal(stale.acquired, true);
  assert.equal(acquireControllerLock({ directory: dir, runId: 'r9' }).acquired, true, '持锁 pid 不存在 → 接管');
});
