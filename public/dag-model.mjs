// DAG 前端数据模型：纯函数，输入 GET /api/dag-runs/:id 的详情，输出节点/波次/分段环/用量。
// 缺失的 Agent、模型、费用一律如实标注，不编造。
const STATE = {
  pending: { label: '未开始', kind: 'pending', icon: '○' },
  dev: { label: '开发中', kind: 'active', icon: '●' },
  review: { label: '独立审阅', kind: 'review', icon: '◐' },
  accepted: { label: '已合并', kind: 'done', icon: '✓' },
  blocked: { label: '阻塞', kind: 'blocked', icon: '!' },
  gated: { label: '等待人工决策', kind: 'blocked', icon: '!' },
  cancelled: { label: '已取消', kind: 'pending', icon: '×' },
};
export const nodeStatus = state => STATE[state] || { label: '未知状态', kind: 'unknown', icon: '?' };
const TERMINAL = new Set(['done', 'cancelled', 'abandoned', 'blocked_unknown']);
const isNum = value => typeof value === 'number' && Number.isFinite(value);

export function sumUsage(items = []) {
  let cost = null; let input = 0; let output = 0; let tokenReported = false;
  for (const item of items) {
    const usage = item?.usage; if (!usage) continue;
    if (isNum(usage.cost)) cost = (cost || 0) + usage.cost;
    if (isNum(usage.input) || isNum(usage.output)) { tokenReported = true; input += usage.input || 0; output += usage.output || 0; }
  }
  return { cost, input, output, tokens: input + output, reported: cost !== null || tokenReported };
}
export function formatUsage(usage) {
  const number = new Intl.NumberFormat('zh-CN');
  const tokenReported = usage.input > 0 || usage.output > 0 || usage.tokens > 0;
  if (usage.unreportable && usage.cost === null && !tokenReported) return '该执行者不上报用量';
  if (usage.noModel && usage.cost === null && !tokenReported) return '不需要模型';
  const costText = usage.cost === null ? '费用未上报' : `费用 $${usage.cost.toFixed(2)}`;
  const tokenText = tokenReported ? `Token ${number.format(usage.tokens)}（入 ${number.format(usage.input)} / 出 ${number.format(usage.output)}）` : 'Token 未上报';
  return `${costText} · ${tokenText}`;
}

function depths(list) {
  const byId = new Map(list.map(node => [node.id, node])); const memo = new Map();
  const visit = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id) || !byId.has(id)) return 0;
    seen.add(id);
    const depth = 1 + Math.max(0, ...(byId.get(id).depends_on || []).map(dep => visit(dep, seen)));
    memo.set(id, depth); return depth;
  };
  list.forEach(node => visit(node.id));
  return memo;
}

export function buildDagNodes(detail) {
  const run = detail?.run || {}; const planNodes = (run.nodes || []).filter(node => node.id !== '__root__');
  const runtime = run.publish?.nodes || {}; const nodeRuns = detail?.nodeRuns || [];
  const depth = depths(planNodes);
  const business = planNodes.filter(node => !(node.id === 'integration-review' || node.integration_review));
  const lastBusiness = Math.max(0, ...business.map(node => depth.get(node.id) || 1));
  return planNodes.map(node => {
    const review = node.id === 'integration-review' || Boolean(node.integration_review);
    const saved = runtime[node.id] || {}; const state = saved.state || 'pending';
    const mine = nodeRuns.filter(item => item.nodeId === node.id);
    const latest = mine.at(-1);
    // PR 由发布器登记在根 run.prs（带 nodeId）：取该节点最新一个仍开着或已合并的；被取代/已关闭的不算。
    // 根上没有该节点的登记时才看各轮 nodeRuns[].prs：仅作兜底，当前发布器不写这里（registerPr 只写根 run）。
    const rootPrs = (run.prs || []).filter(pr => pr.nodeId === node.id);
    const livePr = rootPrs.filter(pr => pr.state === 'open' || pr.state === 'merged').at(-1);
    const prs = rootPrs.length ? (livePr ? [livePr] : []) : mine.flatMap(item => item.prs || []);
    let summary = node.contract?.output ? `产出契约：${node.contract.output}` : '暂无任务摘要';
    if (saved.blockedReason) summary = `阻塞：${saved.blockedReason}`;
    else if (saved.gateReason) summary = `等待人工决策：${saved.gateReason}`;
    const warnings = saved.warnings || null;
    const warningText = warnings ? Object.entries(warnings).map(([kind, value]) => `${kind === 'outOfScope' ? '越界' : '设计证据'}：${Array.isArray(value) ? value.join(', ') : value}`).join('；') : '';
    if (warningText) summary = `${summary}｜警示：${warningText}`;
    return {
      id: node.id, title: node.title || node.id, state, status: nodeStatus(state),
      wave: review ? lastBusiness + 1 : depth.get(node.id) || 1, dependsOn: node.depends_on || [],
      slot: saved.slot ?? latest?.slot ?? null, branch: saved.branch || '', mergeCommit: saved.mergeCommit || '',
      contract: node.contract || {}, summary,
      agent: latest ? (latest.agent || '未上报') : '待派发',
      model: latest ? (saved.model || latest.model || '未上报') : '模型待选择',
      prUrl: prs.at(-1)?.prUrl || '', usage: { ...sumUsage(mine), unreportable: mine.some(item => item.usageUnreportable), noModel: mine.some(item => item.usageNoModel) }, warnings, lastError: saved.lastError || '',
    };
  });
}
export function groupWaves(nodes) {
  const waves = new Map();
  for (const node of nodes) { if (!waves.has(node.wave)) waves.set(node.wave, []); waves.get(node.wave).push(node); }
  return [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([wave, list]) => ({ wave, nodes: list }));
}
// 波次配色：一个波次一个色相；同波次内节点用同色相不同明度表达完成度，全深 = 该节点已完成。
// 完成度档位只来自可核实的状态，不按时间或猜测编造中间百分比。
const COMPLETION = { done: 1, review: 0.75, rework: 0.5, active: 0.5, external: 0.4, blocked: 0.2, pending: 0, unknown: 0 };
export function waveHue(wave) { return Math.round((168 + (Math.max(1, Math.round(wave || 1)) - 1) * 137.5) % 360); }
export function completionOf(status) { return COMPLETION[status?.kind] ?? 0; }
export function segmentColor(node) {
  const lightness = Math.round(72 - 45 * completionOf(node.status));
  return `hsl(${waveHue(node.wave)}, 52%, ${lightness}%)`;
}
export function donutModel(nodes) {
  if (!nodes.length) return { segments: 0, percent: 0, gradient: '' };
  const share = 100 / nodes.length;
  const stops = nodes.map((node, index) => `${segmentColor(node)} ${(index * share).toFixed(3)}% ${((index + 1) * share).toFixed(3)}%`);
  // 总进度 = 节点完成度均值：已合并算 100%，在途/审阅/阻塞按节点内档位计入，
  // 与串行链同向（在途节点按节点内完成度计入）；档值各自定义，两侧数字不必相等。
  const completion = nodes.reduce((sum, node) => sum + completionOf(node.status), 0);
  return { segments: nodes.length, percent: Math.round(completion / nodes.length * 100), gradient: `conic-gradient(${stops.join(',')})` };
}
export function dagRunSummary(detail, nodes) {
  const waves = groupWaves(nodes);
  const open = waves.find(item => item.nodes.some(node => node.status.kind !== 'done'));
  const live = (detail?.nodeRuns || []).filter(item => !TERMINAL.has(item.status));
  return {
    totalWaves: waves.length, currentWave: open ? open.wave : waves.length,
    nodeCount: nodes.length, doneCount: nodes.filter(node => node.status.kind === 'done').length,
    slotsUsed: live.filter(item => item.slot != null && !item.quarantine).length,
    quarantined: live.filter(item => item.quarantine && item.slot != null),
    usage: { ...sumUsage(detail?.nodeRuns || []), unreportable: (detail?.nodeRuns || []).some(item => item.usageUnreportable), noModel: (detail?.nodeRuns || []).some(item => item.usageNoModel) },
  };
}
