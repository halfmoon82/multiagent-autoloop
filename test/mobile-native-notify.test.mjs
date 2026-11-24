// native-notify 节点边界测试：纯静态校验原生源码的注入名、方法签名与错误行为。
// 原生源码由 build-apk.mjs 在授权打包期拷入生成的 android 工程，CI 无 Android SDK，
// 因此这里只校验源码契约（方法名/签名/常量/关键调用），真机行为由 smoke-emulator 汇总。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JAVA = 'mobile/app/native/java/cool/autoloop/console/notify';
const read = name => readFileSync(path.join(ROOT, JAVA, name), 'utf8');

const service = read('ForegroundService.java');
const plugin = read('AutoLoopNotifications.java');
const sources = [service, plugin, ...['AutoloopNotifyBridge.java', 'NotifyReplyReceiver.java', 'NotifyChannels.java']
  .filter(name => {
    try { read(name); return true; } catch { return false; }
  })
  .map(read)];
const all = sources.join('\n');

// 去掉注释后再断言，避免文档性注释里出现关键字造成假阳性。
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 注入名与方法签名 ----------
test('注入 window.AutoloopNotify：JS 桥以该全局名注册到 WebView', () => {
  assert.match(plugin, /addJavascriptInterface\s*\(/, '插件必须把 JS 桥注册进 WebView');
  assert.match(plugin, /["']AutoloopNotify["']/, '注入的全局名必须是 AutoloopNotify');
  assert.match(all, /window\.AutoloopNotify|AutoloopNotify/, '源码必须出现 AutoloopNotify 注入名');
});

test('AutoloopNotify 暴露 start/stop/notify/cancel/onReply/setBadge 六个方法', () => {
  const bridge = all.match(/@JavascriptInterface[\s\S]*?public\s+[\w<>\[\]]+\s+(\w+)\s*\(/g) || [];
  const names = bridge.map(block => block.match(/public\s+[\w<>\[\]]+\s+(\w+)\s*\(/)[1]);
  for (const method of ['start', 'stop', 'notify', 'cancel', 'onReply', 'setBadge']) {
    assert.ok(names.includes(method), `JS 桥缺少 @JavascriptInterface 方法 ${method}`);
  }
});

test('Capacitor 插件名保持 AutoloopNotifications 且提供 setBadge/refresh', () => {
  assert.match(plugin, /@CapacitorPlugin\(name\s*=\s*["']AutoloopNotifications["']\)/);
  assert.match(code(plugin), /public\s+void\s+setBadge\s*\(\s*PluginCall/);
  assert.match(code(plugin), /public\s+void\s+refresh\s*\(\s*PluginCall/);
});

// ---------- 前台服务与常驻通知 ----------
test('dataSync 前台服务：extends Service + startForeground + 常驻「NoMoTo 在线」', () => {
  assert.match(code(service), /class\s+ForegroundService\s+extends\s+Service/);
  assert.match(code(service), /startForeground\s*\(/);
  assert.match(service, /NoMoTo 在线/);
  assert.match(code(service), /START_STICKY/, '被杀后系统应重拉前台服务');
});

test('待办与节点完成使用两个独立通知渠道', () => {
  assert.match(code(all), /CHANNEL_TODO\s*=\s*["']autoloop_todo["']/);
  assert.match(code(all), /CHANNEL_NODE_DONE\s*=\s*["']autoloop_node_done["']/);
  assert.match(code(all), /createNotificationChannel\s*\(/);
});

// ---------- 后台轮询 ----------
test('后台按设备令牌轮询 /api/mobile/api/state，令牌只走请求头', () => {
  assert.match(code(service), /["']\/api\/mobile\/api\/state["']/);
  assert.match(code(service), /x-device-token/);
  assert.match(code(service), /getStringExtra|EXTRA_DEVICE_TOKEN/, '设备令牌由 JS start 下发');
  assert.match(code(service), /EXTRA_INTERVAL_MS|getLongExtra/, '轮询间隔由 JS 下发');
});

// ---------- 系统通知与 RemoteInput 直复 ----------
test('RemoteInput 直复含选项按钮与文字输入', () => {
  assert.match(code(all), /RemoteInput\.Builder/);
  assert.match(code(all), /addRemoteInput|setRemoteInput/);
  assert.match(code(all), /setChoices/, '选项按钮要作为 choices 下发');
  assert.match(code(all), /PendingIntent/);
  assert.match(code(all), /FLAG_IMMUTABLE|FLAG_UPDATE_CURRENT/);
});

test('直复回调写 POST /api/mobile/cards/:id/answer', () => {
  assert.match(code(all), /\/api\/mobile\/cards\//);
  assert.match(code(all), /\/answer/);
  assert.match(code(all), /setRequestMethod\s*\(\s*["']POST["']\)/);
});

// ---------- 错误行为 ----------
test('401 停服务并发「请重新绑定」通知', () => {
  assert.match(code(all), /401/);
  assert.match(code(all), /stopSelf|stopForeground/);
  assert.match(all, /请重新绑定/);
});

test('网络错指数退避并封顶，不狂刷', () => {
  assert.match(code(service), /1L\s*<<|Math\.pow/, '退避应为指数增长');
  assert.match(code(service), /Math\.min\s*\([^;]*MAX_INTERVAL_MS/, '退避需封顶');
});

test('同一事项按 kind:id:revision 去重，不重复通知', () => {
  assert.match(code(all), /NOTIFIED|notifiedKey|dedup|alreadyNotified/);
  assert.match(code(all), /\.add\s*\(/);
});

test('直复失败保留通知并提示，成功后撤销通知', () => {
  assert.match(code(all), /\.cancel\s*\(/, '成功后撤销通知');
  assert.match(all, /失败|重试|直复失败/, '失败保留通知并提示');
});

test('角标 setBadge 落地（数量随待办变化）', () => {
  assert.match(code(all), /setBadge\s*\(/);
  assert.match(code(all), /BADGE|badge|setNumber|ShortcutBadger/);
});

// ---------- 运行时权限与重启 ----------
test('Android 13+ 运行时请求 POST_NOTIFICATIONS', () => {
  assert.match(code(plugin), /POST_NOTIFICATIONS/);
  assert.match(code(plugin), /SDK_INT\s*>=\s*(33|Build\.VERSION_CODES\.TIRAMISU)/);
  assert.match(code(plugin), /requestPermissions/);
});

test('电池优化被杀后下次打开 App 自动重启服务', () => {
  assert.match(code(plugin), /startForegroundService\s*\(/, 'App 打开时按持久化配置重启前台服务');
  assert.match(code(all), /PowerManager|isIgnoringBatteryOptimizations|onStartCommand/);
});
