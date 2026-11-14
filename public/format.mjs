export const formatNumber = value => new Intl.NumberFormat('zh-CN').format(Number(value || 0));
export const formatTime = value => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
export function formatCost(spending = {}) {
  if (spending.missingCost === spending.rounds || (!spending.rounds && !spending.cost)) return '未上报';
  const missing = spending.missingCost ? `（${spending.missingCost} 轮未报）` : '';
  return `$${Number(spending.cost || 0).toFixed(2)}${missing}`;
}
export function formatState(snapshot) {
  const totals = snapshot.totals || {};
  return {
    active: totals.running || 0,
    waiting: (totals.queued || 0) + (totals.retrying || 0),
    unknown: totals.unknown || 0,
    doneToday: totals.doneToday || 0,
    openCards: (snapshot.cards || []).filter(card => card.state === 'open').length,
    tokens: formatNumber(snapshot.spending?.today?.tokens),
    cost: formatCost(snapshot.spending?.today),
  };
}
const LABELS = { claimed: '运行中', queued: '排队中', unknown: '失联待核实', done: '已完成', nothing: '无需处理', cancelled: '已停止', open: '待处理', decided: '已回答', closed: '已结案' };
export const statusLabel = state => LABELS[state] || state || '未知';
export function scheduleLabel(rule) {
  if (rule.when?.cron) return `定时 · ${rule.when.cron}`;
  if (rule.when?.source) return `${rule.when.source} · ${(rule.when.types || []).join(', ')}`;
  return '手动触发';
}

export function projectName(cwd) {
  const text = String(cwd || '').trim().replace(/[\/]+$/, '');
  if (!text) return '未识别';
  const base = text.split(/[\/]/).filter(Boolean).pop();
  return base || text;
}
export function ruleLineStatus(line) {
  if (line?.paused) {
    const until = line.paused.until ? `，至 ${formatTime(line.paused.until)}` : '';
    return { label: '已暂停', kind: 'warn', detail: `暂停原因 · ${line.paused.reason || '未填写'}${until}` };
  }
  const totals = line?.totals || {};
  if (totals.running > 0) return { label: '运行中', kind: 'good', detail: `进行中 ${totals.running} 轮` };
  if (totals.retrying > 0) return { label: '等待重试', kind: 'warn', detail: `等待重试 ${totals.retrying} 轮` };
  if (totals.queued > 0) return { label: '排队中', kind: '', detail: `排队 ${totals.queued} 轮` };
  const next = line?.next ? `下次运行 · ${formatTime(line.next)}` : '';
  return { label: '待命', kind: '', detail: next };
}
