// console-hub 节点：断联重连状态机（纯逻辑，假时钟/假探测，不连网络）。
// 覆盖：退避自动重连、持续连不上才进重连页、立即重试、回前台立即探测、页面请求失败立即探测、
// 恢复后回原页（resumePage）、401 不重试、离线兜底探测、心跳与生命周期事件接线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';
import {
  ShellState, MobileShellError, createReconnectController, reconnectStatusText, attachReconnectLifecycle,
  createMobileClient, createTokenStore,
} from '../mobile/app/www/shell.mjs';

function fakeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    pending() { return [...timers.values()].map(t => t.ms); },
    async fire() {
      const [id, timer] = [...timers.entries()][0] || [];
      if (!timer) return false;
      timers.delete(id);
      timer.fn();
      await new Promise(r => setImmediate(r));
      return true;
    },
  };
}

const unlocked = (opts) => { const s = new ShellState(opts); s.setToken('tok'); s.unlockSuccess(); return s; };
const netError = () => new MobileShellError('NETWORK', '无法连接控制台，请检查网络或地址');

function setup({ results = [], backoffMs = [1000, 2000, 4000, 8000, 15000], heartbeatMs = 0, unreachableAfter = 5 } = {}) {
  const state = unlocked({ backoffMs });
  const clock = fakeClock();
  const calls = { probe: 0, change: 0, resume: 0 };
  const queue = [...results];
  const controller = createReconnectController({
    state,
    probe: async () => {
      calls.probe += 1;
      const next = queue.length ? queue.shift() : 'ok';
      if (next instanceof Error) {
        // 与 createMobileClient.session 一致：失败时由客户端先把状态记成失败
        state.connectFailure(next.message, next.status ?? null);
        throw next;
      }
      state.connectSuccess();
      return {};
    },
    onChange: () => { calls.change += 1; },
    resumePage: () => { calls.resume += 1; },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    heartbeatMs, unreachableAfter,
  });
  return { state, clock, calls, controller };
}

test('退避自动重连：连不上按 1s/2s/4s/8s/15s 排重试，成功后清零', async () => {
  const { state, clock, calls, controller } = setup({ results: [netError(), netError(), netError(), 'ok'] });
  assert.equal(await controller.attempt(), false);
  assert.deepEqual(clock.pending(), [1000]);
  assert.equal(state.connection, 'error');
  await clock.fire();
  assert.deepEqual(clock.pending(), [2000]);
  await clock.fire();
  assert.deepEqual(clock.pending(), [4000]);
  await clock.fire();
  assert.equal(state.connection, 'online');
  assert.equal(state.retryAttempt, 0);
  assert.equal(calls.probe, 4);
  assert.deepEqual(clock.pending(), [], '恢复后不再排重试（无心跳时）');
});

test('持续连不上才进重连页：退避档位走完仍失败才置 unreachable，之前只显示重连中', async () => {
  const { state, clock, controller } = setup({ results: Array.from({ length: 6 }, netError) });
  await controller.attempt();
  for (let i = 0; i < 3; i++) await clock.fire();
  assert.equal(state.unreachable, false, '前几次失败只显示「重连中」，不进重连页');
  await clock.fire();
  assert.equal(state.unreachable, true, '第 5 次仍失败进重连页');
  assert.deepEqual(clock.pending(), [15000], '重连页期间仍按封顶档位自动重试');
  const view = controller.view();
  assert.equal(view.unreachable, true);
  assert.match(reconnectStatusText(view), /重连中（第 5 次，退避 15 秒后重试）· 已保留当前页面与输入/);
});

test('立即重试 + 恢复回原页：重连页点「立即重试」成功后清 unreachable 并回调 resumePage', async () => {
  const { state, clock, calls, controller } = setup({ results: [...Array.from({ length: 5 }, netError), 'ok'] });
  await controller.attempt();
  for (let i = 0; i < 4; i++) await clock.fire();
  assert.equal(state.unreachable, true);
  assert.equal(await controller.manualRetry(), true);
  assert.equal(state.unreachable, false);
  assert.equal(state.connection, 'online');
  assert.equal(calls.resume, 1, '恢复后回到原来的页面，不停留在错误页');
  assert.deepEqual(clock.pending(), [], '成功后取消待定的退避重试');
});

test('切回前台立即探测：不等退避计时，取消已排的重试', async () => {
  const { clock, calls, controller } = setup({ results: [netError(), 'ok'] });
  await controller.attempt();
  assert.deepEqual(clock.pending(), [1000]);
  assert.equal(await controller.onForeground(), true);
  assert.equal(calls.probe, 2);
  assert.deepEqual(clock.pending(), []);
});

test('页面请求连不上控制台（在线态）立即探测进入重连；非在线态不重复触发', async () => {
  const { state, clock, controller } = setup({ results: [netError()] });
  state.connectSuccess();
  await controller.onTransportError();
  assert.equal(state.connection, 'error');
  assert.deepEqual(clock.pending(), [1000]);
  assert.equal(await controller.onTransportError(), false, '已在重连中不重复探测');
});

test('401 授权失效：回锁定、清凭证，不排任何重试', async () => {
  const revoked = Object.assign(new MobileShellError('HTTP_401', '设备授权已失效'), { status: 401 });
  const { state, clock, controller } = setup({ results: [revoked] });
  await controller.attempt();
  assert.equal(state.phase, 'locked');
  assert.equal(state.needsBind, true);
  assert.deepEqual(clock.pending(), []);
});

test('断网：标记离线并按退避排一次兜底探测（旧 WebView online 事件不可靠）；online 立即重连', async () => {
  const { state, clock, controller } = setup({ results: [netError(), 'ok'] });
  state.connectSuccess();
  controller.onOffline();
  assert.equal(state.connection, 'offline');
  assert.deepEqual(clock.pending(), [1000], '离线后仍排兜底探测');
  await clock.fire();
  assert.equal(state.connection, 'error');
  assert.equal(await controller.onOnline(), true);
  assert.equal(state.connection, 'online');
});

test('在线心跳发现中台不可达；心跳成功时不把状态条闪成「正在连接」', async () => {
  const { state, clock, calls, controller } = setup({ heartbeatMs: 30000, results: ['ok', 'ok', netError()] });
  await controller.attempt();
  assert.deepEqual(clock.pending(), [30000]);
  const before = calls.change;
  await clock.fire();
  assert.equal(state.connection, 'online');
  assert.equal(calls.change, before + 1, '静默心跳只在结束时通知一次');
  await clock.fire();
  assert.equal(state.connection, 'error', '心跳失败进入重连');
  assert.deepEqual(clock.pending(), [1000]);
});

test('stop 后不再探测也不排重试（锁定/退出时）', async () => {
  const { clock, calls, controller } = setup({ results: [netError()] });
  await controller.attempt();
  controller.stop();
  assert.deepEqual(clock.pending(), []);
  assert.equal(await controller.attempt(), false);
  assert.equal(calls.probe, 1);
});

test('同一时刻只跑一个探测：并发触发复用同一个 Promise', async () => {
  const { calls, controller } = setup();
  await Promise.all([controller.attempt(), controller.onForeground(), controller.manualRetry()]);
  assert.equal(calls.probe, 1);
});

test('生命周期接线：visibilitychange 变可见/resume 走回前台探测，offline/online 走控制器', () => {
  const listeners = { doc: new Map(), win: new Map() };
  const target = map => ({
    addEventListener: (name, fn) => map.set(name, fn),
    removeEventListener: name => map.delete(name),
  });
  const doc = { ...target(listeners.doc), visibilityState: 'visible' };
  const win = target(listeners.win);
  const seen = [];
  const controller = {
    onForeground: async () => seen.push('fg'), onOffline: () => seen.push('off'), onOnline: async () => seen.push('on'),
  };
  const detach = attachReconnectLifecycle({ win, doc, controller });
  listeners.doc.get('visibilitychange')();
  doc.visibilityState = 'hidden';
  listeners.doc.get('visibilitychange')();
  listeners.doc.get('resume')();
  listeners.win.get('offline')();
  listeners.win.get('online')();
  assert.deepEqual(seen, ['fg', 'fg', 'off', 'on'], '隐藏时不探测');
  detach();
  assert.equal(listeners.doc.size + listeners.win.size, 0);
});

test('客户端网络层失败回调 onTransportError，不带 URL/凭证', async () => {
  let reported = null;
  const client = createMobileClient({
    base: 'https://console.example.com', tokenStore: createTokenStore(),
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    onTransportError: (...args) => { reported = args; },
  });
  await client.tokenStore.set('tok');
  await assert.rejects(() => client.api('state'), error => error.code === 'NETWORK');
  assert.deepEqual(reported, []);
});

test('app.mjs 接线：重连控制器、生命周期、立即重试按钮与恢复原页回调', () => {
  const app = readFileSync(new URL('../mobile/app/www/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /createReconnectController\(/);
  assert.match(app, /attachReconnectLifecycle\(\{ win: window, doc: document, controller: reconnector \}\)/);
  assert.match(app, /reconnectNow\.addEventListener\('click'/);
  assert.match(app, /resumePage: \(\) => renderViewState\(\)/);
  assert.match(app, /onTransportError/);
});

// ---------- 浏览器回归：中台不可达 → 退避重连 → 重连页 → 恢复回原页面且输入不丢 ----------

const browserSkip = (() => {
  try {
    return existsSync(chromium.executablePath()) ? false : 'npm test 阶段未安装 Playwright Chromium，跳过浏览器回归';
  } catch { return '无法探测 Playwright Chromium，跳过浏览器回归'; }
})();

test('浏览器：中台不可达自动退避重连，持续连不上进重连页，恢复后回原页面且输入保留', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-reconnect-'));
  const hub = await fakeHub((req, res) => {
    if (req.url === '/v1/state') return json(res, { runs: [], cards: [], lines: [], spending: {} });
    return json(res, { ok: true });
  });
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'secret', host: '127.0.0.1', root, rulesFile, deviceAuth, projectRoots: [root] });
  const url = await listen(server);
  let browser;
  t.after(async () => { if (browser) await browser.close(); await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let down = false; // 模拟杀掉中台进程：所有控制台 API 连不上
  await context.route('**/api/mobile/**', route => (down ? route.abort('connectionrefused') : route.continue()));
  await context.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(v) { stored = v; }, async remove() { stored = null; } };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.goto(`${url}/mobile/`);
  await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.waitForFunction(() => document.getElementById('connection-status')?.textContent?.includes('已安全连接'));

  // 用户在会话页输入了一半。
  await page.locator('[data-tab="sessions"]').click();
  await page.evaluate(() => {
    const input = document.querySelector('.sessions-composer-input');
    input.value = '写了一半的消息';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // 中台挂掉；切回前台立即探测 → 「重连中」，页面仍在、不跳错误页。
  down = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => /重连中（第 1 次，退避 1 秒后重试）/.test(document.getElementById('reconnect-banner')?.textContent || ''));
  assert.equal(await page.evaluate(() => document.getElementById('reconnect-panel').hidden), true, '短暂断联只显示状态条，不进重连页');
  assert.equal(await page.evaluate(() => document.querySelector('.content').hidden), false);

  // 退避档位走完（1+2+4+8 秒）仍连不上：进带「立即重试」的重连页，页面本体只隐藏不销毁。
  for (const ms of [1000, 2000, 4000, 8000]) {
    await page.clock.runFor(ms);
    await page.waitForFunction(() => !document.getElementById('reconnect-banner').hidden);
  }
  await page.waitForFunction(() => !document.getElementById('reconnect-panel').hidden);
  assert.match(await page.locator('#reconnect-panel').innerText(), /立即重试/);
  assert.equal(await page.evaluate(() => document.querySelector('.content').hidden), true);
  assert.equal(await page.evaluate(() => document.getElementById('app-main').hidden), false, '不回锁屏、不要求重新绑定');

  // 立即重试仍失败：留在重连页。
  await page.locator('#reconnect-now').click();
  await page.waitForFunction(() => !document.getElementById('reconnect-panel').hidden && /第 6 次/.test(document.getElementById('reconnect-banner').textContent));

  // 中台恢复：到点自动重连成功，回到原来的会话页，输入保留。
  down = false;
  await page.clock.runFor(15000);
  await page.waitForFunction(() => document.getElementById('connection-status')?.textContent?.includes('已安全连接'));
  await page.waitForFunction(() => document.getElementById('reconnect-panel').hidden && document.getElementById('reconnect-banner').hidden);
  assert.equal(await page.evaluate(() => document.querySelector('.content').hidden), false);
  assert.equal(await page.evaluate(() => document.getElementById('app-main').dataset.activeTab), 'sessions', '恢复后回到原来的页面');
  assert.equal(await page.evaluate(() => document.querySelector('.sessions-composer-input').value), '写了一半的消息', '重连全程不清空输入');

  // 再断一次：重连页上点「立即重试」直接恢复。
  down = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  for (const ms of [1000, 2000, 4000, 8000]) await page.clock.runFor(ms);
  await page.waitForFunction(() => !document.getElementById('reconnect-panel').hidden);
  down = false;
  await page.locator('#reconnect-now').click();
  await page.waitForFunction(() => document.getElementById('reconnect-panel').hidden && document.getElementById('connection-status')?.textContent?.includes('已安全连接'));
  assert.equal(await page.evaluate(() => document.getElementById('app-main').dataset.activeTab), 'sessions');
  assert.deepEqual(errors, []);
});
