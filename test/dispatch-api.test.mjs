import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { createDispatcher } from '../src/dispatch.mjs';
import { listen, close } from './helpers.mjs';

const headers = { 'content-type': 'application/json', 'x-console-request': '1' };
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'dispatch-api-'));
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'dispatch-proj-'));
  const project = path.join(projectRoot, 'demo'); mkdirSync(path.join(project, '.git'), { recursive: true });
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ rules: [] }));
  const starts = [];
  const sessions = { async start(a) { starts.push(a); return { id: 's1', status: 'running' }; }, dispose() {} };
  const dispatcher = createDispatcher({ root, sessions, git: async () => {} });
  const server = createConsoleServer({ hubUrl: 'http://127.0.0.1:1', ownerKey: 'k', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json'), projectRoots: [projectRoot] }, sessions, dispatcher);
  return { server, project, starts };
}
const body = project => JSON.stringify({ subject: 'task-one', summary: '摘要', detail: '', project, model: 'gpt-5.6' });

test('POST /api/dispatch-tasks dispatches and GET lists it', async () => {
  const { server, project, starts } = setup(); const url = await listen(server);
  try {
    const res = await fetch(`${url}/api/dispatch-tasks`, { method: 'POST', headers, body: body(project) });
    assert.equal(res.status, 201);
    const task = await res.json();
    assert.equal(task.status, 'running'); assert.equal(task.cost.status, 'unreported');
    assert.equal(starts[0].profile, 'worker');
    const list = await (await fetch(`${url}/api/dispatch-tasks`)).json();
    assert.equal(list.tasks.length, 1);
    const cost = await fetch(`${url}/api/dispatch-tasks/${task.id}/cost`, { method: 'POST', headers, body: JSON.stringify({ tokens: 10 }) });
    assert.equal((await cost.json()).cost.tokens, 10);
  } finally { await close(server); }
});

test('write guards: missing marker, bad content-type, bad origin, bad subject, unknown project', async () => {
  const { server, project } = setup(); const url = await listen(server);
  try {
    const post = (h, b) => fetch(`${url}/api/dispatch-tasks`, { method: 'POST', headers: h, body: b });
    assert.equal((await post({ 'content-type': 'application/json' }, body(project))).status, 403);
    assert.equal((await post({ 'x-console-request': '1', 'content-type': 'text/plain' }, body(project))).status, 415);
    assert.equal((await post({ ...headers, origin: 'http://evil.example' }, body(project))).status, 403);
    assert.equal((await post(headers, JSON.stringify({ subject: 'has space', summary: 'x', project, model: 'm' }))).status, 400);
    assert.equal((await post(headers, JSON.stringify({ subject: 'ok', summary: 'x', project: '/etc', model: 'm' }))).status, 400);
    assert.equal((await post(headers, body(project))).status, 201);
    assert.equal((await post(headers, body(project))).status, 409);
  } finally { await close(server); }
});
