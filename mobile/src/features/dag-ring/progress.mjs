// 移动端总览「项目任务进度」视图模型（fix6 project-ring-web-parity，2026-11-26 主人定）：
// 与网页版 public/progress-view.mjs（buildSerialView / buildDagView）、public/views.mjs（串行链行与费用条）、
// public/dag-views.mjs（并行 DAG 卡片）、public/archive-view.mjs（已归档的任务环）同内容同口径，
// 只有窄屏布局不同。串行链与活跃并行 DAG 统一成同一种「环」视图：扇区 = 节点、中心总进度、
// 点扇区切换节点详情、底部费用汇总条；已归档任务同样画环，折叠在「已归档的任务环」里。
// 纯函数：不碰 DOM、不依赖 Node 内置模块；所有上游文本由调用方 textContent 渲染。缺失如实标注，不编造。
import { projectName } from '../../core/contract.mjs';
import {
  matchesProject, projectForCard, projectActivity, projectUsageText, chainNodeExecutors, chainUsage,
  chainUsageText, latestChainsByProject, archiveUsageText, formatDateTime, sumUsage, formatUsage,
} from './usage.mjs';

const array = value => (Array.isArray(value) ? value : []);
const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const text = value => String(value ?? '').trim();

// ---------- 状态与配色：与网页 progress-view.mjs / dag-model.mjs 同表 ----------
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
const SERIAL_COLORS = { done: '#157a65', active: '#2f8d76', review: '#6fae9d', rework: '#c08a2e', blocked: '#d59a37', external: '#3f9b88', pending: '#cfdad6', unknown: '#cfdad6' };
const COMPLETION = { done: 1, review: 0.75, rework: 0.5, active: 0.5, external: 0.4, blocked: 0.2, pending: 0, unknown: 0 };
export const completionOf = kind => COMPLETION[kind] ?? 0;
const waveHue = wave => Math.round((168 + (Math.max(1, Math.round(wave || 1)) - 1) * 137.5) % 360);
export const segmentColor = (kind, wave) => `hsl(${waveHue(wave)}, 52%, ${Math.round(72 - 45 * completionOf(kind))}%)`;

const UNKNOWN_USAGE = '费用未上报 · Token 未上报';
const reported = usage => usage && ['input', 'output', 'cost'].some(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]));
function serialNodeUsage(round) {
  if (round && reported(round.usage)) return `${round.running ? '本轮' : '最近一轮'} · ${formatUsage(sumUsage([{ usage: round.usage }]))}`;
  if (round?.running) return '本轮进行中 · 费用未上报 · Token 未上报';
  if (round?.unreportable) return '该执行者不上报用量';
  if (round?.noModel) return '不需要模型';
  return UNKNOWN_USAGE;
}

// ---------- 串行链 → 环视图（字段与网页 buildSerialView 一致） ----------
export function buildSerialRingView(chain, { usageText = UNKNOWN_USAGE, executors = {} } = {}) {
  const source = object(chain);
  const all = array(source.nodes);
  // 真实 /api/serial-progress 带 order；种子数据缺 order 时按 nodes 原顺序（不丢节点）。
  const order = Array.isArray(source.order) ? source.order : all.map(node => node?.id);
  const nodesRaw = order.map(id => all.find(node => node?.id === id)).filter(Boolean);
  const currentId = text(source.current?.id ?? (typeof source.current === 'string' ? source.current : ''));
  const nodes = nodesRaw.map(node => {
    const status = serialStatus(node.status);
    const executor = executors?.[node.id];
    return {
      id: String(node.id), title: text(node.title) || String(node.id), status,
      groupOrder: status.kind === 'done' ? 1 : node.id === currentId ? 2 : 3,
      summary: text(node.summary) || '暂无任务摘要：节点推进后由开发/审阅上报一句话进展。',
      agent: executor?.agent || '未上报',
      model: executor?.model || (node.id === currentId ? '模型待选择' : '未上报'),
      usageText: serialNodeUsage(executor),
      part: text(node.part), percent: Number(node.percent) || 0, prUrl: text(node.prUrl),
      color: SERIAL_COLORS[status.kind] || SERIAL_COLORS.unknown,
      completion: completionOf(status.kind),
      wave: null, slot: null, branch: '',
    };
  });
  const current = currentId ? nodes.find(node => node.id === currentId) || null : null;
  const createdAt = text(source.createdAt);
  return {
    key: `serial:${text(source.sourceFile)}`, kind: 'serial', id: text(source.sourceFile), runId: text(source.sourceFile),
    project: text(source.project), title: projectName(text(source.project)), badge: '串行链',
    subtitle: `${nodes.length} 个节点 · 按执行顺序排列${current ? ` · 当前 ${current.title}` : ''}${createdAt && formatDateTime(createdAt) ? ` · 创建于 ${formatDateTime(createdAt)}` : ''}`,
    percent: Math.round(Number(source.percent) || 0), segmentNote: '同一色相 · 深浅 = 状态',
    nodes, currentId: current?.id || '', usageText, createdAt,
  };
}

// ---------- 并行 DAG → 环视图（字段与网页 buildDagView 一致；数据来自服务端 mobileSummary.ring 投影） ----------
export function buildDagRunRingView(run) {
  const summary = object(object(run).mobileSummary);
  const ring = object(summary.ring);
  if (!summary.ring) return null;
  const runSummary = object(ring.summary);
  const nodes = array(ring.nodes).map(node => {
    const source = object(node);
    const kind = text(source.statusKind) || 'unknown';
    const wave = Number.isFinite(source.wave) ? source.wave : 1;
    return {
      id: text(source.id), title: text(source.title) || text(source.id),
      status: { label: text(source.statusLabel) || '未知状态', kind },
      groupOrder: wave, wave,
      summary: text(source.summary) || '暂无任务摘要',
      agent: text(source.agent) || '未上报', model: text(source.model) || '未上报',
      usageText: text(source.usageText) || UNKNOWN_USAGE,
      part: '', percent: null, prUrl: text(source.prUrl),
      slot: source.slot ?? null, branch: text(source.branch),
      color: segmentColor(kind, wave), completion: completionOf(kind),
    };
  }).filter(node => node.id);
  const runId = text(summary.runId ?? run?.runId);
  const planId = text(summary.planId ?? run?.planId);
  const createdAt = text(summary.createdAt ?? run?.createdAt);
  const quarantined = array(runSummary.quarantined);
  const slotsUsed = Number(runSummary.slotsUsed) || 0;
  const totalWaves = Number(runSummary.totalWaves) || 0;
  const currentWave = Number(runSummary.currentWave) || 0;
  const project = text(summary.project ?? run?.project);
  return {
    key: `dag:${runId}`, kind: 'dag', id: runId, runId, planId, project, title: projectName(project), badge: '并行 DAG',
    taskId: `dag:${project}:${planId}`,
    subtitle: `${planId || runId} · ${nodes.length} 个节点 · 第 ${currentWave}/${totalWaves} 波${createdAt && formatDateTime(createdAt) ? ` · 创建于 ${formatDateTime(createdAt)}` : ''}`,
    percent: Number.isFinite(object(ring.ring).percent) ? ring.ring.percent : 0,
    segmentNote: '颜色 = 波次 · 深浅 = 完成度',
    nodes, currentId: '', createdAt,
    usageText: `本次运行 · ${text(runSummary.usageText) || UNKNOWN_USAGE}`,
    capacityNote: `${slotsUsed}/5 路占用${quarantined.length ? `（另有 ${quarantined.length} 个隔离槽位仍占名额）` : ''} · 只有 PR 合并后下游才启动。`,
    emptyReason: ring.empty ? text(ring.emptyReason) || 'DAG 节点数据缺失' : '',
  };
}

// 没有显式选择时的默认节点：当前节点 → 进行中/审阅/返工/阻塞 → 第一个未开始 → 最后一个（与网页一致）。
export function defaultNodeId(view) {
  const nodes = array(view?.nodes);
  const byId = id => (id ? nodes.find(node => node.id === id) : null);
  const picked = byId(view?.currentId)
    || nodes.find(node => ['active', 'review', 'rework', 'blocked'].includes(node.status.kind))
    || nodes.find(node => node.status.kind === 'pending')
    || nodes[nodes.length - 1];
  return picked?.id || '';
}

// ---------- 费用汇总条：与网页 countsChips + chain-usage/创建于 + projectUsageChips 同口径 ----------
function countsChips(project, { rules, lines, cards }) {
  const activity = projectActivity(project, rules, lines);
  const cardsHere = cards.filter(card => card?.state === 'open' && matchesProject(projectForCard(card, rules), project)).length;
  const cost = typeof activity.cost === 'number' ? `$${activity.cost.toFixed(2)}` : '未上报';
  return [
    { id: 'waiting', text: `等待重试 ${activity.waiting}` },
    { id: 'done-today', text: `今日完成 ${activity.doneToday}` },
    { id: 'cards', text: `待您处理 ${cardsHere} 张` },
    { id: 'cost-today', text: `今日费用 ${cost}` },
  ];
}

function projectUsageChips(project, projectUsage, loadError) {
  if (loadError) return [{ id: 'project-usage-error', text: '项目用量读取失败，请刷新重试' }];
  const key = projectName(project);
  const found = array(projectUsage).find(item => projectName(item?.key || item?.project) === key);
  return [
    { id: 'project-today', text: projectUsageText('项目今日', found?.today) },
    { id: 'project-total', text: projectUsageText('项目累计', found?.cumulative) },
  ];
}

// ---------- 已归档的任务环：计数与网页 archive-view 一致，每个任务同款环 ----------
const REASON = { completed: { label: '全部完成', kind: 'good' }, cancelled: { label: '已取消', kind: 'warn' }, abandoned: { label: '已取消', kind: 'warn' } };
export function archiveSummaryLine(list) {
  const done = list.filter(item => item?.reason === 'completed').length;
  const cancelled = list.length - done;
  return cancelled ? `全部完成 ${done} · 已取消 ${cancelled}` : `全部完成 ${done}`;
}

// 归档文件未保留节点明细时（改名归档的串行链）：按完成数/总数照常画环并标注，不编造节点名。
function placeholderRing(item) {
  const total = Math.max(0, Number(item?.nodes?.total) || 0);
  const done = Math.min(total, Math.max(0, Number(item?.nodes?.done) || 0));
  const nodes = Array.from({ length: total }, (_, index) => {
    const kind = index < done ? 'done' : 'pending';
    return {
      id: `n${index + 1}`, title: `节点 ${index + 1}`, status: { label: kind === 'done' ? '已完成' : '未完成', kind },
      groupOrder: 1, wave: null, summary: '归档记录未保留该节点明细', agent: '未上报', model: '未上报', usageText: UNKNOWN_USAGE,
      part: '', percent: null, prUrl: '', slot: null, branch: '',
      color: SERIAL_COLORS[kind], completion: completionOf(kind),
    };
  });
  return { nodes, note: '归档记录未保留节点明细：扇区按完成数示意' };
}

function archivedRing(item, { dagRuns, chains }) {
  const kind = item.kind === 'dag' ? 'dag' : 'serial';
  let view = null;
  if (kind === 'dag') {
    const run = dagRuns.find(entry => text(entry?.mobileSummary?.runId ?? entry?.runId) === text(item.runId));
    view = run ? buildDagRunRingView(run) : null;
  } else {
    const chain = chains.find(entry => text(entry?.sourceFile) === `${text(item.source)}-serial.json`);
    view = chain ? buildSerialRingView(chain) : null;
  }
  const reason = REASON[item.reason] || { label: text(item.reason) || '未知', kind: '' };
  const created = formatDateTime(item.createdAt);
  const closed = formatDateTime(item.archivedTime) || text(item.archivedAt);
  const total = Number(item?.nodes?.total) || 0;
  const base = {
    key: `archive:${kind}:${text(item.taskId) || text(item.runId) || text(item.source)}`,
    kind, project: text(item.project), projectLabel: projectName(text(item.project)),
    title: text(item.title) || text(item.source) || '未命名任务',
    source: kind === 'dag' ? `${text(item.source)} · ${total} 节点` : `${text(item.source)}-serial · ${total} 节点`,
    usageText: `链计费 · ${archiveUsageText(item.usage)}`,
    times: `创建 ${created || '未记录'} · 归档 ${closed}`,
    percent: Math.round(Number(item.percent) || 0),
    reason, archivedAt: text(item.archivedAt), runId: text(item.runId),
    segmentNote: kind === 'dag' ? '颜色 = 波次 · 深浅 = 完成度' : '同一色相 · 深浅 = 状态',
    currentId: '', note: '',
  };
  if (view && view.nodes.length) return { ...base, nodes: view.nodes, segmentNote: view.segmentNote };
  const placeholder = placeholderRing(item);
  return { ...base, nodes: placeholder.nodes, note: placeholder.note };
}

export function buildArchivedRings(archive, { dagRuns = [], chains = [], filter = '', error = null } = {}) {
  const list = array(archive).filter(entry => entry && typeof entry === 'object');
  const items = list.map(item => archivedRing(item, { dagRuns: array(dagRuns), chains: array(chains) }));
  const groups = [];
  if (!filter) {
    const byName = new Map();
    for (const item of items) {
      if (!byName.has(item.projectLabel)) { byName.set(item.projectLabel, { name: item.projectLabel, items: [] }); groups.push(byName.get(item.projectLabel)); }
      byName.get(item.projectLabel).items.push(item);
    }
  }
  return {
    title: '已归档的任务环',
    count: items.length,
    summary: items.length ? archiveSummaryLine(list) : '该项目暂无归档',
    // 与网页一致：没有归档且未筛选项目时整块不显示。
    hidden: !items.length && !filter && !error,
    scope: filter ? `筛选：${filter}` : '',
    empty: items.length ? '' : (filter ? '该项目还没有已归档的任务环。' : '还没有已归档的任务环。'),
    items, groups: filter ? [{ name: '', items }] : groups,
    error: error ? `归档详情读取失败：${error}` : '',
  };
}

// ---------- 主入口：snapshot → 项目任务进度（活跃环卡片 + 已归档的任务环） ----------
// snapshot 由页面装配：state/rules/dagRuns/serial + archive/projectUsage（各自带 available/errors）。
const DAG_TERMINAL = new Set(['done', 'cancelled', 'abandoned', 'blocked_unknown']);
export const isDagActive = status => !DAG_TERMINAL.has(text(status));

export function buildProjectProgress(snapshot, { filter = '' } = {}) {
  const source = object(snapshot);
  const available = object(source.available);
  const errors = object(source.errors);
  const state = object(source.state);
  const rulesData = object(source.rules);
  const rules = array(rulesData.rules);
  const models = object(rulesData.models);
  const agents = array(rulesData.agents);
  const agentNames = Object.fromEntries(agents.map(agent => [agent?.id, agent?.name]).filter(([id, name]) => id && name));
  const adapters = Object.fromEntries(agents.map(agent => [agent?.id, agent?.adapter]).filter(([id, adapter]) => id && adapter));
  const lines = array(state.lines);
  const cards = array(state.cards);
  const runs = array(state.runs);
  const projectUsage = array(object(source.projectUsage).projects);
  const usageLoadError = !available['project-usage'];
  const context = { rules, lines, cards };
  const chipsFor = project => ({ counts: countsChips(project, context), project: projectUsageChips(project, projectUsage, usageLoadError) });

  const allChains = array(object(source.serial).chains);
  const chains = latestChainsByProject(allChains);
  const serialCards = chains.map(chain => {
    const executors = chainNodeExecutors(chain, rules, runs, allChains, models, agentNames, adapters);
    const usageText = chainUsageText(chainUsage(chain, rules, lines, allChains));
    const view = buildSerialRingView(chain, { usageText, executors });
    const chips = chipsFor(view.project);
    const created = view.createdAt && formatDateTime(view.createdAt);
    return {
      ...view,
      defaultId: defaultNodeId(view),
      chips: [...chips.counts, { id: 'chain-usage', text: usageText }, ...(created ? [{ id: 'chain-created', text: `创建于 ${created}` }] : [])],
      projectChips: chips.project,
    };
  }).filter(card => card.runId && card.nodes.length);

  const dagRuns = array(source.dagRuns);
  const dagCards = dagRuns.filter(run => isDagActive(run?.mobileSummary?.status ?? run?.status))
    .map(run => buildDagRunRingView(run)).filter(Boolean).map(view => {
      const chips = chipsFor(view.project);
      return { ...view, defaultId: defaultNodeId(view), chips: chips.counts, projectChips: chips.project };
    });

  const cardsOut = [...serialCards, ...dagCards];
  const serialOk = Boolean(available['serial-progress']);
  const dagOk = Boolean(available['dag-runs']);
  let reason = '';
  if (!cardsOut.length) {
    if (!serialOk && !dagOk) reason = `节点进度读取失败：${errors['serial-progress'] || '串行进度数据缺失'}；${errors['dag-runs'] || 'DAG 数据缺失'}（点「重试」再试）`;
    else reason = '暂无活跃项目：没有进行中的串行链或并行 DAG。';
  }
  const archived = buildArchivedRings(available.archive ? source.archive : [], {
    dagRuns, chains: allChains, filter,
    error: available.archive === false ? (errors.archive || '归档数据缺失，未读取到已归档任务') : null,
  });
  return { cards: cardsOut, empty: !cardsOut.length, reason, archived };
}
