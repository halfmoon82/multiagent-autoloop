// #54 接线：reattempt 中 prepare/send 抛错后 run 滞留 queued，节点静默卡住——下一 tick 补发。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkNode, setup } from './dag-fakes.mjs';

// 只在第 N 次 prepare 抛错，模拟发布/磁盘瞬时故障。
function failPrepareOnce(s) {
  const real = s.rt.prepare;
  let armed = false;
  s.rt.prepare = async (...args) => {
    if (armed) { armed = false; throw new Error('prepare boom'); }
    return real(...args);
  };
  return () => { armed = true; };
}

test('reattempt prepare 抛错后 queued 无 hubRunId：下一 tick 补发，不静默卡住', async () => {
  const s = setup([mkNode('a')]);
  const failNext = failPrepareOnce(s);
  await s.ctl.tick(); s.claimAll();
  await s.blockNow('a', 'dev');             // attempt1 存量阻塞（回执韧性后状态机不再产生）
  await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.a.state, 'blocked');
  failNext();
  s.ctl.revive('a', 'blocked-resolved');
  await s.ctl.tick();                       // reattempt → prepare 抛错 → attempt2 queued
  const run = s.runOf('a');
  assert.equal(run.attempt, 2);
  assert.equal(run.status, 'queued');
  assert.ok(!run.hub?.hubRunId, 'send 未执行，没有 hubRunId');
  assert.equal(s.ctl.snapshot().nodes.a.state, 'dev');
  assert.equal(s.ctl.snapshot().nodes.a.todo, null);

  const before = s.hub.dispatched.length;
  await s.ctl.tick();                       // 应补发
  assert.equal(s.hub.dispatched.length, before + 1, 'queued 被补发');
  assert.equal(s.runOf('a').status, 'claimed');
  assert.ok(s.runOf('a').hub?.hubRunId, '补发后拿到 hubRunId');
  assert.equal(s.ctl.snapshot().nodes.a.state, 'dev');
});

test('queued 补发保留 review 的原 commit 基准，不退回基线', async () => {
  const s = setup([mkNode('a')]);
  const failNext = failPrepareOnce(s);
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done'); await s.ctl.tick(); // 进入 review
  s.claimAll(); await s.blockNow('a', 'review'); await s.ctl.tick();                 // review 存量阻塞
  assert.equal(s.ctl.snapshot().nodes.a.blockedRole, 'review');
  failNext();
  s.ctl.revive('a', 'blocked-resolved');
  await s.ctl.tick();                       // review 复活，prepare 抛错 → queued
  const run = s.runOf('a', 'review');
  assert.equal(run.status, 'queued');
  assert.equal(run.role, 'review');
  assert.ok(!run.hub?.hubRunId);

  s.rt.events.length = 0;
  await s.ctl.tick();                       // 补发
  assert.ok(s.rt.events.some(e => e[0] === 'prepare' && e[3] === 'sha-a'), '以原 commit 为基准补 prepare');
  assert.equal(s.runOf('a', 'review').status, 'claimed');
});
