// 语音输入视图模型（Spec §9.2 / §9.3 / §9.10 / §9.11 / DAG 节点 voice-input）：
// 把状态机投影成「麦克风按钮态 + 回退提示 + 可编辑草稿」的普通对象，供所有会话输入框统一装配。
// 不启动识别、不申请权限、不发请求；上游文本原样以字符串返回，由调用方用 textContent 安全渲染。

import {
  voiceStateLabel, isKeyboardFallbackState, voiceFallbackHint,
  VOICE_MIC_DISABLED_STATES, VOICE_SEND_ON_PAUSE, VOICE_TOUCH_TARGET_DP, VOICE_TOUCH_TARGET_MAX_DP,
} from './contract.mjs';
import { canStartVoice } from './voice.mjs';

export function buildVoiceInputBinding(input) {
  const state = input?.state ?? 'idle';
  return {
    id: String(input?.id ?? ''),
    state,
    stateLabel: voiceStateLabel(state),
    draft: String(input?.draft ?? ''),
    interim: String(input?.interim ?? ''),
    canStart: canStartVoice(input),
    micDisabled: VOICE_MIC_DISABLED_STATES.includes(state),
    micSelected: state === 'listening',
    paused: input?.paused === true,
    touchTargetDp: VOICE_TOUCH_TARGET_DP,
    touchTargetMaxDp: VOICE_TOUCH_TARGET_MAX_DP,
    keyboardFallback: isKeyboardFallbackState(state),
    fallbackHint: voiceFallbackHint(state),
    canUndo: Array.isArray(input?.history) && input.history.length > 0,
    error: input?.error ?? null,
    autoSend: VOICE_SEND_ON_PAUSE,
    sent: input?.sent ?? 0,
  };
}
