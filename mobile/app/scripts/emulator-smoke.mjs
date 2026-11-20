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

class StepFailure extends Error {
  constructor(message, kind = 'fail') { super(message); this.kind = kind; }
}

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(appDir, 'work', 'smoke', stamp);
  const report = [];
  const finish = (code) => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
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
