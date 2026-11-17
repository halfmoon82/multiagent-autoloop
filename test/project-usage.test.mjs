import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aggregateProjectUsage } from '../src/project-usage.mjs';
import { projectUsageText } from '../public/status-sections.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const NOW = new Date('2026-11-17T10:00:00Z');
const rules = [
  { name: 'demo 开发', cwd: '/work/demo' },
  { name: 'demo 审阅', cwd: '/work/demo' },
  { name: 'beta 巡检', cwd: '/elsewhere/beta' },
];

const usageOf = (projects, key) => projects.find(item => item.key === key);

// ---- 纯聚合：累计来自规则行 usage，今日来自当天完成的 run.usage ----

test('aggregateProjectUsage 按项目汇总累计费用与 Token，只信自报值', () => {
  const state = { lines: [
    { name: 'demo 开发', totals: { done: 2, usage: { input: 900, output: 100, cost: 0.4 } } },
    { name: 'demo 审阅', usage: { input: 50, output: 10, cost: 0.1 } },
    { name: 'beta 巡检', totals: { usage: { input: 7, output: 3 } } },
  ], runs: [] };
  const { projects } = aggregateProjectUsage({ state, rules, now: NOW });
  const demo = usageOf(projects, 'demo');
  assert.equal(demo.project, '/work/demo');
  assert.equal(demo.cumulative.input, 950);
  assert.equal(demo.cumulative.output, 110);
  assert.equal(demo.cumulative.tokens, 1060);
  assert.ok(Math.abs(demo.cumulative.cost - 0.5) < 1e-9);
  assert.equal(demo.cumulative.reported, true);
  const beta = usageOf(projects, 'beta');
  assert.equal(beta.cumulative.tokens, 10);
  assert.equal(beta.cumulative.cost, null, '只报 Token 的项目不得编造费用');
  assert.equal(beta.cumulative.reported, true);
});

test('aggregateProjectUsage 今日只算当天完成且带 usage 的轮次，其余一律不计', () => {
  const state = { lines: [], runs: [
    { id: 1, rule: 'demo 开发', state: 'done', finishedAt: '2026-11-17T02:00:00Z', usage: { input: 80, output: 20, cost: 0.25 } },
    { id: 2, rule: 'demo 开发', state: 'done', finishedAt: '2026-11-16T02:00:00Z', usage: { input: 900, output: 900, cost: 9 } },
    { id: 3, rule: 'demo 开发', state: 'claimed', createdAt: '2026-11-17T01:00:00Z', usage: { input: 700, output: 700, cost: 7 } },
    { id: 4, rule: 'demo 审阅', state: 'nothing', finishedAt: '2026-11-17T03:00:00Z', usage: { input: 5, output: 5 } },
    { id: 5, rule: 'demo 审阅', state: 'done', finishedAt: '2026-11-17T04:00:00Z' },
  ] };
  const { projects } = aggregateProjectUsage({ state, rules, now: NOW });
  const today = usageOf(projects, 'demo').today;
  assert.equal(today.input, 85);
  assert.equal(today.output, 25);
  assert.equal(today.tokens, 110);
  assert.ok(Math.abs(today.cost - 0.25) < 1e-9);
  assert.equal(today.reported, true);
});

test('aggregateProjectUsage 无用量时 reported=false，不返回零费用冒充上报', () => {
  const { projects } = aggregateProjectUsage({ state: { lines: [], runs: [] }, rules, now: NOW });
  const demo = usageOf(projects, 'demo');
  assert.equal(demo.today.cost, null);
  assert.equal(demo.today.tokens, 0);
  assert.equal(demo.today.reported, false);
  assert.equal(demo.cumulative.reported, false);
});

test('aggregateProjectUsage 混合上报：有费用即累加费用，未报轮次不折算', () => {
  const state = { lines: [
    { name: 'demo 开发', usage: { input: 100, output: 10, cost: 0.5 } },
    { name: 'demo 审阅', usage: { input: 20, output: 2 } },
  ], runs: [] };
  const demo = usageOf(aggregateProjectUsage({ state, rules, now: NOW }).projects, 'demo');
  assert.equal(demo.cumulative.tokens, 132);
  assert.equal(demo.cumulative.cost, 0.5);
});

test('aggregateProjectUsage 忽略非数字 usage 字段与未知规则行', () => {
  const state = { lines: [
    { name: 'demo 开发', usage: { input: '999', output: null, cost: 'x' } },
    { name: '不存在规则', usage: { input: 50, output: 50, cost: 5 } },
  ], runs: [] };
  const { projects } = aggregateProjectUsage({ state, rules, now: NOW });
  assert.equal(usageOf(projects, 'demo').cumulative.reported, false);
  assert.equal(projects.some(item => item.key === '未识别'), false, '未知规则行不得编造项目归属');
});

// ---- 展示口径：已上报费用 → Token+费用未上报 → 暂无用量 ----

test('projectUsageText 按计费优先级展示，未知如实标注', () => {
  assert.equal(projectUsageText('今日', { cost: 0.5, input: 100, output: 20, tokens: 120, reported: true }), '今日 · 费用 $0.50 · Token 120（入 100 / 出 20）');
  assert.equal(projectUsageText('累计', { cost: null, input: 7, output: 3, tokens: 10, reported: true }), '累计 · Token 10（入 7 / 出 3） · 费用未上报');
  assert.equal(projectUsageText('今日', { cost: null, input: 0, output: 0, tokens: 0, reported: false }), '今日 · 暂无用量');
});

// ---- 服务端接口 ----

const rulesFileFor = dir => {
  const file = path.join(dir, 'rules.json');
  writeFileSync(file, JSON.stringify({ rules }));
  return file;
};

test('GET /api/project-usage 返回按项目汇总的今日/累计，不回传密钥', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'project-usage-'));
  const hub = await fakeHub((req, res) => json(res, { lines: [
    { name: 'demo 开发', usage: { input: 100, output: 20, cost: 0.5 } },
  ], runs: [
    { id: 1, rule: 'demo 开发', state: 'done', finishedAt: new Date().toISOString(), usage: { input: 10, output: 5 } },
  ] }));
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', rulesFile: rulesFileFor(dir) });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/project-usage`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const demo = usageOf(body.projects, 'demo');
    assert.ok(demo, 'api must return per-project usage');
    assert.equal(demo.cumulative.cost, 0.5);
    assert.equal(demo.today.tokens, 15);
    assert.equal(demo.today.cost, null, 'today token-only must stay unreported');
    assert.equal(JSON.stringify(body).includes('server-secret'), false);
    assert.equal(hub.requests[0].url, '/v1/state');
  } finally { await close(server); await close(hub.server); rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/project-usage 在 Hub 失败时返回 502', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'project-usage-'));
  const hub = await fakeHub((req, res) => { res.end('not-json'); });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', host: '127.0.0.1', rulesFile: rulesFileFor(dir) });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/project-usage`);
    assert.equal(response.status, 502);
  } finally { await close(server); await close(hub.server); rmSync(dir, { recursive: true, force: true }); }
});
