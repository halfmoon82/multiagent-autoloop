import { statusLabel, projectName } from './format.mjs';
export function billingText(run) {
  const usage = run.usage || {};
  if (typeof usage.cost === 'number') return `$${usage.cost.toFixed(2)}`;
  if (typeof usage.input === 'number' || typeof usage.output === 'number') return `${(usage.input || 0) + (usage.output || 0)} Token · 费用未上报`;
  return '费用未上报';
}
// 项目级今日/累计用量的展示口径：已上报费用 → Token + 费用未上报 → 暂无用量。
// 只展示 Hub 自报值，缺失如实标注，不折算、不按模型名估算。
export function projectUsageText(label, usage) {
  // 如实标注必须在任何分支都跟着走：既无费用又无 Token 时也要交代"补全中/未上报/长期未完成"。
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

export function projectForRun(run, rules = []) {
  const direct = String(run.project || run.cwd || '').trim();
  if (direct) return direct;
  const rule = rules.find(item => item.name === run.rule);
  return String(rule?.cwd || '').trim() || '未识别';
}
export function projectForCard(card, rules = []) {
  const direct = String(card.project || card.cwd || '').trim();
  if (direct) return direct;
  const rule = rules.find(item => item.name === card.rule);
  return String(rule?.cwd || '').trim() || '未识别';
}
// 触发事件：run.events 来自 Hub 的 run_events（每条 run 附带其 triggered 事件）。
// 优先取带 summary/subject 的那条（dag.node.dev / chain.pr.review / run.manual），
// 跳过只有空 schedule.tick 的条目；都不带则退回首条，保证"事件无摘要时可判断"。
export function triggeringEvent(run) {
  const events = Array.isArray(run?.events) ? run.events : [];
  return events.find(event => event && (String(event.summary || '').trim() || String(event.subject || '').trim())) || events[0] || {};
}

// #75 主人强制需求：在途轮次必须有任务摘要 + 任务编号。
// run 文本（error/summary）优先；为空时用触发事件 summary；事件也无摘要则如实显示规则名，不编造。
// 任务编号 = 触发事件 subject（稳定任务编号）；subject 为空时用可见的轮次 #id，不虚构成别的任务。
// DAG 派发事件类型为 dag.<项目>.<角色>[.<分档>]（src/dag-runtime.mjs dagEventType）；
// 只认 dev/review 两种派发角色，回执（dag.*.advance）等其他事件不加标签。
const DAG_ROLE_LABELS = { dev: '开发', review: '审阅' };
export function dagRoleLabel(run) {
  for (const event of Array.isArray(run?.events) ? run.events : []) {
    const match = /^dag\.[^.]+\.(dev|review)(?:\.[a-z0-9-]+)?$/.exec(String(event?.type || ''));
    if (match) return DAG_ROLE_LABELS[match[1]];
  }
  return '';
}

export function runTaskInfo(run) {
  const event = triggeringEvent(run);
  const runText = String(run?.error || '').trim() || String(run?.summary || '').trim();
  const eventSummary = String(event.summary || '').trim();
  const subject = String(event.subject || '').trim();
  const roleLabel = dagRoleLabel(run);
  const summary = runText || eventSummary || String(run?.rule || '').trim() || '暂无概要';
  return {
    roleLabel,
    taskSummary: roleLabel ? `【${roleLabel}】${summary}` : summary,
    taskNumber: subject || String(run?.id ?? ''),
  };
}

export function runLine(run, models = {}, rules = [], agentNames = {}) {
  const task = runTaskInfo(run);
  const project = projectForRun(run, rules);
  const agentId = String(run.agent || '').trim();
  const agent = agentId ? (agentNames[agentId] || agentId) : '';
  return { id: run.id, rule: run.rule, project, projectName: projectName(project), state: run.state, status: run.state === 'queued' && run.attempts > 0 ? '等待重试' : statusLabel(run.state), text: task.taskSummary, taskSummary: task.taskSummary, roleLabel: task.roleLabel, taskNumber: task.taskNumber, attempts: run.attempts || 0, agent, model: models[run.agent] || '未配置', billing: billingText(run) };
}
const sameLocalDay = (iso, now = new Date()) => {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};
export function splitRunSections(snapshot, models = {}, now = new Date(), rules = [], agentNames = {}) {
  const runs = snapshot.runs || [];
  return {
    running: runs.filter(run => run.state === 'claimed').slice(0, 5).map(run => runLine(run, models, rules, agentNames)),
    retrying: runs.filter(run => run.state === 'queued' && run.attempts > 0).slice(0, 5).map(run => runLine(run, models, rules, agentNames)),
    doneToday: runs.filter(run => ['done', 'nothing'].includes(run.state) && sameLocalDay(run.finishedAt || run.createdAt, now)).slice(0, 5).map(run => runLine(run, models, rules, agentNames)),
    needsAttention: runs.filter(run => ['unknown', 'cancelled'].includes(run.state)).slice(0, 5).map(run => runLine(run, models, rules, agentNames)),
  };
}

export function matchesProject(value, filter) {
  if (!filter) return true;
  return projectName(value) === projectName(filter);
}

export function collectProjects({ rules = [], runs = [], cards = [], sessions = [] } = {}) {
  const projects = [];
  const add = value => { const text = String(value || '').trim(); if (text && !projects.includes(text)) projects.push(text); };
  for (const rule of rules) add(rule.cwd);
  for (const run of runs) add(projectForRun(run, rules));
  for (const card of cards) add(projectForCard(card, rules));
  for (const session of sessions) add(session.project);
  return projects;
}

export function ruleProject(rules = [], name) {
  return String(rules.find(rule => rule.name === name)?.cwd || '').trim() || '未识别';
}

function scopedLines(snapshot, rules, filter) {
  return (snapshot.lines || []).filter(line => matchesProject(ruleProject(rules, line.name), filter));
}

// 项目筛选后的总览数字：只聚合该项目的规则行，全部 Hub 上报数据，不编造。
export function scopedTotals(snapshot, rules = [], filter = '') {
  if (!filter) return null;
  const lines = scopedLines(snapshot, rules, filter);
  const totals = { running: 0, queued: 0, retrying: 0, unknown: 0, doneToday: 0 };
  for (const line of lines) {
    const t = line.totals || {};
    totals.running += t.running || 0;
    totals.queued += t.queued || 0;
    totals.retrying += t.retrying || 0;
    totals.unknown += t.unknown || 0;
    totals.doneToday += t.doneToday || 0;
  }
  return totals;
}

export function scopedSpending(snapshot, rules = [], filter = '') {
  if (!filter) return null;
  const lines = scopedLines(snapshot, rules, filter);
  let tokens = 0, cost = 0, hasCost = false, rounds = 0, missingRounds = 0;
  for (const line of lines) {
    const t = line.totals || {};
    const usage = t.usage || line.usage || {}; // 真实 hub 形态：usage 归在 totals 下
    tokens += (usage.input || 0) + (usage.output || 0);
    const finished = (t.done || 0) + (t.nothing || 0);
    rounds += finished;
    if (typeof usage.cost === 'number') { hasCost = true; cost += usage.cost; }
    else missingRounds += finished;
  }
  return { tokens, rounds, cost: hasCost ? cost : undefined, missingCost: hasCost ? missingRounds : rounds };
}

export function timersForProject(timers = [], rules = [], filter = '') {
  if (!filter) return timers;
  return timers.filter(timer => matchesProject(ruleProject(rules, timer.rule), filter));
}

// 台账如实标注：未补全到底、未上报费用、长期未完成未计入，任何用量文案都要带上。
export function usageNotes(usage) {
  const parts = [];
  if (usage?.backfillPending) parts.push('历史补全中');
  if (usage?.missingCostRounds > 0) parts.push(`${usage.missingCostRounds} 轮未上报费用`);
  if (usage?.unresolvedRounds > 0) parts.push(`${usage.unresolvedRounds} 轮长期未完成未计入`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

// 一个项目（按 basename 匹配其规则）的当日活动聚合，供项目任务进度面板计数行使用。
export function projectActivity(cwd, rules = [], lines = []) {
  const target = String(cwd || '').trim();
  const names = new Set(rules.filter(rule => target && matchesProject(rule.cwd, target)).map(rule => rule.name));
  return aggregateLines(names, lines);
}

function aggregateLines(names, lines) {
  lines = lines || [];
  const totals = { running: 0, queued: 0, retrying: 0, unknown: 0, done: 0, nothing: 0, doneToday: 0 };
  let tokens = 0, cost = 0, hasCost = false;
  for (const line of lines) {
    if (!names.has(line.name)) continue;
    const t = line.totals || {};
    for (const key of Object.keys(totals)) totals[key] += t[key] || 0;
    const usage = t.usage || line.usage || {}; // 真实 hub 形态：usage 归在 totals 下
    tokens += (usage.input || 0) + (usage.output || 0);
    if (typeof usage.cost === 'number') { hasCost = true; cost += usage.cost; }
  }
  const finished = totals.done + totals.nothing;
  const totalRounds = finished + totals.running + totals.queued + totals.retrying + totals.unknown;
  return {
    ruleCount: names.size,
    running: totals.running,
    waiting: totals.queued + totals.retrying,
    unknown: totals.unknown,
    doneToday: totals.doneToday,
    finished,
    totalRounds,
    ratio: totalRounds ? finished / totalRounds : null,
    tokens,
    cost: hasCost ? cost : undefined,
  };
}

// 链文件词干 → 规则名前缀（与 src/serial-progress.mjs mapChainProject 同一边界规则）：
// 'v6' 命中 'V6串行推进'/'V6开发'，但不命中 'V6x串行推进'。
export function chainRuleNames(sourceFile, rules = []) {
  const stem = String(sourceFile || '').replace(/-serial\.json$/i, '').toLowerCase();
  if (!stem) return new Set();
  return new Set(rules.filter((rule) => {
    const name = String(rule?.name || '').toLowerCase();
    return name.startsWith(stem) && !/^[a-z0-9]/.test(name.slice(stem.length));
  }).map((rule) => rule.name));
}

// 链归属规则：词干命中优先；零命中（如 mtexec 链配 MT* 规则）回退到该项目归属、且未被其他已加载链词干认领的规则。
export function chainRules(chain, rules = [], allChains = []) {
  let names = chainRuleNames(chain?.sourceFile, rules);
  if (!names.size) {
    const claimed = new Set();
    for (const other of allChains) {
      if (other === chain) continue;
      for (const name of chainRuleNames(other?.sourceFile, rules)) claimed.add(name);
    }
    const project = String(chain?.project || '').trim();
    names = new Set(rules.filter((rule) => project && matchesProject(rule.cwd, project) && !claimed.has(rule.name)).map((rule) => rule.name));
  }
  return names;
}

// 串行链每个节点自己的最近一轮执行者与自报用量。归属依据：串行编排派发节点时，Hub 轮次的触发事件
// subject = 节点 id；巡检/定时器/手动运行不带节点编号，不会挂到任何节点上。
// 底数来自服务端 chain.nodeRounds（翻过 Hub 全部历史）；再叠加首页 runs 里更新的轮次（含正在跑的），
// 让刚派发的轮次不用等服务端刷新。查不到的节点不出现在结果里，界面如实写未上报。
const usageObject = usage => (usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : null);
// 通道两类如实标注（与服务端 src/dag-service.mjs 同口径，改动时两边同步）：
// UNREPORTABLE_USAGE_ADAPTERS：跑模型但协议不带用量（acp）→「该执行者不上报用量」；
// NO_MODEL_ADAPTERS：不跑模型（command/delivery/desktop/dsh/feishu/github/gitlab/webhook）→「不需要模型」。
const UNREPORTABLE_USAGE_ADAPTERS = new Set(['acp']);
const NO_MODEL_ADAPTERS = new Set(['command', 'delivery', 'desktop', 'dsh', 'feishu', 'github', 'gitlab', 'webhook']);
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

// 整条调度链从头到尾的累计 Token 与计费：优先用服务端 chain-usage.mjs 台账
// （翻遍 Hub runs 历史逐轮累加，真·自首次运行）；台账缺失时回退 lines 今日窗口并如实偏低。
// 只信 Hub 上报值，费用缺失如实标注；规则归属见 chainRules。
export function chainUsage(chain, rules = [], lines = [], allChains = []) {
  if (chain?.cumulativeUsage && typeof chain.cumulativeUsage === 'object') return chain.cumulativeUsage;
  const names = chainRules(chain, rules, allChains);
  let tokens = 0, cost = 0, hasCost = false, rounds = 0, missingCostRounds = 0;
  for (const line of lines || []) {
    if (!names.has(line.name)) continue;
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

// 每个调度会话负责的项目任务总进度：只统计绑定到该项目工作目录的规则行。
export function sessionProgress(session, rules = [], lines = []) {
  const cwd = String(session?.project || '').trim();
  return { project: cwd, ...projectActivity(cwd, rules, lines) };
}

// 同一项目（按 basename）存在多条串行链时，只保留最近更新的一条；旧链让位，不并排显示。
// updatedAt 来自链文件的 lastEventAt；缺失视为最旧。
export function latestChainsByProject(chains = []) {
  const best = new Map();
  for (const chain of chains) {
    const key = projectName(String(chain?.project || '').trim());
    const prev = best.get(key);
    if (!prev || String(chain?.updatedAt || '') >= String(prev.updatedAt || '')) best.set(key, chain);
  }
  return chains.filter(chain => best.get(projectName(String(chain?.project || '').trim())) === chain);
}
