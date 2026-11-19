// 待回答组视图模型（Spec §8.2.4 / §8.3 / DAG 节点 question-group）：
// 把状态机投影成「进度轨 + 当前聚焦题 + 已答题折叠列表」的普通对象，供会话流统一装配。
// 不发请求、不启动识别、不拼接 HTML；上游文本原样以字符串返回，由调用方用 textContent 安全渲染。

import {
  questionKindLabel, questionStateLabel, QUESTION_OPTION_TOUCH_TARGET_DP,
} from './contract.mjs';
import { remainingCount, isComplete } from './groups.mjs';

const str = value => String(value ?? '');
const arr = value => (Array.isArray(value) ? value : []);

function answerInputOf(kind) {
  if (kind === 'choice') return 'choice';
  if (kind === 'voice') return 'voice';
  return 'keyboard';
}

function canSubmit(question) {
  if (!question || question.state === 'answered') return false;
  if (question.kind === 'choice') return Boolean(str(question.selected));
  return Boolean(str(question.draft));
}

export function buildQuestionGroupBinding(group) {
  const questions = arr(group?.questions);
  const activeQuestion = questions.find(q => q.id === group?.activeId)
    || questions.find(q => q.state !== 'answered')
    || null;
  const expanded = arr(group?.expanded);
  const answeredList = arr(group?.answered)
    .map(id => questions.find(q => q.id === id))
    .filter(Boolean)
    .map(q => ({
      id: q.id,
      prompt: str(q.prompt),
      kind: q.kind,
      kindLabel: questionKindLabel(q.kind),
      answer: str(q.answer),
      collapsed: !expanded.includes(q.id),
    }));
  const total = questions.length;
  const answeredCount = answeredList.length;

  return {
    id: str(group?.id),
    sessionId: str(group?.sessionId),
    sourceText: str(group?.sourceText),
    contextText: str(group?.contextText),
    total,
    answeredCount,
    remaining: remainingCount(group),
    percent: total ? Math.round((answeredCount / total) * 100) : 0,
    state: isComplete(group) ? 'complete' : 'active',
    active: activeQuestion ? {
      id: activeQuestion.id,
      kind: activeQuestion.kind,
      kindLabel: questionKindLabel(activeQuestion.kind),
      prompt: str(activeQuestion.prompt),
      options: arr(activeQuestion.options).map(str),
      selected: activeQuestion.selected ?? null,
      draft: str(activeQuestion.draft),
      state: activeQuestion.state,
      stateLabel: questionStateLabel(activeQuestion.state),
      answerInput: answerInputOf(activeQuestion.kind),
      canSubmit: canSubmit(activeQuestion),
      touchTargetDp: QUESTION_OPTION_TOUCH_TARGET_DP,
      error: activeQuestion.error ?? null,
    } : null,
    answeredList,
    scrollTop: Number.isFinite(Number(group?.scrollTop)) ? Number(group.scrollTop) : 0,
  };
}
