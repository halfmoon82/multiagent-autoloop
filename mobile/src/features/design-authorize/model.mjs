// 设计授权（确认执行范围）纯逻辑：把 /api/dag-plan 与 /api/dag-preflight 的真实数据整理成
// 可逐条出示的视图模型，并决定能否提交。不碰 DOM、不发请求；上游文本由调用方用 textContent 渲染。
// 口径与网页 public/dag-authorize.mjs 一致：提交前提 = 已出示全部范围 + 用户勾选「已阅读」。

export const ACTION_LABELS = Object.freeze({
  worktree: ['独立 worktree', '固定槽位，互不写入，主 checkout 只读'],
  'run-tests': ['离线测试', 'verify 使用固定命令，不执行依赖安装脚本'],
  'push-branch': ['推送分支', '只推送到本项目的 DAG 分支'],
  'create-pr': ['创建 PR', '每个节点一个 PR'],
  'independent-review': ['独立审阅', '审阅同一 commit，P0–P2 必须清零'],
  'rework-p0-p2': ['P0–P2 返工', '三次未收敛先换打法，再决定是否升级'],
  'squash-merge': ['审阅通过后 squash 合并', '远端 head 必须等于已审 commit'],
  'close-superseded-pr': ['替代旧 attempt 的 PR', '仅关闭本 DAG 登记的 PR 并附说明'],
});
export const DENIED_LABELS = Object.freeze({
  deploy: '部署', release: '发布', 'production-write': '生产数据写入',
  credentials: '新建或读取其他凭据', 'external-communication': '对外通信',
});

const list = value => (Array.isArray(value) ? value : []);
const text = value => String(value ?? '').trim();

// 逐条出示：缺字段不编造，缺失处给明确说明。plan 缺失或无 planDigest 时 ready=false，不可提交。
export function buildAuthorizeView(plan, preflight = null, { acknowledged = false, submitting = false, created = null } = {}) {
  const ready = Boolean(plan && text(plan.planDigest) && Array.isArray(plan.nodes));
  const nodes = ready ? plan.nodes.map(node => ({
    id: text(node.id),
    title: text(node.title) || text(node.id),
    wave: Number.isFinite(node.wave) ? node.wave : null,
    files: list(node.files).map(text).filter(Boolean),
    dependsOn: list(node.dependsOn).map(text).filter(Boolean),
    integrationReview: node.integrationReview === true,
  })) : [];
  const allowed = list(plan?.allowedActions).map(id => ({ id: text(id), label: (ACTION_LABELS[id] || [text(id)])[0], note: (ACTION_LABELS[id] || [])[1] || '' }));
  const denied = list(plan?.deniedActions).map(id => ({ id: text(id), label: DENIED_LABELS[id] || text(id) }));
  const checks = list(preflight?.checks).map(check => ({ id: text(check.id), label: text(check.label) || text(check.id), ok: check.ok === true, message: text(check.message) }));
  const business = nodes.filter(node => !node.integrationReview).length;
  return {
    ready,
    title: ready ? (text(plan.title) || text(plan.planId)) : '',
    planId: ready ? text(plan.planId) : '',
    planDigest: ready ? text(plan.planDigest) : '',
    project: text(plan?.project),
    remoteUrl: text(plan?.remoteUrl) || null,
    remoteLabel: text(plan?.remoteUrl) || '未发现远端（不能推送）',
    summary: ready ? { businessNodes: business, reviewNodes: nodes.length - business, maxParallel: plan.maxParallel ?? null } : null,
    nodes, allowed, denied, checks,
    optionalActions: list(plan?.optionalActions).map(item => ({ id: text(item?.id), label: text(item?.label) || text(item?.id) })),
    acknowledged: acknowledged === true,
    created: created || null,
    // 未勾选、未读到计划、提交中或已创建，一律不可提交。
    canSubmit: ready && acknowledged === true && !submitting && !created && allowed.length > 0,
  };
}

// 提交体：planDigest 与动作清单原样来自服务端计划（服务端会再校验）；未勾选「已阅读」不产出请求体。
export function buildCreateBody(plan, { acknowledged = false } = {}) {
  if (acknowledged !== true) return null;
  if (!plan || !text(plan.planDigest) || !text(plan.project) || !text(plan.planId)) return null;
  const actions = list(plan.allowedActions).map(text).filter(Boolean);
  if (!actions.length) return null;
  return {
    project: text(plan.project), planId: text(plan.planId), planDigest: text(plan.planDigest),
    ...(text(plan.remoteUrl) ? { remoteUrl: text(plan.remoteUrl) } : {}),
    confirm: true, confirmedActionIds: actions, selectedOptionalActions: [],
  };
}
