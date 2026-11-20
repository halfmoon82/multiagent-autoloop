// native-speech 节点边界测试：静态校验原生 speech/ 插件类、window.AutoloopSpeech 注入名、
// 系统 SpeechRecognizer（非谷歌服务）、运行时 RECORD_AUDIO 与错误码回传。
// 真机/模拟器证据由后续 smoke 节点汇总；这里只做代码可判定部分，不调用真实模型、不碰真实设备。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEECH = path.join(ROOT, 'mobile', 'app', 'native', 'java', 'cool', 'autoloop', 'console', 'speech');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');
const readSpeech = name => readFileSync(path.join(SPEECH, name), 'utf8');

// ---------- 文件与 scaffold 接缝 ----------

test('speech/ 下原生实现齐全，且没有改动 scaffold 拥有的文件', () => {
  for (const name of ['AutoLoopSpeech.java', 'AutoLoopSpeechBridge.java', 'SpeechPermissionFragment.java']) {
    assert.ok(existsSync(path.join(SPEECH, name)), `缺少 ${name}`);
  }
});

test('scaffold 接缝保持原样：MainActivity 注册插件、manifest 有 RECORD_AUDIO、gradle 不引入谷歌服务', () => {
  const main = read('mobile/app/native/java/cool/autoloop/console/MainActivity.java');
  assert.match(main, /registerPlugin\(AutoLoopSpeech\.class\)/);
  const manifest = read('mobile/app/native/manifest-additions.xml');
  assert.ok(manifest.includes('android.permission.RECORD_AUDIO'), 'manifest 必须声明 RECORD_AUDIO');
  const gradle = read('mobile/app/native/gradle-dependencies.gradle');
  assert.doesNotMatch(gradle, /com\.google\.android\.gms/, '不得引入谷歌服务依赖');
});

// ---------- RED 1：系统识别服务，不依赖谷歌 ----------

test('AutoloopSpeech 插件用平台 SpeechRecognizer，不依赖谷歌服务', () => {
  const src = readSpeech('AutoLoopSpeech.java');
  assert.match(src, /@CapacitorPlugin\(name\s*=\s*"AutoloopSpeech"\)/);
  assert.match(src, /SpeechRecognizer\.createSpeechRecognizer\s*\(/);
  assert.match(src, /setRecognitionListener\s*\(/);
  assert.match(src, /RecognitionListener/);
  assert.match(src, /startListening\s*\(/);
  assert.match(src, /stopListening\s*\(/);
  assert.match(src, /\.destroy\s*\(\)/);
  assert.match(src, /RecognizerIntent\.EXTRA_PARTIAL_RESULTS/);
  assert.doesNotMatch(src, /com\.google\.android\.gms|GoogleApiAvailability|SpeechRecognitionApi/, '不得依赖谷歌服务');
});

test('isAvailable 在无识别服务时返回 false，不编造可用', () => {
  const src = readSpeech('AutoLoopSpeech.java');
  assert.match(src, /void isAvailable\s*\(/);
  assert.match(src, /SpeechRecognizer\.isRecognitionAvailable\s*\(/);
  assert.match(src, /\.put\s*\(\s*"available"/);
});

// ---------- RED 2：运行时请求 RECORD_AUDIO ----------

test('运行时请求 RECORD_AUDIO，拒权给明确错误码不崩溃', () => {
  const src = readSpeech('AutoLoopSpeech.java');
  assert.match(src, /Manifest\.permission\.RECORD_AUDIO/);
  assert.match(src, /checkSelfPermission\s*\(/);
  assert.match(src, /requestRuntimePermissions\s*\(/);
  assert.match(src, /AUTOLOOP_SPEECH_PERMISSION_DENIED/);
  const frag = readSpeech('SpeechPermissionFragment.java');
  assert.match(frag, /requestPermissions\s*\(/);
  assert.match(frag, /onRequestPermissionsResult\s*\(/);
  assert.match(frag, /RECORD_AUDIO|PermissionCallback/);
});

// ---------- RED 3：回调文字与错误码 ----------

test('onPartial/onResults 回传文字，onError 把网络/超时映射为错误码', () => {
  const src = readSpeech('AutoLoopSpeech.java');
  assert.match(src, /onPartialResults\s*\(/);
  assert.match(src, /onResults\s*\(/);
  assert.match(src, /onError\s*\(/);
  assert.match(src, /SpeechRecognizer\.RESULTS_RECOGNITION/);
  assert.match(src, /SpeechRecognizer\.ERROR_NETWORK/);
  assert.match(src, /SpeechRecognizer\.ERROR_SPEECH_TIMEOUT/);
  assert.match(src, /AUTOLOOP_SPEECH_NETWORK/);
  assert.match(src, /AUTOLOOP_SPEECH_TIMEOUT/);
  for (const e of ['autoloop:speech-partial', 'autoloop:speech-final', 'autoloop:speech-error']) {
    assert.ok(src.includes(e), `缺少事件 ${e}`);
  }
});

// ---------- RED 4：JS 桥注入名与 H5 契约 ----------

test('插件 load 注入 shim，且桥注入 window.AutoloopSpeech 五个方法', () => {
  const src = readSpeech('AutoLoopSpeech.java');
  assert.match(src, /public void load\s*\(/);
  assert.match(src, /AutoLoopSpeechBridge\.inject\s*\(/);
  const bridge = readSpeech('AutoLoopSpeechBridge.java');
  assert.match(bridge, /window\.AutoloopSpeech\s*=/);
  for (const m of ['isAvailable', 'start', 'stop', 'onPartial', 'onFinal', 'onError']) {
    assert.match(bridge, new RegExp(`${m}\\s*:\\s*function\\s*\\(`), `缺少 ${m}`);
  }
  assert.match(bridge, /evaluateJavascript\s*\(/);
});

test('识别文字以纯字符串事件回传，桥做转义且不自动发送任何内容', () => {
  const bridge = readSpeech('AutoLoopSpeechBridge.java');
  assert.match(bridge, /jsEscape\s*\(/);
  assert.match(bridge, /CustomEvent/);
  assert.doesNotMatch(bridge, /innerHTML|insertAdjacentHTML/, '不得拼接不可信 HTML');
  // 识别结果只通过回调交给 H5，本机不替用户发送任何内容。
  assert.doesNotMatch(bridge, /fetch\s*\(|XMLHttpRequest|\.submit\s*\(|sendMessage|autoloop:send/, '不得自动发送');
});
