// card-quick-actions 浏览器回归（假 Hub + 浏览器内写客户端）：
// 浏览器加载移动端写客户端 → 点按等价调用 delegateCard → 真实设备鉴权服务端 → Hub 调度事件 →
// 卡片进待代理决策列表；Hub 不可用时浏览器收到可读重试文案，原卡保留不结案。
// 无 Chromium 时显式跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { createCardDelegateStore, DELEGATE_REASON, delegateSubject } from '../src/card-delegate.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const browserSkip = (() => {
  try { return existsSync(chromium.executablePath()) ? false : '未安装 Playwright Chromium，跳过浏览器回归'; }
  catch { return '无法探测 Playwright Chromium，跳过浏览器回归'; }
})();

test('浏览器：退回调度入待代理列表，Hub 不可用时可读重试且原卡保留', { skip: browserSkip }, async t => {
  const cards = [
    { id: 61, title: '退回我', state: 'open', options: ['继续', '暂停'], project: '/work/p' },
    { id: 62, title: 'Hub 失败卡', state: 'open', options: ['继续'], project: '/work/p' },
  ];
  const events = [];
  const resolves = [];
  const root = mkdtempSync(path.join(tmpdir(), 'card-quick-actions-browser-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hub = await fakeHub((req, res, body) => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch { /* 交给被测代码 */ }
    if (req.url === '/v1/state') return json(res, { cards, runs: [], lines: [], spending: {} });
    if (req.url === '/v1/events') {
      events.push(payload);
      // 第二张卡的调度事件被中台拒绝：模拟控制台不可用的重试路径。
      if (JSON.parse(payload.detail || '{}').cardId === 62) return json(res, { error: '中台暂不可用' }, 500);
      return json(res, { runId: 88 });
    }
    const match = /^\/v1\/cards\/(\d+)\/resolve$/.exec(req.url);
    if (match) { resolves.push(Number(match[1])); return json(res, { ok: true }); }
    return json(res, { ok: true });
  });
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const bound = deviceAuth.bindDevice({ token: deviceAuth.createBinding().token, name: '测试手机', platform: 'Android' });
  const delegateStore = createCardDelegateStore({ file: path.join(root, 'card-delegates.json') });
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'owner-key', sourceKey: 'source-key', host: '127.0.0.1',
    root, deviceAuth, cardDelegateStore: delegateStore, projectRoots: [root],
  });
  const url = await listen(server);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await close(server); await close(hub.server); });
  const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
  await page.goto(url + '/mobile/');

  const result = await page.evaluate(async ({ origin, token }) => {
    const { createSessionsWrite } = await import('/mobile/src/features/sessions/browser.mjs');
    const write = createSessionsWrite({ origin, tokenStore: { get: async () => token } });
    return await write.delegateCard(61);
  }, { origin: url, token: bound.deviceToken });
  assert.equal(result.ok, true, '浏览器内退回调度成功');
  assert.equal(events.length, 1);
  assert.equal(events[0].subject, delegateSubject(61), '调度事件唤醒对应事项');
  assert.ok(resolves.includes(61), '原卡已结案');
  assert.equal(delegateStore.listPending().length, 1, '卡片进入待代理决策列表');

  const retryMessage = await page.evaluate(async ({ origin, token }) => {
    const { createSessionsWrite } = await import('/mobile/src/features/sessions/browser.mjs');
    const write = createSessionsWrite({ origin, tokenStore: { get: async () => token } });
    try { await write.delegateCard(62); return null; }
    catch (error) { return String(error.message); }
  }, { origin: url, token: bound.deviceToken });
  assert.match(retryMessage, /操作暂时不可用，请稍后重试/, 'Hub 不可用时给可重试文案');
  assert.equal(resolves.includes(62), false, '事件失败原卡不结案，保留可重试');
});

// 返工 g1a2（review P1）：上一轮只在浏览器里直接调 write 客户端，未在 App 真 DOM 上点按钮——
// core.mjs renderTodos 没渲染三操作，App 内根本看不到。这里改走真实绑定/解锁/待办页 DOM：
// 三按钮可见 → 点退回调度出提示并入待代理列表 → 已处理/结案点完卡消失 → 失败就地报错保留卡。
test('浏览器 DOM：待办卡三操作可见，点退回调度出提示并入待代理列表，失败就地保留', { skip: browserSkip }, async t => {
  const cards = [
    { id: 71, title: '退回我', state: 'open', options: ['同意', '拒绝'], project: '/work/p' },
    { id: 72, title: '已处理我', state: 'open', options: ['同意'], project: '/work/p' },
    { id: 73, title: '结案我', state: 'open', options: ['同意'], project: '/work/p' },
    { id: 74, title: '失败卡', state: 'open', options: ['同意'], project: '/work/p' },
  ];
  const events = [];
  const resolves = [];
  const root = mkdtempSync(path.join(tmpdir(), 'card-quick-actions-dom-'));
  const profile = mkdtempSync(path.join(tmpdir(), 'card-quick-actions-dom-profile-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  });
  const hub = await fakeHub((req, res, body) => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch { /* 交给被测代码 */ }
    if (req.url === '/v1/state') return json(res, { cards, runs: [], lines: [], spending: {} });
    if (req.url === '/v1/events') {
      events.push(payload);
      if (JSON.parse(payload.detail || '{}').cardId === 74) return json(res, { error: '中台暂不可用' }, 500);
      return json(res, { runId: 88 });
    }
    const match = /^\/v1\/cards\/(\d+)\/resolve$/.exec(req.url);
    if (match) {
      const id = Number(match[1]);
      resolves.push({ id, reason: payload.reason });
      const card = cards.find(item => item.id === id);
      if (card) card.state = 'decided';
      return json(res, { ok: true });
    }
    return json(res, { ok: true });
  });
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const delegateStore = createCardDelegateStore({ file: path.join(root, 'card-delegates.json') });
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'owner-key', sourceKey: 'source-key', host: '127.0.0.1',
    root, deviceAuth, cardDelegateStore: delegateStore, projectRoots: [root],
  });
  const url = await listen(server);
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await close(server); await close(hub.server);
  });
  const qr = deviceAuth.createBinding();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 402, height: 874 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = {
      async get() { return stored; },
      async set(value) { stored = value; },
      async remove() { stored = null; },
    };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  await page.locator('#bind-payload').fill(qr.qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.locator('[data-tab="todos"]').click();
  await page.waitForFunction(() => document.querySelector('[data-card-id="71"] [data-card-quick="delegate-return"]'));

  // 每张待办卡都带三操作，顺序与网页版一致：已处理 / 结案 / 退回调度。
  assert.deepEqual(
    await page.locator('[data-card-id="71"] [data-card-quick]').allTextContents(),
    ['已处理', '结案', '退回调度'],
  );

  // 点退回调度：App 内出「已退回调度，等待代理结论」提示，卡离开待办并入待代理决策列表。
  await page.locator('[data-card-id="71"] [data-card-quick="delegate-return"]').click();
  await page.waitForFunction(() => document.querySelector('[data-card-quick-notice]')?.textContent?.includes('已退回调度，等待代理结论'));
  await page.waitForFunction(() => !document.querySelector('[data-card-id="71"]'));
  assert.equal(events.length, 1);
  assert.equal(events[0].subject, delegateSubject(71));
  assert.deepEqual(resolves.find(item => item.id === 71), { id: 71, reason: DELEGATE_REASON });
  assert.equal(delegateStore.listPending().length, 1, '卡片进入待代理决策列表');

  // 已处理 / 结案：点完即消失（沿用 fix4 闭环），原因分别固定为「已处理」「结案」。
  await page.locator('[data-card-id="72"] [data-card-quick="mark-handled"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-card-id="72"]'));
  await page.locator('[data-card-id="73"] [data-card-quick="resolve"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-card-id="73"]'));
  assert.deepEqual(resolves.filter(item => item.id === 72 || item.id === 73), [
    { id: 72, reason: '已处理' },
    { id: 73, reason: '结案' },
  ]);

  // Hub 不可用：就地可读报错，卡与三按钮都保留，可原样重试。
  await page.locator('[data-card-id="74"] [data-card-quick="delegate-return"]').click();
  await page.waitForFunction(() => document.querySelector('[data-card-id="74"] [data-card-error]')?.textContent?.trim());
  assert.match(await page.locator('[data-card-id="74"] [data-card-error]').innerText(), /操作暂时不可用|重试|失败/);
  assert.equal(await page.locator('[data-card-id="74"] [data-card-quick="delegate-return"]').count(), 1, '失败后按钮保留可重试');
  assert.deepEqual(pageErrors, []);
});
