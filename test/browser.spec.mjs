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
  seq: 1, totals: { running: 8, queued: 8, retrying: 8, unknown: 8, doneToday: 9 },
  spending: { today: { rounds: 4, tokens: 1234, cost: 0.12, missingCost: 0 } },
  cards: [{ id: 9, state: 'open', title: '是否继续测试', text: '这是一个不产生模型费用的假卡片。', options: ['继续', '暂停'], rule: 'beta 巡检', createdAt: '2026-11-14T05:00:00Z' }, { id: 10, state: 'open', title: '直接结案测试', text: '不需要继续执行。', options: [] }, { id: 11, state: 'open', title: '恢复测试', text: '规则同名卡片不得误认项目。', options: [] }],
  agents: [{ id: 'fake', name: '无模型 Agent', worker: 'test', online: true }], channels: [{ id: 'desktop', name: '桌面通知', online: true }],
  lines: [
    { name: '恢复测试', paused: null, totals: { running: 1, queued: 0, retrying: 0, unknown: 0, done: 4, nothing: 1, doneToday: 2 }, usage: { input: 800, output: 200, cost: 0.5 } },
    { name: 'beta 巡检', paused: null, totals: { running: 0, queued: 2, retrying: 0, unknown: 0, done: 1, nothing: 0, doneToday: 1 }, usage: { input: 10, output: 5 } },
    { name: 'demo 巡检', paused: null, totals: { running: 0, queued: 0, retrying: 0, unknown: 0, done: 3, nothing: 0, doneToday: 1 }, usage: { input: 10, output: 5, cost: 0.1 } },
  ],
  runs: [{ id: 3, rule: '恢复测试', agent: 'fake', state: 'claimed', attempts: 0, createdAt: '2026-11-11T03:00:00Z', summary: '' }, { id: 4, rule: 'beta 巡检', agent: 'fake', state: 'queued', attempts: 2, project: '/elsewhere/beta', createdAt: '2026-11-14T01:00:00Z', summary: 'beta 项目等待重试' }], timers: [],
};
const rawRules = { sources: { local: { name: '本机' } }, agents: { fake: { name: '无模型 Agent', use: 'command', access: 'read' } }, rules: [{ name: '恢复测试', when: { source: 'local', types: ['recovery.*'] }, to: 'fake', cwd: root, prompt: '只验证控制台', resume: false }, { name: 'beta 巡检', when: { source: 'local', types: ['beta.*'] }, to: 'fake', cwd: '/elsewhere/beta', prompt: 'beta 项目巡检', resume: false }, { name: 'demo 巡检', when: { cron: '0 9 * * *' }, to: 'fake', cwd: demoRepo, prompt: 'demo 项目巡检', resume: false }], elsewhere: [] };
const schedulingSessions = {
  records: [],
  archived: [{ id: 'deadbeef-aaaa-bbbb-cccc-ddddeeee0001', project: demoRepo, agent: 'Codex ACP', prompt: '旧的首轮调度说明', continuedFrom: null, messages: [{ role: 'user', text: '上次看到一半的计划', at: '2026-11-15T01:00:00Z' }, { role: 'agent', text: '计划草案已给出，待确认', at: '2026-11-15T01:01:00Z' }], createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:01:00Z', closedAt: null, endStatus: 'interrupted', truncated: false }],
  async listArchived() { return this.archived; },
  async continueSession(id) {
    const original = this.archived.find(item => item.id === id);
    const session = await this.start({ prompt: '续跑', project: original?.project || '未识别' });
    session.continuedFrom = id;
    return session;
  },
  async list() { return this.records; },
  async start({ prompt, project } = {}) {
    const session = { id: 'browser-session', sessionId: 'acp-browser', agent: 'Codex ACP', cwd: root, project: project || '未识别', status: 'idle', statusText: '待命', prompt: prompt || '默认调度说明', messages: [{ role: 'user', text: '默认调度说明', at: '2026-11-14T00:00:00Z' }], liveText: '', busy: false, createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' };
    this.records.push(session); return session;
  },
  async send(id, text, { interrupt = false } = {}) {
    const session = this.records.find(item => item.id === id);
    if (!session) throw new Error('调度会话不存在');
    if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs)); // 模拟真实网络：await 跨过后台刷新周期
    session.sendCalls = session.sendCalls || [];
    session.sendCalls.push({ text, interrupt });
    if (session.busy && !interrupt) {
      session.queue = (session.queue || []).concat(text);
      session.queuedCount = session.queue.length;
      session.updatedAt = '2026-11-14T00:03:00Z';
      return session;
    }
    if (interrupt) { session.queue = []; session.queuedCount = 0; session.busy = false; session.status = 'idle'; session.statusText = '待命'; }
    if (text) {
      session.messages.push({ role: 'user', text, at: '2026-11-14T00:03:00Z' });
      session.messages.push({ role: 'agent', text: `收到：${text}`, at: '2026-11-14T00:03:05Z' });
    }
    session.updatedAt = '2026-11-14T00:03:05Z';
    return session;
  },
  async close(id) { this.records = this.records.filter(session => session.id !== id); return { id, status: 'closed', statusText: '已关闭' }; },
};
const rulesFile = path.join(root, 'rules.json'); writeFileSync(rulesFile, JSON.stringify(rawRules));
const cliPath = path.join(root, 'check.sh'); writeFileSync(cliPath, '#!/bin/sh\nexit 0\n'); chmodSync(cliPath, 0o700);
const hub = await fakeHub((req, res) => {
  if (req.url === '/v1/state') return json(res, snapshot);
  if (req.url.endsWith('/resolve')) { snapshot.cards[1].state = 'closed'; return json(res, { changed: true }); }
  if (req.url.endsWith('/answer')) { const match = req.url.match(/\/cards\/(\d+)\/answer$/); const card = snapshot.cards.find(item => item.id === Number(match?.[1])); if (card) card.state = 'decided'; return json(res, { changed: true }); }
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
  // 真实输入法组词探测（CDP imeSetComposition）：组词进行中跨过后台刷新周期，
  // 断言组词未被提交/重启——2026-11-15 事故：replaceChildren 复用节点仍会先移除再插入，组词被杀
  const cdp = await context.newCDPSession(page);
  const probeCompositionAcrossRefresh = async (locator, commitText) => {
    await locator.click(); // 真实鼠标点击（而非程序化 focus），更贴近用户实际交互
    await locator.fill('占位'); // 非空草稿让卡片钉住，避免 click 与组词之间的刷新重建句柄（竞态）
    const handle = await locator.elementHandle();
    await page.evaluate(node => {
      window.__imeEvents = [];
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) node.addEventListener(type, event => window.__imeEvents.push(event.type));
    }, handle);
    await cdp.send('Input.imeSetComposition', { text: 'pinyinbushuru', selectionStart: 13, selectionEnd: 13 });
    await page.waitForTimeout(4500); // 跨过至少两轮 2s 后台刷新
    const state = await page.evaluate(node => ({ active: document.activeElement === node, events: window.__imeEvents.slice() }), handle);
    assert.equal(state.active, true, 'input must keep focus while IME composition is active across background refreshes');
    assert.equal(state.events.filter(type => type === 'compositionstart').length, 1, 'background refresh must not kill and restart an in-progress IME composition');
    await cdp.send('Input.imeSetComposition', { text: 'pinyinbushuruzhong', selectionStart: 16, selectionEnd: 16 });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__imeEvents.at(-1)), 'compositionupdate', 'composition must continue seamlessly after a background refresh');
    await cdp.send('Input.insertText', { text: commitText });
    await page.waitForTimeout(200);
    assert.equal(await locator.inputValue(), `占位${commitText}`, 'committed IME text must land in the input intact');
    assert.equal(await page.evaluate(() => window.__imeEvents.filter(type => type === 'compositionend').length), 1, 'exactly one composition must commit');
  };
  const filterOptions = await page.locator('#project-filter').locator('option').allInnerTexts();
  assert.ok(filterOptions.includes('全部项目'), 'project filter must offer an explicit 全部 option');
  assert.equal(await page.locator('#attention-list').count(), 1, 'overview must have one attention list');
  assert.match(await page.locator('#summary').innerText(), /今日完成/); assert.match(await page.locator('#summary').innerText(), /1,234/);
  assert.ok((await page.locator('#running-list').innerText()).includes(`项目 · ${path.basename(root)}`), 'overview task summary must show its short project name');
  assert.ok(!(await page.locator('#attention-list').innerText()).includes('是否继续测试'), 'open decision cards must not sit in the scheduling-handled queue');
  assert.match(await page.locator('#attention-list').innerText(), /没有等待调度处理的事/, 'scheduling queue only lists scheduling-handleable items');
  const metric = async index => page.locator('#summary .metric').nth(index).innerText();
  assert.match(await metric(2), /9/, 'unfiltered summary uses the hub totals');
  await page.locator('#project-filter').selectOption(path.basename(root));
  assert.match(await metric(0), /正在运行[\s\S]*1/, 'scoped summary counts only the filtered project running rounds');
  assert.match(await metric(2), /今日完成[\s\S]*2[\s\S]*1,000 Token/, 'scoped summary totals come from that project rule lines');
  assert.match(await metric(3), /今日费用 \$0\.50/, 'scoped summary cost comes from that project usage');
  await page.locator('#project-filter').selectOption('beta');
  assert.match(await metric(1), /等待与重试[\s\S]*2/, 'switching the filter rescopes every metric');
  assert.match(await metric(3), /未上报/, 'a project without reported cost must not fabricate one');
  assert.ok(!(await page.locator('#running-list').innerText()).includes('恢复测试'), 'project filter must hide other projects from running list');
  assert.ok((await page.locator('#retrying-list').innerText()).includes('beta 项目等待重试'), 'project filter must keep the matching retrying run');
  await page.locator('#project-filter').selectOption('');
  assert.ok((await page.locator('#running-list').innerText()).includes('恢复测试'), 'clearing the project filter restores the full overview');
  await page.screenshot({ path: path.join(output, 'console-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '调度规则', exact: true }).click();
  const recoveryCard = page.locator('.rule-card').filter({ hasText: '恢复测试' });
  const beforeDismiss = hub.requests.length; acceptDialogs = false;
  await recoveryCard.locator('[data-action="pause"]').click(); await page.waitForTimeout(150);
  assert.equal(hub.requests.length, beforeDismiss, 'dismissing pause must not call the hub'); acceptDialogs = true;
  await recoveryCard.locator('[data-action="pause"]').click(); await recoveryCard.locator('[data-action="resume"]').waitFor();
  await recoveryCard.locator('[data-action="resume"]').click(); await recoveryCard.locator('[data-action="pause"]').waitFor();
  await recoveryCard.locator('[data-action="run"]').click();
  await page.getByRole('button', { name: '执行轮次', exact: true }).click();
  assert.ok((await page.locator('#runs-list').innerText()).includes(`项目 · ${path.basename(root)}`), 'run summary must show its short project name');
  await page.locator('[data-action="cancel"]').first().click();
  await page.getByRole('button', { name: '待我处理', exact: false }).click();
  const collisionCard = page.locator('.decision-card').filter({ hasText: '规则同名卡片不得误认项目' });
  assert.ok((await collisionCard.innerText()).includes('项目 · 未识别'), 'decision cards must show their own project, never inferred from a rule name collision');
  const betaCard = page.locator('.decision-card').filter({ hasText: '是否继续测试' });
  assert.ok((await betaCard.innerText()).includes('项目 · beta'), 'a card must fall back to its creating rule project');
  assert.ok((await betaCard.innerText()).includes('规则 · beta 巡检'), 'cards must show which rule created them');
  assert.equal(await page.locator('.decision-card').count(), 3, '全部项目 shows every open card');
  await page.locator('#project-filter').selectOption('beta');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.decision-card').count(), 1, 'cards view must filter by project');
  assert.ok((await page.locator('.decision-card').first().innerText()).includes('是否继续测试'), 'only the beta project card stays visible');
  await page.locator('#project-filter').selectOption('');
  const textAnswer=page.locator('form[data-action="answer-text"]').first().locator('textarea'); await textAnswer.fill('刷新后仍要保留'); await page.waitForTimeout(5500); assert.equal(await textAnswer.inputValue(), '刷新后仍要保留');
  await page.keyboard.type('追加输入');
  assert.equal(await page.locator('form[data-action="answer-text"]').first().locator('textarea').inputValue(), '刷新后仍要保留追加输入', 'typing must continue seamlessly across background refreshes');
  const answerInput = page.locator('form[data-action="answer-text"]').first().locator('textarea');
  await answerInput.click(); // 真实鼠标点击（而非程序化 focus），更贴近用户实际交互
  const answerNode = await answerInput.elementHandle();
  await page.waitForTimeout(4500);
  assert.equal(await page.evaluate(node => node.isConnected && document.activeElement === node, answerNode), true, 'answer input DOM node must survive background refreshes so IME composition is not broken');
  await probeCompositionAcrossRefresh(page.locator('form[data-action="answer-text"]').first().locator('textarea'), '拼音补输入');
  await collisionCard.locator('textarea[name="answer"]').fill('通知存活测试');
  await collisionCard.locator('textarea[name="answer"]').press('Enter'); // 回车直接发送回答
  await page.waitForTimeout(2500);
  assert.ok((await page.locator('#notice').innerText()).includes('回答已提交'), 'action notices must survive background refresh cycles');
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
  const chatInput = page.getByLabel('发消息给会话 browser-session');
  await chatInput.fill('草稿在，节点就要在'); // 有草稿才钉住卡片；空输入框按期重建不损失任何东西
  await chatInput.click(); // 真实鼠标点击（而非程序化 focus），更贴近用户实际交互
  const chatNode = await chatInput.elementHandle();
  await page.waitForTimeout(4500);
  assert.equal(await page.evaluate(node => node.isConnected && document.activeElement === node, chatNode), true, 'session chat input DOM node must survive background refreshes while it holds a draft');
  await probeCompositionAcrossRefresh(chatInput, '拼音补输入');
  assert.equal(await page.locator('#project-filter').inputValue(), 'demo-repo', 'starting a session must switch the project filter to the new session so the card stays visible');
  assert.equal(await page.locator('#clear-project-filter').getAttribute('hidden'), null, 'a clear-filter button must be shown while a filter is active');
  await page.getByRole('button', { name: '总览', exact: true }).click();
  // 项目任务进度：写入假串行状态文件，验证节点条、整体百分比与节点浮层
  writeFileSync(path.join(root, 'demo-serial.json'), JSON.stringify({
    project: demoRepo,
    plan: ['n1', 'n2', 'n3'],
    lastNode: 'n2',
    lastEventAt: '2026-11-15T07:00:00Z',
    nodes: {
      n1: { status: 'done', title: '节点一', label: '一', summary: '交付了第一块功能' },
      n2: { status: 'dev_dispatched', title: '节点二', label: '二', part: '联调', percent: 50, summary: '正在实现第二块功能', pr_url: 'https://github.com/halfmoon82/x/pull/9' },
      n3: { status: 'pending', title: '节点三', label: '三' },
    },
  }));
  await page.waitForTimeout(2600);
  const progressRow = page.locator('#progress-list .list-row').filter({ hasText: 'demo-repo' });
  await progressRow.waitFor();
  const progressText = await progressRow.innerText();
  assert.ok(progressText.includes('50%'), 'chain percent must be (done + current part) / total');
  assert.ok(progressText.includes('当前：节点二 · 联调 50%'), 'current line uses the node title');
  assert.equal(await progressRow.locator('.node-seg').count(), 3, 'one segment per node');
  assert.ok(progressText.includes('当前：节点二 · 联调 50%'), 'current node line must show part and percent');
  assert.ok(progressText.includes('待您处理') && progressText.includes('今日完成'), 'counts chips must stay');
  const segTwo = progressRow.locator('.node-seg').filter({ hasText: '二' });
  await segTwo.click();
  const pop = progressRow.locator('.node-pop');
  assert.ok(await pop.isVisible(), 'node click must open the summary popover');
  assert.ok((await pop.innerText()).includes('正在实现第二块功能'), 'popover must show the node summary');
  assert.ok((await pop.innerText()).includes('联调 · 节点内 50%'), 'popover must show status and inner percent');
  const popBox = await pop.boundingBox();
  const panelBox = await page.locator('#progress-list').boundingBox();
  assert.ok(popBox.y >= panelBox.y - 1 && popBox.y + popBox.height <= panelBox.y + panelBox.height + 1, 'the popover card must stay inside the panel bounds');
  await page.waitForTimeout(2600);
  assert.ok(await pop.isVisible(), 'an open node popover must survive background refreshes');
  assert.ok((await pop.innerText()).includes('正在实现第二块功能'), 'refreshed popover keeps the same node content');
  await page.keyboard.press('Escape');
  assert.ok(!(await pop.isVisible()), 'Escape must close the popover');
  await segTwo.focus();
  await page.keyboard.press('Enter');
  assert.ok(await pop.isVisible(), 'Enter on a focused node segment must open the popover');
  await page.keyboard.press('Escape');
  await page.locator('#project-filter').selectOption('demo-repo');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#progress-list .list-row').count(), 1, 'project filter keeps only the matching chain row');
  await page.locator('#project-filter').selectOption('');
  await page.waitForTimeout(300);
  const betaRow = page.locator('#progress-list .list-row').filter({ hasText: 'beta' }).filter({ hasText: '无节点计划' });
  assert.ok(await betaRow.count() >= 1, 'a project with activity but no chain file must still show a counts-only row');
  assert.ok((await betaRow.first().innerText()).includes('等待重试 2'), 'counts-only rows use the same hub aggregates');
  await page.locator('#project-filter').selectOption('beta');
  await page.waitForTimeout(200);
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
  // 回车必须直接发送（与 Codex 输入体验一致）；Alt/Option+回车必须换行而不是发送
  await page.getByLabel('发消息给会话 browser-session').fill('回车发送测试');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#sessions-list').innerText.includes('回车发送测试'), null, { timeout: 6000 });
  assert.equal(await page.getByLabel('发消息给会话 browser-session').inputValue(), '', 'input must clear after Enter send');
  const newlineInput = page.getByLabel('发消息给会话 browser-session');
  await newlineInput.fill('第一行');
  await page.keyboard.press('Alt+Enter');
  await page.keyboard.type('第二行');
  assert.equal(await newlineInput.inputValue(), '第一行\n第二行', 'Alt+Enter must insert a newline in the textarea');
  await newlineInput.fill('第三行');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('第四行');
  assert.equal(await newlineInput.inputValue(), '第三行\n第四行', 'Shift+Enter must also insert a newline in the textarea');
  assert.equal(schedulingSessions.records[0].sendCalls.filter(call => call.text.includes('第二行') || call.text.includes('第四行')).length, 0, 'Alt/Shift+Enter must not send the message');
  assert.ok((await sessionCard.innerText()).includes('收到：重点看执行轮次'), 'agent reply must appear in the conversation');

  // busy 时输入保持可用：发送默认排队，「打断」立即送达（与 Codex 输入体验一致）
  await newlineInput.fill(''); // 清空草稿，让卡片解除钉住、按期重建，及时反映运行中状态
  const record = schedulingSessions.records[0];
  record.status = 'running'; record.busy = true; record.statusText = '运行中';
  await page.waitForTimeout(2500);
  const msgInput = page.getByLabel('发消息给会话 browser-session');
  assert.equal(await msgInput.isEnabled(), true, 'busy 时输入框必须保持可输入');
  assert.equal(await page.getByRole('button', { name: '打断', exact: true }).count(), 1, 'busy 时必须提供打断按钮');
  await msgInput.fill('补充：先看 NAS 部署');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(record.sendCalls.at(-1), { text: '补充：先看 NAS 部署', interrupt: false }, 'busy 时发送默认排队，不打断当前轮');
  assert.ok((await page.locator('#notice').innerText()).includes('排队'), 'queued sends must say they will follow after the turn');
  assert.ok((await sessionCard.innerText()).includes('已排队 1 条'), 'queued count must be visible on the card');
  schedulingSessions.delayMs = 2300; // 真实网络节奏：打断请求跨过一次 2s 后台刷新
  await msgInput.fill('方向变了，停下');
  const draftNode = await msgInput.elementHandle();
  await page.getByRole('button', { name: '打断', exact: true }).click();
  for (let i = 0; i < 50 && !record.sendCalls?.some(call => call.interrupt); i++) await page.waitForTimeout(200); // 等打断请求送达（含注入延迟）
  assert.ok(record.sendCalls.some(call => call.interrupt), 'interrupt request must reach the session');
  await page.waitForTimeout(2600); // 等响应返回 + 两轮刷新
  assert.deepEqual(record.sendCalls.at(-1), { text: '方向变了，停下', interrupt: true }, '打断按钮必须以 interrupt 立即送达');
  assert.ok((await sessionCard.innerText()).includes('方向变了，停下'), 'interrupt message must reach the conversation immediately');
  assert.equal(await page.evaluate(node => node.isConnected, draftNode), false, 'card must rebuild during the slow interrupt request (click focuses the button, so the draft does not pin it)');
  assert.equal(await msgInput.inputValue(), '方向变了，停下', 'interrupt must return the just-sent message to the LIVE input for re-editing');
  schedulingSessions.delayMs = 0;
  record.status = 'running'; record.busy = true; record.statusText = '运行中';
  await msgInput.fill(''); // 清空草稿解冻卡片，让运行中状态与打断按钮渲染出来
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: '打断', exact: true }).focus();
  await page.keyboard.press('Enter'); // 键盘可达性：按钮上的回车保持原生语义，必须是打断而不是发送
  await page.waitForTimeout(300);
  assert.deepEqual(record.sendCalls.at(-1), { text: '', interrupt: true }, 'Enter on the interrupt button must trigger interrupt, not a queued send');

  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.locator('#sessions-list').getByText('还没有开启的调度会话').waitFor();
  // 已存档会话：转录只读可回溯，一键继续生成新会话
  const archivedCard = page.locator('#archived-sessions-list .run-card.archived');
  await archivedCard.waitFor();
  assert.ok((await archivedCard.innerText()).includes('被重启中断'), 'archived sessions show why they stopped');
  assert.ok((await archivedCard.innerText()).includes('上次看到一半的计划'), 'archived transcripts stay readable');
  await archivedCard.getByRole('button', { name: '继续调度', exact: true }).click();
  await page.locator('#sessions-list .run-card').filter({ hasText: '项目 · demo-repo' }).waitFor();
  assert.ok(await archivedCard.count() >= 1, 'the archive entry stays after continuing');
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.locator('#sessions-list').getByText('还没有开启的调度会话').waitFor();
  await page.screenshot({ path: path.join(output, 'console-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const paths = hub.requests.map(request => request.url);
  for (const expected of ['/v1/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/pause', '/v1/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/resume', '/v1/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/run', '/v1/runs/3/cancel', '/v1/cards/9/answer', '/v1/cards/10/resolve']) assert.ok(paths.includes(expected), expected);
  console.log('PASS browser: overview, run/pause/resume, cancel, card answer, mobile rule form, no console errors');
} finally {
  if (context) await context.close(); await close(consoleServer); await close(hub.server); rmSync(root, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
}
