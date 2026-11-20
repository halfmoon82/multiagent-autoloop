// 语音输入状态机（Spec §9.2 / §9.3 / DAG 节点 voice-input）：纯逻辑，无隐藏模块状态。
// 识别结果只落到可编辑草稿（draft），停顿/提交都不发送；失败/无权限/无网络保留草稿，键盘随时可用。
// 每次转移返回新对象，便于测试与 UI 逐帧比对；无变化时返回原对象，避免无谓重渲染。

import {
  VOICE_HISTORY_LIMIT, isKeyboardFallbackState, voiceFallbackHint,
} from './contract.mjs';

const str = value => String(value ?? '');

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

// 任何改动草稿的动作（语音提交、键盘追加、手动编辑）都记一个撤销点；无实际变化时不记。
function withDraft(input, nextDraft, extra = {}) {
  const draft = str(nextDraft);
  if (draft === input.draft) return { ...input, ...extra };
  const history = [...(Array.isArray(input.history) ? input.history : []), input.draft].slice(-VOICE_HISTORY_LIMIT);
  return { ...input, ...extra, draft, history };
}

// 单个会话输入框的语音控制器状态；sent 恒为 0，本节点不提供发送动作。
export function createVoiceInput({ id = '', draft = '' } = {}) {
  return {
    id: str(id),
    state: 'idle',
    draft: str(draft),
    interim: '',
    paused: false,
    error: null,
    history: [],
    sent: 0,
  };
}

// 覆盖所有会话输入框：按 id 建独立实例，互不共享状态。
export function createVoiceInputs(ids = []) {
  const registry = {};
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const key = str(id);
    if (key) registry[key] = createVoiceInput({ id: key });
  }
  return registry;
}

export function canStartVoice(input) {
  if (!input || typeof input !== 'object') return false;
  return input.state === 'idle' || isKeyboardFallbackState(input.state);
}

// START：只有 granted 且 online 才进入聆听；无权限/无网络进入对应回退态，草稿保持原样。
export function startVoice(input, { permission = 'granted', online = true } = {}) {
  if (!canStartVoice(input)) return input;
  if (permission !== 'granted') {
    return { ...input, state: 'no-permission', interim: '', paused: false, error: '无麦克风权限，可直接使用键盘输入' };
  }
  if (online === false) {
    return { ...input, state: 'offline', interim: '', paused: false, error: '无网络，可直接使用键盘输入' };
  }
  return { ...input, state: 'listening', interim: '', paused: false, error: null };
}

// INTERIM：实时转写预览只在聆听态生效；预览不属于草稿，也不触发发送。
export function setInterim(input, text = '') {
  if (input?.state !== 'listening') return input;
  return { ...input, interim: str(text) };
}

// PAUSE：停顿只标记 paused 并保留预览，状态仍是聆听，绝不自动发送。
export function pauseVoice(input) {
  if (input?.state !== 'listening') return input;
  return { ...input, paused: true };
}

export function resumeVoice(input) {
  if (input?.state !== 'listening') return input;
  return { ...input, paused: false };
}

// STOP：放弃当前预览回到空闲，草稿不变，不发送。
export function stopVoice(input) {
  if (!input || (input.state !== 'listening' && input.state !== 'transcribing')) return input;
  return { ...input, state: 'idle', interim: '', paused: false };
}

// 识别开始：从聆听进入转写，保留当前预览供 UI 展示。
export function beginTranscribe(input, interimText = '') {
  if (input?.state !== 'listening') return input;
  return { ...setInterim(input, interimText), state: 'transcribing' };
}

// RESULT：把识别文本追加到可编辑草稿，清预览回空闲；记录撤销点，sent 不变。
export function commitVoice(input, text = '') {
  if (!input || (input.state !== 'listening' && input.state !== 'transcribing')) return input;
  return withDraft(input, joinDraft(input.draft, text), {
    state: 'idle', interim: '', paused: false, error: null,
  });
}

// FAIL：回到 failed 并给出原因，草稿与历史保留，键盘仍可用；更具体的无权限/无网络原因不被覆盖。
export function failVoice(input, reason = '识别失败') {
  if (!input || typeof input !== 'object') return input;
  if (input.state === 'no-permission' || input.state === 'offline') return input;
  return {
    ...input,
    state: 'failed',
    interim: '',
    paused: false,
    error: str(reason?.message ?? reason ?? '识别失败'),
  };
}

// 键盘输入在任意状态都可用（回退原则）：追加手动文本，不发送。
export function appendToDraft(input, text = '') {
  if (!input || typeof input !== 'object') return input;
  return withDraft(input, joinDraft(input.draft, text));
}

// 手动整段编辑/修改识别结果。
export function setDraft(input, text = '') {
  if (!input || typeof input !== 'object') return input;
  return withDraft(input, text);
}

// UNDO：回退最近一次追加（语音或键盘），回到空闲；无历史时无变化。
export function undoVoice(input) {
  if (!input || typeof input !== 'object') return input;
  const history = Array.isArray(input.history) ? input.history : [];
  if (!history.length) return input;
  return {
    ...input,
    draft: str(history[history.length - 1]),
    history: history.slice(0, -1),
    state: 'idle',
    interim: '',
    paused: false,
  };
}

// 原生识别错误：无权限、无网络是更具体的回退态，其余错误统一回到 failed；草稿与历史保留。
export function failWithCode(input, error = {}) {
  if (!input || typeof input !== 'object') return input;
  const code = str(error?.code);
  if (code === 'AUTOLOOP_SPEECH_PERMISSION_DENIED') {
    return { ...input, state: 'no-permission', interim: '', paused: false, error: voiceFallbackHint('no-permission') };
  }
  if (code === 'AUTOLOOP_SPEECH_NETWORK') {
    return { ...input, state: 'offline', interim: '', paused: false, error: voiceFallbackHint('offline') };
  }
  return failVoice(input, str(error?.message || '识别失败'));
}

// 输入框显示文本：草稿 + 实时预览。只用于显示，预览不写入草稿，也不进撤销历史。
export function previewDraft(input) {
  const draft = str(input?.draft);
  const interim = str(input?.interim);
  return interim ? joinDraft(draft, interim) : draft;
}
