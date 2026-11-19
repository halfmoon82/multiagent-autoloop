// DAG 节点卡住发现：控制器记录持续报错，无模型巡检把超阈值的卡住交给调度会话。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkNode, setup } from './dag-fakes.mjs';
import { ROOT_NODE } from '../src/dag-run.mjs';
import { findDagStalls, buildStallEvent, sweepDagStalls, createDagStallSweeper, STALL_THRESHOLD_MS } from '../src/dag-stall.mjs';

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
