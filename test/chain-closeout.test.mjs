import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { isChainComplete, chainRuleNames, sweepChainCloseouts, archiveTarget, readCloseouts } from '../src/chain-closeout.mjs';
import { loadChains } from '../src/serial-progress.mjs';
import { fakeHub, json, close } from './helpers.mjs';

const doneChain = { project: '/p/demo', lastNode: 'n2', lastEventAt: '2026-11-15T17:06:00.850Z', nodes: { n1: { status: 'done', title: '一' }, n2: { status: 'done', title: '二' } } };
const RULES = [
  { name: 'V6串行推进', when: { cron: '*/15 * * * *' }, cwd: '/p/demo', to: 'v6-controller' },
  { name: 'V6开发', when: { source: 'local', types: ['v6.dev'] }, cwd: '/p/demo', to: 'workbuddy' },
];

function rootWith(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'closeout-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), typeof content === 'string' ? content : JSON.stringify(content));
  return root;
}
const age = (root, name, hoursAgo) => { const t = new Date(Date.now() - hoursAgo * 3600 * 1000); utimesSync(path.join(root, name), t, t); };
const HUB_CONFIG = { hubUrl: 'http://127.0.0.1:9', ownerKey: 'k' };

test('isChainComplete requires at least one node and all done', () => {
  assert.equal(isChainComplete({ nodes: [{ status: 'done' }, { status: 'done' }] }), true);
  assert.equal(isChainComplete({ nodes: [{ status: 'done' }, { status: 'pending' }] }), false);
  assert.equal(isChainComplete({ nodes: [] }), false);
});

test('chainRuleNames claims by stem at a word boundary, same rule as the project mapping', () => {
  const rules = [{ name: 'V6串行推进' }, { name: 'V6x串行推进' }, { name: '其他' }];
  assert.deepEqual(chainRuleNames('v6-serial.json', rules), ['V6串行推进']);
  assert.deepEqual(chainRuleNames('phase1-serial.json', rules), []);
});

test('archiveTarget appends .done-<date> and dedupes collisions', () => {
  const root = rootWith({ 'x-serial.json': doneChain });
  const first = archiveTarget(root, 'x-serial.json', Date.parse('2026-11-17T05:00:00Z'));
  assert.equal(path.basename(first), 'x-serial.json.done-20261117');
  writeFileSync(first, '{}');
  const second = archiveTarget(root, 'x-serial.json', Date.parse('2026-11-17T05:00:00Z'));
  assert.equal(path.basename(second), 'x-serial.json.done-20261117-2');
  rmSync(root, { recursive: true, force: true });
});

test('a completed stale chain pauses its exclusive cron rule and archives the file', async () => {
  const root = rootWith({ 'v6-serial.json': doneChain });
  age(root, 'v6-serial.json', 2);
  const hub = await fakeHub((req, res) => json(res, { changed: true }));
  const config = { ...HUB_CONFIG, hubUrl: hub.url };
  const result = await sweepChainCloseouts({ root, rules: RULES, config });
  await close(hub.server);
  assert.equal(result.closed.length, 1);
  assert.equal(result.closed[0].pausedRules.join(','), 'V6串行推进');
  assert.match(result.closed[0].archived, /v6-serial\.json\.done-\d{8}$/);
  const pauses = hub.requests.filter(r => r.method === 'POST' && r.url === '/v1/rules/' + encodeURIComponent('V6串行推进') + '/pause');
  assert.equal(pauses.length, 1, '只暂停专属 cron 规则一次');
  assert.equal(JSON.parse(pauses[0].body).until, null, '无限期暂停');
  assert.ok(JSON.parse(pauses[0].body).reason.includes('全部节点完成'));
  assert.equal(existsSync(path.join(root, 'v6-serial.json')), false, '原文件已归档');
  const lines = readCloseouts(root);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].chain, 'v6-serial.json');
  assert.deepEqual(lines[0].pausedRules, ['V6串行推进']);
  const { chains } = await loadChains({ root, rules: RULES });
  assert.equal(chains.length, 0, '归档后不再出现在进度面板');
  rmSync(root, { recursive: true, force: true });
});

test('event rules of the closed chain are never paused', async () => {
  const root = rootWith({ 'v6-serial.json': doneChain });
  age(root, 'v6-serial.json', 2);
  const hub = await fakeHub((req, res) => json(res, { changed: true }));
  await sweepChainCloseouts({ root, rules: RULES, config: { ...HUB_CONFIG, hubUrl: hub.url } });
  await close(hub.server);
  assert.equal(hub.requests.some(r => r.url.includes(encodeURIComponent('V6开发'))), false);
  rmSync(root, { recursive: true, force: true });
});

test('a chain fresh within the grace window is left untouched', async () => {
  const root = rootWith({ 'v6-serial.json': doneChain });
  age(root, 'v6-serial.json', 0.001);
  const hub = await fakeHub((req, res) => json(res, { changed: true }));
  const result = await sweepChainCloseouts({ root, rules: RULES, config: { ...HUB_CONFIG, hubUrl: hub.url } });
  await close(hub.server);
  assert.equal(result.closed.length, 0);
  assert.equal(hub.requests.length, 0, '宽限期内不打中台');
  assert.ok(existsSync(path.join(root, 'v6-serial.json')));
  rmSync(root, { recursive: true, force: true });
});

test('an incomplete chain is skipped', async () => {
  const root = rootWith({ 'v6-serial.json': { ...doneChain, nodes: { ...doneChain.nodes, n3: { status: 'pending', title: '三' } } } });
  age(root, 'v6-serial.json', 2);
  const hub = await fakeHub((req, res) => json(res, { changed: true }));
  const result = await sweepChainCloseouts({ root, rules: RULES, config: { ...HUB_CONFIG, hubUrl: hub.url } });
  await close(hub.server);
  assert.equal(result.closed.length, 0);
  assert.equal(hub.requests.length, 0);
  assert.ok(existsSync(path.join(root, 'v6-serial.json')));
  rmSync(root, { recursive: true, force: true });
});

test('a cron rule also claimed by another live chain is not paused, the completed file still archives', async () => {
  const root = rootWith({
    'a-serial.json': doneChain,
    'a-b-serial.json': { project: '/p/other', nodes: { x: { status: 'pending', title: '活' } } },
  });
  age(root, 'a-serial.json', 2);
  age(root, 'a-b-serial.json', 2);
  const rules = [{ name: 'a-b控制器', when: { cron: '*/5 * * * *' }, cwd: '/p/demo' }];
  const hub = await fakeHub((req, res) => json(res, { changed: true }));
  const result = await sweepChainCloseouts({ root, rules, config: { ...HUB_CONFIG, hubUrl: hub.url } });
  await close(hub.server);
  assert.equal(result.closed.length, 1, '完成链照常归档');
  assert.deepEqual(result.closed[0].pausedRules, [], '共享 cron 规则不暂停');
  assert.equal(hub.requests.length, 0);
  assert.equal(existsSync(path.join(root, 'a-serial.json')), false, '完成的链文件归档与规则共享无关');
  assert.ok(existsSync(path.join(root, 'a-b-serial.json')), '在途链文件不动');
  rmSync(root, { recursive: true, force: true });
});

test('a hub failure records an error and keeps the file for the next sweep', async () => {
  const root = rootWith({ 'v6-serial.json': doneChain });
  age(root, 'v6-serial.json', 2);
  const hub = await fakeHub((req, res) => json(res, { error: '中台返回 500' }, 500));
  const result = await sweepChainCloseouts({ root, rules: RULES, config: { ...HUB_CONFIG, hubUrl: hub.url } });
  await close(hub.server);
  assert.equal(result.closed.length, 0);
  assert.equal(result.errors.length, 1);
  assert.ok(existsSync(path.join(root, 'v6-serial.json')), '暂停失败不归档，下次巡检重试');
  rmSync(root, { recursive: true, force: true });
});

test('missing root is a quiet no-op', async () => {
  const result = await sweepChainCloseouts({ root: null, rules: RULES, config: HUB_CONFIG });
  assert.deepEqual(result, { closed: [], skipped: [], errors: [] });
});

test('readCloseouts tolerates a missing or malformed audit file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'closeout-'));
  assert.deepEqual(readCloseouts(root), []);
  writeFileSync(path.join(root, 'closeouts.jsonl'), '{"chain":"a"}\nnot-json\n');
  assert.equal(readCloseouts(root).length, 1, '坏行跳过，好行保留');
  rmSync(root, { recursive: true, force: true });
});

test('GET /api/closeouts serves the audit tail', async () => {
  const { createConsoleServer } = await import('../src/server.mjs');
  const { listen, close } = await import('./helpers.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'closeout-'));
  const server = createConsoleServer({ root, hubUrl: 'http://127.0.0.1:9', ownerKey: 'k' });
  const url = await listen(server);
  try {
    const empty = await fetch(`${url}/api/closeouts`).then(r => r.json());
    assert.deepEqual(empty.closeouts, []);
    writeFileSync(path.join(root, 'closeouts.jsonl'), '{"chain":"a-serial.json"}\n{"chain":"b-serial.json"}\n');
    const two = await fetch(`${url}/api/closeouts`).then(r => r.json());
    assert.equal(two.closeouts.length, 2);
    assert.equal(two.closeouts[1].chain, 'b-serial.json');
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});
