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
  const first = fakeAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => first.process, maxSessions: 1 });
  await manager.start({ prompt: '第一条', project: 'owner-alpha/demo' });
  await assert.rejects(manager.start({ prompt: '第二条', project: 'owner-alpha/demo' }), /最多/);
  await assert.rejects(manager.start({ prompt: 'x'.repeat(4001), project: 'owner-alpha/demo' }), /4000 字/);
  await assert.rejects(manager.close('missing'), SchedulingSessionError);
  await manager.close(manager.list()[0].id);
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
  assert.match(listed.messages[1].text, /收到：你负责的项目标识是/);
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
