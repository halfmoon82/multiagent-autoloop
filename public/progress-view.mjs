// #75 统一进度视图模型：串行链与 DAG 运行都先映射成同一个 view model，
// 再共用同一套「分段环形总进度 + 节点卡片 + 分组 + 运行详情」渲染。
// 波次（DAG）/ 执行顺序分段（串行）映射到同一分组语言；四栏节点卡片字段一律如实标注，缺失写未上报。
// 所有上游文本只经 textContent 写入（本模块自建 el，避免与 views.mjs 形成循环依赖）。
import { projectName } from './format.mjs';
import { buildDagNodes, groupWaves, dagRunSummary, formatUsage, sumUsage, segmentColor } from './dag-model.mjs';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function badge(text, kind = '') { return el('span', `status ${kind}`.trim(), text); }
const num = new Intl.NumberFormat('zh-CN');

// ---------- 统一视图模型 ----------
const SERIAL_STATUS = {
  done: { label: '已完成', kind: 'done', icon: '✓' },
  dev_dispatched: { label: '开发中', kind: 'active', icon: '●' },
  in_progress: { label: '进行中', kind: 'active', icon: '●' },
  in_review: { label: '审阅中', kind: 'review', icon: '◐' },
  review: { label: '审阅中', kind: 'review', icon: '◐' },
  rework: { label: '返工中', kind: 'rework', icon: '●' },
  external_in_progress: { label: '外部验证中', kind: 'active', icon: '●' },
  blocked: { label: '卡住', kind: 'blocked', icon: '!' },
  pending: { label: '未开始', kind: 'pending', icon: '○' },
};
export const serialStatus = state => SERIAL_STATUS[state] || { label: state ? String(state) : '未知状态', kind: 'unknown', icon: '?' };
// 串行链：全部节点同一色相，深浅表达状态；阻塞保留琥珀色且带图标，不只靠颜色。
const SERIAL_COLORS = { done: '#157a65', active: '#2f8d76', review: '#6fae9d', rework: '#c08a2e', blocked: '#d59a37', external: '#3f9b88', pending: '#cfdad6', unknown: '#cfdad6' };

const UNKNOWN_USAGE = '费用未上报 · Token 未上报';

// 串行链 → 统一视图模型。usageText 由调用方按整条链的真实 Hub 计费口径提供，不编造节点级费用。
export function buildSerialView(chain, usageText = UNKNOWN_USAGE) {
  const nodesRaw = (chain?.order || []).map(id => (chain.nodes || []).find(node => node.id === id)).filter(Boolean);
  const currentId = chain?.current?.id;
  const nodes = nodesRaw.map(node => {
    const status = serialStatus(node.status);
    const group = status.kind === 'done' ? '已完成' : node.id === currentId ? '当前' : '待开始';
    return {
      id: node.id, title: node.title || node.id, status, group, groupOrder: group === '已完成' ? 1 : group === '当前' ? 2 : 3,
      summary: node.summary || '暂无任务摘要：节点推进后由开发/审阅上报一句话进展。',
      // 串行状态文件不含执行 Agent/模型/节点费用，必须如实标注，不能编造。
      agent: '未上报', model: node.id === currentId ? '模型待选择' : '未上报', usageText: UNKNOWN_USAGE,
      part: node.part || '', percent: node.percent || 0, prUrl: node.prUrl || '', color: SERIAL_COLORS[status.kind] || SERIAL_COLORS.unknown,
      contract: {},
    };
  });
  const groups = ['已完成', '当前', '待开始'].map(label => {
    const list = nodes.filter(node => node.group === label);
    return { label, sublabel: label === '已完成' ? `前 ${list.length} 个节点` : label === '当前' ? (chain?.current ? `第 ${nodesRaw.indexOf(nodesRaw.find(n => n.id === currentId)) + 1} 个节点` : '暂无') : '等待上游完成', nodes: list };
  }).filter(group => group.nodes.length);
  const current = chain?.current ? nodes.find(node => node.id === chain.current.id) : null;
  return {
    key: `serial:${chain?.sourceFile || ''}`, kind: 'serial', id: chain?.sourceFile || '', project: chain?.project || '',
    title: projectName(chain?.project || ''), subtitle: `${nodes.length} 个节点 · 按执行顺序排列${current ? ` · 当前 ${current.title}` : ''}`,
    percent: Math.round(chain?.percent || 0), segmentNote: '同一色相 · 深浅 = 状态',
    legend: [{ label: '串行序列', color: SERIAL_COLORS.active }],
    nodes, groups, usageText,
    metrics: [['总进度', `${Math.round(chain?.percent || 0)}%`], ['节点', `${nodes.length} 个`], ['当前节点', current?.title || '—'], ['节点内', current ? `${current.percent}%` : '—'], ['状态', current?.status.label || '—']],
    detailFacts(node) {
      return [
        ['状态', `${node.status.label}${node.part ? ` · ${node.part}` : ''}`],
        ['节点内进度', `${node.percent}%`],
        ['执行 Agent', node.agent],
        ['模型', node.model],
        ['费用 / Token', node.usageText],
        ['证据', node.prUrl ? '查看 PR' : '暂无 PR', node.prUrl],
      ];
    },
    detailContracts(node) {
      const blocks = [{ title: '当前任务摘要', lines: [node.summary] }];
      if (node.part) blocks.push({ title: '当前部分', lines: [node.part] });
      return blocks;
    },
    extra: { current },
  };
}

// DAG 运行 → 统一视图模型（节点/波次/分段的底层计算复用 dag-model.mjs 纯函数）。
export function buildDagView(detail) {
  const nodesRaw = buildDagNodes(detail);
  const waves = groupWaves(nodesRaw);
  const sum = dagRunSummary(detail, nodesRaw);
  const nodes = nodesRaw.map(node => ({
    ...node, color: segmentColor(node), group: `第 ${node.wave} 波`, groupOrder: node.wave,
    summary: node.summary || '暂无任务摘要', usageText: formatUsage(node.usage),
  }));
  const groups = waves.map(wave => ({
    label: `第 ${wave.wave} 波`,
    sublabel: wave.nodes.every(node => node.status.kind === 'done') ? `${wave.nodes.length} 个已完成` : `${wave.nodes.filter(node => ['active', 'review'].includes(node.status.kind)).length} 路在途`,
    nodes: nodes.filter(node => node.wave === wave.wave),
  }));
  const done = nodesRaw.filter(node => node.status.kind === 'done').length;
  const colors = [1, 2, 3].map(wave => segmentColor({ wave, status: { kind: 'done' } }));
  return {
    key: `dag:${detail?.run?.runId || ''}`, kind: 'dag', id: detail?.run?.runId || '', runId: detail?.run?.runId || '', project: detail?.run?.project || '',
    title: projectName(detail?.run?.project || ''), subtitle: `${detail?.run?.planId || detail?.run?.runId || ''} · ${nodes.length} 个节点 · 第 ${sum.currentWave}/${sum.totalWaves} 波`,
    percent: nodes.length ? Math.round(done / nodes.length * 100) : 0, segmentNote: '颜色 = 波次 · 深浅 = 状态',
    legend: colors.map((color, index) => ({ label: `第 ${index + 1} 波`, color })),
    nodes, groups, usageText: `本次运行 · ${formatUsage(sum.usage)}`,
    metrics: [['当前波次', `${sum.currentWave} / ${sum.totalWaves}`], ['业务槽位', `${sum.slotsUsed} / 5`], ['已完成', `${sum.doneCount} / ${sum.nodeCount}`], ['换打法', `${(detail?.run?.publish?.approachChanges || []).length} 次`], ['隔离槽位', `${sum.quarantined.length} 个`]],
    detailFacts(node) {
      return [
        ['槽位', node.slot != null ? `dag-slot-${node.slot}` : '未占用'],
        ['分支', node.branch || '未创建'],
        ['执行 Agent', node.agent],
        ['模型', node.model],
        ['费用 / Token', node.usageText],
        ['证据', node.prUrl ? '查看 PR' : '暂无 PR', node.prUrl],
        ['合并提交', node.mergeCommit || '尚未合并'],
      ];
    },
    detailContracts(node) {
      const blocks = [{ title: '当前任务摘要', lines: [node.summary] }];
      const lines = [];
      for (const [key, label] of [['input', '输入'], ['output', '输出'], ['error_behavior', '异常行为'], ['acceptance_example', '验收示例']]) {
        if (node.contract?.[key]) lines.push(`${label}：${node.contract[key]}`);
      }
      lines.push(`文件范围：${(node.contract?.files || []).join('、') || '只读，无写入'}`);
      blocks.push({ title: '节点契约', lines });
      return blocks;
    },
    extra: { detail, sum },
  };
}

// ---------- 共用组件：分段环 / 四栏节点卡片 / 分组 / 视觉区 ----------
export function progressDonut(view, { label = '', cls = '' } = {}) {
  const nodes = view.nodes || [];
  const share = nodes.length ? 100 / nodes.length : 0;
  const stops = nodes.map((node, index) => `${node.color} ${(index * share).toFixed(3)}% ${((index + 1) * share).toFixed(3)}%`);
  const box = el('div', `dag-donut ${cls}`.trim());
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `${label}总进度 ${view.percent}%，${nodes.length} 个节点，逐节点分段`);
  box.dataset.segments = String(nodes.length);
  if (stops.length) box.style.backgroundImage = `conic-gradient(${stops.join(',')})`;
  const inner = el('div'); inner.append(el('strong', '', `${view.percent}%`), el('span', '', '总进度')); box.append(inner);
  return box;
}

// 四栏：任务摘要 / 执行 Agent / 模型 / 费用 Token；缺数据一律如实写未上报。
export function progressNodeCard(node, { cls = 'progress-node', selected = false, runId = '', key = 'serialNode', selectedRun = '' } = {}) {
  const button = el('button', `${cls} ${node.status.kind}${selected ? ' selected' : ''}`.trim());
  button.type = 'button';
  if (key === 'dagNode') { button.dataset.dagNode = node.id; button.dataset.dagRun = runId; }
  else { button.dataset.serialNode = node.id; button.dataset.serialRun = runId; }
  button.append(el('span', 'node-status-icon', node.status.icon));
  button.append(el('strong', '', node.title));
  button.append(el('small', '', `${node.status.label}${node.slot != null ? ` · 槽位 ${node.slot}` : ''}${node.part ? ` · ${node.part}` : ''}`));
  const fields = el('div', 'node-fields');
  const field = (label, value, valueClass) => {
    const row = el('div', 'node-field');
    row.append(el('span', 'node-field-label', label), el('span', `node-field-value ${valueClass}`.trim(), value));
    return row;
  };
  fields.append(
    field('任务摘要', node.summary, 'node-task-summary'),
    field('执行 Agent', node.agent, 'node-agent'),
    field('模型', node.model, 'node-model'),
    field('费用 Token', node.usageText, 'node-usage'),
  );
  button.append(fields);
  if (selectedRun) button.dataset.selectedRun = selectedRun;
  return button;
}

export function progressGroups(view, { cls = 'progress-node', key = 'serialNode', runId = '', selectedNode = '', selectedRun = '' } = {}) {
  const wrap = el('div', 'progress-waves');
  for (const group of view.groups || []) {
    const row = el('div', 'wave');
    const label = el('div', 'wave-label'); label.append(el('span', '', group.label), el('small', '', group.sublabel));
    const body = el('div', 'wave-nodes');
    for (const node of group.nodes) {
      body.append(progressNodeCard(node, { cls, key, runId, selected: selectedNode === node.id && selectedRun === (runId || view.id), selectedRun: runId || view.id }));
    }
    row.append(label, body); wrap.append(row);
  }
  return wrap;
}

export function progressVisual(view, { label = '', cls = 'progress-node', key = 'serialNode', runId = '', donutCls = '' } = {}) {
  const visual = el('div', 'dag-visual');
  const donutWrap = el('div', 'donut-wrap');
  donutWrap.append(progressDonut(view, { label, cls: donutCls }), el('small', 'subtle', view.segmentNote));
  if (view.legend?.length) {
    const legend = el('div', 'donut-legend');
    for (const item of view.legend) {
      const chip = el('span', '', '');
      const swatch = el('i', 'legend-swatch'); swatch.style.backgroundColor = item.color;
      chip.append(swatch, document.createTextNode(item.label)); legend.append(chip);
    }
    donutWrap.append(legend);
  }
  visual.append(donutWrap, progressGroups(view, { cls, key, runId }));
  return visual;
}

// ---------- 同构的运行详情：串行与 DAG 共用同一结构 ----------
function fact(label, value, link = '') {
  const row = el('div'); row.append(el('dt', '', label));
  const dd = el('dd');
  if (link && /^https:\/\//.test(String(link))) { const a = el('a', '', value); a.href = link; a.rel = 'noreferrer'; a.target = '_blank'; dd.append(a); }
  else dd.textContent = String(value ?? '');
  row.append(dd); return row;
}

function nodeDetailPanel(view, node) {
  const panel = el('section', 'panel node-detail'); panel.id = 'dag-node-detail';
  if (!node) { panel.append(el('div', 'empty', '点击左侧节点查看任务摘要、执行 Agent、模型、费用与证据。')); return panel; }
  const head = el('div', 'panel-heading');
  head.append(el('h3', '', node.title), badge(node.status.label, node.status.kind === 'done' ? 'good' : node.status.kind === 'blocked' ? 'warn' : ''));
  const dl = el('dl', 'fact-list');
  for (const [label, value, link] of view.detailFacts(node)) dl.append(fact(label, value, link));
  panel.append(head, dl);
  for (const block of view.detailContracts(node)) {
    const box = el('div', 'node-contract'); box.append(el('strong', '', block.title));
    for (const line of block.lines) box.append(el('p', '', line));
    panel.append(box);
  }
  return panel;
}

// 串行链运行详情：与 DAG 完全同构的结构，只是数据来自串行状态文件。
export function renderSerialDetail(chain, { selectedNode = '', usageText = '' } = {}) {
  return renderProgressDetail(buildSerialView(chain, usageText), { selectedNode });
}

// opts: { selectedNode, slotNote, active, cancelRequested, titleOverride, statusText, statusKind }
export function renderProgressDetail(view, opts = {}) {
  const { selectedNode = '', slotNote = {}, active = false, cancelRequested = false, titleOverride = '', statusText = '', statusKind = '', extraSide = null } = opts;
  const root = el('div', 'dag-detail');
  if (view.kind === 'dag') root.dataset.dagRun = view.id; else root.dataset.serialRun = view.id;

  const heading = el('div', 'page-heading compact-heading');
  const left = el('div'); const tl = el('div', 'title-with-badge');
  tl.append(el('h2', '', titleOverride || view.title), badge(statusText || (view.kind === 'dag' ? '并行 DAG' : '串行链'), statusKind || (view.kind === 'dag' && active ? 'good' : '')));
  left.append(tl, el('p', 'subtle', view.subtitle));
  const actions = el('div', 'heading-actions');
  if (view.kind === 'dag' && active && !cancelRequested) {
    const cancel = el('button', 'button danger-outline', '取消运行'); cancel.type = 'button'; cancel.dataset.dagCancel = view.id; actions.append(cancel);
  }
  heading.append(left, actions);

  const metrics = el('div', 'run-metrics');
  for (const [label, value] of view.metrics) { const cell = el('div'); cell.append(el('span', '', label), el('strong', '', value)); metrics.append(cell); }
  const usage = el('p', 'subtle dag-usage', `${view.usageText}（以实际上报为准，未上报不计为 0）`);

  const layout = el('div', 'dag-layout');
  const wavesPanel = el('section', 'panel waves-panel'); const wh = el('div', 'panel-heading');
  wh.append(el('div', '', view.kind === 'dag' ? '执行波次' : '节点序列'), el('span', 'subtle', view.kind === 'dag' ? '只有 PR 合并后，下游节点才会启动' : '按执行顺序排列 · 点击节点看详情'));
  wavesPanel.append(wh, progressGroups(view, { cls: 'dag-node', key: view.kind === 'dag' ? 'dagNode' : 'serialNode', runId: view.id, selectedNode, selectedRun: view.id }));
  const side = el('aside', 'dag-sidebar'); side.append(nodeDetailPanel(view, view.nodes.find(node => node.id === selectedNode)));

  if (view.kind === 'dag') {
    const quarantined = view.extra?.sum?.quarantined || [];
    const quarantine = el('section', 'panel side-card'); const qh = el('div', 'panel-heading');
    qh.append(el('h3', '', '隔离槽位'), badge(`${quarantined.length} 个`, quarantined.length ? 'warn' : '')); quarantine.append(qh);
    if (!quarantined.length) quarantine.append(el('p', 'side-copy', '没有隔离槽位。'));
    for (const item of quarantined) {
      quarantine.append(el('p', 'side-copy', `槽位 ${item.slot} · 节点 ${item.nodeId} · 失联，旧回执已作废，仍占 1 路名额。`));
      const label = el('label', 'confirm-check'); const box = el('input'); box.type = 'checkbox'; box.dataset.slotVerify = String(item.slot); label.append(box, el('span', '', '我已确认该槽位的进程组已退出'));
      const release = el('button', 'button secondary full', `释放槽位 ${item.slot}`); release.type = 'button'; release.dataset.slotRelease = String(item.slot); release.dataset.dagRun = view.id;
      quarantine.append(label, release);
      if (slotNote[item.slot]) quarantine.append(el('p', 'side-copy', slotNote[item.slot]));
    }
    side.append(quarantine);
    if (extraSide) side.append(extraSide);
  }

  layout.append(wavesPanel, side); root.append(heading, metrics, usage, layout); return root;
}
