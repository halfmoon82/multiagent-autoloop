import { statusLabel } from './format.mjs';
export function billingText(run) {
  const usage = run.usage || {};
  if (typeof usage.cost === 'number') return `$${usage.cost.toFixed(2)}`;
  if (typeof usage.input === 'number' || typeof usage.output === 'number') return `${(usage.input || 0) + (usage.output || 0)} Token · 费用未上报`;
  return '费用未上报';
}
export function runLine(run, models = {}) {
  const text = run.error || run.summary || '暂无概要';
  return { id: run.id, rule: run.rule, state: run.state, status: run.state === 'queued' && run.attempts > 0 ? '等待重试' : statusLabel(run.state), text, attempts: run.attempts || 0, model: models[run.agent] || '未配置', billing: billingText(run) };
}
const sameLocalDay = (iso, now = new Date()) => {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};
export function splitRunSections(snapshot, models = {}, now = new Date()) {
  const runs = snapshot.runs || [];
  return {
    running: runs.filter(run => run.state === 'claimed').slice(0, 5).map(run => runLine(run, models)),
    retrying: runs.filter(run => run.state === 'queued' && run.attempts > 0).slice(0, 5).map(run => runLine(run, models)),
    doneToday: runs.filter(run => ['done', 'nothing'].includes(run.state) && sameLocalDay(run.finishedAt || run.createdAt, now)).slice(0, 5).map(run => runLine(run, models)),
    needsAttention: runs.filter(run => ['unknown', 'cancelled'].includes(run.state)).slice(0, 5).map(run => runLine(run, models)),
  };
}
