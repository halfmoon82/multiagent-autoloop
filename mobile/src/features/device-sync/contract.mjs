// 多设备状态同步共享契约（Spec §7 / DAG plan wave-5 / issue 12）。
// 纯函数：不触碰浏览器全局、不依赖 Node 内置模块，移动端打包器与 Node 边界测试都可导入。
// 后端（src/device-auth.mjs）是唯一业务状态源；本模块只定义共享状态形状与清洗规则，
// 不新建第二套业务状态。判定只走白名单结论，绝不透传上游文本、令牌或秘密。

export const SYNC_SCHEMA = 1;
export const DECISION_KINDS = Object.freeze(['approve', 'reject', 'note']);
export const MAX_STATE_ENTRIES = 500;

export class SyncStateError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'SyncStateError';
    this.status = status;
    this.code = code;
  }
}

export function createSyncState() {
  return { revision: 0, decisions: {}, updatedAt: null };
}

function safeKey(key) {
  const value = String(key ?? '').trim();
  return value && value.length <= 128 ? value : null;
}

// 单条结论只保留白名单字段；value 必须是枚举之一，byDevice 限定来源标识，at 为时间字符串。
function safeDecision(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const value = DECISION_KINDS.includes(entry.value) ? entry.value : null;
  const byDevice = String(entry.byDevice ?? '').trim().slice(0, 80);
  const at = typeof entry.at === 'string' ? entry.at : null;
  if (!value || !byDevice || !at) return null;
  return { value, byDevice, at };
}

// 规范化外部/落盘状态：缺省、类型错误或字段不合法一律回退空且一致的状态。
export function normalizeSyncState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createSyncState();
  const revision = Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : 0;
  const raw = value.decisions && typeof value.decisions === 'object' && !Array.isArray(value.decisions) ? value.decisions : {};
  const decisions = {};
  for (const [key, entry] of Object.entries(raw)) {
    const k = safeKey(key);
    const decision = safeDecision(entry);
    if (k && decision) decisions[k] = decision;
  }
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : null;
  return { revision, decisions, updatedAt };
}
