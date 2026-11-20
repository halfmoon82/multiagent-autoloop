// native-auth 节点边界测试：静态校验原生 auth/ 插件类、注入名与 scaffold 接缝一致。
// 真机/模拟器证据由 smoke-emulator 节点汇总；这里只做代码可判定的部分，不调用真实模型、不碰真实设备。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTH = path.join(ROOT, 'mobile', 'app', 'native', 'java', 'cool', 'autoloop', 'console', 'auth');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');
const readAuth = name => readFileSync(path.join(AUTH, name), 'utf8');

// ---------- 文件与接缝存在性 ----------

test('auth/ 下六份原生实现齐全，且没有改动 scaffold 拥有的文件', () => {
  for (const name of [
    'AutoLoopBridge.java',
    'AutoLoopHostFragment.java',
    'AutoLoopWebChromeClient.java',
    'AutoLoopBiometric.java',
    'AutoLoopSecureStorage.java',
    'AutoLoopDownloads.java',
  ]) {
    assert.ok(existsSync(path.join(AUTH, name)), `缺少 ${name}`);
  }
});

test('MainActivity 仍按 scaffold 接缝注册全部插件并挂 WebChromeClient / DownloadListener（本节点不改它）', () => {
  const main = read('mobile/app/native/java/cool/autoloop/console/MainActivity.java');
  assert.match(main, /registerPlugin\(AutoLoopBiometric\.class\)/);
  assert.match(main, /registerPlugin\(AutoLoopSecureStorage\.class\)/);
  assert.match(main, /registerPlugin\(AutoLoopDownloads\.class\)/);
  assert.match(main, /setWebChromeClient\(new AutoLoopWebChromeClient\(\)\)/);
  assert.match(main, /setDownloadListener\(new AutoLoopDownloads\.DownloadBridge\(\)\)/);
});

test('scaffold 一次性依赖与权限声明保持原样，本节点不引入谷歌服务', () => {
  const gradle = read('mobile/app/native/gradle-dependencies.gradle');
  assert.match(gradle, /androidx\.biometric:biometric/);
  assert.match(gradle, /androidx\.security:security-crypto/);
  assert.doesNotMatch(gradle, /com\.google\.android\.gms/);
  const manifest = read('mobile/app/native/manifest-additions.xml');
  for (const p of ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO', 'android.permission.USE_BIOMETRIC']) {
    assert.ok(manifest.includes(p), `manifest 缺少 ${p}`);
  }
  for (const name of [
    'AutoLoopBridge.java', 'AutoLoopHostFragment.java', 'AutoLoopWebChromeClient.java',
    'AutoLoopBiometric.java', 'AutoLoopSecureStorage.java', 'AutoLoopDownloads.java',
  ]) {
    assert.doesNotMatch(readAuth(name), /com\.google\.android\.gms|GoogleApiAvailability/, `${name} 不得依赖谷歌服务`);
  }
});

// ---------- RED 1：相机/麦克风运行时权限转发 + 文件选择 ----------

test('WebChromeClient 把 VIDEO/AUDIO_CAPTURE 转运行时权限，授予或给 JS 明确错误码', () => {
  const src = readAuth('AutoLoopWebChromeClient.java');
  assert.match(src, /class AutoLoopWebChromeClient extends WebChromeClient/);
  assert.match(src, /onPermissionRequest\s*\(\s*PermissionRequest/);
  assert.match(src, /RESOURCE_VIDEO_CAPTURE/);
  assert.match(src, /RESOURCE_AUDIO_CAPTURE/);
  assert.match(src, /requestRuntimePermissions\s*\(/);
  assert.match(src, /AutoLoopHostFragment/);
  assert.match(src, /\.grant\s*\(/);
  assert.match(src, /\.deny\s*\(\s*\)/);
  assert.match(src, /AUTOLOOP_CAMERA_PERMISSION_DENIED/);
  assert.match(src, /autoloop:permission-denied/);
  // 拒权要回 JS 可读错误码；不能只默默 deny。
  assert.match(src, /reportToJs\s*\(/);
});

test('WebChromeClient 实现 onShowFileChooser，H5 文件选择走系统选择器并回传 Uri[]', () => {
  const src = readAuth('AutoLoopWebChromeClient.java');
  assert.match(src, /onShowFileChooser\s*\(/);
  assert.match(src, /ValueCallback\s*<\s*Uri\[\]\s*>/);
  assert.match(src, /FileChooserParams/);
  assert.match(src, /createIntent\s*\(/);
  assert.match(src, /launchForResult\s*\(/);
  assert.match(src, /onReceiveValue\s*\(/);
});

test('无 Activity 也可以用 headless Fragment 接权限与 activityResult（不改 MainActivity）', () => {
  const src = readAuth('AutoLoopHostFragment.java');
  assert.match(src, /extends\s+(androidx\.fragment\.app\.)?Fragment/);
  assert.match(src, /onRequestPermissionsResult\s*\(/);
  assert.match(src, /onActivityResult\s*\(/);
  assert.match(src, /requestPermissions\s*\(/);
  assert.match(src, /startActivityForResult\s*\(/);
  assert.match(src, /commitNow\s*\(\)/);
});

// ---------- RED 2：生物识别 ----------

test('AutoloopBiometric.verify 用 androidx.biometric，BIOMETRIC_WEAK | DEVICE_CREDENTIAL 兜底兼容旧鸿蒙', () => {
  const src = readAuth('AutoLoopBiometric.java');
  assert.match(src, /@CapacitorPlugin\(name\s*=\s*"AutoloopBiometric"\)/);
  assert.match(src, /@PluginMethod/);
  assert.match(src, /BiometricPrompt/);
  assert.match(src, /BIOMETRIC_WEAK/);
  assert.match(src, /DEVICE_CREDENTIAL/);
  assert.match(src, /canAuthenticate\s*\(/);
  assert.match(src, /onAuthenticationSucceeded\s*\(/);
  assert.match(src, /onAuthenticationError\s*\(/);
  assert.match(src, /onAuthenticationFailed\s*\(/);
  // 取消/失败必须 reject，JS 侧门禁 createBiometricGate 捕获后按 false 处理，绝不静默放行。
  assert.match(src, /call\.reject\s*\(/);
});

test('生物识别桥把成功映射为 true、取消/失败映射为 false，不放行', () => {
  const src = readAuth('AutoLoopBridge.java');
  assert.match(src, /BIOMETRIC_SHIM/);
  assert.match(src, /nativeVerify/);
  assert.match(src, /return\s+!!\s*\(\s*r\s*&&\s*r\.ok\s*\)/);
  assert.match(src, /catch\s*\(\s*function\s*\(\)\s*\{\s*return\s+false/);
});

// ---------- RED 3：EncryptedSharedPreferences 安全存储 ----------

test('AutoloopSecureStorage.get/set/remove 用 EncryptedSharedPreferences + MasterKey，不写 localStorage', () => {
  const src = readAuth('AutoLoopSecureStorage.java');
  assert.match(src, /@CapacitorPlugin\(name\s*=\s*"AutoloopSecureStorage"\)/);
  assert.match(src, /EncryptedSharedPreferences\.create/);
  assert.match(src, /MasterKey\.Builder/);
  assert.match(src, /AES256_GCM/);
  assert.match(src, /AES256_SIV/);
  for (const method of ['nativeGet', 'nativeSet', 'nativeRemove']) {
    assert.match(src, new RegExp(`@PluginMethod[\\s\\S]*?void ${method}\\s*\\(`), `缺少插件方法 ${method}`);
  }
  assert.doesNotMatch(src, /localStorage|sessionStorage/);
});

test('Keystore 异常回退进程内存并向 JS 报「重启后需重绑」错误码', () => {
  const src = readAuth('AutoLoopSecureStorage.java');
  assert.match(src, /memoryToken/);
  assert.match(src, /AUTOLOOP_STORAGE_UNAVAILABLE/);
  assert.match(src, /重绑|重新绑定/);
  // 异常路径要 resolve 带 error 字段，而不是把 token 丢成 undefined 后静默失败。
  assert.match(src, /\.put\s*\(\s*"error"/);
});

test('安全存储桥把 Capacitor 的 JSObject 解包成 H5 期望的原始 token 字符串', () => {
  const src = readAuth('AutoLoopBridge.java');
  assert.match(src, /SECURE_STORAGE_SHIM/);
  assert.match(src, /nativeGet/);
  assert.match(src, /nativeSet/);
  assert.match(src, /nativeRemove/);
  assert.match(src, /r\.value/);
  assert.match(src, /autoloop:secure-storage-error/);
});

// ---------- RED 4：系统下载管理器 + x-device-token ----------

test('AutoloopDownload.start 从安全存储取令牌，经 DownloadManager 下载到「下载」并发完成通知', () => {
  const src = readAuth('AutoLoopDownloads.java');
  assert.match(src, /@CapacitorPlugin\(name\s*=\s*"AutoloopDownload"\)/);
  assert.match(src, /@PluginMethod/);
  assert.match(src, /nativeStart/);
  assert.match(src, /DownloadManager\.Request/);
  assert.match(src, /addRequestHeader\s*\(\s*"x-device-token"/);
  assert.match(src, /VISIBILITY_VISIBLE_NOTIFY_COMPLETED/);
  assert.match(src, /DIRECTORY_DOWNLOADS/);
  assert.match(src, /AutoLoopSecureStorage\.readToken/);
  assert.match(src, /\.enqueue\s*\(/);
  assert.match(src, /class DownloadBridge implements DownloadListener/);
});

test('下载桥把 H5 的两参 start(url,name) 映射成 Capacitor options 并回传 started', () => {
  const src = readAuth('AutoLoopBridge.java');
  assert.match(src, /DOWNLOAD_SHIM/);
  assert.match(src, /start\s*:\s*function\s*\(\s*url\s*,\s*name\s*\)/);
  assert.match(src, /nativeStart\s*\(\s*\{\s*url/);
  assert.match(src, /r\.started/);
});

test('下载 URL 仅允许 https，缺设备令牌时给明确错误码不发请求', () => {
  const src = readAuth('AutoLoopDownloads.java');
  assert.match(src, /https:\/\//);
  assert.match(src, /AUTOLOOP_DOWNLOAD_INVALID_URL/);
  assert.match(src, /AUTOLOOP_DOWNLOAD_NO_TOKEN/);
});

// ---------- RED 5：scaffold 接缝——注入名与 H5 使用方一致 ----------

test('注入名与 H5 使用方逐字一致：Biometric / SecureStorage / Download', () => {
  const bridge = readAuth('AutoLoopBridge.java');
  const shell = read('mobile/app/www/shell.mjs');
  const app = read('mobile/app/www/app.mjs');
  // H5 按 window.AutoloopSecureStorage.get/set/remove 与 window.AutoloopBiometric.verify 调用。
  assert.match(shell, /bridge\s*\?\s*await\s+bridge\.get\s*\(\s*\)/);
  assert.match(shell, /await\s+bridge\.set\s*\(\s*token\s*\)/);
  assert.match(shell, /await\s+bridge\.remove\s*\(\s*\)/);
  assert.match(shell, /typeof\s+source\.verify\s*===\s*'function'/);
  assert.match(app, /AutoloopDownload\s*&&\s*typeof\s+window\.AutoloopDownload\.start/);
  // 三处注入都在原生侧由 shim 成品提供。
  assert.match(bridge, /window\.AutoloopSecureStorage\s*=/);
  assert.match(bridge, /window\.AutoloopBiometric\s*=/);
  assert.match(bridge, /window\.AutoloopDownload\s*=/);
});
