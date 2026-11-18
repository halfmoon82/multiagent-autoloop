// 真·整条链累计（RED→GREEN）：链/项目累计必须来自 Hub runs 全量翻页累加，
// 不能复用 lines 的今日窗口。只统计已开始且完成的轮次，费用缺失如实标注，
// 幂等不重复计费，翻页预算截断必须有持久化断点续翻（不得静默封顶）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
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
let PAGE = 3;
function makeHub() {
  const store = { runs: [] };
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://hub');
    const before = url.searchParams.get('before');
    const byId = new Map();
    if (before) {
      for (const run of store.runs) if (run.id < Number(before)) byId.set(run.id, run);
      const pool = [...byId.values()].sort((a, b) => b.id - a.id);
      const page = pool.slice(0, PAGE);
      json(res, { runs: page, hasMore: pool.length > PAGE, nextBefore: pool.length > PAGE ? page[PAGE - 1].id : null });
      return;
    }
    // 上游 host/state.ts：第一页 = 最新 PAGE 条，另外把 queued/claimed/unknown 全量并入。
    const pool = [...store.runs].sort((a, b) => b.id - a.id);
    const page = new Map(pool.slice(0, PAGE).map(run => [run.id, run]));
    for (const run of pool) if (!run.finishedAt) page.set(run.id, run);
    const merged = [...page.values()].sort((a, b) => b.id - a.id);
    json(res, { runs: merged, hasMore: pool.length > PAGE, nextBefore: pool.length > PAGE ? pool[PAGE - 1].id : null });
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
  // 每个用例显式复位热路径节流，避免用例之间通过环境变量互相污染。
  process.env.CHAIN_USAGE_TTL_MS = '0';
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

test('陈旧 pending 转入不阻塞记账：不再全量深翻，完成后靠定向探针补计一分不丢', async () => {
  const { store, hub, server, chainUsageOf, root } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    // 预置台账（旧形态：pending 是纯 id 数组 + 陈旧 updatedAt）：10/9/8 已计，run 7 三天前就看到还没完成。
    writeFileSync(path.join(root, 'chain-usage.json'), JSON.stringify({
      version: 2, complete: true, updatedAt: isoDaysAgo(3),
      seen: [8, 9, 10],
      rules: {
        'V6串行推进': { counted: [10, 9, 8], pending: [7], input: 3, output: 3, cost: 3, costReported: true, rounds: 3, missingCostRounds: 0 },
      },
    }));
    store.runs = [
      finished(10, 'V6串行推进', { input: 1, output: 1, cost: 1 }),
      finished(9, 'V6串行推进', { input: 1, output: 1, cost: 1 }),
      finished(8, 'V6串行推进', { input: 1, output: 1, cost: 1 }),
      open(7, 'V6串行推进'),
    ];
    const first = await chainUsageOf();
    assert.equal(first.cost, 3, '已计轮次不得被重算');
    const ledger = readLedgerFile(root);
    assert.deepEqual(ledger.rules['V6串行推进'].unsettled, [7], '陈旧轮次转入不阻塞的记账册');
    assert.deepEqual(ledger.rules['V6串行推进'].pending, []);
    assert.ok(ledger.complete, '不阻塞前沿：台账不必保持未到底状态');
    const callsAfterFirst = beforeCalls(hub);
    assert.ok(callsAfterFirst <= 1, `陈旧轮次只允许定向核实，实测 ${callsAfterFirst} 次历史翻页`);
    // 它三天后才完成：此时 run 7 既不在首页最新 3 条里，也不再是 active 轮次。
    store.runs[3] = finished(7, 'V6串行推进', { input: 1, output: 1, cost: 7 });
    const after = await chainUsageOf();
    assert.equal(after.cost, 10, '长期未完成轮次完成后照样入账，一分不丢');
    assert.equal(after.rounds, 4);
    assert.deepEqual(readLedgerFile(root).rules['V6串行推进'].unsettled, []);
    assert.ok(beforeCalls(hub) - callsAfterFirst <= 2, '补计只花定向探针的少量请求');
  } finally { await close(server); await close(hub.server); }
});

test('unsettled 册满时溢出只计数不静默丢账', async () => {
  const { store, hub, server, chainUsageOf, root } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    process.env.CHAIN_USAGE_UNSETTLED_MAX = '2';
    const staleIds = [70, 71, 72, 73, 74];
    writeFileSync(path.join(root, 'chain-usage.json'), JSON.stringify({
      version: 2, complete: true, updatedAt: isoDaysAgo(3), seen: [...staleIds, 80],
      rules: { 'V6串行推进': { counted: [80], pending: staleIds, input: 1, output: 1, cost: 1, costReported: true, rounds: 1, missingCostRounds: 0 } },
    }));
    store.runs = [finished(80, 'V6串行推进', { input: 1, output: 1, cost: 1 }), ...staleIds.map(id => open(id, 'V6串行推进'))];
    const usage = await chainUsageOf();
    const ledger = readLedgerFile(root);
    assert.equal(ledger.rules['V6串行推进'].unsettled.length, 2, '在册上限内保留');
    assert.equal(ledger.rules['V6串行推进'].unresolved, 3, '溢出的 3 个转成如实计数');
    assert.equal(usage.unresolvedRounds, 3);
    assert.equal(usage.cost, 1, '溢出轮次未完成前不计费，也不冒充已计');
  } finally { delete process.env.CHAIN_USAGE_UNSETTLED_MAX; await close(server); await close(hub.server); }
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
    const firstResponse = await fetch(`${url}/api/serial-progress`);
    assert.equal(firstResponse.status, 200, '中台抖动不能把项目进度面板打成 502');
    const firstBody = await firstResponse.json();
    assert.ok(firstBody.chains.length > 0, '链进度照常返回');
    const ledger = readLedgerFile(root);
    assert.equal(ledger.rules['V6串行推进'].cost, 2, '翻页失败前已扫页的进度必须落盘');
    assert.equal(ledger.backfillCursor, 2, '续翻断点必须落盘');
    const calls = hub.requests.length;
    failBefore = false;
    const second = await ofChain();
    assert.equal(hub.requests.length, calls, '退避期内不再发起任何中台请求');
    assert.equal(second.cost, 2, '退避期按已落盘台账重建，不丢弃断点进度');
    assert.equal(second.backfillPending, true, '尚未补全到底时保持如实标注');
    const third = await ofChain();
    assert.equal(third.cost, second.cost, '故障后的读数走台账，不回到今日窗口冒充');
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

test('双路由持续轮询不会把台账冻结在首扫那一刻（扫描调度与结果缓存分离）', async () => {
  const { store, hub, server, url } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    // 用真实热路径参数：TTL 200ms、前端两路由签名不同、按 app.mjs 的顺序持续轮询。
    // 生产比例：轮询间隔远小于 TTL（前端 2s / 默认 30s），才能暴露"本地重建续期扫描调度"
    // 造成的永久冻结。
    process.env.CHAIN_USAGE_TTL_MS = '250';
    store.runs = [finished(1, 'V6串行推进', { input: 1, output: 1, cost: 3 })];
    const poll = async () => {
      const [serial, usageBody] = await Promise.all([
        fetch(`${url}/api/serial-progress`).then(r => r.json()),
        fetch(`${url}/api/project-usage`).then(r => r.json()),
      ]);
      return { chain: serial.chains[0].cumulativeUsage?.cost, project: usageBody.projects.find(item => item.key === 'v6app')?.cumulative.cost };
    };
    assert.equal((await poll()).chain, 3);
    store.runs.push(finished(2, 'V6开发', { input: 1, output: 1, cost: 100 }));
    let seen = { chain: 3, project: 3 };
    for (let round = 0; round < 30; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 40));   // 间隔 40ms < TTL 250ms
      const value = await poll();
      seen = value;
      if (value.chain === 103) break;
    }
    assert.equal(seen.chain, 103, '新增轮次必须进入链累计（台账不得冻结）');
    assert.equal(seen.project, 103, '项目累计同步推进');
  } finally { delete process.env.CHAIN_USAGE_TTL_MS; await close(server); await close(hub.server); }
});

test('已到底的稳态轮询不闪现“历史补全中”，也不反复深翻', async () => {
  const { store, hub, server, chainUsageOf } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    store.runs = [finished(3, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(2, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(1, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(0, 'V6串行推进', { input: 1, output: 1, cost: 1 })];
    const first = await chainUsageOf();
    assert.equal(first.backfillPending, undefined, '首轮翻到底就不该标注补全中');
    const before = hub.requests.length;
    const second = await chainUsageOf();
    assert.equal(second.backfillPending, undefined, '稳态不得闪现已补全标记');
    assert.equal(second.cost, 4);
    assert.ok(hub.requests.length - before <= 2, `稳态每轮只打前沿一两页，实测 ${hub.requests.length - before}`);
  } finally { await close(server); await close(hub.server); }
});

test('真机规模截断：每一轮都必须比上一轮覆盖更多历史，直至补全到底（活锁回归）', async () => {
  PAGE = 2;                                  // 12 轮 = 6 页，预算只有 3 页：前沿已覆盖区远大于预算
  const maxPagesEnv = '3';
  const { store, hub, server, chainUsageOf, root } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    for (let id = 11; id >= 0; id -= 1) store.runs.push(finished(id, 'V6串行推进', { input: 1, output: 1, cost: 1 }));
    process.env.CHAIN_USAGE_MAX_PAGES = maxPagesEnv;
    let previousRounds = -1;
    let complete = false;
    const ledgerOf = () => readLedgerFile(root);
    for (let round = 0; round < 6 && !complete; round += 1) {
      const usage = await chainUsageOf();
      assert.ok(usage.rounds > previousRounds || usage.backfillPending === undefined, `第 ${round + 1} 轮没有推进覆盖：${previousRounds} → ${usage.rounds}`);
      assert.ok(usage.rounds > previousRounds, `第 ${round + 1} 轮必须比上一轮多覆盖（实测 ${previousRounds} → ${usage.rounds}）`);
      previousRounds = usage.rounds;
      complete = ledgerOf().complete === true;
      if (!complete) assert.equal(usage.backfillPending, true, '未补全期间必须一直如实标注');
    }
    assert.equal(complete, true, '多轮之后必须补全到底');
    assert.equal(previousRounds, 12);
    const final = await chainUsageOf();
    assert.equal(final.backfillPending, undefined);
    assert.equal(final.cost, 12);
  } finally {
    delete process.env.CHAIN_USAGE_MAX_PAGES;
    PAGE = 3;
    await close(server); await close(hub.server);
  }
});

test('坏数据 + 文件里写着已到底：必须降级并重扫补回缺口，不得静默漏计（P2-2 回归）', async () => {
  const { store, hub, server, chainUsageOf, root } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    PAGE = 20;   // 200 轮 = 10 页，一次预算内能全扫
    const all = [];
    for (let id = 199; id >= 0; id -= 1) all.push(finished(id, 'V6串行推进', { input: 1, output: 1, cost: 1 }));
    store.runs = all;
    // 台账声称已到底，但 counted 是坏数据（无法解析），seen 覆盖全部 200 个 id。
    writeFileSync(path.join(root, 'chain-usage.json'), JSON.stringify({
      version: 2, complete: true, updatedAt: isoToday(),
      seen: all.map(run => run.id),
      rules: { 'V6串行推进': { counted: '坏数据', pending: [], input: 0, output: 0, cost: 0, costReported: false, rounds: 0, missingCostRounds: 0 } },
    }));
    const usage = await chainUsageOf();
    assert.equal(usage.rounds, 200, '坏 entry 触发回填后必须把 200 轮全部补回');
    assert.equal(usage.cost, 200);
    assert.equal(usage.backfillPending, undefined, '补回到底后不再标注补全中');
    assert.equal(readLedgerFile(root).complete, true);
  } finally { PAGE = 3; await close(server); await close(hub.server); }
});

test('稳态零写入：本轮没有新入账就不重抄台账（写放大回归）', async () => {
  const { store, hub, server, chainUsageOf, root } = await setup([['v6-serial.json', '/p/v6app']]);
  try {
    store.runs = [finished(2, 'V6串行推进', { input: 1, output: 1, cost: 1 }), finished(1, 'V6串行推进', { input: 1, output: 1, cost: 1 })];
    assert.equal((await chainUsageOf()).cost, 2);
    const mtimeBefore = statSync(path.join(root, 'chain-usage.json')).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await chainUsageOf()).cost, 2, '读数仍然正确');
    const mtimeAfter = statSync(path.join(root, 'chain-usage.json')).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, '无变化的稳态扫描不得重写台账文件');
    store.runs.push(finished(3, 'V6开发', { input: 1, output: 1, cost: 5 }));
    assert.equal((await chainUsageOf()).cost, 7, '有新入账时必须落盘');
    assert.ok(statSync(path.join(root, 'chain-usage.json')).mtimeMs > mtimeAfter);
  } finally { await close(server); await close(hub.server); }
});

test('如实标注在任何用量分支都要带上，包括既无费用又无 Token 的分支（P3-1 回归）', async () => {
  const { projectUsageText } = await import('../public/status-sections.mjs');
  const bare = { cost: null, input: 0, output: 0, tokens: 0, reported: false, missingCostRounds: 3, unresolvedRounds: 1, backfillPending: true };
  const text = projectUsageText('项目累计', bare);
  assert.match(text, /暂无用量/);
  assert.match(text, /历史补全中/, '未上报分支也要交代补全状态');
  assert.match(text, /3 轮未上报费用/);
  assert.match(text, /1 轮长期未完成未计入/);
  const reported = { cost: 1.5, input: 10, output: 5, tokens: 15, reported: true, missingCostRounds: 2, unresolvedRounds: 0, backfillPending: false };
  assert.match(projectUsageText('项目累计', reported), /2 轮未上报费用/);
  assert.equal(projectUsageText('项目今日', { cost: 0.5, input: 1, output: 1, tokens: 2, reported: true, missingCostRounds: 0, unresolvedRounds: 0 }), '项目今日 · 费用 $0.50 · Token 2（入 1 / 出 1）', '没有备注时不得拖尾巴');
});
