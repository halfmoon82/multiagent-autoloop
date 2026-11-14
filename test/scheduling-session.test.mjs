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
