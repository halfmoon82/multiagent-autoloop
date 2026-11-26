// card-two-places-consistency 浏览器回归（2026-11-26 review P2-2，假 Hub + 路由拦截）：
// 同一张决策卡在「待办」与「会话窗」两处出现——
// ①待办答完 → 切会话窗该卡同步消失（只剩另一张）；
// ②会话窗答完 → 切回待办该卡与角标同步收起（不等下拉刷新，靠统一「卡已答」状态源推送）；
// Hub 侧卡片全程保持 open（回答在网络层拦截），两处收起只可能来自本机统一状态源。
// 无 Chromium 时显式跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const browserSkip = (() => {
  try { return existsSync(chromium.executablePath()) ? false : 'npm test 阶段未安装 Playwright Chromium，跳过浏览器回归'; }
  catch { return '无法探测 Playwright Chromium，跳过浏览器回归'; }
})();

test('浏览器：决策卡两处同步——待办答→会话窗消失；会话窗答→待办与角标收起', { skip: browserSkip }, async t => {
  const cards = [
    { id: 81, title: '两处同步卡一', state: 'open', options: ['同意', '拒绝'], project: '/work/p', lane: 'scheduling:sess-a' },
    { id: 82, title: '两处同步卡二', state: 'open', options: ['继续', '暂停'], project: '/work/p', lane: 'scheduling:sess-a' },
  ];
  const sessions = [
    { id: 'sess-a', kind: 'scheduling', hubSubject: 'scheduling:sess-a', project: '/work/p', status: 'idle', prompt: '调度会话 A', updatedAt: '2026-11-26T02:00:00Z' },
  ];
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-card-two-places-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Hub 侧卡片始终保持 open：回答在网络层拦截，两处收起只能来自本机统一状态源。
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards, lines: [], spending: {} } : { ok: true }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, deviceAuth, projectRoots: [root] });
  const url = await listen(server);
  let browser;
  t.after(async () => { if (browser) await browser.close(); await close(server); await close(hub.server); });
  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 402, height: 874 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(value) { stored = value; }, async remove() { stored = null; } };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  const answered = [];
  await page.route('**/api/mobile/api/sessions', route => route.fulfill({ json: { sessions } }));
  await page.route('**/api/mobile/cards/*/answer', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[4]);
    answered.push({ id, body: route.request().postDataJSON() });
    return route.fulfill({ json: { changed: true, id, state: 'decided' } });
  });
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  // 角标探针：包一层 setBadge 记录每次计数（页面内部仍走原实现）。
  await page.evaluate(() => {
    const hooks = window.AutoloopHooks;
    window.__badgeCalls = [];
    const prev = hooks.notify.setBadge;
    hooks.notify.setBadge = count => { window.__badgeCalls.push(count); return prev?.call(hooks.notify, count); };
  });

  // 待办页：两张卡都在，回答卡一。
  await page.locator('[data-tab="todos"]').click();
  await page.waitForFunction(() => Boolean(document.querySelector('[data-card-id="81"]')) && Boolean(document.querySelector('[data-card-id="82"]')));
  await page.evaluate(() => {
    const box = document.querySelector('[data-card-id="81"]');
    box.querySelector('[data-card-option="0"]').click();
    box.querySelector('[data-card-submit]').click();
  });
  await page.waitForFunction(() => !document.querySelector('[data-card-id="81"]'), null, { timeout: 8000 });
  assert.deepEqual(answered.map(item => [item.id, item.body.choice]), [[81, 0]], '待办页回答送达');
  await page.waitForFunction(() => window.__badgeCalls.at(-1) === 1, null, { timeout: 8000 });

  // 切会话窗：卡一已消失，只剩卡二。
  await page.locator('[data-tab="sessions"]').click();
  await page.locator('[data-session-id="sess-a"].sessions-item').waitFor({ state: 'visible' });
  await page.evaluate(() => document.querySelector('[data-session-id="sess-a"].sessions-item').click());
  await page.waitForFunction(() => document.querySelector('.sessions-question')?.textContent?.includes('两处同步卡二'), null, { timeout: 8000 });
  const questionText = await page.evaluate(() => document.querySelector('.sessions-question')?.textContent || '');
  assert.equal(questionText.includes('两处同步卡一'), false, '待办答完卡一会话窗同步消失');
  assert.match(questionText, /问题 1 \/ 1/, '本会话只剩卡二一道题');

  // 会话窗回答卡二。
  await page.evaluate(() => [...document.querySelectorAll('.sessions-option')].find(button => button.textContent === '继续').click());
  await page.evaluate(() => document.querySelector('.sessions-question-submit').click());
  await page.waitForFunction(() => {
    const box = document.querySelector('.sessions-question');
    return !box || box.hidden || !box.textContent.includes('两处同步卡二');
  }, null, { timeout: 8000 });
  assert.deepEqual(answered.map(item => item.id), [81, 82], '会话窗回答送达');

  // 切回待办：卡二与角标不等下拉刷新即收起（统一状态源推送重渲染）。
  await page.locator('[data-tab="todos"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-card-id="82"]'), null, { timeout: 8000 });
  await page.waitForFunction(() => window.__badgeCalls.at(-1) === 0, null, { timeout: 8000 });
  assert.deepEqual(pageErrors, []);
});
