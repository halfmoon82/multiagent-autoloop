// DAG 视图：总览分组、运行详情、历史运行。所有上游文本只经 textContent 写入。
import { el } from './views.mjs';
import { projectName } from './format.mjs';
import { buildDagNodes, groupWaves, donutModel, dagRunSummary, formatUsage, sumUsage } from './dag-model.mjs';

const TERMINAL = new Set(['done', 'cancelled', 'abandoned', 'blocked_unknown']);
export const isDagActive = run => !TERMINAL.has(run?.status);
const safeHref = url => /^https:\/\//.test(String(url || '')) ? url : '';

function badge(text, kind = '') { return el('span', `status ${kind}`.trim(), text); }
function planTitle(detail) { return detail.run.planId || detail.run.runId; }

export function donut(nodes, label) {
  const model = donutModel(nodes);
  const box = el('div', 'dag-donut'); box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `${label}总进度 ${model.percent}%，${model.segments} 个节点，逐节点分段`);
  box.dataset.segments = String(model.segments);
  if (model.gradient) box.style.backgroundImage = model.gradient;
  const inner = el('div'); inner.append(el('strong', '', `${model.percent}%`), el('span', '', '总进度')); box.append(inner);
  return box;
}

export function nodeCard(node, { selected = false, cls = 'dag-node', runId = '' } = {}) {
  const button = el('button', `${cls} ${node.status.kind}${selected ? ' selected' : ''}`);
  button.type = 'button'; button.dataset.dagNode = node.id; button.dataset.dagRun = runId;
  button.append(el('span', 'node-status-icon', node.status.icon), el('strong', '', node.title));
  button.append(el('small', '', `${node.status.label}${node.slot != null ? ` · 槽位 ${node.slot}` : ''}`));
  button.append(el('p', 'node-task-summary', node.summary), el('em', 'node-agent', `${node.agent} · ${node.model}`));
  return button;
}

function wavesView(nodes, opts) {
  const wrap = el('div', 'progress-waves');
  for (const { wave, nodes: list } of groupWaves(nodes)) {
    const row = el('div', 'wave');
    const active = list.filter(n => ['active', 'review'].includes(n.status.kind)).length;
    const label = el('div', 'wave-label'); label.append(el('span', '', `第 ${wave} 波`), el('small', '', list.every(n => n.status.kind === 'done') ? '已完成' : `${active} 路在途`));
    const body = el('div', 'wave-nodes');
    list.forEach(node => body.append(nodeCard(node, { ...opts, selected: opts.selectedNode === node.id && opts.selectedRun === opts.runId })));
    row.append(label, body); wrap.append(row);
  }
  return wrap;
}

// 总览：每个活跃 DAG 一张卡；旧串行行与四组不动。
export function renderDagOverview(details = []) {
  return details.filter(detail => isDagActive(detail.run)).map(detail => {
    const nodes = buildDagNodes(detail); const sum = dagRunSummary(detail, nodes);
    const card = el('article', 'project-progress dag-project'); card.dataset.dagRun = detail.run.runId;
    const head = el('div', 'project-heading-row'); const title = el('div'); const line = el('div', 'title-with-badge');
    line.append(el('h3', '', projectName(detail.run.project)), badge('并行 DAG', 'good'));
    title.append(line, el('p', 'subtle', `${planTitle(detail)} · ${nodes.length} 个节点 · 第 ${sum.currentWave}/${sum.totalWaves} 波`));
    const open = el('button', 'text-button', '查看运行详情 →'); open.type = 'button'; open.dataset.dagOpen = detail.run.runId;
    head.append(title, open);
    const usage = el('div', 'dag-usage', `本次运行 · ${formatUsage(sum.usage)}`);
    const visual = el('div', 'dag-visual'); const donutWrap = el('div', 'donut-wrap');
    donutWrap.append(donut(nodes, 'DAG '), el('small', 'subtle', '颜色 = 波次 · 深浅 = 状态'));
    visual.append(donutWrap, wavesView(nodes, { cls: 'progress-node', runId: detail.run.runId }));
    const note = el('div', 'capacity-note', `${sum.slotsUsed}/5 路占用${sum.quarantined.length ? `（另有 ${sum.quarantined.length} 个隔离槽位仍占名额）` : ''} · 只有 PR 合并后下游才启动。`);
    card.append(head, usage, visual, note);
    return card;
  });
}

function fact(label, value, link = '') {
  const row = el('div'); row.append(el('dt', '', label));
  const dd = el('dd');
  if (link && safeHref(link)) { const a = el('a', '', value); a.href = link; a.rel = 'noreferrer'; a.target = '_blank'; dd.append(a); } else dd.textContent = value;
  row.append(dd); return row;
}

function nodeDetailPanel(node) {
  const panel = el('section', 'panel node-detail'); panel.id = 'dag-node-detail';
  if (!node) { panel.append(el('div', 'empty', '点击左侧节点查看槽位、阶段、分支、契约和证据。')); return panel; }
  const head = el('div', 'panel-heading'); head.append(el('h3', '', node.title), badge(node.status.label, node.status.kind === 'done' ? 'good' : node.status.kind === 'blocked' ? 'warn' : ''));
  const dl = el('dl', 'fact-list');
  dl.append(fact('槽位', node.slot != null ? `dag-slot-${node.slot}` : '未占用'), fact('分支', node.branch || '未创建'), fact('执行 Agent', node.agent), fact('模型', node.model), fact('证据', node.prUrl ? '查看 PR' : '暂无 PR', node.prUrl), fact('合并提交', node.mergeCommit || '尚未合并'), fact('费用 / Token', formatUsage(node.usage)));
  const summary = el('div', 'node-contract'); summary.append(el('strong', '', '当前任务摘要'), el('p', '', node.summary));
  const contract = el('div', 'node-contract'); contract.append(el('strong', '', '节点契约'));
  for (const [key, label] of [['input', '输入'], ['output', '输出'], ['error_behavior', '异常行为'], ['acceptance_example', '验收示例']]) if (node.contract[key]) contract.append(el('p', '', `${label}：${node.contract[key]}`));
  contract.append(el('p', '', `文件范围：${(node.contract.files || []).join('、') || '只读，无写入'}`));
  panel.append(head, dl, summary, contract); return panel;
}

export function renderDagDetail(detail, { selectedNode = '', slotNote = {} } = {}) {
  const nodes = buildDagNodes(detail); const sum = dagRunSummary(detail, nodes); const run = detail.run;
  const root = el('div', 'dag-detail'); root.dataset.dagRun = run.runId;
  const heading = el('div', 'page-heading compact-heading'); const left = el('div'); const tl = el('div', 'title-with-badge');
  tl.append(el('h2', '', planTitle(detail)), badge(isDagActive(run) ? (run.publish?.cancelRequested ? '取消中' : '运行中') : run.status, isDagActive(run) ? 'good' : ''));
  left.append(tl, el('p', 'subtle', `${run.runId} · ${projectName(run.project)} · 计划摘要 ${String(run.planDigest || '').slice(0, 12)}`));
  const actions = el('div', 'heading-actions');
  if (isDagActive(run) && !run.publish?.cancelRequested) { const cancel = el('button', 'button danger-outline', '取消运行'); cancel.type = 'button'; cancel.dataset.dagCancel = run.runId; actions.append(cancel); }
  heading.append(left, actions);
  const metrics = el('div', 'run-metrics');
  for (const [label, value] of [['当前波次', `${sum.currentWave} / ${sum.totalWaves}`], ['业务槽位', `${sum.slotsUsed} / 5`], ['已完成', `${sum.doneCount} / ${sum.nodeCount}`], ['换打法', `${(run.publish?.approachChanges || []).length} 次`], ['隔离槽位', `${sum.quarantined.length} 个`]]) { const cell = el('div'); cell.append(el('span', '', label), el('strong', '', value)); metrics.append(cell); }
  const usage = el('p', 'subtle dag-usage', `本次运行 · ${formatUsage(sum.usage)}（以节点 run 上报为准，未上报不计为 0）`);
  const layout = el('div', 'dag-layout');
  const wavesPanel = el('section', 'panel waves-panel'); const wh = el('div', 'panel-heading');
  wh.append(el('div', '', '执行波次'), el('span', 'subtle', '只有 PR 合并后，下游节点才会启动')); wavesPanel.append(wh, wavesView(nodes, { cls: 'dag-node', runId: run.runId, selectedNode, selectedRun: run.runId }));
  const side = el('aside', 'dag-sidebar'); side.append(nodeDetailPanel(nodes.find(n => n.id === selectedNode)));
  const quarantine = el('section', 'panel side-card'); const qh = el('div', 'panel-heading'); qh.append(el('h3', '', '隔离槽位'), badge(`${sum.quarantined.length} 个`, sum.quarantined.length ? 'warn' : ''));
  quarantine.append(qh);
  if (!sum.quarantined.length) quarantine.append(el('p', 'side-copy', '没有隔离槽位。'));
  for (const item of sum.quarantined) {
    quarantine.append(el('p', 'side-copy', `槽位 ${item.slot} · 节点 ${item.nodeId} · 失联，旧回执已作废，仍占 1 路名额。`));
    const label = el('label', 'confirm-check'); const box = el('input'); box.type = 'checkbox'; box.dataset.slotVerify = String(item.slot); label.append(box, el('span', '', '我已确认该槽位的进程组已退出'));
    const release = el('button', 'button secondary full', `释放槽位 ${item.slot}`); release.type = 'button'; release.dataset.slotRelease = String(item.slot); release.dataset.dagRun = run.runId;
    quarantine.append(label, release);
    if (slotNote[item.slot]) quarantine.append(el('p', 'side-copy', slotNote[item.slot]));
  }
  side.append(quarantine);
  layout.append(wavesPanel, side); root.append(heading, metrics, usage, layout); return root;
}

export function renderDagHistory(details = []) {
  const done = details.filter(detail => !isDagActive(detail.run));
  const panel = el('section', 'panel history-runs'); const toggle = el('button', '', ''); toggle.type = 'button'; toggle.dataset.dagHistoryToggle = '1';
  toggle.append(el('span', '', '历史 DAG 运行'), el('small', '', `已结束 ${done.length} 个 · 默认折叠 · 不自动清理`), el('span', '', '⌄'));
  const list = el('div'); list.id = 'dag-history-list'; list.hidden = true;
  if (!done.length) list.append(el('div', 'empty', '还没有已结束的 DAG 运行。'));
  for (const detail of done) {
    const nodes = buildDagNodes(detail); const row = el('button', 'history-row'); row.type = 'button'; row.dataset.dagOpen = detail.run.runId;
    row.append(el('strong', '', planTitle(detail)), el('span', '', `${detail.run.status} · ${projectName(detail.run.project)} · ${nodes.length} 节点`), el('span', 'history-usage', formatUsage(sumUsage(detail.nodeRuns || []))), el('span', '', '查看节点 →'));
    list.append(row);
  }
  panel.append(toggle, list); return panel;
}
