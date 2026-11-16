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
    async listArchived() { calls.push(['listArchived']); return []; },
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
    async steerQueued(id, itemId) {
      calls.push(['steerQueued', id, itemId]);
      if (id !== 'two') throw new SchedulingSessionError('调度会话不存在', { status: 404 });
      if (itemId !== 'q1') throw new SchedulingSessionError('队列消息不存在或已送达', { status: 404 });
      return { id: 'two', status: 'running', statusText: '运行中', queued: [], queuedCount: 0 };
    },
    async updateQueued(id, itemId, text) {
      calls.push(['updateQueued', id, itemId, text]);
      if (id !== 'two' || itemId !== 'q1') throw new SchedulingSessionError('队列消息不存在或已送达', { status: 404 });
      return { id: 'two', status: 'running', queued: [{ id: 'q1', text, at: 't' }], queuedCount: 1 };
    },
    async moveQueued(id, itemId, direction) {
      calls.push(['moveQueued', id, itemId, direction]);
      if (id !== 'two' || itemId !== 'q1') throw new SchedulingSessionError('队列消息不存在或已送达', { status: 404 });
      return { id: 'two', status: 'running', queued: [], queuedCount: 0 };
    },
    async resumeQueue(id) {
      calls.push(['resumeQueue', id]);
      if (id !== 'two') throw new SchedulingSessionError('调度会话不存在', { status: 404 });
      return { id: 'two', status: 'running', queuePaused: false };
    },
    async clearQueued(id) {
      calls.push(['clearQueued', id]);
      if (id !== 'two') throw new SchedulingSessionError('调度会话不存在', { status: 404 });
      return { id: 'two', status: 'running', queued: [], queuedCount: 0 };
    },
    async listSessionArtifacts(id) {
      calls.push(['listSessionArtifacts', id]);
      if (id !== 'two') throw new SchedulingSessionError('调度会话不存在', { status: 404 });
      return [{ path: 'docs/report.md', name: 'report.md', size: 12, at: '2026-11-16T00:00:00Z' }];
    },
    async readSessionArtifact(id, relPath) {
      calls.push(['readSessionArtifact', id, relPath]);
      if (id !== 'two') throw new SchedulingSessionError('调度会话不存在', { status: 404 });
      if (relPath === '../../etc/passwd') throw new SchedulingSessionError('路径越界：只允许会话工作目录内的相对路径', { status: 400 });
      if (relPath !== 'docs/report.md') throw new SchedulingSessionError('产物文件不存在：' + relPath, { status: 404 });
      return { path: relPath, name: 'report.md', content: '# 报告\n内容' };
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

    const steerMissingMarker = await fetch(`${url}/api/scheduling-sessions/two/queue/q1/steer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(steerMissingMarker.status, 403, 'steer in must require the console request marker');

    const steerMissingItem = await fetch(`${url}/api/scheduling-sessions/two/queue/none/steer`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(steerMissingItem.status, 404, 'steering an unknown queue item must be 404');

    const steered = await fetch(`${url}/api/scheduling-sessions/two/queue/q1/steer`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(steered.status, 200);
    assert.equal((await steered.json()).queuedCount, 0);

    const editMissingMarker = await fetch(`${url}/api/scheduling-sessions/two/queue/q1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '改' }) });
    assert.equal(editMissingMarker.status, 403, 'queue edit must require the console request marker');
    const edited = await fetch(`${url}/api/scheduling-sessions/two/queue/q1`, { method: 'PUT', headers: writeHeaders, body: JSON.stringify({ text: '改后文本' }) });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).queued[0].text, '改后文本');
    const editMissing = await fetch(`${url}/api/scheduling-sessions/two/queue/none`, { method: 'PUT', headers: writeHeaders, body: JSON.stringify({ text: 'x' }) });
    assert.equal(editMissing.status, 404, 'editing an unknown queue item must be 404');
    const moved = await fetch(`${url}/api/scheduling-sessions/two/queue/q1/move`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ direction: 'up' }) });
    assert.equal(moved.status, 200);
    const resumed = await fetch(`${url}/api/scheduling-sessions/two/queue/resume`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).queuePaused, false);
    const resumedMissing = await fetch(`${url}/api/scheduling-sessions/none/queue/resume`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(resumedMissing.status, 404);
    const cleared = await fetch(`${url}/api/scheduling-sessions/two/queue/clear`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).queuedCount, 0);

    const artifactsMissing = await fetch(`${url}/api/scheduling-sessions/none/artifacts`);
    assert.equal(artifactsMissing.status, 404);
    const artifacts = await fetch(`${url}/api/scheduling-sessions/two/artifacts`);
    assert.equal(artifacts.status, 200);
    assert.equal((await artifacts.json()).files[0].path, 'docs/report.md');
    const fileTraversal = await fetch(`${url}/api/scheduling-sessions/two/file?path=..%2F..%2Fetc%2Fpasswd`);
    assert.equal(fileTraversal.status, 400, 'artifact file reads must reject traversal');
    const fileMissing = await fetch(`${url}/api/scheduling-sessions/two/file?path=missing.md`);
    assert.equal(fileMissing.status, 404);
    const fileOk = await fetch(`${url}/api/scheduling-sessions/two/file?path=${encodeURIComponent('docs/report.md')}`);
    assert.equal(fileOk.status, 200);
    assert.match((await fileOk.json()).content, /# 报告/);

    const deleteRuleRun = await fetch(`${url}/api/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/run`, { method: 'DELETE', headers: writeHeaders, body: '{}' });
    assert.equal(deleteRuleRun.status, 404, 'DELETE must not reach action routes that only accept POST');
    const deleteCardAnswer = await fetch(`${url}/api/cards/9/answer`, { method: 'DELETE', headers: writeHeaders, body: '{}' });
    assert.equal(deleteCardAnswer.status, 404, 'DELETE must not reach card routes that only accept POST');

    const putClose = await fetch(`${url}/api/scheduling-sessions/two/close`, { method: 'PUT', headers: writeHeaders, body: '{}' });
    assert.equal(putClose.status, 404, 'session routes must only accept POST');

    const closed = await fetch(`${url}/api/scheduling-sessions/two/close`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(closed.status, 200);
    assert.equal((await closed.json()).status, 'closed');
    assert.deepEqual(calls.map(call => call[0]), ['list', 'start', 'send', 'send', 'removeQueued', 'removeQueued', 'steerQueued', 'steerQueued', 'updateQueued', 'updateQueued', 'moveQueued', 'resumeQueue', 'resumeQueue', 'clearQueued', 'listSessionArtifacts', 'listSessionArtifacts', 'readSessionArtifact', 'readSessionArtifact', 'readSessionArtifact', 'close']);
    assert.deepEqual(calls[16], ['readSessionArtifact', 'two', '../../etc/passwd']);
    assert.deepEqual(calls[17], ['readSessionArtifact', 'two', 'missing.md']);
    assert.deepEqual(calls[8], ['updateQueued', 'two', 'q1', '改后文本']);
    assert.deepEqual(calls[9], ['updateQueued', 'two', 'none', 'x']);
    assert.deepEqual(calls[10], ['moveQueued', 'two', 'q1', 'up']);
    assert.deepEqual(calls[11], ['resumeQueue', 'two']);
    assert.deepEqual(calls[13], ['clearQueued', 'two']);
    assert.equal(calls[1][1], '检查当前调度');
    assert.equal(calls[1][2], repo);
    assert.equal(calls[2][1], 'none');
    assert.equal(calls[3][1], 'two');
    assert.equal(calls[3][2], '重点看卡片');
    assert.equal(calls[4][1], 'two');
  } finally { await close(server); }
});

test('session archives list and continue route through the manager with validation', async () => {
  const calls = [];
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'archive-repo-')), 'demo'); mkdirSync(path.join(repo, '.git'), { recursive: true });
  writeFileSync(path.join(path.dirname(repo), 'rules.json'), JSON.stringify({ agents: {}, sources: {}, rules: [] }));
  const archiveId = 'deadbeef-0000-0000-0000-000000000001';
  const manager = {
    async listArchived() { calls.push(['listArchived']); return [{ id: archiveId, project: repo, agent: 'Codex ACP', messages: [], createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:05:00Z', closedAt: null, endStatus: 'interrupted', continuedFrom: null, prompt: '旧会话' }]; },
    async continueSession(id) { calls.push(['continue', id]); return { id: 'new-session', project: repo, status: 'running' }; },
    async list() { return []; },
  };
  const server = createConsoleServer({ ...config, projectRoots: [repo], rulesFile: path.join(repo, '..', 'rules.json') }, manager);
  const url = await listen(server);
  try {
    const listResponse = await fetch(`${url}/api/session-archives`);
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.json()).sessions.length, 1);

    const missing = await fetch(`${url}/api/scheduling-sessions/99999999-9999-9999-9999-999999999999/continue`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(missing.status, 404);

    const resumed = await fetch(`${url}/api/scheduling-sessions/${archiveId}/continue`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(resumed.status, 201);
    assert.equal((await resumed.json()).id, 'new-session');
    assert.deepEqual(calls.at(-1), ['continue', archiveId]);
  } finally { await close(server); }
});
