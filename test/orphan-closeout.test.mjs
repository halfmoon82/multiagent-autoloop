// 链完成收口：终结根 run 时，把同一项目同计划里"仍非终态、已被更新的 run 取代"的旧 run 收尾。
// 2026-11-19 device-binding 曾留下一个从未派出的 gen2att1 queued run，占着"每项目一条活跃 DAG"的名额，
// 链已 done 却没人清理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkNode, setup } from './dag-fakes.mjs';
import { ROOT_NODE } from '../src/dag-run.mjs';
import { findStaleNonTerminalRuns, closeoutSupersededRuns } from '../src/dag-stall.mjs';

// 造"被取代的孤儿"：同 53b5ffc9 成因——dev 失败后 createAttempt 重建新 attempt。
// gen1att2（base）→ gen1att3（orphan，queued）→ gen2att1（latest，queued）。
// gen2att1 是最新，gen1att3 是被取代的孤儿。让 latest 走完驱动链完成。
const makeOrphan = async s => {
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'dev', 'failed');
  await s.ctl.tick();
  const base = s.store.listRuns().find(r => r.nodeId === 'a' && r.role === 'dev' && r.attempt === 2);
  const orphan = s.store.createAttempt(base.runId, { reason: 'change-approach' }); // gen1att3，queued
  const latest = s.store.createAttempt(orphan.runId, { reason: 'change-approach' }); // gen2att1，queued
  return { orphan, latest };
};

test('findStaleNonTerminalRuns：只认"非终态、已被更新的 run 取代"的旧 run', async () => {
  const s = setup([mkNode('a')]);
  const { orphan, latest } = await makeOrphan(s);
  const stale = findStaleNonTerminalRuns(s.store.listRuns());
  const staleIds = stale.map(r => r.runId).sort();
  const baseId = s.store.listRuns().find(r => r.nodeId === 'a' && r.role === 'dev' && r.attempt === 2).runId;
  assert.deepEqual(staleIds, [baseId, orphan.runId].sort(), '被取代的 gen1att3 是孤儿');
  assert.ok(!stale.some(r => r.runId === latest.runId), '最新 gen2att1 不能被当成孤儿');
});

test('closeoutSupersededRuns：链完成后收尾被取代的非终态 run，最新 run 保留', async () => {
  const s = setup([mkNode('a')]);
  const { orphan, latest } = await makeOrphan(s);
  // base（gen1att2 claimed）占着节点槽位 1：模拟它已被另行收尾（真实里是调度方核实 worker 后处理，
  // closeout 刻意不动 claimed run），否则 review 无法 claim 同一槽位。
  const base = s.store.listRuns().find(r => r.nodeId === 'a' && r.role === 'dev' && r.attempt === 2);
  s.store.cancel(base.runId, { reason: 'test-setup-cleanup' });
  // latest 是"已派出的最新 run"：claim 写入 expectedAdvanceId，dispatch 写入 hubRunId，二者齐备才能被 receipt 驱动。
  s.store.claim(latest.runId, { slot: 1 });
  const res = await s.hub.dispatch({ run: { nodeId: 'a', role: 'dev', runId: latest.runId } });
  s.store.updateRun(latest.runId, { hub: { hubRunId: res.hubRunId } });
  s.claimAll(); s.receipt('a', 'dev', 'done');
  await s.ctl.tick(); s.claimAll(); s.receipt('a', 'review', 'accepted');
  await s.ctl.tick();
  assert.equal(s.store.getRun(s.root.runId).status, 'done');
  assert.equal(s.store.getRun(orphan.runId).status, 'cancelled', '被取代的非终态 run 应被收尾');
  assert.equal(s.store.getRun(orphan.runId).cancelReason, 'superseded-by-later-attempt');
  assert.notEqual(s.store.getRun(latest.runId).status, 'cancelled', '最新 run 不能被误收尾');
});
