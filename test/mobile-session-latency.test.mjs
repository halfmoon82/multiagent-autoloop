// session-latency 节点：详情页轮询只读「活跃会话」一个接口，并带每次请求的计时，便于定位延迟来源。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionsReader } from '../mobile/src/features/sessions/browser.mjs';

function fakeFetch(log, delayMs = 0, clock = { t: 0 }) {
  return async (url) => {
    log.push(new URL(url).pathname);
    clock.t += delayMs;
    const body = url.endsWith('/sessions') ? [{ id: 's1', kind: 'normal', status: 'running', updatedAt: '2026-11-24T00:00:00Z' }] : { sessions: [] };
    return { ok: true, status: 200, json: async () => body };
  };
}

test('load 记录每个接口的耗时，供根因定位', async () => {
  const log = [];
  const slow = fakeFetch(log);
  // 并行性用在途计数判定，不依赖墙钟阈值（高负载下墙钟断言会偶发失败）。
  let inFlight = 0;
  let maxInFlight = 0;
  const reader = createSessionsReader({ origin: 'https://x.test', fetchImpl: async url => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    try { await new Promise(r => setTimeout(r, 50)); return await slow(url); } finally { inFlight -= 1; }
  } });
  await reader.load();
  const timings = reader.timings();
  assert.deepEqual(timings.map(item => item.path).sort(), ['/api/mobile/api/session-archives', '/api/mobile/api/sessions']);
  assert.ok(timings.every(item => item.ms >= 45), '每路耗时应如实记录');
  assert.equal(maxInFlight, 2, '两路并行：两个请求同时在途，而不是串行');
});

test('refreshActive 只打活跃会话接口，沿用上次存档，串行往返减半', async () => {
  const clock = { t: 0 };
  const log = [];
  const reader = createSessionsReader({ origin: 'https://x.test', fetchImpl: fakeFetch(log, 40, clock), now: () => clock.t });
  const first = await reader.load();
  log.length = 0;
  const before = clock.t;
  const next = await reader.refreshActive(first);
  assert.deepEqual(log, ['/api/mobile/api/sessions']);
  assert.equal(clock.t - before, 40);
  assert.equal(next.snapshot.currentId, 's1');
  assert.deepEqual(next.snapshot.archives, first.snapshot.archives);
});

test('refreshActive 失败时保留错误且不编造会话', async () => {
  const reader = createSessionsReader({ origin: 'https://x.test', fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
  const result = await reader.refreshActive({ snapshot: { archives: [] }, rawArchives: [] });
  assert.equal(result.snapshot.sessions, null);
  assert.match(result.snapshot.sessionsError, /502/);
});

// ---------- 根因：详情页从不显示本轮正在输出的 liveText ----------
// 服务端边收 agent_message_chunk 边累积 liveText（src/scheduling-session.mjs），桌面端会渲染它
// （public/views.mjs），移动端详情只渲染已落定的 messages——整轮结束前用户什么都看不到，
// 体感延迟 = 整轮耗时而不是首 token 耗时。
import { buildDetailMessages, isAwaitingReply } from '../mobile/src/features/sessions/browser.mjs';

test('buildDetailMessages：运行中把 liveText 作为流式气泡接在已落定转录之后', () => {
  const session = { status: 'running', liveText: '正在想', messages: [{ role: 'user', text: '你好', at: 't1' }] };
  assert.deepEqual(buildDetailMessages(session), [
    { role: '主人', text: '你好', at: 't1' },
    { role: '会话', text: '正在想', at: '', streaming: true },
  ]);
});

test('buildDetailMessages：轮次结束 liveText 清空后只剩落定回复，不重复', () => {
  const session = { status: 'idle', liveText: '', messages: [{ role: 'user', text: '你好', at: 't1' }, { role: 'agent', text: '正在想完了', at: 't2' }] };
  assert.deepEqual(buildDetailMessages(session, [{ role: '会话', text: '正在想', at: '', streaming: true }]).map(m => m.text), ['你好', '正在想完了']);
});

test('buildDetailMessages：服务端尚未记下的本地发送保留回显，已记下则去重', () => {
  const previous = [{ role: '主人', text: '刚发的', at: '' }];
  assert.deepEqual(buildDetailMessages({ messages: [] }, previous).map(m => m.text), ['刚发的']);
  assert.deepEqual(buildDetailMessages({ messages: [{ role: 'user', text: '刚发的', at: 't' }] }, previous).map(m => m.at), ['t']);
  assert.deepEqual(buildDetailMessages({ messages: [], liveText: '  ' }), [], '空白 liveText 不出气泡');
});

test('isAwaitingReply：运行中/初始化/待复核/busy 视为等回复（详情轮询提速），空闲与异常不算', () => {
  for (const status of ['running', 'initializing', 'unknown']) assert.equal(isAwaitingReply({ status }), true, status);
  assert.equal(isAwaitingReply({ status: 'idle', busy: true }), true);
  for (const status of ['idle', 'error', 'closed']) assert.equal(isAwaitingReply({ status }), false, status);
  assert.equal(isAwaitingReply(null), false);
});

test('refreshActive 按传入筛选重建列表（详情轮询后返回列表不丢筛选）', async () => {
  const body = url => url.endsWith('/sessions')
    ? [{ id: 'n1', kind: 'normal', status: 'idle', updatedAt: '2026-11-24T00:00:01Z' }, { id: 'd1', kind: 'design', status: 'running', updatedAt: '2026-11-24T00:00:00Z' }]
    : { sessions: [] };
  const reader = createSessionsReader({ origin: 'https://x.test', fetchImpl: async url => ({ ok: true, status: 200, json: async () => body(url) }) });
  const first = await reader.load({ kind: 'design' });
  const next = await reader.refreshActive(first, { kind: 'design' });
  assert.deepEqual(next.list.sessions.items.map(item => item.id), ['d1']);
  assert.equal(next.list.kindFilter.selected, 'design');
});

// ---------- 浏览器回归：真页面 + 假会话接口（无 Chromium 时显式跳过） ----------
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

test('浏览器：详情页实时显示本轮 liveText；返回列表时列表已按轮询结果重绘', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-latency-'));
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [], lines: [], spending: {} } : { ok: true }));
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
  const session = { id: 's1', prompt: '延迟测试会话', project: root, kind: 'normal', status: 'running', liveText: '', messages: [{ role: 'user', text: '你好', at: '2026-11-24T00:00:00Z' }], updatedAt: '2026-11-24T00:00:00Z' };
  await page.route('**/api/mobile/api/sessions', route => route.fulfill({ json: { sessions: [structuredClone(session)] } }));
  await page.route('**/api/mobile/api/session-archives', route => route.fulfill({ json: { sessions: [] } }));
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.locator('[data-tab="sessions"]').click();
  await page.locator('.sessions-item').first().waitFor({ state: 'visible' });
  const statusBefore = await page.locator('.sessions-item .status-chip').first().textContent();
  await page.locator('.sessions-item').first().click();
  await page.locator('.sessions-composer-input').waitFor({ state: 'visible' });

  session.liveText = '第一个分片';
  await page.waitForFunction(() => [...document.querySelectorAll('.sessions-bubble')].some(el => el.textContent === '第一个分片'), null, { timeout: 4000 });

  session.liveText = '';
  session.status = 'idle';
  session.messages = [...session.messages, { role: 'agent', text: '第一个分片，完整回复', at: '2026-11-24T00:00:05Z' }];
  await page.waitForFunction(() => [...document.querySelectorAll('.sessions-bubble')].some(el => el.textContent === '第一个分片，完整回复'), null, { timeout: 4000 });
  const bubbles = await page.locator('.sessions-bubble').allTextContents();
  assert.deepEqual(bubbles, ['你好', '第一个分片，完整回复'], '落定后流式气泡被替换，不重复');

  await page.locator('.sessions-back').first().click();
  const statusAfter = await page.locator('.sessions-item .status-chip').first().textContent();
  assert.notEqual(statusAfter, statusBefore, `返回列表应显示轮询后的新状态：${statusBefore} → ${statusAfter}`);
  assert.deepEqual(pageErrors, []);
});

// 审阅 P1：main 的发送入口 sendComposer 发完后 await refreshSessionState()，即整页 load
// （projects/state/sessions/archives 四次往返）。合并后提速逻辑必须接进 sendComposer：
// 发完不再整页刷新，改为快拍只读活跃会话，首个分片尽快出现。
test('浏览器：发送后不整页刷新（不读存档），首个分片很快出现在详情页', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-latency-send-'));
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [], lines: [], spending: {} } : { ok: true }));
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
  const session = { id: 's1', prompt: '发送路径会话', project: root, kind: 'normal', status: 'idle', liveText: '', messages: [], updatedAt: '2026-11-24T00:00:00Z' };
  let sentAt = 0;
  let archivesAfterSend = 0;
  let sentBody = null;
  await page.route('**/api/mobile/api/sessions', route => {
    // 模拟服务端：发送后即转为运行中，首个分片在 600ms 后到达。
    if (sentAt) { session.status = 'running'; if (Date.now() - sentAt >= 600) session.liveText = '首个分片'; }
    return route.fulfill({ json: { sessions: [structuredClone(session)] } });
  });
  await page.route('**/api/mobile/api/session-archives', route => { if (sentAt) archivesAfterSend += 1; return route.fulfill({ json: { sessions: [] } }); });
  await page.route('**/api/mobile/sessions/s1/messages', route => {
    sentBody = JSON.parse(route.request().postData() || '{}');
    session.messages = [{ role: 'user', text: sentBody.text, at: '2026-11-24T00:00:01Z' }];
    sentAt = Date.now();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.locator('[data-tab="sessions"]').click();
  await page.locator('.sessions-item').first().waitFor({ state: 'visible' });
  await page.locator('.sessions-item').first().click();
  await page.locator('.sessions-composer-input').waitFor({ state: 'visible' });

  await page.locator('.sessions-composer-input').fill('你好');
  await page.locator('.sessions-send').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.sessions-bubble')].some(el => el.textContent === '首个分片'), null, { timeout: 4000 });
  const firstChunkMs = Date.now() - sentAt;
  assert.equal(sentBody?.text, '你好');
  assert.ok(firstChunkMs < 3000, `首个分片应在 3s 内出现，实际 ${firstChunkMs}ms`);
  assert.equal(archivesAfterSend, 0, '发送后不应整页刷新去读存档');
  assert.deepEqual(pageErrors, []);
});

// 审阅 P2（PR #297）：详情轮询用 refreshActive 的结果覆盖 state.list，该结果只按类型/搜索词过滤、
// 不含全局项目筛选；返回列表若直接重绘它，选中项目时会混入其他项目的会话。
test('浏览器：选中项目后进出详情（期间有轮询），返回列表仍只显示该项目的会话', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-latency-pf-'));
  const projectA = path.join(root, 'proj-a');
  const projectB = path.join(root, 'proj-b');
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [], lines: [], spending: {} } : { ok: true }));
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
  const sessions = [
    { id: 'a1', prompt: '项目A会话', project: projectA, kind: 'normal', status: 'running', liveText: '', messages: [{ role: 'user', text: '你好', at: '2026-11-24T00:00:00Z' }], updatedAt: '2026-11-24T00:00:02Z' },
    { id: 'b1', prompt: '项目B会话', project: projectB, kind: 'normal', status: 'idle', liveText: '', messages: [], updatedAt: '2026-11-24T00:00:01Z' },
  ];
  let activeReads = 0;
  await page.route('**/api/mobile/api/projects', route => route.fulfill({ json: { projects: [{ path: projectA, name: 'proj-a' }, { path: projectB, name: 'proj-b' }] } }));
  await page.route('**/api/mobile/api/sessions', route => { activeReads += 1; return route.fulfill({ json: { sessions: structuredClone(sessions) } }); });
  await page.route('**/api/mobile/api/session-archives', route => route.fulfill({ json: { sessions: [] } }));
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.locator('[data-tab="sessions"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.sessions-item').length === 2);
  await page.waitForFunction(dir => [...document.querySelectorAll('#project-filter option')].some(o => o.value === dir), projectA);
  await page.locator('#project-filter').selectOption(projectA);
  await page.waitForFunction(() => document.querySelectorAll('.sessions-item').length === 1);

  await page.locator('.sessions-item').first().click();
  await page.locator('.sessions-composer-input').waitFor({ state: 'visible' });
  const readsAtOpen = activeReads;
  await page.waitForTimeout(2200); // 运行中 1.5s 一拍，确保详情轮询至少跑过一次
  assert.ok(activeReads > readsAtOpen, '详情页期间应发生过轮询');

  await page.locator('.sessions-back').first().click();
  const titles = await page.locator('.sessions-item').allTextContents();
  assert.equal(titles.length, 1, `返回列表应只剩项目A的会话，实际：${titles.join(' | ')}`);
  assert.match(titles[0], /项目A会话/);
  assert.deepEqual(pageErrors, []);
});
