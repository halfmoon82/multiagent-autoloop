import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HubSchedulingSessionAdapter,
  HubSchedulingError,
  HUB_SCHEDULING_AGENT_LABEL,
  schedulingSubject,
  schedulingEventId,
  buildSchedulingEvent,
  mapHubStateToStatus,
  matterTurn,
} from '../src/hub-scheduling-session.mjs';
import { SchedulingSessionManager } from '../src/scheduling-session.mjs';
import { postSchedulingEvent, readSchedulingEvent } from '../src/hub.mjs';

const HUB_CONFIG = { hubUrl: 'http://127.0.0.1:9', ownerKey: 'owner-key', sourceKey: 'source-key' };

function fakeHubClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    async postEvent(config, event) {
      calls.push(['postEvent', event]);
      if (overrides.postError) throw overrides.postError;
      return { id: event.id, subject: event.subject, runId: overrides.runId || `run-${event.subject}`, state: overrides.state || 'running' };
    },
    async readEvent(config, eventId) {
      calls.push(['readEvent', eventId]);
      if (overrides.readError) throw overrides.readError;
      return { id: eventId, runId: overrides.runId || 'run-1', state: overrides.state || 'completed' };
    },
    async listMatters(config) {
      calls.push(['listMatters']);
      if (overrides.listError) throw overrides.listError;
      return overrides.matters || [];
    },
    async cancelRun(config, runId) {
      calls.push(['cancelRun', runId]);
      if (overrides.cancelError) throw overrides.cancelError;
      return { ok: true };
    },
  };
}

function flagSpawn(label = 'spawn') {
  const state = { count: 0 };
  state.fn = () => { state.count += 1; throw new Error(`${label} must not happen`); };
  return state;
}

test('§6.2 subject and event id contract', () => {
  assert.equal(schedulingSubject('abc-123'), 'scheduling:abc-123');
  assert.equal(schedulingEventId('abc-123', 1), 'console:abc-123:turn:1');
  assert.equal(schedulingEventId('abc-123', 7), 'console:abc-123:turn:7');
  const event = buildSchedulingEvent({ sessionId: 'abc-123', turn: 1, project: 'owner/demo', text: '开始' });
  assert.equal(event.id, 'console:abc-123:turn:1');
  assert.equal(event.subject, 'scheduling:abc-123');
  assert.equal(event.type, 'scheduling.message');
  assert.equal(event.resume, true);
  assert.equal(event.project, 'owner/demo');
  assert.equal(event.text, '开始');
});

test('hub.mjs write/read adapters call POST /v1/events and read by event id', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push([String(url), opts]);
    return { ok: true, status: 200, text: async () => JSON.stringify({ runId: 'r1', state: 'queued' }) };
  };
  try {
    const result = await postSchedulingEvent(HUB_CONFIG, { id: 'e1', subject: 'scheduling:s', type: 'scheduling.message', resume: true, text: 'x' });
    assert.equal(result.runId, 'r1');
    assert.match(seen[0][0], /\/v1\/events$/);
    assert.equal(seen[0][1].method, 'POST');
    assert.equal(JSON.parse(seen[0][1].body).id, 'e1');
    await readSchedulingEvent(HUB_CONFIG, 'e1');
    assert.match(seen[1][0], /\/v1\/events\/e1$/);
  } finally {
    globalThis.fetch = original;
  }
});

test('adapter posts every turn to the same matter with resume and monotonically increasing ids', async () => {
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  await adapter.postTurn({ sessionId: 's-1', turn: 1, project: 'owner/demo', text: '第一轮' });
  await adapter.postTurn({ sessionId: 's-1', turn: 2, project: 'owner/demo', text: '第二轮' });
  const posted = client.calls.filter(call => call[0] === 'postEvent').map(call => call[1]);
  assert.equal(posted.length, 2);
  assert.equal(posted[0].subject, 'scheduling:s-1');
  assert.equal(posted[1].subject, 'scheduling:s-1');
  assert.equal(posted[0].id, 'console:s-1:turn:1');
  assert.equal(posted[1].id, 'console:s-1:turn:2');
  assert.equal(posted[0].resume, true);
  assert.equal(posted[1].resume, true);
});

test('duplicate event ids do not produce a second execution', async () => {
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  await adapter.postTurn({ sessionId: 's-1', turn: 1, project: 'owner/demo', text: '第一轮' });
  await adapter.postTurn({ sessionId: 's-1', turn: 1, project: 'owner/demo', text: '重复的同一轮' });
  const posted = client.calls.filter(call => call[0] === 'postEvent');
  assert.equal(posted.length, 1, 'the same event id must be posted to the Hub only once');
});

test('Hub run state maps to console session status', () => {
  assert.equal(mapHubStateToStatus('running'), 'running');
  assert.equal(mapHubStateToStatus('queued'), 'running');
  assert.equal(mapHubStateToStatus('completed'), 'idle');
  assert.equal(mapHubStateToStatus('failed'), 'error');
  assert.equal(mapHubStateToStatus(undefined), 'idle');
});

test('scheduling start uses the Hub adapter and never spawns a private ACP process', async () => {
  const spawned = flagSpawn();
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({
    cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: spawned.fn, hubScheduling: adapter,
  });
  const started = await manager.start({ project: 'owner/demo', prompt: '首轮调度' });
  assert.equal(spawned.count, 0);
  assert.equal(started.agent, HUB_SCHEDULING_AGENT_LABEL);
  assert.match(started.hubSubject, /^scheduling:/);
  assert.equal(started.status, 'running');
  assert.equal(manager.list().length, 1);
  const posted = client.calls.filter(call => call[0] === 'postEvent');
  assert.equal(posted.length, 1);
  assert.match(posted[0][1].text, /首轮调度/);
});

test('subsequent messages join the same Hub matter with a new turn', async () => {
  const spawned = flagSpawn();
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: spawned.fn, hubScheduling: adapter });
  const started = await manager.start({ project: 'owner/demo', prompt: '首轮' });
  await manager.send(started.id, '第二轮重点看卡片');
  const posted = client.calls.filter(call => call[0] === 'postEvent').map(call => call[1]);
  assert.equal(posted.length, 2);
  assert.equal(posted[0].subject, posted[1].subject);
  assert.equal(posted[1].id, schedulingEventId(posted[1].subject.slice('scheduling:'.length), 2));
  assert.match(posted[1].text, /第二轮/);
  assert.equal(spawned.count, 0);
});

test('Hub unavailable preserves input and never falls back to ACP', async () => {
  const spawned = flagSpawn();
  const client = fakeHubClient({ postError: new Error('ECONNREFUSED') });
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: spawned.fn, hubScheduling: adapter });
  await assert.rejects(
    manager.start({ project: 'owner/demo', prompt: '检查当前调度' }),
    error => { assert.match(error.message, /中台|未接线|保留/); return true; },
  );
  assert.equal(spawned.count, 0);
  assert.equal(manager.list().length, 0, 'failed start must not register a phantom session');
});

test('unwired rule (Hub 404) returns a readable error, not an ACP fallback', async () => {
  const spawned = flagSpawn();
  const client = fakeHubClient({ postError: Object.assign(new Error('没有匹配的调度规则'), { status: 404 }) });
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: spawned.fn, hubScheduling: adapter });
  await assert.rejects(
    manager.start({ project: 'owner/demo', prompt: '检查' }),
    error => { assert.match(error.message, /规则|未接线|保留/); return true; },
  );
  assert.equal(spawned.count, 0);
});

test('interrupt maps to canceling the active Hub run without posting a new event', async () => {
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: flagSpawn().fn, hubScheduling: adapter });
  const started = await manager.start({ project: 'owner/demo', prompt: '首轮' });
  const before = client.calls.filter(call => call[0] === 'postEvent').length;
  await manager.send(started.id, '', { interrupt: true });
  assert.equal(client.calls.filter(call => call[0] === 'postEvent').length, before);
  assert.ok(client.calls.some(call => call[0] === 'cancelRun'), 'interrupt must cancel the active Hub run');
});

test('close stops new events and does not kill any local ACP process', async () => {
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: flagSpawn().fn, hubScheduling: adapter });
  const started = await manager.start({ project: 'owner/demo', prompt: '首轮' });
  const closed = await manager.close(started.id);
  assert.equal(closed.status, 'closed');
  assert.equal(manager.list().length, 0);
  const before = client.calls.filter(call => call[0] === 'postEvent').length;
  await assert.rejects(manager.send(started.id, '还会继续吗'), /不存在|关闭/);
  assert.equal(client.calls.filter(call => call[0] === 'postEvent').length, before);
  assert.ok(!client.calls.some(call => call[0] === 'cancelRun'), 'closing the console view does not kill the Hub run');
});

test('restart recovery rebuilds Hub scheduling views without spawning ACP', async () => {
  const matters = [{
    subject: 'scheduling:survived', sessionId: 'survived', project: 'owner/demo',
    state: 'running', text: '控制台重启前的调度', startedAt: '2026-11-17T10:00:00Z',
  }];
  const client = fakeHubClient({ matters });
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: flagSpawn().fn, hubScheduling: adapter });
  await manager.restoreFromHub();
  const views = manager.list();
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'running');
  assert.equal(views[0].project, 'owner/demo');
  assert.equal(views[0].agent, HUB_SCHEDULING_AGENT_LABEL);
  assert.equal(views[0].hubSubject, 'scheduling:survived');
});

test('normal and design sessions keep the existing ACP spawn path', async () => {
  const { PassThrough } = await import('node:stream');
  const makeProcess = () => {
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    let buffer = '';
    const proc = { stdin, stdout, stderr, pid: 1, kill() { stdout.end(); } };
    const respond = (request, result) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    stdin.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.method === 'initialize') respond(request, { protocolVersion: 1, agentInfo: { name: 'fake' } });
        else if (request.method === 'session/new') respond(request, { sessionId: 'acp-1' });
        else if (request.method === 'session/set_mode') respond(request, {});
        else if (request.method === 'session/set_config_option') respond(request, { configOptions: [{ id: request.params.configId, currentValue: request.params.value }] });
        else if (request.method === 'session/prompt') respond(request, { stopReason: 'end_turn' });
        else if (request.method === 'session/close') respond(request, {});
        else if (request.method === 'session/cancel') respond(request, {});
      }
    });
    return proc;
  };
  let spawned = 0;
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: () => { spawned += 1; return makeProcess(); }, hubScheduling: adapter });
  const started = await manager.start({ kind: 'normal', project: 'owner/demo', prompt: '普通会话' });
  assert.equal(spawned, 1, 'normal sessions must still use ACP');
  assert.equal(started.sessionId, 'acp-1');
  assert.equal(client.calls.length, 0, 'normal sessions must not touch the Hub scheduling adapter');
});

// ---- PR #74 返工回归 ----
test('F2 restore of a multi-turn matter continues at the next turn, not a duplicate id', async () => {
  const matters = [{ subject: 'scheduling:multi', sessionId: 'multi', project: 'owner/demo', state: 'idle', text: '第一句', lastEventId: 'console:multi:turn:3', runId: 'run-3' }];
  const client = fakeHubClient({ matters });
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: flagSpawn().fn, hubScheduling: adapter });
  await manager.restoreFromHub();
  await manager.send('multi', '恢复后继续');
  const posted = client.calls.filter(call => call[0] === 'postEvent').map(call => call[1].id);
  assert.deepEqual(posted, ['console:multi:turn:4']);
});

test('F2 matterTurn reads the max turn from events list and falls back to 1', () => {
  assert.equal(matterTurn('s', {}), 1);
  assert.equal(matterTurn('s', { events: [{ id: 'console:s:turn:2' }, 'console:s:turn:5', { id: 'other' }] }), 5);
  assert.equal(matterTurn('s', { lastEventId: 'console:other:turn:9' }), 1);
});

test('F3 restoreFromHub surfaces Hub failure instead of an empty list', async () => {
  const client = fakeHubClient({ listError: new Error('hub down') });
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  await assert.rejects(adapter.listMatters(), error => error instanceof HubSchedulingError && /hub down/.test(error.message));
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: flagSpawn().fn, hubScheduling: adapter });
  await assert.rejects(manager.restoreFromHub(), /hub down/);
  const empty = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: fakeHubClient({ matters: [] }) });
  assert.deepEqual(await empty.listMatters(), []);
});

test('F4 interrupt without a runId looks it up, and errors without marking idle when unknown', async () => {
  const matters = [{ subject: 'scheduling:norun', sessionId: 'norun', project: 'owner/demo', state: 'running', text: 'x' }];
  const found = fakeHubClient({ matters, runId: 'run-found', state: 'running' });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: flagSpawn().fn, hubScheduling: new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: found }) });
  await manager.restoreFromHub();
  await manager.send('norun', '', { interrupt: true });
  assert.ok(found.calls.some(call => call[0] === 'cancelRun' && call[1] === 'run-found'));

  const missing = fakeHubClient({ matters, readError: new Error('nope') });
  const manager2 = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: flagSpawn().fn, hubScheduling: new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: missing }) });
  await manager2.restoreFromHub();
  await assert.rejects(manager2.send('norun', '', { interrupt: true }), /run/);
  assert.equal(manager2.list()[0].status, 'running');
  assert.ok(!missing.calls.some(call => call[0] === 'cancelRun'));
});

test('F1 real createConsoleServer assembly restores sessions from the Hub on start', async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { createConsoleServer } = await import('../src/server.mjs');
  const { listen, close } = await import('./helpers.mjs');
  const hub = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/v1/matters')) return res.end(JSON.stringify({ matters: [{ subject: 'scheduling:real', sessionId: 'real', project: 'owner/demo', state: 'running', text: '重启前', lastEventId: 'console:real:turn:2' }] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  const root = mkdtempSync(path.join(tmpdir(), 'restore-root-'));
  const server = createConsoleServer({ hubUrl: `http://127.0.0.1:${hub.address().port}`, ownerKey: 'k', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json') });
  try {
    const url = await listen(server);
    await server.restoreSchedulingSessions();
    const response = await fetch(`${url}/api/scheduling-sessions`, { headers: { host: '127.0.0.1' } });
    const sessions = await response.json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].hubSubject, 'scheduling:real');
  } finally { await close(server); await new Promise(resolve => hub.close(resolve)); }
});

// #85：POST/GET /v1/events 必须用 source 密钥认证；其余 owner 调用不变；双密钥都要脱敏。
async function fakeAuthHub(handler) {
  const { createServer } = await import('node:http');
  const seen = [];
  const hub = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    handler?.(req, res) || res.end(JSON.stringify({ id: 'e1', state: 'running' }));
  });
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  return { seen, hubUrl: `http://127.0.0.1:${hub.address().port}`, close: () => new Promise(resolve => hub.close(resolve)) };
}

test('#85 events POST/GET authenticate with the source key; owner calls keep the owner key', async () => {
  const { hubRequest } = await import('../src/hub.mjs');
  const hub = await fakeAuthHub();
  try {
    const config = { hubUrl: hub.hubUrl, ownerKey: 'owner-key', sourceKey: 'source-key' };
    await postSchedulingEvent(config, { id: 'e1', subject: 'scheduling:s', type: 'scheduling.message' });
    await readSchedulingEvent(config, 'e1');
    await hubRequest(config, '/v1/matters?kind=scheduling');
    assert.deepEqual(hub.seen.map(r => r.authorization), ['Bearer source-key', 'Bearer source-key', 'Bearer owner-key']);
  } finally { await hub.close(); }
});

test('#85 missing sourceKey fails closed with a readable error and never falls back to the owner key', async () => {
  const hub = await fakeAuthHub();
  try {
    const config = { hubUrl: hub.hubUrl, ownerKey: 'owner-key' };
    await assert.rejects(() => postSchedulingEvent(config, { id: 'e1' }), /source\.key/);
    await assert.rejects(() => readSchedulingEvent(config, 'e1'), /source\.key/);
    assert.equal(hub.seen.length, 0, 'no request may reach the Hub without a source key');
  } finally { await hub.close(); }
});

test('#85 adapter keeps input and spawns nothing when the source key is missing', async () => {
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: { hubUrl: 'http://127.0.0.1:9', ownerKey: 'owner-key' } });
  await assert.rejects(
    () => adapter.postTurn({ sessionId: 's-1', turn: 1, project: 'owner/demo', text: '保留我' }),
    error => error instanceof HubSchedulingError && /source\.key/.test(error.message) && /输入已保留/.test(error.message) && /未派生本地进程/.test(error.message),
  );
});

test('#85 both keys are redacted from Hub responses and errors', async () => {
  const hub = await fakeAuthHub((req, res) => {
    if (req.method === 'POST') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad source-key and owner-key' })); }
    return res.end(JSON.stringify({ echo: ['owner-key', { k: 'x source-key y' }] }));
  });
  try {
    const config = { hubUrl: hub.hubUrl, ownerKey: 'owner-key', sourceKey: 'source-key' };
    await assert.rejects(() => postSchedulingEvent(config, { id: 'e1' }), error => !/source-key|owner-key/.test(error.message) && /已隐藏/.test(error.message));
    const read = await readSchedulingEvent(config, 'e1');
    assert.doesNotMatch(JSON.stringify(read), /source-key|owner-key/);
  } finally { await hub.close(); }
});

test('#85 loadConsoleConfig exposes sourceKey from the source object and tolerates its absence', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { loadConsoleConfig } = await import('../src/config.mjs');
  const make = extra => {
    const root = mkdtempSync(path.join(tmpdir(), 'src-key-'));
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:3350', owner: 'o', ...extra }));
    return loadConsoleConfig(root);
  };
  assert.equal(make({ source: { name: 'console', key: 'sk' } }).sourceKey, 'sk');
  assert.equal(make({}).sourceKey, null);
  assert.equal(make({ source: { name: 'console' } }).sourceKey, null);
  assert.equal(make({ source: 'sk' }).sourceKey, null, 'a bare string is not the documented shape');
});
