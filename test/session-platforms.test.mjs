import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SchedulingSessionManager } from '../src/scheduling-session.mjs';
import { fakeAcp, waitFor } from './fake-acp.mjs';

const project = () => { const root = mkdtempSync(path.join(tmpdir(), 'plat-')); const p = path.join(root, 'proj'); mkdirSync(path.join(p, '.git'), { recursive: true }); writeFileSync(path.join(p, 'a.txt'), 'a'); return { root, p }; };
const launchOf = { claude: { platform: 'claude', use: 'claude', tier: 'light', model: 'haiku', label: 'Claude Code', command: null }, workbuddy: { platform: 'workbuddy', use: 'acp', tier: 'light', model: 'hy4std', label: 'WorkBuddy AI', command: ['/bin/wb.sh', '--acp'] } };
function manager(e, fake, spawned) {
  return new SchedulingSessionManager({
    cwd: e.p, archiveRoot: e.root, hubScheduling: false, claudeAdapterPath: '/fixed/claude-acp.js', adapterPath: '/fixed/codex-acp.js',
    sessionLaunch: (kind, platform) => (platform ? launchOf[platform] || null : null),
    spawnFn: (cmd, args, options) => { spawned.push({ cmd, args, options }); return fake.child; },
  });
}

for (const [platform, kind, mode] of [['claude', 'normal', 'default'], ['claude', 'design', 'plan'], ['workbuddy', 'normal', 'default'], ['workbuddy', 'design', 'plan']]) {
  test(`${platform} ${kind} 会话：按所选平台启动适配器，权限模式设为 ${mode} 并核验，记录平台`, async () => {
    const e = project(); const fake = fakeAcp({}); const spawned = [];
    const m = manager(e, fake, spawned);
    const started = await m.start({ kind, project: e.p, prompt: '开始', platform });
    if (platform === 'claude') assert.deepEqual([spawned[0].cmd, spawned[0].args], [process.execPath, ['/fixed/claude-acp.js']]);
    else assert.deepEqual([spawned[0].cmd, spawned[0].args], ['/bin/wb.sh', ['--acp', '--model', 'hy4std']]);
    assert.equal(spawned[0].options.env.CODEX_HOME, process.env.CODEX_HOME, '非 Codex 平台不改 CODEX_HOME');
    const modeCalls = fake.requests.filter(r => r.method === 'session/set_mode').map(r => r.params.modeId);
    assert.deepEqual(modeCalls, [mode]);
    assert.equal(started.platform, platform); assert.equal(started.platformLabel, launchOf[platform].label);
    m.dispose();
  });
}

test('所选平台不存在或不可开会话：创建失败，不降级到 Codex', async () => {
  const e = project(); const spawned = [];
  const m = manager(e, fakeAcp({}), spawned);
  await assert.rejects(() => m.start({ kind: 'normal', project: e.p, prompt: 'x', platform: 'nope' }), /不可用于普通会话/);
  assert.equal(spawned.length, 0);
});

test('非 Codex 平台的模式核验失败即拒绝创建（fail closed）', async () => {
  const e = project(); const spawned = [];
  const m = manager(e, fakeAcp({ modeMismatch: true }), spawned);
  await assert.rejects(() => m.start({ kind: 'design', project: e.p, prompt: 'x', platform: 'claude' }), /开启会话失败/);
});

test('Claude Code 会话的越权请求同样出会话内决策卡；设计会话放行后切回 default 模式', async () => {
  const e = project();
  const fake = fakeAcp({ permissions: [{ toolCall: { toolCallId: 't1', kind: 'execute', title: 'git push origin main', rawInput: { command: 'git push origin main' } }, options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }, { optionId: 'deny', name: '拒绝', kind: 'reject_once' }] }] });
  const m = manager(e, fake, []);
  const started = await m.start({ kind: 'design', project: e.p, prompt: '设计', platform: 'claude' });
  await waitFor(() => m.list()[0]?.pendingPermissions?.length === 1);
  m.answerPermission(started.id, m.list()[0].pendingPermissions[0].id, 'reject');
  await waitFor(() => fake.outcomes['perm-0']);
  assert.deepEqual(fake.outcomes['perm-0'], { outcome: 'selected', optionId: 'deny' });
  await m.approvePlan(started.id);
  assert.deepEqual(fake.requests.filter(r => r.method === 'session/set_mode').map(r => r.params.modeId), ['plan', 'plan', 'default'], '首轮结束后复核一次 plan，放行后切 default');
  m.dispose();
});
