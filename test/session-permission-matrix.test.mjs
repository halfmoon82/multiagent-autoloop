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

// ownerChoice：需要主人确认的请求由测试代主人在会话内决策卡上答复（默认拒绝）；null = 不答复，留给用例自己处理。
async function runKind(kind, permissions, { updates = [], extra = {}, ownerChoice = 'reject' } = {}) {
  const e = env();
  const list = typeof permissions === 'function' ? permissions(e) : permissions;
  const fake = fakeAcp({ permissions: list, updates, ...extra });
  const manager = new SchedulingSessionManager({ cwd: e.project, adapterPath: '/fixed/acp.js', spawnFn: () => fake.child, writableDir: e.scripts, archiveRoot: e.home, userCodexHome: e.userCodex });
  await manager.start({ kind, project: e.project, prompt: '开始' });
  const asked = [];
  const owner = ownerChoice ? setInterval(() => {
    for (const session of manager.list()) for (const card of session.pendingPermissions || []) { asked.push(card); try { manager.answerPermission(session.id, card.id, ownerChoice); } catch {} }
  }, 5) : null;
  if (ownerChoice) await waitFor(() => Object.keys(fake.outcomes).length >= list.length, 3000);
  if (owner) clearInterval(owner);
  const audit = (existsSync(path.join(e.home, 'permission-audit.jsonl')) ? readFileSync(path.join(e.home, 'permission-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []).filter(item => item.via !== 'asked');
  const result = { e, fake, audit, asked, manager, out: i => fake.outcomes[`perm-${i}`] };
  if (ownerChoice) manager.dispose();
  return result;
}

// ---- 事故复现：调度/设计会话请求 shell 与被禁写入必须被拒并留痕 ----
for (const kind of ['scheduling', 'design']) {
  test(`${kind}: shell execution is rejected via reject_once (never reported as user-cancelled) and audited`, async () => {
    const r = await runKind(kind, [exec('git status'), exec('gh pr merge 12 --squash'), exec('git push origin main')]);
    for (const i of [0, 1, 2]) assert.deepEqual(r.out(i), { outcome: 'selected', optionId: 'deny' });
    assert.equal(r.audit.length, 3);
    assert.ok(r.audit.every(item => item.decision === 'denied' && item.kind === kind && item.toolKind === 'execute' && item.at));
  });
  test(`${kind}: network/fetch is rejected via reject_once; allow_always-only requests fall back to cancelled`, async () => {
    const r = await runKind(kind, [fetchReq, { toolCall: { toolCallId: 'a', kind: 'other', status: 'pending' }, options: ALLOW_ALWAYS_ONLY }]);
    assert.deepEqual(r.out(0), { outcome: 'selected', optionId: 'deny' });
    assert.equal(r.out(1).outcome, 'cancelled', 'no reject option offered → fail-closed fallback');
  });
}
test('scheduling: edits inside the project workspace are cancelled, edits in AGENT_AUTOLOOP_HOME/scripts are approved once', async () => {
  const r = await runKind('scheduling', e => [edit(path.join(e.project, 'a.txt')), edit(path.join(e.scripts, 'scan.mjs')), edit(path.join(e.scripts, '..', 'rules.json')), edit(e.outside)]);
  assert.deepEqual(r.out(0), { outcome: 'selected', optionId: 'deny' }, 'project code write must be denied for scheduling');
  assert.deepEqual(r.out(1), { outcome: 'selected', optionId: 'allow' });
  assert.deepEqual(r.out(2), { outcome: 'selected', optionId: 'deny' }, 'traversal out of scripts');
  assert.deepEqual(r.out(3), { outcome: 'selected', optionId: 'deny' });
  assert.deepEqual(r.audit.map(item => item.decision), ['denied', 'allowed', 'denied', 'denied']);
});
test('design: even edits inside scripts are rejected via reject_once', async () => {
  const r = await runKind('design', e => [edit(path.join(e.scripts, 'scan.mjs'))]);
  assert.deepEqual(r.out(0), { outcome: 'selected', optionId: 'deny' });
  assert.equal(r.asked.length, 1, '设计会话的提权请求出会话内决策卡，不静默拒绝');
  assert.match(r.audit[0].reason, /主人在会话内决策卡拒绝/);
});
test('scheduling: Hub controlled-write MCP tools are approved, unknown MCP tools and standalone elicitations are cancelled', async () => {
  const r = await runKind('scheduling', [mcpApproval('m1'), mcpApproval('m2'), mcpApproval('m3'), mcpApproval('m4'), { toolCall: { toolCallId: 'standalone', kind: 'execute', status: 'pending', title: 'MCP tool call approval', input: { serverName: 'autoloop-hub' } }, options: ALLOW_ONCE }], {
    updates: [mcpStart('m1', 'run_rule'), mcpStart('m2', 'pause_rule'), mcpStart('m3', 'resume_rule'), { ...mcpStart('m4', 'merge_pr'), title: 'mcp.autoloop-hub.merge_pr' }],
  });
  assert.deepEqual([0, 1, 2].map(i => r.out(i).outcome), ['selected', 'selected', 'selected']);
  assert.deepEqual(r.out(3), { outcome: 'selected', optionId: 'deny' });
  assert.deepEqual(r.out(4), { outcome: 'selected', optionId: 'deny' });
});
test('scheduling: a foreign MCP server tool named like a hub tool is rejected via reject_once', async () => {
  const r = await runKind('scheduling', [mcpApproval('m1')], { updates: [{ ...mcpStart('m1', 'run_rule'), title: 'mcp.evil-server.run_rule' }] });
  assert.deepEqual(r.out(0), { outcome: 'selected', optionId: 'deny' });
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
  for (const i of [0, 1, 2, 3, 4, 5]) assert.deepEqual(r.out(i), { outcome: 'selected', optionId: 'deny' }, `request ${i}`);
});
test('normal: pushes to protected branches, force/delete pushes and ambiguous pushes are cancelled', async () => {
  const r = await runKind('normal', [
    exec('git push origin main'), exec('git push -u origin HEAD:master'), exec('git push --force origin feat/x'), exec('git push -f origin feat/x'),
    exec('git push origin +feat/x'), exec('git push origin --delete feat/x'), exec('git push origin :feat/x'), exec('git push'),
    exec('git push origin HEAD'), exec('cd p && git status; git -C /tmp/p push origin main'), exec('bash -c "git add . && git push origin main"'),
    exec('git push --force-with-lease origin feat/x'), exec('git push --mirror origin'),
  ]);
  for (let i = 0; i < 13; i++) assert.deepEqual(r.out(i), { outcome: 'selected', optionId: 'deny' }, `request ${i}`);
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
  assert.deepEqual(r.out(0), { outcome: 'selected', optionId: 'deny' }); assert.equal(r.out(1).outcome, 'selected');
  assert.match(r.asked[0].reason, /工作目录越出项目工作区/, 'must be escalated for the cwd, not for an unrelated reason');
});
test('started commands whose approval request omits kind/command are judged from the earlier tool_call update', async () => {
  const startCmd = (id, command) => ({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'execute', title: command, rawInput: { command }, status: 'pending' });
  const bare = id => ({ toolCall: { toolCallId: id, status: 'pending' }, options: ALLOW_ONCE });
  const r = await runKind('normal', [bare('s1'), bare('s2')], { updates: [startCmd('s1', 'git push origin main'), startCmd('s2', 'npm test')] });
  assert.deepEqual(r.out(0), { outcome: 'selected', optionId: 'deny' }); assert.equal(r.out(1).outcome, 'selected');
  const sched = await runKind('scheduling', [bare('s1')], { updates: [startCmd('s1', 'npm test')] });
  assert.deepEqual(sched.out(0), { outcome: 'selected', optionId: 'deny' });
  const unknown = await runKind('normal', [bare('never-seen')]);
  assert.deepEqual(unknown.out(0), { outcome: 'selected', optionId: 'deny' }, 'a request that cannot be classified must fail closed (as an explicit reject, not a fake cancel)');
});

// ---- 沙箱模式机械化：调度=read-only，普通=workspace-write，失败即拒绝创建 ----
test('scheduling session sets and verifies read-only mode before the first prompt', async () => {
  const e = env(); const fake = fakeAcp();
  const manager = new SchedulingSessionManager({ cwd: e.project, adapterPath: '/fixed/acp.js', spawnFn: () => fake.child, writableDir: e.scripts, archiveRoot: e.home, userCodexHome: e.userCodex });
  await manager.start({ kind: 'scheduling', project: e.project, prompt: '诊断' });
  await waitFor(() => fake.requests.some(r => r.method === 'session/prompt'));
  const methods = fake.requests.filter(r => r.method).map(r => r.method);
  assert.deepEqual(methods.slice(0, 4), ['initialize', 'session/new', 'session/set_mode', 'session/set_config_option']);
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

test('session fails closed when the mode read-back does not match the requested sandbox mode', async () => {
  const e = env(); const fake = fakeAcp({ modeMismatch: true });
  const manager = new SchedulingSessionManager({ cwd: e.project, adapterPath: '/fixed/acp.js', spawnFn: () => fake.child, writableDir: e.scripts, archiveRoot: e.home, userCodexHome: e.userCodex });
  await assert.rejects(() => manager.start({ kind: 'scheduling', project: e.project, prompt: '开始' }), /无法将会话设置为 read-only 模式/);
  assert.equal(fake.requests.some(r => r.method === 'session/prompt'), false);
  assert.equal(manager.list().length, 0);
  manager.dispose();
});

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

// ---- P1-1：MCP 标题不能旁路 shell 分析 ----
const spoof = command => ({ toolCall: { toolCallId: `s-${command}`, kind: 'execute', status: 'pending', title: 'mcp.autoloop-hub.run_rule', rawInput: { command } }, options: ALLOW_ONCE });
test('scheduling: execute carrying a command is denied even with an mcp.autoloop-hub title', async () => {
  const r = await runKind('scheduling', [spoof('rm -rf /tmp/victim'), spoof('git push origin main')]);
  for (const i of [0, 1]) assert.deepEqual(r.out(i), { outcome: 'selected', optionId: 'deny' });
});
test('normal: execute with an mcp title still goes through command analysis', async () => {
  const r = await runKind('normal', [spoof('git push origin main'), spoof('git status')]);
  assert.deepEqual(r.out(0), { outcome: 'selected', optionId: 'deny' });
  assert.notEqual(r.out(1).outcome, 'cancelled');
});

// ---- 2026-11-26 事故回归：策略拒绝不得伪装成「主人取消」 ----
// ACP 协议里 cancelled 的唯一语义是「用户在应答前打断了本轮」（session/cancel）。
// 权限层以前把策略拒绝一律回 cancelled，上游 agent 于是向主人谎称「你取消了授权弹窗」，
// 设计会话与普通会话的推送/登记被这种假「取消」阻塞。拒绝必须显式选择 reject 选项。
test('regression: policy denial selects reject_once instead of reporting a user cancellation', async () => {
  const r = await runKind('normal', [exec('git push --force origin feat/x')]);
  assert.deepEqual(r.out(0), { outcome: 'selected', optionId: 'deny' }, 'denial must surface as an explicit rejection, not as a user cancel');
  assert.equal(r.audit[0].decision, 'denied');
  assert.match(r.audit[0].reason, /force|强推/);
});
test('regression: a request offering no reject option falls back to cancelled (fail closed)', async () => {
  const r = await runKind('normal', [{ toolCall: { toolCallId: 'nr', kind: 'execute', status: 'pending', title: 'git push origin main', rawInput: { command: 'git push origin main' } }, options: ALLOW_ALWAYS_ONLY }]);
  assert.equal(r.out(0).outcome, 'cancelled', 'malformed request without a reject option keeps the fail-closed fallback');
  assert.equal(r.audit[0].decision, 'denied');
});

// reject-only 选项集（无 allow_once）：只读请求也不能回裸 selected，必须 fail closed 到拒绝路径
test('regression: a reject-only option set never yields a bare selected approval', async () => {
  const rejectOnly = [{ optionId: 'no', name: '拒绝', kind: 'reject_once' }];
  const r = await runKind('normal', [
    { toolCall: { toolCallId: 'ro-read', kind: 'read', status: 'pending' }, options: rejectOnly },
    { toolCall: { toolCallId: 'ro-edit', kind: 'edit', status: 'pending', locations: ['/x'] }, options: rejectOnly },
  ]);
  assert.deepEqual(r.out(0), { outcome: 'selected', optionId: 'no' }, 'read without an allow_once option must fail closed as an explicit reject');
  assert.deepEqual(r.out(1), { outcome: 'selected', optionId: 'no' });
  assert.ok(r.audit.every(item => item.decision === 'denied'));
});

// ---- 会话内决策卡：需要主人确认的请求挂起，主人答复后才回给适配器 ----
test('design: an escalation is held as an in-session decision card until the owner answers', async () => {
  const r = await runKind('design', e => [exec('git push origin feat/x')], { ownerChoice: null });
  await waitFor(() => r.manager.list()[0]?.pendingPermissions?.length === 1);
  const [session] = r.manager.list(); const [card] = session.pendingPermissions;
  assert.equal(card.command, 'git push origin feat/x'); assert.equal(r.out(0), undefined, '主人未答复前不回适配器');
  r.manager.answerPermission(session.id, card.id, 'allow');
  await waitFor(() => r.out(0));
  assert.deepEqual(r.out(0), { outcome: 'selected', optionId: 'allow' });
  assert.equal(r.manager.list()[0].pendingPermissions.length, 0);
  assert.throws(() => r.manager.answerPermission(session.id, card.id, 'allow'), /已处理或已失效/);
  r.manager.dispose();
});
test('normal: pre-authorised push / PR / merge never raise a card; protected-branch push asks, force push is hard-denied', async () => {
  const r = await runKind('normal', [exec('git push origin feat/a'), exec('gh pr create --fill'), exec('gh pr merge 9 --squash'), exec('git push origin main'), exec('git push --force origin feat/a')], { ownerChoice: 'allow' });
  for (const i of [0, 1, 2]) assert.deepEqual(r.out(i), { outcome: 'selected', optionId: 'allow' });
  assert.equal(r.asked.length, 1); assert.equal(r.asked[0].command, 'git push origin main');
  assert.deepEqual(r.out(4), { outcome: 'selected', optionId: 'deny' }, '强推永远硬拒绝，不进决策卡');
});
test('closing the session resolves an unanswered card as cancelled', async () => {
  const r = await runKind('normal', [exec('git push origin main')], { ownerChoice: null });
  await waitFor(() => r.manager.list()[0]?.pendingPermissions?.length === 1);
  await r.manager.close(r.manager.list()[0].id);
  await waitFor(() => r.out(0));
  assert.deepEqual(r.out(0), { outcome: 'cancelled' });
});
