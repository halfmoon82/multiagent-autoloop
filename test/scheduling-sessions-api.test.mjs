import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleServer } from '../src/server.mjs';
import { listen, close } from './helpers.mjs';

const config = { hubUrl: 'http://127.0.0.1:1', ownerKey: 'server-secret', host: '127.0.0.1' };
const writeHeaders = { 'content-type': 'application/json', 'x-console-request': '1' };

test('scheduling session API lists, starts and closes local ACP sessions', async () => {
  const calls = [];
  const manager = {
    async list() { calls.push(['list']); return [{ id: 'one', sessionId: 'acp-1', agent: 'Codex ACP', cwd: '/workspace/control-plane', status: 'idle', statusText: '待命', prompt: '检查调度', createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' }]; },
    async start({ prompt } = {}) { calls.push(['start', prompt]); return { id: 'two', sessionId: 'acp-2', agent: 'Codex ACP', cwd: '/workspace/control-plane', status: 'running', statusText: '运行中', prompt, createdAt: '2026-11-14T00:01:00Z', updatedAt: '2026-11-14T00:01:00Z' }; },
    async close(id) { calls.push(['close', id]); return { id, status: 'closed', statusText: '已关闭' }; },
  };
  const server = createConsoleServer(config, manager);
  const url = await listen(server);
  try {
    const listResponse = await fetch(`${url}/api/scheduling-sessions`);
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.json())[0].sessionId, 'acp-1');

    const missingMarker = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missingMarker.status, 403);

    const started = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ prompt: '检查当前调度' }) });
    assert.equal(started.status, 201);
    assert.equal((await started.json()).sessionId, 'acp-2');

    const closed = await fetch(`${url}/api/scheduling-sessions/two/close`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(closed.status, 200);
    assert.equal((await closed.json()).status, 'closed');
    assert.deepEqual(calls.map(call => call[0]), ['list', 'start', 'close']);
    assert.equal(calls[1][1], '检查当前调度');
    assert.equal(calls[2][1], 'two');
  } finally { await close(server); }
});
