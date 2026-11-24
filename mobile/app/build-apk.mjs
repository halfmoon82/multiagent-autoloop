#!/usr/bin/env node
// 首版 Android APK 打包门禁 + release 签名（Spec §5.2.7 / §3、Issue 1、Nomoto App 修复）。
// 真机打包、签名、安装与验证需要单独授权且必须人工值守；CI 与 PR 合并不得自动触发。
// 未获授权时只给出可读阻塞原因并以非零码退出，绝不改动任何文件——APK 打包失败不阻塞其他节点。
// 授权后：生成平台 → 注入 CAMERA 权限/相机非必需声明与 minSdk 23 → 内置壳加载本地 www（不烧死任何
// 控制台地址，首启引导添加）并经原生 HTTP 连接用户添加的控制台 → 用仓库外密钥库 zipalign + apksigner 签名
// → 产物与 sha256 写入 work/apk/。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const authorized = process.env.AUTOLOOP_APK_BUILD_AUTHORIZED === '1';
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';

// 多控制台（console-hub）：不再把单个控制台地址烧进 APK。内置壳从本地 https://localhost 加载，
// 首启未绑定时引导用户添加控制台；连接各控制台的 API 请求走 Capacitor 原生 HTTP（CapacitorHttp），
// 不经浏览器跨站请求，服务端同源/凭证规则保持不变、无需放宽 CORS。
const LOCAL_SHELL_URL = 'https://localhost/';
// 页面模块按 ../src/... 动态导入视图模型；本地壳没有控制台的 /mobile/src 路由，构建期把 mobile/src 拷进 assets。
const MOBILE_SRC = process.env.AUTOLOOP_MOBILE_SRC_DIR || path.join(here, '..', 'src');

// 自写原生源码与离线兜底页：一次性预留并入库在 native/，构建期拷入并合并生成的 android 工程。
const NATIVE_SRC = path.join(here, 'native');
const MANIFEST_ADDITIONS = path.join(NATIVE_SRC, 'manifest-additions.xml');
const GRADLE_DEPS = path.join(NATIVE_SRC, 'gradle-dependencies.gradle');
const OFFLINE_HTML = path.join(here, 'www', 'offline.html');

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
const run = (command, args, exitCode = 5, cwd = here) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    fail(exitCode, `步骤失败：${path.basename(command)}（退出码 ${result.status ?? 'N/A'}）`);
  }
};

// 自写原生源码只入库在 native/；生成目录 android/ 仍不入库。合并失败即非零退出，不产半成品。
function copyNativeJava() {
  const source = path.join(NATIVE_SRC, 'java');
  if (!existsSync(source)) fail(10, '缺少 native/java 源码目录');
  const target = path.join(here, 'android', 'app', 'src', 'main', 'java');
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
}

function mergeManifest(manifestPath, additionsXml) {
  let manifest = readFileSync(manifestPath, 'utf8');
  let body = additionsXml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<manifest-additions\b[^>]*>/, '')
    .replace(/<\/manifest-additions>/, '')
    .trim();
  // activity-config 不是清单节点，只用来给生成的 <activity> 追加属性（键盘 adjustResize）。
  const activityConfig = /<activity-config\b([^>]*)\/>/.exec(body);
  if (activityConfig) body = body.replace(activityConfig[0], '');
  const appMatch = /<application\b[^>]*>[\s\S]*?<\/application>/.exec(body);
  const outside = (appMatch ? body.replace(appMatch[0], '') : body).trim();
  const appInner = appMatch
    ? appMatch[0].replace(/^<application\b[^>]*>/, '').replace(/<\/application>$/, '').trim()
    : '';

  if (activityConfig) {
    for (const attribute of activityConfig[1].matchAll(/([\w:]+)="([^"]*)"/g)) {
      const [, name, value] = attribute;
      if (!manifest.includes(`${name}="`)) {
        manifest = manifest.replace(/(<activity\b[^>]*?)(>)/, `$1 ${name}="${value}"$2`);
      }
    }
  }

  if (outside) {
    const missing = outside.split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter(line => {
      const name = /android:name="([^"]+)"/.exec(line)?.[1];
      return !name || !manifest.includes(`android:name="${name}"`);
    });
    if (missing.length) {
      const block = missing.join('\n    ');
      if (/<application\b/.test(manifest)) manifest = manifest.replace(/(<application\b[^>]*>)/, `    ${block}\n    $1`);
      else manifest = manifest.replace(/(<manifest\b[^>]*>)/, `$1\n    ${block}`);
    }
  }
  if (appInner) {
    if (!/<application\b[^>]*>/.test(manifest)) fail(10, '生成的 AndroidManifest 缺少 <application>，无法合并前台服务声明');
    manifest = manifest.replace(/(<application\b[^>]*>)/, `$1\n    ${appInner}`);
  }
  writeFileSync(manifestPath, manifest);
}

function mergeGradle(gradlePath, additions) {
  let gradle = readFileSync(gradlePath, 'utf8');
  const lines = additions.split(/\r?\n/).map(line => line.trim()).filter(line => /^implementation\b/.test(line));
  const missing = lines.filter(line => !gradle.includes(line));
  if (!missing.length) return;
  const open = gradle.indexOf('dependencies {');
  if (open < 0) fail(10, '生成的 build.gradle 缺少 dependencies 块，无法合并原生依赖');
  const brace = gradle.indexOf('{', open);
  gradle = `${gradle.slice(0, brace + 1)}\n    ${missing.join('\n    ')}${gradle.slice(brace + 1)}`;
  writeFileSync(gradlePath, gradle);
}

function generatedAssetDirs() {
  // cap sync 把 www/ 拷进生成的 assets（Capacitor 版本不同目录名可能是 public 或 www）。
  return [
    path.join(here, 'android', 'app', 'src', 'main', 'assets', 'public'),
    path.join(here, 'android', 'app', 'src', 'main', 'assets', 'www'),
  ].filter(dir => existsSync(dir));
}

// 内置 www 的内容指纹（sha256 前 16 位）：写入离线页 meta，便于核对包内壳与服务端 hash 长缓存版本的对应关系。
function wwwFingerprint() {
  const hash = createHash('sha256');
  const walk = rel => {
    for (const entry of readdirSync(path.join(here, 'www', rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) hash.update(`${next}\0`).update(readFileSync(path.join(here, 'www', next)));
    }
  };
  walk('');
  return hash.digest('hex').slice(0, 16);
}

// 离线兜底页的「重试」回到本地壳入口（不再指向任何固定控制台）；连哪台控制台由壳内的控制台列表决定。
function injectOfflineUrl() {
  if (!existsSync(OFFLINE_HTML)) fail(11, '缺少内置 www/offline.html 离线兜底页');
  const original = readFileSync(OFFLINE_HTML, 'utf8');
  const meta = `<meta name="autoloop-console-mobile-url" content="${LOCAL_SHELL_URL}">`;
  const withUrl = /<meta\s+name="autoloop-console-mobile-url"/.test(original)
    ? original.replace(/<meta\s+name="autoloop-console-mobile-url"[^>]*>/, meta)
    : original.replace(/<\/head>/, `  ${meta}\n  </head>`);
  const fingerprint = `<meta name="autoloop-www-fingerprint" content="${wwwFingerprint()}">`;
  const html = /<meta\s+name="autoloop-www-fingerprint"/.test(withUrl)
    ? withUrl.replace(/<meta\s+name="autoloop-www-fingerprint"[^>]*>/, fingerprint)
    : withUrl.replace(/<\/head>/, `  ${fingerprint}\n  </head>`);
  const targets = generatedAssetDirs().map(dir => path.join(dir, 'offline.html'));
  if (!targets.length) fail(11, '未找到生成的 Android assets 目录，无法注入离线兜底页');
  for (const file of targets) writeFileSync(file, html);
}

// 本地壳的页面模块需要 mobile/src 视图模型：拷到 assets/<public|www>/src，与浏览器里 /mobile/src 同一相对路径。
function copyMobileSources() {
  if (!existsSync(MOBILE_SRC)) fail(11, '缺少 mobile/src 视图模型目录，本地壳无法加载页面模块');
  const dirs = generatedAssetDirs();
  if (!dirs.length) fail(11, '未找到生成的 Android assets 目录，无法拷入页面视图模型');
  for (const dir of dirs) cpSync(MOBILE_SRC, path.join(dir, 'src'), { recursive: true });
}

function mergeNativeSources() {
  for (const file of [MANIFEST_ADDITIONS, GRADLE_DEPS]) {
    if (!existsSync(file)) fail(10, `缺少 native/ 原生接缝文件：${path.basename(file)}`);
  }
  const manifestPath = path.join(here, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const gradlePath = path.join(here, 'android', 'app', 'build.gradle');
  if (!existsSync(manifestPath)) fail(8, '未找到生成的 AndroidManifest.xml：请先成功执行 cap add android / cap sync android。');
  if (!existsSync(gradlePath)) fail(10, '未找到生成的 android/app/build.gradle：请先成功执行 cap add android。');
  copyNativeJava();
  mergeManifest(manifestPath, readFileSync(MANIFEST_ADDITIONS, 'utf8'));
  mergeGradle(gradlePath, readFileSync(GRADLE_DEPS, 'utf8'));
  injectOfflineUrl();
  copyMobileSources();
}

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

  // 3) WebView 加载本地内置壳（不设 server.url、不放行任何远程导航），API 请求走原生 HTTP；
  //    只改生成产物的配置，不写回被跟踪的源文件。
  if (!existsSync(assetCfgPath)) {
    fail(8, '未找到生成的 assets/capacitor.config.json：请先成功执行 cap sync android。');
  }
  const assetCfg = JSON.parse(readFileSync(assetCfgPath, 'utf8'));
  const { url: _legacyUrl, allowNavigation: _legacyNavigation, ...server } = assetCfg.server || {};
  assetCfg.server = { ...server, androidScheme: 'https', errorPath: 'offline.html' };
  assetCfg.plugins = {
    ...(assetCfg.plugins || {}),
    CapacitorHttp: { ...(assetCfg.plugins?.CapacitorHttp || {}), enabled: true },
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

// 签名前门禁：合并后的清单、自写插件注册与编译产物必须完整，缺一即以码 12 退出、不进入签名。
// 注释里的声明不算数（先剥离 XML/Java 注释再比对）。
const VERIFY_FAIL = 12;

function stripXmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function stripJavaComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function listFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

function listJavaSources(dir) {
  return listFiles(dir).filter(file => file.endsWith('.java'));
}

function verifyBeforeSign() {
  const manifestPath = path.join(here, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const mainActivityPath = path.join(NATIVE_SRC, 'java', 'cool', 'autoloop', 'console', 'MainActivity.java');
  const javacRoot = path.join(here, 'android', 'app', 'build', 'intermediates', 'javac');
  const missing = [];

  // 1) 合并后清单含 manifest-additions 声明的全部权限与服务。
  const manifest = stripXmlComments(readFileSync(manifestPath, 'utf8'));
  const additions = stripXmlComments(readFileSync(MANIFEST_ADDITIONS, 'utf8'));
  for (const [, permission] of additions.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)) {
    if (!manifest.includes(`android:name="${permission}"`)) missing.push(`清单权限 ${permission}`);
  }
  for (const [, service] of additions.matchAll(/<service\b[^>]*?android:name="([^"]+)"/g)) {
    const declared = new RegExp(`<service\\b[^>]*android:name="${service.replace(/\./g, '\\.')}"`);
    if (!declared.test(manifest)) missing.push(`清单服务 ${service}`);
  }

  // 2) 自写 Capacitor 插件必须在 MainActivity 中 registerPlugin。
  if (!existsSync(mainActivityPath)) fail(10, '缺少 native/java 下的 MainActivity.java，无法校验插件注册');
  const mainActivity = stripJavaComments(readFileSync(mainActivityPath, 'utf8'));
  const sources = listJavaSources(path.join(NATIVE_SRC, 'java'));
  for (const source of sources) {
    const text = stripJavaComments(readFileSync(source, 'utf8'));
    if (!/@CapacitorPlugin\b/.test(text)) continue;
    const name = path.basename(source, '.java');
    if (!new RegExp(`registerPlugin\\(\\s*${name}\\.class\\s*\\)`).test(mainActivity)) {
      missing.push(`自写插件 ${name} 未在 MainActivity 中注册（registerPlugin）`);
    }
  }

  // 3) 每个自写源文件都有对应编译产物（按包路径定位 .class）。
  const compiled = listFiles(javacRoot).map(file => file.split(path.sep).join('/'));
  for (const source of sources) {
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(readFileSync(source, 'utf8'))?.[1];
    if (!pkg) continue;
    const rel = `${pkg.split('.').join('/')}/${path.basename(source, '.java')}.class`;
    if (!compiled.some(file => file.endsWith(`/${rel}`))) missing.push(`编译产物缺少类 ${pkg}.${path.basename(source, '.java')}`);
  }

  if (missing.length) {
    fail(VERIFY_FAIL, `签名前校验未通过，已拒绝签名：${missing.join('；')}`);
  }
  console.log('[apk] 签名前校验通过：清单、插件注册与编译产物齐全。');
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

  // 合并自写原生源码与离线兜底页（失败即非零退出，不进入签名步骤、不产半成品）。
  mergeNativeSources();
  patchAndroidPlatform();
  const creds = signingCredentials();
  run(path.join(here, 'android', 'gradlew'), ['assembleRelease'], 5, path.join(here, 'android'));
  verifyBeforeSign();
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
