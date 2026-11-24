import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConsoleConfig, DEFAULT_MAX_SESSIONS, MAX_SESSIONS_UPPER_BOUND } from '../src/config.mjs';
import { SchedulingSessionManager } from '../src/scheduling-session.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { listen, close } from './helpers.mjs';

function writeConfig(extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'session-limit-config-'));
  mkdirSync(path.join(root, 'app', 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    url: 'http://127.0.0.1:3350', owner: 'private-owner-key', ...extra,
  }));
  return root;
}

function captureWarn(fn) {
  const original = console.warn;
  const messages = [];
  console.warn = (...args) => messages.push(args.map(String).join(' '));
  try { return { result: fn(), messages }; }
  finally { console.warn = original; }
}

// 最小 ACP 假适配器：只回 initialize / session/new / prompt / close，供并发上限回归用。
function fakeAdapter() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = '';
  const proc = { stdin, stdout, stderr, pid: 4242, kill() { stdout.end(); } };
  const send = value => stdout.write(`${JSON.stringify(value)}\n`);
  stdin.on('data', chunk => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      if (request.method === 'initialize') {
        send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { prompt: true } }, agentInfo: { name: 'fake', version: '0' } } });
      } else if (request.method === 'session/new') {
        send({ jsonrpc: '2.0', id: request.id, result: { sessionId: `fake-${request.id}` } });
      } else if (request.method === 'session/set_mode' || request.method === 'session/close' || request.method === 'session/cancel') {
        send({ jsonrpc: '2.0', id: request.id, result: {} });
      } else if (request.method === 'session/set_config_option') {
        send({ jsonrpc: '2.0', id: request.id, result: { configOptions: [{ id: request.params.configId, currentValue: request.params.value }] } });
      } else if (request.method === 'session/prompt') {
        send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } });
      }
    }
  });
  return proc;
}

test('maxSessions 缺失时回退默认 6 并告警', () => {
  assert.equal(DEFAULT_MAX_SESSIONS, 6);
  const { result: config, messages } = captureWarn(() => loadConsoleConfig(writeConfig()));
  assert.equal(config.maxSessions, 6);
  assert.ok(config.maxSessionsWarning, '缺失应记录回退原因供控制台展示');
  assert.ok(messages.some(message => /maxSessions/.test(message)), `应告警，实际：${JSON.stringify(messages)}`);
});

test('maxSessions 非法（非整数/字符串）回退 6 并告警', () => {
  for (const value of ['abc', 2.5, {}, false]) {
    const { result: config, messages } = captureWarn(() => loadConsoleConfig(writeConfig({ maxSessions: value })));
    assert.equal(config.maxSessions, 6, `${JSON.stringify(value)} 应回退`);
    assert.ok(messages.some(message => /maxSessions/.test(message)), `${JSON.stringify(value)} 应告警`);
  }
});

test('maxSessions 越界（0/13/20/-1）回退 6 并告警', () => {
  for (const value of [0, 13, 20, -1]) {
    const { result: config, messages } = captureWarn(() => loadConsoleConfig(writeConfig({ maxSessions: value })));
    assert.equal(config.maxSessions, 6, `${value} 应回退`);
    assert.ok(messages.some(message => /maxSessions/.test(message)), `${value} 应告警`);
    assert.match(config.maxSessionsWarning, /越界|1–12/);
  }
  assert.equal(MAX_SESSIONS_UPPER_BOUND, 12);
});

test('maxSessions 正常值（1/6/12）原样生效且不告警', () => {
  for (const value of [1, 6, 12]) {
    const { result: config, messages } = captureWarn(() => loadConsoleConfig(writeConfig({ maxSessions: value })));
    assert.equal(config.maxSessions, value);
    assert.equal(config.maxSessionsWarning, null);
    assert.equal(messages.length, 0, `${value} 不应告警`);
  }
});

test('默认上限 6：并发开满 6 个后再开被拒，文案带当前上限', async () => {
  const manager = new SchedulingSessionManager({
    hubScheduling: false, cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js',
    spawnFn: () => fakeAdapter(), settleMs: 10,
  });
  assert.equal(manager.maxSessions, 6);
  try {
    for (let i = 0; i < 6; i += 1) await manager.start({ project: `owner/project-${i}`, prompt: `任务${i}` });
    assert.equal(manager.list().length, 6);
    await assert.rejects(manager.start({ project: 'owner/project-7', prompt: '超额' }), error => {
      assert.match(error.message, /最多同时开启 6 个会话/);
      return true;
    });
  } finally {
    for (const session of manager.list()) await manager.close(session.id);
  }
});

test('server 装配 config.maxSessions，并由只读端点如实暴露', async () => {
  const config = loadConsoleConfig(writeConfig({ maxSessions: 9 }));
  const server = createConsoleServer(config);
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/session-limit`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.maxSessions, 9, '装配值应来自 config.json 而非硬编码');
    assert.equal(data.default, 6);
    assert.equal(data.min, 1);
    assert.equal(data.max, 12);
    assert.equal(data.warning, null);
  } finally { await close(server); }
});

test('越界回退告警经只读端点传给控制台，UI 可如实展示', async () => {
  const { result: config } = captureWarn(() => loadConsoleConfig(writeConfig({ maxSessions: 20 })));
  const server = createConsoleServer(config);
  const url = await listen(server);
  try {
    const data = await (await fetch(`${url}/api/session-limit`)).json();
    assert.equal(data.maxSessions, 6);
    assert.match(data.warning, /越界/);
  } finally { await close(server); }
});
