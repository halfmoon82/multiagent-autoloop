// question-group 节点（Spec §8.2.4 / §8.3 / DAG 节点 question-group）边界测试：
// 会话内待回答组、进度轨、逐题作答、已答题折叠回看与上下文保持。
// 纯逻辑：feature 不碰 DOM、不依赖 node: 内置模块；无隐藏状态，纯函数返回新对象。
// 上游文本全程是纯字符串，由调用方用 textContent 之类安全方式渲染。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUESTION_KINDS, QUESTION_KIND_LABELS, questionKindLabel,
  QUESTION_STATES, QUESTION_STATE_LABELS, questionStateLabel,
  GROUP_STATES,
  QUESTION_SELECT_AUTO_SUBMIT, QUESTION_RESUBMIT_ANSWERED, QUESTION_OPTION_TOUCH_TARGET_DP,
  createQuestion, createQuestionGroup, createQuestionGroups,
  selectOption, setDraft, appendVoiceDraft, focusQuestion,
  submitAnswer, toggleAnswered, setScrollTop,
  snapshotGroup, restoreGroup, remainingCount, isComplete,
  buildQuestionGroupBinding,
} from '../mobile/src/features/question-group/index.mjs';

const FEATURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'src', 'features', 'question-group');

function threeQuestionGroup(overrides = {}) {
  return createQuestionGroup({
    id: 'g1', sessionId: 's1',
    sourceText: '请确认以下三件事',
    contextText: '来自项目 A 的调度会话',
    questions: [
      { id: 'q1', kind: 'choice', prompt: '选哪种方案？', options: ['方案甲', '方案乙'] },
      { id: 'q2', kind: 'text', prompt: '补充背景？' },
      { id: 'q3', kind: 'voice', prompt: '口述确认？' },
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// RED 1：契约词表与常量（三种输入、待答/失败/已答三态、进度组两态）
// ---------------------------------------------------------------------------
test('契约词表覆盖选择/文字/语音三种输入与待答/失败/已答三态，不编造', () => {
  assert.deepEqual(QUESTION_KINDS, ['choice', 'text', 'voice']);
  for (const kind of QUESTION_KINDS) assert.equal(typeof QUESTION_KIND_LABELS[kind], 'string');
  assert.equal(questionKindLabel('voice'), '语音');
  assert.equal(questionKindLabel('unknown'), QUESTION_KIND_LABELS.text, '未知输入回退文字，不编造');
  assert.deepEqual(QUESTION_STATES, ['pending', 'failed', 'answered']);
  assert.equal(questionStateLabel('failed'), '提交失败');
  assert.equal(questionStateLabel('weird'), QUESTION_STATE_LABELS.pending);
  assert.deepEqual([...GROUP_STATES], ['active', 'complete']);
});

// ---------------------------------------------------------------------------
// RED 2：选择不自动发送、不重复提交已答；整卡热区
// ---------------------------------------------------------------------------
test('选择整卡最小 48dp 热区；选择不自动提交；不重复提交已答', () => {
  assert.equal(QUESTION_OPTION_TOUCH_TARGET_DP, 48);
  assert.equal(QUESTION_SELECT_AUTO_SUBMIT, false, '选择只选中，显式提交才发送');
  assert.equal(QUESTION_RESUBMIT_ANSWERED, false, '已答事项不重复提交');
});

// ---------------------------------------------------------------------------
// RED 3：初始态与第一道未答题聚焦
// ---------------------------------------------------------------------------
test('createQuestionGroup 初态聚焦第一道未答题，进度轨为 0/N', () => {
  const group = threeQuestionGroup();
  assert.equal(group.id, 'g1');
  assert.equal(group.sessionId, 's1');
  assert.equal(group.sourceText, '请确认以下三件事');
  assert.equal(group.questions.length, 3);
  assert.deepEqual(group.questions.map(q => q.state), ['pending', 'pending', 'pending']);
  assert.equal(group.activeId, 'q1', '默认聚焦第一道未答题');
  assert.equal(remainingCount(group), 3);
  assert.deepEqual(group.answered, []);
  assert.equal(group.scrollTop, 0);
  const binding = buildQuestionGroupBinding(group);
  assert.equal(binding.total, 3);
  assert.equal(binding.answeredCount, 0);
  assert.equal(binding.remaining, 3);
  assert.equal(binding.percent, 0);
  assert.equal(binding.state, 'active');
});

test('createQuestion 归一化单题；createQuestionGroups 空列表返回空表', () => {
  const q = createQuestion({ id: 'q1', kind: 'choice', prompt: '题', options: ['A', 'B'] });
  assert.equal(q.kind, 'choice');
  assert.deepEqual(q.options, ['A', 'B']);
  assert.equal(q.state, 'pending');
  assert.equal(q.draft, '');
  assert.deepEqual(createQuestionGroups([]), {});
});

// ---------------------------------------------------------------------------
// RED 4：整卡选择只选中、可改选，不自动提交
// ---------------------------------------------------------------------------
test('选项整卡只选中不提交，提交按钮可用但状态仍是待答', () => {
  const group = threeQuestionGroup();
  const selected = selectOption(group, 'q1', '方案乙');
  assert.equal(selected.questions[0].selected, '方案乙');
  assert.equal(selected.questions[0].state, 'pending', '选择不自动提交');
  assert.equal(selected.activeId, 'q1');
  assert.equal(remainingCount(selected), 3);
  const binding = buildQuestionGroupBinding(selected);
  assert.equal(binding.active.canSubmit, true);
  assert.equal(binding.active.answerInput, 'choice');
  assert.equal(binding.active.selected, '方案乙');
  assert.equal(binding.active.touchTargetDp, 48);
  const changed = selectOption(selected, 'q1', '方案甲');
  assert.equal(changed.questions[0].selected, '方案甲', '整卡再选可改选');
});

// ---------------------------------------------------------------------------
// RED 5：文字/语音草稿可编辑，语音结果落草稿不发送，手动可改
// ---------------------------------------------------------------------------
test('文字与语音草稿可编辑：语音结果落草稿、不自动提交，手动可改', () => {
  let group = threeQuestionGroup();
  group = appendVoiceDraft(group, 'q2', '背景是测试');
  assert.equal(group.questions[1].draft, '背景是测试');
  assert.equal(group.questions[1].state, 'pending');
  assert.equal(group.activeId, 'q1', '草稿不改变聚焦');
  group = setDraft(group, 'q2', '背景是测试，补充');
  assert.equal(group.questions[1].draft, '背景是测试，补充');

  group = focusQuestion(group, 'q2');
  const textBinding = buildQuestionGroupBinding(group).active;
  assert.equal(textBinding.kind, 'text');
  assert.equal(textBinding.answerInput, 'keyboard');
  assert.equal(textBinding.draft, '背景是测试，补充');
  assert.equal(textBinding.canSubmit, true);

  group = focusQuestion(group, 'q3');
  assert.equal(buildQuestionGroupBinding(group).active.answerInput, 'voice', '语音题可用语音输入');
});

// ---------------------------------------------------------------------------
// RED 6：逐题提交推进、已答题折叠回看、空答案不提交
// ---------------------------------------------------------------------------
test('逐题提交推进到下一未答题，已答题折叠保留并可展开只读回看', () => {
  const empty = threeQuestionGroup();
  assert.equal(submitAnswer(empty, 'q2'), empty, '空答案不提交、不推进');

  let group = threeQuestionGroup();
  group = selectOption(group, 'q1', '方案甲');
  group = submitAnswer(group, 'q1');
  assert.equal(group.questions[0].state, 'answered');
  assert.equal(group.questions[0].answer, '方案甲');
  assert.deepEqual(group.answered, ['q1']);
  assert.equal(group.activeId, 'q2', '提交后进入下一未答题');
  assert.equal(remainingCount(group), 2);

  group = setDraft(group, 'q2', '补充说明');
  group = submitAnswer(group, 'q2');
  assert.equal(group.activeId, 'q3');
  assert.deepEqual(group.answered, ['q1', 'q2']);

  group = appendVoiceDraft(group, 'q3', '确认无误');
  group = submitAnswer(group, 'q3');
  assert.equal(group.activeId, null, '全部答完无未答题');
  assert.equal(isComplete(group), true);
  assert.equal(remainingCount(group), 0);

  const binding = buildQuestionGroupBinding(group);
  assert.equal(binding.state, 'complete');
  assert.equal(binding.percent, 100);
  assert.equal(binding.answeredList.length, 3);
  assert.equal(binding.answeredList[0].collapsed, true, '已答题默认折叠');
  group = toggleAnswered(group, 'q1');
  const reopened = buildQuestionGroupBinding(group);
  assert.equal(reopened.answeredList[0].collapsed, false, '可展开回看');
  assert.equal(reopened.answeredList[0].answer, '方案甲');
});

// ---------------------------------------------------------------------------
// RED 7：提交失败保留题目/选项/草稿与进度，可原样重试
// ---------------------------------------------------------------------------
test('提交失败保留题目/选项/草稿与进度，可原样重试', () => {
  let group = threeQuestionGroup();
  group = selectOption(group, 'q1', '方案乙');
  group = submitAnswer(group, 'q1', null, { ok: false, error: '网络超时' });
  assert.equal(group.questions[0].state, 'failed');
  assert.equal(group.questions[0].selected, '方案乙', '选项保留');
  assert.equal(group.questions[0].error, '网络超时');
  assert.equal(group.activeId, 'q1', '仍聚焦失败题');
  assert.equal(remainingCount(group), 3, '进度不丢');
  const failed = buildQuestionGroupBinding(group);
  assert.equal(failed.active.stateLabel, '提交失败');
  assert.equal(failed.active.selected, '方案乙');
  assert.equal(failed.answeredCount, 0);

  group = submitAnswer(group, 'q1', null, { ok: true });
  assert.equal(group.questions[0].state, 'answered');
  assert.equal(group.questions[0].answer, '方案乙', '重试沿用保留的选项');
  assert.equal(group.activeId, 'q2');
  assert.equal(remainingCount(group), 2);
});

// ---------------------------------------------------------------------------
// RED 8：已成功回答的事项不重复提交
// ---------------------------------------------------------------------------
test('已成功回答的事项不重复提交', () => {
  let group = threeQuestionGroup();
  group = selectOption(group, 'q1', '方案甲');
  group = submitAnswer(group, 'q1');
  const again = submitAnswer(group, 'q1', '另一个答案', { ok: true });
  assert.equal(again, group, '已答再提交原样返回，不产生新提交');
  assert.deepEqual(again.answered, ['q1']);
  assert.equal(again.activeId, 'q2', '不因重复提交再次推进');
});

// ---------------------------------------------------------------------------
// RED 9：上下文保持、多会话隔离、通知定位、滚动位置
// ---------------------------------------------------------------------------
test('切页/旋转上下文保持：快照恢复保留进度、草稿、折叠与滚动位置', () => {
  let group = threeQuestionGroup();
  group = selectOption(group, 'q1', '方案甲');
  group = submitAnswer(group, 'q1');
  group = setDraft(group, 'q2', '草稿');
  group = toggleAnswered(group, 'q1');
  group = setScrollTop(group, 128);
  const snapshot = snapshotGroup(group);
  assert.deepEqual(snapshot, JSON.parse(JSON.stringify(snapshot)), '快照是可 JSON 化的纯数据');
  const restored = restoreGroup(snapshot);
  assert.deepEqual(buildQuestionGroupBinding(restored), buildQuestionGroupBinding(group), '恢复后视图完全一致');
  assert.equal(restored.scrollTop, 128);
  assert.equal(restored.questions[1].draft, '草稿');
  assert.equal(restored.expanded.includes('q1'), true);
  assert.deepEqual(restored.answered, ['q1']);
});

test('多会话待回答组互不共享状态；通知可定位到指定失败题', () => {
  const registry = createQuestionGroups([
    { id: 'g1', sessionId: 's1', questions: [{ id: 'q1', kind: 'choice', prompt: 'A', options: ['x'] }, { id: 'q2', kind: 'text', prompt: 'B' }] },
    { id: 'g2', sessionId: 's2', questions: [{ id: 'q1', kind: 'choice', prompt: 'C', options: ['y'] }] },
  ]);
  assert.deepEqual(Object.keys(registry), ['g1', 'g2']);
  registry.g1 = selectOption(registry.g1, 'q1', 'x');
  registry.g1 = submitAnswer(registry.g1, 'q1');
  assert.equal(registry.g1.questions[0].state, 'answered');
  assert.equal(registry.g2.questions[0].state, 'pending', '另一会话不受影响');

  let group = threeQuestionGroup();
  group = submitAnswer(group, 'q2', 'x', { ok: false, error: '失败' });
  const focused = focusQuestion(group, 'q2');
  assert.equal(focused.activeId, 'q2', '可定位到失败题');
  assert.equal(focusQuestion(focused, 'missing'), focused, '未知题无副作用');
});

// ---------------------------------------------------------------------------
// RED 10：视图模型安全渲染，不拼接 HTML、不泄漏凭据
// ---------------------------------------------------------------------------
test('视图模型文本原样返回、不拼接 HTML、不泄漏凭据', () => {
  const binding = buildQuestionGroupBinding(threeQuestionGroup());
  const dump = JSON.stringify(binding);
  assert.equal(typeof binding.sourceText, 'string');
  assert.equal(typeof binding.active.prompt, 'string');
  assert.equal(Object.hasOwn(binding, 'html'), false);
  assert.ok(!dump.includes('<script') && !dump.includes('</div>') && !dump.includes('onerror='));
  assert.ok(!dump.includes('deviceToken') && !dump.includes('server-secret') && !dump.includes('apiKey'));
});

// ---------------------------------------------------------------------------
// RED 11：纯逻辑守门
// ---------------------------------------------------------------------------
test('feature 是纯逻辑：不依赖 node: 内置模块、不碰 DOM、不拼接 HTML', () => {
  const files = readdirSync(FEATURE_DIR).filter(name => name.endsWith('.mjs'));
  assert.ok(files.length > 0, 'feature 目录至少有一个 .mjs');
  for (const name of files) {
    const source = readFileSync(path.join(FEATURE_DIR, name), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(source), `${name} 不得 import node: 内置模块`);
    assert.ok(!/\bdocument\.|\bwindow\.|\blocalStorage\b/.test(source.replace(/\/\/.*$/gm, '')), `${name} 不得直接碰 DOM/浏览器存储`);
    assert.ok(!/innerHTML|insertAdjacentHTML/.test(source), `${name} 不得拼接 HTML`);
  }
});
