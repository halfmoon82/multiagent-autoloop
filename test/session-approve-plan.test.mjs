import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SchedulingSessionManager } from '../src/scheduling-session.mjs';
import { fakeAcp, waitFor, ALLOW_ONCE } from './fake-acp.mjs';

function env() {
  const root = mkdtempSync(path.join(tmpdir(), 'approve-'));
  const home = path.join(root, 'home'); const scripts = path.join(home, 'scripts');
  const project = path.join(root, 'project'); const userCodex = path.join(root, 'user-codex');
  mkdirSync(scripts, { recursive: true }); mkdirSync(path.join(project, '.git'), { recursive: true }); mkdirSync(userCodex);
  writeFileSync(path.join(project, 'a.txt'), 'a');
  return { root, home, scripts, project, userCodex, outside: path.join(root, 'elsewhere', 'x.txt') };
}
const managerFor = (e, fake) => new SchedulingSessionManager({ cwd: e.project, adapterPath: '/fixed/acp.js', spawnFn: () => fake.child, writableDir: e.scripts, archiveRoot: e.home, userCodexHome: e.userCodex });
const edit = file => ({ toolCall: { toolCallId: `e-${file}`, kind: 'edit', status: 'pending', locations: [{ path: file }] }, options: ALLOW_ONCE });
const configCalls = (fake, configId) => fake.requests.filter(r => r.method === 'session/set_config_option' && r.params.configId === configId).map(r => r.params.value);
const modeCalls = fake => fake.requests.filter(r => r.method === 'session/set_mode').map(r => r.params.modeId);

test('design: approvePlan flips sandbox to workspace-write, exits Plan Mode and exposes planApproved', async () => {
  const e = env(); const fake = fakeAcp({ permissions: [] }); const m = managerFor(e, fake);
  const started = await m.start({ kind: 'design', project: e.project, prompt: '设计并拆解 DAG' });
  assert.ok(!started.planApproved, '设计会话开局未放行');
  assert.deepEqual(modeCalls(fake), ['read-only'], '开局仍是只读沙箱');
  assert.deepEqual(configCalls(fake, 'collaboration_mode'), ['plan'], '开局仍是 Plan Mode');

  const approved = await m.approvePlan(started.id);
  assert.equal(approved.planApproved, true);
  assert.deepEqual(modeCalls(fake), ['read-only', 'workspace-write']);
  assert.deepEqual(configCalls(fake, 'mode').slice(-1), ['workspace-write']);
  assert.deepEqual(configCalls(fake, 'collaboration_mode'), ['plan', 'default'], 'Plan Mode 已退出并复读核验');

  const again = await m.approvePlan(started.id);
  assert.equal(again.planApproved, true);
  assert.equal(modeCalls(fake).length, 2, '幂等：重复放行不再次下发模式变更');
  m.dispose();
});

test('design: after approvePlan, writes inside the workspace are allowed like a normal session, outside still denied', async () => {
  const e = env();
  const fake = fakeAcp({ permissions: [edit(path.join(e.project, 'a.txt')), edit(e.outside)] });
  const m = managerFor(e, fake);
  const started = await m.start({ kind: 'design', project: e.project, prompt: '开始' });
  await waitFor(() => Object.keys(fake.outcomes).length >= 2);
  assert.equal(fake.outcomes['perm-0'].outcome, 'cancelled', '放行前工作区内编辑也被拒');
  assert.equal(fake.outcomes['perm-1'].outcome, 'cancelled');

  await m.approvePlan(started.id);
  await m.send(started.id, '现在落盘');
  await waitFor(() => fake.outcomes['perm-0']?.outcome === 'selected');
  assert.equal(fake.outcomes['perm-0'].outcome, 'selected', '放行后工作区内编辑获批');
  assert.equal(fake.outcomes['perm-1'].outcome, 'cancelled', '放行后工作区外仍被拒');
  m.dispose();
});

test('approvePlan rejects non-design kinds and unknown ids', async () => {
  const e = env(); const fake = fakeAcp({ permissions: [] }); const m = managerFor(e, fake);
  const normal = await m.start({ kind: 'normal', project: e.project, prompt: 'hi' });
  await assert.rejects(() => m.approvePlan(normal.id), (error) => error.status === 400);
  await assert.rejects(() => m.approvePlan('no-such-session'), (error) => error.status === 404);
  m.dispose();
});

test('design: approvePlan fails closed when collaboration_mode cannot be switched', async () => {
  const e = env(); const fake = fakeAcp({ permissions: [], collaborationMismatch: true }); const m = managerFor(e, fake);
  const started = await m.start({ kind: 'design', project: e.project, prompt: '设计' });
  await assert.rejects(() => m.approvePlan(started.id), /协作模式/);
  assert.ok(!m.list().find(s => s.id === started.id)?.planApproved, '核验失败不得留下半解锁状态');
  // 权限仍按设计会话只读裁定
  const deniedFake = fakeAcp({ permissions: [edit(path.join(e.project, 'a.txt'))] });
  m.dispose();
  const m2 = managerFor(e, deniedFake);
  const s2 = await m2.start({ kind: 'design', project: e.project, prompt: '设计' });
  await waitFor(() => Object.keys(deniedFake.outcomes).length >= 1);
  assert.equal(deniedFake.outcomes['perm-0'].outcome, 'cancelled');
  m2.dispose();
});

test('design: continueSession restores planApproved — resumed session starts unlocked without plan/read-only guards', async () => {
  const e = env(); const fake = fakeAcp({ permissions: [] }); const m = managerFor(e, fake);
  const started = await m.start({ kind: 'design', project: e.project, prompt: '设计' });
  await m.approvePlan(started.id);
  await m.close(started.id);
  m.dispose();

  // 模拟控制台重启：全新管理器 + 全新假 ACP
  const fake2 = fakeAcp({ permissions: [] }); const m2 = managerFor(e, fake2);
  const resumed = await m2.continueSession(started.id);
  assert.equal(resumed.kind, 'design');
  assert.equal(resumed.planApproved, true, '继续的会话保持放行状态');
  assert.deepEqual(modeCalls(fake2), ['workspace-write'], '不再回到只读沙箱');
  assert.deepEqual(configCalls(fake2, 'collaboration_mode'), ['default'], '不再回到 Plan Mode');
  m2.dispose();
});

test('design: continued session without approval still enforces read-only + Plan Mode', async () => {
  const e = env(); const fake = fakeAcp({ permissions: [] }); const m = managerFor(e, fake);
  const started = await m.start({ kind: 'design', project: e.project, prompt: '设计' });
  await m.close(started.id);
  m.dispose();
  const fake2 = fakeAcp({ permissions: [] }); const m2 = managerFor(e, fake2);
  const resumed = await m2.continueSession(started.id);
  assert.ok(!resumed.planApproved);
  assert.deepEqual(modeCalls(fake2), ['read-only']);
  assert.deepEqual(configCalls(fake2, 'collaboration_mode'), ['plan']);
  m2.dispose();
});
