// ui-core-pages 节点浏览器回归（假 Hub）：五页渲染真实字段、写路由 501 保留草稿、
// 回答成功后列表更新、待办数同步角标。不调用真实模型、不操作真实规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { createDagService, mobileDagSummaries } from '../src/dag-service.mjs';
import { mobileRuleSummaries } from '../src/rules.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const ALLOWED = ['worktree', 'run-tests', 'push-branch', 'create-pr'];
const DENIED = ['deploy', 'release', 'production-write'];

// CI 在 npm test 阶段尚未安装 Playwright 浏览器（npx playwright install 在 test:browser 之前才执行），
// 此时 chromium.launch 会因找不到可执行文件而失败。没有浏览器时显式跳过，不把环境缺失误判成功能回归；
// 一旦浏览器可用（本地开发，或安装浏览器后的阶段）这条回归仍会真实执行。
const browserSkip = (() => {
  try {
    return existsSync(chromium.executablePath())
      ? false
      : 'npm test 阶段未安装 Playwright Chromium，跳过浏览器回归（安装浏览器后本地会真实执行）';
  } catch {
    return '无法探测 Playwright Chromium，跳过浏览器回归';
  }
})();

test('浏览器：五页渲染真实字段，回答一条待办后列表更新，501 时草稿保留', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-ui-core-'));
  const profile = mkdtempSync(path.join(tmpdir(), 'mobile-ui-core-profile-'));
  const hubState = {
    runs: [{ id: 7, rule: '移动控制台 · 设计推进', project: '/work/移动控制台', state: 'claimed', attempts: 0, agent: 'codex', usage: { input: 100, output: 50 }, events: [{ subject: 'dag-ui-core-pages', summary: '开发核心页面' }], createdAt: '2026-11-20T09:00:00+08:00' }],
    cards: [{ id: 9, title: '移动网络的访问边界', text: '任意网络还是仅私网？', rule: '移动控制台 · 设计推进', project: '/work/移动控制台', state: 'open', options: ['任意网络', '仅私网'], createdAt: '2026-11-20T09:38:00+08:00' }],
    lines: [{ name: '移动控制台 · 设计推进', paused: null, totals: { running: 1, queued: 0, retrying: 0, unknown: 0, doneToday: 0 } }],
    spending: { today: { tokens: 150, cost: 0.25 } },
  };
  const hub = await fakeHub((req, res) => {
    if (req.url === '/v1/state') return json(res, hubState);
    if (req.method === 'POST' && req.url === '/v1/cards/9/answer') {
      hubState.cards[0].state = 'decided';
      hubState.cards[0].choice = '仅私网';
      return json(res, { ok: true });
    }
    return json(res, { ok: true });
  });
  const rulesFile = path.join(root, 'rules.json');
  const rawRule = { name: '移动控制台 · 设计推进', when: { cron: '*/10 * * * *' }, to: 'codex', cwd: '/work/移动控制台', prompt: '推进设计' };
  writeFileSync(rulesFile, JSON.stringify({
    sources: {}, agents: { codex: { name: 'Codex', use: 'acp', access: 'edit' } }, rules: [rawRule],
  }));
  const rawDagRun = {
    runId: 'dagrun-core', nodeId: '__root__', project: '/work/移动控制台', planId: 'mobile-app', status: 'running',
    authorizationSnapshot: { schema: 2, planDigest: 'a'.repeat(64), allowedActions: ALLOWED, deniedActions: DENIED, remoteUrl: 'https://example.com/repo.git' },
    nodes: [{ id: 'ui-core-pages', contract: { files: ['mobile/app/www/pages/core.mjs'] } }],
  };
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, rulesFile, deviceAuth,
    projectRoots: [root],
    dagService: createDagService({ root, store: { listRuns: () => [rawDagRun] } }),
  });
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
  const context = await browser.newContext();
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
  await page.evaluate(() => {
    const original = window.AutoloopHooks.notify.setBadge;
    window.__badges = [];
    window.AutoloopHooks.notify.setBadge = count => { window.__badges.push(count); original(count); };
  });
  await page.locator('#bind-payload').fill(qr.qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#connection-status')?.getAttribute('aria-label')?.includes('已安全连接'));

  // 运行后的主导航也必须保持六栏；执行授权并入待办，不再动态追加第七个 Tab。
  const runtimeTabs = await page.evaluate(() => [...document.querySelectorAll('#tab-bar .tab')].map(el => el.textContent.trim()));
  assert.deepEqual(runtimeTabs, ['总览', '规则', '会话', '轮次', '待办', '管理后台']);

  // 回归：底部六栏图标渲染与折叠卡片全局接线不能被启动优化打断
  // （2026-11-24 merge 事故：boot 调用被删，图标静默缺失、折叠整体失活，现有静态测试均未捕获）。
  await page.waitForFunction(() => {
    const icons = [...document.querySelectorAll('#tab-bar .nav-icon')];
    return icons.length === 6 && icons.every(el => el.childElementCount > 0);
  }, null, { timeout: 5000 });
  await page.evaluate(() => {
    const tall = document.createElement('div');
    tall.className = 'card';
    tall.textContent = '折叠接线回归长卡片。'.repeat(120);
    document.querySelector('#page-core').append(tall);
  });
  await page.waitForFunction(() => {
    const expand = document.querySelector('#page-core .card-expand');
    return expand && expand.parentElement?.classList?.contains('collapsible-card')
      && expand.parentElement.textContent.includes('折叠接线回归');
  }, null, { timeout: 5000 });

  // 总览：四组计数、最近一条标题、费用、项目 DAG 全部来自后端。
  await page.waitForFunction(() => document.querySelector('[data-core-section="metrics"]')?.textContent?.includes('正在运行'));
  const metrics = await page.locator('[data-core-section="metrics"]').innerText();
  assert.match(metrics, /正在运行/);
  assert.match(metrics, /等待重试/);
  assert.match(metrics, /今日完成/);
  assert.match(metrics, /待调度处理/);
  assert.match(metrics, /开发核心页面/);
  assert.match(await page.locator('[data-core-section="usage"]').innerText(), /\$0\.25/);
  assert.match(await page.locator('[data-core-section="projects"]').innerText(), /移动控制台/);

  // 规则：真实名称、触发与状态；状态已知时动作按钮可用。
  await page.locator('[data-tab="rules"]').click();
  await page.waitForFunction(() => document.querySelector('[data-core-section="rules"]')?.textContent?.includes('设计推进'));
  assert.match(await page.locator('[data-core-section="rules"]').innerText(), /定时 · \*\/10 \* \* \* \*/);
  assert.match(await page.locator('[data-core-section="rules"]').innerText(), /运行中/);
  assert.equal(await page.locator('[data-rule-action="pause"]').first().isEnabled(), true);

  // 轮次：任务摘要、模型与实际费用。
  await page.locator('[data-tab="rounds"]').click();
  await page.waitForFunction(() => document.querySelector('[data-core-section="runs"]')?.textContent?.includes('开发核心页面'));
  const rounds = await page.locator('[data-core-section="runs"]').innerText();
  assert.match(rounds, /dag-ui-core-pages/);
  assert.match(rounds, /模型 .+/);

  // 待办页同时承载执行授权：只读展示真实授权快照，不增加第七个 Tab。
  await page.locator('[data-tab="todos"]').click();
  await page.waitForFunction(() => document.querySelector('[data-core-section="authorize"]')?.textContent?.includes('移动控制台'));
  const authorize = await page.locator('[data-core-section="authorize"]').innerText();
  assert.match(authorize, /mobile-app/);
  assert.match(authorize, /a{64}/);
  assert.match(authorize, /独立工作区/);
  assert.match(authorize, /部署/);

  // 待办：计数经 hooks.notify.setBadge 同步。
  await page.waitForFunction(() => document.querySelector('[data-card-id="9"]')?.textContent?.includes('移动网络的访问边界'));
  assert.deepEqual(await page.evaluate(() => window.__badges.at(-1)), 1);
  const card = page.locator('[data-card-id="9"]');
  assert.match(await card.innerText(), /任意网络还是仅私网/);

  // 写路由已实现；这里显式模拟失败（501）来验证：失败给人话提示，选项与文字草稿都保留，不白屏。
  await page.route('**/api/mobile/cards/*/answer', route => route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: '尚未实现' }) }));
  await card.locator('[data-card-option="1"]').click();
  await card.locator('[data-card-text]').fill('我先填着的草稿');
  await card.locator('[data-card-submit]').click();
  await page.waitForFunction(() => document.querySelector('[data-card-id="9"] [data-card-error]')?.textContent?.trim());
  assert.match(await card.locator('[data-card-error]').innerText(), /尚未实现|失败/);
  assert.equal(await card.locator('[data-card-option="1"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await card.locator('[data-card-text]').inputValue(), '我先填着的草稿');

  // 模拟 mobile-write-api 节点上线：回答成功 → 重新拉取 → 列表显示已回答，角标归零。
  // 成功路径走真实服务端写路由，让 Hub 写代际与状态缓存失效按生产逻辑执行；
  // 不能在浏览器侧伪造成 200，否则绕过服务端缓存失效，重载仍会读到旧状态。
  await page.unroute('**/api/mobile/cards/*/answer');
  await card.locator('[data-card-submit]').click();
  await page.waitForFunction(() => document.querySelector('[data-card-id="9"]')?.textContent?.includes('已回答'));
  assert.deepEqual(await page.evaluate(() => window.__badges.at(-1)), 0);
  assert.deepEqual(pageErrors, []);
});
