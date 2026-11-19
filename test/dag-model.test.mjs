import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDagNodes, groupWaves, donutModel, sumUsage, dagRunSummary, formatUsage, nodeStatus } from '../public/dag-model.mjs';

const plan = [
  { id: 'a', title: '账户', depends_on: [], contract: { output: '账户表', files: ['src/a.mjs'] } },
  { id: 'b', title: '计费', depends_on: ['a'], contract: { output: '计费规则', files: ['src/b.mjs'] } },
  { id: 'c', title: '审计', depends_on: ['a'], contract: { output: '审计日志', files: ['src/c.mjs'] } },
  { id: 'integration-review', title: '整合审查', depends_on: ['b', 'c'], contract: { output: '只读审查', files: [] } },
];
const detail = {
  run: { runId: 'r1', project: '/p/demo', status: 'claimed', nodes: plan, usage: { cost: 1.5, input: 100, output: 20 }, publish: { nodes: {
    a: { state: 'accepted', slot: 1, branch: 'feat/a', model: 'K3.1', mergeCommit: 'abc' },
    b: { state: 'dev', slot: 2, branch: 'feat/b', model: null },
    c: { state: 'blocked', slot: null, branch: 'feat/c', blockedReason: 'blocked_unknown' },
  } } },
  nodeRuns: [{ runId: 'n1', nodeId: 'a', role: 'dev', status: 'done', agent: 'Codex', usage: { cost: 0.5, input: 10, output: 5 }, prs: [{ prUrl: 'https://example.com/pr/1', state: 'merged' }] }, { runId: 'n2', nodeId: 'b', role: 'dev', status: 'claimed', slot: 2 }],
};

test('节点按依赖分波，整合审查固定在最后一波；状态来自服务端 publish.nodes', () => {
  const nodes = buildDagNodes(detail);
  assert.deepEqual(nodes.map(n => [n.id, n.wave, n.state]), [['a', 1, 'accepted'], ['b', 2, 'dev'], ['c', 2, 'blocked'], ['integration-review', 3, 'pending']]);
  assert.deepEqual(groupWaves(nodes).map(w => w.nodes.map(n => n.id)), [['a'], ['b', 'c'], ['integration-review']]);
});

test('Agent/模型如实：已上报才显示，缺失显示待派发/未上报，绝不编造', () => {
  const [a, b, c, review] = buildDagNodes(detail);
  assert.equal(a.agent, 'Codex'); assert.equal(a.model, 'K3.1');
  assert.equal(b.agent, '未上报'); assert.equal(b.model, '未上报');
  assert.equal(review.agent, '待派发'); assert.equal(review.model, '模型待选择');
  assert.equal(c.agent, '待派发');
  assert.match(c.summary, /阻塞/);
  assert.equal(a.prUrl, 'https://example.com/pr/1');
});

// 真实数据形状：发布器只把 PR 登记在根 run.prs（带 nodeId），各轮 nodeRuns[].prs 为空（2026-11-19 device-binding：详情一直显示「暂无 PR」）
test('节点 PR 取自根 run.prs：同节点最新一个 open/merged，被取代/已关闭的不算；根上没有才回退 nodeRuns', () => {
  const plan2 = [{ id: 'x', title: 'X', depends_on: [] }, { id: 'y', title: 'Y', depends_on: [] }, { id: 'z', title: 'Z', depends_on: [] }];
  const real = {
    run: { runId: 'r2', nodes: plan2, publish: { nodes: { x: { state: 'dev' }, y: { state: 'accepted' }, z: { state: 'dev' } } }, prs: [
      { prUrl: 'https://github.com/o/r/pull/121', nodeId: 'x', state: 'closed', supersededBy: 'https://github.com/o/r/pull/136' },
      { prUrl: 'https://github.com/o/r/pull/136', nodeId: 'x', state: 'open' },
      { prUrl: 'https://github.com/o/r/pull/140', nodeId: 'y', state: 'merged' },
      { prUrl: 'https://github.com/o/r/pull/150', nodeId: 'z', state: 'closed' },
    ] },
    nodeRuns: [{ runId: 'q1', nodeId: 'x', role: 'dev', status: 'done', prs: [] }, { runId: 'q2', nodeId: 'z', role: 'dev', status: 'done', prs: [] }],
  };
  const [x, y, z] = buildDagNodes(real);
  assert.equal(x.prUrl, 'https://github.com/o/r/pull/136', '被取代的 #121 不显示，显示仍开着的 #136');
  assert.equal(y.prUrl, 'https://github.com/o/r/pull/140', '已合并的 PR 照常显示');
  assert.equal(z.prUrl, '', '只有已关闭（未合并）的 PR 时如实显示无 PR');
  // 根 run 上没有登记时，沿用旧数据源 nodeRuns[].prs（旧记录兼容）
  assert.equal(buildDagNodes(detail)[0].prUrl, 'https://example.com/pr/1');
});

test('分段环：每节点一段，百分比计入节点内完成度（accepted=100%/review=75%/dev=50%/blocked=20%/pending=0），颜色=波次色相+完成度深浅', () => {
  const model = donutModel(buildDagNodes(detail));
  // a=accepted(1)、b=dev(0.5)、c=blocked(0.2)、ir=pending(0) → (1+0.5+0.2+0)/4 = 42.5% → 43%
  assert.equal(model.segments, 4); assert.equal(model.percent, 43);
  assert.match(model.gradient, /^conic-gradient\(/);
  const stops = model.gradient.match(/hsl\([^)]+\)/g) || [];
  assert.equal(stops.length, 4, '每个节点一段');
  const parse = color => { const match = /hsl\((\d+), 52%, (\d+)%\)/.exec(color); return { hue: Number(match[1]), light: Number(match[2]) }; };
  const [a, b, c] = stops.map(parse); // a=已完成(第1波)、b=开发中(第2波)、c=阻塞(第2波)
  assert.equal(b.hue, c.hue, '同波次共用一个色相');
  assert.notEqual(a.hue, b.hue, '不同波次不同色相');
  assert.equal(a.light, 27, '全深 = 该节点已完成');
  assert.ok(a.light < b.light && b.light < c.light, '完成度越低颜色越浅');
  assert.equal(donutModel([]).segments, 0);
});

test('总进度计入节点内完成度：审阅中节点不再显示 0%，与串行链节点内 percent 语义一致', () => {
  // 复现 2026-11-19 问题：13 节点只有 1 个在审阅中，旧口径显示 0%
  const inReview = {
    run: { runId: 'r3', nodes: Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, depends_on: [] })),
      publish: { nodes: { n0: { state: 'review' } } } },
    nodeRuns: [],
  };
  const model = donutModel(buildDagNodes(inReview));
  assert.equal(model.percent, 6, '(0.75)/13 ≈ 5.8% → 6%，不再显示 0%');
  const oneDone = { run: { runId: 'r4', nodes: [{ id: 'a' }, { id: 'b' }], publish: { nodes: { a: { state: 'accepted' }, b: { state: 'review' } } } }, nodeRuns: [] };
  assert.equal(donutModel(buildDagNodes(oneDone)).percent, 88, '(1+0.75)/2 = 87.5% → 88%');
});

test('用量汇总：没有上报就写未上报，不输出 0 冒充', () => {
  assert.deepEqual(sumUsage([{ usage: { cost: 1, input: 3, output: 4 } }, { usage: { cost: 0.5, input: 1, output: 1 } }, {}]), { cost: 1.5, input: 4, output: 5, tokens: 9, reported: true });
  assert.equal(sumUsage([{}, {}]).reported, false);
  assert.equal(formatUsage(sumUsage([{}])), '费用未上报 · Token 未上报');
  assert.equal(formatUsage(sumUsage([{ usage: { cost: 1.5, input: 100, output: 20 } }])), '费用 $1.50 · Token 120（入 100 / 出 20）');
  assert.equal(formatUsage(sumUsage([{ usage: { input: 2, output: 1 } }])), '费用未上报 · Token 3（入 2 / 出 1）');
});

test('用量终态不上报：节点轮次标 usageUnreportable 时如实写「该执行者不上报用量」', () => {
  assert.equal(formatUsage({ ...sumUsage([{}]), unreportable: true }), '该执行者不上报用量');
  // 有轮次报过用量时不标（unreportable=false 或混合轮次仍显示已报部分）
  const nodes = buildDagNodes({
    run: { runId: 'r', nodes: [{ id: 'n1' }], publish: { nodes: { n1: { state: 'dev' } } } },
    nodeRuns: [{ runId: 'a', nodeId: 'n1', agent: 'workbuddy', model: 'hy4', usageUnreportable: true }],
  });
  assert.equal(formatUsage(nodes[0].usage), '该执行者不上报用量');
  const mixed = buildDagNodes({
    run: { runId: 'r', nodes: [{ id: 'n1' }], publish: { nodes: { n1: { state: 'dev' } } } },
    nodeRuns: [
      { runId: 'a', nodeId: 'n1', agent: 'workbuddy', usageUnreportable: true },
      { runId: 'b', nodeId: 'n1', agent: 'workbuddy', usage: { input: 10, output: 2 } },
    ],
  });
  assert.equal(formatUsage(mixed[0].usage), '费用未上报 · Token 12（入 10 / 出 2）');
});

test('不需要模型：节点轮次标 usageNoModel 时写「不需要模型」', () => {
  assert.equal(formatUsage({ ...sumUsage([{}]), noModel: true }), '不需要模型');
  const nodes = buildDagNodes({
    run: { runId: 'r', nodes: [{ id: 'n1' }], publish: { nodes: { n1: { state: 'dev' } } } },
    nodeRuns: [{ runId: 'a', nodeId: 'n1', agent: 'remote-watch', usageNoModel: true }],
  });
  assert.equal(formatUsage(nodes[0].usage), '不需要模型');
  // unreportable 与 noModel 同时存在时优先写不上报（跑模型但读不到的语义更具体）
  const both = buildDagNodes({
    run: { runId: 'r', nodes: [{ id: 'n1' }], publish: { nodes: { n1: { state: 'dev' } } } },
    nodeRuns: [
      { runId: 'a', nodeId: 'n1', agent: 'remote-watch', usageNoModel: true },
      { runId: 'b', nodeId: 'n1', agent: 'workbuddy', usageUnreportable: true },
    ],
  });
  assert.equal(formatUsage(both[0].usage), '该执行者不上报用量');
});

test('运行摘要：波次、槽位占用、完成数、隔离槽位', () => {
  const nodes = buildDagNodes(detail);
  const summary = dagRunSummary(detail, nodes);
  assert.equal(summary.totalWaves, 3); assert.equal(summary.currentWave, 2);
  assert.equal(summary.doneCount, 1); assert.equal(summary.nodeCount, 4);
  assert.equal(summary.slotsUsed, 1);
  assert.equal(summary.quarantined.length, 0);
  const q = dagRunSummary({ ...detail, nodeRuns: [{ runId: 'n3', nodeId: 'c', slot: 5, quarantine: true, status: 'unknown' }] }, nodes);
  assert.deepEqual(q.quarantined.map(r => r.slot), [5]);
});

test('nodeStatus 未知状态不当成完成', () => {
  assert.equal(nodeStatus('weird').label, '未知状态');
  assert.equal(nodeStatus('accepted').kind, 'done');
});
