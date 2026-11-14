import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { SchedulingSessionManager, SchedulingSessionError } from '../src/scheduling-session.mjs';

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function fakeAdapter({ askPermission = false, failInitialize = false, stderrBytes = 0 } = {}) {
  const requests = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = '';
  const process = {
    stdin, stdout, stderr, pid: 4242, killedWith: null,
    kill(signal) { this.killedWith = signal; stdout.end(); },
  };
  const respond = (request, result) => stdout.write(jsonLine({ jsonrpc: '2.0', id: request.id, result }));
  const requestPermission = () => {
    const request = { jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'fake-session', toolCall: { toolCallId: 'call-1', kind: 'generic', status: 'pending' }, options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }] } };
    stdout.write(jsonLine(request));
  };
  stdin.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      requests.push(request);
      if (request.method === 'initialize') {
        if (failInitialize) {
          stdout.write(jsonLine({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'initialize boom' } }));
        } else {
          respond(request, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { prompt: true } }, agentInfo: { name: 'fake-codex', version: '0' } });
        }
      } else if (request.method === 'session/new') {
        respond(request, { sessionId: 'fake-session' });
      } else if (request.method === 'session/prompt') {
        if (stderrBytes > 0) stderr.write('x'.repeat(stderrBytes));
        if (askPermission) setTimeout(requestPermission, 0);
        const reply = `收到：${request.params.prompt[0].text.slice(0, 12)}`;
        setTimeout(() => {
          stdout.write(jsonLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } } }));
          respond(request, { stopReason: 'end_turn' });
        }, askPermission ? 20 : 0);
      } else if (request.method === 'session/close') {
        respond(request, {});
      } else if (request.method === 'session/cancel') {
        respond(request, {});
      }
    }
  });
  return { process, requests };
}

async function waitFor(predicate, timeout = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error('等待假 ACP 适配器响应超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('starts a Codex ACP scheduling session in the configured project and closes it cleanly', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({
    cwd: '/workspace/control-plane',
    adapterPath: '/fixed/codex-acp.js',
    spawnFn: (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ['/fixed/codex-acp.js']);
      assert.equal(options.cwd, '/workspace/control-plane');
      assert.equal(options.shell, false);
      return fake.process;
    },
  });

  const started = await manager.start({ prompt: '检查当前待调度事项', project: 'owner-alpha/demo' });
  await waitFor(() => fake.requests.some(request => request.method === 'session/prompt'));
  assert.equal(started.sessionId, 'fake-session');
  assert.equal(started.project, 'owner-alpha/demo');
  assert.equal(started.cwd, '/workspace/control-plane');
  assert.equal(started.status, 'running');
  assert.deepEqual(fake.requests.map(request => request.method), ['initialize', 'session/new', 'session/prompt']);
  assert.equal(fake.requests[1].params.cwd, '/workspace/control-plane');
  assert.equal(fake.requests[2].params.sessionId, 'fake-session');
  assert.equal(fake.requests[2].params.prompt[0].type, 'text');
  assert.match(fake.requests[2].params.prompt[0].text, /检查当前待调度事项/);
  assert.match(fake.requests[2].params.prompt[0].text, /owner-alpha\/demo/);
  assert.equal(manager.list().length, 1);

  await manager.close(started.id);
  assert.equal(fake.process.killedWith, 'SIGTERM');
  assert.deepEqual(manager.list(), []);
});

test('injects console scheduling contract into the prompt after project context', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  await manager.start({ project: '/workspace/demo', projectContext: '# 项目约定', consoleContext: '# 调度契约\n事件链不变量' });
  await waitFor(() => fake.requests.some(request => request.method === 'session/prompt'));
  const text = fake.requests.find(request => request.method === 'session/prompt').params.prompt[0].text;
  assert.match(text, /# 调度契约/);
  assert.match(text, /事件链不变量/);
  assert.ok(text.indexOf('# 项目约定') < text.indexOf('# 调度契约'), 'project context must precede console contract');
  await manager.close(manager.list()[0].id);
});

test('injects project docs into the default prompt and stays project-first', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  await manager.start({ project: '/workspace/demo', projectContext: '# 项目约定\n每次改动先跑测试' });
  await waitFor(() => fake.requests.some(request => request.method === 'session/prompt'));
  const text = fake.requests.find(request => request.method === 'session/prompt').params.prompt[0].text;
  assert.match(text, /# 项目约定/);
  assert.match(text, /每次改动先跑测试/);
  assert.ok(text.indexOf('项目约定') < text.indexOf('调度状态'), 'project context must come before status analysis');
  assert.match(text, /调度状态/);
  await manager.close(manager.list()[0].id);
});

test('starts the session inside the project repo and falls back to the console cwd', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const repo = mkdtempSync((await import('node:path')).join(tmpdir(), 'target-repo-'));
  mkdirSync((await import('node:path')).join(repo, '.git'), { recursive: true });
  let seenCwd;
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({
    cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js',
    spawnFn: (command, args, options) => { seenCwd = options.cwd; return fake.process; },
  });
  const started = await manager.start({ project: repo, projectContext: 'ctx' });
  assert.equal(seenCwd, repo, 'session must be spawned inside the project repo');
  assert.equal(started.cwd, repo);
  await manager.close(started.id);

  let fallbackCwd;
  const fake2 = fakeAdapter();
  const manager2 = new SchedulingSessionManager({
    cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js',
    spawnFn: (command, args, options) => { fallbackCwd = options.cwd; return fake2.process; },
  });
  const fallback = await manager2.start({ project: 'owner/not-on-disk' });
  assert.equal(fallbackCwd, '/workspace/control-plane', 'unknown projects fall back to the console cwd');
  await manager2.close(fallback.id);

  const plainDir = mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'plain-dir-'));
  let plainCwd;
  const fake3 = fakeAdapter();
  const manager3 = new SchedulingSessionManager({
    cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js',
    spawnFn: (command, args, options) => { plainCwd = options.cwd; return fake3.process; },
  });
  const plain = await manager3.start({ project: plainDir });
  assert.equal(plainCwd, '/workspace/control-plane', 'a directory without .git must not become the session cwd');
  await manager3.close(plain.id);
});

test('auto-approves file edits inside the writable scripts dir and cancels everything else', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const writableDir = mkdtempSync(path.join(tmpdir(), 'writable-'));
  const fake = fakeAdapter({ askPermission: true });
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process, writableDir });
  await manager.start({ prompt: '读取状态', project: 'owner-alpha/demo' });
  await waitFor(() => fake.requests.some(message => message.id === 'permission-1' && message.result));
  const denied = fake.requests.find(message => message.id === 'permission-1' && message.result);
  assert.equal(denied?.result.outcome.outcome, 'cancelled', 'permission without a known writable scope must be denied');
  await manager.close(manager.list()[0].id);

  // 手动构造带 locations 的编辑请求
  const requests = [];
  const { PassThrough } = await import('node:stream');
  const jsonLine = v => JSON.stringify(v) + '\n';
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  let buffer = '';
  const proc = { stdin, stdout, stderr, pid: 7, kill() { stdout.end(); } };
  stdin.on('data', chunk => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const req = JSON.parse(line); requests.push(req);
      if (req.method === 'initialize') stdout.write(jsonLine({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake' } } }));
      else if (req.method === 'session/new') stdout.write(jsonLine({ jsonrpc: '2.0', id: req.id, result: { sessionId: 's-perm' } }));
      else if (req.method === 'session/prompt') {
        stdout.write(jsonLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-perm', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } }));
        setTimeout(() => stdout.write(jsonLine({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } })), 5);
      } else if (req.method === 'session/close' || req.method === 'session/cancel') stdout.write(jsonLine({ jsonrpc: '2.0', id: req.id, result: {} }));
    }
  });
  const manager2 = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => proc, writableDir });
  await manager2.start({ project: 'owner-alpha/demo' });
  const perm = { jsonrpc: '2.0', id: 'perm-in', method: 'session/request_permission', params: { sessionId: 's-perm', toolCall: { toolCallId: 't1', kind: 'edit', status: 'pending', locations: [{ path: path.join(writableDir, 'scan.mjs') }] }, options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }, { optionId: 'deny', name: '拒绝', kind: 'reject_once' }] } };
  const permOut = { jsonrpc: '2.0', id: 'perm-out', method: 'session/request_permission', params: { sessionId: 's-perm', toolCall: { toolCallId: 't2', kind: 'edit', status: 'pending', locations: [{ path: '/etc/crontab' }] }, options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }] } };
  const permTraverse = { jsonrpc: '2.0', id: 'perm-tr', method: 'session/request_permission', params: { sessionId: 's-perm', toolCall: { toolCallId: 't3', kind: 'edit', status: 'pending', locations: [{ path: path.join(writableDir, '..', 'escape.mjs') }] }, options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }] } };
  const permExec = { jsonrpc: '2.0', id: 'perm-ex', method: 'session/request_permission', params: { sessionId: 's-perm', toolCall: { toolCallId: 't4', kind: 'execute', status: 'pending' }, options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }] } };
  const permAlways = { jsonrpc: '2.0', id: 'perm-al', method: 'session/request_permission', params: { sessionId: 's-perm', toolCall: { toolCallId: 't5', kind: 'edit', status: 'pending', locations: [{ path: path.join(writableDir, 'scan.mjs') }] }, options: [{ optionId: 'allow-always', name: '总是允许', kind: 'allow_always' }] } };
  const { symlinkSync } = await import('node:fs');
  const outsideFile = path.join(path.dirname(writableDir), 'outside-secret.txt');
  const linkPath = path.join(writableDir, 'linked-secret.txt');
  symlinkSync(outsideFile, linkPath);
  const permSymlink = { jsonrpc: '2.0', id: 'perm-sy', method: 'session/request_permission', params: { sessionId: 's-perm', toolCall: { toolCallId: 't6', kind: 'edit', status: 'pending', locations: [{ path: linkPath }] }, options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }] } };
  stdout.write(jsonLine(perm)); stdout.write(jsonLine(permOut)); stdout.write(jsonLine(permTraverse)); stdout.write(jsonLine(permExec)); stdout.write(jsonLine(permAlways)); stdout.write(jsonLine(permSymlink));
  await waitFor(() => requests.filter(r => typeof r.id === 'string' && r.id.startsWith('perm-') && r.result).length >= 6, 1000);
  const byId = id => requests.find(r => r.id === id && r.result);
  assert.ok(byId('perm-in') && byId('perm-out') && byId('perm-tr') && byId('perm-ex'), 'all four permission responses received');
  assert.equal(byId('perm-in').result.outcome.outcome, 'selected', 'edit inside writable dir must be approved');
  assert.equal(byId('perm-out').result.outcome.outcome, 'cancelled', 'edit outside writable dir must be cancelled');
  assert.equal(byId('perm-tr').result.outcome.outcome, 'cancelled', 'path traversal must be cancelled');
  assert.equal(byId('perm-ex').result.outcome.outcome, 'cancelled', 'shell execution must stay cancelled');
  assert.equal(byId('perm-al').result.outcome.outcome, 'cancelled', 'allow_always options must never be selected');
  assert.equal(byId('perm-sy').result.outcome.outcome, 'cancelled', 'symlinks pointing outside the writable dir must be cancelled');
  await manager2.close(manager2.list()[0].id);
  mkdirSync(path.join(writableDir, 'sub'), { recursive: true });
});

test('cancels ACP permission requests instead of approving them from the console', async () => {
  const fake = fakeAdapter({ askPermission: true });
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '读取调度状态', project: 'owner-alpha/demo' });
  await waitFor(() => fake.requests.some(message => message.id === 'permission-1' && message.result));
  const permissionResponse = fake.requests.find(message => message.id === 'permission-1' && message.result);
  assert.equal(permissionResponse?.result.outcome.outcome, 'cancelled');
  await waitFor(() => manager.list().find(session => session.id === started.id)?.status === 'idle');
  const listed = manager.list().find(session => session.id === started.id);
  assert.equal(listed.status, 'idle');
  assert.equal(listed.stopReason, 'end_turn');
  await manager.close(started.id);
});

test('enforces concurrency and prompt size without exposing process control to the browser', async () => {
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fakeAdapter().process, maxSessions: 1 });
  await manager.start({ prompt: '第一条', project: 'owner-alpha/demo' });
  await assert.rejects(manager.start({ prompt: '第二条', project: 'owner-beta/other' }), /最多/);
  await assert.rejects(manager.start({ prompt: 'x'.repeat(65000), project: 'owner-delta/big' }), /64000/);
  await manager.close(manager.list()[0].id);
  const bigContext = await manager.start({ project: 'owner-gamma/big', projectContext: 'y'.repeat(5000) });
  assert.match(manager.list().find(session => session.id === bigContext.id).prompt, /y{100}/);
  await manager.close(bigContext.id);
  await assert.rejects(manager.close('missing'), SchedulingSessionError);
});

test('rejects a start when the ACP adapter is missing and cleans up after initialize failures', async () => {
  const missing = new SchedulingSessionManager({ adapterPath: '/definitely/not/there.js' });
  await assert.rejects(missing.start({ project: 'owner/demo' }), /适配器/);

  const failing = fakeAdapter({ failInitialize: true });
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => failing.process });
  await assert.rejects(manager.start({ project: 'owner/demo' }), /开启调度会话失败/);
  assert.deepEqual(manager.list(), []);
  assert.ok(failing.process.killedWith, 'failed start must terminate the adapter process');
});

test('rejects control characters in project and prefers duplicate message over capacity limit', async () => {
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fakeAdapter().process, maxSessions: 1 });
  await manager.start({ project: 'owner/demo' });
  await assert.rejects(manager.start({ project: 'owner/demo' }), /已有进行中的调度会话/);
  await assert.rejects(manager.start({ project: 'owner/other' }), /最多同时开启/);
  await assert.rejects(manager.start({ project: 'bad\x00project' }), /控制字符/);
  await manager.close(manager.list()[0].id);
  const spaced = await manager.start({ project: '/Volumes/Storage/Home/Desktop/AI project/socialmore' });
  assert.equal(spaced.project, '/Volumes/Storage/Home/Desktop/AI project/socialmore');
  await manager.close(spaced.id);
});

test('rejects a second active session for the same project but allows other projects', async () => {
  const first = fakeAdapter();
  const second = fakeAdapter();
  let n = 0;
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => (++n === 1 ? first.process : second.process) });
  await manager.start({ project: '/Volumes/Storage/auto调度' });
  await assert.rejects(manager.start({ project: '/Volumes/Storage/auto调度' }), /已有进行中的调度会话/);
  const other = await manager.start({ project: 'owner/other' });
  assert.equal(manager.list().length, 2);
  for (const session of manager.list()) await manager.close(session.id);
});

test('drains adapter stderr so a chatty child cannot deadlock the session', async () => {
  const fake = fakeAdapter({ stderrBytes: 200 * 1024 });
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '检查状态', project: 'owner/demo' });
  await waitFor(() => manager.list().find(session => session.id === started.id)?.status === 'idle');
  assert.equal(manager.list()[0].stopReason, 'end_turn');
  await manager.close(started.id);
});

test('marks the session error when the adapter process exits on its own', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '读取状态', project: 'owner/demo' });
  await waitFor(() => manager.list().find(session => session.id === started.id)?.status === 'running');
  fake.process.kill('SIGKILL');
  await waitFor(() => manager.list().find(session => session.id === started.id)?.status === 'error');
  assert.match(manager.list()[0].error, /进程已退出|ACP connection closed/);
});

test('keeps a transcript and accepts follow-up messages while the agent is idle', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度分析', project: 'owner-alpha/demo' });
  await waitFor(() => manager.list()[0]?.status === 'idle');
  let listed = manager.list()[0];
  assert.deepEqual(listed.messages.map(message => message.role), ['user', 'agent']);
  assert.match(listed.messages[0].text, /首轮调度分析/);
  assert.match(listed.messages[1].text, /收到：你负责调度的项目/);
  assert.equal(listed.liveText, '');
  assert.equal(listed.busy, false);

  const sending = await manager.send(started.id, '第二轮重点看卡片');
  assert.equal(sending.busy, true);
  assert.deepEqual(sending.messages.map(message => message.role), ['user', 'agent', 'user']);
  await waitFor(() => manager.list()[0]?.status === 'idle');
  listed = manager.list()[0];
  assert.deepEqual(listed.messages.map(message => message.role), ['user', 'agent', 'user', 'agent']);
  assert.match(listed.messages[3].text, /收到：第二轮重点看卡片/);

  await assert.rejects(manager.send(started.id, '   '), /发送内容/);
  await assert.rejects(manager.send('missing', '你好'), SchedulingSessionError);
  await manager.close(started.id);
  await assert.rejects(manager.send(started.id, '还在吗'), /不存在/);
});

test('session/new carries the autoloop-hub MCP server pointing at the bundled read-only tools script', async () => {
  const { existsSync } = await import('node:fs');
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  await manager.start({ project: '/workspace/demo', projectContext: 'ctx' });
  await waitFor(() => fake.requests.some(request => request.method === 'session/new'));
  const newRequest = fake.requests.find(request => request.method === 'session/new');
  assert.equal(Array.isArray(newRequest.params.mcpServers), true);
  assert.equal(newRequest.params.mcpServers.length, 1);
  const server = newRequest.params.mcpServers[0];
  assert.equal(server.name, 'autoloop-hub');
  assert.equal(server.command, process.execPath);
  assert.equal(server.args.length, 1);
  assert.ok(existsSync(server.args[0]), 'MCP 脚本路径必须存在');
  assert.match(server.args[0], /src[\/]mcp[\/]hub-tools\.mjs$/);
  assert.ok(Array.isArray(server.env), 'env 透传必须是 EnvVariable 数组');
  const homeVar = server.env.find(item => item.name === 'AGENT_AUTOLOOP_HOME');
  assert.ok(homeVar, '必须透传 AGENT_AUTOLOOP_HOME 给 MCP 子进程');
  await manager.close(manager.list()[0].id);
});

test('scheduling prompt instructs native MCP tools first and keeps the console API as fallback', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  await manager.start({ project: '/workspace/demo', projectContext: 'ctx' });
  await waitFor(() => fake.requests.some(request => request.method === 'session/prompt'));
  const text = fake.requests.find(request => request.method === 'session/prompt').params.prompt[0].text;
  assert.match(text, /autoloop-hub MCP 工具/);
  assert.match(text, /list_rules\/list_runs\/list_cards/);
  assert.match(text, /resume_rule\/run_rule/);
  assert.match(text, /自愈闭环/);
  assert.match(text, /最多重试 3 次/);
  assert.doesNotMatch(text, /curl/);
  await manager.close(manager.list()[0].id);
});

// 受控适配器：session/prompt 的响应由测试手动释放，用来覆盖运行中排队/打断语义。
function controlledAdapter() {
  const requests = [];
  const prompts = [];
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  let buffer = '';
  const proc = { stdin, stdout, stderr, pid: 77, kill() { stdout.end(); } };
  const respond = (request, result) => stdout.write(jsonLine({ jsonrpc: '2.0', id: request.id, result }));
  stdin.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      requests.push(request);
      if (request.method === 'initialize') respond(request, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { prompt: true } }, agentInfo: { name: 'fake-codex', version: '0' } });
      else if (request.method === 'session/new') respond(request, { sessionId: 'ctrl-session' });
      else if (request.method === 'session/prompt') prompts.push(request);
      else if (request.method === 'session/cancel' || request.method === 'session/close') respond(request, {});
    }
  });
  const endTurn = (request, text = '本轮回复') => {
    stdout.write(jsonLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ctrl-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }));
    respond(request, { stopReason: 'end_turn' });
  };
  return { process: proc, requests, prompts, endTurn };
}

test('queues follow-up messages while the agent is running and flushes them in order after the turn', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;

  const queued = await manager.send(id, '补充：先看 NAS 部署');
  assert.equal(queued.status, 'running');
  assert.equal(queued.queuedCount, 1, 'a busy session must accept the message into the queue');
  assert.equal(fake.prompts.length, 1, 'queued messages must not interrupt the running turn');
  await manager.send(id, '再看 Phase1 门禁');
  assert.equal(manager.list()[0].queuedCount, 2);

  fake.endTurn(fake.prompts[0]);
  await waitFor(() => fake.prompts.length === 2);
  assert.match(fake.prompts[1].params.prompt[0].text, /补充：先看 NAS 部署/);
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => fake.prompts.length === 3);
  assert.match(fake.prompts[2].params.prompt[0].text, /再看 Phase1 门禁/);
  fake.endTurn(fake.prompts[2]);
  await waitFor(() => manager.list()[0].status === 'idle' && manager.list()[0].queuedCount === 0);

  const transcript = manager.list()[0].messages.map(message => `${message.role}:${message.text.slice(0, 8)}`);
  assert.deepEqual(transcript, ['user:你负责调度的项目', 'agent:本轮回复', 'user:补充：先看 NA', 'agent:本轮回复', 'user:再看 Phase', 'agent:本轮回复'], 'queued user messages must land between turns in send order');
  await manager.close(id);
});

test('interrupt cancels the running turn and delivers the new message immediately after', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;

  const interrupted = await manager.send(id, '方向变了，停下', { interrupt: true });
  assert.equal(interrupted.queuedCount, 1, 'interrupt message is delivered ahead of the queue');
  assert.ok(fake.requests.some(request => request.method === 'session/cancel'), 'interrupt must call session/cancel');
  assert.equal(fake.prompts.length, 1, 'no new prompt before the cancelled turn settles');

  fake.endTurn(fake.prompts[0]);
  await waitFor(() => fake.prompts.length === 2);
  assert.match(fake.prompts[1].params.prompt[0].text, /方向变了，停下/);
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => manager.list()[0].status === 'idle');
  const transcript = manager.list()[0].messages.map(message => `${message.role}:${message.text.slice(0, 6)}`);
  assert.deepEqual(transcript, ['user:你负责调度的', 'user:方向变了，停', 'agent:本轮回复'], 'an interrupted turn must not record a partial agent reply');
  await manager.close(id);
});

test('interrupt with an empty text stops the turn without sending a new prompt', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;

  await manager.send(id, '', { interrupt: true });
  assert.ok(fake.requests.some(request => request.method === 'session/cancel'));
  assert.equal(fake.prompts.length, 1);

  fake.endTurn(fake.prompts[0]);
  await waitFor(() => manager.list()[0].status === 'idle');
  assert.equal(fake.prompts.length, 1, 'stop-only interrupt must not start a new turn');
  assert.equal(manager.list()[0].messages.filter(message => message.role === 'user').length, 1, 'no empty user message recorded');
  await manager.close(id);
});

test('a genuine turn failure still marks the session as error instead of hiding it', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const request = fake.prompts[0];
  fake.process.stdout.write(jsonLine({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'prompt boom' } }));
  await waitFor(() => manager.list()[0].status === 'error');
  assert.match(manager.list()[0].error, /prompt boom/);
  await manager.close(started.id);
});
