// 会话内待回答组与开放卡片的接缝：卡片来自 /api/state，作答走移动端 cards answer 写路由。
// 纯函数、不碰浏览器全局、不依赖 node: 内置模块；只映射真实字段，不编造题目或答案。

import { createQuestionGroup } from './groups.mjs';

const HANDLED_STATES = new Set(['decided', 'closed', 'cancelled', 'answered']);

// 每张开放卡片映射为一道题：有选项即整卡选择，无选项即文字/语音作答。
// 已处理/失效卡片不生成待答题，避免重复提交。
export function cardsToQuestionGroup(cards, { id = 'session-cards', sessionId = '' } = {}) {
  const questions = (Array.isArray(cards) ? cards : [])
    .filter(card => card && typeof card === 'object' && !Array.isArray(card)
      && card.id !== undefined && card.id !== null
      && !HANDLED_STATES.has(String(card.state ?? '').trim()))
    .map(card => {
      const options = (Array.isArray(card.options) ? card.options : []).map(option => String(option ?? ''));
      return {
        id: String(card.id),
        kind: options.length ? 'choice' : 'text',
        prompt: String(card.title || card.text || '请回答'),
        options,
      };
    });
  return createQuestionGroup({ id, sessionId, questions });
}

// 卡片回答载荷：选择题传选项下标，文字/语音传文本；未知选项回退文本，不静默改选。
export function answerPayload(question, answer) {
  const source = question && typeof question === 'object' ? question : {};
  const value = answer === undefined || answer === null ? String(source.draft ?? '') : String(answer);
  if (source.kind === 'choice' && Array.isArray(source.options) && source.options.includes(value)) {
    return { choice: source.options.indexOf(value) };
  }
  return { text: value };
}

// 会话归属过滤（fix4，2026-11-25 真机：别的会话的决策卡串进本会话）：卡片的 lane 是事项
// subject，与会话的 hubSubject 对应；有 lane 的卡只进对应会话，无 lane 的卡维持按项目归属。
// 会话没有 hubSubject（ACP 会话等）时只看无 lane 卡片，不抢别的会话的卡。
export function cardsForSession(cards, session) {
  const list = Array.isArray(cards) ? cards : [];
  const subject = String(session?.hubSubject ?? '').trim();
  const project = String(session?.project ?? '').trim();
  return list.filter(card => {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
    const lane = String(card.lane ?? '').trim();
    if (lane) return Boolean(subject) && lane === subject;
    return !card.project || String(card.project).trim() === project;
  });
}

// 回答成功后的本地同步（fix4，2026-11-25 真机：回答过的卡在别的会话/重建时又冒出来）：
// state.cards 是会话页重建待回答组的唯一来源，回答后必须把它标为已答，
// 与 cardsToQuestionGroup 的 HANDLED_STATES 过滤衔接；返回新数组，不改原数据。
export function markCardAnswered(cards, id, payload = {}) {
  const target = String(id ?? '');
  const answer = payload && payload.choice !== undefined
    ? { choice: Number(payload.choice) }
    : { text: String(payload?.text ?? '') };
  return (Array.isArray(cards) ? cards : []).map(card => (
    card && typeof card === 'object' && String(card.id) === target
      ? { ...card, state: 'answered', answer }
      : card
  ));
}
