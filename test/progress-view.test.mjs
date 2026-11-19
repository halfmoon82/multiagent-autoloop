import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSerialView, buildDagView, serialStatus, nodeInnerProgress } from '../public/progress-view.mjs';
import { waveHue } from '../public/dag-model.mjs';

const serialChain = {
  sourceFile: 'demo-serial.json', project: '/p/demo', percent: 50, updatedAt: '2026-11-17T00:00:00Z',
  order: ['n1', 'n2', 'n3'], current: { id: 'n2' },
  nodes: [
    { id: 'n1', title: '授权恢复', status: 'done', percent: 100, summary: '路径已验证', label: '一', weight: 1 },
    { id: 'n2', title: '上下文压缩', status: 'dev_dispatched', percent: 50, part: '联调', summary: '正在压缩上下文', label: '二', weight: 1, prUrl: 'https://example.com/pr/9' },
    { id: 'n3', title: '返工接力', status: 'blocked', percent: 20, summary: '', label: '三', weight: 1 },
  ],
};

const dagDetail = {
  run: { runId: 'r1', planId: 'plan-one', project: '/p/demo', status: 'claimed',
    nodes: [
      { id: 'a', title: '账户', depends_on: [], contract: { output: '账户表', files: ['src/a.mjs'] } },
      { id: 'b', title: '计费', depends_on: ['a'], contract: { output: '计费规则', files: ['src/b.mjs'] } },
      { id: 'c', title: '整合审查', depends_on: ['b'], integration_review: true, contract: { output: '只读审查', files: [] } },
    ],
    publish: { nodes: { a: { state: 'accepted', slot: 1 }, b: { state: 'dev', slot: 2 }, c: { state: 'pending' } } } },
  nodeRuns: [{ nodeId: 'a', status: 'done', agent: 'Codex', model: 'K3.1', usage: { cost: 0.5, input: 10, output: 5 } }],
};

test('串行链与 DAG 映射为同构视图模型：相同分组语言、相同四栏节点字段', () => {
  const s = buildSerialView(serialChain, '链累计 · 120 Token · $0.21');
  const d = buildDagView(dagDetail);
  for (const view of [s, d]) {
    assert.ok(['key', 'kind', 'title', 'percent', 'nodes', 'groups', 'metrics', 'usageText'].every(key => key in view), '同一组顶层字段');
    assert.ok(view.groups.every(g => 'label' in g && 'sublabel' in g && Array.isArray(g.nodes)), '分组同构');
    assert.ok(view.nodes.every(node => ['title', 'status', 'summary', 'agent', 'model', 'usageText', 'color'].every(key => key in node)), '节点四栏 + 分段色同构');
    assert.ok(view.detailFacts(view.nodes[0]).length >= 4 && view.detailContracts(view.nodes[0]).length >= 1, '详情事实与摘要同构');
  }
  assert.equal(s.nodes.length, 3); assert.equal(d.nodes.length, 3);
  assert.deepEqual(s.groups.map(g => g.label), ['已完成', '当前', '待开始']);
  assert.deepEqual(d.groups.map(g => g.label), ['第 1 波', '第 2 波', '第 3 波']);
});

test('四栏字段如实标注：串行无 Agent/模型/节点费用不编造，DAG 待派发也不编造', () => {
  const s = buildSerialView(serialChain, '链累计 · 120 Token · $0.21');
  assert.equal(s.nodes[0].agent, '未上报');
  assert.equal(s.nodes[1].summary, '正在压缩上下文');
  assert.equal(s.nodes[1].usageText, '费用未上报 · Token 未上报', '节点级费用无上报源时如实标注');
  const d = buildDagView(dagDetail);
  assert.equal(d.nodes[0].agent, 'Codex'); assert.equal(d.nodes[0].model, 'K3.1');
  assert.match(d.nodes[0].usageText, /费用 \$0\.50/);
  const pending = d.nodes[2];
  assert.equal(pending.agent, '待派发'); assert.equal(pending.model, '模型待选择');
  assert.equal(pending.usageText, '费用未上报 · Token 未上报');
});

test('分段环=每节点一段：串行百分比来自编排器，DAG 百分比来自 accepted 占比', () => {
  const s = buildSerialView(serialChain, '链累计 · 120 Token · $0.21');
  assert.equal(s.percent, 50);
  assert.equal(s.nodes.length, 3);
  assert.ok(s.nodes.every(node => /^#/.test(node.color)), '每个节点有分段色');
  assert.equal(s.segmentNote, '同一色相 · 深浅 = 状态');
  const serialColors = new Set(s.nodes.filter(n => n.status.kind !== 'blocked').map(n => n.color));
  assert.equal(serialColors.size, 2, '串行节点同色相不同深浅（done/active 两档，阻塞另色）');
  assert.notEqual(s.nodes[2].color, s.nodes[0].color, '阻塞节点用琥珀色，不只靠深浅区分');
  const d = buildDagView(dagDetail);
  assert.equal(d.percent, 33, '1/3 accepted 四舍五入');
  assert.equal(d.nodes.length, 3);
  assert.match(d.segmentNote, /波次/);
});

test('DAG 环：一个波次一个色相，同波次内深浅表达节点完成度', () => {
  const detail = {
    run: { runId: 'r2', planId: 'p2', project: '/p/demo', status: 'claimed',
      nodes: [
        { id: 'a', title: 'A', depends_on: [], contract: {} },
        { id: 'b', title: 'B', depends_on: ['a'], contract: {} },
        { id: 'c', title: 'C', depends_on: ['a'], contract: {} },
        { id: 'ir', title: '整合', depends_on: ['b', 'c'], integration_review: true, contract: {} },
      ],
      publish: { nodes: { a: { state: 'accepted' }, b: { state: 'dev' }, c: { state: 'pending' }, ir: { state: 'pending' } } } },
    nodeRuns: [],
  };
  const view = buildDagView(detail);
  const parse = color => { const match = /hsl\((\d+), 52%, (\d+)%\)/.exec(color); return match ? { hue: Number(match[1]), light: Number(match[2]) } : null; };
  const byId = id => parse(view.nodes.find(node => node.id === id).color);
  const a = byId('a'), b = byId('b'), c = byId('c');
  assert.ok(a && b && c, 'DAG 节点色是波次色相 + 完成度明度');
  assert.equal(b.hue, c.hue, '同一波次共用一个色相');
  assert.notEqual(a.hue, b.hue, '不同波次用不同色相');
  assert.ok(a.light < b.light && b.light < c.light, '已完成最深、开发中其次、未开始最浅');
  assert.equal(a.light, 27, '全深固定为完成档');
  const hues = new Set(Array.from({ length: 10 }, (_, index) => waveHue(index + 1)));
  assert.equal(hues.size, 10, '前 10 个波次色相互不相同');
});

test('节点内进度：自报 percent 优先，缺失回落到状态完成度档，越界被夹到 0..1', () => {
  const s = buildSerialView(serialChain, '');
  const byId = id => s.nodes.find(node => node.id === id);
  assert.equal(nodeInnerProgress(byId('n1')), 1, 'done 节点 percent=100 → 满弧');
  assert.equal(nodeInnerProgress(byId('n2')), 0.5, 'dev 节点自报 percent=50');
  assert.equal(nodeInnerProgress(byId('n3')), 0.2, '自报 percent=20 优先于 blocked 档');
  assert.equal(nodeInnerProgress({ percent: 30, status: { kind: 'done' } }), 1, 'done 状态永远满弧，过期 percent 不拖回');
  assert.equal(nodeInnerProgress({ status: { kind: 'active' } }), 0.5, '无 percent 回落到完成度档');
  assert.equal(nodeInnerProgress({ status: { kind: 'pending' } }), 0, '未开始为空弧');
  assert.equal(nodeInnerProgress({ percent: 140, status: { kind: 'active' } }), 1, 'percent 越界夹到 1');
  const d = buildDagView(dagDetail);
  const dagById = id => d.nodes.find(node => node.id === id);
  assert.equal(nodeInnerProgress(dagById('a')), 1, 'DAG accepted → 满弧');
  assert.equal(nodeInnerProgress(dagById('b')), 0.5, 'DAG dev → 状态档 0.5');
});

test('串行状态映射未知状态不崩、不当成完成', () => {
  assert.equal(serialStatus('weird').kind, 'unknown');
  assert.equal(serialStatus('').label, '未知状态');
  const view = buildSerialView({ ...serialChain, nodes: [{ ...serialChain.nodes[0], status: 'weird' }], order: ['n1'], current: null }, '');
  assert.equal(view.nodes[0].status.kind, 'unknown');
  assert.notEqual(view.nodes[0].color, '#157a65');
});

test('串行每个节点显示自己最近一轮的执行者与自报用量，正在跑的标本轮，查不到如实标注', () => {
  const s = buildSerialView(serialChain, '链累计 · 120 Token · $0.21', {
    n1: { agent: 'claude', model: 'opus', usage: { input: 10, output: 20, cost: 0.05 }, running: false },
    n2: { agent: 'workbuddy', model: '未配置', usage: null, running: true },
  });
  const byId = id => s.nodes.find(node => node.id === id);
  assert.equal(byId('n1').agent, 'claude'); assert.equal(byId('n1').model, 'opus');
  assert.match(byId('n1').usageText, /^最近一轮 · 费用 \$0\.05 · Token 30/);
  assert.equal(byId('n2').agent, 'workbuddy'); assert.equal(byId('n2').usageText, '本轮进行中 · 费用未上报 · Token 未上报');
  assert.equal(byId('n3').agent, '未上报'); assert.equal(byId('n3').model, '未上报'); assert.equal(byId('n3').usageText, '费用未上报 · Token 未上报');
  assert.equal(buildSerialView(serialChain, '').nodes.find(node => node.id === 'n2').model, '模型待选择', '当前节点无记录仍显示模型待选择');
});

test('串行节点：无用量分两类——跑模型的写不上报，不跑模型的写不需要', () => {
  const s = buildSerialView(serialChain, '链累计 · 0', {
    n1: { agent: 'workbuddy', model: 'hy4', usage: null, running: false, unreportable: true },
    n3: { agent: 'remote-watch', model: '—', usage: null, running: false, noModel: true },
  });
  const byId = id => s.nodes.find(node => node.id === id);
  assert.equal(byId('n1').usageText, '该执行者不上报用量');
  assert.equal(byId('n3').usageText, '不需要模型');
  assert.equal(byId('n2').usageText, '费用未上报 · Token 未上报', '无记录节点不受影响');
});

test('chainNodeExecutors：acp 标 unreportable、command 标 noModel，缺 adapters 不误标', async () => {
  const { chainNodeExecutors } = await import('../public/status-sections.mjs');
  const chain = { project: '/p', sourceFile: 'x-serial.json', order: ['n1', 'n2', 'n3', 'n4'], nodes: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }, { id: 'n4' }],
    nodeRounds: {
      n1: { id: 10, agent: 'workbuddy', state: 'done', usage: null },
      n2: { id: 11, agent: 'claude', state: 'done', usage: null },
      n3: { id: 12, agent: 'workbuddy', state: 'done', usage: { input: 4 } },
      n4: { id: 13, agent: 'remote-watch', state: 'done', usage: null },
    } };
  const adapters = { workbuddy: 'acp', claude: 'claude', 'remote-watch': 'command' };
  const out = chainNodeExecutors(chain, [], [], [], {}, {}, adapters);
  assert.equal(out.n1.unreportable, true); assert.equal(out.n1.noModel, undefined);
  assert.equal(out.n2.unreportable, undefined, 'claude 通道能上报，无用量仍是「未上报」');
  assert.equal(out.n3.unreportable, undefined, '报过用量不标');
  assert.equal(out.n4.noModel, true); assert.equal(out.n4.unreportable, undefined);
  const bare = chainNodeExecutors(chain, [], [], [], {}, {});
  assert.equal(bare.n1.unreportable, undefined); assert.equal(bare.n4.noModel, undefined);
});
