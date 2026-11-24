// 输入框自动长高（DAG 节点 session-inputs）：纯逻辑 + 一个薄 DOM 适配层。
// 规则：最少 2 行；随内容长高，最多 5 行或主区高度的 38%（取较小者，但不低于最少行数）；
// 超出上限后固定高度、内部滚动；清空（如发送后）回弹到最少行数。键盘/语音/粘贴任何来源都走同一入口。

export const AUTOGROW_MIN_ROWS = 2;
export const AUTOGROW_MAX_ROWS = 5;
export const AUTOGROW_MAX_VIEWPORT_RATIO = 0.38;
export const AUTOGROW_EVENT = 'autoloop-autogrow';
const FALLBACK_LINE_HEIGHT = 24;

const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

/**
 * 计算目标高度。contentHeight 为内容完整高度（含内边距与边框，即 scrollHeight + 边框）。
 * extraY 为上下内边距与边框之和；mainHeight 为主区可用高度（缺失则只受最大行数限制）。
 */
export function computeAutogrow({
  contentHeight = 0, lineHeight = FALLBACK_LINE_HEIGHT, extraY = 0,
  minRows = AUTOGROW_MIN_ROWS, maxRows = AUTOGROW_MAX_ROWS, mainHeight = null,
} = {}) {
  const line = positive(lineHeight, FALLBACK_LINE_HEIGHT);
  const extra = Number.isFinite(extraY) && extraY > 0 ? extraY : 0;
  const min = Math.max(1, Math.floor(minRows));
  const max = Math.max(min, Math.floor(maxRows));
  const minHeight = min * line + extra;
  let cap = max * line + extra;
  if (Number.isFinite(mainHeight) && mainHeight > 0) cap = Math.min(cap, mainHeight * AUTOGROW_MAX_VIEWPORT_RATIO);
  cap = Math.max(minHeight, cap); // 小屏下也保证最少行数可用
  const wanted = Math.max(minHeight, Number.isFinite(contentHeight) ? contentHeight : 0);
  const height = Math.min(wanted, cap);
  return {
    height,
    rows: Math.max(min, Math.round((height - extra) / line)),
    overflow: wanted > cap,
  };
}

/** 发送按钮是否可用：空白内容禁用。 */
export function canSend(text) {
  return String(text ?? '').trim().length > 0;
}

const px = value => Number.parseFloat(value) || 0;

/** DOM 适配：按当前内容重算高度并写回样式。返回计算结果；无 DOM 能力时返回 null。 */
export function applyAutogrow(el, { mainHeight = null, maxRows = AUTOGROW_MAX_ROWS } = {}) {
  if (!el || !el.style || typeof globalThis.getComputedStyle !== 'function') return null;
  const style = globalThis.getComputedStyle(el);
  const fontSize = px(style.fontSize) || 16;
  const lineHeight = px(style.lineHeight) || fontSize * 1.5;
  const extraY = px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth);
  el.style.height = '0px'; // 先收到最小才能量到真实内容高度（内容变短时才能回弹，不受 rows 属性影响）
  const result = computeAutogrow({
    contentHeight: el.scrollHeight + px(style.borderTopWidth) + px(style.borderBottomWidth),
    lineHeight, extraY, mainHeight, maxRows,
  });
  el.style.height = `${Math.ceil(result.height)}px`;
  el.style.overflowY = result.overflow ? 'auto' : 'hidden';
  return result;
}

/** 挂载：输入事件（含语音落草稿派发的 input）与专用预览事件都触发同一次重算。返回 { refresh, detach }。 */
export function attachAutogrow(el, { getMainHeight = () => null, maxRows = AUTOGROW_MAX_ROWS } = {}) {
  if (!el || typeof el.addEventListener !== 'function') return { refresh() {}, detach() {} };
  const refresh = () => applyAutogrow(el, { mainHeight: getMainHeight(), maxRows });
  el.addEventListener('input', refresh);
  el.addEventListener(AUTOGROW_EVENT, refresh);
  refresh();
  return {
    refresh,
    detach() {
      el.removeEventListener('input', refresh);
      el.removeEventListener(AUTOGROW_EVENT, refresh);
    },
  };
}

// ---- 输入区体验（DAG 节点 composer-ux）：输入框上限、自适应轮询、乐观上屏 ----

/** 会话输入框自动增高上限约 4 行（通用上限 AUTOGROW_MAX_ROWS 保持不变，供新建表单等沿用）。 */
export const COMPOSER_MAX_ROWS = 4;
export const POLL_BUSY_MS = 1000;
export const POLL_IDLE_MS = 5000;
/** 本地「Agent 正在响应」态最长保留时长：服务端迟迟不报 busy 时也不会永远转圈。 */
export const RESPONDING_TTL_MS = 30000;

/**
 * 详情轮询间隔：页面隐藏返回 null（不轮询）；本轮进行中（busy / turnStartedAt / 本地响应态）1 秒；空闲 5 秒。
 */
export function pollIntervalMs({ hidden = false, busy = false, turnStartedAt = null, responding = false } = {}) {
  if (hidden) return null;
  return busy === true || responding === true || Boolean(turnStartedAt) ? POLL_BUSY_MS : POLL_IDLE_MS;
}

/** 本地响应态是否仍有效：发送时间在 TTL 内。 */
export function isResponding(since, now = Date.now(), ttl = RESPONDING_TTL_MS) {
  return Number.isFinite(since) && since > 0 && now - since < ttl;
}

/** 乐观上屏：发送中的主人消息，带本地 id 以便失败重发时复用同一条（不重复入账）。 */
export function optimisticMessage(text, localId) {
  return { role: '主人', text: String(text ?? ''), at: '', localId, sendState: 'sending' };
}

/** 按本地 id 更新发送状态（sending → sent / failed），返回新数组；未命中则原样返回。 */
export function settleMessage(messages, localId, sendState) {
  if (!Array.isArray(messages) || !messages.some(m => m?.localId === localId)) return messages;
  return messages.map(m => (m?.localId === localId ? { ...m, sendState } : m));
}
