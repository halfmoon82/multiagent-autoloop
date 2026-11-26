// session-actions 节点浏览器回归（假 Hub + 路由拦截）：
// 左滑→二次确认→行消失；滑动不触发进入；关闭失败保留原状；设计会话双按钮显隐；授权流程走通
// （未勾选不可提交、planDigest 原样回传、提交失败不清空勾选）。无 Chromium 时显式跳过。
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

const DIGEST = 'c'.repeat(64);
const PLAN = {
  project: '/work/p', planId: 'plan-1', planDigest: DIGEST, title: '计划一', remoteUrl: 'https://example.com/r.git', maxParallel: 3,
  allowedActions: ['worktree', 'run-tests'], deniedActions: ['deploy'],
  nodes: [{ id: 'n1', title: '节点一', files: ['src/a.mjs'], dependsOn: [], wave: 1 }],
};

async function open(t, { sessions, routes, cards = [] }) {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-session-actions-ui-'));
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards, lines: [], spending: {} } : { ok: true }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, deviceAuth, projectRoots: [root] });
  const url = await listen(server);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true })).newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const posts = [];
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(value) { stored = value; }, async remove() { stored = null; } };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  await page.route('**/api/mobile/api/sessions', route => route.fulfill({ json: { sessions: sessions() } }));
  await page.route('**/api/mobile/**', route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST') posts.push({ pathname, body: request.postDataJSON?.() ?? null });
    return routes(route, pathname, request) || route.fallback();
  });
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.locator('[data-tab="sessions"]').click();
  await page.locator('[data-session-id].sessions-item').first().waitFor({ state: 'visible' });
  return { page, pageErrors, posts };
}

// 在页面内合成指针序列，定位与操作在同一 evaluate 内完成。
const swipeRow = (page, id, dx) => page.evaluate(([sessionId, delta]) => {
  const row = document.querySelector(`[data-swipe-row="${sessionId}"]`);
  const rect = row.getBoundingClientRect();
  const x0 = rect.left + rect.width * 0.8; const y = rect.top + rect.height / 2;
  const fire = (type, x) => row.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y }));
  fire('pointerdown', x0); fire('pointermove', x0 + delta / 2); fire('pointermove', x0 + delta); fire('pointerup', x0 + delta);
}, [id, dx]);

test('浏览器：左滑露出关闭→二次确认→行消失；滑动不进入；失败保留原状并提示；双按钮显隐', { skip: browserSkip }, async t => {
  let live = [
    { id: 'sess-a', kind: 'normal', project: '/work/p', status: 'idle', prompt: '普通会话 A', updatedAt: '2026-11-24T02:00:00Z' },
    { id: 'sess-b', kind: 'design', project: '/work/p', status: 'idle', prompt: '设计会话 B', planApproved: false, updatedAt: '2026-11-24T01:00:00Z' },
    { id: 'sess-c', kind: 'design', project: '/work/p', status: 'idle', prompt: '设计会话 C 已放行', planApproved: true, updatedAt: '2026-11-24T00:30:00Z' },
    { id: 'sess-d', kind: 'normal', project: '/work/p', status: 'idle', prompt: '会失败的会话 D', updatedAt: '2026-11-23T23:00:00Z' },
  ];
  const { page, pageErrors, posts } = await open(t, {
    sessions: () => live,
    routes: (route, pathname) => {
      if (pathname === '/api/mobile/sessions/sess-a/close') { live = live.filter(item => item.id !== 'sess-a'); return route.fulfill({ json: { id: 'sess-a', status: 'closed' } }); }
      if (pathname === '/api/mobile/sessions/sess-d/close') return route.fulfill({ status: 409, json: { error: '会话已关闭，请开启新会话' } });
      if (pathname === '/api/mobile/sessions/sess-b/approve-plan') { live = live.map(item => (item.id === 'sess-b' ? { ...item, planApproved: true } : item)); return route.fulfill({ json: { id: 'sess-b', planApproved: true } }); }
      return undefined;
    },
  });

  // 双按钮显隐：B 只有「放行落盘」一颗；C（已放行）与普通会话没有；页面无「确认执行范围」入口。
  const buttons = id => page.evaluate(sessionId => [...document.querySelectorAll(`[data-design-actions="${sessionId}"] button`)].map(button => button.dataset.action), id);
  assert.deepEqual(await buttons('sess-b'), ['approve-plan']);
  assert.deepEqual(await buttons('sess-c'), []);
  assert.ok(!(await page.evaluate(() => document.body.textContent)).includes('确认执行范围'));
  assert.deepEqual(await buttons('sess-a'), []);

  // 滑动中不触发点击进入：滑完仍在列表。
  await swipeRow(page, 'sess-a', -120);
  await page.waitForFunction(() => document.querySelector('[data-swipe-row="sess-a"]').classList.contains('open'));
  assert.equal(await page.evaluate(() => document.querySelector('[data-view="detail"]').hidden), true, '滑动不进入会话');

  // 第一次点「关闭」只进入确认态，不发请求；第二次才提交。
  await page.waitForTimeout(250);
  await page.locator('[data-swipe-row="sess-a"] .sessions-close-action').click();
  assert.equal(await page.locator('[data-swipe-row="sess-a"] .sessions-close-action').textContent(), '确认关闭');
  assert.equal(posts.filter(item => item.pathname.endsWith('/close')).length, 0);
  await page.locator('[data-swipe-row="sess-a"] .sessions-close-action').click();
  await page.waitForFunction(() => !document.querySelector('[data-swipe-row="sess-a"]'));
  assert.equal(posts.filter(item => item.pathname === '/api/mobile/sessions/sess-a/close').length, 1);

  // 失败：行保留，提示原因。
  await swipeRow(page, 'sess-d', -120);
  await page.waitForFunction(() => document.querySelector('[data-swipe-row="sess-d"]').classList.contains('open'));
  await page.waitForTimeout(250); // 等 160ms 滑动动画落定，避免点击被 track 遮挡
  await page.locator('[data-swipe-row="sess-d"] .sessions-close-action').click();
  await page.locator('[data-swipe-row="sess-d"] .sessions-close-action').click();
  await page.waitForFunction(() => /会话已关闭，请开启新会话/.test(document.querySelector('[data-session-id="sess-d"]').closest('.sessions-card-wrap').textContent));
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-swipe-row="sess-d"]'))), true, '失败保留列表原状');

  // 放行落盘后按钮消失。
  await page.locator('[data-design-actions="sess-b"] [data-action="approve-plan"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-design-actions="sess-b"] [data-action="approve-plan"]'));
  assert.deepEqual(await buttons('sess-b'), []);
  assert.deepEqual(pageErrors, []);
});

// fix4 回归（2026-11-25 真机）：会话内决策卡①不按会话绑定——别的会话的卡串进来；
// ②回答后不消失——回答只改了内存里的待回答组，state.cards 还是 open，重建时又冒出来。
test('浏览器：会话内决策卡按 lane 归属过滤，回答后跨会话不再复活（fix4）', { skip: browserSkip }, async t => {
  const cards = [
    { id: 8, state: 'open', title: 'A 会话的决策？', options: ['选项一', '选项二'], lane: 'scheduling:sess-a', project: '/work/p' },
    { id: 9, state: 'open', title: 'B 会话的决策？', options: ['好', '不好'], lane: 'scheduling:sess-b', project: '/work/p' },
    { id: 10, state: 'open', title: '项目公共问题？', project: '/work/p' },
  ];
  const sessions = () => [
    { id: 'sess-a', kind: 'scheduling', status: 'running', project: '/work/p', prompt: '调度 A', hubSubject: 'scheduling:sess-a', messages: [], queue: [], createdAt: '2026-11-25T09:00:00.000Z', updatedAt: '2026-11-25T10:00:00.000Z' },
    { id: 'sess-b', kind: 'scheduling', status: 'running', project: '/work/p', prompt: '调度 B', hubSubject: 'scheduling:sess-b', messages: [], queue: [], createdAt: '2026-11-25T09:00:00.000Z', updatedAt: '2026-11-25T09:30:00.000Z' },
  ];
  const { page, pageErrors, posts } = await open(t, { sessions, cards, routes: () => false });
  const questionBox = page.locator('.sessions-question');

  // 会话 A：只看自己的卡（8）与项目公共卡（10），看不到 B 会话的卡（9）。
  await page.locator('.sessions-item[data-session-id="sess-a"]').first().click();
  await questionBox.locator('.sessions-question-card').waitFor({ timeout: 6000 });
  let boxText = await questionBox.innerText();
  assert.match(boxText, /需要您的回答 · 0\/2/, 'A 会话只有卡 8 与公共卡 10 两道题');
  assert.match(boxText, /A 会话的决策？/);
  assert.ok(!boxText.includes('B 会话的决策？'), 'B 会话的卡不得串进 A 会话');

  // 回答卡 8（选择）：请求真实打到 /api/mobile/cards/8/answer，卡立即离开卡组（不留已回答残留行）。
  await questionBox.locator('.sessions-option', { hasText: '选项一' }).click();
  await questionBox.locator('.sessions-question-submit').click();
  await page.waitForFunction(() => {
    const text = document.querySelector('.sessions-question')?.textContent || '';
    return text.includes('0/1') && !text.includes('A 会话的决策？');
  }, null, { timeout: 6000 });
  assert.ok(posts.some(post => post.pathname === '/api/mobile/cards/8/answer' && post.body?.choice === 0), '回答走 cards answer 写路由');

  // 回到列表进会话 B：自己的卡（9）与公共卡（10）在；已答的卡 8 不得以任何形式复活。
  await page.locator('.sessions-back[aria-label="返回会话列表"]').click();
  await page.locator('.sessions-item[data-session-id="sess-b"]').first().click();
  await questionBox.locator('.sessions-question-card').waitFor({ timeout: 6000 });
  boxText = await questionBox.innerText();
  assert.match(boxText, /B 会话的决策？/);
  assert.ok(!boxText.includes('A 会话的决策？'), '已回答的 A 会话卡不得在 B 会话复活');

  // 先答 B 自己的选择卡 9，再答公共卡 10（文字）：每答一张即消失，全部答完卡组隐藏；回 A 后公共卡也不再出现。
  await questionBox.locator('.sessions-option', { hasText: '好' }).first().click();
  await questionBox.locator('.sessions-question-submit').click();
  await page.waitForFunction(() => {
    const text = document.querySelector('.sessions-question')?.textContent || '';
    return text.includes('0/1') && !text.includes('B 会话的决策？');
  }, null, { timeout: 6000 });
  await questionBox.locator('.sessions-question-input').fill('公共回答');
  await questionBox.locator('.sessions-question-submit').click();
  await page.waitForFunction(() => {
    const box = document.querySelector('.sessions-question');
    return !box || box.hidden || !box.textContent.includes('项目公共问题？');
  }, null, { timeout: 6000 });
  assert.ok(posts.some(post => post.pathname === '/api/mobile/cards/10/answer' && post.body?.text === '公共回答'));
  await page.locator('.sessions-back[aria-label="返回会话列表"]').click();
  await page.locator('.sessions-item[data-session-id="sess-a"]').first().click();
  await page.waitForTimeout(600);
  boxText = await questionBox.innerText();
  assert.ok(!boxText.includes('项目公共问题？'), '已回答的公共卡在 A 会话同样不得复活');
  assert.ok(!boxText.includes('A 会话的决策？'), 'A 自己的已答卡也不得以待答形式回来');
  assert.deepEqual(pageErrors, []);
});
