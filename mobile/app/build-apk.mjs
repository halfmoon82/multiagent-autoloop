#!/usr/bin/env node
// 首版 Android APK 打包门禁（Spec §5.2.7 / §3、Issue 1）。
// 真机打包、签名、安装与验证需要单独授权且必须人工值守；CI 与 PR 合并不得自动触发。
// 未获授权时只给出可读阻塞原因并以非零码退出，绝不改动任何文件——APK 打包失败不阻塞其他节点。
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const authorized = process.env.AUTOLOOP_APK_BUILD_AUTHORIZED === '1';
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';

if (!authorized) {
  console.error('[apk] 未获单独授权：APK 打包、签名与真机安装须由控制台所有者显式授权（AUTOLOOP_APK_BUILD_AUTHORIZED=1）后人工运行。');
  process.exit(2);
}

const config = JSON.parse(readFileSync(path.join(here, 'capacitor.config.json'), 'utf8'));
const minSdk = Number(config.autoloop?.android?.minSdkVersion);
if (!Number.isInteger(minSdk) || minSdk > 23) {
  console.error('[apk] 打包配置未声明兼容当前旧版鸿蒙设备的 minSdkVersion（<= 23）。');
  process.exit(3);
}
if (!sdk || !existsSync(sdk)) {
  console.error('[apk] 未检测到 Android SDK：请设置 ANDROID_HOME 或 ANDROID_SDK_ROOT。');
  process.exit(4);
}

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: here, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`[apk] 步骤失败：${command} ${args.join(' ')}`);
    process.exit(5);
  }
};
// 全新 checkout 没有 android/ 平台目录，直接 cap sync 会失败；先生成平台再同步。
if (!existsSync(path.join(here, 'android'))) {
  run('npx', ['cap', 'add', 'android']);
}
run('npx', ['cap', 'sync', 'android']);
run(path.join(here, 'android', 'gradlew'), ['assembleRelease']);
console.log('[apk] Release 包已生成；签名与真机安装仍需按单独授权执行。');
