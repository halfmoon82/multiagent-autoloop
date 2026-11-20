// 归档任务环的最终计费与 Token（只读）：串行取服务端台账累计，DAG 汇总各节点轮次的 Hub 自报用量。
// 已归档任务不再变化，DAG 结果按 runId 缓存；读不到就不给 usage，界面如实写「未上报」。
const isNum = value => typeof value === 'number' && Number.isFinite(value);

export function sumRunUsage(nodeRuns = []) {
  let cost = null; let input = 0; let output = 0; let tokenReported = false; let rounds = 0; let missingCostRounds = 0;
  for (const run of nodeRuns) {
    rounds += 1;
    const usage = run?.usage;
    // 不跑模型的通道本来就没有费用，不算「漏报」。
    if (!isNum(usage?.cost) && !run?.usageNoModel) missingCostRounds += 1;
    if (!usage) continue;
    if (isNum(usage.cost)) cost = (cost || 0) + usage.cost;
    if (isNum(usage.input) || isNum(usage.output)) { tokenReported = true; input += usage.input || 0; output += usage.output || 0; }
  }
  return { input, output, tokens: input + output, cost, rounds, missingCostRounds, tokenReported };
}

const dagCache = new Map();

export async function attachArchiveUsage(items, { chainUsageFor = () => null, dagUsageFor = async () => null } = {}) {
  return Promise.all(items.map(async item => {
    let usage = null;
    try {
      if (item.kind === 'serial') usage = chainUsageFor(item) || null;
      else if (item.kind === 'dag' && item.runId) {
        if (dagCache.has(item.runId)) usage = dagCache.get(item.runId);
        else { usage = (await dagUsageFor(item)) || null; if (usage) dagCache.set(item.runId, usage); }
      }
    } catch { usage = null; }
    return { ...item, usage };
  }));
}
