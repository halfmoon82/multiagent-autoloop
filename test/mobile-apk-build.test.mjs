// apk-release-script 节点边界测试：授权后生成平台并注入 CAMERA/相机硬件声明、minSdk=23、
// 让内置 App 同源加载远程 /mobile/，再用仓库外密钥库 zipalign + apksigner 签名并产出 sha256。
// 全程用临时目录 + PATH 上的假命令，不调用真 SDK/密钥库、不改真实仓库文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SCRIPT = path.join(ROOT, 'mobile', 'app', 'build-apk.mjs');
const INDEX_HTML = path.join(ROOT, 'mobile', 'app', 'www', 'index.html');

const MANIFEST_REL = path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml');
const VARS_REL = path.join('android', 'variables.gradle');
const ASSET_CFG_REL = path.join('android', 'app', 'src', 'main', 'assets', 'capacitor.config.json');
const UNSIGNED_REL = path.join('android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
const SIGNED_REL = path.join('work', 'apk', 'nomoto-release.apk');
const CONSOLE_URL = 'https://auto.socialmore.net/mobile/';
const CONSOLE_HOST = 'auto.socialmore.net';

function shLog(file, prefix) {
  return `#!/bin/sh\nprintf '%s\\n' "${prefix} $*" >> ${JSON.stringify(file)}\n`;
}

function makeSandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'apk-build-node-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });

  // 源配置由脚本读取；autoloop.minSdkVersion 已是 23（门禁），server.url 不应被脚本写回源文件。
  writeFileSync(path.join(dir, 'capacitor.config.json'), JSON.stringify({
    appId: 'cool.autoloop.console',
    webDir: 'www',
    server: { androidScheme: 'https' },
    autoloop: { android: { minSdkVersion: 23 } },
  }, null, 2));

  // 模拟 cap add android 生成的平台：清单缺 CAMERA、minSdk 仍为默认 22。
  const manifest = path.join(dir, MANIFEST_REL);
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(manifest, '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="cool.autoloop.console">\n'
    + '  <uses-sdk android:minSdkVersion="22" android:targetSdkVersion="34" />\n'
    + '  <application android:label="NoMoTo">\n'
    + '    <activity android:name="cool.autoloop.console.MainActivity" android:exported="true"></activity>\n'
    + '  </application>\n'
    + '</manifest>\n');
  const vars = path.join(dir, VARS_REL);
  mkdirSync(path.dirname(vars), { recursive: true });
  writeFileSync(vars, 'ext {\n  minSdkVersion = 22\n  compileSdkVersion = 34\n}\n');
  const assetCfg = path.join(dir, ASSET_CFG_REL);
  mkdirSync(path.dirname(assetCfg), { recursive: true });
  writeFileSync(assetCfg, JSON.stringify({
    appId: 'cool.autoloop.console',
    appName: 'NoMoTo',
    server: { androidScheme: 'https' },
  }, null, 2));
  const unsigned = path.join(dir, UNSIGNED_REL);
  mkdirSync(path.dirname(unsigned), { recursive: true });
  writeFileSync(unsigned, 'fake-unsigned-apk-payload');

  // 自写原生源码与离线兜底页：由 scaffold 节点入库，构建期拷入生成的 android 工程并合并。
  const native = path.join(dir, 'native');
  mkdirSync(path.join(native, 'java', 'cool', 'autoloop', 'console', 'auth'), { recursive: true });
  writeFileSync(path.join(native, 'java', 'cool', 'autoloop', 'console', 'MainActivity.java'),
    'package cool.autoloop.console;\npublic class MainActivity {}\n');
  writeFileSync(path.join(native, 'manifest-additions.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<manifest-additions xmlns:android="http://schemas.android.com/apk/res/android">\n'
    + '  <uses-permission android:name="android.permission.CAMERA" />\n'
    + '  <uses-permission android:name="android.permission.RECORD_AUDIO" />\n'
    + '  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n'
    + '  <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\n'
    + '  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />\n'
    + '  <uses-permission android:name="android.permission.USE_BIOMETRIC" />\n'
    + '  <activity-config android:windowSoftInputMode="adjustResize" />\n'
    + '  <application>\n'
    + '    <service android:name="cool.autoloop.console.notify.ForegroundService" android:exported="false" android:foregroundServiceType="dataSync" />\n'
    + '  </application>\n'
    + '</manifest-additions>\n');
  writeFileSync(path.join(native, 'gradle-dependencies.gradle'),
    'dependencies {\n'
    + '  implementation "androidx.biometric:biometric:1.1.0"\n'
    + '  implementation "androidx.security:security-crypto:1.1.0-alpha06"\n'
    + '}\n');
  const wwwDir = path.join(dir, 'www');
  mkdirSync(wwwDir, { recursive: true });
  writeFileSync(path.join(wwwDir, 'offline.html'), '<html><head>'
    + '<meta name="autoloop-console-mobile-url" content="">'
    + '</head><body>网络不可用<button id="retry">重试</button></body></html>\n');
  const assetsPublic = path.join(dir, 'android', 'app', 'src', 'main', 'assets', 'public');
  mkdirSync(assetsPublic, { recursive: true });
  writeFileSync(path.join(assetsPublic, 'offline.html'), readFileSync(path.join(wwwDir, 'offline.html')));
  writeFileSync(path.join(dir, 'android', 'app', 'build.gradle'),
    'apply plugin: "com.android.application"\n\ndependencies {\n  implementation "androidx.core:core:1.0.0"\n}\n');

  // 构建工具假命令：只记录参数，不调用真实 SDK。
  const commands = path.join(dir, 'commands.log');
  const signing = path.join(dir, 'signing.log');
  const gradlew = path.join(dir, 'android', 'gradlew');
  writeFileSync(gradlew, shLog(commands, 'gradlew'), { mode: 0o755 });
  writeFileSync(path.join(bin, 'npx'), shLog(commands, 'npx'), { mode: 0o755 });
  writeFileSync(path.join(bin, 'zipalign'),
    '#!/bin/sh\n'
    + `printf '%s\\n' "zipalign $*" >> ${JSON.stringify(signing)}\n`
    + 'cp "$4" "$5"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'apksigner'),
    '#!/bin/sh\n'
    + `printf '%s\\n' "apksigner $*" >> ${JSON.stringify(signing)}\n`
    + 'prev=""; out=""\n'
    + 'for arg in "$@"; do\n'
    + '  if [ "$prev" = "--out" ]; then out="$arg"; fi\n'
    + '  prev="$arg"\n'
    + 'done\n'
    + 'if [ -n "$out" ]; then printf "signed-apk-payload" > "$out"; fi\n', { mode: 0o755 });

  // 仓库外密钥库（仅存在于临时目录，绝不入库）。
  writeFileSync(path.join(dir, 'release.jks'), 'fake-keystore-bytes');
  copyFileSync(BUILD_SCRIPT, path.join(dir, 'build-apk.mjs'));
  return { dir, commands, signing };
}

function runBuild(box, overrides = {}, { authorized = true } = {}) {
  const dir = box.dir || box;
  const bin = path.join(dir, 'bin');
  const env = {
    ...process.env,
    ANDROID_HOME: dir,
    ANDROID_SDK_ROOT: dir,
    AUTOLOOP_APK_KEYSTORE: path.join(dir, 'release.jks'),
    AUTOLOOP_APK_KEYSTORE_PASSWORD: 'ks-secret',
    AUTOLOOP_APK_KEY_ALIAS: 'release',
    AUTOLOOP_APK_KEY_PASSWORD: 'key-secret',
    AUTOLOOP_APK_ZIPALIGN: 'zipalign',
    AUTOLOOP_APK_APKSIGNER: 'apksigner',
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    ...overrides,
  };
  if (authorized) env.AUTOLOOP_APK_BUILD_AUTHORIZED = '1';
  else delete env.AUTOLOOP_APK_BUILD_AUTHORIZED;
  return spawnSync(process.execPath, [path.join(dir, 'build-apk.mjs')], {
    cwd: dir, env, encoding: 'utf8', timeout: 20000,
  });
}

function ok(result) {
  assert.equal(result.error, undefined, `脚本应能启动：${result.error?.message || ''}`);
  assert.equal(result.status, 0, `授权构建应成功：code=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
}

// --- RED 1：清单注入 CAMERA 权限与 camera 硬件非必需声明 ---
test('授权构建在生成的 AndroidManifest 注入 CAMERA 权限与相机硬件非必需声明', () => {
  const box = makeSandbox();
  try {
    ok(runBuild(box));
    const manifest = readFileSync(path.join(box.dir, MANIFEST_REL), 'utf8');
    assert.match(manifest, /<uses-permission\s+android:name="android\.permission\.CAMERA"\s*\/>/);
    assert.match(manifest, /<uses-feature\s+android:name="android\.hardware\.camera"\s+android:required="false"\s*\/>/);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// --- RED 2：minSdk 设为 23（variables.gradle 与清单 uses-sdk） ---
test('授权构建把 minSdk 从默认 22 提升到 23', () => {
  const box = makeSandbox();
  try {
    ok(runBuild(box));
    const vars = readFileSync(path.join(box.dir, VARS_REL), 'utf8');
    assert.match(vars, /minSdkVersion\s*=\s*23\b/);
    assert.doesNotMatch(vars, /minSdkVersion\s*=\s*22\b/);
    const manifest = readFileSync(path.join(box.dir, MANIFEST_REL), 'utf8');
    assert.match(manifest, /android:minSdkVersion="23"/);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// --- RED 3：App 同源加载远程 /mobile/，allowNavigation 仅含该主机 ---
test('授权构建让 capacitor server.url 指向 /mobile/ 且 allowNavigation 仅含控制台主机', () => {
  const box = makeSandbox();
  try {
    ok(runBuild(box));
    const cfg = JSON.parse(readFileSync(path.join(box.dir, ASSET_CFG_REL), 'utf8'));
    assert.equal(cfg.server.url, CONSOLE_URL);
    assert.equal(cfg.server.androidScheme, 'https');
    assert.deepEqual(cfg.server.allowNavigation, [CONSOLE_HOST]);
    // 构建期只改生成产物的配置，不写回被跟踪的源 capacitor.config.json。
    const source = JSON.parse(readFileSync(path.join(box.dir, 'capacitor.config.json'), 'utf8'));
    assert.equal(source.server.url, undefined);
    assert.equal(source.server.allowNavigation, undefined);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// --- RED 4：zipalign / apksigner 用仓库外密钥库签名，产物与 sha256 写入 work/apk/ ---
test('授权构建用环境变量密钥库签名并把产物与 sha256 写入 work/apk', () => {
  const box = makeSandbox();
  try {
    ok(runBuild(box));
    const signing = readFileSync(box.signing, 'utf8');
    assert.match(signing, /zipalign\s+-v\s+-p\s+4\s+.*app-release-unsigned\.apk\s+.*app-release-aligned\.apk/);
    assert.match(signing, /apksigner\s+sign\s+--ks\s+.*release\.jks\s+--ks-key-alias\s+release\s+--ks-pass\s+pass:ks-secret\s+--key-pass\s+pass:key-secret\s+--out\s+.*\.apk/);

    const signed = path.join(box.dir, SIGNED_REL);
    assert.ok(existsSync(signed), '签名后产物应写入 work/apk/');
    const digest = createHash('sha256').update(readFileSync(signed)).digest('hex');
    assert.match(readFileSync(`${signed}.sha256`, 'utf8'), new RegExp(digest), 'sha256 文件应含签名产物摘要');
    assert.ok(!readdirSync(path.dirname(signed)).some(name => /secret|keystore|jks/i.test(name)), 'work/apk/ 不得出现密钥库或口令文件');
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// --- RED 5：缺密钥库环境变量时拒绝且不留半成品 ---
test('缺密钥库环境变量时以非零码退出并给出可读原因，不产出半成品', () => {
  const box = makeSandbox();
  try {
    const result = runBuild(box, { AUTOLOOP_APK_KEYSTORE: '' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /AUTOLOOP_APK_KEYSTORE/);
    assert.ok(!existsSync(path.join(box.dir, SIGNED_REL)), '不得留下签名半成品');
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// --- RED 6：缺 SDK 时拒绝 ---
test('缺 Android SDK 时以非零码退出并给出可读原因', () => {
  const box = makeSandbox();
  try {
    const missing = path.join(box.dir, 'no-sdk-here');
    const result = runBuild(box, { ANDROID_HOME: missing, ANDROID_SDK_ROOT: missing });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /SDK/);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// --- RED 7：未授权时与现状一致只提示、不改任何文件 ---
test('未授权时只提示并以退出码 2 拒绝，不改动任何文件', () => {
  const box = makeSandbox();
  try {
    const result = runBuild(box, {}, { authorized: false });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /未获单独授权/);
    assert.match(readFileSync(path.join(box.dir, MANIFEST_REL), 'utf8'), /android:minSdkVersion="22"/, '未授权不得改清单');
    const assetCfg = JSON.parse(readFileSync(path.join(box.dir, ASSET_CFG_REL), 'utf8'));
    assert.equal(assetCfg.server.url, undefined, '未授权不得改 capacitor 配置');
    assert.ok(!existsSync(path.join(box.dir, SIGNED_REL)), '未授权不得产出 APK');
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// --- RED 8：内置壳预置默认控制台地址，避免手工注入 ---
test('www/index.html 预置默认控制台地址与同源 /mobile/ 说明', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');
  assert.match(html, /id="base-url"[^>]*value="https:\/\/auto\.socialmore\.net"/, '控制台地址应预置默认值，不必手工注入');
  assert.match(html, /https:\/\/auto\.socialmore\.net\/mobile\//, '应说明打包版直接加载同源 /mobile/');
});

// --- RED 9：原生权限与前台服务声明一次性合并进生成的 manifest ---
test('授权构建把全部原生权限与前台服务声明合并进 AndroidManifest', () => {
  const box = makeSandbox();
  try {
    ok(runBuild(box));
    const manifest = readFileSync(path.join(box.dir, MANIFEST_REL), 'utf8');
    for (const permission of ['CAMERA', 'RECORD_AUDIO', 'POST_NOTIFICATIONS', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_DATA_SYNC', 'USE_BIOMETRIC']) {
      assert.match(manifest, new RegExp(`android\\.permission\\.${permission}`), `缺少权限 ${permission}`);
    }
    assert.match(manifest, /<service[^>]*ForegroundService[^>]*>/, '缺少前台服务声明');
    assert.match(manifest, /<activity[^>]*android:windowSoftInputMode="adjustResize"/, '键盘应 adjustResize');
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// --- RED 10：gradle 片段合并 biometric 与 security-crypto ---
test('授权构建把 androidx.biometric 与 security-crypto 依赖合并进 build.gradle', () => {
  const box = makeSandbox();
  try {
    ok(runBuild(box));
    const gradle = readFileSync(path.join(box.dir, 'android', 'app', 'build.gradle'), 'utf8');
    assert.match(gradle, /androidx\.biometric:biometric/);
    assert.match(gradle, /androidx\.security:security-crypto/);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// --- RED 11：native/java 源码拷入生成的 android 工程 ---
test('授权构建把 native/java 源码拷入生成的 android 工程', () => {
  const box = makeSandbox();
  try {
    ok(runBuild(box));
    const copied = path.join(box.dir, 'android', 'app', 'src', 'main', 'java', 'cool', 'autoloop', 'console', 'MainActivity.java');
    assert.ok(existsSync(copied), '自写 MainActivity 应被拷入 android 工程');
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// --- RED 12：offline.html 的 meta 被注入远程 /mobile/ 地址 ---
test('授权构建把远程 /mobile/ 地址写入内置 offline.html 的 meta', () => {
  const box = makeSandbox();
  try {
    ok(runBuild(box));
    const html = readFileSync(path.join(box.dir, 'android', 'app', 'src', 'main', 'assets', 'public', 'offline.html'), 'utf8');
    assert.match(html, /name="autoloop-console-mobile-url" content="https:\/\/auto\.socialmore\.net\/mobile\/"/);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

// --- RED 13：原生源码缺失时非零退出且不产半成品 ---
test('缺少 native 原生源码时非零退出且不产出半成品', () => {
  const box = makeSandbox();
  try {
    rmSync(path.join(box.dir, 'native'), { recursive: true, force: true });
    const result = runBuild(box);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /native/);
    assert.ok(!existsSync(path.join(box.dir, SIGNED_REL)), '合并失败不得产出 APK');
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});
