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
import { createCardDelegateStore, delegateSubject } from '../src/card-delegate.mjs';
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
