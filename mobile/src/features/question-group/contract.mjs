// 会话内待回答组共享契约（Spec §8.2.4 / §8.3 / DAG 节点 question-group）。
// 纯函数、不触碰浏览器全局、不依赖 Node 内置模块：Node 边界测试与移动端打包器都可导入。
// 状态机口径见 groups.mjs；上游文本全程是纯字符串，由调用方用 textContent 之类安全方式渲染。

// 支持的三种作答方式：整卡选择、键盘文字、语音转写（语音结果落可编辑草稿）。
export const QUESTION_KINDS = Object.freeze(['choice', 'text', 'voice']);
export const QUESTION_KIND_LABELS = Object.freeze({
  choice: '选择', text: '文字', voice: '语音',
});
export const questionKindLabel = kind => QUESTION_KIND_LABELS[kind] || QUESTION_KIND_LABELS.text;

// 单题状态：待回答、提交失败（保留草稿可重试）、已回答（只读回看）。
export const QUESTION_STATES = Object.freeze(['pending', 'failed', 'answered']);
export const QUESTION_STATE_LABELS = Object.freeze({
  pending: '待回答', failed: '提交失败', answered: '已回答',
});
export const questionStateLabel = state => QUESTION_STATE_LABELS[state] || QUESTION_STATE_LABELS.pending;

// 组状态：仍有未答题 / 全部答完。
export const GROUP_STATES = Object.freeze(['active', 'complete']);

// 选择只选中、显式提交才发送，避免触摸误发（设计评审 §3.1）。
export const QUESTION_SELECT_AUTO_SUBMIT = false;
// 已成功回答的事项不重复提交（节点异常行为约束）。
export const QUESTION_RESUBMIT_ANSWERED = false;
// 整卡选项交互热区约 48dp。
export const QUESTION_OPTION_TOUCH_TARGET_DP = 48;
