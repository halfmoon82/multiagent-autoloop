// 回归（节点 dag-render-serial-parallel，2026-11-25；fix6 project-ring-web-parity 2026-11-26 改写）：
// 串行链与并行 DAG 两条总览渲染路径的种子数据级验证——扇区点选/膨出/详情跳转、视图模型到渲染端到端。
// fix6 起两条路径共用同一个网页同款节点环（buildProjectRingCard）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, byAttr, byClass, walk } from './mobile-dag-ring-fake-dom.test.mjs';

installFakeDom();
const { buildProjectRingCard } = await import('../mobile/app/www/pages/core.mjs');
const { buildProjectProgress, buildDagRunRingView } = await import('../mobile/src/features/dag-ring/index.mjs');
const { mobileDagSummaries } = await import('../src/dag-service.mjs');

function seedRun() {
  const run = {
    runId: 'dagrun-seed', project: '/work/种子项目', planId: 'seed-plan', status: 'running',
    createdAt: '2026-11-25T09:00:00+08:00',
    authorizationSnapshot: { schema: 2, planDigest: 'f'.repeat(64), allowedActions: ['worktree'], digest: 'e'.repeat(64) },
    nodes: [
      { id: 'a', title: '甲', depends_on: [] },
      { id: 'b', title: '乙', depends_on: ['a'] },
      { id: 'c', title: '丙', depends_on: ['a'] },
    ],
    publish: { nodes: { a: { state: 'accepted', slot: 1 }, b: { state: 'dev', slot: 2 }, c: { state: 'queued', slot: null } } },
  };
  const nodeRuns = [
    { runId: 'n1', nodeId: 'a', project: run.project, planId: run.planId, role: 'dev', status: 'done', agent: 'Codex', usage: { cost: 1, input: 10, output: 5 } },
    { runId: 'n2', nodeId: 'b', project: run.project, planId: run.planId, role: 'dev', status: 'claimed', slot: 2, agent: 'K2', usage: { cost: 0.5, input: 5, output: 2 } },
  ];
  const summary = mobileDagSummaries([run], nodeRuns)[0];
  summary.ring.nodes = summary.ring.nodes.map(n => ({ ...n, summary: `${n.id} 节点说明` }));
  return { ...run, mobileSummary: summary };
}
const segs = el => byClass(el, 'ring-seg');
const segId = seg => seg.attrs['data-ring-node'];

test('并行 DAG：每个节点一个可点扇区，点选回调带节点 id', () => {
  const card = buildDagRunRingView(seedRun());
  const picks = [];
  const wrap = buildProjectRingCard(card, { onPick: id => picks.push(id) });
  assert.deepEqual(segs(wrap).map(segId), card.nodes.map(n => n.id));
  segs(wrap)[1].click();
  assert.deepEqual(picks, [card.nodes[1].id]);
});

test('并行 DAG：选中节点膨出并显示说明，查看运行详情回调带 taskId/runId/nodeId', () => {
  const card = buildDagRunRingView(seedRun());
  const target = card.nodes[0]; // 未选中时默认落到最后一个节点，目标取第一个
  const jumps = [];
  const unselected = buildProjectRingCard(card, {});
  const selected = buildProjectRingCard(card, { selectedId: target.id, onDagDetail: d => jumps.push(d) });
  const width = el => segs(el).find(s => segId(s) === target.id).attrs['stroke-width'];
  assert.ok(Number(width(selected)) > Number(width(unselected)), '选中扇区外沿膨出');
  const detail = byAttr(selected, 'data-ring-detail')[0];
  assert.equal(detail.attrs['data-ring-detail'], target.id);
  assert.ok(walk(detail).some(el => el.textContent === `${target.id} 节点说明`), '说明来自节点 summary');
  walk(detail).find(el => el.textContent === '查看运行详情 →').click();
  assert.deepEqual(jumps, [{ taskId: card.taskId, runId: 'dagrun-seed', nodeId: target.id }]);
});

test('并行 DAG：单节点整环仍有可点击扇区（整圈弧长）', () => {
  const run = seedRun();
  run.mobileSummary.ring.nodes = run.mobileSummary.ring.nodes.slice(0, 1);
  const card = buildDagRunRingView(run);
  const wrap = buildProjectRingCard(card, {});
  assert.equal(segs(wrap).length, 1);
  const seg = segs(wrap)[0];
  const [len, gap] = seg.attrs['stroke-dasharray'].split(' ').map(Number);
  assert.ok(Math.abs(len - 2 * Math.PI * Number(seg.attrs.r)) < 0.01 && gap < 0.01, '单节点占满整圈');
});

test('串行链：种子链经视图模型到渲染，扇区与节点一一对应，详情出现在环下方', () => {
  const progress = buildProjectProgress({
    available: { state: true, rules: true, 'dag-runs': true, 'serial-progress': true, archive: true },
    errors: {}, state: { cards: [], runs: [], lines: [] }, rules: { rules: [] }, dagRuns: [], archive: [],
    serial: { chains: [
      { sourceFile: 'seed-serial.json', project: '/work/串行项目', percent: 40, current: 'n2', nodes: [
        { id: 'n1', title: '第一步', status: 'done', percent: 100 },
        { id: 'n2', title: '第二步', status: 'in_progress', percent: 20 },
      ] },
    ] },
  });
  const card = progress.cards.find(c => c.runId === 'seed-serial.json');
  assert.ok(card, '串行链成环卡片');
  const wrap = buildProjectRingCard(card, { defaultId: card.defaultId });
  assert.deepEqual(segs(wrap).map(segId), ['n1', 'n2']);
  assert.equal(byAttr(wrap, 'data-ring-detail')[0].attrs['data-ring-detail'], 'n2', '默认详情 = 当前节点');
});
