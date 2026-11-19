// 服务端 DAG 环形进度模型（Spec §8.2 / 计划 dag-ring）：把 GET /api/dag-runs/:id 的只读详情
// 投影成移动端环形图所需的纯数据。波次/分段环/完成度/用量/PR 口径复用 public/dag-model.mjs
// 已验算的纯函数，不在服务端重算 digest、不改写任何授权快照；缺失字段留空/明确空态，
// 不编造 Agent、模型、费用、进度或证据。
import { buildDagNodes, groupWaves, donutModel, dagRunSummary, formatUsage } from '../public/dag-model.mjs';

const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const text = value => String(value ?? '').trim();

// 节点证据：只取真实可核实的 PR / 合并提交 / 分支 / 槽位，缺失的不造。
function evidenceOf(node) {
  const rows = [];
  if (node.prUrl) rows.push({ kind: 'pr', label: 'PR', value: String(node.prUrl) });
  if (node.mergeCommit) rows.push({ kind: 'merge', label: '合并提交', value: String(node.mergeCommit) });
  if (node.branch) rows.push({ kind: 'branch', label: '分支', value: String(node.branch) });
  if (node.slot != null) rows.push({ kind: 'slot', label: '槽位', value: String(node.slot) });
  return rows;
}

// 节点视图：契约四段原样带出（点击节点可查看输入/输出/异常行为/验收示例），证据单独成列。
function nodeView(node) {
  const contract = object(node.contract);
  return {
    id: node.id,
    title: node.title,
    wave: node.wave,
    state: node.state,
    statusLabel: node.status.label,
    statusKind: node.status.kind,
    slot: node.slot ?? null,
    branch: text(node.branch),
    mergeCommit: text(node.mergeCommit),
    prUrl: text(node.prUrl),
    agent: text(node.agent),
    model: text(node.model),
    usageText: formatUsage(node.usage),
    summary: text(node.summary),
    warnings: node.warnings || null,
    lastError: text(node.lastError),
    contract: {
      input: text(contract.input),
      output: text(contract.output),
      error_behavior: text(contract.error_behavior),
      acceptance_example: text(contract.acceptance_example),
      files: Array.isArray(contract.files) ? contract.files.map(String) : [],
    },
    evidence: evidenceOf(node),
  };
}

// 主入口：run（根 run）+ nodeRuns（各节点轮次）→ 可安全序列化的环形图模型。
export function buildDagRing(run, nodeRuns = []) {
  const detail = {
    run: object(run),
    nodeRuns: Array.isArray(nodeRuns) ? nodeRuns : [],
  };
  const nodes = buildDagNodes(detail);
  const views = nodes.map(nodeView);
  const byId = new Map(views.map(view => [view.id, view]));
  const waves = groupWaves(nodes).map(group => ({
    wave: group.wave,
    nodes: group.nodes.map(node => byId.get(node.id)),
  }));
  const summary = dagRunSummary(detail, nodes);

  return {
    runId: text(detail.run.runId),
    project: text(detail.run.project),
    planId: text(detail.run.planId),
    status: text(detail.run.status),
    createdAt: text(detail.run.createdAt),
    ring: donutModel(nodes),
    waves,
    nodes: views,
    summary: { ...summary, usageText: formatUsage(summary.usage) },
    empty: nodes.length === 0,
    emptyReason: nodes.length ? null : 'DAG 节点数据缺失，不显示进度环（不改用串行链条）',
  };
}
