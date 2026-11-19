// font-touch 共享契约（Spec §9.6–§9.12 / §9.3 / 设计评审 §3.4 / DAG 节点 font-touch）。
// 常量与纯词条，不触碰浏览器全局、不依赖 Node 内置模块：Node 边界测试与移动端打包器都可导入。
// 本模块只定义口径与词表，不放缩放/状态算法（见 font.mjs、touch.mjs），视图投影见 views.mjs。

// Spec §9.6 + 设计评审 §3.4：字体跟随系统设置，原型提供 100%／130%／160% 检查档。
export const FONT_SCALE_STEPS = Object.freeze([100, 130, 160]);
export const FONT_SCALE_DEFAULT = 100;
export const FONT_SCALE_MIN = 100;
export const FONT_SCALE_MAX = 160;

// 原生字体度量基准（dp）。放大靠度量重排，不靠网页缩放。
export const FONT_BASE_DP = 16;

// 设计评审 §3.4：正文、长问题、选项、输入框、产物文档、错误信息都参与缩放。
export const FONT_SURFACES = Object.freeze([
  'body', 'long-question', 'option', 'input', 'artifact-doc', 'error',
]);

// Spec §9.8／§9.9：放大后换行、容器增高、纵向滚动；不截断、不遮挡、不把正文强制压成横向滚动。
// Spec §9.7：使用原生字体度量，不以网页缩放代替。
export const FONT_LAYOUT_POLICY = Object.freeze({
  wrap: true,
  growContainer: true,
  verticalScroll: true,
  horizontalScroll: false,
  truncate: false,
  occlude: false,
  nativeFontMetrics: true,
  webZoom: false,
});

// Spec §9.10：图标视觉轻巧，但交互热区扩张至约 44–48 dp。
export const TOUCH_TARGET_MIN_DP = 44;
export const TOUCH_TARGET_MAX_DP = 48;
export const ICON_VISUAL_DP = 22;

// Spec §9.11：整卡选项有清晰按压、选中和禁用状态。
export const OPTION_STATES = Object.freeze(['idle', 'pressed', 'selected', 'disabled']);
export const OPTION_STATE_LABELS = Object.freeze({
  idle: '默认', pressed: '按压', selected: '选中', disabled: '禁用',
});
export const optionStateLabel = state => OPTION_STATE_LABELS[state] || OPTION_STATE_LABELS.idle;
