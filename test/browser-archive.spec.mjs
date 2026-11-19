// 底部归档区浏览器回归：折叠/展开、按项目分组、跟随顶部项目筛选、桌面与移动无横向溢出。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'archive-browser-'));
const projA = path.join(root, 'alpha'); const projB = path.join(root, 'beta');
for (const dir of [projA, projB]) mkdirSync(path.join(dir, '.git'), { recursive: true });

const chain = (project, title, statuses) => JSON.stringify({
  project, title, plan: Object.keys(statuses), lastEventAt: '2026-11-18T02:00:00Z',
  nodes: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status }])),
});
writeFileSync(path.join(root, 'done-a-serial.json.done-20261118'), chain(projA, 'Alpha 全完成任务', { a: 'done', b: 'done' }));
writeFileSync(path.join(root, 'abandoned-b-serial.json.done-20261117'), chain(projB, 'Beta 中途放弃任务', { a: 'done', b: 'pending' }));
writeFileSync(path.join(root, 'live-serial.json'), chain(projA, 'Alpha 进行中任务', { a: 'done', b: 'in_progress' }));

writeFileSync(path.join(root, 'rules.json'), JSON.stringify({
  sources: { local: { name: '本机' } },
  rules: [
    { name: 'alpha 巡检', when: { cron: '0 9 * * *' }, to: 'fake', cwd: projA, prompt: '只验证控制台', resume: false },
    { name: 'beta 巡检', when: { cron: '0 9 * * *' }, to: 'fake', cwd: projB, prompt: '只验证控制台', resume: false },
  ],
  elsewhere: [],
}));
const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state'
  ? { seq: 1, totals: {}, spending: { today: {} }, cards: [], agents: [], channels: [], lines: [], runs: [], timers: [] }
  : { ok: true }));
const consoleServer = createConsoleServer({
  hubUrl: hub.url, ownerKey: 'k', rulesFile: path.join(root, 'rules.json'), root, projectRoots: [root],
}, { async list() { return []; }, async listArchived() { return []; }, dispose() {} });
const url = await listen(consoleServer);
const profile = mkdtempSync(path.join(tmpdir(), 'archive-browser-profile-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.getByRole('heading', { name: '今天的自动化' }).waitFor();

  const section = page.locator('#archive-section');
  await section.locator('details.arch-section').waitFor();
  assert.equal(await section.locator('summary .arch-title').innerText(), '已归档的任务环');
  assert.equal(await section.locator('summary .status').innerText(), '2', 'two archived rings must be counted');
  assert.ok((await section.locator('summary .arch-sub').innerText()).includes('全部完成 1'), 'reason summary must be truthful');
  assert.ok((await section.locator('summary .arch-sub').innerText()).includes('已取消 1'), 'abandoned counts as cancelled');
  assert.equal(await section.locator('.arch-body').isVisible(), false, 'archive body is collapsed by default');

  await section.locator('summary').click();
  assert.equal(await section.locator('.arch-group-name').count(), 2, 'unfiltered archive groups by project');
  assert.ok((await section.innerText()).includes('Alpha 全完成任务'));
  assert.ok((await section.innerText()).includes('Beta 中途放弃任务'));
  assert.ok(!(await section.innerText()).includes('Alpha 进行中任务'), 'in-progress task must not appear in archive');

  const options = await page.locator('#project-filter option').evaluateAll(list => list.map(option => ({ value: option.value, text: option.textContent || '' })));
  const alphaOption = options.find(option => option.text.includes('alpha'));
  assert.ok(alphaOption, `project filter must offer alpha (got ${JSON.stringify(options)})`);
  await page.locator('#project-filter').selectOption(alphaOption.value);
  await page.waitForTimeout(150);
  assert.equal(await section.locator('.arch-row').count(), 1, 'project filter must narrow the archive');
  assert.equal(await section.locator('.arch-group-name').count(), 0, 'filtered archive drops group headings');
  assert.ok((await section.locator('summary .arch-scope').innerText()).includes('alpha'), 'filter scope must be visible');
  assert.ok((await section.locator('.arch-row').innerText()).includes('Alpha 全完成任务'));

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(overflow, 0, 'desktop must not overflow horizontally');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(mobileOverflow, 0, 'mobile must not overflow horizontally');
  assert.equal(errors.length, 0, errors.join('; '));
  console.log('PASS browser-archive: collapsed/expanded, grouping, project filter, desktop+mobile overflow');
} finally {
  if (context) await context.close();
  await close(consoleServer);
  await close(hub.server);
}
