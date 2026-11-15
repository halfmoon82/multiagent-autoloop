import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { SchedulingSessionError } from '../src/scheduling-session.mjs';
import { listen, close } from './helpers.mjs';

const config = { hubUrl: 'http://127.0.0.1:1', ownerKey: 'server-secret', host: '127.0.0.1' };

test('createConsoleServer derives and creates the writable scripts dir from config.root', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'console-root-'));
  const server = createConsoleServer({ ...config, root, rulesFile: path.join(root, 'rules.json') });
  const url = await listen(server);
  try {
    assert.ok(existsSync(path.join(root, 'scripts')), 'AGENT_AUTOLOOP_HOME/scripts must be created for scheduling sessions');
  } finally { await close(server); }
});

test('createConsoleServer falls back to read-only when the scripts dir cannot be created', async () => {
  const fileRoot = path.join(mkdtempSync(path.join(tmpdir(), 'console-root-')), 'a-file');
  writeFileSync(fileRoot, 'x');
  const server = createConsoleServer({ ...config, root: fileRoot, rulesFile: path.join(path.dirname(fileRoot), 'rules.json') });
  const url = await listen(server);
  try {
    assert.ok(!existsSync(path.join(fileRoot, 'scripts')), 'uncreatable scripts dir must stay absent');
  } finally { await close(server); }
});
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
    async removeQueued(id, itemId) {
      calls.push(['removeQueued', id, itemId]);
      if (id !== 'two') throw new SchedulingSessionError('调度会话不存在', { status: 404 });
      if (itemId !== 'q1') throw new SchedulingSessionError('队列消息不存在或已送达', { status: 404 });
      return { id: 'two', status: 'running', statusText: '运行中', queued: [], queuedCount: 0 };
    },
    async close(id) { calls.push(['close', id]); return { id, status: 'closed', statusText: '已关闭' }; },
  };
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'api-projects-'));
  const repo = path.join(projectRoot, 'demo-repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const rulesFile = path.join(projectRoot, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [], elsewhere: [] }));
  const server = createConsoleServer({ ...config, projectRoots: [projectRoot], rulesFile }, manager);
  const url = await listen(server);
  try {
    const listResponse = await fetch(`${url}/api/scheduling-sessions`);
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.json())[0].project, 'owner/demo');

    const missingMarker = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missingMarker.status, 403);

    const noProject = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ prompt: '检查当前调度' }) });
    assert.equal(noProject.status, 400);

    const unknownProject = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ project: '/etc' }) });
    assert.equal(unknownProject.status, 400, 'projects outside the discovered repo list must be rejected');

    const started = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ prompt: '检查当前调度', project: repo }) });
    assert.equal(started.status, 201);
    const startedBody = await started.json();
    assert.equal(startedBody.sessionId, 'acp-2');
    assert.equal(startedBody.project, repo);
    assert.equal(calls[1].length, 3, 'server must no longer inject project/console docs into the session start');
    assert.doesNotMatch(calls[1][1], /事件链不变量/, 'console contract must not be inlined into the prompt');

    const messageMissingMarker = await fetch(`${url}/api/scheduling-sessions/two/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }) });
    assert.equal(messageMissingMarker.status, 403);

    const missingSession = await fetch(`${url}/api/scheduling-sessions/none/messages`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text: '你好' }) });
    assert.equal(missingSession.status, 404);

    const sent = await fetch(`${url}/api/scheduling-sessions/two/messages`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text: '重点看卡片' }) });
    assert.equal(sent.status, 200);
    const sentBody = await sent.json();
    assert.equal(sentBody.busy, true);
    assert.equal(sentBody.messages.at(-1).text, '重点看卡片');

    const queueMissingMarker = await fetch(`${url}/api/scheduling-sessions/two/queue/q1`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(queueMissingMarker.status, 403, 'queue removal must require the console request marker');

    const queueMissingItem = await fetch(`${url}/api/scheduling-sessions/two/queue/none`, { method: 'DELETE', headers: writeHeaders, body: '{}' });
    assert.equal(queueMissingItem.status, 404, 'unknown queue item must be 404');

    const removed = await fetch(`${url}/api/scheduling-sessions/two/queue/q1`, { method: 'DELETE', headers: writeHeaders, body: '{}' });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).queuedCount, 0);

    const deleteRuleRun = await fetch(`${url}/api/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/run`, { method: 'DELETE', headers: writeHeaders, body: '{}' });
    assert.equal(deleteRuleRun.status, 404, 'DELETE must not reach action routes that only accept POST');
    const deleteCardAnswer = await fetch(`${url}/api/cards/9/answer`, { method: 'DELETE', headers: writeHeaders, body: '{}' });
    assert.equal(deleteCardAnswer.status, 404, 'DELETE must not reach card routes that only accept POST');

    const putClose = await fetch(`${url}/api/scheduling-sessions/two/close`, { method: 'PUT', headers: writeHeaders, body: '{}' });
    assert.equal(putClose.status, 404, 'session routes must only accept POST');

    const closed = await fetch(`${url}/api/scheduling-sessions/two/close`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(closed.status, 200);
    assert.equal((await closed.json()).status, 'closed');
    assert.deepEqual(calls.map(call => call[0]), ['list', 'start', 'send', 'send', 'removeQueued', 'removeQueued', 'close']);
    assert.deepEqual(calls[5], ['removeQueued', 'two', 'q1']);
    assert.equal(calls[1][1], '检查当前调度');
    assert.equal(calls[1][2], repo);
    assert.equal(calls[2][1], 'none');
    assert.equal(calls[3][1], 'two');
    assert.equal(calls[3][2], '重点看卡片');
    assert.equal(calls[4][1], 'two');
  } finally { await close(server); }
});
