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

async function open(t, { sessions, routes }) {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-session-actions-ui-'));
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [], lines: [], spending: {} } : { ok: true }));
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

  // 双按钮显隐：B 两颗；C（已放行）只有「确认执行范围」；普通会话没有。
  const buttons = id => page.evaluate(sessionId => [...document.querySelectorAll(`[data-design-actions="${sessionId}"] button`)].map(button => button.dataset.action), id);
  assert.deepEqual(await buttons('sess-b'), ['approve-plan', 'design-authorize']);
  assert.deepEqual(await buttons('sess-c'), ['design-authorize']);
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
  assert.deepEqual(await buttons('sess-b'), ['design-authorize']);
  assert.deepEqual(pageErrors, []);
});

test('浏览器：确认执行范围——未勾选不可提交；失败不清空勾选；成功回传服务端 planDigest', { skip: browserSkip }, async t => {
  let attempts = 0;
  const { page, pageErrors, posts } = await open(t, {
    sessions: () => [{ id: 'sess-b', kind: 'design', project: '/work/p', status: 'idle', prompt: '设计会话 B', planApproved: true, updatedAt: '2026-11-24T01:00:00Z' }],
    routes: (route, pathname) => {
      if (pathname === '/api/mobile/dag-plan') return route.fulfill({ json: PLAN });
      if (pathname === '/api/mobile/dag-preflight') return route.fulfill({ json: { source: 'native', checks: [{ id: 'plan-source', label: '计划来源', ok: true, message: '原生计划' }] } });
      if (pathname === '/api/mobile/dag-runs') {
        attempts += 1;
        return attempts === 1
          ? route.fulfill({ status: 400, json: { error: 'PLAN_DIGEST_MISMATCH：计划已变化需重新确认' } })
          : route.fulfill({ status: 201, json: { runId: 'dagrun-ui' } });
      }
      return undefined;
    },
  });
  await page.locator('[data-design-actions="sess-b"] [data-action="design-authorize"]').click();
  await page.locator('.sessions-auth-plan').waitFor({ state: 'visible' });
  await page.locator('.sessions-auth-plan').fill('plan-1');
  await page.locator('.sessions-auth-load').click();
  await page.locator('[data-plan-digest]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-plan-digest]').textContent(), new RegExp(DIGEST));
  assert.ok(await page.locator('[data-auth-node="n1"]').textContent().then(text => text.includes('src/a.mjs')), '逐条出示节点文件范围');
  assert.equal(await page.locator('.sessions-auth-submit').isDisabled(), true, '未勾选不可提交');

  await page.locator('.sessions-auth-ack').check();
  assert.equal(await page.locator('.sessions-auth-submit').isDisabled(), false);
  await page.locator('.sessions-auth-submit').click();
  await page.locator('[data-auth-error]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-auth-error]').textContent(), /计划已变化/);
  assert.equal(await page.locator('.sessions-auth-ack').isChecked(), true, '失败不清空已勾选项');

  await page.locator('.sessions-auth-submit').click();
  await page.locator('[data-auth-created]').waitFor({ state: 'visible' });
  const sent = posts.filter(item => item.pathname === '/api/mobile/dag-runs');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.planDigest, DIGEST);
  assert.equal(sent[1].body.confirm, true);
  assert.deepEqual(sent[1].body.confirmedActionIds, ['worktree', 'run-tests']);
  assert.deepEqual(pageErrors, []);
});
