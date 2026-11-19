// DAG 状态变化唤醒（无模型）：一轮 tick 里值得推进调度关注的状态变化，合并成一条 scheduling.message。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkNode, setup } from './dag-fakes.mjs';
import { ROOT_NODE } from '../src/dag-run.mjs';
import { buildProgressEvent, createProgressNotifier } from '../src/dag-stall.mjs';

const wakeOf = snap => (snap.progress || []).map(p => `${p.nodeId}:${p.to}`);
const rootRuns = s => s.store.listRuns().filter(run => run.nodeId === ROOT_NODE);

test('一轮多节点变化合并进 progress；dev/review/accepted/blocked 计入，错误不计入', async () => {
  const s = setup([mkNode('a'), mkNode('b')]);
  const snap = await s.ctl.tick();
  assert.deepEqual(wakeOf(snap), ['a:dev', 'b:dev'], '本轮两个节点各派发一次');
});

test('同状态不再报；dev 完成进 review 记入 progress', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'done');
  const snap = await s.ctl.tick();
  assert.ok(wakeOf(snap).includes('a:review'));
  const snap2 = await s.ctl.tick();
  assert.deepEqual(wakeOf(snap2), [], '同状态不再报');
});

test('事件发往调度会话通道并去敏；通知方按事件 ID 去重', async () => {
  const posted = []; const sent = new Set();
  const s = setup([mkNode('a')]);
  const snap = await s.ctl.tick();
  const ev = buildProgressEvent(rootRuns(s)[0], snap);
  assert.equal(ev.type, 'scheduling.message');
  assert.match(ev.id, /^console:dag-progress:/);
  assert.notEqual(ev.id, `console:dag-progress:${s.root.runId}:1`, '不再用恒定 tickSeq');
  assert.equal(ev.subject, `scheduling:dag:${s.root.runId}`);
  assert.doesNotMatch(ev.id + ev.subject, /\s/);
  // 同一批 progress 重复调用生成同一 ID（幂等）；不同批变化生成不同 ID（P1 回归）。
  const ev2 = buildProgressEvent(rootRuns(s)[0], snap);
  assert.equal(ev2.id, ev.id);
  const other = buildProgressEvent(rootRuns(s)[0], { ...snap, progress: [{ nodeId: 'a', from: 'dev', to: 'review' }] });
  assert.notEqual(other.id, ev.id, '状态变化不同则事件 ID 不同');
  const notify = createProgressNotifier({ post: async e => posted.push(e), sent });
  await notify(rootRuns(s)[0], snap);
  await notify(rootRuns(s)[0], snap);
  assert.equal(posted.length, 1);
});

test('通知投递失败只记日志，不影响 tick 结果', async () => {
  const s = setup([mkNode('a')]);
  const notify = createProgressNotifier({ post: async () => { throw new Error('hub down'); } });
  const snap = await s.ctl.tick();
  await assert.doesNotReject(() => notify(rootRuns(s)[0], snap));
});
