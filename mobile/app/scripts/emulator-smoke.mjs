#!/usr/bin/env node
// Android 模拟器冒烟：在 API 23+ 模拟器装新 APK，逐项验证真机关键路径（npm run smoke:android）。
// 不属于 test/*.test.mjs，CI 不跑；需人工值守并自备模拟器与 APK。
// 无 adb/模拟器/APK 时明确报「未执行」（退出码 3），绝不当作通过；任一步失败给原因与截图（退出码 1）。
// 报告、截图与 UI 快照写入 work/smoke/<时间戳>/（work/ 已被忽略，不入库）。
//
// 环境变量（都不入库，绑定载荷与口令不写入日志/报告）：
//   AUTOLOOP_SMOKE_APK            待装 APK 路径（默认 work/apk/nomoto-release.apk）
//   AUTOLOOP_SMOKE_BIND_PAYLOAD   一次性备用码（autoloop://bind?token=…），粘贴绑定用
//   AUTOLOOP_SMOKE_SERIAL         主模拟器序列号（默认取第一台在线 emulator-*）
//   AUTOLOOP_SMOKE_SERIAL_B       第二台模拟器序列号（同步步骤；缺失则该步报「未执行」）
//   AUTOLOOP_SMOKE_BIND_PAYLOAD_B 第二台的备用码（缺失同上）
//   AUTOLOOP_SMOKE_PIN            设备 PIN（指纹录入用，默认 1234）
//   AUTOLOOP_SMOKE_PLAN_ID        设计授权步骤读取的计划编号（缺失则该步报「未执行」）
//   AUTOLOOP_SMOKE_AUTH_SUBMIT    设为 1 才真正点「确认并进入事件链」（会创建真实 DAG，默认只验证按钮可见）
//   AUTOLOOP_SMOKE_WEB_ARTIFACTS  网页产物页的标题清单（逗号分隔），产物页须逐一出现（缺失则一致性未执行）
//   AUTOLOOP_SMOKE_STARTUP_BASELINE_MS 改版前的首屏耗时基线（毫秒），缺失则「改善」未执行，仅记录数字
//   AUTOLOOP_SMOKE_SECOND_CONSOLE 已绑定的第二个控制台显示名片段（设置页切换用，缺失则该步未执行）
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const PACKAGE = 'cool.autoloop.console';
const MIN_API = 23;
const TABS = [['core', '总览'], ['rules', '规则'], ['rounds', '轮次'], ['todos', '待办'], ['sessions', '会话'], ['artifacts', '产物'], ['dag', 'DAG'], ['devices', '设备']];

export const EXIT = { pass: 0, fail: 1, notRun: 3 };

// 下拉刷新冒烟：核心 Tab 都在内容顶部；y 从 22% 拉到 62% 越过 56px 阈值且保持足够时长。
export const PULL_REFRESH_SMOKE_TABS = Object.freeze([['core', '总览'], ['rules', '规则'], ['rounds', '轮次'], ['todos', '待办'], ['sessions', '会话']]);

/** 生成 adb swipe 参数（x 取屏幕中线，y 按比例）；尺寸非法返回 null 由调用方标未执行。 */
export function pullSwipeArgs(width, height, { fromY = 0.22, toY = 0.62, durationMs = 500 } = {}) {
  const w = Number(width); const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return ['shell', 'input', 'swipe',
    String(Math.round(w / 2)), String(Math.round(h * fromY)),
    String(Math.round(w / 2)), String(Math.round(h * toY)),
    String(durationMs)];
}

export function findAdb(env = process.env) {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || '';
  const candidates = [sdk && path.join(sdk, 'platform-tools', 'adb'), 'adb'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

export function parseDevices(text) {
  return String(text).split('\n').slice(1).map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === 'device' && p[0].startsWith('emulator-')).map((p) => p[0]);
}

const NODE_RE = /<node [^>]*?(?:text|content-desc)="([^"]+)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;

// uiautomator 快照里按文本找节点，返回中心点。
export function findNode(xml, text) {
  for (const m of String(xml).matchAll(NODE_RE)) {
    if (m[1].includes(text)) {
      const [x1, y1, x2, y2] = m.slice(2).map(Number);
      return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
    }
  }
  return null;
}

// 文本溢出判定：任一节点横向越过屏幕即视为溢出。
export function findOverflow(xml, width) {
  const bad = [];
  for (const m of String(xml).matchAll(NODE_RE)) {
    const [x1, , x2] = m.slice(2).map(Number);
    if (x2 > width + 1 || x1 < -1) bad.push(m[1].slice(0, 30));
  }
  return bad;
}

// uiautomator 里 selected="true" 的 Tab 文本（滑动切 Tab 判定用）。
export function selectedTab(xml, labels = TABS.map(([, l]) => l)) {
  for (const m of String(xml).matchAll(/<node [^>]*>/g)) {
    if (!/selected="true"/.test(m[0])) continue;
    const t = /(?:text|content-desc)="([^"]+)"/.exec(m[0]);
    if (t && labels.some((l) => t[1].includes(l))) return labels.find((l) => t[1].includes(l));
  }
  return null;
}

// 计时：返回 [结果, 毫秒]。uiautomator 一次 dump 约 0.5–1s，所以本脚本的计时分辨率约 1s，报告里如实标注。
export function timed(fn) {
  const t0 = Date.now();
  const value = fn();
  return [value, Date.now() - t0];
}

// 通知渠道 id（与 NotifyChannels.java 一致）按渠道名取已发出的通知条数。
export function countPosted(dumpsys, channelId) {
  return (String(dumpsys).match(new RegExp(`channel=${channelId}\\b`, 'g')) || []).length;
}

class StepFailure extends Error {
  constructor(message, kind = 'fail') { super(message); this.kind = kind; }
}

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(appDir, 'work', 'smoke', stamp);
  const report = [];
  const metrics = {};
  const finish = (code) => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify({ steps: report, metrics }, null, 2)}\n`);
    const mark = { pass: '通过', fail: '失败', 'not-run': '未执行' };
    for (const r of report) console.log(`[smoke] ${mark[r.status]}  ${r.step}${r.reason ? ` —— ${r.reason}` : ''}${r.screenshot ? `（截图 ${r.screenshot}）` : ''}`);
    console.log(`[smoke] 报告目录：${outDir}`);
    process.exit(code);
  };
  const notRunAll = (reason) => { report.push({ step: '环境检查', status: 'not-run', reason }); finish(EXIT.notRun); };

  const adbPath = findAdb();
  if (!adbPath) return notRunAll('未找到 adb（设置 ANDROID_HOME 或把 platform-tools 加入 PATH）；未执行，不代表通过');
  const apk = process.env.AUTOLOOP_SMOKE_APK || path.join(appDir, 'work', 'apk', 'nomoto-release.apk');
  if (!existsSync(apk)) return notRunAll(`未找到 APK：${path.relative(appDir, apk)}（先按授权流程 npm run android:apk，或设 AUTOLOOP_SMOKE_APK）；未执行`);
  const online = parseDevices(spawnSync(adbPath, ['devices'], { encoding: 'utf8' }).stdout);
  const serialA = process.env.AUTOLOOP_SMOKE_SERIAL || online[0];
  if (!serialA || !online.includes(serialA)) return notRunAll('没有在线的 Android 模拟器（adb devices 无 emulator-*）；未执行，不代表通过');
  const payloadA = process.env.AUTOLOOP_SMOKE_BIND_PAYLOAD || '';
  const pin = process.env.AUTOLOOP_SMOKE_PIN || '1234';
  const serialB = process.env.AUTOLOOP_SMOKE_SERIAL_B || online.find((s) => s !== serialA) || '';

  const adb = (serial, args, opts = {}) => spawnSync(adbPath, ['-s', serial, ...args], { encoding: opts.binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const sh = (serial, cmd) => String(adb(serial, ['shell', cmd]).stdout || '').trim();
  mkdirSync(outDir, { recursive: true });
  let shot = 0;
  const screenshot = (serial, label) => {
    const file = `${String(++shot).padStart(2, '0')}-${label.replace(/[^\w一-龥-]+/g, '_')}.png`;
    const r = adb(serial, ['exec-out', 'screencap', '-p'], { binary: true });
    if (r.status === 0 && r.stdout?.length) writeFileSync(path.join(outDir, file), r.stdout);
    return path.join('work', 'smoke', stamp, file);
  };
  const dump = (serial) => {
    adb(serial, ['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
    const xml = String(adb(serial, ['shell', 'cat', '/sdcard/ui.xml']).stdout || '');
    writeFileSync(path.join(outDir, `ui-${serial}-${Date.now()}.xml`), xml);
    return xml;
  };
  const pause = (s) => spawnSync('sleep', [String(s)]);
  const waitFor = (serial, text, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const node = findNode(dump(serial), text);
      if (node) return node;
      pause(1);
    }
    throw new StepFailure(`等待界面出现「${text}」超时（${ms / 1000}s）`);
  };
  const tap = (serial, node) => adb(serial, ['shell', 'input', 'tap', String(node.x), String(node.y)]);
  const typeText = (serial, text) => adb(serial, ['shell', 'input', 'text', text.replace(/ /g, '%s')]);
  const launch = (serial) => adb(serial, ['shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1']);
  const bindOn = (serial, payload) => {
    tap(serial, waitFor(serial, 'autoloop://bind'));
    typeText(serial, payload);
    tap(serial, waitFor(serial, '绑定设备'));
    waitFor(serial, '总览', 20000);
  };

  // [名称, 实现, 前置失败即中止后续, 截图所用序列号]
  const steps = [
    ['API 级别 ≥ 23', () => {
      const api = Number(sh(serialA, 'getprop ro.build.version.sdk'));
      if (!(api >= MIN_API)) throw new StepFailure(`模拟器 API=${api || '未知'}，需 ≥ ${MIN_API}`);
      return { reason: `API ${api}` };
    }, true],
    ['安装新 APK', () => {
      adb(serialA, ['uninstall', PACKAGE]);
      const r = adb(serialA, ['install', '-r', apk]);
      if (r.status !== 0 || !/Success/.test(String(r.stdout))) throw new StepFailure(`安装失败：${String(r.stdout || r.stderr).trim().slice(0, 200)}`);
    }, true],
    ['扫码弹相机权限', () => {
      adb(serialA, ['shell', 'pm', 'revoke', PACKAGE, 'android.permission.CAMERA']);
      launch(serialA);
      tap(serialA, waitFor(serialA, '扫码绑定'));
      const allow = waitFor(serialA, '允许', 12000);
      screenshot(serialA, 'camera-permission-dialog');
      tap(serialA, allow);
    }],
    ['粘贴备用码绑定', () => {
      if (!payloadA) throw new StepFailure('未提供 AUTOLOOP_SMOKE_BIND_PAYLOAD（一次性备用码）；该步未执行', 'not-run');
      bindOn(serialA, payloadA);
    }],
    ['指纹解锁', () => {
      adb(serialA, ['shell', 'locksettings', 'set-pin', pin]);
      adb(serialA, ['shell', 'am', 'force-stop', PACKAGE]);
      launch(serialA);
      tap(serialA, waitFor(serialA, '使用生物识别解锁'));
      pause(2);
      adb(serialA, ['emu', 'finger', 'touch', '1']);
      waitFor(serialA, '总览', 15000);
    }],
    ...TABS.map(([, label]) => [`Tab 可达且有数据：${label}`, () => {
      tap(serialA, waitFor(serialA, label));
      pause(2);
      const xml = dump(serialA);
      const tabLabels = new Set(TABS.map(([, l]) => l));
      const texts = [...xml.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).filter((t) => !tabLabels.has(t));
      if (texts.length < 2) throw new StepFailure(`「${label}」页没有可见数据内容（仅 ${texts.length} 个文本节点）`);
      return { reason: `${texts.length} 个文本节点` };
    }]),
    ['常驻通知出现', () => {
      if (!/NoMoTo 在线/.test(sh(serialA, 'dumpsys notification --noredact'))) throw new StepFailure('系统通知里没有「NoMoTo 在线」常驻通知');
    }],
    ['锁屏直复一条待办', () => {
      adb(serialA, ['shell', 'input', 'keyevent', 'KEYCODE_SLEEP']);
      adb(serialA, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
      adb(serialA, ['shell', 'cmd', 'statusbar', 'expand-notifications']);
      const xml = dump(serialA);
      const todo = findNode(xml, '待我决策') || findNode(xml, '回复');
      if (!todo) throw new StepFailure('通知栏找不到带直复的待办通知（需先在控制台制造一条待办）');
      tap(serialA, todo);
      typeText(serialA, 'smoke');
      adb(serialA, ['shell', 'input', 'keyevent', 'KEYCODE_ENTER']);
    }],
    ['第二台模拟器同步', () => {
      const payloadB = process.env.AUTOLOOP_SMOKE_BIND_PAYLOAD_B || '';
      if (!serialB) throw new StepFailure('没有第二台在线模拟器；该步未执行', 'not-run');
      if (!payloadB) throw new StepFailure('未提供 AUTOLOOP_SMOKE_BIND_PAYLOAD_B；该步未执行', 'not-run');
      adb(serialB, ['install', '-r', apk]);
      launch(serialB);
      bindOn(serialB, payloadB);
      tap(serialB, waitFor(serialB, '待办'));
      pause(2);
      if (!/smoke/.test(dump(serialB))) throw new StepFailure('第二台待办页没有看到第一台直复的内容（同步未到达）');
    }, false, serialB || serialA],
    ['重连恢复', () => {
      sh(serialA, 'svc wifi disable; svc data disable');
      try {
        waitFor(serialA, '重连中', 30000);
        screenshot(serialA, 'reconnecting');
      } finally {
        sh(serialA, 'svc wifi enable; svc data enable');
      }
      const [, ms] = timed(() => waitFor(serialA, '总览', 60000));
      const xml = dump(serialA);
      if (findNode(xml, '重连中')) throw new StepFailure('网络恢复后仍显示「重连中」');
      metrics.reconnectRecoverMs = ms;
      return { reason: `恢复后回到原页面，约 ${ms}ms` };
    }],
    ['Tab 滑动切换', () => {
      tap(serialA, waitFor(serialA, '总览'));
      pause(1);
      const before = selectedTab(dump(serialA));
      const size = /(\d+)x(\d+)/.exec(sh(serialA, 'wm size'));
      if (!size) throw new StepFailure('读不到屏幕尺寸，无法滑动');
      const w = Number(size[1]); const h = Number(size[2]);
      adb(serialA, ['shell', 'input', 'swipe', String(Math.round(w * 0.85)), String(Math.round(h * 0.5)), String(Math.round(w * 0.15)), String(Math.round(h * 0.5)), '200']);
      pause(1);
      const after = selectedTab(dump(serialA));
      if (!after || after === before) throw new StepFailure(`左滑后 Tab 没有变化（滑前 ${before || '未知'}，滑后 ${after || '未知'}）`);
      return { reason: `${before} → ${after}` };
    }],
    ['卡片展开收起', () => {
      tap(serialA, waitFor(serialA, '待办'));
      pause(2);
      tap(serialA, waitFor(serialA, '展开', 10000));
      pause(1);
      waitFor(serialA, '收起', 8000);
    }],
    ...PULL_REFRESH_SMOKE_TABS.map(([, label]) => [`下拉刷新：${label}`, () => {
      tap(serialA, waitFor(serialA, label));
      pause(1);
      const size = /(\d+)x(\d+)/.exec(sh(serialA, 'wm size'));
      const args = pullSwipeArgs(size?.[1], size?.[2]);
      if (!args) throw new StepFailure('读不到屏幕尺寸，无法下拉');
      // 先回到内容顶部再下拉，落在纵向区间，不与卡片滚动/左滑关闭抢手势。
      adb(serialA, ['shell', 'input', 'swipe',
        String(Math.round(Number(size[1]) / 2)), String(Math.round(Number(size[2]) * 0.5)),
        String(Math.round(Number(size[1]) / 2)), String(Math.round(Number(size[2]) * 0.95)), '120']);
      adb(serialA, args);
      const refreshing = waitFor(serialA, '正在刷新', 6000);
      screenshot(serialA, `pull-refresh-${label}`);
      return { reason: `下拉出现刷新指示（约 ${refreshing.x},${refreshing.y}）` };
    }]),
    ['界面版本变化自动换新', () => {
      const turn = process.env.AUTOLOOP_SMOKE_VERSION_TURN || '';
      if (!turn) throw new StepFailure('未提供 AUTOLOOP_SMOKE_VERSION_TURN（控制台重打包后的版本号）；该步未执行', 'not-run');
      // 真机流程：重打包移动资源后切到「规则」，回前台等版本自检提示「控制台界面已更新」并自动换回原 tab。
      tap(serialA, waitFor(serialA, '总览'));
      tap(serialA, waitFor(serialA, '规则'));
      try { waitFor(serialA, '控制台界面已更新', 60000); }
      catch { throw new StepFailure('回前台 60s 内没有看到版本更新提示与自动换新'); }
      const current = selectedTab(dump(serialA));
      if (current !== '规则') throw new StepFailure(`自动换新后没有回到原 tab（当前 ${current || '未知'}）`);
      return { reason: `换到版本 ${turn} 后仍停在规则 tab` };
    }],
    ['三类通知到达', () => {
      const dumpsys = sh(serialA, 'dumpsys notification --noredact');
      const kinds = [['待我决策', 'autoloop_todo'], ['节点完成', 'autoloop_node_done'], ['会话新回复', 'autoloop_session']];
      const missing = kinds.filter(([name, id]) => countPosted(dumpsys, id) === 0 && !dumpsys.includes(name)).map(([name]) => name);
      if (missing.length) throw new StepFailure(`没有收到这几类通知：${missing.join('、')}（需先在控制台各制造一条）`);
    }],
    ['设置页控制台切换', () => {
      const second = process.env.AUTOLOOP_SMOKE_SECOND_CONSOLE || '';
      if (!second) throw new StepFailure('未提供 AUTOLOOP_SMOKE_SECOND_CONSOLE（已绑定的第二个控制台）；该步未执行', 'not-run');
      tap(serialA, waitFor(serialA, '设备与偏好'));
      waitFor(serialA, '当前控制台');
      tap(serialA, waitFor(serialA, second));
      waitFor(serialA, '总览', 30000);
    }],
    ['设计授权按钮可见并走通', () => {
      const plan = process.env.AUTOLOOP_SMOKE_PLAN_ID || '';
      if (!plan) throw new StepFailure('未提供 AUTOLOOP_SMOKE_PLAN_ID；该步未执行', 'not-run');
      tap(serialA, waitFor(serialA, '会话'));
      tap(serialA, waitFor(serialA, '确认执行范围'));
      const load = waitFor(serialA, '读取计划');
      adb(serialA, ['shell', 'input', 'text', plan.replace(/ /g, '%s')]);
      tap(serialA, load);
      const submit = waitFor(serialA, '确认并进入事件链', 20000);
      screenshot(serialA, 'design-authorize-buttons');
      if (process.env.AUTOLOOP_SMOKE_AUTH_SUBMIT !== '1') return { reason: '读取计划与提交按钮均可见（未提交，设 AUTOLOOP_SMOKE_AUTH_SUBMIT=1 才真点）' };
      tap(serialA, waitFor(serialA, '我已阅读'));
      tap(serialA, submit);
      waitFor(serialA, '已创建 DAG', 20000);
    }],
    ['乐观上屏与响应计时', () => {
      tap(serialA, waitFor(serialA, '会话'));
      pause(1);
      const marker = `smk${Date.now() % 100000}`;
      const send = waitFor(serialA, '发送', 8000);
      typeText(serialA, marker);
      const t0 = Date.now();
      tap(serialA, send);
      const [, onScreenMs] = timed(() => waitFor(serialA, marker, 5000));
      metrics.optimisticOnScreenMs = Date.now() - t0;
      const busy = (() => { try { return waitFor(serialA, '打断', 20000); } catch { return null; } })();
      if (!busy) throw new StepFailure('发送后 20s 内没有出现响应态（「打断」按钮）');
      metrics.sendToResponseStateMs = Date.now() - t0;
      const baseline = String(dump(serialA).length);
      const end = Date.now() + 30000;
      let first = null;
      while (Date.now() < end && !first) { pause(1); if (String(dump(serialA).length) !== baseline) first = Date.now() - t0; }
      if (first == null) throw new StepFailure('响应态出现后 30s 内没有看到流式首帧');
      metrics.firstStreamFrameMs = first;
      return { reason: `上屏≈${metrics.optimisticOnScreenMs}ms，响应态≈${metrics.sendToResponseStateMs}ms，流式首帧≈${first}ms（分辨率约 1s）` };
    }],
    ['打断带文本后新轮启动', () => {
      const marker = `stp${Date.now() % 100000}`;
      const steer = waitFor(serialA, '打断', 8000);
      typeText(serialA, marker);
      tap(serialA, steer);
      waitFor(serialA, marker, 8000);
    }],
    ['产物页有数据且与网页一致', () => {
      tap(serialA, waitFor(serialA, '产物'));
      pause(3);
      const xml = dump(serialA);
      const tabLabels = new Set(TABS.map(([, l]) => l));
      const texts = [...xml.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).filter((t) => !tabLabels.has(t));
      if (texts.length < 2) throw new StepFailure(`产物页没有数据（仅 ${texts.length} 个文本节点）`);
      const web = (process.env.AUTOLOOP_SMOKE_WEB_ARTIFACTS || '').split(',').map((t) => t.trim()).filter(Boolean);
      if (!web.length) throw new StepFailure('产物页有数据，但未提供 AUTOLOOP_SMOKE_WEB_ARTIFACTS，网页一致性未执行', 'not-run');
      const absent = web.filter((t) => !xml.includes(t));
      if (absent.length) throw new StepFailure(`网页有而 App 产物页缺少：${absent.slice(0, 5).join('、')}`);
    }],
    ['产物下载后页面出现提示', () => {
      const web = (process.env.AUTOLOOP_SMOKE_WEB_ARTIFACTS || '').split(',').map((t) => t.trim()).filter(Boolean);
      if (!web.length) throw new StepFailure('未提供 AUTOLOOP_SMOKE_WEB_ARTIFACTS，无法选择产物下载', 'not-run');
      tap(serialA, waitFor(serialA, '产物'));
      tap(serialA, waitFor(serialA, web[0]));
      tap(serialA, waitFor(serialA, '下载 '));
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        const xml = dump(serialA);
        if (/已开始下载|已下载完成/.test(xml)) { screenshot(serialA, 'download-feedback'); return; }
        if (/下载失败|重新绑定|HTTPS/.test(xml)) { screenshot(serialA, 'download-feedback-failed'); throw new StepFailure('下载后页面显示的是失败提示'); }
        pause(1);
      }
      throw new StepFailure('点击下载后 15s 内页面没有出现任何提示');
    }],
    ['首屏耗时', () => {
      adb(serialA, ['shell', 'am', 'force-stop', PACKAGE]);
      const out = String(adb(serialA, ['shell', 'am', 'start', '-W', '-n', `${PACKAGE}/.MainActivity`]).stdout || '');
      const total = Number((/TotalTime:\s*(\d+)/.exec(out) || [])[1]);
      const [, usable] = timed(() => waitFor(serialA, '总览', 30000));
      metrics.coldStartTotalMs = Number.isFinite(total) ? total : null;
      metrics.firstScreenUsableMs = usable;
      const base = Number(process.env.AUTOLOOP_SMOKE_STARTUP_BASELINE_MS || 0);
      const note = `冷启动 TotalTime=${total || '未知'}ms，到总览可见≈${usable}ms`;
      if (!base) throw new StepFailure(`${note}；未提供 AUTOLOOP_SMOKE_STARTUP_BASELINE_MS，「改善」未执行`, 'not-run');
      if (usable >= base) throw new StepFailure(`${note}，未优于基线 ${base}ms`);
      return { reason: `${note}，优于基线 ${base}ms` };
    }],
    ['系统字体 160% 无溢出', () => {
      adb(serialA, ['shell', 'settings', 'put', 'system', 'font_scale', '1.6']);
      try {
        adb(serialA, ['shell', 'am', 'force-stop', PACKAGE]);
        launch(serialA);
        waitFor(serialA, '总览', 20000);
        const size = /(\d+)x(\d+)/.exec(sh(serialA, 'wm size'));
        if (!size) throw new StepFailure('读不到屏幕尺寸，无法判定溢出');
        const bad = [];
        for (const [, label] of TABS) {
          tap(serialA, waitFor(serialA, label));
          pause(1);
          bad.push(...findOverflow(dump(serialA), Number(size[1])).map((t) => `${label}:${t}`));
        }
        if (bad.length) throw new StepFailure(`字体 160% 下文本越界：${bad.slice(0, 5).join('、')}`);
      } finally {
        adb(serialA, ['shell', 'settings', 'put', 'system', 'font_scale', '1.0']);
      }
    }],
  ];

  let aborted = false;
  for (const [name, fn, fatal, serial = serialA] of steps) {
    if (aborted) { report.push({ step: name, status: 'not-run', reason: '前置步骤（API/安装）失败，未执行' }); continue; }
    try {
      const res = fn();
      report.push({ step: name, status: 'pass', screenshot: screenshot(serial, name), ...(res || {}) });
    } catch (e) {
      const notRun = e instanceof StepFailure && e.kind === 'not-run';
      report.push({ step: name, status: notRun ? 'not-run' : 'fail', reason: e.message, screenshot: screenshot(serial, `${name}-fail`) });
      if (fatal && !notRun) aborted = true;
    }
  }
  finish(report.some((r) => r.status === 'fail') ? EXIT.fail : report.some((r) => r.status === 'not-run') ? EXIT.notRun : EXIT.pass);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
