// 移动端核心页面共享契约（Spec §8.2 / DAG 计划 wave-3）。
// 纯函数、不触碰浏览器全局、不依赖 Node 内置模块：Node 边界测试与移动端打包器都可导入。
// 展示口径与网页控制台 public/format.mjs、public/status-sections.mjs 对齐；
// 数据缺失一律用 emptyState / collection 明确标注，不编造状态、模型、费用或进度。
// 上游文本全程是纯字符串，由调用方用 textContent 之类安全方式渲染。

export const MOBILE_PAGE_IDS = Object.freeze(['overview', 'rules', 'runs', 'todos', 'authorize']);
export const MOBILE_PAGE_TITLES = Object.freeze({
  overview: '总览', rules: '调度规则', runs: '执行轮次', todos: '待我处理', authorize: '执行授权',
});
export const MOBILE_NAVIGATION = Object.freeze(
  MOBILE_PAGE_IDS.map(id => Object.freeze({ id, title: MOBILE_PAGE_TITLES[id] })),
);

export const STATE_LABELS = Object.freeze({
  claimed: '运行中', queued: '排队中', unknown: '失联待核实', done: '已完成',
  nothing: '无需处理', cancelled: '已停止', open: '待处理', decided: '已回答', closed: '已结案',
});
export const statusLabel = state => STATE_LABELS[state] || state || '未知';

// DAG 根 run 的状态词与 Hub 轮次不同，另立一份映射；查不到就回退到通用口径。
export const DAG_STATUS_LABELS = Object.freeze({
  queued: '排队中', claimed: '运行中', running: '运行中', done: '已完成',
  cancelled: '已取消', abandoned: '已放弃', blocked_unknown: '失联待核实', gated: '等待人工决策',
});
export const dagStatusLabel = status => DAG_STATUS_LABELS[status] || statusLabel(status);

export const CARD_STATE_LABELS = Object.freeze({ open: '待处理', decided: '已回答', closed: '已结案' });
export const cardStateLabel = state => CARD_STATE_LABELS[state] || state || '未知';

// 执行授权动作文案沿用网页控制台 public/dag-authorize.mjs，移动端只做只读展示。
export const ACTION_LABELS = Object.freeze({
  worktree: '独立工作区', 'run-tests': '离线测试', 'push-branch': '推送分支',
  'create-pr': '创建 PR', 'independent-review': '独立审阅', 'rework-p0-p2': 'P0–P2 返工',
  'squash-merge': '审阅通过后合并', 'close-superseded-pr': '关闭被替代的 PR',
});
export const DENIED_LABELS = Object.freeze({
  deploy: '部署', release: '发布', 'production-write': '生产数据写入',
  credentials: '新建或读取其他凭据', 'external-communication': '对外通信',
});

// 总览四组的空态文案与网页版 public/views.mjs renderWorkSections 逐字一致。
export const OVERVIEW_GROUP_EMPTY = Object.freeze({
  running: '没有正在运行的任务。',
  retrying: '没有等待重试的任务。',
  doneToday: '今天还没有完成任务。',
  attention: '没有等待调度处理的事。',
});

export function emptyState(reason) { return { empty: true, reason }; }

// 所有列表统一成 collection：空列表带明确 reason，绝不返回「看起来有数据」的占位项。
export function collection(items, emptyReason, extra = {}) {
  const list = Array.isArray(items) ? items : [];
  return { items: list, empty: list.length === 0, reason: list.length ? null : emptyReason, ...extra };
}

export const titleOf = (value, fallback = '暂无概要') => String(value ?? '').trim() || fallback;
export const projectName = cwd => {
  const text = String(cwd ?? '').trim().replace(/[/]+$/, '');
  if (!text) return '未识别';
  return text.split(/[/]/).filter(Boolean).pop() || text;
};
export const formatTokens = value => Number(value || 0).toLocaleString('en-US');

// 计费口径与 public/status-sections.mjs billingText 一致：只信 Hub 自报值，缺失如实标注。
export function billingText(run) {
  const usage = run?.usage && typeof run.usage === 'object' && !Array.isArray(run.usage) ? run.usage : {};
  if (typeof usage.cost === 'number') return `$${usage.cost.toFixed(2)}`;
  if (typeof usage.input === 'number' || typeof usage.output === 'number') {
    return `${formatTokens((usage.input || 0) + (usage.output || 0))} Token · 费用未上报`;
  }
  return '费用未上报';
}

export function scheduleLabel(rule) {
  if (rule?.when?.cron) return `定时 · ${rule.when.cron}`;
  if (rule?.when?.source) return `${rule.when.source} · ${(rule.when.types || []).join(', ')}`;
  return '手动触发';
}

// 规则状态来自 Hub /v1/state 的 lines；没有对应行时 known=false，由调用方显示明确空态。
export function ruleStatus(line) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) {
    return { known: false, label: '状态未知', kind: '', detail: '' };
  }
  if (line.paused) {
    const reason = String(line.paused.reason || '未填写').trim();
    const until = line.paused.until ? `，至 ${line.paused.until}` : '';
    return { known: true, label: '已暂停', kind: 'warn', detail: `暂停原因 · ${reason}${until}` };
  }
  const totals = line.totals && typeof line.totals === 'object' ? line.totals : {};
  if (totals.running > 0) return { known: true, label: '运行中', kind: 'good', detail: `进行中 ${totals.running} 轮` };
  if (totals.retrying > 0) return { known: true, label: '等待重试', kind: 'warn', detail: `等待重试 ${totals.retrying} 轮` };
  if (totals.queued > 0) return { known: true, label: '排队中', kind: '', detail: `排队 ${totals.queued} 轮` };
  if (line.next) return { known: true, label: '待命', kind: '', detail: `下次运行 · ${line.next}` };
  return { known: true, label: '待命', kind: '', detail: '' };
}

// 轮次任务摘要/编号与 public/status-sections.mjs runTaskInfo 同口径，缺失不编造。
export function triggeringEvent(run) {
  const events = Array.isArray(run?.events) ? run.events : [];
  return events.find(event => event && (String(event.summary || '').trim() || String(event.subject || '').trim())) || events[0] || {};
}
// DAG 派发角色标签与 public/status-sections.mjs dagRoleLabel 同口径：只认 dev/review，回执等事件不加标签。
const DAG_ROLE_LABELS = Object.freeze({ dev: '开发', review: '审阅' });
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
  const summary = runText || String(event.summary || '').trim() || String(run?.rule || '').trim() || '暂无概要';
  const roleLabel = dagRoleLabel(run);
  return {
    roleLabel,
    taskSummary: roleLabel ? `【${roleLabel}】${summary}` : summary,
    taskNumber: String(event.subject || '').trim() || String(run?.id ?? ''),
  };
}
export function sameLocalDay(iso, now) {
  if (!iso) return false;
  const value = new Date(iso);
  return value.getFullYear() === now.getFullYear()
    && value.getMonth() === now.getMonth()
    && value.getDate() === now.getDate();
}
