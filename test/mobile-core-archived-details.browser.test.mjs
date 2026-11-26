// 浏览器回归（archived-dag-details）：App 总览「已归档」区每条显示摘要、创建日期、用量；缺失项走默认文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { createDagService } from '../src/dag-service.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const browserSkip = (() => {
  try { return existsSync(chromium.executablePath()) ? false : 'npm test 阶段未安装 Playwright Chromium，跳过浏览器回归'; }
  catch { return '无法探测 Playwright Chromium，跳过浏览器回归'; }
})();

test('浏览器：已归档区显示摘要、创建日期、用量（未上报如实标注）', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-archived-details-'));
  const project = path.join(root, 'proj-gamma');
  mkdirSync(path.join(project, '.git'), { recursive: true });
  mkdirSync(path.join(project, 'docs', 'dag-plans'), { recursive: true });
  writeFileSync(path.join(project, 'docs', 'dag-plans', 'plan-g.json'), JSON.stringify({ plan_id: 'plan-g', title: '归档摘要标题' }));
  const hub = await fakeHub((req, res) => json(res, { runs: [], cards: [], lines: [], spending: { today: {} } }));
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const rootRun = {
    runId: 'dagrun-gone', nodeId: '__root__', project, planId: 'plan-g', status: 'done',
    createdAt: '2026-11-20T09:00:00+08:00', finishedAt: '2026-11-21T09:00:00+08:00',
    authorizationSnapshot: { schema: 2, planDigest: 'a'.repeat(64), allowedActions: ['worktree'], deniedActions: ['deploy'] },
    nodes: [{ id: 'n1', title: '节点', depends_on: [], contract: { input: 'i', output: 'o', error_behavior: 'e', acceptance_example: 'a' } }],
    publish: { nodes: { n1: { state: 'accepted', slot: 1 } } },
  };
  mkdirSync(path.join(root, 'dag-runs'), { recursive: true });
  writeFileSync(path.join(root, 'dag-runs', 'dagrun-gone.json'), JSON.stringify(rootRun));
  const sessionsFake = { async list() { return []; }, async listArchived() { return []; } };
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, rulesFile, deviceAuth,
    projectRoots: [project],
    dagService: createDagService({ root, store: { listRuns: () => [rootRun] } }),
  }, sessionsFake);
  const url = await listen(server);
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await close(server); await close(hub.server);
    rmSync(root, { recursive: true, force: true });
  });
  const qr = deviceAuth.createBinding();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(v) { stored = v; }, async remove() { stored = null; } };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  await page.goto(`${url}/mobile/`);
  await page.locator('#bind-payload').fill(qr.qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });

  // fix6：已归档任务收进「已归档的任务环」（与网页 archive-view 同口径），展开后每个任务同款环。
  const archived = page.locator('[data-archived-rings]');
  await archived.waitFor({ timeout: 6000 });
  assert.equal((await archived.locator('[data-archived-count]').innerText()).trim(), '1');
  assert.equal((await archived.locator('[data-archived-summary]').innerText()).trim(), '全部完成 1');
  await archived.locator('[data-archived-toggle]').click();
  const row = archived.locator('[data-archived-ring]').first();
  await row.waitFor({ timeout: 4000 });
  assert.match(await row.innerText(), /归档摘要标题/);
  assert.match(await row.locator('[data-archive-times]').innerText(), /^创建 2026\/11\/(19|20) \d\d:\d\d · 归档 /);
  // 本测试不上报用量：如实标注，不编造 0。
  assert.equal((await row.locator('[data-archive-usage]').innerText()).trim(), '链计费 · 费用未上报 · Token 未上报', '与网页 archiveUsageText 同口径');
  assert.equal(await row.locator('.ring-seg').count(), 1, '归档任务同款环：一个节点一个扇区');
});
