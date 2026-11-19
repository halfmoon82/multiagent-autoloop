// /api/archive 端点级回归：真实服务端形状（DAG 节点 accepted、root done）+ 只读方法约束。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

test('GET /api/archive 返回已完成 DAG 与已完成串行链，且不接受写方法', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'archive-api-'));
  const project = path.join(root, 'demo');
  mkdirSync(path.join(project, '.git'), { recursive: true });
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ rules: [] }));
  writeFileSync(path.join(root, 'demo-serial.json.done-20261118'), JSON.stringify({
    project, title: '演示串行任务', plan: ['a', 'b'], nodes: { a: { status: 'done' }, b: { status: 'done' } },
  }));
  mkdirSync(path.join(root, 'dag-runs'), { recursive: true });
  writeFileSync(path.join(root, 'dag-runs', 'dagrun-fin.json'), JSON.stringify({
    runId: 'dagrun-fin', planId: 'demo-plan', nodeId: '__root__', project, status: 'done',
    createdAt: '2026-11-19T01:00:00Z', updatedAt: '2026-11-19T04:00:00Z', nodes: [{ id: 'a' }, { id: 'b' }],
    publish: { nodes: { a: { state: 'accepted' }, b: { state: 'accepted' } } },
  }));
  const hub = await fakeHub((req, res) => json(res, { seq: 1, totals: {}, spending: { today: {} }, cards: [], agents: [], channels: [], lines: [], runs: [], timers: [] }));
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', rulesFile: path.join(root, 'rules.json'), root, projectRoots: [root] }, { async list() { return []; }, async listArchived() { return []; }, dispose() {} });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/archive`);
    assert.equal(response.status, 200);
    const { archived } = await response.json();
    assert.equal(archived.length, 2, JSON.stringify(archived));
    const dag = archived.find(item => item.kind === 'dag');
    assert.equal(dag.reason, 'completed');
    assert.equal(dag.percent, 100);
    assert.equal(dag.title, 'demo-plan');
    const serial = archived.find(item => item.kind === 'serial');
    assert.equal(serial.reason, 'completed');
    assert.equal(serial.archivedAt, '2026-11-18');
    const post = await fetch(`${url}/api/archive`, { method: 'POST' });
    assert.equal(post.status, 403, 'archive endpoint must stay read-only (write guard rejects unmarked POST)');
  } finally {
    await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true });
  }
});
