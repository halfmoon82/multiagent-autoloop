// 待回答组状态机（Spec §8.2.4 / §8.3 / DAG 节点 question-group）：纯逻辑，无隐藏模块状态。
// 一次聚焦一道题；选项只选中不自动发送；失败保留题目/选项/草稿且不丢进度；已答不重复提交。
// 每次转移返回新对象，便于测试与 UI 逐帧比对；无变化时返回原对象，避免无谓重渲染。

import { QUESTION_KINDS, QUESTION_STATES, QUESTION_RESUBMIT_ANSWERED } from './contract.mjs';

const str = value => String(value ?? '');
const arr = value => (Array.isArray(value) ? value : []);

// 追加文本时只在两侧都不是标点/空白处补一个空格，避免「原稿，补一句」变成「原稿 ，补一句」。
const BOUNDARY_END = /[\s.,，。！？!?；;：:、]$/;
const BOUNDARY_START = /^[\s.,，。！？!?；;：:、]/;
function joinDraft(base, addition) {
  const head = str(base);
  const tail = str(addition);
  if (!tail) return head;
  if (!head) return tail;
  const needsSpace = !BOUNDARY_END.test(head) && !BOUNDARY_START.test(tail);
  return needsSpace ? `${head} ${tail}` : `${head}${tail}`;
}

export function createQuestion({ id = '', kind = 'text', prompt = '', options = [] } = {}) {
  return {
    id: str(id),
    kind: QUESTION_KINDS.includes(kind) ? kind : 'text',
    prompt: str(prompt),
    options: arr(options).map(str),
    selected: null,
    draft: '',
    state: 'pending',
    answer: null,
    error: null,
  };
}

export function createQuestionGroup({
  id = '', sessionId = '', sourceText = '', contextText = '', questions = [], scrollTop = 0,
} = {}) {
  const normalized = arr(questions).map(raw => (
    raw && typeof raw === 'object' && !Array.isArray(raw) ? createQuestion(raw) : createQuestion({ prompt: raw })
  ));
  const first = normalized.find(q => q.state === 'pending');
  return {
    id: str(id),
    sessionId: str(sessionId),
    sourceText: str(sourceText),
    contextText: str(contextText),
    questions: normalized,
    activeId: first ? first.id : null,
    answered: [],
    expanded: [],
    scrollTop: Number.isFinite(Number(scrollTop)) ? Number(scrollTop) : 0,
  };
}

// 按组 id 建独立实例，互不共享状态（不同会话的待回答组隔离）。
export function createQuestionGroups(groups = []) {
  const registry = {};
  for (const raw of arr(groups)) {
    const group = createQuestionGroup(raw);
    if (group.id) registry[group.id] = group;
  }
  return registry;
}

const findIndex = (group, questionId) => arr(group?.questions).findIndex(q => q.id === questionId);
function patchQuestion(group, index, patch) {
  const questions = [...group.questions];
  questions[index] = { ...questions[index], ...patch };
  return { ...group, questions };
}

// 整卡选择：只记录选中项，不自动提交；再选可改选；编辑视为重试，清掉旧错误。
export function selectOption(group, questionId, option) {
  if (!group || typeof group !== 'object') return group;
  const i = findIndex(group, questionId);
  if (i < 0 || group.questions[i].state === 'answered') return group;
  const value = str(option);
  if (group.questions[i].selected === value) return group;
  return patchQuestion(group, i, { selected: value, error: null });
}

// 键盘编辑：整段替换草稿，不发送。
export function setDraft(group, questionId, text = '') {
  if (!group || typeof group !== 'object') return group;
  const i = findIndex(group, questionId);
  if (i < 0 || group.questions[i].state === 'answered') return group;
  const draft = str(text);
  if (group.questions[i].draft === draft) return group;
  return patchQuestion(group, i, { draft, error: null });
}

// 语音转写结果落可编辑草稿，停顿/识别都不发送；手动可继续修改。
export function appendVoiceDraft(group, questionId, text = '') {
  if (!group || typeof group !== 'object') return group;
  const i = findIndex(group, questionId);
  if (i < 0 || group.questions[i].state === 'answered') return group;
  const draft = joinDraft(group.questions[i].draft, text);
  if (draft === group.questions[i].draft) return group;
  return patchQuestion(group, i, { draft, error: null });
}

// 通知/定位：聚焦指定题；未知题不改动。
export function focusQuestion(group, questionId) {
  if (!group || typeof group !== 'object') return group;
  if (findIndex(group, questionId) < 0 || group.activeId === questionId) return group;
  return { ...group, activeId: questionId };
}

// 提交当前/指定题。失败保留题目、选项、草稿且不推进；成功落答案并进入下一未答题；
// 已成功回答的事项不重复提交；空答案不提交。
export function submitAnswer(group, questionId, answer, { ok = true, error = null } = {}) {
  if (!group || typeof group !== 'object') return group;
  const i = findIndex(group, questionId);
  if (i < 0) return group;
  const question = group.questions[i];
  if (question.state === 'answered' && !QUESTION_RESUBMIT_ANSWERED) return group;

  if (ok === false) {
    const reason = str(error || '提交失败');
    if (question.state === 'failed' && question.error === reason) return group;
    return patchQuestion(group, i, { state: 'failed', error: reason });
  }

  const resolved = answer !== undefined && answer !== null
    ? str(answer)
    : (question.kind === 'choice' ? str(question.selected) : str(question.draft));
  if (!resolved) return group;

  const answered = group.answered.includes(questionId)
    ? [...group.answered]
    : [...group.answered, questionId];
  const questions = [...group.questions];
  questions[i] = { ...question, state: 'answered', answer: resolved, error: null };
  const next = questions.find(q => q.state !== 'answered');
  return { ...group, questions, answered, activeId: next ? next.id : null };
}

// 已答题默认折叠；展开只用于只读回看，不恢复编辑。
export function toggleAnswered(group, questionId) {
  if (!group || typeof group !== 'object') return group;
  const i = findIndex(group, questionId);
  if (i < 0 || group.questions[i].state !== 'answered') return group;
  const expanded = arr(group.expanded).includes(questionId)
    ? arr(group.expanded).filter(id => id !== questionId)
    : [...arr(group.expanded), questionId];
  return { ...group, expanded };
}

// 记住滚动位置：切页/旋转后恢复，不丢浏览进度。
export function setScrollTop(group, top) {
  if (!group || typeof group !== 'object') return group;
  const value = Number.isFinite(Number(top)) ? Number(top) : 0;
  if (group.scrollTop === value) return group;
  return { ...group, scrollTop: value };
}

export function remainingCount(group) {
  return arr(group?.questions).filter(q => q.state !== 'answered').length;
}

export function isComplete(group) {
  const questions = arr(group?.questions);
  return questions.length > 0 && questions.every(q => q.state === 'answered');
}

// 上下文保持：快照为可 JSON 化的纯数据；恢复时逐字段保留进度、草稿、折叠与滚动位置。
export function snapshotGroup(group) {
  return JSON.parse(JSON.stringify(group));
}

export function restoreGroup(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return createQuestionGroup();
  const questions = arr(snapshot.questions).map(raw => {
    const base = createQuestion(raw);
    return {
      ...base,
      selected: raw?.selected ?? null,
      draft: str(raw?.draft),
      state: QUESTION_STATES.includes(raw?.state) ? raw.state : 'pending',
      answer: raw?.answer ?? null,
      error: raw?.error ?? null,
    };
  });
  const activeId = questions.some(q => q.id === snapshot.activeId)
    ? snapshot.activeId
    : (questions.find(q => q.state !== 'answered')?.id ?? null);
  return {
    id: str(snapshot.id),
    sessionId: str(snapshot.sessionId),
    sourceText: str(snapshot.sourceText),
    contextText: str(snapshot.contextText),
    questions,
    activeId,
    answered: arr(snapshot.answered).map(str),
    expanded: arr(snapshot.expanded).map(str),
    scrollTop: Number.isFinite(Number(snapshot.scrollTop)) ? Number(snapshot.scrollTop) : 0,
  };
}
