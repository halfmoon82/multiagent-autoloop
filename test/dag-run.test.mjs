// DAG run 状态机核心：创建/授权快照、迁移校验、advance 回执、失败计数、槽位、publish、持久化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRunStore, ALLOWED_ACTIONS, DENIED_ACTIONS, MAX_SLOTS, MAX_ATTEMPTS,
  transition, isTerminal, evaluateSlotRelease, snapshotDigest, TERMINAL_STATUSES,
} from '../src/dag-run.mjs';

const setup = () => createRunStore({ directory: mkdtempSync(path.join(tmpdir(), 'dag-run-')) });

const ALL_ACTIONS = [...ALLOWED_ACTIONS];
const baseInput = over => ({
  project: 'demo-project',
  planId: 'plan-1',
  planDigest: 'sha256:plandigest',
  confirmedActionIds: ALL_ACTIONS,
  confirm: true,
  nodeId: 'node-a',
  role: 'dev',
  ...over,
});

test('createRun 生成授权快照（含 planDigest 摘要），confirm 缺失或非 true 拒绝', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  assert.equal(run.status, 'queued');
  assert.equal(run.generation, 1);
  assert.equal(run.attempt, 1);
  const snap = run.authorizationSnapshot;
  assert.deepEqual(snap.allowedActions, [...ALL_ACTIONS].sort());
  assert.equal(snap.planDigest, 'sha256:plandigest');
  assert.equal(snap.mergeStrategy, 'squash');
  assert.match(snap.digest, /^[a-f0-9]{64}$/);
  assert.throws(() => store.createRun(baseInput({ confirm: false })), /confirm/);
  assert.throws(() => store.createRun(baseInput({ confirm: 'yes' })), /confirm/);
  const other = setup();
  assert.notEqual(snapshotDigest(other.createRun(baseInput({ planDigest: 'sha256:other' })).authorizationSnapshot), snap.digest, 'planDigest 变化必须改变快照摘要');
  const third = setup();
  assert.equal(snapshotDigest(third.createRun(baseInput()).authorizationSnapshot), snap.digest, '相同授权内容摘要必须稳定');
});

test('createRun 白名单：deploy/release/凭据/对外通信出现即整体拒绝，未知动作同样拒绝', () => {
  const store = setup();
  for (const bad of ['deploy', 'release', 'production-write', 'credentials', 'external-communication', 'rm-rf']) {
    assert.throws(() => store.createRun(baseInput({ confirmedActionIds: ['worktree', bad] })), new RegExp(bad), `应拒绝 ${bad}`);
  }
  assert.throws(() => store.createRun(baseInput({ confirmedActionIds: [] })), /动作/);
});

test('createRun 同项目已有活跃 run 返回 409 语义错误（code=CONFLICT），查重键为纯 project 级', () => {
  const store = setup();
  const first = store.createRun(baseInput());
  // 相同 planId：拒绝
  let conflict = null;
  try { store.createRun(baseInput({ nodeId: 'node-b' })); } catch (error) { conflict = error; }
  assert.ok(conflict, '同项目活跃 run 必须拒绝创建');
  assert.equal(conflict.code, 'CONFLICT');
  // 不同 planId：同样拒绝（每项目最多一个活跃 DAG，查重不看 planId）
  let crossPlan = null;
  try { store.createRun(baseInput({ nodeId: 'node-c', planId: 'plan-2' })); } catch (error) { crossPlan = error; }
  assert.ok(crossPlan, '同项目不同 planId 的第二个活跃 run 必须拒绝');
  assert.equal(crossPlan.code, 'CONFLICT');
  // 其他项目不受影响
  assert.equal(store.createRun(baseInput({ project: 'demo-2' })).status, 'queued');
  store.cancel(first.runId, { reason: 'user-request' });
  const second = store.createRun(baseInput({ nodeId: 'node-b' }));
  assert.equal(second.status, 'queued');
});

test('createRun 查重按归一后的 project：\' demo \' 与 \'demo\' 视为同项目冲突', () => {
  const store = setup();
  const first = store.createRun(baseInput({ project: 'demo' }));
  assert.equal(first.project, 'demo');
  let conflict = null;
  try { store.createRun(baseInput({ project: '  demo ', planId: 'plan-2' })); } catch (error) { conflict = error; }
  assert.ok(conflict, '带空白的同项目名不得绕过活跃查重');
  assert.equal(conflict.code, 'CONFLICT');
});

test('状态机：queued→claimed→done 合法，非法迁移报错不静默纠正', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  const claimed = transition(run, 'claimed');
  assert.equal(claimed.status, 'claimed');
  assert.equal(transition(claimed, 'done').status, 'done');
  assert.throws(() => transition(claimed, 'queued'), /迁移/);
  assert.throws(() => transition({ ...run, status: 'done' }, 'claimed'), /迁移/);
  assert.equal(isTerminal('done'), true);
  assert.equal(isTerminal('unknown'), false);
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ['abandoned', 'blocked_unknown', 'cancelled', 'done']);
});

test('状态机：unknown 不可取消；queued/claimed 可取消；unknown→abandoned 合法', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  store.claim(run.runId, { slot: 1 });
  store.markUnknown(run.runId);
  assert.throws(() => store.cancel(run.runId, { reason: 'user-request' }), /迁移|unknown/);
  assert.equal(transition(store.getRun(run.runId), 'abandoned').status, 'abandoned');
  const other = store.createRun(baseInput({ nodeId: 'node-b', project: 'demo-2' }));
  store.claim(other.runId, { slot: 1 });
  store.cancel(other.runId, { reason: 'user-request' });
  assert.equal(store.getRun(other.runId).status, 'cancelled');
});

// project 级 409 后，同项目多活跃 run 只能来自同一 DAG 内的 attempt 链（quarantine/换打法重派）。
const fillSlots = (store, project) => {
  const ids = [store.createRun(baseInput({ project })).runId];
  while (ids.length < MAX_SLOTS) {
    const prev = store.getRun(ids[ids.length - 1]);
    const needApproach = prev.attempt >= MAX_ATTEMPTS;
    ids.push(store.createAttempt(prev.runId, needApproach ? { reason: 'change-approach' } : {}).runId);
  }
  return ids;
};

test('claim 校验槽位 1-5 且互斥，第 6 路占用被拒绝', () => {
  const store = setup();
  const ids = fillSlots(store, 'p');
  for (let i = 0; i < MAX_SLOTS; i++) store.claim(ids[i], { slot: i + 1 });
  const sixth = store.createAttempt(ids[MAX_SLOTS - 1], { reason: 'change-approach' });
  assert.throws(() => store.claim(sixth.runId, { slot: 1 }), /槽位|占用/);
  assert.throws(() => store.claim(ids[0], { slot: 6 }), /1-5/);
  assert.equal(store.slotUsage('p'), MAX_SLOTS);
  // 终态释放槽位
  store.cancel(sixth.runId, { reason: 'user-request' });
  store.claim(ids[0], { slot: 1 }); // 幂等重复 claim 同一槽位
});

const validReceipt = run => ({
  advanceId: run.expectedAdvanceId,
  runId: run.runId,
  nodeId: run.nodeId,
  role: run.role,
  generation: run.generation,
  attempt: run.attempt,
  outcome: 'done',
  detail: { branch: 'feat/x', commit: 'abc', tests: 'pass', prUrl: 'https://example/pr/1', evidenceRef: 'ev/1' },
});

test('advance：回执必须逐字一致，合法回执迁移 done', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  store.claim(run.runId, { slot: 2 });
  const claimed = store.getRun(run.runId);
  assert.match(claimed.expectedAdvanceId, new RegExp(`^${claimed.runId}:${claimed.nodeId}:${claimed.role}:1:1`));
  const result = store.advance(run.runId, validReceipt(claimed));
  assert.equal(result.verdict, 'apply');
  assert.equal(store.getRun(run.runId).status, 'done');
});

test('advance：id 不符/类型错误计一次失败；done 后的无合法 advance 回执也计失败', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  store.claim(run.runId, { slot: 1 });
  const forged = store.advance(run.runId, { ...validReceipt(store.getRun(run.runId)), advanceId: 'forged-id' });
  assert.equal(forged.verdict, 'invalid');
  assert.equal(store.getRun(run.runId).failures, 1);
  const typeError = store.advance(run.runId, 'not-an-object');
  assert.equal(typeError.verdict, 'invalid');
  assert.equal(typeError.failureCounted, true);
  assert.equal(store.getRun(run.runId).failures, 2);
  store.advance(run.runId, validReceipt(store.getRun(run.runId)));
  assert.equal(store.getRun(run.runId).status, 'done');
  const late = store.advance(run.runId, validReceipt(store.getRun(run.runId)));
  assert.equal(late.verdict, 'invalid');
  assert.equal(store.getRun(run.runId).failures, 3, 'done 后无合法 advance 回须计一次失败');
});

test('advance：重复回执幂等，返回相同结果且不重复计数', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  store.claim(run.runId, { slot: 1 });
  const receipt = validReceipt(store.getRun(run.runId));
  const first = store.advance(run.runId, receipt);
  const replay = store.advance(run.runId, receipt);
  assert.equal(replay.verdict, 'duplicate');
  assert.deepEqual(replay.result, first.result);
  assert.equal(store.getRun(run.runId).failures, 0);
  assert.equal(store.getRun(run.runId).status, 'done');
});

test('advance：畸形 detail 进入 blocked_unknown 并计失败', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  store.claim(run.runId, { slot: 1 });
  const bad = store.advance(run.runId, { ...validReceipt(store.getRun(run.runId)), detail: '{"not":"an object"}' });
  assert.equal(bad.verdict, 'invalid');
  assert.equal(store.getRun(run.runId).status, 'blocked_unknown');
  assert.equal(store.getRun(run.runId).failures, 1);
});

test('失败计数：cancelled 计一次失败，attempts-exhausted 取消不重复计数', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  store.claim(run.runId, { slot: 1 });
  store.advance(run.runId, { ...validReceipt(store.getRun(run.runId)), outcome: 'rework', detail: { note: 'rework' } });
  assert.equal(store.getRun(run.runId).failures, 1, 'rework 计一次失败');
  const exhausted = store.createRun(baseInput({ nodeId: 'n2', project: 'p2' }));
  store.cancel(exhausted.runId, { reason: 'attempts-exhausted' });
  assert.equal(store.getRun(exhausted.runId).failures, 0, 'attempts-exhausted 取消不得重复计数');
  const plain = store.createRun(baseInput({ nodeId: 'n3', project: 'p3' }));
  store.cancel(plain.runId, { reason: 'user-request' });
  assert.equal(store.getRun(plain.runId).failures, 1);
});

test('换打法：新 generation/attempt 的 run 创建后旧 run 晚到 advance 因 attempt 不符作废且不计失败', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  store.claim(run.runId, { slot: 1 });
  store.advance(run.runId, { ...validReceipt(store.getRun(run.runId)), outcome: 'rework', detail: {} });
  const next = store.createAttempt(run.runId, { reason: 'retry' });
  assert.equal(next.attempt, 2);
  assert.equal(next.generation, 1);
  const stale = store.advance(run.runId, validReceipt(store.getRun(run.runId)));
  assert.equal(stale.verdict, 'stale');
  assert.equal(store.getRun(next.runId).failures, 0, '旧 run 晚到回执不得给新 attempt 计失败');
  // 契约（R10）：同一任务累计满 3 次才必须换打法；第 2→3 次仍可同打法重派。
  const third = store.createAttempt(next.runId, { reason: 'same-approach' });
  assert.equal(third.attempt, 3);
  assert.throws(() => store.createAttempt(third.runId, { reason: 'same-approach' }), /换打法/);
  const gen2 = store.createAttempt(third.runId, { reason: 'change-approach' });
  assert.equal(gen2.generation, 2);
  assert.equal(gen2.attempt, 1);
  const crossGen = store.advance(run.runId, { ...validReceipt(store.getRun(gen2.runId)), advanceId: store.getRun(gen2.runId).expectedAdvanceId || 'x' });
  assert.notEqual(crossGen.verdict, 'apply', '跨 generation 复用 id 不得生效');
});

test('槽位：unknown 超 15 分钟可隔离，隔离槽位仍占 5 路名额直到终态', () => {
  const store = setup();
  const runs = fillSlots(store, 'p');
  for (let i = 0; i < MAX_SLOTS; i++) store.claim(runs[i], { slot: i + 1 });
  const now = Date.now();
  store.markUnknown(runs[0], { at: now - 16 * 60 * 1000 });
  store.quarantineSlot(runs[0]);
  assert.equal(store.getRun(runs[0]).quarantine, true);
  assert.equal(store.slotUsage('p'), MAX_SLOTS, 'quarantine 槽位仍占名额');
  const extra = store.createAttempt(runs[MAX_SLOTS - 1], { reason: 'change-approach' });
  assert.throws(() => store.claim(extra.runId, { slot: 1 }), /占用/);
});

test('slot-release 判定：queued/在线 claimed 拒绝；未满 24 小时拒绝；证据缺失 fail closed；超 24h+进程组核实才允许', () => {
  const store = setup();
  const now = Date.now();
  const queued = store.createRun(baseInput({ nodeId: 'q', project: 'rel-a', planId: 'plan-q' }));
  assert.equal(evaluateSlotRelease(store.getRun(queued.runId), { processGroupVerified: true }).allowed, false);

  const claimed = store.createRun(baseInput({ nodeId: 'c', project: 'rel-b', planId: 'plan-c' }));
  store.claim(claimed.runId, { slot: 1 });
  const online = evaluateSlotRelease(store.getRun(claimed.runId), { workerOnline: true, offlineSince: now - 25 * 3600 * 1000, processGroupVerified: true });
  assert.equal(online.allowed, false, '在线 claimed 一律拒绝');

  const unknownRun = store.createRun(baseInput({ nodeId: 'u', project: 'rel-c', planId: 'plan-u' }));
  store.claim(unknownRun.runId, { slot: 2 });
  store.markUnknown(unknownRun.runId, { at: now - 23 * 3600 * 1000 });
  const tooSoon = evaluateSlotRelease(store.getRun(unknownRun.runId), { processGroupVerified: true, now });
  assert.equal(tooSoon.allowed, false, '未满 24 小时拒绝');

  // unknownSince 只在首次进入 unknown 时记录（重复 markUnknown 不刷新），25h 场景用独立 run。
  const longUnknown = store.createRun(baseInput({ nodeId: 'lu', project: 'rel-e', planId: 'plan-lu' }));
  store.claim(longUnknown.runId, { slot: 4 });
  store.markUnknown(longUnknown.runId, { at: now - 25 * 3600 * 1000 });
  assert.equal(evaluateSlotRelease(store.getRun(longUnknown.runId), { now }).allowed, false, '进程组核实依据缺失 fail closed');
  const ok = evaluateSlotRelease(store.getRun(longUnknown.runId), { processGroupVerified: true, now });
  assert.equal(ok.allowed, true);

  const offlineClaimed = store.createRun(baseInput({ nodeId: 'oc', project: 'rel-d', planId: 'plan-oc' }));
  store.claim(offlineClaimed.runId, { slot: 3 });
  const deniedEvidence = evaluateSlotRelease(store.getRun(offlineClaimed.runId), { workerOnline: false, now });
  assert.equal(deniedEvidence.allowed, false, 'claimed 离线但 offlineSince 证据缺失 fail closed');
  const allowedOffline = evaluateSlotRelease(store.getRun(offlineClaimed.runId), {
    workerOnline: false, offlineSince: now - 26 * 3600 * 1000, processGroupVerified: true, now,
  });
  assert.equal(allowedOffline.allowed, true, 'claimed 且 worker 离线超 24h 且有核实依据允许');

  store.releaseSlot(longUnknown.runId, { processGroupVerified: true, now });
  assert.equal(store.getRun(longUnknown.runId).status, 'abandoned');
  assert.equal(store.slotUsage('rel-e'), 0, 'abandoned 后槽位释放');
  assert.equal(store.slotUsage('rel-d'), 1, '仍占用的槽位继续计数');
  const late = store.advance(longUnknown.runId, { runId: longUnknown.runId, advanceId: 'whatever' });
  assert.notEqual(late.verdict, 'apply', 'abandoned 后晚到回执一律作废');
});

test('publish 只能关闭 run.json 登记且同 runId/nodeId 的 PR，外链 PR 一律拒绝', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  store.registerPr(run.runId, 'node-a', 'https://github.com/o/r/pull/1');
  const closed = store.publishClosePr(run.runId, 'node-a', 'https://github.com/o/r/pull/1', { supersededBy: 'https://github.com/o/r/pull/2' });
  assert.equal(closed.state, 'closed');
  assert.match(closed.closedNote, /superseded-by .*pull\/2/);
  assert.throws(() => store.publishClosePr(run.runId, 'node-a', 'https://github.com/o/r/pull/999'), /登记/);
  assert.throws(() => store.publishClosePr(run.runId, 'node-b', 'https://github.com/o/r/pull/1'), /登记/);
  const replay = store.publishClosePr(run.runId, 'node-a', 'https://github.com/o/r/pull/1', { supersededBy: 'x' });
  assert.equal(replay.closedNote, closed.closedNote, '重复关闭幂等');
});

test('publish 关闭 PR 需要快照授权 close-superseded-pr 动作', () => {
  const store = setup();
  const run = store.createRun(baseInput({ confirmedActionIds: ['worktree', 'run-tests'] }));
  store.registerPr(run.runId, 'node-a', 'https://github.com/o/r/pull/1');
  assert.throws(() => store.publishClosePr(run.runId, 'node-a', 'https://github.com/o/r/pull/1'), /授权/);
});

test('run.json 原子落盘：注入目录、可重读、无临时残留、损坏文件报 blocked 语义错误', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dag-run-persist-'));
  const store = createRunStore({ directory });
  const run = store.createRun(baseInput());
  const file = path.join(directory, `${run.runId}.json`);
  assert.equal(existsSync(file), true);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.runId, run.runId);
  assert.equal(readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0, '原子写不得残留 tmp');
  const reloaded = createRunStore({ directory }).getRun(run.runId);
  assert.equal(reloaded.status, 'queued');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(directory, 'dag-corrupt.json'), '{broken');
  let corrupt = null;
  try { createRunStore({ directory }).getRun('dag-corrupt'); } catch (error) { corrupt = error; }
  assert.ok(corrupt, '损坏状态文件必须报错');
  assert.match(corrupt.message, /损坏|blocked/);
  assert.equal(corrupt.code, 'CORRUPT_STATE');
});

// ---- PR #44 返工回归（reviewer P1-1 / P2-1 / P2-3 / P3）----
import { writeFileSync as fsWrite } from 'node:fs';
import { canClosePr, buildAuthorizationSnapshot } from '../src/dag-run.mjs';

test('P1-1 授权快照被篡改（allowedActions 加项）后 digest 校验失败，publish 与读取 fail closed', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dag-run-tamper-'));
  const store = createRunStore({ directory });
  const run = store.createRun(baseInput({ confirmedActionIds: ['worktree', 'run-tests'] }));
  store.registerPr(run.runId, 'node-a', 'https://github.com/o/r/pull/1');
  const file = path.join(directory, `${run.runId}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.authorizationSnapshot.allowedActions.push('close-superseded-pr');
  fsWrite(file, JSON.stringify(raw));
  assert.equal(canClosePr(raw, 'node-a', 'https://github.com/o/r/pull/1').ok, false, '纯判定也必须拒绝被篡改快照');
  assert.throws(() => store.publishClosePr(run.runId, 'node-a', 'https://github.com/o/r/pull/1'), error => ['CORRUPT_STATE', 'PR_ACTION_NOT_AUTHORIZED'].includes(error.code));
  assert.throws(() => store.getRun(run.runId), error => error.code === 'CORRUPT_STATE');
});

test('P3-2 快照输入与 run 字段同口径归一（带空白 project/planDigest 不致 digest 失配）', () => {
  const store = setup();
  const run = store.createRun(baseInput({ project: '  demo-project ', planDigest: ' sha256:plandigest\n' }));
  assert.equal(run.authorizationSnapshot.project, 'demo-project');
  assert.equal(run.authorizationSnapshot.planDigest, 'sha256:plandigest');
  assert.equal(run.authorizationSnapshot.digest, snapshotDigest(run.authorizationSnapshot));
  assert.equal(store.getRun(run.runId).project, run.authorizationSnapshot.project);
  assert.equal(buildAuthorizationSnapshot({ project: ' x ', planDigest: ' d ', confirmedActionIds: ['worktree'] }).project, 'x');
});

test('P2-1 换打法按契约：第 2 次失败仍可同打法重派，满 3 次才要求 change-approach', () => {
  const store = setup();
  const r1 = store.createRun(baseInput());
  const r2 = store.createAttempt(r1.runId);
  assert.equal(r2.attempt, 2);
  const r3 = store.createAttempt(r2.runId);
  assert.equal(r3.attempt, 3);
  assert.throws(() => store.createAttempt(r3.runId), error => error.code === 'CHANGE_APPROACH_REQUIRED' && /3/.test(error.message));
  assert.equal(store.createAttempt(r3.runId, { reason: 'change-approach' }).generation, 2);
});

test('P2-3 listRuns 遇损坏 run 文件 fail closed：不得静默忽略而放行第二个 DAG/第 6 路', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dag-run-corrupt-list-'));
  const store = createRunStore({ directory });
  store.createRun(baseInput());
  fsWrite(path.join(directory, 'dagrun-broken.json'), '{broken');
  assert.throws(() => store.listRuns(), error => error.code === 'CORRUPT_STATE');
  assert.throws(() => store.createRun(baseInput({ project: 'demo-project', planId: 'plan-2' })), error => error.code === 'CORRUPT_STATE');
  assert.throws(() => store.slotUsage('demo-project'), error => error.code === 'CORRUPT_STATE');
});

test('P3 createAttempt 前置状态守卫：用户取消的 run 不得再派生 attempt；attempts-exhausted 取消仍可换打法', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  store.cancel(run.runId, { reason: 'user-request' });
  assert.throws(() => store.createAttempt(run.runId), error => error.code === 'RUN_CANCELLED');
  const other = setup();
  const r1 = other.createRun(baseInput());
  const r2 = other.createAttempt(r1.runId); const r3 = other.createAttempt(r2.runId);
  other.cancel(r3.runId, { reason: 'attempts-exhausted' });
  assert.equal(other.createAttempt(r3.runId, { reason: 'change-approach' }).generation, 2);
});

test('P3 markUnknown 重复调用不刷新 unknownSince（观察期从首次进入起算）', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  store.markUnknown(run.runId, { at: 1000 });
  const again = store.markUnknown(run.runId, { at: 999999 });
  assert.equal(again.unknownSince, 1000);
});

test('阻塞解除自动恢复（2026-11-16 b7 教训入契约）：blocked_unknown 经 createAttempt 复活', () => {
  const store = setup();
  const run = store.createRun(baseInput());
  store.claim(run.runId, { slot: 1 });
  const blocked = store.advance(run.runId, { ...validReceipt(store.getRun(run.runId)), detail: '{"bad":"not an object"}' });
  assert.equal(blocked.verdict, 'invalid');
  assert.equal(store.getRun(run.runId).status, 'blocked_unknown');

  // 复活必须注明原因：blocked-resolved（阻塞证据已消失）或 change-approach（换打法）。
  assert.throws(() => store.createAttempt(run.runId), error => error.code === 'REVIVE_REASON_REQUIRED');
  assert.throws(() => store.createAttempt(run.runId, { reason: 'retry' }), error => error.code === 'REVIVE_REASON_REQUIRED', 'blocked_unknown 不是普通重派，retry 不构成复活依据');

  // blocked-resolved 复活：同 generation、attempt+1（复活计一次执行尝试）、授权快照逐字继承、留痕。
  const revived = store.createAttempt(run.runId, { reason: 'blocked-resolved' });
  assert.equal(revived.status, 'queued');
  assert.equal(revived.generation, 1);
  assert.equal(revived.attempt, 2);
  assert.equal(revived.revivedFrom, run.runId);
  assert.equal(revived.reviveReason, 'blocked-resolved');
  assert.deepEqual(revived.authorizationSnapshot, store.getRun(run.runId).authorizationSnapshot, '复活不得变更授权快照，借复活换授权即拒');

  // 复活后的旧 run 保持终态：晚到回执作废、不重复计数（evaluateAdvance terminal-run 口径）。
  const late = store.advance(run.runId, validReceipt(store.getRun(run.runId)));
  assert.equal(late.verdict, 'stale');
  assert.equal(store.getRun(revived.runId).failures, 0, '旧 run 晚到回执不得给复活 run 计失败');
});

test('终态复活白名单：blocked_unknown 满 3 次必须 change-approach；done/abandoned 永不复活', () => {
  const store = setup();
  const r1 = store.createRun(baseInput());
  store.claim(r1.runId, { slot: 1 });
  store.advance(r1.runId, { ...validReceipt(store.getRun(r1.runId)), detail: 'malformed' });
  const r2 = store.createAttempt(r1.runId, { reason: 'blocked-resolved' });
  store.claim(r2.runId, { slot: 1 });
  store.advance(r2.runId, { ...validReceipt(store.getRun(r2.runId)), detail: 'malformed' });
  const r3 = store.createAttempt(r2.runId, { reason: 'blocked-resolved' });
  assert.equal(r3.attempt, 3);
  assert.throws(() => store.createAttempt(r3.runId, { reason: 'blocked-resolved' }), error => error.code === 'CHANGE_APPROACH_REQUIRED', '复活计入执行尝试，满 3 次必须换打法，防无限复活循环');
  assert.equal(store.createAttempt(r3.runId, { reason: 'change-approach' }).generation, 2);

  // done 的语义是「本轮回合结束」（rework 回执同样落 done 并由调度方重派），允许无原因重派，不属复活。
  const doneStore = setup();
  const doneRun = doneStore.createRun(baseInput());
  doneStore.claim(doneRun.runId, { slot: 1 });
  doneStore.advance(doneRun.runId, validReceipt(doneStore.getRun(doneRun.runId)));
  assert.equal(doneStore.getRun(doneRun.runId).status, 'done');
  assert.equal(doneStore.createAttempt(doneRun.runId).attempt, 2, 'done（含 rework 落 done）维持既有重派口径');
});
