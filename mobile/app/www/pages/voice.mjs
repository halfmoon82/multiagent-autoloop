// 语音输入挂载点：不对应 Tab，由 app.mjs 在装配阶段 mount 一次。
// 提供者降级链：控制台转写（录音上传 transcribe 端点）→ 原生系统识别器 window.AutoloopSpeech → 双不可用则隐藏麦克风。
// 识别文字只进输入框：实时转写作为预览显示，最终结果落为草稿并通知输入框变化；任何时候都不发送。
const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/voice-input/index.mjs');

export { loadViewModel };

/** 双提供者都不可用：通知会话页隐藏麦克风（键盘输入不受影响）。 */
export const VOICE_UNAVAILABLE_EVENT = 'autoloop:voice-unavailable';

/** 挂载点。ctx 含 client / state / hooks。 */
export function mount(ctx) {
  if (typeof window === 'undefined') return;
  const speech = window.AutoloopSpeech && typeof window.AutoloopSpeech.start === 'function' ? window.AutoloopSpeech : null;
  const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  const MediaRecorderCtor = typeof window.MediaRecorder === 'function' ? window.MediaRecorder : null;
  const recordable = Boolean(mediaDevices && typeof mediaDevices.getUserMedia === 'function' && MediaRecorderCtor && ctx.client?.origin);
  if (!speech && !recordable) return; // 两条路都没有：保持空操作，会话页据此隐藏麦克风

  const inputs = new WeakMap(); // 每个会话输入框独立的语音状态
  let vm = null;                // voice-input 状态机，首次点击时加载
  let active = null;            // 当前接收原生识别结果的输入框
  let consoleDown = false;      // 控制台转写本页生命周期内已判定不可用
  let recorder = null;          // 控制台转写的当前录音器
  let recordingEl = null;

  const notifyInput = el => {
    if (typeof Event === 'function') el.dispatchEvent(new Event('input', { bubbles: true }));
    else el.dispatchEvent({ type: 'input' });
  };

  // 输入框显示草稿 + 实时预览；状态提示放在 title（悬停提示），不改动会话页占位文案。
  function render(el, input) {
    el.value = vm.previewDraft(input);
    el.title = vm.voiceFallbackHint(input.state) || vm.voiceStateLabel(input.state);
  }
  const put = (el, input) => { inputs.set(el, input); render(el, input); return input; };

  // 键盘可能在两次听写之间改过文字：开始前以输入框内容为准同步草稿。
  function syncDraft(el, input) {
    return el.value === input.draft ? input : vm.setDraft(input, el.value);
  }

  const nativeAvailable = () => Boolean(speech);
  const consoleAvailable = () => recordable && !consoleDown;
  const hideMic = () => window.dispatchEvent(new CustomEvent(VOICE_UNAVAILABLE_EVENT));

  async function startNative(el, input) {
    if (!(await speech.isAvailable())) {
      put(el, vm.failVoice(input, '本机不支持语音识别'));
      return;
    }
    active = el;
    if (!(await speech.start())) {
      put(el, vm.failVoice(input, '语音识别无法启动'));
      active = null;
    }
  }

  // 控制台转写不可用后的降级：有原生就提示再点一次，没有就隐藏麦克风。
  function degradeFromConsole(el, input) {
    consoleDown = true;
    if (nativeAvailable()) put(el, vm.failVoice(input, '控制台转写不可用，已切换系统识别，请再点一次麦克风'));
    else { put(el, vm.failVoice(input, '语音转写不可用，请使用键盘输入')); hideMic(); }
  }

  async function startConsole(el, input) {
    recorder = vm.createRecorder({ mediaDevices, MediaRecorderCtor });
    recordingEl = el;
    try {
      await recorder.start();
    } catch {
      recorder = null; recordingEl = null;
      degradeFromConsole(el, input);
      // 无麦克风/权限拒绝但有原生识别器：直接接力，用户无需再点。
      if (nativeAvailable()) { const next = vm.startVoice(syncDraft(el, inputs.get(el)), { permission: 'granted', online: true }); put(el, next); await startNative(el, next); }
    }
  }

  async function finishConsole(el) {
    const current = recorder;
    recorder = null; recordingEl = null;
    let input = vm.beginTranscribe(inputs.get(el), inputs.get(el).interim);
    put(el, input);
    try {
      const blob = await current.stop();
      const text = await vm.transcribeBlob({ origin: ctx.client.origin, token: await ctx.client.tokenStore.get(), blob });
      input = vm.commitVoice(inputs.get(el), text);
      put(el, input);
      notifyInput(el);
    } catch (error) {
      if (error && error.fallback) degradeFromConsole(el, inputs.get(el));
      else put(el, vm.failVoice(inputs.get(el), error?.message || '转写失败，请重试')); // 草稿保留
    }
  }

  ctx.hooks.attachVoice = async el => {
    if (!el) return;
    if (!vm) vm = await loadViewModel();
    let input = inputs.get(el) || vm.createVoiceInput({ id: el.id || 'composer', draft: el.value });

    // 聆听/转写中再次点击：停止录音或识别，等待最终结果或错误回调再落草稿。
    if (input.state === 'listening' || input.state === 'transcribing') {
      if (recordingEl === el && recorder) { await finishConsole(el); return; }
      if (input.state === 'transcribing') return; // 上传中，等结果
      speech?.stop();
      put(el, vm.beginTranscribe(input, input.interim));
      return;
    }

    input = syncDraft(el, input);
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    input = put(el, vm.startVoice(input, { permission: 'granted', online }));
    if (input.state !== 'listening') return; // 无网络：状态机已回退，键盘可用

    const provider = vm.resolveVoiceProvider({ consoleAvailable: consoleAvailable(), nativeAvailable: nativeAvailable() });
    if (provider === 'console') await startConsole(el, input);
    else if (provider === 'native') await startNative(el, input);
    else { put(el, vm.failVoice(input, '语音转写不可用，请使用键盘输入')); hideMic(); }
  };

  speech?.onPartial(text => {
    const el = active;
    if (!el || !vm) return;
    put(el, vm.setInterim(inputs.get(el), text));
  });

  speech?.onFinal(text => {
    const el = active;
    if (!el || !vm) return;
    put(el, vm.commitVoice(inputs.get(el), text));
    active = null;
    notifyInput(el);
  });

  speech?.onError(error => {
    const el = active;
    if (!el || !vm) return;
    put(el, vm.failWithCode(inputs.get(el), error));
    active = null;
  });
}
