// 语音输入挂载点：不对应 Tab，由 app.mjs 在装配阶段 mount 一次。
// 只有原生桥 window.AutoloopSpeech 存在时才覆盖 ctx.hooks.attachVoice；否则保持空操作，会话页据此隐藏麦克风。
// 识别文字只进输入框：实时转写作为预览显示，最终结果落为草稿并通知输入框变化；任何时候都不发送。
const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/voice-input/index.mjs');

export { loadViewModel };

/** 挂载点。ctx 含 client / state / hooks。 */
export function mount(ctx) {
  const speech = typeof window === 'undefined' ? null : window.AutoloopSpeech;
  if (!speech || typeof speech.start !== 'function') return;

  const inputs = new WeakMap(); // 每个会话输入框独立的语音状态
  let vm = null;                // voice-input 状态机，首次点击时加载
  let active = null;            // 当前接收识别结果的输入框

  const notifyInput = el => {
    if (typeof Event === 'function') el.dispatchEvent(new Event('input', { bubbles: true }));
    else el.dispatchEvent({ type: 'input' });
  };

  // 输入框显示草稿 + 实时预览；状态提示放在 title（悬停提示），不改动会话页占位文案。
  function render(el, input) {
    el.value = vm.previewDraft(input);
    el.title = vm.voiceFallbackHint(input.state) || vm.voiceStateLabel(input.state);
  }

  // 键盘可能在两次听写之间改过文字：开始前以输入框内容为准同步草稿。
  function syncDraft(el, input) {
    return el.value === input.draft ? input : vm.setDraft(input, el.value);
  }

  ctx.hooks.attachVoice = async el => {
    if (!el) return;
    if (!vm) vm = await loadViewModel();
    let input = inputs.get(el) || vm.createVoiceInput({ id: el.id || 'composer', draft: el.value });

    // 聆听/转写中再次点击：停止识别，等待最终结果或错误回调再落草稿。
    if (input.state === 'listening' || input.state === 'transcribing') {
      speech.stop();
      input = vm.beginTranscribe(input, input.interim);
      inputs.set(el, input);
      render(el, input);
      return;
    }

    input = syncDraft(el, input);
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    input = vm.startVoice(input, { permission: 'granted', online });
    inputs.set(el, input);
    render(el, input);
    if (input.state !== 'listening') return; // 无网络：状态机已回退，键盘可用

    if (!(await speech.isAvailable())) {
      input = vm.failVoice(input, '本机不支持语音识别');
      inputs.set(el, input);
      render(el, input);
      return;
    }
    active = el;
    if (!(await speech.start())) {
      input = vm.failVoice(input, '语音识别无法启动');
      inputs.set(el, input);
      render(el, input);
      active = null;
    }
  };

  speech.onPartial(text => {
    const el = active;
    if (!el || !vm) return;
    const input = vm.setInterim(inputs.get(el), text);
    inputs.set(el, input);
    render(el, input);
  });

  speech.onFinal(text => {
    const el = active;
    if (!el || !vm) return;
    const input = vm.commitVoice(inputs.get(el), text);
    inputs.set(el, input);
    render(el, input);
    active = null;
    notifyInput(el);
  });

  speech.onError(error => {
    const el = active;
    if (!el || !vm) return;
    const input = vm.failWithCode(inputs.get(el), error);
    inputs.set(el, input);
    render(el, input);
    active = null;
  });
}
