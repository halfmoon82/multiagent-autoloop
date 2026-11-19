// 语音输入共享契约（Spec §9.2 / §9.3 / DAG 节点 voice-input）。
// 纯函数、不触碰浏览器全局、不依赖 Node 内置模块：Node 边界测试与移动端打包器都可导入。
// 状态机口径见 voice.mjs；上游文本全程是纯字符串，由调用方用 textContent 之类安全方式渲染。

// Spec §9.3：语音输入状态机必须覆盖空闲、聆听、转写、失败、无权限和无网络。
export const VOICE_STATES = Object.freeze([
  'idle', 'listening', 'transcribing', 'failed', 'no-permission', 'offline',
]);
export const VOICE_STATE_LABELS = Object.freeze({
  idle: '空闲', listening: '聆听中', transcribing: '转写中',
  failed: '识别失败', 'no-permission': '无权限', offline: '无网络',
});
export const voiceStateLabel = state => VOICE_STATE_LABELS[state] || VOICE_STATE_LABELS.idle;

// 这三种状态必须允许键盘直接使用（Spec §9.2.5：无权限/识别失败/无网络均可直接键盘输入）。
export const VOICE_KEYBOARD_FALLBACK_STATES = Object.freeze(['failed', 'no-permission', 'offline']);
export const isKeyboardFallbackState = state => VOICE_KEYBOARD_FALLBACK_STATES.includes(state);
export const VOICE_FALLBACK_HINTS = Object.freeze({
  failed: '识别失败，可直接使用键盘输入或重试',
  'no-permission': '无麦克风权限，可直接使用键盘输入',
  offline: '无网络，可直接使用键盘输入',
});
export const voiceFallbackHint = state => VOICE_FALLBACK_HINTS[state] || null;

// 产品非目标：停顿只保留转写预览并落草稿，绝不触发发送（Spec §9.2.4）。
export const VOICE_SEND_ON_PAUSE = false;

// Spec §9.10：图标视觉轻巧，但交互热区扩展到约 44–48 dp。
export const VOICE_TOUCH_TARGET_DP = 44;
export const VOICE_TOUCH_TARGET_MAX_DP = 48;

// 撤销栈上限，避免长会话里无限增长；撤销只回退最近一次追加。
export const VOICE_HISTORY_LIMIT = 20;

// Spec §9.11：聆听/转写中麦克风进入禁用态，防止重复启动；聆听中为选中态。
export const VOICE_MIC_DISABLED_STATES = Object.freeze(['listening', 'transcribing']);
