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

test('分段环：每节点一段，百分比=accepted 占比，阻塞为琥珀色', () => {
  const model = donutModel(buildDagNodes(detail));
  assert.equal(model.segments, 4); assert.equal(model.percent, 25);
  assert.match(model.gradient, /^conic-gradient\(/);
  assert.ok(model.gradient.includes('#d59a37'));
  assert.equal(donutModel([]).segments, 0);
});

test('用量汇总：没有上报就写未上报，不输出 0 冒充', () => {
  assert.deepEqual(sumUsage([{ usage: { cost: 1, input: 3, output: 4 } }, { usage: { cost: 0.5, input: 1, output: 1 } }, {}]), { cost: 1.5, input: 4, output: 5, tokens: 9, reported: true });
  assert.equal(sumUsage([{}, {}]).reported, false);
  assert.equal(formatUsage(sumUsage([{}])), '费用未上报 · Token 未上报');
  assert.equal(formatUsage(sumUsage([{ usage: { cost: 1.5, input: 100, output: 20 } }])), '费用 $1.50 · Token 120（入 100 / 出 20）');
  assert.equal(formatUsage(sumUsage([{ usage: { input: 2, output: 1 } }])), '费用未上报 · Token 3（入 2 / 出 1）');
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
