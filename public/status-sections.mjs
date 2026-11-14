import { statusLabel, projectName } from './format.mjs';
export function billingText(run) {
  const usage = run.usage || {};
  if (typeof usage.cost === 'number') return `$${usage.cost.toFixed(2)}`;
  if (typeof usage.input === 'number' || typeof usage.output === 'number') return `${(usage.input || 0) + (usage.output || 0)} Token · 费用未上报`;
  return '费用未上报';
}
export function projectForRun(run, rules = []) {
  const direct = String(run.project || run.cwd || '').trim();
  if (direct) return direct;
  const rule = rules.find(item => item.name === run.rule);
  return String(rule?.cwd || '').trim() || '未识别';
}
export function projectForCard(card) {
  return String(card.project || card.cwd || '').trim() || '未识别';
}
export function runLine(run, models = {}, rules = []) {
  const text = run.error || run.summary || '暂无概要';
  const project = projectForRun(run, rules);
  return { id: run.id, rule: run.rule, project, projectName: projectName(project), state: run.state, status: run.state === 'queued' && run.attempts > 0 ? '等待重试' : statusLabel(run.state), text, attempts: run.attempts || 0, model: models[run.agent] || '未配置', billing: billingText(run) };
}
const sameLocalDay = (iso, now = new Date()) => {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};
export function splitRunSections(snapshot, models = {}, now = new Date(), rules = []) {
  const runs = snapshot.runs || [];
  return {
    running: runs.filter(run => run.state === 'claimed').slice(0, 5).map(run => runLine(run, models, rules)),
    retrying: runs.filter(run => run.state === 'queued' && run.attempts > 0).slice(0, 5).map(run => runLine(run, models, rules)),
    doneToday: runs.filter(run => ['done', 'nothing'].includes(run.state) && sameLocalDay(run.finishedAt || run.createdAt, now)).slice(0, 5).map(run => runLine(run, models, rules)),
    needsAttention: runs.filter(run => ['unknown', 'cancelled'].includes(run.state)).slice(0, 5).map(run => runLine(run, models, rules)),
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
  for (const card of cards) add(projectForCard(card));
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
  let tokens = 0, cost = 0, hasCost = false, rounds = 0;
  for (const line of lines) {
    const usage = line.usage || {};
    tokens += (usage.input || 0) + (usage.output || 0);
    if (typeof usage.cost === 'number') { hasCost = true; cost += usage.cost; }
    const t = line.totals || {};
    rounds += (t.done || 0) + (t.nothing || 0);
  }
  return { tokens, rounds, cost: hasCost ? cost : undefined, missingCost: hasCost ? 0 : rounds };
}

export function timersForProject(timers = [], rules = [], filter = '') {
  if (!filter) return timers;
  return timers.filter(timer => matchesProject(ruleProject(rules, timer.rule), filter));
}

// 每个调度会话负责的项目任务总进度：只统计绑定到该项目工作目录的规则行。
export function sessionProgress(session, rules = [], lines = []) {
  const cwd = String(session?.project || '').trim();
  const names = new Set(rules.filter(rule => cwd && matchesProject(rule.cwd, cwd)).map(rule => rule.name));
  const totals = { running: 0, queued: 0, retrying: 0, unknown: 0, done: 0, nothing: 0, doneToday: 0 };
  let tokens = 0, cost = 0, hasCost = false;
  for (const line of lines) {
    if (!names.has(line.name)) continue;
    const t = line.totals || {};
    for (const key of Object.keys(totals)) totals[key] += t[key] || 0;
    const usage = line.usage || {};
    tokens += (usage.input || 0) + (usage.output || 0);
    if (typeof usage.cost === 'number') { hasCost = true; cost += usage.cost; }
  }
  const finished = totals.done + totals.nothing;
  const totalRounds = finished + totals.running + totals.queued + totals.retrying + totals.unknown;
  return {
    project: cwd,
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
