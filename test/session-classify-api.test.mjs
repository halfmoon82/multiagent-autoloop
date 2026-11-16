import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { listen, close } from './helpers.mjs';

const config = { hubUrl: 'http://127.0.0.1:1', ownerKey: 'server-secret', host: '127.0.0.1' };
const writeHeaders = { 'content-type': 'application/json', 'x-console-request': '1' };

test('classify endpoint recommends normal, scheduling or design from the first sentence', async () => {
  const calls = [];
  const manager = {
    async list() { return []; },
    async listArchived() { return []; },
    async start({ prompt, project, kind } = {}) { calls.push(['start', prompt, project, kind]); return { id: 'k1', kind, project, status: 'idle' }; },
  };
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'classify-projects-'));
  const repo = path.join(projectRoot, 'demo-repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const rulesFile = path.join(projectRoot, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [], elsewhere: [] }));
  const server = createConsoleServer({ ...config, projectRoots: [projectRoot], rulesFile }, manager);
  const url = await listen(server);
  try {
    const classify = async text => (await fetch(`${url}/api/session-classify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).json();
    // 只读推断：不带写请求头也可用。
    assert.equal((await classify('分析一下账单 API 的依赖关系')).kind, 'normal');
    assert.equal((await classify('排查失败任务并恢复调度规则')).kind, 'scheduling');
    const design = await classify('设计一个多租户计费方案，并拆解为可并行执行的 DAG');
    assert.equal(design.kind, 'design');
    assert.match(design.reason, /PRD/);
    assert.equal((await classify('')).kind, null);

    const started = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ prompt: '设计计费方案', project: repo, kind: 'design' }) });
    assert.equal(started.status, 201);
    assert.equal(calls.at(-1)[3], 'design', 'kind must be passed through to the session manager');

    const defaulted = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ prompt: '检查调度', project: repo }) });
    assert.equal(defaulted.status, 201);
    assert.equal(calls.at(-1)[3], 'scheduling', 'kind defaults to scheduling for backwards compatibility');

    const invalid = await fetch(`${url}/api/scheduling-sessions`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ prompt: 'x', project: repo, kind: 'superuser' }) });
    assert.equal(invalid.status, 400, 'unknown session kinds must be rejected');
  } finally { await close(server); }
});
