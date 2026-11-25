// 回归（节点 dag-render-serial-parallel，2026-11-25）：串行链与并行 DAG 两条总览渲染路径的
// 种子数据级验证——环形卡片扇区点选/膨出/详情跳转、视图模型到渲染的端到端、无环回退行。
import test from 'node:test';
import assert from 'node:assert/strict';

function makeNode(tag) {
  return {
    tag, className: '', textContent: '', hidden: false, attrs: {}, children: [], handlers: {},
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; if (k === 'class') this.className = String(v); },
    addEventListener(t, h) { (this.handlers[t] ||= []).push(h); },
    click() { for (const h of this.handlers.click || []) h(); },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    replaceChildren(...c) { this.children = c; },
  };
}
globalThis.document = { createElement: makeNode, createElementNS: (_ns, tag) => makeNode(tag) };
const { buildDagRingCard, buildChainDetail } = await import('../mobile/app/www/pages/core.mjs');
const { buildActiveDagCard, mobileDagSummaries } = await import('../mobile/src/features/dag-ring/index.mjs').then(async ring => ({
  buildActiveDagCard: ring.buildActiveDagCard,
  mobileDagSummaries: (await import('../src/dag-service.mjs')).mobileDagSummaries,
}));

const walk = (el, out = []) => { out.push(el); for (const c of el.children || []) walk(c, out); return out; };
const byAttr = (root, k) => walk(root).filter(el => el.attrs?.[k] !== undefined);

function seedCard() {
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
  return buildActiveDagCard({ ...run, mobileSummary: summary });
}

test('并行 DAG：每个节点一个可点扇区，点选回调带节点 id，再点同一扇区取消', () => {
  const card = seedCard();
  assert.ok(card);
  const picks = [];
  const wrap = buildDagRingCard({ projectLabel: '种子项目' }, card, { onSelect: id => picks.push(id) });
  const segs = byAttr(wrap, 'data-node-id');
  assert.deepEqual(segs.map(s => s.attrs['data-node-id']), card.nodes.map(n => n.id));
  segs[1].click();
  assert.deepEqual(picks, [card.nodes[1].id]);
  assert.equal(byAttr(wrap, 'data-node-card').length, 0, '未选中不显示节点卡');
});

test('并行 DAG：选中节点膨出并显示说明，查看详情回调带 taskId/runId/nodeId', () => {
  const card = seedCard();
  const target = card.nodes[1];
  const jumps = [];
  const unselected = buildDagRingCard({}, card, {});
  const selected = buildDagRingCard({}, card, { selectedId: target.id, onDetail: d => jumps.push(d) });
  const arc = el => byAttr(el, 'data-node-id').find(s => s.attrs['data-node-id'] === target.id).attrs.d;
  assert.notEqual(arc(selected), arc(unselected), '选中扇区外半径膨出');
  const nodeCard = byAttr(selected, 'data-node-card')[0];
  assert.equal(nodeCard.attrs['data-node-card'], target.id);
  assert.ok(walk(nodeCard).some(el => el.textContent === `${target.id} 节点说明`), '说明来自节点 summary');
  const detail = walk(nodeCard).find(el => el.textContent === '查看详情 →');
  detail.click();
  assert.deepEqual(jumps, [{ taskId: card.taskId, runId: 'dagrun-seed', nodeId: target.id }]);
});

test('并行 DAG：单节点整环仍有可点击扇区（359.999° 特判）', () => {
  const card = { ...seedCard(), nodes: [seedCard().nodes[0]], nodeCount: 1 };
  const wrap = buildDagRingCard({}, card, {});
  const segs = byAttr(wrap, 'data-node-id');
  assert.equal(segs.length, 1);
  assert.match(segs[0].attrs.d, /^M [\d.\-]+ [\d.\-]+ A/);
});

test('串行链：种子链经视图模型到渲染，入口稳定出现且点开见节点清单', async () => {
  const { assembleSnapshot, buildOverview } = await import('../mobile/src/core/index.mjs');
  const snap = assembleSnapshot({
    state: { cards: [], runs: [] },
    projects: { projects: [] },
    rules: { rules: [], agents: [], sources: [], models: {}, mobileRules: [] },
    'dag-runs': { runs: [] },
    'serial-progress': { chains: [
      { sourceFile: 'seed-serial.json', project: '/work/串行项目', percent: 40, current: 'n2', nodes: [
        { id: 'n1', title: '第一步', status: 'done', percent: 100 },
        { id: 'n2', title: '第二步', status: 'in_progress', percent: 20 },
      ] },
    ] },
  });
  const page = buildOverview(snap, { now: new Date('2026-11-25T12:00:00+08:00') });
  const item = page.projects.items.find(i => i.runId === 'seed-serial.json');
  assert.ok(item?.chainEntry && item.chainDetail, '串行链条目带详情入口');
  const { toggle, panel } = buildChainDetail(item);
  toggle.click();
  assert.deepEqual(byAttr(panel, 'data-chain-node').map(l => l.attrs['data-chain-node']), ['n1', 'n2']);
});
