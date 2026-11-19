// 移动端项目 DAG 环形进度只读视图模型（Spec §8.2 / 计划 dag-ring）。
// 输入是 assembleSnapshot 归一后的 dag-runs（每个 run 带服务端投影的 mobileSummary.ring）。
// 输出可安全渲染的普通对象：外层按项目分组、同项目+planId 多次运行只取最新一次成一个环，
// 环内波次节点/槽位/费用/证据/节点详情全部来自服务端真实字段；DAG 数据缺失给明确空态，
// 绝不用串行链条替代。不碰 DOM、不依赖 Node 内置模块、不拼接 HTML 字符串。
import { collection, projectName, dagStatusLabel } from '../../core/contract.mjs';
import { RING_MISSING_REASON, RING_NO_TASKS_REASON, CONTRACT_ROWS, taskIdOf } from './contract.mjs';

const array = value => (Array.isArray(value) ? value : []);
const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const text = value => String(value ?? '').trim();

function ringCard(run, summary) {
  const data = object(summary.ring);
  const project = text(summary.project ?? run.project);
  const planId = text(summary.planId ?? run.planId);
  const status = text(summary.status ?? run.status);
  return {
    taskId: taskIdOf(project, planId),
    project,
    projectLabel: projectName(project),
    planId,
    runId: text(summary.runId ?? run.runId),
    createdAt: text(summary.createdAt ?? run.createdAt),
    status,
    statusLabel: dagStatusLabel(status),
    ring: object(data.ring),
    waves: array(data.waves),
    nodes: array(data.nodes),
    summary: object(data.summary),
    empty: Boolean(data.empty),
    emptyReason: data.emptyReason || null,
    selected: false,
  };
}

// 主入口：snapshot → 任务环集合（按项目+planId 归组取最新 run）+ 选中态。
// 没有 ring 投影的 run 一律跳过，不凭空从节点数组造环。
export function buildDagRingView(snapshot) {
  const source = object(snapshot);
  const available = Boolean(source.available?.['dag-runs']);
  const error = text(source.errors?.['dag-runs']);
  const latest = new Map();
  for (const run of array(source.dagRuns)) {
    const summary = object(object(run).mobileSummary);
    if (!summary.ring) continue;
    const card = ringCard(object(run), summary);
    if (!card.planId) continue;
    const prev = latest.get(card.taskId);
    const better = !prev
      || card.createdAt > prev.createdAt
      || (card.createdAt === prev.createdAt && card.runId > prev.runId);
    if (better) latest.set(card.taskId, card);
  }
  const items = [...latest.values()].sort((a, b) =>
    a.projectLabel.localeCompare(b.projectLabel) || a.planId.localeCompare(b.planId));
  const reason = available ? RING_NO_TASKS_REASON : (error || RING_MISSING_REASON);
  return { rings: collection(items, reason), selectedId: null, selected: null, available, error };
}

// 选中一个环：切换选中态并带出该环的节点清单，供下方详情点击节点查看；不可变，不改原视图。
export function selectRing(view, taskId) {
  const items = array(view?.rings?.items);
  const chosen = items.find(item => item.taskId === taskId) || null;
  const reason = view?.rings?.reason || RING_NO_TASKS_REASON;
  return {
    ...view,
    selectedId: chosen ? taskId : null,
    selected: chosen ? { ...chosen, nodes: array(chosen.nodes).map(node => ({ ...object(node) })) } : null,
    rings: collection(items.map(item => ({ ...item, selected: item.taskId === taskId })), reason),
  };
}

// 节点详情：契约四段 + 证据，全部为可安全渲染的纯字符串；缺失段不显示、不编造。
export function buildNodeDetailView(node) {
  const source = object(node);
  const contract = object(source.contract);
  const contractRows = CONTRACT_ROWS
    .map(row => ({ key: row.key, label: row.label, value: text(contract[row.key]) }))
    .filter(row => row.value);
  const evidence = array(source.evidence)
    .map(row => ({ kind: text(object(row).kind), label: text(object(row).label), value: text(object(row).value) }))
    .filter(row => row.value);
  return {
    id: text(source.id),
    title: text(source.title || source.id),
    wave: Number.isInteger(source.wave) ? source.wave : null,
    state: text(source.state),
    statusLabel: text(source.statusLabel),
    statusKind: text(source.statusKind),
    slot: source.slot ?? null,
    branch: text(source.branch),
    agent: text(source.agent),
    model: text(source.model),
    usageText: text(source.usageText),
    summary: text(source.summary),
    contract: contractRows,
    evidence,
  };
}
