import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SchedulingSessionManager, SchedulingSessionError } from '../src/scheduling-session.mjs';
import { HubSchedulingSessionAdapter, HUB_SCHEDULING_AGENT_LABEL } from '../src/hub-scheduling-session.mjs';

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
      } else if (request.method === 'session/set_mode') {
        respond(request, {});
      } else if (request.method === 'session/set_config_option') {
        respond(request, { configOptions: [{ id: request.params.configId, currentValue: request.params.value }] });
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
  const manager = new SchedulingSessionManager({ hubScheduling: false,
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
  assert.deepEqual(fake.requests.map(request => request.method), ['initialize', 'session/new', 'session/set_mode', 'session/set_config_option', 'session/prompt']);
  assert.equal(fake.requests[1].params.cwd, '/workspace/control-plane');
  assert.deepEqual(fake.requests[3].params, { sessionId: 'fake-session', configId: 'mode', value: 'read-only' });
  assert.equal(fake.requests[4].params.sessionId, 'fake-session');
  assert.equal(fake.requests[4].params.prompt[0].type, 'text');
  assert.match(fake.requests[4].params.prompt[0].text, /检查当前待调度事项/);
  assert.match(fake.requests[4].params.prompt[0].text, /owner-alpha\/demo/);
  assert.equal(manager.list().length, 1);

  await manager.close(started.id);
  assert.equal(fake.process.killedWith, 'SIGTERM');
  assert.deepEqual(manager.list(), []);
});

test('keeps behavioral guardrails inline and routes console docs through read_console_doc', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  await manager.start({ project: '/workspace/demo' });
  await waitFor(() => fake.requests.some(request => request.method === 'session/prompt'));
  const text = fake.requests.find(request => request.method === 'session/prompt').params.prompt[0].text;
  // 行为护栏必须在开局内联生效
  assert.match(text, /重试/);
  assert.match(text, /升级最小门禁/);
  assert.match(text, /worktree/);
  // 控制台文档不再内联全文，改为 read_console_doc 按需获取 + 文档索引
  assert.match(text, /read_console_doc/);
  assert.match(text, /docs\/scheduling-contract\.md/);
  assert.match(text, /事件 subject 使用无空格的稳定 ASCII 标识/);
  assert.match(text, /穷尽仍失败的任务，挂起并在会话中升级给用户/);
  // 实现边界：实现类任务必须派发独立 worker，禁止本会话亲自实施或派子智能体代劳
  assert.match(text, /禁止本会话亲自写项目代码/);
  assert.match(text, /派生子智能体\/子会话代劳/);
  assert.match(text, /等同于本会话直接实施/);
  assert.match(text, /琐碎自愈（本地调度脚本、配置、状态、规则的小修/);
  // 升级门禁的"执行"主语必须是调度体系（派发 worker），不是本会话自己
  assert.doesNotMatch(text, /由你自行决定、执行并担责/);
  assert.match(text, /组织派发/);
  assert.ok(!text.includes('【项目资料】'), 'project docs must not be inlined anymore');
  assert.ok(!text.includes('【调度契约】'), 'console contract must not be inlined anymore');
  await manager.close(manager.list()[0].id);
});

test('prompt stays slim: no doc injection parameters are accepted or required', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  await manager.start({ project: '/workspace/demo' });
  await waitFor(() => fake.requests.some(request => request.method === 'session/prompt'));
  const text = fake.requests.find(request => request.method === 'session/prompt').params.prompt[0].text;
  assert.ok(text.length < 6000, `scheduling prompt should stay slim, got ${text.length} chars`);
  // 项目上下文改为"cwd 即项目仓库，自己读盘"的指令
  assert.match(text, /工作目录就是该项目仓库/);
  assert.match(text, /AGENTS\.md/);
  assert.ok(text.indexOf('项目仓库') < text.indexOf('list_rules'), 'project orientation must come before status analysis');
  assert.match(text, /list_rules/);
  await manager.close(manager.list()[0].id);
});

test('starts the session inside the project repo and falls back to the console cwd', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const repo = mkdtempSync((await import('node:path')).join(tmpdir(), 'target-repo-'));
  mkdirSync((await import('node:path')).join(repo, '.git'), { recursive: true });
  let seenCwd;
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false,
    cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js',
    spawnFn: (command, args, options) => { seenCwd = options.cwd; return fake.process; },
  });
  const started = await manager.start({ project: repo });
  assert.equal(seenCwd, repo, 'session must be spawned inside the project repo');
  assert.equal(started.cwd, repo);
  await manager.close(started.id);

  let fallbackCwd;
  const fake2 = fakeAdapter();
  const manager2 = new SchedulingSessionManager({ hubScheduling: false,
    cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js',
    spawnFn: (command, args, options) => { fallbackCwd = options.cwd; return fake2.process; },
  });
  const fallback = await manager2.start({ project: 'owner/not-on-disk' });
  assert.equal(fallbackCwd, '/workspace/control-plane', 'unknown projects fall back to the console cwd');
  await manager2.close(fallback.id);

  const plainDir = mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'plain-dir-'));
  let plainCwd;
  const fake3 = fakeAdapter();
  const manager3 = new SchedulingSessionManager({ hubScheduling: false,
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
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process, writableDir });
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
      else if (req.method === 'session/set_mode') stdout.write(jsonLine({ jsonrpc: '2.0', id: req.id, result: {} }));
      else if (req.method === 'session/set_config_option') stdout.write(jsonLine({ jsonrpc: '2.0', id: req.id, result: { configOptions: [{ id: req.params.configId, currentValue: req.params.value }] } }));
      else if (req.method === 'session/prompt') {
        stdout.write(jsonLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-perm', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } }));
        setTimeout(() => stdout.write(jsonLine({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } })), 5);
      } else if (req.method === 'session/close' || req.method === 'session/cancel') stdout.write(jsonLine({ jsonrpc: '2.0', id: req.id, result: {} }));
    }
  });
  const manager2 = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => proc, writableDir });
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
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
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
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fakeAdapter().process, maxSessions: 1 });
  await manager.start({ prompt: '第一条', project: 'owner-alpha/demo' });
  await assert.rejects(manager.start({ prompt: '第二条', project: 'owner-beta/other' }), /最多/);
  await assert.rejects(manager.start({ prompt: 'x'.repeat(65000), project: 'owner-delta/big' }), /64000/);
  await manager.close(manager.list()[0].id);
  const bigContext = await manager.start({ project: 'owner-gamma/big', prompt: 'y'.repeat(5000) });
  assert.match(manager.list().find(session => session.id === bigContext.id).prompt, /y{100}/);
  await manager.close(bigContext.id);
  await assert.rejects(manager.close('missing'), SchedulingSessionError);
});

test('rejects a start when the ACP adapter is missing and cleans up after initialize failures', async () => {
  const missing = new SchedulingSessionManager({ hubScheduling: false, adapterPath: '/definitely/not/there.js' });
  await assert.rejects(missing.start({ project: 'owner/demo' }), /适配器/);

  const failing = fakeAdapter({ failInitialize: true });
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => failing.process });
  await assert.rejects(manager.start({ project: 'owner/demo' }), /开启调度会话失败/);
  assert.deepEqual(manager.list(), []);
  assert.ok(failing.process.killedWith, 'failed start must terminate the adapter process');
});

test('rejects control characters in project and prefers duplicate message over capacity limit', async () => {
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fakeAdapter().process, maxSessions: 1 });
  await manager.start({ project: 'owner/demo' });
  await assert.rejects(manager.start({ project: 'owner/demo' }), /已有进行中的调度会话/);
  await assert.rejects(manager.start({ project: 'owner/other' }), /最多同时开启/);
  await assert.rejects(manager.start({ project: 'bad\x00project' }), /控制字符/);
  await manager.close(manager.list()[0].id);
  const spaced = await manager.start({ project: '/home/alice/projects/AI project demo' });
  assert.equal(spaced.project, '/home/alice/projects/AI project demo');
  await manager.close(spaced.id);
});

test('rejects a second active session for the same project but allows other projects', async () => {
  const first = fakeAdapter();
  const second = fakeAdapter();
  let n = 0;
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => (++n === 1 ? first.process : second.process) });
  await manager.start({ project: '/home/alice/projects/console' });
  await assert.rejects(manager.start({ project: '/home/alice/projects/console' }), /已有进行中的调度会话/);
  const other = await manager.start({ project: 'owner/other' });
  assert.equal(manager.list().length, 2);
  for (const session of manager.list()) await manager.close(session.id);
});

test('drains adapter stderr so a chatty child cannot deadlock the session', async () => {
  const fake = fakeAdapter({ stderrBytes: 200 * 1024 });
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '检查状态', project: 'owner/demo' });
  await waitFor(() => manager.list().find(session => session.id === started.id)?.status === 'idle');
  assert.equal(manager.list()[0].stopReason, 'end_turn');
  await manager.close(started.id);
});

test('marks the session error when the adapter process exits on its own', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '读取状态', project: 'owner/demo' });
  await waitFor(() => manager.list().find(session => session.id === started.id)?.status === 'running');
  fake.process.kill('SIGKILL');
  await waitFor(() => manager.list().find(session => session.id === started.id)?.status === 'error');
  assert.match(manager.list()[0].error, /进程已退出|ACP connection closed/);
});

test('keeps a transcript and accepts follow-up messages while the agent is idle', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度分析', project: 'owner-alpha/demo' });
  await waitFor(() => manager.list()[0]?.status === 'idle');
  let listed = manager.list()[0];
  assert.deepEqual(listed.messages.map(message => message.role), ['user', 'agent']);
  assert.match(listed.messages[0].text, /首轮调度分析/);
  assert.match(listed.messages[1].text, /收到：你是 Multiagen/);
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
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  await manager.start({ project: '/workspace/demo' });
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
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  await manager.start({ project: '/workspace/demo' });
  await waitFor(() => fake.requests.some(request => request.method === 'session/prompt'));
  const text = fake.requests.find(request => request.method === 'session/prompt').params.prompt[0].text;
  assert.match(text, /autoloop-hub MCP 工具/);
  assert.match(text, /list_rules/);
  assert.match(text, /list_runs/);
  assert.match(text, /list_cards/);
  assert.match(text, /read_console_doc/);
  assert.match(text, /resume_rule/);
  assert.match(text, /自愈闭环/);
  assert.match(text, /满 3 次仍失败/);
  assert.doesNotMatch(text, /curl/);
  await manager.close(manager.list()[0].id);
});

// 受控适配器：session/prompt 的响应由测试手动释放，用来覆盖运行中排队/打断语义。
function controlledAdapter({ holdInitialize = false, rejectPromptOnCancel = false, failSteering = false } = {}) {
  const requests = [];
  const prompts = [];
  const steers = [];
  const heldInitializes = [];
  let turnActive = false;
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  let buffer = '';
  const proc = { stdin, stdout, stderr, pid: 77, kill() { stdout.end(); } };
  const respond = (request, result) => stdout.write(jsonLine({ jsonrpc: '2.0', id: request.id, result }));
  const initializeResult = request => ({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { prompt: true } }, agentInfo: { name: 'fake-codex', version: '0' } });
  stdin.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      requests.push(request);
      if (request.method === 'initialize') {
        if (holdInitialize) heldInitializes.push(request);
        else respond(request, initializeResult(request));
      }
      else if (request.method === 'session/new') respond(request, { sessionId: 'ctrl-session' });
      else if (request.method === 'session/set_mode') respond(request, {});
      else if (request.method === 'session/set_config_option') respond(request, { configOptions: [{ id: request.params.configId, currentValue: request.params.value }] });
      else if (request.method === 'session/prompt') { prompts.push(request); turnActive = true; }
      else if (request.method === '_session/steering') {
        steers.push(request);
        if (failSteering) stdout.write(jsonLine({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'connection reset by peer' } }));
        else if (turnActive) respond(request, { outcome: 'steeredActiveTurn' });
        else respond(request, { error: { code: -32602, message: 'no active turn to steer' } });
      }
      else if (request.method === 'session/cancel') {
        respond(request, {});
        if (rejectPromptOnCancel && prompts.length) {
          const pending = prompts[prompts.length - 1];
          turnActive = false;
          stdout.write(jsonLine({ jsonrpc: '2.0', id: pending.id, error: { code: -32800, message: 'request cancelled' } }));
        }
      }
      else if (request.method === 'session/close') respond(request, {});
    }
  });
  const endTurn = (request, text = '本轮回复') => {
    turnActive = false;
    stdout.write(jsonLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ctrl-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }));
    respond(request, { stopReason: 'end_turn' });
  };
  const releaseInitialize = () => { for (const request of heldInitializes.splice(0)) respond(request, initializeResult(request)); };
  return { process: proc, requests, prompts, steers, endTurn, releaseInitialize };
}

test('queues follow-up messages while the agent is running and flushes them in order after the turn', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;

  const queued = await manager.send(id, '补充：先看 NAS 部署');
  assert.equal(queued.status, 'running');
  assert.equal(queued.queuedCount, 1, 'a busy session must accept the message into the queue');
  assert.equal(fake.prompts.length, 1, 'queued messages must not interrupt the running turn');
  await manager.send(id, '再看 Phase1 门禁');
  assert.equal(manager.list()[0].queuedCount, 2);
  const exposed = manager.list()[0].queued;
  assert.deepEqual(exposed.map(item => item.text), ['补充：先看 NAS 部署', '再看 Phase1 门禁'], 'queued messages must be exposed with their texts in send order');
  assert.ok(exposed.every(item => typeof item.id === 'string' && item.id.length > 0 && typeof item.at === 'string'), 'each queued item must carry a stable id and timestamp');

  fake.endTurn(fake.prompts[0]);
  await waitFor(() => fake.prompts.length === 2);
  assert.match(fake.prompts[1].params.prompt[0].text, /补充：先看 NAS 部署/);
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => fake.prompts.length === 3);
  assert.match(fake.prompts[2].params.prompt[0].text, /再看 Phase1 门禁/);
  fake.endTurn(fake.prompts[2]);
  await waitFor(() => manager.list()[0].status === 'idle' && manager.list()[0].queuedCount === 0);

  const transcript = manager.list()[0].messages.map(message => `${message.role}:${message.text.slice(0, 8)}`);
  assert.deepEqual(transcript, ['user:你是 Multi', 'agent:本轮回复', 'user:补充：先看 NA', 'agent:本轮回复', 'user:再看 Phase', 'agent:本轮回复'], 'queued user messages must land between turns in send order');
  await manager.close(id);
});

test('removeQueued drops only the chosen queued message and unknown ids are 404', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;
  await manager.send(id, '第一条');
  await manager.send(id, '第二条');
  const listed = manager.list()[0];
  const removed = await manager.removeQueued(id, listed.queued[0].id);
  assert.deepEqual(removed.queued.map(item => item.text), ['第二条'], 'removeQueued must drop only the chosen message');
  assert.equal(removed.queuedCount, 1);
  await assert.rejects(() => manager.removeQueued(id, 'no-such-item'), error => error.status === 404, 'unknown queue item must be 404');
  await assert.rejects(() => manager.removeQueued('no-such-session', listed.queued[0].id), error => error.status === 404, 'unknown session must be 404');
  fake.endTurn(fake.prompts[0]);
  await waitFor(() => fake.prompts.length === 2, 'the surviving queued message must be delivered after the turn');
  assert.match(fake.prompts[1].params.prompt[0].text, /第二条/);
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => manager.list()[0].status === 'idle' && manager.list()[0].queuedCount === 0);
  const texts = manager.list()[0].messages.map(message => message.text);
  assert.ok(texts.includes('第二条') && !texts.includes('第一条'), 'removed queued message must never be delivered');
  await manager.close(id);
  await assert.rejects(() => manager.removeQueued(id, 'whatever'), error => error.status === 404 && /不存在/.test(error.message), 'a closed session is destroyed, so removal must be a plain 404');
});

test('updateQueued edits in place, moveQueued reorders within bounds, clearQueued empties the queue', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;
  await manager.send(id, '第一条');
  await manager.send(id, '第二条');
  await manager.send(id, '第三条');
  const listed = manager.list()[0];
  const edited = await manager.updateQueued(id, listed.queued[1].id, '第二条（改）');
  assert.deepEqual(edited.queued.map(item => item.text), ['第一条', '第二条（改）', '第三条'], 'updateQueued must edit the queued message in place');
  await assert.rejects(() => manager.updateQueued(id, 'no-such-item', 'x'), error => error.status === 404, 'editing an unknown item must be 404');
  const moved = await manager.moveQueued(id, edited.queued[2].id, 'up');
  assert.deepEqual(moved.queued.map(item => item.text), ['第一条', '第三条', '第二条（改）'], 'moveQueued up must swap with the previous item');
  const noop = await manager.moveQueued(id, moved.queued[0].id, 'up');
  assert.deepEqual(noop.queued.map(item => item.text), ['第一条', '第三条', '第二条（改）'], 'moving the head up must be a no-op');
  const cleared = await manager.clearQueued(id);
  assert.equal(cleared.queuedCount, 0, 'clearQueued must empty the queue');
  fake.endTurn(fake.prompts[0]);
  await waitFor(() => manager.list()[0].status === 'idle');
  await manager.close(id);
});

test('steer in injects the queued message into the live turn via _session/steering, without cancelling', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;
  await manager.send(id, '第一条');
  await manager.send(id, '第二条');
  const listed = manager.list()[0];
  const steered = await manager.steerQueued(id, listed.queued[1].id);
  assert.deepEqual(steered.queued.map(item => item.text), ['第一条'], 'steered-in message leaves the queue and enters the live turn');
  assert.equal(fake.steers.length, 1, 'steer in must call the native _session/steering method');
  assert.match(fake.steers[0].params.prompt[0].text, /第二条/);
  assert.ok(!fake.requests.some(request => request.method === 'session/cancel'), 'steer in must NOT cancel the running turn');
  assert.equal(fake.prompts.length, 1, 'steering injects into the live turn without starting a new one');
  await assert.rejects(() => manager.steerQueued(id, 'no-such-item'), error => error.status === 404, 'steering an unknown item must be 404');
  fake.endTurn(fake.prompts[0]);
  await waitFor(() => fake.prompts.length === 2, 2000);
  assert.match(fake.prompts[1].params.prompt[0].text, /第一条/, 'the remaining queue continues automatically after the steered turn ends');
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => manager.list()[0].status === 'idle', 2000);
  await manager.close(id);
});

test('a steering transport failure reports 502 and restores the message to the queue', async () => {
  const fake = controlledAdapter({ failSteering: true });
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;
  await manager.send(id, '第一条');
  await manager.send(id, '第二条');
  const listed = manager.list()[0];
  await assert.rejects(() => manager.steerQueued(id, listed.queued[1].id), error => error.status === 502, 'a steering transport failure must be 502');
  const after = manager.list()[0];
  assert.deepEqual(after.queued.map(item => item.text), ['第二条', '第一条'], 'a failed steer must restore the message to the queue head');
  await manager.close(id);
});

test('a send during the settle window wins and the settle timer then no-ops', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process, settleMs: 120 });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;
  await manager.send(id, '排队一');
  await manager.send(id, '', { interrupt: true });
  fake.endTurn(fake.prompts[0]);
  await new Promise(resolve => setTimeout(resolve, 10)); // finish 已跑、settle 定时器（120ms）未到期
  await manager.send(id, '插队新消息'); // settle 窗口内直接发送：立即开轮
  await waitFor(() => fake.prompts.length === 2, 2000);
  assert.match(fake.prompts[1].params.prompt[0].text, /插队新消息/);
  await new Promise(resolve => setTimeout(resolve, 200)); // settle 定时器触发：会话在运行，必须空转不抢跑
  assert.equal(fake.prompts.length, 2, 'the settle timer must no-op when a new turn already started');
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => fake.prompts.length === 3, 2000);
  assert.match(fake.prompts[2].params.prompt[0].text, /排队一/, 'the queued message must continue automatically after the intervening turn');
  fake.endTurn(fake.prompts[2]);
  await waitFor(() => manager.list()[0].status === 'idle', 2000);
  await manager.close(id);
});

test('closing during the settle window is safe when the timer fires', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process, settleMs: 40 });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;
  await manager.send(id, '排队一');
  await manager.send(id, '', { interrupt: true });
  fake.endTurn(fake.prompts[0]);
  await new Promise(resolve => setTimeout(resolve, 10));
  await manager.close(id);
  await new Promise(resolve => setTimeout(resolve, 120)); // settle 定时器在已销毁会话上触发：必须静默兜底
  assert.ok(manager.list().length === 0, 'the session stays closed after the settle timer fires');
});

test('steer in with no active turn starts a new turn immediately and keeps the remaining queue', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process, settleMs: 200 });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;
  await manager.send(id, '第一条');
  await manager.send(id, '第二条');
  await manager.send(id, '', { interrupt: true });
  fake.endTurn(fake.prompts[0]);
  await new Promise(resolve => setTimeout(resolve, 20)); // finish 已跑（微任务）、settle 窗口（200ms）未到期：会话空闲且队列仍在
  const listed = manager.list()[0];
  assert.equal(listed.status, 'idle');
  assert.equal(listed.queued.length, 2, '队列在 settle 窗口内保持待送达');
  const steered = await manager.steerQueued(id, listed.queued[1].id);
  assert.equal(fake.steers.length, 0, '会话已不在运行，不应走 steering 注入');
  assert.deepEqual(steered.queued.map(item => item.text), ['第一条'], 'steered-in message leaves the queue');
  await waitFor(() => fake.prompts.length === 2, 2000);
  assert.match(fake.prompts[1].params.prompt[0].text, /第二条/, 'with no active turn the steered message must start a new turn immediately');
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => fake.prompts.length === 3, 2000);
  assert.match(fake.prompts[2].params.prompt[0].text, /第一条/, 'remaining queue keeps its order');
  fake.endTurn(fake.prompts[2]);
  await waitFor(() => manager.list()[0].status === 'idle', 2000);
  await manager.close(id);
});

test('interrupt is a pure stop and the queue continues automatically after the turn settles', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process, settleMs: 30 });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;
  await manager.send(id, '排队一');
  await manager.send(id, '排队二');
  // 与 Codex 原生 Stop 一致：纯停止本轮、不动队列；轮次收尾后队列自动按序续跑
  const interrupted = await manager.send(id, '', { interrupt: true });
  assert.equal(interrupted.queuePaused, undefined, 'interrupt must not pause the queue');
  assert.equal(interrupted.queuedCount, 2, 'interrupt must not consume or inject queue items');
  assert.ok(fake.requests.some(request => request.method === 'session/cancel'), 'interrupt must call session/cancel');
  fake.endTurn(fake.prompts[0]);
  await waitFor(() => fake.prompts.length === 2, 2000); // settle 窗口后自动续跑，无需手动恢复
  assert.match(fake.prompts[1].params.prompt[0].text, /排队一/);
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => fake.prompts.length === 3, 2000);
  assert.match(fake.prompts[2].params.prompt[0].text, /排队二/);
  fake.endTurn(fake.prompts[2]);
  await waitFor(() => manager.list()[0].status === 'idle' && manager.list()[0].queuedCount === 0, 2000);
  await manager.close(id);
});

test('interrupt with an empty text stops the turn without sending a new prompt', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;

  const stopped = await manager.send(id, '', { interrupt: true });
  assert.ok(fake.requests.some(request => request.method === 'session/cancel'));
  assert.equal(fake.prompts.length, 1);
  assert.equal(stopped.queuedCount, 0, 'a pure stop marker must not be exposed as a queued message');
  assert.deepEqual(stopped.queued, [], 'a pure stop marker must not appear in the queued list');

  fake.endTurn(fake.prompts[0]);
  await waitFor(() => manager.list()[0].status === 'idle');
  assert.equal(fake.prompts.length, 1, 'stop-only interrupt must not start a new turn');
  assert.equal(manager.list()[0].messages.filter(message => message.role === 'user').length, 1, 'no empty user message recorded');
  await manager.close(id);
});

test('a genuine turn failure still marks the session as error instead of hiding it', async () => {
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const request = fake.prompts[0];
  fake.process.stdout.write(jsonLine({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'prompt boom' } }));
  await waitFor(() => manager.list()[0].status === 'error');
  assert.match(manager.list()[0].error, /prompt boom/);
  await manager.close(started.id);
});

test('a cancel-induced prompt rejection settles as interrupted, not error, and the queue still drains', async () => {
  const fake = controlledAdapter({ rejectPromptOnCancel: true });
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process, settleMs: 30 });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;

  await manager.send(id, '排队一');
  await manager.send(id, '', { interrupt: true }); // 纯停止：文本被忽略
  await waitFor(() => fake.prompts.length === 2, 2000); // cancel 拒绝结算 → settle → 队列自动续跑
  assert.match(fake.prompts[1].params.prompt[0].text, /排队一/);
  assert.equal(manager.list()[0].error, null, 'a cancel-induced rejection must not mark the session as error');
  const transcript = manager.list()[0].messages.map(message => `${message.role}:${message.text.slice(0, 4)}`);
  assert.deepEqual(transcript, ['user:你是 M', 'user:排队一'], 'the interrupted turn leaves no partial agent reply and no phantom interrupt message');
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => manager.list()[0].status === 'idle', 2000);
  await manager.close(id);
});

test('steerQueued is rejected with 409 before touching the queue while initializing or in error', async () => {
  const fake = controlledAdapter({ holdInitialize: true });
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const starting = manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => manager.list().length === 1);
  const id = manager.list()[0].id;
  await manager.send(id, '初始化期间排一条');
  const itemId = manager.list()[0].queued[0].id;
  await assert.rejects(() => manager.steerQueued(id, itemId), error => error.status === 409, 'steering during initialization must be 409');
  assert.deepEqual(manager.list()[0].queued.map(item => item.text), ['初始化期间排一条'], 'a rejected steer must leave the queue untouched');
  fake.releaseInitialize();
  await starting;
  await waitFor(() => fake.prompts.length === 1);
  fake.endTurn(fake.prompts[0]);
  await waitFor(() => fake.prompts.length === 2, 'the queued message must still be deliverable after the rejected steer');
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => manager.list()[0].status === 'idle');
  await manager.close(id);
  await assert.rejects(() => manager.steerQueued(id, 'whatever'), error => error.status === 404, 'a destroyed session must be 404');
});

test('interrupt is rejected while the session is still initializing, while queueing stays open', async () => {
  const fake = controlledAdapter({ holdInitialize: true });
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  const starting = manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => manager.list().length === 1);
  const id = manager.list()[0].id;
  assert.equal(manager.list()[0].status, 'initializing');

  await assert.rejects(() => manager.send(id, '打断', { interrupt: true }), /初始化中/, 'interrupt must not fire into a session without a session id');
  const queued = await manager.send(id, '初始化期间排一条');
  assert.equal(queued.queuedCount, 1, 'queueing stays open during initialization');

  fake.releaseInitialize();
  await starting;
  await waitFor(() => fake.prompts.length === 1);
  fake.endTurn(fake.prompts[0]);
  await waitFor(() => fake.prompts.length === 2);
  assert.match(fake.prompts[1].params.prompt[0].text, /初始化期间排一条/);
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => manager.list()[0].status === 'idle');
  await manager.close(id);
});

test('sessions persist to the archive and reappear as interrupted after a simulated restart', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'sess-archive-'));
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process, archiveRoot: home });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.requests.some(message => message.method === 'session/prompt'));
  await manager.send(started.id, '补充一条');
  await waitFor(() => manager.list()[0].status === 'idle');

  // 模拟重启：新管理器实例同一运行目录
  const revived = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fakeAdapter().process, archiveRoot: home });
  assert.equal(revived.list().length, 0, 'active sessions live in memory only');
  const archived = await revived.listArchived();
  assert.equal(archived.length, 1);
  assert.equal(archived[0].endStatus, 'interrupted');
  assert.equal(archived[0].project, 'owner-alpha/demo');
  assert.equal(archived[0].messages.length, 4, 'transcript includes both turns and the follow-up');
  await manager.close(started.id);
});

test('closed sessions archive as closed and continue starts a new session with the transcript', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'sess-archive-'));
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process, archiveRoot: home });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => manager.list()[0].status === 'idle');
  await manager.close(started.id);
  const archived = await manager.listArchived();
  assert.equal(archived[0].endStatus, 'closed');

  const fake2 = fakeAdapter();
  const manager2 = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake2.process, archiveRoot: home });
  const continued = await manager2.continueSession(started.id);
  assert.equal(continued.continuedFrom, started.id, 'the new session records where it came from');
  await waitFor(() => fake2.requests.some(message => message.method === 'session/prompt'));
  const sentPrompt = fake2.requests.find(message => message.method === 'session/prompt');
  assert.match(sentPrompt.params.prompt[0].text, /会话续跑/);
  assert.match(sentPrompt.params.prompt[0].text, /首轮调度/, 'original scheduling brief is included');
  assert.match(sentPrompt.params.prompt[0].text, /先简要汇报上次中断时的状态/);
  await manager2.close(continued.id);
});

test('continueSession rejects unknown archives', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fakeAdapter().process, archiveRoot: mkdtempSync(join(tmpdir(), 'sess-archive-')) });
  await assert.rejects(() => manager.continueSession('99999999-9999-9999-9999-999999999999'), /存档不存在/);
});

test('active in-memory sessions never appear in the archived list', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'sess-archive-'));
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process, archiveRoot: home });
  await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.requests.some(message => message.method === 'session/prompt'));
  const archived = await manager.listArchived();
  assert.equal(archived.length, 0, 'an active session must not surface as archived while it lives in memory');
  await manager.close(manager.list()[0].id);
});

test('an adapter crash persists the error end-status so a restart shows 异常结束', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'sess-archive-'));
  const fake = controlledAdapter();
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process, archiveRoot: home });
  const started = await manager.start({ prompt: '首轮调度', project: 'owner-alpha/demo' });
  await waitFor(() => fake.prompts.length === 1);
  fake.process.kill();
  await waitFor(() => manager.list()[0].status === 'error');
  const { SessionArchive } = await import('../src/session-archive.mjs');
  const record = await new SessionArchive(home).read(started.id);
  assert.equal(record.endStatus, 'error', 'the crash must reach the archive, not stay active');
  await manager.close(started.id);
});

// ---- #96：ACP 时代旧存档分类回归（假 Hub 复刻 #92/#94 的真实响应形状）----
const HUB_CONFIG = { hubUrl: 'http://127.0.0.1:9', ownerKey: 'owner-key', sourceKey: 'source-key' };

function legacyHubClient(overrides = {}) {
  const calls = [];
  let nextEventId = overrides.firstEventId ?? 7184;
  return {
    calls,
    async postEvent(config, event) {
      calls.push(['postEvent', event]);
      if (overrides.postError) throw overrides.postError;
      return { event: nextEventId++, duplicate: false, routed: true, paused: false };
    },
    async readEvent(config, eventId) {
      calls.push(['readEvent', eventId]);
      if (overrides.readError) throw overrides.readError;
      return { event: eventId, routed: true, paused: false, runs: overrides.runs ?? [{ run: 6586, state: 'running' }] };
    },
    async cancelRun(config, runId) { calls.push(['cancelRun', runId]); return { ok: true }; },
  };
}

function legacyHubManager(home, client) {
  return new SchedulingSessionManager({
    cwd: '/x', adapterPath: '/a.js',
    spawnFn: () => { throw new Error('scheduling sessions must never spawn a private ACP'); },
    hubScheduling: new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client }),
    archiveRoot: home,
  });
}

// 直接落 ACP 时代 scheduling 存档：agent 为 Codex ACP、没有 .hub.json 旁车。
function writeLegacyAcpArchive(home, id, project, { agent = 'Codex ACP' } = {}) {
  const dir = path.join(home, 'console-sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, kind: 'scheduling', project, agent,
    prompt: 'ACP 时代调度',
    messages: [{ role: 'user', text: '旧存档', at: '2026-11-16T01:00:00Z' }],
    createdAt: '2026-11-16T01:00:00Z', updatedAt: '2026-11-17T01:00:00Z', closedAt: null, endStatus: 'interrupted',
  }));
}

function writeHubShapeArchive(home, id, project, hub) {
  const dir = path.join(home, 'console-sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, kind: 'scheduling', project, agent: HUB_SCHEDULING_AGENT_LABEL,
    prompt: 'Hub 接线后的调度',
    messages: [{ role: 'user', text: 'Hub 形态', at: '2026-11-18T06:00:00Z' }],
    createdAt: '2026-11-18T06:00:00Z', updatedAt: '2026-11-18T06:05:00Z', closedAt: null, endStatus: 'interrupted',
  }));
  writeFileSync(path.join(dir, `${id}.hub.json`), JSON.stringify(hub));
}

test('#96 ACP-era archives stay historical, never get a hub sidecar, and never block a new scheduling session', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'legacy-archive-'));
  const project = 'owner/legacy';
  const oldIds = ['b0882d18-0000-0000-0000-000000000001', '59b6a1cf-0000-0000-0000-000000000002', '17c34d27-0000-0000-0000-000000000003'];
  for (const id of oldIds) writeLegacyAcpArchive(home, id, project);

  const client = legacyHubClient();
  const manager = legacyHubManager(home, client);
  await manager.restoreFromHub();
  assert.equal(manager.list().length, 0, 'ACP-era archives must not surface as active/待复核 sessions');
  assert.equal(client.calls.length, 0, 'no numeric event id means no speculative Hub read');
  const sidecars = readdirSync(path.join(home, 'console-sessions')).filter(name => name.endsWith('.hub.json'));
  assert.equal(sidecars.length, 0, 'recovery must not fabricate Hub sidecars for ACP-era archives');
  const archived = await manager.listArchived();
  assert.deepEqual(archived.map(item => item.id).sort(), [...oldIds].sort(), 'legacy archives remain visible in the history area');

  const created = await manager.start({ project, prompt: '新建调度会话' });
  assert.equal(created.project, project, 'a new scheduling session must be creatable for the same project');
  assert.equal(manager.list().length, 1, 'only the brand-new session is active');

  const revived = legacyHubManager(home, legacyHubClient());
  await revived.restoreFromHub();
  assert.equal(revived.list().length, 1, 'after restart only the hub-shape session is active');
  assert.equal(revived.list()[0].id, created.id, 'the restarted view is the real Hub session, not a legacy archive');
});

test('#96 forged sidecar with a non-numeric lastEventId is treated as a legacy archive', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'legacy-forged-'));
  const id = 'f60295a6-0000-0000-0000-000000000001';
  const dir = path.join(home, 'console-sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, kind: 'scheduling', project: 'owner/legacy', agent: HUB_SCHEDULING_AGENT_LABEL,
    prompt: '被误判的旧会话', messages: [],
    createdAt: '2026-11-17T01:00:00Z', updatedAt: '2026-11-17T01:05:00Z', closedAt: null, endStatus: 'interrupted',
  }));
  writeFileSync(path.join(dir, `${id}.hub.json`), JSON.stringify({
    sessionId: id, subject: `scheduling:${id}`, turn: 1, lastEventId: null, runId: null,
  }));

  const client = legacyHubClient();
  const manager = legacyHubManager(home, client);
  await manager.restoreFromHub();
  assert.equal(manager.list().length, 0, 'a null lastEventId must not be mistaken for a Hub shape');
  assert.equal(client.calls.length, 0, 'a legacy archive must not trigger a Hub read');
  assert.equal((await manager.listArchived()).length, 1, 'it stays visible in history');
  const created = await manager.start({ project: 'owner/legacy', prompt: '新建' });
  assert.equal(created.project, 'owner/legacy');
});

test('#96 hub-shape archives still reconcile through GET runs[0] (no #94 regression)', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hub-shape-'));
  const id = 'aaaaaaaa-0000-0000-0000-000000000001';
  writeHubShapeArchive(home, id, 'owner/demo', { sessionId: id, subject: `scheduling:${id}`, turn: 2, lastEventId: 7191, runId: null });
  const client = legacyHubClient({ firstEventId: 7191, runs: [{ run: 6592, state: 'running' }] });
  const manager = legacyHubManager(home, client);
  await manager.restoreFromHub();
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0].status, 'running', 'a legal sidecar is reconciled as before');
  assert.equal(manager.list()[0].hubRunId, 6592);
  assert.deepEqual(client.calls.filter(call => call[0] === 'readEvent').map(call => call[1]), [7191]);
});

test('#96 recovery never fabricates a hub sidecar when lastEventId is missing', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'lost-sidecar-'));
  const id = 'cccccccc-0000-0000-0000-000000000001';
  writeHubShapeArchive(home, id, 'owner/demo', { sessionId: id, subject: `scheduling:${id}`, turn: 2, lastEventId: 7191, runId: null });
  const sidecar = path.join(home, 'console-sessions', `${id}.hub.json`);
  const { unlinkSync } = await import('node:fs');
  unlinkSync(sidecar); // 模拟 Hub 形态会话的旁车丢失，recovery 不得凭空补写
  const client = legacyHubClient();
  const manager = legacyHubManager(home, client);
  await manager.restoreFromHub();
  assert.equal(manager.list().length, 0, 'a lost sidecar is no sidecar: the archive is historical');
  assert.ok(!existsSync(sidecar), 'a missing lastEventId must never be fabricated into a hub sidecar');
  assert.equal((await manager.listArchived()).length, 1, 'it stays visible in history');
  assert.equal(client.calls.length, 0);
});

// ---- #100：Hub 会话状态周期刷新与 claimed 映射（会话 b3be7ce2 / 事件 7267 / run 6663）----
// 假 Hub 像真实中台一样按 claimed → done 推进 state，验证视图随轮询自动跟上。
function sequenceHubClient(states, { failNext = false } = {}) {
  const calls = [];
  let index = 0;
  let flaky = failNext;
  return {
    calls,
    setStates(next) { states = next; index = 0; },
    failOnce() { flaky = true; },
    async postEvent(config, event) {
      calls.push(['postEvent', event]);
      return { event: 7267, duplicate: false, routed: true, paused: false };
    },
    async readEvent(config, eventId) {
      calls.push(['readEvent', eventId]);
      if (flaky) { flaky = false; throw new Error('Hub 暂时不可用'); }
      const state = states[Math.min(index, states.length - 1)];
      index += 1;
      return { event: eventId, routed: true, paused: false, runs: [{ run: 6663, state }] };
    },
    async cancelRun(config, runId) { calls.push(['cancelRun', runId]); return { ok: true }; },
  };
}

function refreshingManager(client, { reconcileMs = 20 } = {}) {
  return new SchedulingSessionManager({
    cwd: '/x', adapterPath: '/a.js',
    spawnFn: () => { throw new Error('Hub scheduling sessions must not spawn a private ACP'); },
    hubScheduling: new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client }),
    hubReconcileMs: reconcileMs,
  });
}

test('#100 claimed maps to running and periodic reconciliation catches done without losing the final state', async () => {
  const client = sequenceHubClient(['claimed', 'done']);
  const manager = refreshingManager(client);
  const session = await manager.start({ project: 'owner/demo', prompt: '周期刷新验证' });
  assert.equal(session.status, 'running', '中台真实 state=claimed 必须映射为运行中，而不是待复核');
  assert.equal(manager.list()[0].status, 'running');

  // 中台转 done 后，下一次前端轮询触发节流对账，视图自动跟上 idle。
  await waitFor(() => manager.list()[0].status === 'idle', 1000);
  assert.equal(manager.list()[0].status, 'idle');

  // 终态不被后续对账翻回：Hub 抖动/失败都不得把已完成的视图刷成待复核。
  const readsBefore = client.calls.filter(call => call[0] === 'readEvent').length;
  client.setStates(['claimed']);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(client.calls.filter(call => call[0] === 'readEvent').length, readsBefore, 'terminal session must stop being polled so its final state is kept');
  assert.equal(manager.list()[0].status, 'idle', 'final state must never be lost by later reconciliation');
  await manager.close(session.id);
});

test('#100 a failed reconciliation degrades only that session to unknown with a readable reason, and can recover', async () => {
  const client = sequenceHubClient(['claimed']);
  const manager = refreshingManager(client);
  const session = await manager.start({ project: 'owner/demo', prompt: '降级验证' });
  assert.equal(session.status, 'running');

  client.failOnce();
  await waitFor(() => {
    const listed = manager.list()[0];
    return listed.status === 'unknown' && /Hub 状态待复核/.test(listed.error || '');
  }, 1000);
  assert.equal(manager.list()[0].status, 'unknown');
  assert.match(manager.list()[0].error, /Hub 状态待复核/);
  assert.equal(manager.list().length, 1, 'a failed reconciliation must not drop the session from the list');

  // 后续对账成功即恢复，且最终态仍能跟上。
  client.setStates(['done']);
  await waitFor(() => manager.list()[0].status === 'idle', 1000);
  assert.equal(manager.list()[0].error, null, 'a successful reconciliation clears the transient reason');
  await manager.close(session.id);
});

test('#100 reconciliation is throttled to at least the configured interval', async () => {
  const client = sequenceHubClient(['claimed']);
  const manager = refreshingManager(client, { reconcileMs: 5000 });
  await manager.start({ project: 'owner/demo', prompt: '节流验证' });
  const reads = () => client.calls.filter(call => call[0] === 'readEvent').length;
  assert.equal(reads(), 1, 'start already reconciles once');
  for (let i = 0; i < 10; i += 1) manager.list();
  assert.equal(reads(), 1, 'rapid list() polls inside the throttle window must not re-read Hub');
  await manager.close(manager.list()[0].id);
});

// ---- #102：close 终态持久化（会话 b3be7ce2 close 后重启复活并堵查重）----
function readSidecar(home, id) {
  return JSON.parse(readFileSync(path.join(home, 'console-sessions', `${id}.hub.json`), 'utf8'));
}

test('#102 close persists a terminal marker into the existing sidecar and a restart does not resurrect or block a new session', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'close-persist-'));
  const project = 'owner/close';
  const manager = legacyHubManager(home, legacyHubClient({ runs: [{ run: 6663, state: 'claimed' }] }));
  const session = await manager.start({ project, prompt: 'close 持久化验证' });
  const id = session.id;
  const sidecar = path.join(home, 'console-sessions', `${id}.hub.json`);
  assert.ok(existsSync(sidecar), 'the active Hub session must have a sidecar');
  assert.equal(readSidecar(home, id).closed, undefined, 'an active session must not carry a closed marker');
  const credentials = readSidecar(home, id);

  await manager.close(id);
  assert.equal(manager.list().length, 0, 'close removes the session from the active list');
  const closed = readSidecar(home, id);
  assert.equal(closed.closed, true, 'close must persist the terminal state into the existing sidecar');
  assert.equal(closed.lastEventId, credentials.lastEventId, 'closing must keep the reconcile credentials in the sidecar');
  assert.equal(closed.sessionId, credentials.sessionId);
  assert.equal(closed.subject, credentials.subject);
  assert.equal(closed.turn, credentials.turn);
  assert.equal(readdirSync(path.join(home, 'console-sessions')).filter(name => name.endsWith('.hub.json')).length, 1, 'no extra state file may be introduced');

  // 模拟重启：新实例 restore，用一个会记录调用的假 Hub 证明已关会话不再读状态。
  const revivedClient = legacyHubClient();
  const revived = legacyHubManager(home, revivedClient);
  await revived.restoreFromHub();
  assert.equal(revived.list().length, 0, 'a closed session must not resurrect into the active list');
  assert.equal(revivedClient.calls.filter(call => call[0] === 'readEvent').length, 0, 'a terminal session must not be reconciled on restart');
  const archived = await revived.listArchived();
  assert.ok(archived.some(item => item.id === id), 'the closed session must stay visible in the history area');
  assert.equal(archived.find(item => item.id === id).endStatus, 'closed', 'history must show it as closed');

  const created = await revived.start({ project, prompt: '新建同项目会话' });
  assert.equal(created.project, project, 'a closed session must not block a new session for the same project');
  assert.equal(revived.list().length, 1, 'only the brand-new session is active');
});

test('#102 a legacy sidecar without a closed field stays open (backward compatible) and still occupies the project slot', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'close-legacy-'));
  const project = 'owner/legacy-open';
  const id = 'c1030000-0000-0000-0000-000000000001';
  // 旧旁车形状：有合法数字 lastEventId，但没有 closed 字段。
  writeHubShapeArchive(home, id, project, { sessionId: id, subject: `scheduling:${id}`, turn: 2, lastEventId: 7191, runId: null });
  const client = legacyHubClient({ firstEventId: 7191, runs: [{ run: 6592, state: 'running' }] });
  const manager = legacyHubManager(home, client);
  await manager.restoreFromHub();
  assert.equal(manager.list().length, 1, 'an old sidecar without closed must still restore as active');
  assert.equal(manager.list()[0].id, id);
  await assert.rejects(() => manager.start({ project, prompt: '重复项目' }), /已有进行中的调度会话/, 'an old open session must still occupy the dedup slot');
  await manager.close(id);
});

test('#102 a failed terminal write is diagnosable and keeps the in-memory state consistent', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'close-write-fail-'));
  const manager = legacyHubManager(home, legacyHubClient());
  const session = await manager.start({ project: 'owner/fail', prompt: '终态写失败验证' });
  const sidecar = path.join(home, 'console-sessions', `${session.id}.hub.json`);
  unlinkSync(sidecar);
  mkdirSync(sidecar); // 目标变成目录：renameSync 无法覆盖，终态写入抛错
  const statusBefore = manager.list()[0].status;
  await assert.rejects(() => manager.close(session.id), error => error.status === 500 && /终态写入失败|关闭调度会话失败/.test(error.message), 'a terminal write failure must surface a readable diagnosable error');
  assert.equal(manager.list().length, 1, 'the session must remain in memory when its terminal state could not be persisted');
  assert.equal(manager.list()[0].status, statusBefore, 'in-memory status must stay consistent with the unpersisted state');
  assert.equal(readdirSync(path.join(home, 'console-sessions')).filter(name => name.endsWith('.hub.json')).length, 1);
  rmSync(sidecar, { recursive: true });
  await manager.close(session.id); // 恢复可写后能正常关闭
  assert.equal(manager.list().length, 0);
});

test('#102 a closed Hub session can still be continued from the history area', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'close-continue-'));
  const project = 'owner/continue';
  const manager = legacyHubManager(home, legacyHubClient());
  const session = await manager.start({ project, prompt: '续跑验证' });
  await manager.close(session.id);

  const revived = legacyHubManager(home, legacyHubClient());
  await revived.restoreFromHub();
  assert.equal(revived.list().length, 0, 'the closed session must stay out of the active list');
  const continued = await revived.continueSession(session.id);
  assert.equal(continued.continuedFrom, session.id, 'continue from history must still work with a terminal sidecar');
  assert.notEqual(continued.id, session.id);
  assert.equal(continued.project, project);
  await revived.close(continued.id);
});

test('attachments are saved and included in the next agent prompt', async () => {
  const fake = fakeAdapter();
  const archiveRoot = mkdtempSync(path.join(tmpdir(), 'session-attachments-manager-'));
  const manager = new SchedulingSessionManager({ hubScheduling: false, archiveRoot, adapterPath: '/fixed/codex-acp.js', spawnFn: () => fake.process });
  try {
    const started = await manager.start({ project: '/workspace/demo' });
    await waitFor(() => manager.list()[0]?.status === 'idle');
    await manager.send(started.id, '请分析附件', { attachments: [{ name: '说明.md', type: 'text/markdown', dataBase64: Buffer.from('附件正文').toString('base64') }, { name: '截图.png', type: 'image/png', dataBase64: Buffer.from([1, 2]).toString('base64') }] });
    await waitFor(() => fake.requests.filter(request => request.method === 'session/prompt').length >= 2);
    const text = fake.requests.filter(request => request.method === 'session/prompt').at(-1).params.prompt[0].text;
    assert.match(text, /请分析附件/);
    assert.match(text, /附件正文/);
    assert.match(text, /截图\.png/);
    assert.match(text, /session-attachments/);
    await manager.close(started.id);
  } finally {
    rmSync(archiveRoot, { recursive: true, force: true });
  }
});
