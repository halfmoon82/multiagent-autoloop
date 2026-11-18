// 真·整条链累计（RED→GREEN）：链/项目累计必须来自 Hub runs 全量翻页累加，
// 不能复用 lines 的今日窗口。只统计已开始且完成的轮次，费用缺失如实标注，
// 幂等不重复计费，翻页预算截断必须有持久化断点续翻（不得静默封顶）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

// 测试要逐轮验证增量入账，跳过热路径 TTL；断言也绝不依赖固定日历日期。
process.env.CHAIN_USAGE_TTL_MS = '0';
const DAY = 24 * 60 * 60 * 1000;
const isoToday = () => new Date().toISOString();
const isoDaysAgo = days => new Date(Date.now() - days * DAY).toISOString();

// 假 Hub：?before=<id> 返回 id 更小的最近 PAGE 条，newest first，协议同 /v1/state。
// 另按上游语义把未终态轮次并入第一页（host/state.ts 的 active 合并）。
const PAGE = 3;
function makeHub() {
  const store = { runs: [] };
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://hub');
    const before = url.searchParams.get('before');
    const byId = new Map();
    if (before) {
      for (const run of store.runs) if (run.id < Number(before)) byId.set(run.id, run);
    } else {
      for (const run of store.runs) byId.set(run.id, run);
      for (const run of store.runs) if (!run.finishedAt) byId.set(run.id, run); // active 合并
    }
    const pool = [...byId.values()].sort((a, b) => b.id - a.id);
    const page = pool.slice(0, PAGE);
    json(res, { runs: page, hasMore: pool.length > PAGE, nextBefore: pool.length > PAGE ? page[PAGE - 1].id : null });
  };
  return { store, handler };
}

function writeRuntime(root, chains) {
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({
    agents: {}, sources: {},
    rules: [
      { name: 'V6串行推进', when: { cron: '*/15 * * * *' }, to: 'claude', cwd: '/p/v6app', prompt: 'x' },
      { name: 'V6开发', when: { cron: '*/15 * * * *' }, to: 'claude', cwd: '/p/v6app', prompt: 'x' },
      { name: 'Other推进', when: { cron: '*/15 * * * *' }, to: 'claude', cwd: '/p/other', prompt: 'x' },
      { name: 'MT开发', when: { cron: '*/15 * * * *' }, to: 'claude', cwd: '/p/mt', prompt: 'x' },
    ],
  }));
  for (const [file, project] of chains) {
    writeFileSync(path.join(root, file), JSON.stringify({
      project, lastNode: 'n1', lastEventAt: isoToday(), nodes: { n1: { status: 'done', title: '节点一' } },
    }));
  }
}

async function setup(chains = [['v6-serial.json', '/p/v6app'], ['mtexec-serial.json', '/p/mt']]) {
  const root = mkdtempSync(path.join(tmpdir(), 'chain-usage-'));
  writeRuntime(root, chains);
  const { store, handler } = makeHub();
  const hub = await fakeHub(handler);
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret-key', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json') });
  const url = await listen(server);
  const progress = async () => (await fetch(`${url}/api/serial-progress`)).json();
  const chainUsageOf = async () => (await progress()).chains.find(item => item.sourceFile === 'v6-serial.json')?.cumulativeUsage;
  return { root, store, hub, server, url, progress, chainUsageOf };
}

const finished = (id, rule, usage) => ({
  id, rule, agent: 'claude', state: 'done', attempts: 1,
  createdAt: isoDaysAgo(1), claimedAt: isoDaysAgo(1), finishedAt: isoDaysAgo(1),
  notBefore: null, summary: '', error: '', link: '', session: null, usage,
  stopping: false, manual: false, events: [],
});
const open = (id, rule) => ({ ...finished(id, rule, null), state: 'claimed', finishedAt: null, usage: null });
const beforeCalls = hub => hub.requests.filter(item => item.url.includes('before=')).length;
const readLedgerFile = root => JSON.parse(readFileSync(path.join(root, 'chain-usage.json'), 'utf8'));

test('链累计翻遍 Hub 全部历史轮次，只算链规则已开始且完成的轮次', async () => {
  const { store, hub, server, chainUsageOf } = await setup();
  try {
    store.runs = [
      finished(6, 'V6串行推进', { input: 100, output: 50, cost: 1.5 }),
      finished(5, 'Other推进', { input: 999, output: 999, cost: 9 }),   // 别的项目：不计
      finished(4, 'V6开发', { input: 10, output: 0 }),                  // 费用未上报
      { ...finished(3, 'V6串行推进', null), usage: null },              // 无上报
      { ...finished(2, 'V6串行推进', null), claimedAt: null, usage: null }, // 从未开跑就取消：与中台 spending 口径一样不计轮次
      open(1, 'V6串行推进'),                                            // 未完成：不计
      finished(0, 'V6串行推进', { input: 1000, output: 500, cost: 3 }),  // 更早一页
    ];
    const usage = await chainUsageOf();
    assert.ok(usage, '链必须带服务端累计');
    assert.equal(usage.tokens, 1660);
    assert.equal(usage.cost, 4.5, '未完成与从未开跑轮次的费用不得入账');
    assert.equal(usage.rounds, 4, '只数已开始且完成的轮次');
    assert.equal(usage.missingCostRounds, 2, '费用未上报与 usage 为空都如实标注');
  } finally { await close(server); await close(hub.server); }
});

test('响应不回显密钥', async () => {
  const { store, hub, server, progress } = await setup();
  try {
    store.runs = [finished(1, 'V6串行推进', { input: 1, output: 1, cost: 1 })];
    const body = await progress();
    assert.equal(JSON.stringify(body).includes('server-secret-key'), false);
  } finally { await close(server); await close(hub.server); }
});

test('重复读取幂等：已计轮次不重复累计，热路径只翻前沿页', async () => {
  const { store, hub, server, chainUsageOf } = await setup();
  try {
    store.runs = [finished(2, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(1, 'V6开发', { input: 1, output: 1, cost: 1 })];
    assert.equal((await chainUsageOf()).cost, 2);
    const callsAfterFirst = hub.requests.length;
    assert.equal((await chainUsageOf()).cost, 2, '第二次读数不得重复计费');
    assert.ok(hub.requests.length - callsAfterFirst <= 2, '稳态只翻前几页');
    store.runs.push(finished(3, 'V6开发', { input: 2, output: 2, cost: 2.5 }));
    const third = await chainUsageOf();
    assert.equal(third.cost, 4.5, '新完成轮次增量入账');
    assert.equal(third.tokens, 8);
  } finally { await close(server); await close(hub.server); }
});

test('先未完成、后完成的轮次在完成后入账', async () => {
  const { store, hub, server, chainUsageOf } = await setup();
  try {
    store.runs = [open(1, 'V6串行推进')];
    assert.equal((await chainUsageOf()).rounds, 0);
    store.runs[0] = finished(1, 'V6串行推进', { input: 3, output: 3, cost: 1 });
    const usage = await chainUsageOf();
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

test('项目累计走全量翻页台账，今日只算当天完成轮次', async () => {
  const { store, hub, server, url } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    store.runs = [
      { ...finished(2, 'V6开发', { input: 5, output: 5, cost: 8 }), finishedAt: isoToday() },
      finished(1, 'V6串行推进', { input: 5, output: 5, cost: 8 }),   // 昨天
    ];
    const usage = await (await fetch(`${url}/api/project-usage`)).json();
    const v6 = usage.projects.find(item => item.key === 'v6app');
    assert.equal(v6.cumulative.cost, 16, '累计=全部历史轮次之和');
    assert.equal(v6.cumulative.tokens, 20);
    assert.equal(v6.today.cost, 8, '今日窗口只算当天完成的轮次');
  } finally { await close(server); await close(hub.server); }
});

test('翻页预算截断：断点持久化，下一轮续翻补全更早历史，未补全时如实标注', async () => {
  const { store, hub, server, chainUsageOf, root } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    for (let id = 0; id < 10; id += 1) store.runs.push(finished(id, 'V6串行推进', { input: 1, output: 1, cost: 1 }));
    process.env.CHAIN_USAGE_MAX_PAGES = '2';
    const partial = await chainUsageOf();
    assert.equal(partial.rounds, 6, '预算截断只入账已翻到的 2 页');
    assert.equal(partial.backfillPending, true, '未翻到底必须透出补全中，不得冒充全量');
    assert.equal(readLedgerFile(root).backfillCursor > 0, true, '截断点必须落盘');
    assert.equal(readLedgerFile(root).complete, false);
    delete process.env.CHAIN_USAGE_MAX_PAGES;
    const done = await chainUsageOf();
    assert.equal(done.rounds, 10, '下一轮从断点续翻，更早历史补全');
    assert.equal(done.cost, 10);
    assert.equal(done.backfillPending, undefined);
    assert.equal(readLedgerFile(root).complete, true);
    assert.equal(readLedgerFile(root).backfillCursor, null);
  } finally { delete process.env.CHAIN_USAGE_MAX_PAGES; await close(server); await close(hub.server); }
});

test('陈旧 pending（旧数组形态）转入不阻塞记账，不再深翻历史，完成后照样入账', async () => {
  const { store, hub, server, chainUsageOf, root } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    // 预置台账：4/3/2 已计，run 1 是三天前看到的未完成轮次（旧形态纯 id + 陈旧 updatedAt）。
    writeFileSync(path.join(root, 'chain-usage.json'), JSON.stringify({
      version: 2, complete: true, updatedAt: isoDaysAgo(3),
      seen: [1, 2, 3, 4],
      rules: {
        'V6串行推进': { counted: [4, 3, 2], pending: [1], input: 3, output: 3, cost: 3, costReported: true, rounds: 3, missingCostRounds: 0 },
      },
    }));
    store.runs = [finished(4, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(3, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(2, 'V6串行推进', { input: 1, output: 1, cost: 1 }), open(1, 'V6串行推进')];
    const usage = await chainUsageOf();
    assert.equal(beforeCalls(hub), 0, '陈旧 pending 不得再触发历史翻页');
    assert.equal(usage.cost, 3);
    assert.deepEqual(readLedgerFile(root).rules['V6串行推进'].unsettled, [1], '陈旧轮次转为不阻塞的记账');
    assert.deepEqual(readLedgerFile(root).rules['V6串行推进'].pending, []);
    // 它后来真的完成（中台把 active 轮次并入首页）：费用必须补计，一分不丢。
    store.runs[3] = finished(1, 'V6串行推进', { input: 1, output: 1, cost: 7 });
    const after = await chainUsageOf();
    assert.equal(after.cost, 10, '长期未完成轮次完成后照样入账');
    assert.equal(after.rounds, 4);
    assert.deepEqual(readLedgerFile(root).rules['V6串行推进'].unsettled, []);
  } finally { await close(server); await close(hub.server); }
});

test('翻页中途失败：已扫页进度与断点落盘，退避期内零中台请求且按台账重建结果', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chain-usage-'));
  writeRuntime(root, [['v6-serial.json', '/p/v6app']]);
  let failBefore = true;
  const hub = await fakeHub((req, res) => {
    if (req.url.includes('before=')) {
      if (failBefore) { json(res, { error: 'hub 抖动' }, 502); return; }
      return json(res, { runs: [finished(1, 'V6串行推进', { input: 1, output: 1, cost: 1 })], hasMore: false, nextBefore: null });
    }
    return json(res, {
      runs: [finished(3, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(2, 'V6串行推进', { input: 1, output: 1, cost: 1 })],
      hasMore: true, nextBefore: 2,
    });
  });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret-key', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json') });
  const url = await listen(server);
  const ofChain = async () => (await (await fetch(`${url}/api/serial-progress`)).json()).chains[0].cumulativeUsage;
  try {
    // 台账已到底（complete=true），本次只需回填断点之外的旧区：中途 502 → 断点在盘上。
    writeFileSync(path.join(root, 'chain-usage.json'), JSON.stringify({
      version: 2, complete: false, backfillCursor: null, updatedAt: isoToday(), seen: [], rules: {},
    }));
    const first = await ofChain().catch(() => undefined);
    assert.equal(first, undefined, '本轮刷新失败不附加累计');
    const ledger = readLedgerFile(root);
    assert.equal(ledger.rules['V6串行推进'].cost, 2, '翻页失败前已扫页的进度必须落盘');
    assert.equal(ledger.backfillCursor, 2, '续翻断点必须落盘');
    const calls = hub.requests.length;
    failBefore = false;
    const second = await ofChain();
    assert.equal(hub.requests.length, calls, '退避期内不再发起任何中台请求');
    assert.equal(second.cost, 2, '退避期按已落盘台账重建，不丢弃断点进度');
    assert.equal(second.backfillPending, true, '尚未补全到底时保持如实标注');
  } finally { await close(server); await close(hub.server); }
});

test('跨路由共享在途扫描：链累计不被 project-usage 的空链结果吃掉', async () => {
  const { store, hub, server, url, progress } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    store.runs = [finished(1, 'V6串行推进', { input: 2, output: 2, cost: 5 })];
    const [usageBody, serialBody] = await Promise.all([
      fetch(`${url}/api/project-usage`).then(r => r.json()),      // project-usage 先起翻（chains=[]）
      progress(),                                                  // serial-progress 共享同一次扫描
    ]);
    assert.equal(usageBody.projects.find(item => item.key === 'v6app').cumulative.cost, 5);
    assert.equal(serialBody.chains[0].cumulativeUsage.cost, 5, '链累计必须按本次链集合重建');
  } finally { await close(server); await close(hub.server); }
});

test('台账条目损坏时其 run id 一并出 seen，不做“已覆盖”假象', async () => {
  const { store, hub, server, chainUsageOf, root } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    writeFileSync(path.join(root, 'chain-usage.json'), JSON.stringify({
      version: 2, complete: true, seen: [9, 8, 7],
      rules: { 'V6串行推进': { counted: '坏掉', pending: [], input: 1, output: 1, cost: 9, costReported: true, rounds: 1, missingCostRounds: 0 } },
    }));
    store.runs = [finished(9, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(8, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(7, 'V6串行推进', { input: 1, output: 1, cost: 1 })];
    const usage = await chainUsageOf();
    assert.equal(usage.cost, 3, '损坏条目丢弃后这些轮次必须重新入账，不能被 seen 假装已计');
    assert.equal(usage.rounds, 3);
  } finally { await close(server); await close(hub.server); }
});
