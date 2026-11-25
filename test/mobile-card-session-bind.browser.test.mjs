// decision-card-lifecycle 节点浏览器回归（假 Hub + 路由拦截）：
// 会话页只显示归属本会话（lane = scheduling:<会话id>）的决策卡；回答成功 → 卡立即消失；
// 切到同项目另一会话不串卡；回答失败就地报错并保留卡与选项。无 Chromium 时显式跳过。
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

test('浏览器：会话卡按会话归属，回答→卡消失→切会话不串卡；失败保留卡与选项', { skip: browserSkip }, async t => {
  const cards = [
    { id: 41, title: '会话A的问题', state: 'open', options: ['继续', '结案'], project: '/work/p', lane: 'scheduling:sess-a' },
    { id: 42, title: '会话B的问题', state: 'open', options: ['好', '不好'], project: '/work/p', lane: 'scheduling:sess-b' },
    { id: 43, title: '规则卡无会话', state: 'open', options: ['是'], project: '/work/p' },
  ];
  const sessions = [
    { id: 'sess-a', kind: 'scheduling', hubSubject: 'scheduling:sess-a', project: '/work/p', status: 'idle', prompt: '调度会话 A', updatedAt: '2026-11-25T02:00:00Z' },
    { id: 'sess-b', kind: 'scheduling', hubSubject: 'scheduling:sess-b', project: '/work/p', status: 'idle', prompt: '调度会话 B', updatedAt: '2026-11-25T01:00:00Z' },
  ];
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-card-bind-ui-'));
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards, lines: [], spending: {} } : { ok: true }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, deviceAuth, projectRoots: [root] });
  const url = await listen(server);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(value) { stored = value; }, async remove() { stored = null; } };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  let failNext = true;
  const answered = [];
  await page.route('**/api/mobile/api/sessions', route => route.fulfill({ json: { sessions } }));
  await page.route('**/api/mobile/cards/*/answer', route => {
    if (failNext) { failNext = false; return route.fulfill({ status: 502, json: { error: '操作暂时不可用，请稍后重试' } }); }
    const id = Number(new URL(route.request().url()).pathname.split('/')[4]);
    answered.push({ id, body: route.request().postDataJSON() });
    const card = cards.find(item => item.id === id);
    card.state = 'decided';
    return route.fulfill({ json: { changed: true, id, state: 'decided' } });
  });
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.locator('[data-tab="sessions"]').click();
  await page.locator('[data-session-id="sess-a"].sessions-item').waitFor({ state: 'visible' });

  const openSession = id => page.evaluate(sessionId => document.querySelector(`[data-session-id="${sessionId}"].sessions-item`).click(), id);
  const questionText = () => page.evaluate(() => {
    const box = document.querySelector('.sessions-question');
    return box && !box.hidden ? box.textContent : '';
  });

  // 会话 A：只见 A 的卡，不见 B 的卡与无会话规则卡。
  await openSession('sess-a');
  await page.waitForFunction(() => document.querySelector('.sessions-question')?.textContent?.includes('会话A的问题'));
  const textA = await questionText();
  assert.equal(textA.includes('会话B的问题'), false, '不串 B 会话的卡');
  assert.equal(textA.includes('规则卡无会话'), false, '无会话 lane 的卡不进会话页');
  assert.match(textA, /问题 1 \/ 1/, '本会话只有 1 道题');

  // 回答失败：就地报错，卡与选项保留。
  await page.evaluate(() => [...document.querySelectorAll('.sessions-option')].find(button => button.textContent === '结案').click());
  await page.evaluate(() => document.querySelector('.sessions-question-submit').click());
  await page.waitForFunction(() => document.querySelector('.sessions-question .status.error')?.textContent?.trim());
  assert.match(await questionText(), /会话A的问题/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.sessions-option').length), 2);

  // 重试成功：卡立即从会话卡组消失（不留已回答残留行）。
  await page.evaluate(() => document.querySelector('.sessions-question-submit').click());
  await page.waitForFunction(() => {
    const box = document.querySelector('.sessions-question');
    return !box || box.hidden || !box.textContent.includes('会话A的问题');
  });
  assert.deepEqual(answered.map(item => [item.id, item.body.choice]), [[41, 1]]);
  assert.equal(await questionText(), '', '答完卡组为空并隐藏');

  // 切到会话 B：只见 B 的卡，A 的卡不出现。
  await page.evaluate(() => document.querySelector('.sessions-back.icon-btn').click());
  await page.locator('[data-session-id="sess-b"].sessions-item').waitFor({ state: 'visible' });
  await openSession('sess-b');
  await page.waitForFunction(() => document.querySelector('.sessions-question')?.textContent?.includes('会话B的问题'));
  const textB = await questionText();
  assert.equal(textB.includes('会话A的问题'), false, '切会话不串卡');
  assert.equal(textB.includes('规则卡无会话'), false);
  assert.deepEqual(pageErrors, []);
});
