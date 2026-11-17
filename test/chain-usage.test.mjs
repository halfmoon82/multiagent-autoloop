// 真·整条链累计（RED）：链累计 Token/费用必须来自 Hub runs 全量翻页累加，
// 不能复用 lines 的今日窗口。只统计已完成轮次，费用缺失如实标注，幂等不重复计费。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

process.env.CHAIN_USAGE_TTL_MS = '0'; // 测试要逐轮验证增量入账，跳过热路径 TTL

// 假 Hub：?before=<id> 返回 id 更小的最近 PAGE 条， newest first，协议同 /v1/state。
const PAGE = 3;
function makeHub() {
  const store = { runs: [] };
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://hub');
    const before = url.searchParams.get('before');
    let pool = [...store.runs].sort((a, b) => b.id - a.id);
    if (before) pool = pool.filter(run => run.id < Number(before));
    const page = pool.slice(0, PAGE);
    json(res, {
      runs: page,
      hasMore: pool.length > PAGE,
      nextBefore: pool.length > PAGE ? page[PAGE - 1].id : null,
    });
  };
  return { store, handler };
}

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'chain-usage-'));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({
    agents: {}, sources: {},
    rules: [
      { name: 'V6串行推进', when: { cron: '*/15 * * * *' }, to: 'claude', cwd: '/p/v6app', prompt: 'x' },
      { name: 'V6开发', when: { cron: '*/15 * * * *' }, to: 'claude', cwd: '/p/v6app', prompt: 'x' },
      { name: 'Other推进', when: { cron: '*/15 * * * *' }, to: 'claude', cwd: '/p/other', prompt: 'x' },
      { name: 'MT开发', when: { cron: '*/15 * * * *' }, to: 'claude', cwd: '/p/mt', prompt: 'x' },
    ],
  }));
  writeFileSync(path.join(root, 'v6-serial.json'), JSON.stringify({
    project: '/p/v6app', lastNode: 'n1', lastEventAt: '2026-11-17T10:00:00+08:00',
    nodes: { n1: { status: 'done', title: '节点一' } },
  }));
  writeFileSync(path.join(root, 'mtexec-serial.json'), JSON.stringify({
    project: '/p/mt', lastNode: 'n1', lastEventAt: '2026-11-17T10:00:00+08:00',
    nodes: { n1: { status: 'done', title: '节点一' } },
  }));
  const { store, handler } = makeHub();
  const hub = await fakeHub(handler);
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret-key', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json') });
  const url = await listen(server);
  const progress = async () => (await fetch(`${url}/api/serial-progress`)).json();
  return { root, store, hub, server, url, progress };
}

const finished = (id, rule, usage, summary = '') => ({
  id, rule, agent: 'claude', state: 'done', attempts: 1,
  createdAt: '2026-11-17T01:00:00Z', claimedAt: '2026-11-17T01:00:01Z',
  finishedAt: '2026-11-17T01:05:00Z', notBefore: null, summary, error: '',
  link: '', session: null, usage, stopping: false, manual: false, events: [],
});

test('链累计翻遍 Hub 全部历史轮次，只算链规则的已完成轮次', async () => {
  const { store, hub, server, progress } = await setup();
  try {
    store.runs = [
      finished(6, 'V6串行推进', { input: 100, output: 50, cost: 1.5 }),
      finished(5, 'Other推进', { input: 999, output: 999, cost: 9 }),       // 别的项目：不计
      finished(4, 'V6开发', { input: 10, output: 0 }),                      // 费用未上报
      { ...finished(3, 'V6串行推进', null), usage: null },                  // 无上报：missingCost
      { ...finished(2, 'V6串行推进', { input: 1, output: 1, cost: 0.5 }), finishedAt: null }, // 未完成：不计
      finished(1, 'V6串行推进', { input: 1000, output: 500, cost: 3 }),     // 第二页
    ];
    const body = await progress();
    const chain = body.chains.find(item => item.sourceFile === 'v6-serial.json');
    assert.ok(chain.cumulativeUsage, '链必须带服务端累计');
    assert.equal(chain.cumulativeUsage.tokens, 1000 + 500 + 100 + 50 + 10);
    assert.equal(chain.cumulativeUsage.cost, 4.5, '未完成轮次的 0.5 不得入账');
    assert.equal(chain.cumulativeUsage.rounds, 4, '只数已完成轮次');
    assert.equal(chain.cumulativeUsage.missingCostRounds, 2, '费用未上报与 usage 为空的完成轮次都如实标注');
    assert.ok(!JSON.stringify(body).includes('server-secret-key'), '密钥不泄漏');
  } finally { await close(server); await close(hub.server); }
});

test('重复读取幂等：已计轮次不重复累计，且只翻到有新轮的页', async () => {
  const { store, hub, server, progress } = await setup();
  try {
    store.runs = [finished(2, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(1, 'V6开发', { input: 1, output: 1, cost: 1 })];
    const first = await progress();
    const chainOf = body => body.chains.find(item => item.sourceFile === 'v6-serial.json').cumulativeUsage;
    assert.equal(chainOf(first).cost, 2);
    const callsAfterFirst = hub.requests.length;
    const second = await progress();
    assert.equal(chainOf(second).cost, 2, '第二次读数不得重复计费');
    assert.ok(hub.requests.length - callsAfterFirst <= 2, '热路径只翻前几页');
    store.runs.push(finished(3, 'V6开发', { input: 2, output: 2, cost: 2.5 }));
    const third = await progress();
    assert.equal(chainOf(third).cost, 4.5, '新完成轮次增量入账');
    assert.equal(chainOf(third).tokens, 8);
  } finally { await close(server); await close(hub.server); }
});

test('先未完成、后完成的轮次在完成后入账', async () => {
  const { store, hub, server, progress } = await setup();
  try {
    store.runs = [{ ...finished(1, 'V6串行推进', { input: 3, output: 3, cost: 1 }), finishedAt: null }];
    assert.equal((await progress()).chains.find(item => item.sourceFile === 'v6-serial.json').cumulativeUsage.rounds, 0);
    store.runs[0].finishedAt = '2026-11-17T02:00:00Z';
    const again = await progress();
    const usage = again.chains.find(item => item.sourceFile === 'v6-serial.json').cumulativeUsage;
    assert.equal(usage.rounds, 1);
    assert.equal(usage.cost, 1);
  } finally { await close(server); await close(hub.server); }
});

test('链词干零命中回退到项目归属规则', async () => {
  const { store, hub, server, progress } = await setup();
  try {
    store.runs = [finished(2, 'MT开发', { input: 7, output: 7, cost: 4 }), finished(1, 'V6串行推进', { input: 1, output: 1, cost: 1 })];
    const body = await progress();
    const chain = body.chains.find(item => item.sourceFile === 'mtexec-serial.json');
    assert.equal(chain.cumulativeUsage.tokens, 14);
    assert.equal(chain.cumulativeUsage.cost, 4, 'mtexec 链只认领 MT 规则，不碰 V6 项目规则');
  } finally { await close(server); await close(hub.server); }
});

test('项目累计同样走全量翻页，不受 lines 今日窗口限制', async () => {
  const { store, hub, server, url } = await setup();
  try {
    store.runs = [
      finished(2, 'V6开发', { input: 5, output: 5, cost: 8 }),
      { ...finished(1, 'V6串行推进', { input: 5, output: 5, cost: 8 }), finishedAt: '2026-11-16T01:05:00Z' },
    ];
    const usage = await (await fetch(`${url}/api/project-usage`)).json();
    const v6 = usage.projects.find(item => item.key === 'v6app');
    assert.equal(v6.cumulative.cost, 16, '累计=全部历史轮次之和');
    assert.equal(v6.cumulative.tokens, 20);
    assert.equal(v6.today.cost, 8, '今日窗口只算当天完成的轮次');
  } finally { await close(server); await close(hub.server); }
});

// —— Reviewer P2 回归：陈旧 pending 不得拖垮热路径；翻页失败退避且保留断点进度 ——

test('超过 24h 未完成的 pending 视为夭折：不再阻塞前沿，也不再翻历史页', async () => {
  const { root, store, hub, server, progress } = await setup();
  try {
    // 预置台账：runs 4/3/2 已计，run 1 是 3 天前看到的未完成轮次（已夭折）。
    const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(path.join(root, 'chain-usage.json'), JSON.stringify({
      version: 1, complete: true, updatedAt: stale,
      seen: [1, 2, 3, 4],
      rules: {
        'V6串行推进': { counted: [4, 3, 2], pending: [{ id: 1, since: stale }], input: 3, output: 3, cost: 3, costReported: true, rounds: 3, missingCostRounds: 0 },
      },
    }));
    const unfinished = { ...finished(1, 'V6串行推进', { input: 9, output: 9, cost: 9 }), finishedAt: null, state: 'claimed' };
    store.runs = [finished(4, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(3, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(2, 'V6串行推进', { input: 1, output: 1, cost: 1 }), unfinished];
    const beforeCalls = () => hub.requests.filter(item => item.url.includes('before=')).length;
    const body = await progress();
    const usage = body.chains.find(item => item.sourceFile === 'v6-serial.json').cumulativeUsage;
    assert.equal(beforeCalls(), 0, '陈旧 pending 不得触发历史翻页');
    assert.equal(usage.cost, 3, '夭折轮次不计费、不污染已计结果');
    const ledger = JSON.parse(readFileSync(path.join(root, 'chain-usage.json'), 'utf8'));
    assert.deepEqual(ledger.rules['V6串行推进'].pending, [], '陈旧 pending 被清出台账');
  } finally { await close(server); await close(hub.server); }
});

test('翻页中途失败：已扫页进度落盘，退避期内不再打中台', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chain-usage-'));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({
    agents: {}, sources: {},
    rules: [{ name: 'V6串行推进', when: { cron: '* * * * *' }, to: 'claude', cwd: '/p/v6app', prompt: 'x' }],
  }));
  writeFileSync(path.join(root, 'v6-serial.json'), JSON.stringify({ project: '/p/v6app', lastNode: 'n1', nodes: { n1: { status: 'done' } } }));
  let failBefore = true;
  const hub = await fakeHub((req, res) => {
    if (req.url.includes('before=')) {
      if (failBefore) { json(res, { error: 'hub 抖动' }, 502); return; }
      return json(res, { runs: [], hasMore: false, nextBefore: null });
    }
    return json(res, {
      runs: [finished(3, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(2, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(1, 'V6串行推进', { input: 1, output: 1, cost: 1 })],
      hasMore: true, nextBefore: 1,
    });
  });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json') });
  const url = await listen(server);
  try {
    const first = await (await fetch(`${url}/api/serial-progress`)).json();
    assert.equal(first.chains[0].cumulativeUsage, undefined, '本轮刷新失败不附加累计');
    const ledger = JSON.parse(readFileSync(path.join(root, 'chain-usage.json'), 'utf8'));
    assert.equal(ledger.rules['V6串行推进'].cost, 3, '翻页失败前已扫页的进度必须落盘');
    const calls = hub.requests.length;
    failBefore = false;
    const second = await (await fetch(`${url}/api/serial-progress`)).json();
    assert.equal(second.chains[0].cumulativeUsage, undefined, '退避期内直接复用/降级，不重扫');
    assert.equal(hub.requests.length, calls, '退避期内不再发起任何中台请求');
  } finally { await close(server); await close(hub.server); }
});
