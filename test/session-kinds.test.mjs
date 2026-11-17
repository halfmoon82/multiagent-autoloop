import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { SchedulingSessionManager } from '../src/scheduling-session.mjs';

const line = value => `${JSON.stringify(value)}\n`;
const realCwd = process.cwd();
function fakeAdapter({ failMode = false, driftMode = false, askPermission = false } = {}) {
  const requests = [];
  const responses = [];
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  let buffer = '';
  let planConfigCalls = 0;
  const process = { stdin, stdout, stderr, pid: 4242, kill() { stdout.end(); } };
  const respond = (request, result) => stdout.write(line({ jsonrpc: '2.0', id: request.id, result }));
  stdin.on('data', chunk => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!raw.trim()) continue;
      const request = JSON.parse(raw); requests.push(request);
      if (!request.method) { responses.push(request); continue; }
      if (request.method === 'initialize') respond(request, { agentInfo: { name: 'fake-codex' }, agentCapabilities: {} });
      else if (request.method === 'session/new') respond(request, { sessionId: 'fake-session' });
      else if (request.method === 'session/set_mode') {
        if (failMode) stdout.write(line({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'mode unavailable' } }));
        else respond(request, { configOptions: [{ id: 'mode', currentValue: request.params.modeId }] });
      } else if (request.method === 'session/set_config_option') {
        planConfigCalls += 1;
        if (driftMode && planConfigCalls > 1) stdout.write(line({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'collaboration_mode drifted back to default' } }));
        else respond(request, { configOptions: [{ id: request.params.configId, currentValue: request.params.value }] });
      } else if (request.method === 'session/prompt') {
        setTimeout(() => {
          stdout.write(line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } } } }));
          respond(request, { stopReason: 'end_turn' });
          if (askPermission) {
            stdout.write(line({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 'fake-session', toolCall: { toolCallId: 'call-1', kind: 'edit', status: 'pending', locations: [{ path: `${realCwd}/notes.md` }] }, options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }] } }));
          }
        }, 0);
      } else if (request.method === 'session/close' || request.method === 'session/cancel') respond(request, {});
    }
  });
  return { process, requests, responses };
}
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('等待 ACP 请求超时');
};

test('normal session uses the project workspace with the exact user prompt and no Hub MCP', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/demo', adapterPath: '/fixed/acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ kind: 'normal', project: '/workspace/demo', prompt: '分析账单 API，不要修改文件' });
  await waitFor(() => fake.requests.some(request => request.method === 'session/prompt'));
  assert.equal(started.kind, 'normal');
  assert.deepEqual(fake.requests.map(request => request.method), ['initialize', 'session/new', 'session/set_mode', 'session/prompt']);
  assert.equal(fake.requests[1].params.cwd, '/workspace/demo');
  assert.deepEqual(fake.requests[1].params.mcpServers, []);
  assert.equal(fake.requests[3].params.prompt[0].text, '分析账单 API，不要修改文件');
  assert.doesNotMatch(fake.requests[3].params.prompt[0].text, /调度会话|PRD 引导/);
});

test('design session enforces read-only and native Plan Mode before the first prompt', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/demo', adapterPath: '/fixed/acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ kind: 'design', project: '/workspace/demo', prompt: '设计多租户计费并拆解 DAG' });
  await waitFor(() => fake.requests.some(request => request.method === 'session/prompt'));
  assert.equal(started.kind, 'design');
  // 只截取到首个 prompt：每轮结束后的护栏复核会产生额外的 set_mode/set_config_option，不属于首轮顺序断言范围。
  const upToPrompt = [];
  for (const request of fake.requests) { upToPrompt.push(request.method); if (request.method === 'session/prompt') break; }
  assert.deepEqual(upToPrompt, ['initialize', 'session/new', 'session/set_mode', 'session/set_config_option', 'session/prompt']);
  assert.equal(fake.requests[2].params.modeId, 'read-only');
  assert.deepEqual(fake.requests[3].params, { sessionId: 'fake-session', configId: 'collaboration_mode', value: 'plan' });
  assert.deepEqual(fake.requests[1].params.mcpServers, []);
  assert.match(fake.requests[4].params.prompt[0].text, /PRD/);
  assert.match(fake.requests[4].params.prompt[0].text, /product-spec/);
  assert.doesNotMatch(fake.requests[4].params.prompt[0].text, /派发 worker/);
  await assert.rejects(() => manager.send(started.id, '/plan'), /设计会话不接受斜杠命令/);
});

test('design session fails closed when read-only mode cannot be set', async () => {
  const fake = fakeAdapter({ failMode: true });
  const manager = new SchedulingSessionManager({ cwd: '/workspace/demo', adapterPath: '/fixed/acp.js', spawnFn: () => fake.process });
  await assert.rejects(() => manager.start({ kind: 'design', project: '/workspace/demo', prompt: '设计新功能' }), /开启会话失败/);
  assert.equal(fake.requests.some(request => request.method === 'session/prompt'), false);
  assert.equal(manager.list().length, 0);
});

test('one active session per project and kind allows normal, scheduling and design to coexist', async () => {
  const fakes = [];
  const manager = new SchedulingSessionManager({ cwd: '/workspace/demo', adapterPath: '/fixed/acp.js', maxSessions: 3, spawnFn: () => { const fake = fakeAdapter(); fakes.push(fake); return fake.process; } });
  await manager.start({ kind: 'normal', project: '/workspace/demo', prompt: '普通问答' });
  await manager.start({ kind: 'scheduling', project: '/workspace/demo', prompt: '调度诊断' });
  await manager.start({ kind: 'design', project: '/workspace/demo', prompt: '设计新功能' });
  assert.deepEqual(manager.list().map(session => session.kind).sort(), ['design', 'normal', 'scheduling']);
  await assert.rejects(() => manager.start({ kind: 'normal', project: '/workspace/demo', prompt: '重复普通会话' }), /已有进行中的普通会话/);
});

test('design session queue edits cannot smuggle slash commands', async () => {
  const fake = fakeAdapter();
  const manager = new SchedulingSessionManager({ cwd: '/workspace/demo', adapterPath: '/fixed/acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ kind: 'design', project: '/workspace/demo', prompt: '设计新功能' });
  const queued = await manager.send(started.id, '先补充一点背景');
  assert.equal(queued.queued.length, 1, '运行中的设计会话应把消息排进队列');
  await assert.rejects(() => manager.updateQueued(started.id, queued.queued[0].id, '/plan 偷偷切换模式'), /设计会话不接受斜杠命令/);
});

test('design session cancels every permission request, even edits inside the writable dir', async () => {
  const fake = fakeAdapter({ askPermission: true });
  const manager = new SchedulingSessionManager({ cwd: '/workspace/demo', adapterPath: '/fixed/acp.js', writableDir: process.cwd(), spawnFn: () => fake.process });
  await manager.start({ kind: 'design', project: '/workspace/demo', prompt: '设计新功能' });
  await waitFor(() => fake.responses.some(response => response.id === 'perm-1'));
  const reply = fake.responses.find(response => response.id === 'perm-1');
  assert.equal(reply.result.outcome.outcome, 'cancelled', '设计会话的写审批必须全部取消，不能只依赖 ACP read-only');
});

test('design session re-verifies read-only + plan after each turn and errors on drift', async () => {
  const fake = fakeAdapter({ driftMode: true });
  const manager = new SchedulingSessionManager({ cwd: '/workspace/demo', adapterPath: '/fixed/acp.js', spawnFn: () => fake.process });
  const started = await manager.start({ kind: 'design', project: '/workspace/demo', prompt: '设计新功能' });
  await waitFor(() => { const item = manager.list().find(entry => entry.id === started.id); return item && item.status === 'error'; });
  const session = manager.list().find(entry => entry.id === started.id);
  assert.match(session.error, /模式漂移/, '每轮结束后复核 read-only + plan，漂移必须置 error');
});
