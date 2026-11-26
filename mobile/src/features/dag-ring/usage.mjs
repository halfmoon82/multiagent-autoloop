// 项目任务进度的用量/计数口径（fix6 project-ring-web-parity）：与网页版 public/status-sections.mjs、
// public/views.mjs、public/dag-model.mjs 同一算法的移动端副本（移动端受限静态服务只能加载 mobile/src，
// 不能直接引用 public/）。两边口径由 test/mobile-dag-ring-parity.test.mjs 用同一份数据逐字比对守住，
// 改动任一侧都要同步。纯函数：不碰 DOM、不依赖 Node 内置模块；只信 Hub 自报值，缺失如实标注。
import { projectName } from '../../core/contract.mjs';

const isNum = value => typeof value === 'number' && Number.isFinite(value);
const array = value => (Array.isArray(value) ? value : []);

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

export const formatNumber = value => new Intl.NumberFormat('zh-CN').format(Number(value || 0));

// 与网页 format.mjs formatDateTime 一致：纯日期原样返回，非法时间返回空串（调用方决定是否显示）。
export function formatDateTime(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return String(value);
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time))
    : '';
}

export function matchesProject(value, filter) {
  if (!filter) return true;
  return projectName(value) === projectName(filter);
}

export function projectForCard(card, rules = []) {
  const direct = String(card?.project || card?.cwd || '').trim();
  if (direct) return direct;
  const rule = rules.find(item => item.name === card?.rule);
  return String(rule?.cwd || '').trim() || '未识别';
}

export function usageNotes(usage) {
  const parts = [];
  if (usage?.backfillPending) parts.push('历史补全中');
  if (usage?.missingCostRounds > 0) parts.push(`${usage.missingCostRounds} 轮未上报费用`);
  if (usage?.unresolvedRounds > 0) parts.push(`${usage.unresolvedRounds} 轮长期未完成未计入`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

export function projectUsageText(label, usage) {
  const notes = usageNotes(usage);
  if (!usage || !usage.reported) return `${label} · 暂无用量${notes}`;
  const fmt = value => Number(value || 0).toLocaleString('en-US');
  const tokens = fmt(usage.tokens);
  const split = (usage.input > 0 || usage.output > 0) ? `（入 ${fmt(usage.input)} / 出 ${fmt(usage.output)}）` : '';
  const cost = typeof usage.cost === 'number' ? `费用 $${usage.cost.toFixed(2)}` : null;
  const token = usage.tokens > 0 ? `Token ${tokens}${split}` : null;
  if (cost && token) return `${label} · ${cost} · ${token}${notes}`;
  if (cost) return `${label} · ${cost}${notes}`;
  if (token) return `${label} · ${token} · 费用未上报${notes}`;
  return `${label} · 暂无用量${notes}`;
}

// 一个项目（按 basename 匹配其规则）的当日活动聚合：等待重试 / 今日完成 / 今日费用。
export function projectActivity(cwd, rules = [], lines = []) {
  const target = String(cwd || '').trim();
  const names = new Set(rules.filter(rule => target && matchesProject(rule.cwd, target)).map(rule => rule.name));
  const totals = { running: 0, queued: 0, retrying: 0, unknown: 0, done: 0, nothing: 0, doneToday: 0 };
  let tokens = 0, cost = 0, hasCost = false;
  for (const line of lines || []) {
    if (!names.has(line?.name)) continue;
    const t = line.totals || {};
    for (const key of Object.keys(totals)) totals[key] += t[key] || 0;
    const usage = t.usage || line.usage || {};
    tokens += (usage.input || 0) + (usage.output || 0);
    if (typeof usage.cost === 'number') { hasCost = true; cost += usage.cost; }
  }
  return {
    running: totals.running,
    waiting: totals.queued + totals.retrying,
    unknown: totals.unknown,
    doneToday: totals.doneToday,
    tokens,
    cost: hasCost ? cost : undefined,
  };
}

export function chainRuleNames(sourceFile, rules = []) {
  const stem = String(sourceFile || '').replace(/-serial\.json$/i, '').toLowerCase();
  if (!stem) return new Set();
  return new Set(rules.filter(rule => {
    const name = String(rule?.name || '').toLowerCase();
    return name.startsWith(stem) && !/^[a-z0-9]/.test(name.slice(stem.length));
  }).map(rule => rule.name));
}

export function chainRules(chain, rules = [], allChains = []) {
  let names = chainRuleNames(chain?.sourceFile, rules);
  if (!names.size) {
    const claimed = new Set();
    for (const other of allChains) {
      if (other === chain) continue;
      for (const name of chainRuleNames(other?.sourceFile, rules)) claimed.add(name);
    }
    const project = String(chain?.project || '').trim();
    names = new Set(rules.filter(rule => project && matchesProject(rule.cwd, project) && !claimed.has(rule.name)).map(rule => rule.name));
  }
  return names;
}

const usageObject = usage => (usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : null);
const UNREPORTABLE_USAGE_ADAPTERS = new Set(['acp']);
const NO_MODEL_ADAPTERS = new Set(['command', 'delivery', 'desktop', 'dsh', 'feishu', 'github', 'gitlab', 'webhook']);

// 串行链每个节点自己最近一轮的执行者与自报用量（服务端 nodeRounds 为底，叠加首页 runs 里更新的轮次）。
export function chainNodeExecutors(chain, rules = [], runs = [], allChains = [], models = {}, agentNames = {}, adapters = {}) {
  const latest = {};
  for (const [nodeId, round] of Object.entries(chain?.nodeRounds || {})) {
    if (round && String(round.agent || '').trim()) latest[nodeId] = { id: Number(round.id), agent: String(round.agent).trim(), state: round.state, usage: usageObject(round.usage) };
  }
  const nodeIds = new Set([...(chain?.order || []), ...(chain?.nodes || []).map(node => node?.id)].map(id => String(id || '').trim()).filter(Boolean));
  const names = chainRules(chain, rules, allChains);
  for (const run of runs || []) {
    const agent = String(run?.agent || '').trim();
    if (!names.has(run?.rule) || !agent) continue;
    for (const event of run.events || []) {
      const nodeId = String(event?.subject || '').trim();
      if (!nodeIds.has(nodeId)) continue;
      if (latest[nodeId] && latest[nodeId].id >= Number(run.id)) continue;
      latest[nodeId] = { id: Number(run.id), agent, state: run.state, usage: usageObject(run.usage) };
    }
  }
  const out = {};
  for (const [nodeId, round] of Object.entries(latest)) {
    const entry = { agent: agentNames[round.agent] || round.agent, model: models[round.agent] || '未配置', usage: round.usage, running: round.state === 'claimed' };
    const adapter = String(adapters[round.agent] || '');
    if (!round.usage && UNREPORTABLE_USAGE_ADAPTERS.has(adapter)) entry.unreportable = true;
    else if (!round.usage && NO_MODEL_ADAPTERS.has(adapter)) entry.noModel = true;
    out[nodeId] = entry;
  }
  return out;
}

// 整条链累计：优先服务端台账 cumulativeUsage，缺失回退 lines 今日窗口（如实偏低）。
export function chainUsage(chain, rules = [], lines = [], allChains = []) {
  if (chain?.cumulativeUsage && typeof chain.cumulativeUsage === 'object') return chain.cumulativeUsage;
  const names = chainRules(chain, rules, allChains);
  let tokens = 0, cost = 0, hasCost = false, rounds = 0, missingCostRounds = 0;
  for (const line of lines || []) {
    if (!names.has(line?.name)) continue;
    const t = line.totals || {};
    const usage = t.usage || line.usage || {};
    tokens += (usage.input || 0) + (usage.output || 0);
    const finished = (t.done || 0) + (t.nothing || 0);
    rounds += finished;
    if (typeof usage.cost === 'number') { hasCost = true; cost += usage.cost; }
    else missingCostRounds += finished;
  }
  return { tokens, cost: hasCost ? cost : undefined, rounds, missingCostRounds };
}

export function chainUsageText(usage) {
  const tokens = (usage.tokens || 0).toLocaleString('en-US');
  const notes = usageNotes(usage);
  if (typeof usage.cost === 'number') return `链累计 · ${tokens} Token · $${usage.cost.toFixed(2)}${notes}`;
  if (usage.tokens > 0) return `链累计 · ${tokens} Token · 费用未上报${notes}`;
  return `链累计 · 暂无用量${notes}`;
}

// 同一项目多条串行链只保留最近更新的一条（与网页 latestChainsByProject 一致）。
export function latestChainsByProject(chains = []) {
  const best = new Map();
  for (const chain of array(chains)) {
    const key = projectName(String(chain?.project || '').trim());
    const prev = best.get(key);
    if (!prev || String(chain?.updatedAt || '') >= String(prev.updatedAt || '')) best.set(key, chain);
  }
  return array(chains).filter(chain => best.get(projectName(String(chain?.project || '').trim())) === chain);
}

// 归档链计费：与网页 archive-view.mjs archiveUsageText 同口径。
export function archiveUsageText(usage) {
  if (!usage) return '用量未上报';
  const tokens = Number(usage.tokens) || 0;
  const tokenText = tokens > 0 ? `Token ${formatNumber(tokens)}（入 ${formatNumber(usage.input)} / 出 ${formatNumber(usage.output)}）` : 'Token 未上报';
  const costText = typeof usage.cost === 'number' ? `费用 $${usage.cost.toFixed(2)}` : '费用未上报';
  const partial = Number(usage.missingCostRounds) > 0 && typeof usage.cost === 'number' ? `（${formatNumber(usage.missingCostRounds)} 轮未上报费用，实际更高）` : '';
  return `${costText}${partial} · ${tokenText}`;
}
