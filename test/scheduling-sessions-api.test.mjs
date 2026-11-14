import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleServer } from '../src/server.mjs';
import { SchedulingSessionError } from '../src/scheduling-session.mjs';
import { listen, close } from './helpers.mjs';

const config = { hubUrl: 'http://127.0.0.1:1', ownerKey: 'server-secret', host: '127.0.0.1' };
const writeHeaders = { 'content-type': 'application/json', 'x-console-request': '1' };

test('scheduling session API lists, starts and closes local ACP sessions', async () => {
  const calls = [];
  const manager = {
    async list() { calls.push(['list']); return [{ id: 'one', sessionId: 'acp-1', agent: 'Codex ACP', cwd: '/workspace/control-plane', project: 'owner/demo', status: 'idle', statusText: '待命', prompt: '检查调度', createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' }]; },
    async start({ prompt, project } = {}) {
      calls.push(['start', prompt, project]);
      if (!project) throw new SchedulingSessionError('请填写项目标识');
      return { id: 'two', sessionId: 'acp-2', agent: 'Codex ACP', cwd: '/workspace/control-plane', project, status: 'running', statusText: '运行中', prompt, createdAt: '2026-11-14T00:01:00Z', updatedAt: '2026-11-14T00:01:00Z' };
    },
    async send(id, text) {
      calls.push(['send', id, text]);
      if (id !== 'two') throw new SchedulingSessionError('调度会话不存在', { status: 404 });
      return { id: 'two', sessionId: 'acp-2', project: 'owner/demo', status: 'running', statusText: '运行中', messages: [{ role: 'user', text, at: '2026-11-14T00:02:00Z' }], liveText: '', busy: true };
    },
    async close(id) { calls.push(['close', id]); return { id, status: 'closed', statusText: '已关闭' }; },
  };
  const server = createConsoleServer(config, manager);
  const url = await listen(server);
  try {
    const listResponse = await fetch(`${url}/api/scheduling-sessions`);
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.json())[0].project, 'owner/demo');

    const missingMarker = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missingMarker.status, 403);

    const noProject = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ prompt: '检查当前调度' }) });
    assert.equal(noProject.status, 400);

    const started = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ prompt: '检查当前调度', project: 'owner/demo' }) });
    assert.equal(started.status, 201);
    const startedBody = await started.json();
    assert.equal(startedBody.sessionId, 'acp-2');
    assert.equal(startedBody.project, 'owner/demo');

    const messageMissingMarker = await fetch(`${url}/api/scheduling-sessions/two/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }) });
    assert.equal(messageMissingMarker.status, 403);

    const missingSession = await fetch(`${url}/api/scheduling-sessions/none/messages`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text: '你好' }) });
    assert.equal(missingSession.status, 404);

    const sent = await fetch(`${url}/api/scheduling-sessions/two/messages`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text: '重点看卡片' }) });
    assert.equal(sent.status, 200);
    const sentBody = await sent.json();
    assert.equal(sentBody.busy, true);
    assert.equal(sentBody.messages.at(-1).text, '重点看卡片');

    const closed = await fetch(`${url}/api/scheduling-sessions/two/close`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(closed.status, 200);
    assert.equal((await closed.json()).status, 'closed');
    assert.deepEqual(calls.map(call => call[0]), ['list', 'start', 'start', 'send', 'send', 'close']);
    assert.equal(calls[1][1], '检查当前调度');
    assert.equal(calls[1][2], undefined);
    assert.equal(calls[2][2], 'owner/demo');
    assert.equal(calls[3][1], 'none');
    assert.equal(calls[4][1], 'two');
    assert.equal(calls[4][2], '重点看卡片');
    assert.equal(calls[5][1], 'two');
  } finally { await close(server); }
});
