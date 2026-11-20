#!/usr/bin/env node
// 首版 Android APK 打包门禁 + release 签名（Spec §5.2.7 / §3、Issue 1、Nomoto App 修复）。
// 真机打包、签名、安装与验证需要单独授权且必须人工值守；CI 与 PR 合并不得自动触发。
// 未获授权时只给出可读阻塞原因并以非零码退出，绝不改动任何文件——APK 打包失败不阻塞其他节点。
// 授权后：生成平台 → 注入 CAMERA 权限/相机非必需声明与 minSdk 23 → 让内置壳同源加载远程
// /mobile/ → 用仓库外密钥库 zipalign + apksigner 签名 → 产物与 sha256 写入 work/apk/。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const authorized = process.env.AUTOLOOP_APK_BUILD_AUTHORIZED === '1';
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';

// 远程控制台同源入口：内置页若停留在 https://localhost，调用 /api/mobile/bind 属跨站，
// 服务端按设计拒绝跨站且无 CORS 预检，真机会报「无法连接控制台」。指向 /mobile/ 后同源。
const CONSOLE_BASE = 'https://auto.socialmore.net';
const CONSOLE_MOBILE_URL = `${CONSOLE_BASE}/mobile/`;
const CONSOLE_HOST = new URL(CONSOLE_BASE).host;

// 构建期工具与密钥库都来自环境变量，绝不入库；口令不写入任何产物或日志。
const MIN_SDK = 23;
const APK_OUT_DIR = path.join(here, 'work', 'apk');
const APK_NAME = 'nomoto-release.apk';
const SIGNED_APK = path.join(APK_OUT_DIR, APK_NAME);
const PENDING_APK = path.join(APK_OUT_DIR, 'nomoto-release.pending.apk');
let partialOutput = null;

class BuildError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => { throw new BuildError(code, message); };

if (!authorized) {
  console.error('[apk] 未获单独授权：APK 打包、签名与真机安装须由控制台所有者显式授权（AUTOLOOP_APK_BUILD_AUTHORIZED=1）后人工运行。');
  process.exit(2);
}

// 通用步骤执行器：工具失败时给出可读原因；不打印任何参数，避免把签名口令写进日志。
const run = (command, args, exitCode = 5) => {
  const result = spawnSync(command, args, { cwd: here, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    fail(exitCode, `步骤失败：${path.basename(command)}（退出码 ${result.status ?? 'N/A'}）`);
  }
};

function patchAndroidPlatform() {
  const manifestPath = path.join(here, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const varsPath = path.join(here, 'android', 'variables.gradle');
  const assetCfgPath = path.join(here, 'android', 'app', 'src', 'main', 'assets', 'capacitor.config.json');
  if (!existsSync(manifestPath)) {
    fail(8, '未找到生成的 AndroidManifest.xml：请先成功执行 cap add android / cap sync android。');
  }

  // 1) CAMERA 权限与相机硬件非必需声明（cap add android 生成的清单没有 CAMERA）。
  let manifest = readFileSync(manifestPath, 'utf8');
  const cameraPermission = '<uses-permission android:name="android.permission.CAMERA" />';
  const cameraFeature = '<uses-feature android:name="android.hardware.camera" android:required="false" />';
  const injected = `${cameraPermission}\n    ${cameraFeature}`;
  if (!manifest.includes('android.permission.CAMERA') || !manifest.includes('android.hardware.camera')) {
    manifest = manifest.replace(/(<manifest\b[^>]*>)/, `$1\n    ${injected}`);
  }
  // 2) minSdk 提升到 23（覆盖旧版鸿蒙设备）。
  if (/<uses-sdk\b/.test(manifest)) {
    manifest = manifest.replace(/(<uses-sdk\b[^>]*android:minSdkVersion=")\d+(")/, `$1${MIN_SDK}$2`);
  } else {
    manifest = manifest.replace(/(<manifest\b[^>]*>)/, `$1\n    <uses-sdk android:minSdkVersion="${MIN_SDK}" />`);
  }
  writeFileSync(manifestPath, manifest);

  if (existsSync(varsPath)) {
    const vars = readFileSync(varsPath, 'utf8');
    writeFileSync(varsPath, /minSdkVersion\s*=/.test(vars)
      ? vars.replace(/(minSdkVersion\s*=\s*)\d+/, `$1${MIN_SDK}`)
      : `${vars.trimEnd()}\nminSdkVersion = ${MIN_SDK}\n`);
  }

  // 3) 让 WebView 直接加载同源远程入口；只改生成产物的配置，不写回被跟踪的源文件。
  if (!existsSync(assetCfgPath)) {
    fail(8, '未找到生成的 assets/capacitor.config.json：请先成功执行 cap sync android。');
  }
  const assetCfg = JSON.parse(readFileSync(assetCfgPath, 'utf8'));
  assetCfg.server = {
    ...(assetCfg.server || {}),
    androidScheme: 'https',
    url: CONSOLE_MOBILE_URL,
    allowNavigation: [CONSOLE_HOST],
  };
  writeFileSync(assetCfgPath, `${JSON.stringify(assetCfg, null, 2)}\n`);
}

function signingCredentials() {
  const names = ['AUTOLOOP_APK_KEYSTORE', 'AUTOLOOP_APK_KEYSTORE_PASSWORD', 'AUTOLOOP_APK_KEY_ALIAS', 'AUTOLOOP_APK_KEY_PASSWORD'];
  const missing = names.filter(name => !process.env[name]);
  if (missing.length) {
    fail(6, `缺少签名环境变量：${missing.join('、')}（密钥库与口令来自仓库外环境变量，绝不入库）。`);
  }
  const keystore = process.env.AUTOLOOP_APK_KEYSTORE;
  if (!existsSync(keystore)) {
    fail(6, `密钥库文件不存在：${path.basename(keystore)}（请在仓库外提供有效路径）。`);
  }
  return {
    keystore,
    alias: process.env.AUTOLOOP_APK_KEY_ALIAS,
    ksPass: process.env.AUTOLOOP_APK_KEYSTORE_PASSWORD,
    keyPass: process.env.AUTOLOOP_APK_KEY_PASSWORD,
  };
}

function resolveTool(envName, binName) {
  const override = process.env[envName];
  if (override) return override;
  if (sdk) {
    const buildTools = path.join(sdk, 'build-tools');
    if (existsSync(buildTools)) {
      const versions = readdirSync(buildTools)
        .filter(v => existsSync(path.join(buildTools, v, binName)))
        .sort();
      if (versions.length) return path.join(buildTools, versions[versions.length - 1], binName);
    }
  }
  return binName;
}

function signRelease(creds) {
  const unsigned = path.join(here, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
  if (!existsSync(unsigned)) {
    fail(7, `未找到未签名 APK：${path.relative(here, unsigned)}（gradlew assembleRelease 可能未产出 release 包）。`);
  }
  mkdirSync(APK_OUT_DIR, { recursive: true });
  const aligned = path.join(here, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-aligned.apk');
  partialOutput = PENDING_APK;

  // zipalign 不含凭据，可按常规步骤报错。
  run(resolveTool('AUTOLOOP_APK_ZIPALIGN', 'zipalign'), ['-v', '-p', '4', unsigned, aligned]);

  // apksigner 参数含口令：失败时只报工具名，绝不回显参数。
  const signArgs = [
    'sign',
    '--ks', creds.keystore,
    '--ks-key-alias', creds.alias,
    '--ks-pass', `pass:${creds.ksPass}`,
    '--key-pass', `pass:${creds.keyPass}`,
    '--out', PENDING_APK,
    aligned,
  ];
  const result = spawnSync(resolveTool('AUTOLOOP_APK_APKSIGNER', 'apksigner'), signArgs, { cwd: here, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    fail(7, `apksigner 签名失败（退出码 ${result.status ?? 'N/A'}）；参数含凭据已隐藏。`);
  }
  renameSync(PENDING_APK, SIGNED_APK);
  partialOutput = SIGNED_APK;

  const digest = createHash('sha256').update(readFileSync(SIGNED_APK)).digest('hex');
  writeFileSync(`${SIGNED_APK}.sha256`, `${digest}  ${APK_NAME}\n`);
  console.log(`[apk] 签名完成：${path.relative(here, SIGNED_APK)}（sha256 已写入同目录 .sha256）。`);
}

function main() {
  const config = JSON.parse(readFileSync(path.join(here, 'capacitor.config.json'), 'utf8'));
  const minSdk = Number(config.autoloop?.android?.minSdkVersion);
  if (!Number.isInteger(minSdk) || minSdk > MIN_SDK) {
    fail(3, `打包配置未声明兼容当前旧版鸿蒙设备的 minSdkVersion（<= ${MIN_SDK}）。`);
  }
  if (!sdk || !existsSync(sdk)) {
    fail(4, '未检测到 Android SDK：请设置 ANDROID_HOME 或 ANDROID_SDK_ROOT。');
  }

  // 全新 checkout 没有 android/ 平台目录，直接 cap sync 会失败；先生成平台再同步。
  if (!existsSync(path.join(here, 'android'))) {
    run('npx', ['cap', 'add', 'android']);
  }
  run('npx', ['cap', 'sync', 'android']);

  patchAndroidPlatform();
  const creds = signingCredentials();
  run(path.join(here, 'android', 'gradlew'), ['assembleRelease']);
  signRelease(creds);
}

try {
  main();
} catch (error) {
  if (partialOutput && existsSync(partialOutput)) {
    rmSync(partialOutput, { force: true });
  }
  if (error instanceof BuildError) {
    console.error(`[apk] ${error.message}`);
    process.exit(error.code);
  }
  console.error(`[apk] 未预期错误：${error?.message || String(error)}`);
  process.exit(9);
}
