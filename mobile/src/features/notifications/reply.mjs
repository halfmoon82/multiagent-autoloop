// 锁屏直复视图模型（Spec §7.2.4 / §7.2.6 / §7.2.8）：纯逻辑，无隐藏模块状态。
// 草稿是每次直复的临时 UI 状态，不属于通知去重状态；通知状态只有 src/notifier.mjs 一份。
// 失败时题目、选项与草稿保留，可重试；已处理或失效事项绝不重复提交。

import { DIRECT_REPLY_REQUIRES_BIOMETRIC, NOTIFICATION_KINDS } from './contract.mjs';

// 接受 todo descriptor（buildTodoNotification 产物）或原始待办卡片。
export function createReplyDraft(source = {}, draftText = '') {
  const src = source && typeof source === 'object' ? source : {};
  const isDescriptor = src.kind === NOTIFICATION_KINDS.TODO;
  const title = isDescriptor
    ? (src.summary ?? '待处理事项')
    : (src.title ?? src.summary ?? '待处理事项');
  const options = isDescriptor
    ? (Array.isArray(src.reply?.choices) ? src.reply.choices.map(choice => choice.label ?? choice.id) : [])
    : (Array.isArray(src.options) ? src.options.map(String) : []);
  const cardId = isDescriptor ? (src.click?.cardId ?? null) : (src.id ?? src.cardId ?? null);
  const requiresBiometric = isDescriptor
    ? (src.reply?.requiresBiometric !== false)
    : DIRECT_REPLY_REQUIRES_BIOMETRIC;
  return {
    cardId,
    title: String(title),
    options: options.map(String),
    draft: String(draftText ?? ''),
    requiresBiometric,
    submitted: false,
    invalid: false,
    error: null,
  };
}

export function canSubmitReply(draft) {
  return Boolean(draft) && draft.submitted !== true && draft.invalid !== true;
}

export function markReplySubmitted(draft) {
  return { ...draft, submitted: true, error: null };
}

// 失败保留题目、选项、草稿，并允许重试（submitted 保持 false）。
export function applyReplyFailure(draft, error) {
  return { ...draft, submitted: false, error: String(error?.message ?? error ?? '提交失败') };
}

function validAnswer(answer, options) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
  if (answer.type === 'choice') return options.map(String).includes(String(answer.optionId));
  if (answer.type === 'text') return String(answer.text ?? '').trim().length > 0;
  return false;
}

// 提交顺序：已处理/失效门禁 → 答案校验 → 生物识别门禁 → 提交通道。
// 任一失败都返回保留草稿的 draft，不调用 submit；不重复提交已处理事项。
export async function submitReply(draft, answer, { submit, verifyBiometric } = {}) {
  if (!canSubmitReply(draft)) {
    return { ok: false, reason: draft?.invalid ? 'invalid' : 'already-processed', draft };
  }
  if (!validAnswer(answer, draft.options)) {
    return { ok: false, reason: 'invalid-answer', draft };
  }
  if (draft.requiresBiometric) {
    let verified = false;
    try { verified = Boolean(await (typeof verifyBiometric === 'function' ? verifyBiometric() : false)); }
    catch { verified = false; }
    if (!verified) return { ok: false, reason: 'biometric-failed', draft };
  }
  if (typeof submit !== 'function') {
    return { ok: false, reason: 'submit-failed', draft: applyReplyFailure(draft, new Error('缺少提交通道')) };
  }
  try {
    await submit(answer);
    return { ok: true, draft: markReplySubmitted(draft) };
  } catch (error) {
    return { ok: false, reason: 'submit-failed', draft: applyReplyFailure(draft, error) };
  }
}
