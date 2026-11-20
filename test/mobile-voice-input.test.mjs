// voice-input 节点（Spec §9.2 / §9.3 / DAG 节点 voice-input）边界测试：
// 所有会话输入框的语音转文字 → 可编辑草稿、停顿不自动发送、失败/无权限/无网络回退键盘。
// 纯逻辑：feature 不碰 DOM、不依赖 node: 内置模块；状态机无隐藏状态，纯函数返回新对象。
// 上游文本全程是纯字符串，由调用方用 textContent 之类安全方式渲染。
import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  VOICE_STATES, VOICE_STATE_LABELS, voiceStateLabel,
  VOICE_KEYBOARD_FALLBACK_STATES, isKeyboardFallbackState, voiceFallbackHint,
  VOICE_SEND_ON_PAUSE, VOICE_TOUCH_TARGET_DP, VOICE_TOUCH_TARGET_MAX_DP, VOICE_HISTORY_LIMIT,
  VOICE_MIC_DISABLED_STATES,
  createVoiceInput, createVoiceInputs, canStartVoice, startVoice,
  setInterim, pauseVoice, resumeVoice, stopVoice, beginTranscribe, commitVoice,
  failVoice, appendToDraft, setDraft, undoVoice, buildVoiceInputBinding,
  failWithCode, previewDraft,
} from '../mobile/src/features/voice-input/index.mjs';

const FEATURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'src', 'features', 'voice-input');

// ---------------------------------------------------------------------------
// RED 1：契约词表与常量（Spec §9.3 的 6 态、回退态、不自动发送、触控热区）
// ---------------------------------------------------------------------------
test('契约词表覆盖 Spec §9.3 的 6 个状态，不编造', () => {
  assert.deepEqual(VOICE_STATES, ['idle', 'listening', 'transcribing', 'failed', 'no-permission', 'offline']);
  for (const state of VOICE_STATES) assert.equal(typeof VOICE_STATE_LABELS[state], 'string');
  assert.equal(voiceStateLabel('listening'), '聆听中');
  assert.equal(voiceStateLabel('unknown'), VOICE_STATE_LABELS.idle, '未知态回退到空闲，不编造');
  assert.deepEqual([...VOICE_KEYBOARD_FALLBACK_STATES].sort(), ['failed', 'no-permission', 'offline']);
  assert.equal(isKeyboardFallbackState('offline'), true);
  assert.equal(isKeyboardFallbackState('listening'), false);
  assert.equal(voiceFallbackHint('no-permission').includes('键盘'), true);
  assert.equal(voiceFallbackHint('idle'), null);
});

test('停顿不自动发送是非目标；触控热区 44–48dp；撤销栈有上限', () => {
  assert.equal(VOICE_SEND_ON_PAUSE, false, '停顿绝不自动发送');
  assert.ok(VOICE_TOUCH_TARGET_DP >= 44 && VOICE_TOUCH_TARGET_DP <= 48);
  assert.ok(VOICE_TOUCH_TARGET_MAX_DP >= VOICE_TOUCH_TARGET_DP && VOICE_TOUCH_TARGET_MAX_DP <= 48);
  assert.ok(VOICE_HISTORY_LIMIT > 0);
  assert.deepEqual([...VOICE_MIC_DISABLED_STATES].sort(), ['listening', 'transcribing']);
});

// ---------------------------------------------------------------------------
// RED 2：初始态与启动门禁（无权限/无网络回退）
// ---------------------------------------------------------------------------
test('createVoiceInput 初态为空闲，草稿原样，无预览/历史/发送', () => {
  const input = createVoiceInput({ id: 'c1', draft: '已有草稿' });
  assert.equal(input.id, 'c1');
  assert.equal(input.state, 'idle');
  assert.equal(input.draft, '已有草稿');
  assert.equal(input.interim, '');
  assert.deepEqual(input.history, []);
  assert.equal(input.sent, 0);
});

test('startVoice 先判权限再判网络，任一不满足回退且草稿不变', () => {
  const base = createVoiceInput({ id: 'c1', draft: '原稿' });
  for (const permission of ['denied', 'prompt']) {
    const next = startVoice(base, { permission, online: true });
    assert.equal(next.state, 'no-permission');
    assert.equal(next.draft, '原稿');
    assert.ok(next.error.includes('键盘'));
  }
  const offline = startVoice(base, { permission: 'granted', online: false });
  assert.equal(offline.state, 'offline');
  assert.equal(offline.draft, '原稿');
  const ready = startVoice(base, { permission: 'granted', online: true });
  assert.equal(ready.state, 'listening');
  assert.equal(ready.interim, '');
  assert.equal(ready.error, null);
  assert.equal(ready.draft, '原稿');
});

test('startVoice 仅在空闲或回退态可启动，聆听/转写中不可重复启动', () => {
  const listening = startVoice(createVoiceInput({ id: 'c1' }));
  assert.equal(canStartVoice(listening), false);
  assert.equal(startVoice(listening), listening, '无变化时返回同一对象，不重复启动');
  assert.equal(canStartVoice(createVoiceInput({ id: 'c1' })), true);
  assert.equal(canStartVoice(startVoice(createVoiceInput(), { permission: 'denied' })), true, '失败后可重试');
});

// ---------------------------------------------------------------------------
// RED 3：实时转写 → 可编辑草稿；停顿不发送
// ---------------------------------------------------------------------------
test('实时转写预览不进草稿；提交后落到可编辑草稿且绝不发送', () => {
  const listening = startVoice(createVoiceInput({ id: 'c1', draft: '开头' }));
  const interim = setInterim(listening, '你好世界');
  assert.equal(interim.state, 'listening');
  assert.equal(interim.interim, '你好世界');
  assert.equal(interim.draft, '开头', '预览不进草稿');
  assert.equal(interim.sent, 0);

  const transcribing = beginTranscribe(interim, '你好世界');
  assert.equal(transcribing.state, 'transcribing');
  const committed = commitVoice(transcribing, '你好世界');
  assert.equal(committed.state, 'idle');
  assert.equal(committed.draft, '开头 你好世界', '识别文本追加到可编辑草稿');
  assert.equal(committed.interim, '');
  assert.equal(committed.sent, 0, '提交不发送');
  assert.equal(committed.history.length, 1, '保留撤销点');
});

test('停顿只是保留预览，不自动发送；恢复与停止均可控', () => {
  const listening = startVoice(createVoiceInput({ id: 'c1' }));
  const paused = pauseVoice(setInterim(listening, '停顿前'));
  assert.equal(paused.state, 'listening', '停顿不改变状态');
  assert.equal(paused.paused, true);
  assert.equal(paused.interim, '停顿前');
  assert.equal(paused.sent, 0);
  assert.equal(paused.draft, '', '停顿不把预览写入草稿，更不发送');

  const resumed = resumeVoice(paused);
  assert.equal(resumed.paused, false);
  const stopped = stopVoice(paused);
  assert.equal(stopped.state, 'idle');
  assert.equal(stopped.interim, '');
  assert.equal(stopped.sent, 0);
});

test('非聆听/转写态的转写操作无副作用', () => {
  const idle = createVoiceInput({ id: 'c1', draft: '原稿' });
  assert.equal(setInterim(idle, 'x'), idle);
  assert.equal(beginTranscribe(idle, 'x'), idle);
  assert.equal(commitVoice(idle, 'x'), idle);
  assert.equal(pauseVoice(idle), idle);
  assert.equal(resumeVoice(idle), idle);
  assert.equal(stopVoice(idle), idle);
});

// ---------------------------------------------------------------------------
// RED 4：失败回退键盘；手动修改/追加/撤销
// ---------------------------------------------------------------------------
test('识别失败回到 failed，键盘输入在任意状态可用', () => {
  const listening = startVoice(createVoiceInput({ id: 'c1', draft: '原稿' }));
  const failed = failVoice(listening, new Error('引擎异常'));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.draft, '原稿', '失败保留草稿');
  assert.equal(failed.error, '引擎异常');
  assert.equal(voiceFallbackHint(failed.state).includes('键盘'), true);

  const typed = appendToDraft(failed, '，键盘补一句');
  assert.equal(typed.draft, '原稿，键盘补一句');
  const fromIdle = appendToDraft(createVoiceInput(), '随手输入');
  assert.equal(fromIdle.draft, '随手输入');
  assert.equal(fromIdle.sent, 0);
});

test('无权限/无网络是更具体的回退原因，不被通用失败覆盖', () => {
  const denied = startVoice(createVoiceInput({ id: 'c1' }), { permission: 'denied' });
  assert.equal(failVoice(denied, '识别失败'), denied, '保留无权限原因');
  const offline = startVoice(createVoiceInput({ id: 'c1' }), { online: false });
  assert.equal(failVoice(offline, '识别失败'), offline, '保留无网络原因');
});

test('手动编辑、追加语音、撤销各自独立可测', () => {
  let input = createVoiceInput({ id: 'c1' });
  input = appendToDraft(input, '第一段');
  input = commitVoice(beginTranscribe(startVoice(input), '第二段'), '第二段');
  assert.equal(input.draft, '第一段 第二段');
  input = setDraft(input, '第一段 第二段（手动改）');
  assert.equal(input.draft, '第一段 第二段（手动改）');
  input = undoVoice(input);
  assert.equal(input.draft, '第一段 第二段', '撤销先回退手动编辑');
  input = undoVoice(input);
  assert.equal(input.draft, '第一段', '再撤销回退语音追加');
  input = undoVoice(input);
  assert.equal(input.draft, '', '继续撤销回退键盘追加');
  assert.equal(input.state, 'idle');
  assert.equal(undoVoice(createVoiceInput()).draft, '', '无历史时撤销不报错');
});

test('撤销栈有上限，不无限增长', () => {
  let input = createVoiceInput();
  for (let i = 0; i < VOICE_HISTORY_LIMIT + 5; i += 1) {
    input = commitVoice(beginTranscribe(startVoice(input), `第${i}段`), `第${i}段`);
  }
  assert.equal(input.history.length, VOICE_HISTORY_LIMIT);
});

// ---------------------------------------------------------------------------
// RED 5：覆盖所有会话输入框；视图模型安全渲染
// ---------------------------------------------------------------------------
test('每个会话输入框有独立语音实例，互不共享状态', () => {
  const registry = createVoiceInputs(['c1', 'c2', 'c3']);
  assert.deepEqual(Object.keys(registry), ['c1', 'c2', 'c3']);
  registry.c1 = commitVoice(beginTranscribe(startVoice(registry.c1), '甲'), '甲');
  assert.equal(registry.c1.draft, '甲');
  assert.equal(registry.c2.draft, '');
  assert.equal(registry.c2.state, 'idle');
  assert.equal(registry.c1.state, 'idle');
  assert.deepEqual(Object.keys(createVoiceInputs([])), []);
});

test('视图模型给出麦克风态、热区、回退提示，且标明不自动发送', () => {
  const idle = buildVoiceInputBinding(createVoiceInput({ id: 'c1' }));
  assert.equal(idle.id, 'c1');
  assert.equal(idle.stateLabel, '空闲');
  assert.equal(idle.micDisabled, false);
  assert.equal(idle.micSelected, false);
  assert.equal(idle.touchTargetDp, VOICE_TOUCH_TARGET_DP);
  assert.equal(idle.keyboardFallback, false);
  assert.equal(idle.autoSend, false, '视图明确不自动发送');
  assert.equal(idle.sent, 0);

  const listening = buildVoiceInputBinding(startVoice(createVoiceInput({ id: 'c2' })));
  assert.equal(listening.micDisabled, true, '聆听中麦克风置禁用态防重复启动');
  assert.equal(listening.micSelected, true, '聆听中为选中态');

  const denied = buildVoiceInputBinding(startVoice(createVoiceInput({ id: 'c3' }), { permission: 'denied' }));
  assert.equal(denied.keyboardFallback, true);
  assert.ok(denied.fallbackHint.includes('键盘'));
});

test('端到端：授权后语音转可编辑文字、停顿不发送、失败回键盘、可撤销', () => {
  let input = createVoiceInput({ id: 'session-1' });
  input = startVoice(input, { permission: 'granted', online: true });
  input = pauseVoice(setInterim(input, '嗯'));
  assert.equal(input.sent, 0, '停顿不发送');
  input = commitVoice(beginTranscribe(input, '请把规则暂停'), '请把规则暂停');
  assert.equal(input.draft, '请把规则暂停');
  assert.equal(input.sent, 0, '提交仅落到草稿');
  input = setDraft(input, '请把规则暂停一下');
  assert.equal(input.draft, '请把规则暂停一下', '可手动修改');

  input = failVoice(startVoice(input), '识别失败');
  input = appendToDraft(input, '，改用键盘');
  assert.equal(input.state, 'failed');
  assert.equal(input.draft, '请把规则暂停一下，改用键盘');
  input = undoVoice(input);
  assert.equal(input.draft, '请把规则暂停一下');
  assert.equal(input.sent, 0, '全程无发送');
});

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

test('上游文本全程是纯字符串：视图模型可安全渲染，不拼接 HTML、不泄漏凭据', () => {
  const binding = buildVoiceInputBinding(createVoiceInput({
    id: 'c1', draft: '请把规则暂停一下',
  }));
  const dump = JSON.stringify([
    binding,
    buildVoiceInputBinding(startVoice(createVoiceInput({ id: 'c2' }), { permission: 'denied' })),
  ]);
  assert.equal(typeof binding.draft, 'string');
  assert.equal(binding.draft, '请把规则暂停一下', '文本原样返回，由调用方 textContent 渲染');
  assert.equal(Object.hasOwn(binding, 'html'), false, '视图模型不产出 html 字段');
  assert.ok(!dump.includes('<script') && !dump.includes('</div>') && !dump.includes('onerror='));
  assert.ok(!dump.includes('deviceToken') && !dump.includes('server-secret') && !dump.includes('apiKey'));
});

// ---------------------------------------------------------------------------
// RED voice-wiring：原生错误码分流（无权限/无网络/其他）与预览只用于显示
// ---------------------------------------------------------------------------
test('原生错误码分流：无权限回 no-permission，无网络回 offline，其余回 failed，草稿保留', () => {
  const base = { ...createVoiceInput({ id: 's', draft: '已有草稿' }), state: 'listening', interim: '预览' };
  const denied = failWithCode(base, { code: 'AUTOLOOP_SPEECH_PERMISSION_DENIED', message: 'x' });
  assert.equal(denied.state, 'no-permission');
  assert.equal(denied.draft, '已有草稿');
  assert.equal(denied.interim, '');
  assert.equal(failWithCode(base, { code: 'AUTOLOOP_SPEECH_NETWORK' }).state, 'offline');
  const busy = failWithCode(base, { code: 'AUTOLOOP_SPEECH_BUSY', message: '识别器忙' });
  assert.equal(busy.state, 'failed');
  assert.equal(busy.error, '识别器忙');
  assert.equal(busy.draft, '已有草稿');
  assert.equal(failWithCode(base, { code: 'AUTOLOOP_SPEECH_TIMEOUT' }).state, 'failed');
  assert.equal(failWithCode(base, {}).state, 'failed', '缺省错误码也回退为 failed');
});

test('预览只用于显示：previewDraft 拼接草稿与预览，不改变草稿', () => {
  const s = { ...createVoiceInput({ id: 's', draft: '请暂停，' }), state: 'listening', interim: '规则' };
  assert.equal(previewDraft(s), '请暂停，规则');
  assert.equal(s.draft, '请暂停，', '预览不写入草稿');
  assert.equal(previewDraft({ ...s, interim: '' }), '请暂停，');
  assert.equal(previewDraft(createVoiceInput({ draft: '' })), '');
});

// ---------------------------------------------------------------------------
// RED voice-wiring：pages/voice.mjs 把状态机接到 window.AutoloopSpeech 与输入框
// 假桥 + 假输入框，不调用真实识别、不碰真实设备。
// ---------------------------------------------------------------------------
const PAGE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'app', 'www', 'pages', 'voice.mjs');
// 服务端把 /mobile/pages/* 映射到 www/pages、/mobile/src/* 映射到 mobile/src，页面用 ../src 引入 feature。
// 本地检出没有 www/src，这里在临时目录复现同样的相对布局：pages/voice.mjs 副本 + src → mobile/src 的符号链接。
const SERVED_ROOT = mkdtempSync(path.join(os.tmpdir(), 'voice-page-'));
mkdirSync(path.join(SERVED_ROOT, 'pages'));
symlinkSync(path.resolve(FEATURE_DIR, '..', '..'), path.join(SERVED_ROOT, 'src'));
after(() => rmSync(SERVED_ROOT, { recursive: true, force: true }));
const DEFAULT_ATTACH_VOICE = 'attachVoice(){}';
const compact = fn => fn.toString().replace(/\s+/g, '');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function fakeSpeech({ available = true, startOk = true } = {}) {
  const speech = {
    starts: 0, stops: 0, onPartialCb: null, onFinalCb: null, onErrorCb: null,
    isAvailable: () => Promise.resolve(available),
    start: () => { speech.starts += 1; return Promise.resolve(startOk); },
    stop: () => { speech.stops += 1; return Promise.resolve(true); },
    onPartial(cb) { speech.onPartialCb = cb; },
    onFinal(cb) { speech.onFinalCb = cb; },
    onError(cb) { speech.onErrorCb = cb; },
  };
  return speech;
}

function fakeTextarea(value) {
  const listeners = {};
  const dispatched = [];
  return {
    value, title: '', dispatched,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(ev) {
      dispatched.push(ev.type);
      for (const fn of listeners[ev.type] || []) fn(ev);
      return true;
    },
    setAttribute(key, val) { this[key] = val; },
  };
}

// 每个用例用 cache-busting 查询重新求值页面模块，使 window 检测生效于本次用例。
async function mountVoicePage(speech) {
  globalThis.window = speech ? { AutoloopSpeech: speech } : {};
  const copy = path.join(SERVED_ROOT, 'pages', 'voice.mjs');
  copyFileSync(PAGE_PATH, copy);
  const page = await import(`${pathToFileURL(copy).href}?case=${Math.random()}`);
  const ctx = { hooks: { attachVoice() {} } };
  page.mount(ctx);
  return { ctx, attach: el => ctx.hooks.attachVoice(el) };
}

afterEach(() => { delete globalThis.window; });

test('pages/voice.mjs 无原生桥时保持默认空操作（会话页据此隐藏麦克风），有桥时才覆盖 attachVoice', async () => {
  const none = await mountVoicePage(null);
  assert.equal(compact(none.ctx.hooks.attachVoice), DEFAULT_ATTACH_VOICE);
  const withBridge = await mountVoicePage(fakeSpeech());
  assert.notEqual(compact(withBridge.ctx.hooks.attachVoice), DEFAULT_ATTACH_VOICE);
});

test('pages/voice.mjs 不拼接 HTML、不直接发送、不 import node 内置模块', () => {
  const source = readFileSync(PAGE_PATH, 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(source, /from\s+['"]node:/);
  assert.doesNotMatch(source, /\.submit\s*\(|requestSubmit|autoloop:send/);
});

test('点击开始听写：实时预览显示在输入框但不触发输入事件，最终结果落为草稿且绝不发送', async () => {
  const speech = fakeSpeech();
  const { attach } = await mountVoicePage(speech);
  const el = fakeTextarea('请把规则，');
  await attach(el);
  await flush();
  assert.equal(speech.starts, 1);
  assert.match(el.title, /聆听中/);

  speech.onPartialCb('暂停');
  assert.equal(el.value, '请把规则，暂停', '实时转写显示在输入框');
  assert.deepEqual(el.dispatched, [], '预览不触发输入事件，不写入草稿');

  speech.onFinalCb('暂停一下');
  await flush();
  assert.equal(el.value, '请把规则，暂停一下');
  assert.deepEqual(el.dispatched, ['input'], '只通知输入框内容变化，没有发送类事件');
});

test('拒权回落：无权限时保留草稿、提示键盘；键盘补充后可再次尝试', async () => {
  const speech = fakeSpeech();
  const { attach } = await mountVoicePage(speech);
  const el = fakeTextarea('草稿');
  await attach(el);
  await flush();
  speech.onErrorCb({ code: 'AUTOLOOP_SPEECH_PERMISSION_DENIED', message: '拒绝' });
  await flush();
  assert.equal(el.value, '草稿');
  assert.match(el.title, /无麦克风权限/);

  el.value = '草稿，键盘补充';
  el.dispatchEvent({ type: 'input' });
  await attach(el);
  await flush();
  assert.equal(speech.starts, 2, '回退态允许再次点击开始');
});

test('bridge 不可用时不启动识别，并提示用键盘输入', async () => {
  const speech = fakeSpeech({ available: false });
  const { attach } = await mountVoicePage(speech);
  const el = fakeTextarea('草稿');
  await attach(el);
  await flush();
  assert.equal(speech.starts, 0);
  assert.equal(el.value, '草稿');
  assert.match(el.title, /键盘/);
});

test('再次点击停止听写：调用 stop，草稿不变', async () => {
  const speech = fakeSpeech();
  const { attach } = await mountVoicePage(speech);
  const el = fakeTextarea('草稿');
  await attach(el);
  await flush();
  await attach(el);
  await flush();
  assert.equal(speech.stops, 1);
  assert.equal(el.value, '草稿');
});
