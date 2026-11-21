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
