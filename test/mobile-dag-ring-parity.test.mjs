// fix6 project-ring-web-parity（2026-11-26 主人定，卡片 167）：移动端总览「项目任务进度」必须与网页版
// 同内容同形式（只允许窄屏布局差异）。基准 = 网页版真实渲染（docs/design/2026-11-26-nomoto-fix6-baseline/refs/web-ring-baseline.png）。
// 本文件用同一份 /api/serial-progress + dag-runs + archive 数据，分别喂给网页版渲染函数（public/）与移动端
// （mobile/），对比节点数、扇区标签、中心百分比、节点详情字段、费用汇总条与已归档计数逐一相等。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, byClass, byAttr, textOf, walk } from './mobile-dag-ring-fake-dom.test.mjs';

installFakeDom();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webViews = await import('../public/views.mjs');
const webDag = await import('../public/dag-views.mjs');
const webArchive = await import('../public/archive-view.mjs');
const core = await import('../mobile/app/www/pages/core.mjs');
const ring = await import('../mobile/src/features/dag-ring/index.mjs');
const { buildOverview } = await import('../mobile/src/core/index.mjs');
const { mobileDagSummaries } = await import('../src/dag-service.mjs');

// ---------- 同一份种子数据（真实接口形态） ----------
const RULES = [
  { name: 'health串行推进', cwd: '/work/health-service-core' },
  { name: '控制台 · DAG 开发', cwd: '/work/console' },
];
const STATE = {
  runs: [
    { id: 41, rule: 'health串行推进', agent: 'claude', state: 'done', usage: { cost: 0.14, input: 57954, output: 726 }, events: [{ subject: 'patient-profile' }] },
  ],
  cards: [{ id: 7, state: 'open', project: '/work/console' }],
  lines: [
    { name: 'health串行推进', totals: { queued: 0, retrying: 0, doneToday: 0, usage: { cost: 27.39, input: 100, output: 20 } } },
    { name: '控制台 · DAG 开发', totals: { queued: 1, retrying: 1, doneToday: 3, usage: { cost: 4.5, input: 10, output: 5 } } },
  ],
};
const MODELS = { claude: 'claude-sonnet-5-5' };
const AGENTS = [{ id: 'claude', name: 'Claude Code', adapter: 'claude' }];
const PROJECT_USAGE = [
  { key: 'health-service-core', today: { reported: true, cost: 27.39, tokens: 120, input: 100, output: 20 }, cumulative: { reported: true, cost: 27.39, tokens: 199000000, input: 190000000, output: 9000000 } },
];
const CHAIN = {
  sourceFile: 'health-serial.json', project: '/work/health-service-core', percent: 78, createdAt: '2026-11-16T06:00:00Z',
  updatedAt: '2026-11-26T00:00:00Z',
  order: ['mem', 'cron', 'env', 'patient-profile', 'tenant'],
  current: { id: 'patient-profile' },
  nodes: [
    { id: 'mem', title: '内存采样', status: 'in_progress', percent: 2, summary: '需满 14 天才能出结论' },
    { id: 'cron', title: 'cron 循环', status: 'done', percent: 100 },
    { id: 'env', title: '环境变量', status: 'done', percent: 100 },
    { id: 'patient-profile', title: '病人档案聚合接口', status: 'in_progress', percent: 64, summary: '联调中，为租户端前置依赖' },
    { id: 'tenant', title: '租户端', status: 'pending', percent: 0 },
  ],
  cumulativeUsage: { tokens: 199000000, cost: 27.39 },
};
const DAG_RUN = {
  runId: 'dagrun-fix6', nodeId: '__root__', project: '/work/console', planId: 'nomoto-fix6', status: 'running',
  createdAt: '2026-11-26T00:20:00Z',
  authorizationSnapshot: { schema: 2, planDigest: 'a'.repeat(64), allowedActions: ['worktree'] },
  nodes: [
    { id: 'design', title: '设计稿', depends_on: [], contract: { output: '网页版同款环设计稿' } },
    { id: 'project-ring-web-parity', title: '项目进度环对齐网页版', depends_on: ['design'] },
    { id: 'app-refresh', title: '下拉刷新', depends_on: ['design'] },
    { id: 'integration-review', title: '集成审阅', depends_on: ['project-ring-web-parity', 'app-refresh'] },
  ],
  publish: { nodes: {
    design: { state: 'accepted', slot: 1, branch: 'feat/design', mergeCommit: 'abc' },
    'project-ring-web-parity': { state: 'dev', slot: 2, branch: 'feat/ring', model: 'claude-opus-5-5' },
    'app-refresh': { state: 'review', slot: 3, branch: 'feat/refresh' },
  } },
};
const NODE_RUNS = [
  { runId: 'n1', nodeId: 'design', project: '/work/console', planId: 'nomoto-fix6', role: 'dev', status: 'done', agent: 'Codex', usage: { cost: 1.2, input: 1000, output: 200 } },
  { runId: 'n2', nodeId: 'project-ring-web-parity', project: '/work/console', planId: 'nomoto-fix6', role: 'dev', status: 'claimed', slot: 2, agent: 'Claude Code', usage: { cost: 0.5, input: 50, output: 5 } },
];
const DONE_RUN = {
  ...DAG_RUN, runId: 'dagrun-old', planId: 'nomoto-fix5', status: 'done', createdAt: '2026-11-25T00:00:00Z',
  publish: { nodes: { design: { state: 'accepted' }, 'project-ring-web-parity': { state: 'accepted' }, 'app-refresh': { state: 'accepted' }, 'integration-review': { state: 'accepted' } } },
};
const ARCHIVE = [
  { taskId: 'dag:/work/console:nomoto-fix5', kind: 'dag', source: 'nomoto-fix5', runId: 'dagrun-old', project: '/work/console', title: 'NoMoTo fix5', percent: 100, nodes: { done: 4, total: 4 }, reason: 'completed', archivedAt: '2026-11-25', createdAt: '2026-11-25T00:00:00Z', archivedTime: '2026-11-25T09:00:00Z', usage: { cost: 3.2, tokens: 1500, input: 1200, output: 300 } },
  { taskId: 'serial:/work/health-service-core:v5', kind: 'serial', source: 'v5', project: '/work/health-service-core', title: 'v5', percent: 40, nodes: { done: 2, total: 5 }, reason: 'abandoned', archivedAt: '2026-11-20', createdAt: null, archivedTime: null, usage: null },
  { taskId: 'serial:/work/health-service-core:v4', kind: 'serial', source: 'v4', project: '/work/health-service-core', title: 'v4', percent: 100, nodes: { done: 3, total: 3 }, reason: 'completed', archivedAt: '2026-11-18', createdAt: '2026-11-01T00:00:00Z', archivedTime: '2026-11-18T10:00:00Z', usage: { tokens: 500, input: 400, output: 100 } },
];

const withSummary = run => ({ ...run, mobileSummary: mobileDagSummaries([run], NODE_RUNS.filter(r => r.planId === run.planId))[0] });
function mobileSnapshot(over = {}) {
  return {
    available: { state: true, rules: true, projects: true, 'dag-runs': true, 'serial-progress': true, archive: true, 'project-usage': true },
    errors: {},
    state: STATE,
    rules: { rules: RULES, models: MODELS, agents: AGENTS, mobileRules: [] },
    projects: [],
    dagRuns: [withSummary(DAG_RUN), withSummary(DONE_RUN)],
    serial: { chains: [CHAIN] },
    archive: ARCHIVE,
    projectUsage: { projects: PROJECT_USAGE },
    ...over,
  };
}

// ---------- 网页版渲染（真实 public/ 代码）与移动端渲染的公共提取 ----------
const webContext = { rules: RULES, snapshot: { ...STATE, models: MODELS }, projectUsage: PROJECT_USAGE, usageLoadError: false };
function webSerialRow() {
  return webViews.renderProjectProgress({
    chains: [CHAIN], rules: RULES, snapshot: { ...STATE, models: MODELS }, projectUsage: PROJECT_USAGE,
    agentNames: { claude: 'Claude Code' }, agentAdapters: { claude: 'claude' },
  })[0];
}
const webDagCard = () => webDag.renderDagOverview([{ run: DAG_RUN, nodeRuns: NODE_RUNS }], webContext)[0];
const progress = () => ring.buildProjectProgress(mobileSnapshot());
const mobileCard = (kind, opts = {}) => {
  const card = progress().cards.find(c => c.kind === kind);
  return { card, el: core.buildProjectRingCard(card, { defaultId: card.defaultId, ...opts }) };
};

const ringFacts = el => ({
  segments: byClass(el, 'ring-seg').map(s => s.attrs['data-ring-node'] ?? s.dataset?.ringNode),
  labels: byClass(el, 'ring-label').map(textOf),
  colors: byClass(el, 'ring-seg').map(s => s.attrs.stroke),
  pointers: byClass(el, 'ring-pointer').length,
  selected: byClass(el, 'ring-seg').filter(s => String(s.attrs.class).includes('selected')).map(s => s.attrs['data-ring-node'] ?? s.dataset?.ringNode),
});
const webPercent = el => textOf(byClass(el, 'overview-ring-center')[0]);
const mobilePercent = el => byClass(el, 'pring-percent').map(textOf).join('') + byClass(el, 'pring-sub').filter(n => n.tag === 'text').map(textOf).join('');
const webDetail = el => Object.fromEntries(byClass(byClass(el, 'overview-node')[0], 'node-field').map(row => [textOf(byClass(row, 'node-field-label')[0]), textOf(byClass(row, 'node-field-value')[0])]));
const mobileDetail = el => Object.fromEntries(byClass(el, 'pring-fact').map(row => [textOf(byClass(row, 'pring-fact-label')[0]), textOf(byClass(row, 'pring-fact-value')[0])]));
const webChips = el => byClass(el, 'chip').map(textOf);
const mobileChips = el => byClass(el, 'pring-chip').map(textOf);
// fix10 / issue #356：移动端串行链改为统一 hsl 波次配色（wave=null → 色相 168 绿系），
// 网页版仍是同色系的十六进制色板；两者「绿系一致」而非逐字相等，故按色相家族比对。
const colorHue = value => {
  const hsl = /^hsl\((\d+),/.exec(String(value));
  if (hsl) return Number(hsl[1]);
  const hex = /^#([0-9a-f]{6})$/i.exec(String(value));
  if (!hex) return NaN;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h = max === r ? ((b - g) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
};

test('串行链：节点数/扇区标签/配色/中心百分比与网页版逐一相等', () => {
  const web = webSerialRow();
  const { el } = mobileCard('serial');
  const w = ringFacts(web); const m = ringFacts(el);
  // 网页 seg 用 dataset.ringNode；fake DOM 下 dataset 是普通对象。
  w.segments = byClass(web, 'ring-seg').map(s => s.dataset.ringNode);
  w.selected = byClass(web, 'ring-seg').filter(s => String(s.attrs.class).includes('selected')).map(s => s.dataset.ringNode);
  assert.deepEqual(m.segments, w.segments, '扇区 = 节点，顺序一致');
  assert.equal(m.segments.length, 5);
  assert.deepEqual(m.labels, w.labels, '弧排节点标签（同弧长截断）逐字相等');
  assert.equal(m.colors.length, w.colors.length, '扇区数一致');
  assert.ok(m.colors.every(c => colorHue(c) === 168), '移动端串行链统一 wave=null → 色相 168 绿系');
  assert.ok(w.colors.every(c => colorHue(c) >= 150 && colorHue(c) <= 175), '网页版串行链同为绿系色相家族');
  const lightness = c => Number(/^hsl\(\d+, 52%, (\d+)%\)$/.exec(c)[1]);
  assert.ok(lightness(m.colors[1]) < lightness(m.colors[m.colors.length - 1]), '移动端完成度驱动明度：已完成节点（cron）比待开始节点（tenant）更深');
  assert.equal(m.pointers, w.pointers, '进行中节点内圈三角指针数量相等');
  assert.deepEqual(m.selected, w.selected, '默认选中当前节点，与网页一致');
  assert.equal(mobilePercent(el), webPercent(web), '中心总进度% 与节点数相等');
  assert.equal(mobilePercent(el), '78%总进度 · 5 个节点');
});

test('串行链：节点详情字段与网页一致（标题/状态/节点内进度/任务摘要/执行 Agent/模型/费用 Token）', () => {
  const web = webSerialRow();
  const { el } = mobileCard('serial');
  const w = webDetail(web); const m = mobileDetail(el);
  for (const key of Object.keys(w)) assert.equal(m[key], w[key], `字段「${key}」与网页相等`);
  for (const key of ['状态', '节点内进度', '任务摘要', '执行 Agent', '模型', '费用 Token']) assert.ok(key in m, `移动端详情含「${key}」`);
  assert.equal(m['执行 Agent'], 'Claude Code');
  assert.equal(m['费用 Token'], '最近一轮 · 费用 $0.14 · Token 58,680（入 57,954 / 出 726）');
  const webTitle = textOf(byClass(web, 'overview-node-head')[0]);
  assert.equal(textOf(byClass(el, 'pring-node-head')[0]), webTitle, '详情标题 + 状态徽标一致');
  assert.ok(walk(el).some(n => n.textContent === '查看运行详情 →'), '详情带「查看运行详情」入口');
});

test('串行链：费用汇总条（等待重试/今日完成/待处理/今日费用/链累计/创建于 + 项目今日/累计）与网页同口径', () => {
  assert.deepEqual(mobileChips(mobileCard('serial').el), webChips(webSerialRow()));
  const chips = mobileChips(mobileCard('serial').el);
  assert.ok(chips.includes('今日费用 $27.39'));
  assert.ok(chips.includes('链累计 · 199,000,000 Token · $27.39'));
  assert.ok(chips.some(chip => chip.startsWith('创建于 2026/11/16')));
});

test('并行 DAG：扇区/标签/百分比/副标题/用量与网页 renderDagOverview 相等', () => {
  const web = webDagCard();
  const { el, card } = mobileCard('dag');
  const w = ringFacts(web); const m = ringFacts(el);
  w.segments = byClass(web, 'ring-seg').map(s => s.dataset.ringNode);
  assert.deepEqual(m.segments, w.segments);
  assert.deepEqual(m.labels, w.labels);
  assert.deepEqual(m.colors, w.colors, '颜色 = 波次 · 深浅 = 完成度');
  assert.equal(m.pointers, w.pointers);
  assert.equal(mobilePercent(el), webPercent(web));
  assert.equal(card.subtitle, textOf(byClass(web, 'subtle')[0]));
  assert.equal(card.usageText, textOf(byClass(web, 'dag-usage')[0]));
  assert.equal(card.capacityNote, textOf(byClass(web, 'capacity-note')[0]));
  assert.deepEqual(mobileChips(el), webChips(web), '项目计数/今日费用/项目用量条相等');
});

test('并行 DAG：点扇区切换详情，字段与网页同一节点逐一相等；查看运行详情带 taskId/runId/nodeId', () => {
  const web = webDagCard();
  const target = 'app-refresh';
  // 网页：点扇区切换右侧详情。
  byClass(web, 'ring-seg').find(s => s.dataset.ringNode === target).click();
  const webAfter = byClass(web, 'overview-node')[0] ? web : null;
  assert.ok(webAfter);
  const picks = [];
  const { el: before } = mobileCard('dag', { onPick: id => picks.push(id) });
  byClass(before, 'ring-seg').find(s => s.attrs['data-ring-node'] === target).click();
  assert.deepEqual(picks, [target], '点扇区回调带节点 id');
  const jumps = [];
  const { el, card } = mobileCard('dag', { selectedId: target, onDagDetail: d => jumps.push(d) });
  assert.deepEqual(ringFacts(el).selected, [target], '选中扇区膨出');
  const w = webDetail(web); const m = mobileDetail(el);
  for (const key of Object.keys(w)) assert.equal(m[key], w[key], `字段「${key}」与网页相等`);
  assert.equal(m['节点内进度'], '完成度档 75%（未上报实测，按状态推导）', 'DAG 无实测节点内进度：如实标注为推导值');
  walk(el).find(n => n.textContent === '查看运行详情 →').click();
  assert.deepEqual(jumps, [{ taskId: card.taskId, runId: 'dagrun-fix6', nodeId: target }]);
});

test('已归档的任务环：计数/摘要与网页 archive-view 一致，展开后每个任务同款环', () => {
  const archived = progress().archived;
  assert.equal(archived.title, '已归档的任务环');
  assert.equal(archived.count, ARCHIVE.length);
  // 网页摘要行：全部完成 X · 已取消 Y。
  const done = ARCHIVE.filter(item => item.reason === 'completed').length;
  assert.equal(archived.summary, `全部完成 ${done} · 已取消 ${ARCHIVE.length - done}`);
  const collapsed = core.buildArchivedRingSection(archived, { isOpen: false });
  assert.equal(byClass(collapsed, 'pring-archived-body')[0].hidden, true, '默认折叠');
  assert.equal(textOf(byAttr(collapsed, 'data-archived-summary')[0]), '全部完成 2 · 已取消 1');
  const opened = core.buildArchivedRingSection(archived, { isOpen: true });
  const rows = byAttr(opened, 'data-archived-ring');
  assert.equal(rows.length, 3);
  for (const row of rows) assert.ok(byClass(row, 'ring-seg').length > 0, '每个归档任务都画环（同款扇区）');
  const dagRow = rows.find(r => r.attrs['data-archived-ring'].includes('nomoto-fix5'));
  assert.deepEqual(byClass(dagRow, 'ring-label').map(textOf).length, 4, '有运行记录的归档 DAG 用真实节点');
  assert.equal(textOf(byAttr(dagRow, 'data-archive-usage')[0]), `链计费 · ${webArchive.archiveUsageText(ARCHIVE[0].usage)}`, '链计费与网页同口径');
  const serialRow = rows.find(r => r.attrs['data-archived-ring'].includes(':v5'));
  assert.equal(byClass(serialRow, 'ring-seg').length, 5, '无节点明细的归档链按总数照常画环');
  assert.ok(walk(serialRow).some(n => /未保留节点明细/.test(n.textContent)), '缺失如实标注');
  assert.equal(textOf(byAttr(serialRow, 'data-archive-usage')[0]), '链计费 · 用量未上报');
});

test('总览视图模型带 projectProgress：活跃串行链 + 活跃 DAG 同面板，已完成 DAG 不进活跃卡', () => {
  const page = buildOverview(mobileSnapshot(), { now: new Date('2026-11-26T10:00:00+08:00') });
  const kinds = page.projectProgress.cards.map(card => `${card.kind}:${card.runId}`);
  assert.deepEqual(kinds, ['serial:health-serial.json', 'dag:dagrun-fix6']);
});

test('空态与数据缺失：无活跃项目如实空态；接口缺失给原因；扇区数据缺失照常渲染环', () => {
  const none = ring.buildProjectProgress(mobileSnapshot({ serial: { chains: [] }, dagRuns: [] }));
  assert.equal(none.empty, true);
  assert.match(none.reason, /暂无活跃项目/);
  const broken = ring.buildProjectProgress(mobileSnapshot({
    available: { state: true, rules: true, 'dag-runs': false, 'serial-progress': false, archive: false },
    errors: { 'dag-runs': 'HTTP 502', 'serial-progress': 'HTTP 502', archive: '归档读取失败' }, serial: null, dagRuns: null,
  }));
  assert.match(broken.reason, /HTTP 502/);
  assert.match(broken.archived.error, /归档读取失败/);
  assert.equal(broken.archived.hidden, false, '归档读取失败要显示可重试提示');
  const section = core.buildArchivedRingSection(broken.archived, { onRetry: () => {} });
  assert.equal(byAttr(section, 'data-archive-retry').length, 1);
  // 节点缺 agent/model/usage：照常渲染扇区，详情如实写未上报。
  const sparse = { ...CHAIN, nodes: [{ id: 'x', status: 'in_progress' }], order: ['x'], current: null, cumulativeUsage: null };
  const card = ring.buildProjectProgress(mobileSnapshot({ serial: { chains: [sparse] }, dagRuns: [], state: { runs: [], cards: [], lines: [] } })).cards[0];
  const el = core.buildProjectRingCard(card, { defaultId: card.defaultId });
  assert.equal(byClass(el, 'ring-seg').length, 1);
  const facts = mobileDetail(el);
  assert.equal(facts['执行 Agent'], '未上报');
  assert.equal(facts['费用 Token'], '费用未上报 · Token 未上报');
  assert.ok(mobileChips(el).includes('链累计 · 暂无用量'));
});

test('节点详情渲染失败就地重试，不拖垮整张卡', () => {
  const { card } = mobileCard('serial');
  let calls = 0;
  const flaky = { ...card.nodes[0], get summary() { calls += 1; if (calls === 1) throw new Error('临时失败'); return '恢复后的摘要'; } };
  const panel = core.buildRingNodePanel(flaky, card, {});
  const retry = byAttr(panel, 'data-ring-detail-retry')[0];
  assert.ok(retry, '失败时出现重试按钮');
  assert.match(textOf(panel), /节点详情加载失败：临时失败/);
  retry.click();
  assert.equal(byAttr(panel, 'data-ring-detail-retry').length, 0);
  assert.match(textOf(panel), /恢复后的摘要/);
});

test('源码守门：环画法与网页同参数，标签截断不越扇区；无节点分隔线；不拼接 HTML', () => {
  const src = readFileSync(path.join(ROOT, 'mobile', 'app', 'www', 'pages', 'core.mjs'), 'utf8');
  const web = readFileSync(path.join(ROOT, 'public', 'progress-view.mjs'), 'utf8');
  for (const name of ['RING_SIZE', 'RING_RADIUS', 'RING_STROKE', 'RING_BULGE', 'RING_INNER_STROKE', 'RING_INNER_GAP']) {
    const value = re => (re.exec(web) || [])[1];
    const pattern = new RegExp(`const ${name} = (\\d+);`);
    assert.equal(value.call(null, pattern), (pattern.exec(src) || [])[1], `${name} 与网页一致`);
  }
  assert.doesNotMatch(src, /ring-divider/, '设计稿 v3：扇区光滑相接，不画节点分隔线');
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(src));
  const viewModel = readFileSync(path.join(ROOT, 'mobile', 'src', 'features', 'dag-ring', 'progress.mjs'), 'utf8')
    + readFileSync(path.join(ROOT, 'mobile', 'src', 'features', 'dag-ring', 'usage.mjs'), 'utf8');
  assert.ok(!/from\s+['"]node:/.test(viewModel), '视图模型可直接作为浏览器模块加载');
  assert.ok(!/\bdocument\.|\bwindow\./.test(viewModel.replace(/\/\/.*$/gm, '')));
});
