// session-steer：App「打断」按钮 = 打断当前轮并立即把输入框文字作为新一轮发出。
// 服务端 send(id, text, { interrupt: true }) 过去有意忽略 text（网页版纯停止），
// 本文件先 RED 复现「带文本被丢弃」，再覆盖 ACP / Hub 两条路径与纯停止不回退。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SchedulingSessionManager } from '../src/scheduling-session.mjs';
import { HubSchedulingSessionAdapter } from '../src/hub-scheduling-session.mjs';

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

async function waitFor(predicate, timeout = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error('等待假适配器响应超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// 受控 ACP：cancel 会拒绝当前 prompt（真实适配器取消中状态），新轮由测试释放。
function makeAcp({ rejectOnCancel = false } = {}) {
  const requests = [];
  const prompts = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
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
      if (request.method === 'initialize') {
        respond(request, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { prompt: true } }, agentInfo: { name: 'steer-acp', version: '0' } });
      } else if (request.method === 'session/new') respond(request, { sessionId: 'steer-session' });
      else if (request.method === 'session/set_mode') respond(request, {});
      else if (request.method === 'session/set_config_option') respond(request, { configOptions: [{ id: request.params.configId, currentValue: request.params.value }] });
      else if (request.method === 'session/prompt') prompts.push(request);
      else if (request.method === 'session/cancel') {
        respond(request, {});
        if (rejectOnCancel && prompts.length) {
          const pending = prompts[prompts.length - 1];
          stdout.write(jsonLine({ jsonrpc: '2.0', id: pending.id, error: { code: -32800, message: 'request cancelled' } }));
        }
      } else if (request.method === 'session/close') respond(request, {});
    }
  });
  const endTurn = (request, text = '本轮回复') => {
    stdout.write(jsonLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'steer-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }));
    respond(request, { stopReason: 'end_turn' });
  };
  return { process: proc, requests, prompts, endTurn };
}

function acpManager(fake, extra = {}) {
  return new SchedulingSessionManager({
    hubScheduling: false, cwd: '/x', adapterPath: '/a.js', spawnFn: () => fake.process, settleMs: 20, ...extra,
  });
}

const HUB_CONFIG = { hubUrl: 'http://127.0.0.1:9', ownerKey: 'owner-key', sourceKey: 'source-key' };

function makeHubClient(overrides = {}) {
  const calls = [];
  let nextEventId = 7184;
  let postCount = 0;
  const postEvent = async (config, event) => {
    postCount += 1;
    calls.push(['postEvent', event]);
    if (overrides.failPostAt === postCount) throw new Error('网络中断');
    return { event: nextEventId++, duplicate: false, routed: true, paused: false };
  };
  return {
    calls,
    postEvent,
    async readEvent(config, eventId) {
      calls.push(['readEvent', eventId]);
      return { event: eventId, routed: true, paused: false, runs: [{ run: 6586, rule: '调度会话执行', state: 'running' }] };
    },
    async cancelRun(config, runId) {
      calls.push(['cancelRun', runId]);
      if (overrides.cancelError) throw overrides.cancelError;
      return { ok: true };
    },
    async readState() {
      calls.push(['readState']);
      return { rules: [], runs: [], cards: [] };
    },
  };
}

function hubManager(client) {
  return new SchedulingSessionManager({
    cwd: '/x', adapterPath: '/a.js',
    spawnFn: () => { throw new Error('Hub 会话不得派生本地 ACP'); },
    hubScheduling: new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client }),
    archiveRoot: mkdtempSync(path.join(tmpdir(), 'steer-hub-')),
  });
}

// ---------- ACP 路径 ----------

test('ACP 打断带文本：cancel 当前轮后以该文本开新轮（复用 #runTurn），旧轮按 interrupted 收尾', async () => {
  const fake = makeAcp({ rejectOnCancel: true });
  const manager = acpManager(fake);
  const started = await manager.start({ prompt: '首轮调度', project: 'owner/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;

  await manager.send(id, '打断后立刻发这条', { interrupt: true });
  assert.ok(fake.requests.some(request => request.method === 'session/cancel'), '打断必须调用 session/cancel');

  // 新轮在旧轮 interrupted 结算 + settle 窗口之后启动，文本一字不差进入新轮 prompt。
  await waitFor(() => fake.prompts.length === 2);
  assert.match(fake.prompts[1].params.prompt[0].text, /打断后立刻发这条/);
  assert.equal(manager.list()[0].stopReason, 'interrupted', '被取消的旧轮必须以 interrupted 收尾');
  const userTexts = manager.list()[0].messages.filter(message => message.role === 'user').map(message => message.text);
  assert.ok(userTexts.some(text => /打断后立刻发这条/.test(text)), '打断文本必须进入转录，不能凭空丢失');

  fake.endTurn(fake.prompts[1]);
  await waitFor(() => manager.list()[0].status === 'idle');
  await manager.close(id);
});

test('ACP 打断带文本按队列/settle 纪律：插到已排队消息之前，且旧队列不丢', async () => {
  const fake = makeAcp({ rejectOnCancel: true });
  const manager = acpManager(fake);
  const started = await manager.start({ prompt: '首轮调度', project: 'owner/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;

  await manager.send(id, '更早排队的消息');
  const afterInterrupt = await manager.send(id, '打断插入最前', { interrupt: true });
  assert.equal(afterInterrupt.queuedCount, 2, '打断文本与既有排队消息都还在，未被丢弃');

  await waitFor(() => fake.prompts.length === 2);
  assert.match(fake.prompts[1].params.prompt[0].text, /打断插入最前/, '刚打断输入的文字应排到队首，先于更早的排队消息');
  fake.endTurn(fake.prompts[1]);
  await waitFor(() => fake.prompts.length === 3);
  assert.match(fake.prompts[2].params.prompt[0].text, /更早排队的消息/, '既有排队消息仍按序送达');
  fake.endTurn(fake.prompts[2]);
  await waitFor(() => manager.list()[0].status === 'idle' && manager.list()[0].queuedCount === 0);
  await manager.close(id);
});

test('ACP 纯停止（空文本）路径不变：只 cancel，不开新轮、不进队列', async () => {
  const fake = makeAcp({ rejectOnCancel: true });
  const manager = acpManager(fake);
  const started = await manager.start({ prompt: '首轮调度', project: 'owner/demo' });
  await waitFor(() => fake.prompts.length === 1);
  const id = started.id;

  const stopped = await manager.send(id, '', { interrupt: true });
  assert.ok(fake.requests.some(request => request.method === 'session/cancel'));
  assert.equal(stopped.queuedCount, 0, '纯停止不得把空文本当成排队消息');
  await waitFor(() => manager.list()[0].status === 'idle');
  assert.equal(fake.prompts.length, 1, '空文本打断不得开新轮（网页版纯停止语义不回退）');
  assert.equal(manager.list()[0].messages.filter(message => message.role === 'user').length, 1, '不得记录空的用户消息');
  await manager.close(id);
});

// ---------- Hub 路径 ----------

test('Hub 打断带文本：cancelRun 后把该文本 postTurn 为 turn+1，文本进转录', async () => {
  const client = makeHubClient();
  const manager = hubManager(client);
  const started = await manager.start({ project: 'owner/demo', prompt: '首轮' });

  const result = await manager.send(started.id, '打断后立刻发这条', { interrupt: true });

  assert.ok(client.calls.some(call => call[0] === 'cancelRun'), '打断必须先取消正在运行的 Hub run');
  const posted = client.calls.filter(call => call[0] === 'postEvent').map(call => call[1]);
  assert.equal(posted.length, 2, '带文本打断必须恰好发出一条新 turn 事件（纯停止才不发）');
  const next = posted.at(-1);
  const sessionId = started.id;
  assert.equal(next.id, `console:${sessionId}:turn:2`, '新事件轮次必须是 turn+1');
  assert.match(JSON.parse(next.detail).text, /打断后立刻发这条/);
  assert.ok(result.messages.some(message => message.role === 'user' && /打断后立刻发这条/.test(message.text)), '文本必须进入转录');
});

test('Hub 打断带文本：cancel 失败维持运行中并报错，不 post 新轮', async () => {
  const client = makeHubClient({ cancelError: new Error('cancel boom') });
  const manager = hubManager(client);
  const started = await manager.start({ project: 'owner/demo', prompt: '首轮' });
  const postedBefore = client.calls.filter(call => call[0] === 'postEvent').length;

  await assert.rejects(
    () => manager.send(started.id, '别丢了我', { interrupt: true }),
    error => /打断.*失败/.test(error.message),
    'cancel 失败必须报错提示，不能假装打断成功',
  );
  assert.equal(client.calls.filter(call => call[0] === 'postEvent').length, postedBefore, 'cancel 失败不得发出新轮事件');
});

test('Hub 打断带文本：新轮 post 失败不推进轮次，文本可用同一轮次重试', async () => {
  const client = makeHubClient({ failPostAt: 2 });
  const manager = hubManager(client);
  const started = await manager.start({ project: 'owner/demo', prompt: '首轮' });

  await assert.rejects(
    () => manager.send(started.id, '别丢了我', { interrupt: true }),
    error => /发送失败.*已保留/.test(error.message),
    '新轮启动失败必须提示用户内容已保留可重试',
  );

  // 重试：轮次未前进，下一次发送仍落在 turn:2，不跳号、不丢消息。
  client.postEvent = async (config, event) => {
    client.calls.push(['postEvent', event]);
    return { event: 7190, duplicate: false, routed: true, paused: false };
  };
  await manager.send(started.id, '重试文本', { interrupt: false });
  const posted = client.calls.filter(call => call[0] === 'postEvent').map(call => call[1]);
  assert.equal(posted.at(-1).id, `console:${started.id}:turn:2`, '失败后重试必须仍用 turn 2');
});

test('Hub 纯停止（空文本）路径不变：只 cancelRun，不 post 新轮', async () => {
  const client = makeHubClient();
  const manager = hubManager(client);
  const started = await manager.start({ project: 'owner/demo', prompt: '首轮' });

  await manager.send(started.id, '', { interrupt: true });

  assert.ok(client.calls.some(call => call[0] === 'cancelRun'), '纯停止也应取消当前 run');
  assert.equal(client.calls.filter(call => call[0] === 'postEvent').length, 1, '空文本打断不得发新轮（网页版纯停止语义不回退）');
});
