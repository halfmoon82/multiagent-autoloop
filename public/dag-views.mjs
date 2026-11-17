// DAG 视图：总览分组、运行详情、历史运行。所有上游文本只经 textContent 写入。
// #75：节点/波次/环形/详情统一走 progress-view.mjs 的同一套组件语言，与串行链同构。
import { el } from './views.mjs';
import { projectName } from './format.mjs';
import { buildDagNodes, formatUsage, segmentColor, sumUsage } from './dag-model.mjs';
import { buildDagView, progressDonut, progressNodeCard, progressVisual, renderProgressDetail } from './progress-view.mjs';

const TERMINAL = new Set(['done', 'cancelled', 'abandoned', 'blocked_unknown']);
export const isDagActive = run => !TERMINAL.has(run?.status);
const safeHref = url => /^https:\/\//.test(String(url || '')) ? url : '';

// 授权确认页的「可选高风险动作」：默认关闭，逐项写明产品语言的收益与代价，勾选后才随计划生效。
export function renderOptionalGrants(plan, { selected = [] } = {}) {
  const section = el('section', 'panel authorization-section optional-grants');
  section.append(el('h2', '', '可选高风险动作（默认关闭）'));
  section.append(el('p', 'subtle', '以下动作默认不执行；只有逐项勾选并随本计划确认后才写入授权记录。'));
  const list = el('div', 'permission-grid');
  for (const option of plan?.optionalActions || []) {
    const label = el('label', 'optional-grant');
    const box = el('input'); box.type = 'checkbox'; box.checked = selected.includes(option.id);
    box.dataset.optionalGrant = option.id;
    const text = el('span');
    text.append(el('strong', '', option.title || option.id));
    text.append(el('small', 'grant-benefit', `收益：${option.benefit || '未提供'}`));
    text.append(el('small', 'grant-cost', `代价：${option.cost || '未提供'}`));
    label.append(box, text); list.append(label);
  }
  if (!(plan?.optionalActions || []).length) list.append(el('p', 'empty', '本计划未声明可选高风险动作。'));
  section.append(list);
  return section;
}

// DAG 详情的轻量授权记录：标准动作自动继承 + 已选高风险动作 + 摘要与修订号。
export function renderGrantRecord(grant) {
  const panel = el('section', 'panel side-card grant-record'); panel.id = 'dag-grant-record';
  const head = el('div', 'panel-heading'); head.append(el('h3', '', '执行授权记录')); panel.append(head);
  if (!grant) { panel.append(el('p', 'side-copy', '暂无授权记录。')); return panel; }
  panel.append(el('p', 'side-copy', `修订 #${grant.revision ?? 1} · 摘要 ${String(grant.digest || '').slice(0, 12)}`));
  panel.append(el('p', 'side-copy', `标准动作（自动继承 ${(grant.standardActions || []).length} 项）：${(grant.standardActions || []).join('、') || '无'}`));
  const optional = grant.optionalGrants || [];
  panel.append(el('p', 'side-copy', `可选高风险动作：${optional.length ? optional.map(id => HIGH_RISK_TITLE[id] || id).join('、') : '均未开启（默认关闭）'}`));
  return panel;
}
const HIGH_RISK_TITLE = { deploy: '部署', release: '发布', 'production-write': '生产数据写入', credentials: '凭据', 'external-communication': '对外通信' };

function badge(text, kind = '') { return el('span', `status ${kind}`.trim(), text); }
function planTitle(detail) { return detail.run.planId || detail.run.runId; }

// 兼容导出（旧签名）：内部统一委托给共用组件，渲染结果仍保留既有选择器。
export function donut(nodes, label) {
  const view = {
    nodes: nodes.map(node => ({ ...node, color: segmentColor(node) })),
    percent: nodes.length ? Math.round(nodes.filter(node => node.status.kind === 'done').length / nodes.length * 100) : 0,
  };
  return progressDonut(view, { label });
}
export function nodeCard(node, { selected = false, cls = 'dag-node', runId = '' } = {}) {
  return progressNodeCard({ ...node, usageText: formatUsage(node.usage) }, { selected, cls, runId, key: 'dagNode' });
}

// 总览：每个活跃 DAG 一张卡；环形 + 分组四栏节点卡片，与串行链同构。
export function renderDagOverview(details = []) {
  return details.filter(detail => isDagActive(detail.run)).map(detail => {
    const view = buildDagView(detail);
    const card = el('article', 'project-progress dag-project'); card.dataset.dagRun = detail.run.runId;
    const head = el('div', 'project-heading-row'); const title = el('div'); const line = el('div', 'title-with-badge');
    line.append(el('h3', '', projectName(detail.run.project)), badge('并行 DAG', 'good'));
    title.append(line, el('p', 'subtle', view.subtitle));
    const open = el('button', 'text-button', '查看运行详情 →'); open.type = 'button'; open.dataset.dagOpen = detail.run.runId;
    head.append(title, open);
    const usage = el('div', 'dag-usage', view.usageText);
    const visual = progressVisual(view, { label: 'DAG ', cls: 'progress-node', key: 'dagNode', runId: detail.run.runId });
    const sum = view.extra.sum;
    const note = el('div', 'capacity-note', `${sum.slotsUsed}/5 路占用${sum.quarantined.length ? `（另有 ${sum.quarantined.length} 个隔离槽位仍占名额）` : ''} · 只有 PR 合并后下游才启动。`);
    card.append(head, usage, visual, note);
    return card;
  });
}

// 运行详情：与串行链共用 renderProgressDetail，只是数据来自 DAG 详情与波次。
export function renderDagDetail(detail, { selectedNode = '', slotNote = {} } = {}) {
  const view = buildDagView(detail);
  const run = detail.run;
  const active = isDagActive(run);
  const cancelRequested = Boolean(run.publish?.cancelRequested);
  return renderProgressDetail(view, {
    selectedNode, slotNote, active, cancelRequested, titleOverride: planTitle(detail), extraSide: renderGrantRecord(run.authorizationSnapshot),
    statusText: cancelRequested ? '取消中' : active ? '运行中' : run.status,
    statusKind: cancelRequested ? 'warn' : active ? 'good' : '',
  });
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
