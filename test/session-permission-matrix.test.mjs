import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SchedulingSessionManager } from '../src/scheduling-session.mjs';
import { fakeAcp, waitFor, ALLOW_ONCE, ALLOW_ALWAYS_ONLY } from './fake-acp.mjs';

function env() {
  const root = mkdtempSync(path.join(tmpdir(), 'matrix-'));
  const home = path.join(root, 'home'); const scripts = path.join(home, 'scripts');
  const project = path.join(root, 'project'); const userCodex = path.join(root, 'user-codex');
  mkdirSync(scripts, { recursive: true }); mkdirSync(path.join(project, '.git'), { recursive: true }); mkdirSync(userCodex);
  writeFileSync(path.join(project, 'a.txt'), 'a');
  return { root, home, scripts, project, userCodex, outside: path.join(root, 'elsewhere', 'x.txt') };
}
const edit = file => ({ toolCall: { toolCallId: `e-${file}`, kind: 'edit', status: 'pending', locations: [{ path: file }] }, options: ALLOW_ONCE });
const exec = command => ({ toolCall: { toolCallId: `x-${command}`, kind: 'execute', status: 'pending', title: command, rawInput: { command } }, options: ALLOW_ONCE });
const fetchReq = { toolCall: { toolCallId: 'f1', kind: 'fetch', status: 'pending', title: 'network access to github.com' }, options: ALLOW_ONCE };
const mcpStart = (id, tool) => ({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'execute', title: `mcp.autoloop-hub.${tool}`, status: 'pending' });
const mcpApproval = id => ({ toolCall: { toolCallId: id, kind: 'execute', status: 'pending' }, options: ALLOW_ONCE });

async function runKind(kind, permissions, { updates = [], extra = {} } = {}) {
  const e = env();
  const list = typeof permissions === 'function' ? permissions(e) : permissions;
  const fake = fakeAcp({ permissions: list, updates, ...extra });
  const manager = new SchedulingSessionManager({ cwd: e.project, adapterPath: '/fixed/acp.js', spawnFn: () => fake.child, writableDir: e.scripts, archiveRoot: e.home, userCodexHome: e.userCodex });
  await manager.start({ kind, project: e.project, prompt: '开始' });
  await waitFor(() => Object.keys(fake.outcomes).length >= list.length);
  const audit = existsSync(path.join(e.home, 'permission-audit.jsonl')) ? readFileSync(path.join(e.home, 'permission-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  manager.dispose();
  return { e, fake, audit, out: i => fake.outcomes[`perm-${i}`] };
}

// ---- 事故复现：调度/设计会话请求 shell 与被禁写入必须被拒并留痕 ----
for (const kind of ['scheduling', 'design']) {
  test(`${kind}: shell execution is cancelled and audited`, async () => {
    const r = await runKind(kind, [exec('git status'), exec('gh pr merge 12 --squash'), exec('git push origin main')]);
    for (const i of [0, 1, 2]) assert.equal(r.out(i).outcome, 'cancelled');
    assert.equal(r.audit.length, 3);
    assert.ok(r.audit.every(item => item.decision === 'denied' && item.kind === kind && item.toolKind === 'execute' && item.at));
  });
  test(`${kind}: network/fetch and allow_always-only requests are cancelled`, async () => {
    const r = await runKind(kind, [fetchReq, { toolCall: { toolCallId: 'a', kind: 'other', status: 'pending' }, options: ALLOW_ALWAYS_ONLY }]);
    assert.equal(r.out(0).outcome, 'cancelled'); assert.equal(r.out(1).outcome, 'cancelled');
  });
}
test('scheduling: edits inside the project workspace are cancelled, edits in AGENT_AUTOLOOP_HOME/scripts are approved once', async () => {
  const r = await runKind('scheduling', e => [edit(path.join(e.project, 'a.txt')), edit(path.join(e.scripts, 'scan.mjs')), edit(path.join(e.scripts, '..', 'rules.json')), edit(e.outside)]);
  assert.equal(r.out(0).outcome, 'cancelled', 'project code write must be denied for scheduling');
  assert.deepEqual(r.out(1), { outcome: 'selected', optionId: 'allow' });
  assert.equal(r.out(2).outcome, 'cancelled', 'traversal out of scripts');
  assert.equal(r.out(3).outcome, 'cancelled');
  assert.deepEqual(r.audit.map(item => item.decision), ['denied', 'allowed', 'denied', 'denied']);
});
test('design: even edits inside scripts are cancelled', async () => {
  const r = await runKind('design', e => [edit(path.join(e.scripts, 'scan.mjs'))]);
  assert.equal(r.out(0).outcome, 'cancelled');
});
test('scheduling: Hub controlled-write MCP tools are approved, unknown MCP tools and standalone elicitations are cancelled', async () => {
  const r = await runKind('scheduling', [mcpApproval('m1'), mcpApproval('m2'), mcpApproval('m3'), mcpApproval('m4'), { toolCall: { toolCallId: 'standalone', kind: 'execute', status: 'pending', title: 'MCP tool call approval', input: { serverName: 'autoloop-hub' } }, options: ALLOW_ONCE }], {
    updates: [mcpStart('m1', 'run_rule'), mcpStart('m2', 'pause_rule'), mcpStart('m3', 'resume_rule'), { ...mcpStart('m4', 'merge_pr'), title: 'mcp.autoloop-hub.merge_pr' }],
  });
  assert.deepEqual([0, 1, 2].map(i => r.out(i).outcome), ['selected', 'selected', 'selected']);
  assert.equal(r.out(3).outcome, 'cancelled');
  assert.equal(r.out(4).outcome, 'cancelled');
});
test('scheduling: a foreign MCP server tool named like a hub tool is cancelled', async () => {
  const r = await runKind('scheduling', [mcpApproval('m1')], { updates: [{ ...mcpStart('m1', 'run_rule'), title: 'mcp.evil-server.run_rule' }] });
  assert.equal(r.out(0).outcome, 'cancelled');
});

// ---- 普通会话：workspace 内写 + shell + 网络获批 ----
test('normal: workspace writes, shell and network are approved once (never allow_always)', async () => {
  const r = await runKind('normal', e => [edit(path.join(e.project, 'a.txt')), edit(path.join(e.project, 'new', 'b.txt')), exec('npm test'), exec('git commit -m x'), exec('gh pr create --fill'), fetchReq, { toolCall: { toolCallId: 'aa', kind: 'execute', status: 'pending', title: 'npm test' }, options: ALLOW_ALWAYS_ONLY }]);
  for (const i of [0, 1, 2, 3, 4, 5]) assert.deepEqual(r.out(i), { outcome: 'selected', optionId: 'allow' }, `request ${i}`);
  assert.equal(r.out(6).outcome, 'cancelled');
  assert.ok(r.audit.slice(0, 6).every(item => item.decision === 'allowed' && item.kind === 'normal'));
});
test('normal: writes outside the workspace, traversal and symlink escapes are cancelled', async () => {
  const r = await runKind('normal', e => {
    const link = path.join(e.project, 'link.txt'); symlinkSync(path.dirname(e.root), link);
    return [edit(e.outside), edit(path.join(e.project, '..', 'escape.txt')), edit('/etc/crontab'), edit(link), edit(path.join(e.home, 'rules.json')), { toolCall: { toolCallId: 'noloc', kind: 'edit', status: 'pending' }, options: ALLOW_ONCE }];
  });
  for (const i of [0, 1, 2, 3, 4, 5]) assert.equal(r.out(i).outcome, 'cancelled', `request ${i}`);
});
test('normal: pushes to protected branches, force/delete pushes and ambiguous pushes are cancelled', async () => {
  const r = await runKind('normal', [
    exec('git push origin main'), exec('git push -u origin HEAD:master'), exec('git push --force origin feat/x'), exec('git push -f origin feat/x'),
    exec('git push origin +feat/x'), exec('git push origin --delete feat/x'), exec('git push origin :feat/x'), exec('git push'),
    exec('git push origin HEAD'), exec('cd p && git status; git -C /tmp/p push origin main'), exec('bash -c "git add . && git push origin main"'),
    exec('git push --force-with-lease origin feat/x'), exec('git push --mirror origin'),
  ]);
  for (let i = 0; i < 13; i++) assert.equal(r.out(i).outcome, 'cancelled', `request ${i}`);
});
test('normal: feature/fix/hotfix branch push, commits and PR create/merge (authorized by the user) are approved', async () => {
  const r = await runKind('normal', [
    exec('git push -u origin feat/session-permission'), exec('git push origin fix/topic'), exec('git push origin hotfix/x'),
    exec('git commit -m "docs: push origin main notes"'), exec('git -C /p push -u origin feat/y'), exec('gh pr create --fill'), exec('gh pr merge 5 --squash'),
    exec('git push origin feat/x:feat/x'),
  ]);
  for (let i = 0; i < 8; i++) assert.deepEqual(r.out(i), { outcome: 'selected', optionId: 'allow' }, `request ${i}`);
});
test('normal: a shell cwd outside the project workspace is cancelled', async () => {
  const r = await runKind('normal', e => [{ toolCall: { toolCallId: 'c1', kind: 'execute', status: 'pending', rawInput: { command: 'ls', cwd: path.dirname(e.root) } }, options: ALLOW_ONCE }, { toolCall: { toolCallId: 'c2', kind: 'execute', status: 'pending', rawInput: { command: 'ls', cwd: path.join(e.project, 'sub') } }, options: ALLOW_ONCE }]);
  assert.equal(r.out(0).outcome, 'cancelled'); assert.equal(r.out(1).outcome, 'selected');
  assert.match(r.audit[0].reason, /工作目录越出项目工作区/, 'must be denied for the cwd, not for an unrelated fail-closed reason');
});
test('started commands whose approval request omits kind/command are judged from the earlier tool_call update', async () => {
  const startCmd = (id, command) => ({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'execute', title: command, rawInput: { command }, status: 'pending' });
  const bare = id => ({ toolCall: { toolCallId: id, status: 'pending' }, options: ALLOW_ONCE });
  const r = await runKind('normal', [bare('s1'), bare('s2')], { updates: [startCmd('s1', 'git push origin main'), startCmd('s2', 'npm test')] });
  assert.equal(r.out(0).outcome, 'cancelled'); assert.equal(r.out(1).outcome, 'selected');
  const sched = await runKind('scheduling', [bare('s1')], { updates: [startCmd('s1', 'npm test')] });
  assert.equal(sched.out(0).outcome, 'cancelled');
  const unknown = await runKind('normal', [bare('never-seen')]);
  assert.equal(unknown.out(0).outcome, 'cancelled', 'a request that cannot be classified must fail closed');
});

// ---- 沙箱模式机械化：调度=read-only，普通=workspace-write，失败即拒绝创建 ----
test('scheduling session sets and verifies read-only mode before the first prompt', async () => {
  const e = env(); const fake = fakeAcp();
  const manager = new SchedulingSessionManager({ cwd: e.project, adapterPath: '/fixed/acp.js', spawnFn: () => fake.child, writableDir: e.scripts, archiveRoot: e.home, userCodexHome: e.userCodex });
  await manager.start({ kind: 'scheduling', project: e.project, prompt: '诊断' });
  await waitFor(() => fake.requests.some(r => r.method === 'session/prompt'));
  const methods = fake.requests.filter(r => r.method).map(r => r.method);
  assert.deepEqual(methods.slice(0, 4), ['initialize', 'session/new', 'session/set_mode', 'session/prompt']);
  assert.equal(fake.requests.find(r => r.method === 'session/set_mode').params.modeId, 'read-only');
  manager.dispose();
});
test('normal session sets and verifies workspace-write mode before the first prompt', async () => {
  const e = env(); const fake = fakeAcp();
  const manager = new SchedulingSessionManager({ cwd: e.project, adapterPath: '/fixed/acp.js', spawnFn: () => fake.child, archiveRoot: e.home, userCodexHome: e.userCodex });
  await manager.start({ kind: 'normal', project: e.project, prompt: '改代码' });
  await waitFor(() => fake.requests.some(r => r.method === 'session/prompt'));
  assert.equal(fake.requests.find(r => r.method === 'session/set_mode').params.modeId, 'workspace-write');
  manager.dispose();
});
for (const kind of ['scheduling', 'normal']) {
  test(`${kind} session fails closed when the sandbox mode cannot be set`, async () => {
    const e = env(); const fake = fakeAcp({ failSetMode: true });
    const manager = new SchedulingSessionManager({ cwd: e.project, adapterPath: '/fixed/acp.js', spawnFn: () => fake.child, writableDir: e.scripts, archiveRoot: e.home, userCodexHome: e.userCodex });
    await assert.rejects(() => manager.start({ kind, project: e.project, prompt: '开始' }), /开启.*失败/);
    assert.equal(fake.requests.some(r => r.method === 'session/prompt'), false);
    assert.equal(manager.list().length, 0);
  });
}

// ---- 普通会话分支纪律：作为独立提示块送达，用户消息保持逐字 ----
test('normal session delivers branch discipline as a separate prompt block while the user message stays verbatim', async () => {
  const e = env(); const fake = fakeAcp();
  const manager = new SchedulingSessionManager({ cwd: e.project, adapterPath: '/fixed/acp.js', spawnFn: () => fake.child, archiveRoot: e.home, userCodexHome: e.userCodex });
  const started = await manager.start({ kind: 'normal', project: e.project, prompt: '修复 issue #7' });
  await waitFor(() => fake.requests.some(r => r.method === 'session/prompt'));
  const blocks = fake.requests.find(r => r.method === 'session/prompt').params.prompt;
  assert.equal(blocks[0].text, '修复 issue #7');
  assert.match(blocks[1].text, /不直推 main/);
  assert.match(blocks[1].text, /fix\/<topic>/);
  assert.match(blocks[1].text, /worktree/);
  assert.equal(manager.list()[0].messages[0].text, '修复 issue #7');
  assert.equal(started.prompt, '修复 issue #7');
  manager.dispose();
});
