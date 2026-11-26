// app-refresh-mechanism 节点回归（DAG 2026-11-25 fix5b）：
// 1) 下拉刷新手势纯逻辑：仅顶部、纵向、越阈才触发；横向切页与取消互不干扰；
// 2) 版本自检纯逻辑：从服务端改写的入口 HTML 提取 ?v= 内容 hash，变化才回调整页重载，失败静默；
// 3) 会话上下文：当前 tab 跨整页重载保留，非法值回落 core；
// 4) 源码与设计合同标记（设计 verifier 静态口径）；
// 5) 真浏览器回归：真实控制台服务 + 假设备桥，下拉出现刷新指示并触发页面重载，版本变化后整页重载回到原 tab。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  extractMobileAssetVersion,
  createPullRefreshGesture,
  createVersionWatcher,
  isBundledShell,
  readSessionValue, writeSessionValue, restoreTab,
  REFRESH_TAB_KEY, REFRESH_VERSION_KEY,
  PULL_REFRESH_THRESHOLD_PX,
} from '../mobile/app/www/shell.mjs';
import { pullSwipeArgs, pullFromListArgs } from '../mobile/app/scripts/emulator-smoke.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(REPO, rel), 'utf8');

// ---------------------------------------------------------------------------
// 下拉手势纯逻辑
// ---------------------------------------------------------------------------

test('下拉手势：顶部纵向越过阈值才触发，松开回弹不触发', () => {
  const g = createPullRefreshGesture();
  assert.equal(g.start({ x: 150, y: 40, t: 0, atTop: true }), true);
  assert.deepEqual(g.move({ x: 150, y: 40 }), { pulling: false, distance: 0, ready: false });
  const pulling = g.move({ x: 150, y: 40 + PULL_REFRESH_THRESHOLD_PX + 10 });
  assert.equal(pulling.pulling, true);
  assert.equal(pulling.ready, true);
  assert.equal(g.end({ x: 150, y: 40 + PULL_REFRESH_THRESHOLD_PX + 10 }).fired, true);
});

test('下拉手势：未到顶时接管手势但不触发，滚动交还浏览器', () => {
  const notTop = createPullRefreshGesture();
  assert.equal(notTop.start({ x: 100, y: 100, atTop: false }), true);
  assert.deepEqual(notTop.move({ x: 100, y: 300, atTop: false }), { pulling: false, distance: 0, ready: false });
  assert.equal(notTop.end({ x: 100, y: 300 }).fired, false);

  const horiz = createPullRefreshGesture();
  assert.equal(horiz.start({ x: 100, y: 100 }), true);
  horiz.move({ x: 180, y: 108 }); // 主轴锁为横向
  assert.equal(horiz.move({ x: 180, y: 260 }).pulling, false);
  assert.equal(horiz.end({ x: 180, y: 260 }).fired, false);

  const up = createPullRefreshGesture();
  assert.equal(up.start({ x: 100, y: 100 }), true);
  assert.equal(up.move({ x: 100, y: 20 }).pulling, false);
  assert.equal(up.end({ x: 100, y: 20 }).fired, false);

  const cancelled = createPullRefreshGesture();
  assert.equal(cancelled.start({ x: 100, y: 100 }), true);
  cancelled.move({ x: 100, y: 200 });
  assert.equal(cancelled.cancel().interrupted, true);
  assert.equal(cancelled.end({ x: 100, y: 300 }).fired, false);
});

test('下拉手势：距离设上限，回弹后不残留 active', () => {
  const g = createPullRefreshGesture({ thresholdPx: 50, maxPullPx: 72 });
  g.start({ x: 10, y: 10 });
  assert.equal(g.move({ x: 10, y: 400 }).distance, 72);
  assert.equal(g.active(), true);
  const r = g.end({ x: 10, y: 400 });
  assert.equal(r.fired, true);
  assert.equal(r.distance, 72);
  assert.equal(g.active(), false);
});

// 滚动守卫（issue #349）：会话历史/长列表从列表中部起拉，即使滚到顶后继续下拉也不得误触刷新。
// 旧版「起拉时未到顶、到顶时重设基准把滚动量算成下拉」正是会话页上滑浏览历史误触发的根因。
test('下拉手势：列表中部起拉滚到顶后继续下拉也不触发（会话历史浏览不误触）', () => {
  const g = createPullRefreshGesture({ thresholdPx: 56 });
  assert.equal(g.start({ x: 150, y: 600, t: 0, atTop: false }), true);
  // 手指下移 300px 把列表滚到顶；这是浏览历史，不该出现 pulling。
  assert.deepEqual(g.move({ x: 150, y: 900, atTop: true }), { pulling: false, distance: 0, ready: false });
  assert.equal(g.end({ x: 150, y: 900 }).fired, false, '只滚到顶就松手不能刷新');

  const scroll = createPullRefreshGesture({ thresholdPx: 56 });
  scroll.start({ x: 150, y: 600, t: 0, atTop: false });
  scroll.move({ x: 150, y: 900, atTop: true }); // 滚到顶（旧版在此重设基准）
  const r = scroll.move({ x: 150, y: 970, atTop: true }); // 继续下拉 70px
  assert.equal(r.pulling, false, '非顶部起拉整段手势都不进入下拉态');
  assert.equal(r.ready, false);
  assert.equal(scroll.end({ x: 150, y: 970 }).fired, false, '列表中部起拉不得误触刷新');
});

// 滚动守卫放行：起拉时容器已到顶 + 明确向下 + 非惯性，越过阈值才刷新。
test('下拉手势：从顶部起拉、匀速下拉越过阈值才触发', () => {
  const g = createPullRefreshGesture({ thresholdPx: 56 });
  assert.equal(g.start({ x: 150, y: 200, t: 1000, atTop: true }), true);
  assert.equal(g.move({ x: 150, y: 240, atTop: true, t: 1100 }).pulling, true);
  const r = g.move({ x: 150, y: 280, atTop: true, t: 1200 });
  assert.equal(r.ready, true);
  assert.equal(g.end({ x: 150, y: 280, t: 1250 }).fired, true);
});

test('下拉手势：高速甩动（惯性滚动）即使到顶越阈也不触发', () => {
  const g = createPullRefreshGesture({ thresholdPx: 56 });
  assert.equal(g.start({ x: 150, y: 200, t: 1000, atTop: true }), true);
  // 16ms 内下滑 120px，远超正常下拉速度，是聊天列表惯性/甩动。
  assert.equal(g.move({ x: 150, y: 320, atTop: true, t: 1016 }).pulling, false);
  assert.equal(g.move({ x: 150, y: 360, atTop: true, t: 1024 }).pulling, false);
  assert.equal(g.end({ x: 150, y: 360, t: 1030 }).fired, false);
});

test('下拉手势：守卫测量异常时宁可不触发', () => {
  const unknown = createPullRefreshGesture();
  assert.equal(unknown.start({ x: 150, y: 100, atTop: null }), true, 'atTop 不可信也应建会话，但不能武装刷新');
  assert.equal(unknown.move({ x: 150, y: 200, atTop: true }).pulling, false);
  assert.equal(unknown.end({ x: 150, y: 200 }).fired, false);
  const broken = createPullRefreshGesture();
  assert.equal(broken.start({ x: NaN, y: 100, atTop: true }), false);
  assert.equal(broken.end({ x: 100, y: 200 }).fired, false);
});

test('下拉手势：到顶后横向仍是 tab-swipe / 左滑的，不被下拉抢走', () => {
  const g = createPullRefreshGesture();
  assert.equal(g.start({ x: 100, y: 100, atTop: true }), true);
  g.move({ x: 180, y: 140, atTop: true }); // 主轴锁为横向
  assert.equal(g.move({ x: 180, y: 260, atTop: true }).pulling, false);
  assert.equal(g.end({ x: 180, y: 260 }).fired, false);
});

// ---------------------------------------------------------------------------
// 版本自检纯逻辑
// ---------------------------------------------------------------------------

test('版本 hash 从服务端改写后的入口 HTML 提取，缺失或畸形返回 null', () => {
  const html = read('mobile/app/www/index.html');
  const rewritten = html.replace(/(href|src)="(\.\/[^"?#]+\.(?:css|mjs))"/g, '$1="$2?v=0123456789abcdef"');
  assert.equal(extractMobileAssetVersion(rewritten), '0123456789abcdef');
  assert.equal(extractMobileAssetVersion(html), null);
  assert.equal(extractMobileAssetVersion(''), null);
  assert.equal(extractMobileAssetVersion(null), null);
  assert.equal(extractMobileAssetVersion('<a href="x?v=zzz">'), null);
});

test('版本 watcher：首检记录基线，版本变化回调一次，相同版本不回调', async () => {
  const html = version => `<link rel="stylesheet" href="./styles.css?v=${version}">`;
  let version = 'aaaaaaaaaaaaaaaa';
  const calls = [];
  const w = createVersionWatcher({
    getEntryUrl: () => 'https://console.example/mobile/index.html',
    fetchImpl: async url => {
      assert.match(url, /[?&]v=/);
      return { ok: true, text: async () => html(version) };
    },
    onChanged: info => calls.push(info),
  });
  const first = await w.check();
  assert.deepEqual(first, { ok: true, changed: false, version: 'aaaaaaaaaaaaaaaa' });
  assert.equal(w.version, 'aaaaaaaaaaaaaaaa');
  assert.equal(calls.length, 0);

  version = 'bbbbbbbbbbbbbbbb';
  const changed = await w.check();
  assert.equal(changed.changed, true);
  assert.equal(changed.previous, 'aaaaaaaaaaaaaaaa');
  assert.deepEqual(calls, [{ version: 'bbbbbbbbbbbbbbbb', previous: 'aaaaaaaaaaaaaaaa' }]);

  const same = await w.check();
  assert.equal(same.changed, false);
  assert.equal(calls.length, 1);
  w.stop();
});

test('版本 watcher：探测失败静默、无 base 跳过、计时器可停止', async () => {
  let fail = true;
  const w = createVersionWatcher({
    getEntryUrl: () => 'https://console.example/mobile/index.html',
    fetchImpl: async () => {
      if (fail) throw new Error('offline');
      return { ok: true, text: async () => '<link href="./styles.css?v=cccccccccccccccc">' };
    },
  });
  assert.deepEqual(await w.check(), { ok: false, reason: 'network' });
  fail = false;
  assert.equal((await w.check()).version, 'cccccccccccccccc');
  const skipped = createVersionWatcher({ getEntryUrl: () => null, fetchImpl: async () => { throw new Error('should not fetch'); } });
  assert.equal((await skipped.check()).ok, false);
  w.stop();
  skipped.stop();
});

test('版本 watcher：定时与回前台触发检查，停止后不再排程', async () => {
  const timers = [];
  const setTimer = (fn, ms) => { const id = { fn, ms, cleared: false }; timers.push(id); return id; };
  const clearTimer = id => { if (id) id.cleared = true; };
  const w = createVersionWatcher({
    getEntryUrl: () => 'https://console.example/mobile/index.html',
    fetchImpl: async () => ({ ok: true, text: async () => '<link href="./x.css?v=dddddddddddddddd">' }),
    intervalMs: 1000, setTimer, clearTimer,
  });
  w.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
  await w.onForeground();
  assert.equal(w.version, 'dddddddddddddddd');
  w.stop();
  assert.equal(timers[0].cleared, true);
  assert.equal((await w.onForeground()).ok, false);
});

// 内置壳判定：页面 origin 与控制台地址不一致时，整页重载拿不到新界面，禁止伪称已切换。
test('内置壳判定：随包冻结页面与远程控制台 origin 不同才为真', () => {
  assert.equal(isBundledShell('https://localhost/mobile/index.html', 'https://console.example'), true);
  assert.equal(isBundledShell('https://127.0.0.1:50761/mobile/', 'https://console.example:50761'), true);
  assert.equal(isBundledShell('http://127.0.0.1:50761/mobile/', 'http://127.0.0.1:50761'), false);
  assert.equal(isBundledShell('https://console.example/mobile/', 'https://console.example'), false);
  assert.equal(isBundledShell('https://console.example/mobile/', ''), false);
  assert.equal(isBundledShell('https://console.example/mobile/', null), false);
  assert.equal(isBundledShell('', 'https://console.example'), false);
});

test('源码标记：版本变化重载受内置壳判定约束且如实提示需更新安装包', () => {
  const app = read('mobile/app/www/app.mjs');
  assert.match(app, /isBundledShell\s*\(/);
  assert.match(app, /请更新安装包|需更新安装包/);
  const body = app.slice(app.indexOf('onChanged:'), app.indexOf('versionCheck.start()'));
  const gateAt = body.indexOf('isBundledShell');
  const reloadAt = body.indexOf('location.reload');
  assert.ok(gateAt >= 0 && reloadAt > gateAt, '版本回调必须先判内置壳，再决定是否整页重载');
});

// ---------------------------------------------------------------------------
// 上下文保留与源码标记
// ---------------------------------------------------------------------------

test('会话上下文：tab 值跨重载保留，非法值回落 core，存储失败不抛错', () => {
  const store = new Map();
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  writeSessionValue(REFRESH_TAB_KEY, 'sessions', storage);
  assert.equal(readSessionValue(REFRESH_TAB_KEY, storage), 'sessions');
  assert.equal(restoreTab(['core', 'rules', 'sessions'], readSessionValue(REFRESH_TAB_KEY, storage)), 'sessions');
  writeSessionValue(REFRESH_VERSION_KEY, 'abc', storage);
  assert.equal(readSessionValue(REFRESH_VERSION_KEY, storage), 'abc');
  assert.equal(restoreTab(['core', 'rules'], 'settings', 'core'), 'core');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readSessionValue(REFRESH_TAB_KEY, broken), null);
  assert.doesNotThrow(() => writeSessionValue(REFRESH_TAB_KEY, 'core', broken));
});

test('设计合同标记：app.mjs 命中 pull-refresh / version-reload 的 verifier 口径', () => {
  const app = read('mobile/app/www/app.mjs');
  const markers = {
    'pull-refresh': ['pull-to-refresh', 'pullRefresh', 'touchstart', '下拉', 'ptr-'],
    'version-reload': ['mobileVersion', 'assetVersion', '版本', 'location.reload', 'versionCheck'],
  };
  for (const [interaction, any] of Object.entries(markers)) {
    assert.ok(any.some(token => app.includes(token)), `${interaction} 未在 app.mjs 找到约定标记`);
  }
});

test('真机接线：touchmove 非被动且只在到顶下拉时阻止原生 overscroll', () => {
  const app = read('mobile/app/www/app.mjs');
  assert.match(app, /addEventListener\(['"]touchmove['"][^)]*passive:\s*false/, '必须用非被动 touchmove 才能阻止原生回弹');
  assert.match(app, /pull\.move\(\{[^}]*atTop/, '每次移动都要重新判定是否到顶');
  assert.match(app, /e\.preventDefault\(\)/, '到顶下拉需阻止原生 overscroll，避免 pointercancel 吃掉手势');
  // 未到顶时只滚动不阻止：preventDefault 必须跟在 pulling 判定之后（由浏览器回归覆盖实际行为）。
  const css = read('mobile/app/www/styles.css');
  assert.match(css, /ptr-idle|ptr-ready/, 'idle 态需有可见样式');
  assert.match(css, /ptr-refreshing/, 'refreshing 态需有可见样式');
  assert.match(css, /prefers-reduced-motion/, 'reduced-motion 降级保留');
  const smoke = read('mobile/app/scripts/emulator-smoke.mjs');
  assert.match(smoke, /已到顶下拉/, '冒烟步骤需覆盖已到顶下拉触发');
  assert.match(smoke, /会话页上滑浏览历史不误触/, '冒烟步骤需覆盖会话历史浏览不误触');
  assert.match(smoke, /列表中部起拉不误触/, '冒烟步骤需覆盖列表中部起拉不误触');
});

test('模拟器 swipe 参数：按屏幕宽高生成下拉坐标', () => {
  assert.deepEqual(pullSwipeArgs(400, 800), ['shell', 'input', 'swipe', '200', '176', '200', '496', '500']);
  assert.equal(pullSwipeArgs(0, 800), null);
});

test('真机手势参数：列表中部起拉到接近底缘，用于验证滚动浏览不误触', () => {
  // 402x874 屏幕：起点约 393px（列表中部，非顶缘），终点约 830px，跨度远大于 56px 阈值。
  assert.deepEqual(pullFromListArgs(402, 874), ['shell', 'input', 'swipe', '201', '393', '201', '830', '600']);
  assert.equal(pullFromListArgs(0, 874), null);
  assert.equal(pullFromListArgs(402, 0), null);
});

// ---------------------------------------------------------------------------
// 真浏览器回归（CI 未装 Chromium 时跳过，不误判功能）
// ---------------------------------------------------------------------------

const browserSkip = (() => {
  try { return existsSync(chromium.executablePath()) ? false : '未安装 Playwright Chromium，跳过浏览器回归'; }
  catch { return '无法探测 Chromium，跳过浏览器回归'; }
})();

test('浏览器：下拉刷新出现指示并触发重载；界面版本变化整页重载回原 tab', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-app-refresh-'));
  const profile = mkdtempSync(path.join(tmpdir(), 'mobile-app-refresh-profile-'));
  const hub = await fakeHub((req, res) => json(res, { ok: true }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'secret', host: '127.0.0.1', root, rulesFile, deviceAuth, projectRoots: [root] });
  const url = await listen(server);
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await close(server); await close(hub.server);
    rmSync(root, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  });

  const qr = deviceAuth.createBinding();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(v) { stored = v; }, async remove() { stored = null; } };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  await page.locator('#bind-payload').fill(qr.qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('connection-status')?.getAttribute('aria-label')?.includes('已安全连接'));

  // 切到「规则」Tab，用真实 TouchEvent 覆盖真机手势路径（不是只跑 PointerEvent）。
  await page.evaluate(() => window.AutoloopNav.selectTab('rules'));
  await page.waitForFunction(() => document.getElementById('app-main')?.dataset.activeTab === 'rules');
  // 造一个可滚动的内容区，模拟“列表不在顶部”的真实场景。
  await page.evaluate(() => {
    const surface = document.querySelector('.content');
    Object.defineProperty(surface, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(surface, 'clientHeight', { configurable: true, get: () => 800 });
    // scrollTop 真属性会被实际布局钳制，这里用可控假值模拟列表滚动位置。
    let top = 300;
    Object.defineProperty(surface, 'scrollTop', { configurable: true, get: () => top, set: v => { top = v; } });
    window.__fireTouch = (type, y) => {
      const t = new Touch({ identifier: 7, target: surface, clientX: 180, clientY: y });
      const ending = type === 'touchend' || type === 'touchcancel';
      surface.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: ending ? [] : [t], targetTouches: ending ? [] : [t], changedTouches: [t],
      }));
    };
  });

  // 未到顶的下拉只滚动，不出现刷新指示（浏览器回归“滚动不误触”）。
  await page.evaluate(() => {
    window.__fireTouch('touchstart', 400);
    window.__fireTouch('touchmove', 470);
    window.__fireTouch('touchmove', 520);
    window.__fireTouch('touchend', 520);
  });
  assert.equal(await page.evaluate(() => document.getElementById('pull-refresh-indicator')?.hidden), true, '列表未到顶的下拉不应触发刷新');

  // 会话页上滑浏览历史：从列表中部起拉 → 原生滚动回顶 → 继续下拉，守卫必须拦住，不出现刷新指示。
  await page.evaluate(() => window.AutoloopNav.selectTab('sessions'));
  await page.waitForFunction(() => document.getElementById('app-main')?.dataset.activeTab === 'sessions');
  await page.evaluate(() => {
    const surface = document.querySelector('.content');
    surface.scrollTop = 300;
    window.__fireTouch('touchstart', 400);
    surface.scrollTop = 0; // 会话消息流往上浏览历史，滚到顶
    window.__fireTouch('touchmove', 700);
    window.__fireTouch('touchmove', 780);
    window.__fireTouch('touchend', 780);
  });
  assert.equal(await page.evaluate(() => document.getElementById('pull-refresh-indicator')?.hidden), true, '会话历史滚动不得误触下拉刷新');

  // 已到顶下拉：从顶部起拉、匀速下拉越过阈值 → 指示器出现 → 松手刷新。
  await page.evaluate(() => window.AutoloopNav.selectTab('rules'));
  await page.waitForFunction(() => document.getElementById('app-main')?.dataset.activeTab === 'rules');
  await page.evaluate(async () => {
    const surface = document.querySelector('.content');
    surface.scrollTop = 0;
    window.__fireTouch('touchstart', 400);
    await new Promise(resolve => setTimeout(resolve, 80));
    window.__fireTouch('touchmove', 470);
    await new Promise(resolve => setTimeout(resolve, 80));
    window.__fireTouch('touchmove', 560); // 累计下拉 160px，越过阈值且非惯性
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('pull-refresh-indicator');
    return el && !el.hidden && /松开立即刷新规则/.test(el.textContent);
  }, null, { timeout: 3000 });
  assert.equal(await page.locator('#pull-refresh-indicator').getAttribute('data-state'), 'idle', '下拉未松手时应是 idle 态');
  await page.evaluate(() => window.__fireTouch('touchend', 560));
  await page.waitForFunction(() => {
    const el = document.getElementById('pull-refresh-indicator');
    return el && !el.hidden && el.textContent.includes('正在刷新');
  }, null, { timeout: 3000 });
  const indicatorText = await page.locator('#pull-refresh-indicator').textContent();
  assert.match(indicatorText, /正在刷新规则/);
  assert.equal(await page.locator('#pull-refresh-indicator').getAttribute('data-state'), 'refreshing');
  await page.waitForFunction(() => document.getElementById('pull-refresh-indicator')?.hidden === true, null, { timeout: 5000 });

  // 手势共存：下拉刷新之后横向滑动仍由 tab-swipe 切页，纵向与横向两套手势互不拦截。
  await page.evaluate(() => {
    const surface = document.querySelector('.content');
    const fire = (type, x, y) => surface.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', clientX: x, clientY: y }));
    fire('pointerdown', 300, 300);
    fire('pointermove', 240, 300);
    fire('pointermove', 160, 300);
    fire('pointerup', 160, 300);
  });
  await page.waitForFunction(() => document.getElementById('app-main')?.dataset.activeTab === 'sessions', null, { timeout: 3000 });

  // 版本自检：拦截 watcher 的入口探测，返回一个不同的 ?v= 版本，应整页重载并回到 rules。
  await page.evaluate(() => window.AutoloopNav.selectTab('rules'));
  await page.waitForFunction(() => document.getElementById('app-main')?.dataset.activeTab === 'rules');
  let probeCount = 0;
  await page.route('**/mobile/index.html**', async route => {
    probeCount += 1;
    const response = await route.fetch();
    const body = await response.text();
    const changed = body.replace(/([?&]v=)[0-9a-f]{16}/g, '$1ffffffffffffffff');
    assert.match(changed, /v=ffffffffffffffff/, '入口 HTML 未含可被提取的 ?v= 版本标记');
    await route.fulfill({ response, body: changed });
  });
  // 模拟回到 App 前台：立即触发一次版本探测，应拿到变化后的 ?v= 并整页重载。
  const reloaded = page.waitForEvent('load', { timeout: 8000 });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await reloaded;
  await page.waitForFunction(() => document.getElementById('app-main')?.dataset.activeTab === 'rules', null, { timeout: 8000 });
  assert.ok(probeCount >= 2, `版本探测未发生（probeCount=${probeCount}）`);
  assert.match(await page.locator('#tab-bar .tab[aria-selected="true"]').textContent(), /规则/);

  // 内置壳模式（安装版 App）：页面 origin 与控制台地址不同，版本变化不得整页重载，
  // 也不得伪称「已切换到新版」，应如实提示需更新安装包，并保留当前 tab 与页面状态。
  await page.evaluate(() => {
    window.AutoloopConsoleBase = 'https://console.example';
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input?.url || String(input));
      if (url.includes('console.example/mobile/index.html')) {
        return Promise.resolve(new Response(
          '<!doctype html><html><head><link rel="stylesheet" href="./styles.css?v=eeeeeeeeeeeeeeee"></head><body></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        ));
      }
      return realFetch(input, init);
    };
  });
  let bundledReloaded = false;
  const trackReload = () => { bundledReloaded = true; };
  page.on('load', trackReload);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => {
    const el = document.getElementById('toast');
    return el && !el.hidden && el.textContent.includes('请更新安装包');
  }, null, { timeout: 8000 });
  assert.doesNotMatch(await page.locator('#toast').textContent(), /自动为你切换到新版/);
  assert.equal(bundledReloaded, false, '内置壳版本变化不应整页重载');
  assert.equal(await page.evaluate(() => document.getElementById('app-main')?.dataset.activeTab), 'rules');
  page.off('load', trackReload);

  assert.deepEqual(errors, []);
});
