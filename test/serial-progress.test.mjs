import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { effectiveNodePercent, chainNodeOrder, computeChainProgress, mapChainProject, parseChainFile, loadChains } from '../src/serial-progress.mjs';

test('node percent uses the explicit override, then the status default, then zero', () => {
  assert.equal(effectiveNodePercent({ status: 'dev_dispatched', percent: 60 }), 60);
  assert.equal(effectiveNodePercent({ status: 'dev_dispatched' }), 30);
  assert.equal(effectiveNodePercent({ status: 'done' }), 100);
  assert.equal(effectiveNodePercent({ status: 'mystery' }), 0, 'unknown statuses must not crash');
  assert.equal(effectiveNodePercent({ status: 'dev_dispatched', percent: 160 }), 30, 'out-of-range overrides are ignored');
  assert.equal(effectiveNodePercent({ status: 'dev_dispatched', percent: '60' }), 30, 'non-numeric overrides are ignored');
});

test('chain order prefers the plan array and falls back to object key order', () => {
  const chain = { nodes: { b: {}, a: {}, c: {} }, plan: ['c', 'a', 'b'] };
  assert.deepEqual(chainNodeOrder(chain), ['c', 'a', 'b']);
  assert.deepEqual(chainNodeOrder({ nodes: { x: {}, y: {} } }), ['x', 'y']);
});

test('overall percent counts done nodes plus the current node inner progress', () => {
  const chain = {
    nodes: {
      n1: { status: 'done' },
      n2: { status: 'dev_dispatched' },
      n3: { status: 'pending' },
      n4: { status: 'pending' },
    },
    lastNode: 'n2',
  };
  const result = computeChainProgress(chain);
  assert.equal(result.currentId, 'n2');
  assert.equal(result.percent, 32.5, '(1 + 0.3) / 4');
  const overridden = computeChainProgress({ ...chain, nodes: { ...chain.nodes, n2: { status: 'dev_dispatched', percent: 50 } } });
  assert.equal(overridden.percent, 37.5);
  const weighted = computeChainProgress({ nodes: { a: { status: 'done' }, b: { status: 'pending', weight: 3 } }, lastNode: 'b' });
  assert.equal(weighted.percent, 25, 'done weight 1 of total 4');
  assert.equal(computeChainProgress({ nodes: { a: { status: 'done' }, b: { status: 'done' } } }).percent, 100);
  assert.equal(computeChainProgress({ nodes: { a: { status: 'pending' } } }).percent, 0);
  const noLast = computeChainProgress({ nodes: { a: { status: 'done' }, b: { status: 'rework' }, c: { status: 'pending' } } });
  assert.equal(noLast.currentId, 'b', 'without lastNode the first non-done node in chain order is current');
});

test('project mapping falls back project field, meta.project, then filename-to-rule prefix', () => {
  const rules = [{ name: 'V6串行推进', cwd: '/Users/macmini/Desktop/vibeguide' }, { name: 'Phase1串行推进', cwd: '/Volumes/Storage/health-service-core' }];
  assert.equal(mapChainProject('v6-serial.json', { project: '/explicit/vibeguide' }, rules), '/explicit/vibeguide');
  assert.equal(mapChainProject('x-serial.json', { meta: { project: '/meta/path' } }, rules), '/meta/path');
  assert.equal(mapChainProject('v6-serial.json', {}, rules), '/Users/macmini/Desktop/vibeguide');
  assert.equal(mapChainProject('phase1-serial.json', {}, rules), '/Volumes/Storage/health-service-core');
  assert.equal(mapChainProject('mystery-serial.json', {}, rules), '未识别');
});

test('parseChainFile validates shape and normalizes fields', () => {
  const chain = parseChainFile(JSON.stringify({
    project: '/p/demo', lastNode: 'n2',
    nodes: { n1: { status: 'done', title: '节点一', summary: '实现了第一块功能', pr_url: 'https://github.com/x/pull/1' }, n2: { status: 'blocked' } },
  }), 'demo-serial.json');
  assert.equal(chain.project, '/p/demo');
  assert.equal(chain.nodes.length, 2);
  assert.equal(chain.nodes[0].title, '节点一');
  assert.equal(chain.nodes[0].prUrl, 'https://github.com/x/pull/1');
  assert.throws(() => parseChainFile('{"nodes":"nope"}', 'x.json'), /nodes/);
  assert.throws(() => parseChainFile('not json', 'x.json'), /JSON/);
});

const chainFixture = {
  project: '/p/demo', lastNode: 'n2', plan: ['n1', 'n2', 'n3'],
  nodes: {
    n1: { status: 'done', title: '节点一', summary: '第一块功能' },
    n2: { status: 'dev_dispatched', title: '节点二', summary: '第二块功能' },
    n3: { status: 'pending', title: '节点三' },
  },
};

test('loadChains reads serial files, computes progress, skips corrupt files with a note', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serial-home-'));
  writeFileSync(path.join(root, 'demo-serial.json'), JSON.stringify(chainFixture));
  writeFileSync(path.join(root, 'broken-serial.json'), '{nope');
  writeFileSync(path.join(root, 'notes.txt'), 'ignored, not a serial file');
  const rules = [];
  const first = await loadChains({ root, rules });
  assert.equal(first.chains.length, 1);
  assert.equal(first.chains[0].project, '/p/demo');
  assert.equal(first.chains[0].percent, 43.3, '(1 + 0.3) / 3 rounded to one decimal');
  assert.equal(first.chains[0].current.title, '节点二');
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0], /broken-serial\.json/);
  const again = await loadChains({ root, rules });
  assert.equal(again.chains.length, 1, 'empty rules keep the explicit project field');
});

test('loadChains caches by mtime and refreshes after the file changes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serial-home-'));
  const file = path.join(root, 'demo-serial.json');
  writeFileSync(file, JSON.stringify(chainFixture));
  const rules = [];
  const first = await loadChains({ root, rules });
  assert.equal(first.chains[0].percent, 43.3);
  const changed = { ...chainFixture, nodes: { ...chainFixture.nodes, n2: { status: 'done', title: '节点二' }, n3: { status: 'done', title: '节点三' } } };
  writeFileSync(file, JSON.stringify(changed));
  const past = new Date(Date.now() - 2000);
  utimesSync(file, past, past);
  const fresh = await loadChains({ root, rules });
  assert.equal(fresh.chains[0].percent, 100, 'a changed file is re-read and refreshed');
});

test('GET /api/serial-progress exposes chains without leaking beyond whitelisted fields', async () => {
  const { createConsoleServer } = await import('../src/server.mjs');
  const { listen, close, fakeHub, json } = await import('./helpers.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'serial-api-'));
  writeFileSync(path.join(root, 'demo-serial.json'), JSON.stringify(chainFixture));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ agents: {}, sources: {}, rules: [] }));
  const hub = await fakeHub((req, res) => json(res, { seq: 1, cards: [], runs: [], lines: [] }));
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json'), projectRoots: [] }, { list: async () => [] });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/serial-progress`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.chains.length, 1);
    const chain = body.chains[0];
    assert.equal(chain.percent, 43.3);
    assert.equal(chain.current.title, '节点二');
    assert.deepEqual(Object.keys(chain.nodes[0]).sort(), ['id', 'kind', 'label', 'part', 'percent', 'prUrl', 'status', 'summary', 'title', 'weight'].sort(), 'only whitelisted node fields may leave the server');
  } finally { await close(server); await close(hub.server); }
});
