import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { SchedulingSessionManager, SchedulingSessionError } from '../src/scheduling-session.mjs';
import { HubSchedulingSessionAdapter } from '../src/hub-scheduling-session.mjs';
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
    assert.deepEqual(calls.map(call => call[0]), ['list', 'start', 'send', 'send', 'removeQueued', 'removeQueued', 'steerQueued', 'steerQueued', 'updateQueued', 'updateQueued', 'moveQueued', 'clearQueued', 'listSessionArtifacts', 'listSessionArtifacts', 'readSessionArtifact', 'readSessionArtifact', 'readSessionArtifact', 'close']);
    assert.deepEqual(calls[14], ['readSessionArtifact', 'two', '../../etc/passwd']);
    assert.deepEqual(calls[15], ['readSessionArtifact', 'two', 'missing.md']);
    assert.deepEqual(calls[8], ['updateQueued', 'two', 'q1', '改后文本']);
    assert.deepEqual(calls[9], ['updateQueued', 'two', 'none', 'x']);
    assert.deepEqual(calls[10], ['moveQueued', 'two', 'q1', 'up']);
    assert.deepEqual(calls[11], ['clearQueued', 'two']);
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

// #89：真实 HTTP 路径创建 scheduling 会话时，事件只含中台白名单字段；假 Hub 像真实中台一样拒绝未知字段。
test('#89 creating a scheduling session posts a whitelist-only event to a strict Hub and returns 201', async () => {
  const { createServer } = await import('node:http');
  const EVENT_FIELDS = ['id', 'type', 'subject', 'summary', 'detail', 'link'];
  const seen = [];
  const strictHub = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/events') {
        const event = JSON.parse(raw || '{}');
        seen.push(event);
        const unknown = Object.keys(event).filter(key => !EVENT_FIELDS.includes(key));
        if (unknown.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: `不认识的字段：${unknown.join(', ')}` })); }
        return res.end(JSON.stringify({ id: event.id, runId: 'run-strict', state: 'running' }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(resolve => strictHub.listen(0, '127.0.0.1', resolve));
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'strict-hub-projects-'));
  const repo = path.join(projectRoot, 'demo-repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const rulesFile = path.join(projectRoot, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [], elsewhere: [] }));
  const server = createConsoleServer({
    hubUrl: `http://127.0.0.1:${strictHub.address().port}`, sourceKey: 'source-key', ownerKey: 'owner-key',
    host: '127.0.0.1', root: projectRoot, rulesFile, projectRoots: [projectRoot],
  });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/scheduling-sessions`, {
      method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ kind: 'scheduling', project: repo, prompt: '按规则推进调度' }),
    });
    assert.equal(response.status, 201, 'strict Hub accepts a whitelist-only scheduling event');
    const body = await response.json();
    assert.equal(seen.length, 1);
    assert.deepEqual(Object.keys(seen[0]).sort(), ['detail', 'id', 'subject', 'summary', 'type']);
    assert.equal(seen[0].subject, `scheduling:${body.sessionId}`, 'subject 规则不变');
    assert.equal(seen[0].id, `console:${body.sessionId}:turn:1`, 'event.id 幂等键不变');
    assert.equal(seen[0].type, 'scheduling.message');
    const detail = JSON.parse(seen[0].detail);
    assert.equal(detail.project, repo, 'project 进入 worker 可解析的 detail');
    // 首轮文本 = 调度提示词（含资料文件提示，可能被截断）；用户原句在提示词尾部或在被截掉的附加说明里——
    // 不逐字断言用户输入，断言 detail 形态 + 3950 预算 + 提示存在。
    assert.ok(Buffer.byteLength(detail.text, 'utf8') <= 3950, 'detail.text 必须在 Hub 4000 预算内');
    assert.match(detail.text, /本轮完整资料|按规则推进调度/, '首轮文本要么含资料提示，要么原文完整');
  } finally { await close(server); await new Promise(resolve => strictHub.close(resolve)); }
});

// #100：真实 HTTP 轮询路径上，活跃 Hub 会话状态随中台 run.state 自动刷新。
test('#100 GET /api/scheduling-sessions auto-refreshes an active Hub session through polling', async () => {
  const states = ['claimed', 'done'];
  let index = 0;
  const hubClient = {
    async postEvent() { return { event: 7267, duplicate: false, routed: true, paused: false }; },
    async readEvent(hubConfig, eventId) {
      const state = states[Math.min(index, states.length - 1)];
      index += 1;
      return { event: eventId, routed: true, paused: false, runs: [{ run: 6663, state }] };
    },
    async cancelRun() { return { ok: true }; },
  };
  const manager = new SchedulingSessionManager({
    cwd: '/x', adapterPath: '/a.js',
    spawnFn: () => { throw new Error('Hub scheduling sessions must not spawn a private ACP'); },
    hubScheduling: new HubSchedulingSessionAdapter({
      hubConfig: { hubUrl: 'http://127.0.0.1:9', ownerKey: 'k', sourceKey: 's' },
      hubClient,
    }),
    hubReconcileMs: 20,
  });
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'refresh-api-'));
  const repo = path.join(projectRoot, 'demo-repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const rulesFile = path.join(projectRoot, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [], elsewhere: [] }));
  const server = createConsoleServer({ ...config, root: projectRoot, rulesFile, projectRoots: [projectRoot] }, manager);
  const base = await listen(server);
  try {
    const created = await fetch(`${base}/api/scheduling-sessions`, {
      method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ kind: 'scheduling', project: repo, prompt: '按规则推进调度' }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).status, 'running', 'claimed 映射为运行中，而不是待复核');

    // 中台转 done 后，仅靠前端周期性 GET 轮询，视图自动跟上 idle。
    const deadline = Date.now() + 1000;
    let listed;
    do {
      listed = (await (await fetch(`${base}/api/scheduling-sessions`)).json())[0];
      if (listed.status === 'idle') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(listed.status, 'idle', 'polling must pick up the terminal state automatically');
    assert.equal(listed.hubRunId, 6663);
  } finally { await close(server); manager.dispose(); }
});

// #102：真实 HTTP 路径上，close 后重启不再复活、不堵新建，且历史折叠区可见。
test('#102 after close and restart the console does not resurrect a Hub session or block a new one for the same project', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'close-persist-api-'));
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'close-api-projects-'));
  const repo = path.join(projectRoot, 'demo-repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const rulesFile = path.join(projectRoot, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [], elsewhere: [] }));
  const hubClient = {
    async postEvent() { return { event: 7300, duplicate: false, routed: true, paused: false }; },
    async readEvent(hubConfig, eventId) { return { event: eventId, routed: true, paused: false, runs: [{ run: 6700, state: 'claimed' }] }; },
    async cancelRun() { return { ok: true }; },
  };
  const makeManager = () => new SchedulingSessionManager({
    cwd: '/x', adapterPath: '/a.js',
    spawnFn: () => { throw new Error('Hub scheduling sessions must not spawn a private ACP'); },
    hubScheduling: new HubSchedulingSessionAdapter({
      hubConfig: { hubUrl: 'http://127.0.0.1:9', ownerKey: 'k', sourceKey: 's' },
      hubClient,
    }),
    archiveRoot: home,
  });
  const serverOptions = { ...config, root: home, rulesFile, projectRoots: [projectRoot] };
  let closedId;

  const firstManager = makeManager();
  const firstServer = createConsoleServer(serverOptions, firstManager);
  const firstUrl = await listen(firstServer);
  try {
    const created = await fetch(`${firstUrl}/api/scheduling-sessions`, {
      method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ kind: 'scheduling', project: repo, prompt: '将被关闭' }),
    });
    assert.equal(created.status, 201);
    closedId = (await created.json()).id;
    const closed = await fetch(`${firstUrl}/api/scheduling-sessions/${closedId}/close`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(closed.status, 200, 'close via HTTP must succeed');
  } finally { await close(firstServer); }

  // 重启：新 manager + 新 server，先 restore。
  const secondManager = makeManager();
  await secondManager.restoreFromHub();
  const secondServer = createConsoleServer(serverOptions, secondManager);
  const secondUrl = await listen(secondServer);
  try {
    const active = await (await fetch(`${secondUrl}/api/scheduling-sessions`)).json();
    assert.equal(active.length, 0, 'a closed session must not reappear in the active list after restart');
    const archive = await (await fetch(`${secondUrl}/api/session-archives`)).json();
    assert.ok(archive.sessions.some(item => item.id === closedId), 'the closed session must be visible in the history area');
    const recreated = await fetch(`${secondUrl}/api/scheduling-sessions`, {
      method: 'POST', headers: writeHeaders,
      body: JSON.stringify({ kind: 'scheduling', project: repo, prompt: '重启后新建' }),
    });
    assert.equal(recreated.status, 201, 'a closed session must not block a new one for the same project');
  } finally { await close(secondServer); secondManager.dispose(); }
});
