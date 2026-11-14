import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'console-browser-data-'));
const demoRepo = path.join(root, 'demo-repo'); mkdirSync(path.join(demoRepo, '.git'), { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'console-browser-profile-'));
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = {
  seq: 1, totals: { running: 1, queued: 2, retrying: 0, unknown: 0, doneToday: 3 },
  spending: { today: { rounds: 4, tokens: 1234, cost: 0.12, missingCost: 0 } },
  cards: [{ id: 9, state: 'open', title: '是否继续测试', text: '这是一个不产生模型费用的假卡片。', options: ['继续', '暂停'] }, { id: 10, state: 'open', title: '直接结案测试', text: '不需要继续执行。', options: [] }, { id: 11, state: 'open', title: '恢复测试', text: '规则同名卡片不得误认项目。', options: [] }],
  agents: [{ id: 'fake', name: '无模型 Agent', worker: 'test', online: true }], channels: [{ id: 'desktop', name: '桌面通知', online: true }],
  lines: [{ name: '恢复测试', paused: null }], runs: [{ id: 3, rule: '恢复测试', agent: 'fake', state: 'claimed', attempts: 0, createdAt: '2026-11-11T03:00:00Z', summary: '' }, { id: 4, rule: 'beta 巡检', agent: 'fake', state: 'queued', attempts: 2, project: '/elsewhere/beta', createdAt: '2026-11-14T01:00:00Z', summary: 'beta 项目等待重试' }], timers: [],
};
const rawRules = { sources: { local: { name: '本机' } }, agents: { fake: { name: '无模型 Agent', use: 'command', access: 'read' } }, rules: [{ name: '恢复测试', when: { source: 'local', types: ['recovery.*'] }, to: 'fake', cwd: root, prompt: '只验证控制台', resume: false }], elsewhere: [] };
const schedulingSessions = {
  records: [],
  async list() { return this.records; },
  async start({ prompt, project } = {}) {
    const session = { id: 'browser-session', sessionId: 'acp-browser', agent: 'Codex ACP', cwd: root, project: project || '未识别', status: 'idle', statusText: '待命', prompt: prompt || '默认调度说明', messages: [{ role: 'user', text: '默认调度说明', at: '2026-11-14T00:00:00Z' }], liveText: '', busy: false, createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' };
    this.records.push(session); return session;
  },
  async send(id, text) {
    const session = this.records.find(item => item.id === id);
    if (!session) throw new Error('调度会话不存在');
    session.messages.push({ role: 'user', text, at: '2026-11-14T00:02:00Z' });
    session.messages.push({ role: 'agent', text: `收到：${text}`, at: '2026-11-14T00:02:05Z' });
    session.updatedAt = '2026-11-14T00:02:05Z';
    return session;
  },
  async close(id) { this.records = this.records.filter(session => session.id !== id); return { id, status: 'closed', statusText: '已关闭' }; },
};
const rulesFile = path.join(root, 'rules.json'); writeFileSync(rulesFile, JSON.stringify(rawRules));
const cliPath = path.join(root, 'check.sh'); writeFileSync(cliPath, '#!/bin/sh\nexit 0\n'); chmodSync(cliPath, 0o700);
const hub = await fakeHub((req, res) => {
  if (req.url === '/v1/state') return json(res, snapshot);
  if (req.url.endsWith('/resolve')) { snapshot.cards[1].state = 'closed'; return json(res, { changed: true }); }
  if (req.url.endsWith('/answer')) { snapshot.cards[0].state = 'decided'; return json(res, { changed: true }); }
  if (req.url.endsWith('/pause')) { snapshot.lines[0].paused = { reason: 'browser test' }; return json(res, { changed: true }); }
  if (req.url.endsWith('/resume')) { snapshot.lines[0].paused = null; return json(res, { changed: true }); }
  return json(res, { ok: true });
});
const consoleServer = createConsoleServer({ hubUrl: hub.url, ownerKey: 'not-returned', rulesFile, cliPath, root, projectRoots: [root] }, schedulingSessions);
const url = await listen(consoleServer);
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); const errors = [];
  page.on('response', response => { if (response.status() >= 400) console.log('HTTP DIAGNOSTIC:', response.status(), response.url()); }); page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} at ${JSON.stringify(message.location())}`); });
  let acceptDialogs = true;
  page.on('dialog', dialog => acceptDialogs ? dialog.accept() : dialog.dismiss());
  await page.goto(url); await page.getByRole('heading', { name: '今天的自动化' }).waitFor();
  assert.equal(await page.locator('#attention-list').count(), 1, 'overview must have one attention list');
  assert.match(await page.locator('#summary').innerText(), /今日完成/); assert.match(await page.locator('#summary').innerText(), /1,234/);
  assert.ok((await page.locator('#running-list').innerText()).includes(`项目 · ${path.basename(root)}`), 'overview task summary must show its short project name');
  const collisionCard = page.locator('#attention-list .list-row').filter({ hasText: '规则同名卡片不得误认项目' });
  assert.ok((await collisionCard.innerText()).includes('项目 · 未识别'), 'decision card project must not be inferred from a title collision');
  await page.locator('#project-filter').selectOption('beta');
  assert.ok(!(await page.locator('#running-list').innerText()).includes('恢复测试'), 'project filter must hide other projects from running list');
  assert.ok((await page.locator('#retrying-list').innerText()).includes('beta 项目等待重试'), 'project filter must keep the matching retrying run');
  await page.locator('#project-filter').selectOption('');
  assert.ok((await page.locator('#running-list').innerText()).includes('恢复测试'), 'clearing the project filter restores the full overview');
  await page.screenshot({ path: path.join(output, 'console-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '调度规则', exact: true }).click();
  const beforeDismiss = hub.requests.length; acceptDialogs = false;
  await page.locator('[data-action="pause"]').click(); await page.waitForTimeout(150);
  assert.equal(hub.requests.length, beforeDismiss, 'dismissing pause must not call the hub'); acceptDialogs = true;
  await page.locator('[data-action="pause"]').click(); await page.locator('[data-action="resume"]').waitFor();
  await page.locator('[data-action="resume"]').click(); await page.locator('[data-action="pause"]').waitFor();
  await page.locator('[data-action="run"]').click();
  await page.getByRole('button', { name: '执行轮次', exact: true }).click();
  assert.ok((await page.locator('#runs-list').innerText()).includes(`项目 · ${path.basename(root)}`), 'run summary must show its short project name');
  await page.locator('[data-action="cancel"]').first().click();
  await page.getByRole('button', { name: '待调度处理', exact: false }).click();
  const textAnswer=page.locator('form[data-action="answer-text"]').first().locator('input'); await textAnswer.fill('刷新后仍要保留'); await page.waitForTimeout(5500); assert.equal(await textAnswer.inputValue(), '刷新后仍要保留');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  const resolveCard=page.locator('.decision-card').filter({hasText:'直接结案测试'}); await resolveCard.getByRole('button',{name:'结案',exact:true}).click();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole('button', { name: '调度规则', exact: true }).click(); await page.getByRole('button', { name: '新建规则', exact: true }).click();
  await page.getByLabel('规则名称').fill('手机创建测试'); await page.getByLabel('Cron 表达式').fill('0 9 * * *'); await page.getByLabel('工作目录').fill(root); await page.getByLabel('处理说明').fill('验证手机表单');
  await page.getByRole('button', { name: '创建规则', exact: true }).click();
  try { await page.locator('dialog').waitFor({ state: 'hidden', timeout: 5000 }); }
  catch (error) { console.log('DIALOG DIAGNOSTIC:', await page.locator('dialog').innerText()); console.log('HUB REQUESTS:', hub.requests.map(x => x.url)); throw error; }
  const saved = JSON.parse(readFileSync(rulesFile, 'utf8')); assert.equal(saved.rules.at(-1).name, '手机创建测试');
  await page.getByRole('button', { name: '调度会话', exact: true }).click();
  await page.getByLabel('项目标识').selectOption(demoRepo);
  await page.getByRole('button', { name: '开启调度会话', exact: true }).click();
  const sessionCard = page.locator('#sessions-list .run-card').filter({ hasText: 'browser-' });
  await sessionCard.waitFor();
  assert.ok((await sessionCard.innerText()).includes('项目 · demo-repo'), 'scheduling session must show its bound project name');
  assert.equal(await page.locator('#project-filter').inputValue(), 'demo-repo', 'starting a session must switch the project filter to the new session so the card stays visible');
  assert.equal(await page.locator('#clear-project-filter').getAttribute('hidden'), null, 'a clear-filter button must be shown while a filter is active');
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.locator('#clear-project-filter').click();
  assert.equal(await page.locator('#project-filter').inputValue(), '', 'clear-filter must reset the project filter');
  await page.getByRole('button', { name: '调度会话', exact: true }).click();
  await page.locator('#session-project').selectOption({ index: 0 });
  await page.getByRole('button', { name: '开启调度会话', exact: true }).click();
  await page.waitForTimeout(300);
  assert.ok((await page.locator('#notice').innerText()).includes('请先从列表选择'), 'placeholder selection must be rejected before starting a session');
  assert.equal(await page.locator('#sessions-list .run-card').count(), 1, 'no session must be created for placeholder selection');
  await page.getByLabel('发消息给会话 browser-session').fill('重点看执行轮次');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForTimeout(300);
  assert.ok((await sessionCard.innerText()).includes('重点看执行轮次'), 'user message must appear in the conversation');
  assert.ok((await sessionCard.innerText()).includes('收到：重点看执行轮次'), 'agent reply must appear in the conversation');
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.getByText('还没有开启的调度会话').waitFor();
  await page.screenshot({ path: path.join(output, 'console-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const paths = hub.requests.map(request => request.url);
  for (const expected of ['/v1/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/pause', '/v1/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/resume', '/v1/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/run', '/v1/runs/3/cancel', '/v1/cards/9/answer', '/v1/cards/10/resolve']) assert.ok(paths.includes(expected), expected);
  console.log('PASS browser: overview, run/pause/resume, cancel, card answer, mobile rule form, no console errors');
} finally {
  if (context) await context.close(); await close(consoleServer); await close(hub.server); rmSync(root, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
}
