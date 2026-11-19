import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { decodeQr } from '../public/qr.mjs';
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
    { name: 'demo 巡检', paused: null, totals: { running: 0, queued: 0, retrying: 0, unknown: 0, done: 3, nothing: 0, doneToday: 1, usage: { input: 1234, output: 432, cost: 0.21 } } },
  ],
  runs: [{ id: 3, rule: '恢复测试', agent: 'fake', state: 'claimed', attempts: 0, createdAt: '2026-11-11T03:00:00Z', summary: '',
    events: [{ source: 'local', type: 'run.manual', subject: 'recovery-75', summary: 'owner 手动触发恢复核验' }] }, { id: 4, rule: 'beta 巡检', agent: 'fake', state: 'queued', attempts: 2, project: '/elsewhere/beta', createdAt: '2026-11-14T01:00:00Z', summary: 'beta 项目等待重试' }, { id: 5, rule: 'demo 巡检', agent: 'fake', state: 'done', finishedAt: new Date().toISOString(), usage: { input: 60, output: 40, cost: 0.07 }, summary: '今日完成一次巡检' }], timers: [],
  hasMore: true, nextBefore: 3,
};
const rawRules = { sources: { local: { name: '本机' } }, agents: { fake: { name: '无模型 Agent', use: 'command', access: 'read' } }, rules: [{ name: '恢复测试', when: { source: 'local', types: ['recovery.*'] }, to: 'fake', cwd: root, prompt: '只验证控制台', resume: false }, { name: 'beta 巡检', when: { source: 'local', types: ['beta.*'] }, to: 'fake', cwd: '/elsewhere/beta', prompt: 'beta 项目巡检', resume: false }, { name: 'demo 巡检', when: { cron: '0 9 * * *' }, to: 'fake', cwd: demoRepo, prompt: 'demo 项目巡检', resume: false }], elsewhere: [] };
const schedulingSessions = {
  records: [],
  queueSeq: 0,
  archived: [{ id: 'deadbeef-aaaa-bbbb-cccc-ddddeeee0001', project: demoRepo, agent: 'Codex ACP', prompt: '旧的首轮调度说明', continuedFrom: null, messages: [...Array.from({ length: 8 }, (_, index) => [{ role: 'user', text: `第 ${index + 1} 轮调度指令`, at: '2026-11-15T00:00:00Z' }, { role: 'agent', text: `第 ${index + 1} 轮回复：` + '内容较长需要换行展示。'.repeat(6), at: '2026-11-15T00:05:00Z' }]).flat(), { role: 'user', text: '上次看到一半的计划', at: '2026-11-15T01:00:00Z' }, { role: 'agent', text: '计划草案已给出，待确认。' + '收尾补充说明。'.repeat(20), at: '2026-11-15T01:01:00Z' }], createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:01:00Z', closedAt: null, endStatus: 'interrupted', truncated: false }],
  async listArchived() { return this.archived; },
  async continueSession(id) {
    const original = this.archived.find(item => item.id === id);
    const session = await this.start({ prompt: '续跑', project: original?.project || '未识别' });
    session.continuedFrom = id;
    return session;
  },
  async list() { return this.records; },
  async start({ prompt, project, kind } = {}) {
    (this.startCalls ||= []).push({ prompt, project, kind });
    // 测试开关（一次性）：failNextStart 让下一次新建失败；nextStartId 给下一次新建指定 id（默认沿用 browser-session）。
    if (this.failNextStart) { const message = this.failNextStart; this.failNextStart = null; throw new Error(message); }
    const id = this.nextStartId || 'browser-session'; this.nextStartId = null;
    const session = { id, sessionId: id === 'browser-session' ? 'acp-browser' : `acp-${id}`, agent: 'Codex ACP', cwd: root, project: project || '未识别', status: 'idle', statusText: '待命', prompt: prompt || '默认调度说明', messages: [{ role: 'user', text: '默认调度说明', at: '2026-11-14T00:00:00Z' }], liveText: '', busy: false, queue: [], queued: [], queuedCount: 0, createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' };
    this.records.push(session); return session;
  },
  async listSessionArtifacts(id) {
    const session = this.records.find(item => item.id === id);
    if (!session) { const error = new Error('调度会话不存在'); error.status = 404; throw error; }
    session.artifactListCalls = (session.artifactListCalls || 0) + 1;
    return [
      { path: 'docs/调度报告.md', name: '调度报告.md', size: 210, at: '2026-11-16T00:00:00Z' },
      { path: 'docs/看板.html', name: '看板.html', size: 120, at: '2026-11-16T00:00:00Z' },
    ];
  },
  async readSessionArtifact(id, relPath) {
    const session = this.records.find(item => item.id === id);
    if (!session) { const error = new Error('调度会话不存在'); error.status = 404; throw error; }
    if (relPath === 'docs/调度报告.md') return { path: relPath, name: '调度报告.md', content: '# 调度报告\n\n- **事项一**：已修复\n- 事项二：跟进中\n\n> 引用：队列已暂停\n\n[恶意链](javascript:fetch(\'/api/rules\'))与[正常链](https://example.com)' };
    if (relPath === 'docs/看板.html') return { path: relPath, name: '看板.html', content: "<h1>数据看板</h1><p>实时</p><script>parent.document.documentElement.dataset.pwned='1'</script>" };
    const error = new Error('产物文件不存在：' + relPath); error.status = 404; throw error;
  },
  async removeQueued(id, itemId) {
    const session = this.records.find(item => item.id === id);
    if (!session) throw new Error('调度会话不存在');
    session.removeCalls = session.removeCalls || [];
    session.removeCalls.push(itemId);
    session.queue = (session.queue || []).filter(item => item.id !== itemId);
    session.queued = session.queue;
    session.queuedCount = session.queue.length;
    return session;
  },
  async steerQueued(id, itemId) {
    const session = this.records.find(item => item.id === id);
    if (!session) throw new Error('调度会话不存在');
    const item = (session.queue || []).find(entry => entry.id === itemId);
    if (!item) {
      const error = new Error('队列消息不存在或已送达'); error.status = 404;
      throw error;
    }
    session.queue = (session.queue || []).filter(entry => entry.id !== itemId);
    session.queued = session.queue;
    session.queuedCount = session.queue.length;
    if (session.busy) session.steerCalls = (session.steerCalls || []).concat({ text: item.text }); // 原生 steering：注入当前轮
    else { session.queue.unshift({ id: `q${++this.queueSeq}`, text: item.text, at: '2026-11-14T00:03:00Z' }); session.queued = session.queue; session.queuedCount = session.queue.length; session.sendCalls.push({ text: item.text, interrupt: true, steer: true }); }
    return session;
  },
  async updateQueued(id, itemId, text) {
    const session = this.records.find(item => item.id === id);
    if (!session) throw new Error('调度会话不存在');
    session.editCalls = session.editCalls || [];
    session.editCalls.push({ itemId, text });
    const entry = (session.queue || []).find(item => item.id === itemId);
    if (!entry) { const error = new Error('队列消息不存在或已送达'); error.status = 404; throw error; }
    entry.text = text;
    return session;
  },
  async moveQueued(id, itemId, direction) {
    const session = this.records.find(item => item.id === id);
    if (!session) throw new Error('调度会话不存在');
    const index = (session.queue || []).findIndex(item => item.id === itemId);
    if (index === -1) { const error = new Error('队列消息不存在或已送达'); error.status = 404; throw error; }
    const target = index + (direction === 'up' ? -1 : 1);
    if (target >= 0 && target < session.queue.length) [session.queue[index], session.queue[target]] = [session.queue[target], session.queue[index]];
    session.queued = session.queue;
    return session;
  },
  async clearQueued(id) {
    const session = this.records.find(item => item.id === id);
    if (!session) throw new Error('调度会话不存在');
    session.clearCalls = (session.clearCalls || 0) + 1;
    session.queue = []; session.queued = []; session.queuedCount = 0; session.queuePaused = false;
    return session;
  },
  async send(id, text, { interrupt = false } = {}) {
    const session = this.records.find(item => item.id === id);
    if (!session) throw new Error('调度会话不存在');
    if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs)); // 模拟真实网络：await 跨过后台刷新周期
    session.sendCalls = session.sendCalls || [];
    session.sendCalls.push({ text, interrupt });
    if (session.busy && !interrupt) {
      session.queue = (session.queue || []).concat({ id: `q${++this.queueSeq}`, text, at: '2026-11-14T00:03:00Z' });
      session.queued = session.queue;
      session.queuedCount = session.queue.length;
      session.updatedAt = '2026-11-14T00:03:00Z';
      return session;
    }
    if (interrupt) { session.busy = false; session.status = 'idle'; session.statusText = '待命'; }
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
const detourSample = {
  detoured: { id: 'wb-hy4-browser', status: 'detoured', blockedAt: '2026-11-15T00:24:04.000Z', blockedAgent: 'workbuddy', blockedModel: 'hy4free', evidence: 'WP8 连续 5 次 refusal（429 配额）', fallbackAgent: 'claude', rules: [{ name: 'demo 巡检', originalTo: 'workbuddy' }], probe: { command: ['/secret/probe.sh'], cooldownMinutes: 30 }, lastProbeAt: null, lastProbeOk: null, history: [] },
  reverted: { id: 'wb-hy4-old', status: 'reverted', blockedAt: '2026-11-14T00:00:00.000Z', revertedAt: '2026-11-15T01:00:00.000Z', blockedAgent: 'workbuddy', blockedModel: 'hy4free', evidence: '旧绕行已回归', fallbackAgent: 'claude', rules: [{ name: 'demo 巡检', originalTo: 'workbuddy' }], probe: { command: ['/secret/probe.sh'], cooldownMinutes: 30 }, lastProbeAt: '2026-11-15T01:00:00.000Z', lastProbeOk: true, history: [] },
};
writeFileSync(path.join(root, 'detours.json'), JSON.stringify({ detours: [detourSample.detoured, detourSample.reverted] }));
const cliPath = path.join(root, 'check.sh'); writeFileSync(cliPath, '#!/bin/sh\nexit 0\n'); chmodSync(cliPath, 0o700);
const hubEvents = [];
// 台账翻页的历史轮次：demo 巡检在 ?before= 页里还有更早完成的两轮，
// 链/项目累计必须来自这些 runs 全量累加，而不是 lines 的今日窗口。
const historyRuns = [
  // 这一轮由串行编排派给节点 n2（触发事件 subject=节点 id），它就是 n2 的最近一轮；首页 #5 没有节点编号，不算任何节点的。
  { id: 2, rule: 'demo 巡检', agent: 'fake', state: 'done', finishedAt: '2026-11-10T01:00:00Z', usage: { input: 600, output: 200, cost: 0.1 }, summary: '更早完成一轮巡检', events: [{ source: 'local', type: 'demo.dev', subject: 'n2', summary: '节点二开发' }] },
  { id: 1, rule: 'demo 巡检', agent: 'fake', state: 'done', finishedAt: '2026-11-09T01:00:00Z', usage: { input: 574, output: 192, cost: 0.04 }, summary: '首轮巡检' },
];
const hub = await fakeHub((req, res) => {
  if (req.url === '/v1/state') return json(res, snapshot);
  if (req.url.startsWith('/v1/state?before=')) return json(res, { ...snapshot, runs: historyRuns, hasMore: false, nextBefore: null });   // 历史页到此为止：不得继承首页的 hasMore/nextBefore
  if (req.url === '/v1/events') { hubEvents.push(req.url); return json(res, { runId: 999 }); }
  if (req.url.endsWith('/resolve')) {
    const match = req.url.match(/\/cards\/(\d+)\/resolve$/);
    const card = snapshot.cards.find(item => item.id === Number(match?.[1])) || snapshot.cards[1];
    card.state = 'closed'; return json(res, { changed: true });
  }
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
  page.on('response', response => { if (response.status() >= 400) console.log('HTTP DIAGNOSTIC:', response.status(), response.url()); }); page.on('pageerror', error => errors.push(error.message)); page.on('console', message => {
    if (message.type() !== 'error') return;
    // 沙箱 iframe 里的 XSS 载荷被 Chrome 拦下时会打这条 console —— 这正是防护生效的证据，不是脚本错误。
    if (message.text().includes("Blocked script execution in 'about:srcdoc'")) return;
    errors.push(`${message.text()} at ${JSON.stringify(message.location())}`);
  });
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
  assert.ok((await page.locator('#running-list').innerText()).includes('执行 · 无模型 Agent'), 'overview items must show which agent executes them');
  // #75：run 无 text 的在途轮次必须显示触发事件的任务摘要 + 稳定任务编号
  assert.ok((await page.locator('#running-list').innerText()).includes('任务摘要'), 'in-flight round must label the task summary');
  assert.ok((await page.locator('#running-list').innerText()).includes('owner 手动触发恢复核验'), 'run without text falls back to triggering event summary');
  assert.ok((await page.locator('#running-list').innerText()).includes('recovery-75'), 'run without text falls back to triggering event subject as task number');
  assert.ok(!(await page.locator('#attention-list').innerText()).includes('是否继续测试'), 'open decision cards must not sit in the scheduling-handled queue');
  const attentionBefore = await page.locator('#attention-list').innerText();
  assert.ok(attentionBefore.includes('wb-hy4-browser') || attentionBefore.includes('没有等待调度处理的事'), 'scheduling queue only lists scheduling-handleable items (detours count as scheduling-handled)');
  const metric = async index => page.locator('#summary .metric').nth(index).innerText();
  assert.match(await metric(2), /9/, 'unfiltered summary uses the hub totals');
  await page.locator('#project-filter').selectOption(path.basename(root));
  assert.match(await metric(0), /正在运行[\s\S]*1/, 'scoped summary counts only the filtered project running rounds');
  assert.match(await metric(2), /今日完成[\s\S]*2[\s\S]*1,000 Token/, 'scoped summary totals come from that project rule lines');
  assert.match(await metric(2), /今日费用 \$0\.50/, 'scoped summary cost comes from that project usage');
  await page.locator('#project-filter').selectOption('beta');
  assert.match(await metric(1), /等待重试[\s\S]*2/, 'switching the filter rescopes every metric');
  assert.match(await metric(2), /未上报/, 'a project without reported cost must not fabricate one');
  assert.ok(!(await page.locator('#running-list').innerText()).includes('恢复测试'), 'project filter must hide other projects from running list');
  assert.ok((await page.locator('#retrying-list').innerText()).includes('beta 项目等待重试'), 'project filter must keep the matching retrying run');
  const retryingText = await page.locator('#retrying-list').innerText();
  assert.ok(retryingText.includes('绕行中'), 'an active detour must show in the retrying section');
  assert.ok(retryingText.includes('workbuddy/hy4free'), 'the detour row must name the blocked agent/model');
  assert.ok(retryingText.includes('核实恢复中'), 'the detour row must say verification is pending');
  assert.ok(!retryingText.includes('wb-hy4-old'), 'a reverted detour must not be listed anymore');
  const attentionText = await page.locator('#attention-list').innerText();
  assert.ok(attentionText.includes('绕行中'), 'the scheduling-handled queue must surface the active detour too');
  await page.locator('#project-filter').selectOption('');
  assert.ok((await page.locator('#running-list').innerText()).includes('恢复测试'), 'clearing the project filter restores the full overview');
  await page.screenshot({ path: path.join(output, 'console-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '调度规则', exact: true }).click();
  const recoveryCard = page.locator('.rule-card').filter({ hasText: '恢复测试' });
  // 后台每 2s 会读 /v1/state，按 pause 路径计数才不会把轮询算成误调用
  const pauseCalls = () => hub.requests.filter(request => request.url.includes('/pause')).length;
  const beforeDismiss = pauseCalls(); acceptDialogs = false;
  await recoveryCard.locator('[data-action="pause"]').click(); await page.waitForTimeout(150);
  assert.equal(pauseCalls(), beforeDismiss, 'dismissing pause must not call the hub'); acceptDialogs = true;
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
  for (const card of await page.locator('.decision-card').all()) {
    assert.equal(await card.getByRole('button', { name: '退回调度处理', exact: true }).count(), 1, 'every open card must expose exactly one delegate action');
  }
  assert.deepEqual(await betaCard.locator('[data-action="answer-choice"]').allInnerTexts(), ['继续', '暂停'], 'adding the delegate action must not change original option order');
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
  // 全局 DOM 稳定：非键控列表（执行轮次）内的文本选区必须能跨过后台 2s 刷新周期——
  // 否则 replaceChildren 重建把选区打散，内容无法选定复制（2026-11-17 事故：各页面普遍存在）
  await page.getByRole('button', { name: '执行轮次', exact: true }).click();
  const runSummary = page.locator('#runs-list .run-summary').filter({ hasText: 'beta 项目等待重试' });
  await runSummary.waitFor();
  const selectedText = await runSummary.evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  assert.equal(selectedText, 'beta 项目等待重试');
  snapshot.runs[1].summary = 'beta 项目已改派，需要人工看一眼'; // 选区存在期间后台数据变化
  await page.waitForTimeout(4500); // 跨过至少两轮 2s 后台刷新
  const selectionAcrossRefresh = await page.evaluate(() => {
    const selection = document.getSelection();
    const anchor = selection.anchorNode;
    const host = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    return { text: selection.toString(), connected: !!(host && host.isConnected), frozen: document.querySelector('#runs-list').innerText.includes('beta 项目等待重试') };
  });
  assert.equal(selectionAcrossRefresh.connected, true, 'selection anchor must stay connected across background refreshes');
  assert.equal(selectionAcrossRefresh.text, 'beta 项目等待重试', 'selected text must survive background refreshes so it can be copied');
  assert.equal(selectionAcrossRefresh.frozen, true, 'the list under selection freezes instead of rebuilding');
  await page.evaluate(() => document.getSelection().removeAllRanges());
  await page.waitForTimeout(3500); // 选区收起后下一轮轮询必须用最新数据补齐（余量 > 轮询间隔，防 CI 抖动）
  assert.ok((await page.locator('#runs-list').innerText()).includes('beta 项目已改派'), 'after the selection collapses the next refresh must catch up with the latest data');
  // 指针按下未抬起（点击/拖选进行中）同帧轮询不能拆除目标节点，否则 click 丢失；
  // 拖出窗口外释放收不到 pointerup，靠 window blur 兜底清除按压状态
  const pressCard = page.locator('#runs-list .run-card').filter({ hasText: 'beta 项目已改派' });
  // 不用 boundingBox 读坐标：2s 后台刷新可能刚好重建列表，坐标读取会拿到 null。
  // hover 由 Playwright 等待可见并稳定，元素若在途中被替换会自动重试。
  await pressCard.hover();
  snapshot.runs[1].summary = 'beta 项目二次改派';
  await page.mouse.down();
  await page.waitForTimeout(4500); // 按下未抬起跨两轮轮询
  assert.ok((await page.locator('#runs-list').innerText()).includes('beta 项目已改派'), 'the list under a held pointer freezes instead of rebuilding the pressed target away');
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); // 模拟拖出窗口外释放：blur 兜底清除按压态
  await page.mouse.up();
  await page.waitForTimeout(3500);
  assert.ok((await page.locator('#runs-list').innerText()).includes('beta 项目二次改派'), 'after the press clears the next refresh must catch up with the latest data');
  snapshot.runs[1].summary = 'beta 项目等待重试'; // 还原，避免影响后续断言
  await page.waitForTimeout(3500);
  await page.locator('.nav-item[data-view="cards"]').click(); // 回到插入前的视图，后续断言在待我处理页继续
  await page.getByRole('button', { name: '继续', exact: true }).click();
  const resolveCard=page.locator('.decision-card').filter({hasText:'直接结案测试'}); await resolveCard.getByRole('button',{name:'结案',exact:true}).click();
  // 退回调度：一键退回产生 Hub 事件，成功后原卡结案；原选项和答案保持不变
  const delegateBefore = hubEvents.length;
  snapshot.cards.push({ id: 12, state: 'open', title: '退回调度测试卡', text: '这是一个产品语言背景。', options: ['保留', '取消'], rule: 'beta 巡检', createdAt: '2026-11-17T00:00:00Z' });
  await page.waitForTimeout(2500);
  const delegateCard = page.locator('.decision-card').filter({ hasText: '退回调度测试卡' });
  assert.deepEqual(await delegateCard.locator('[data-action="answer-choice"]').allInnerTexts(), ['保留', '取消'], 'delegate card options must stay in original order');
  await delegateCard.getByRole('button', { name: '退回调度处理', exact: true }).click();
  await page.waitForTimeout(2500);
  assert.ok((await page.locator('#notice').innerText()).includes('已退回调度处理'), 'delegate must report success to the user');
  assert.ok(hubEvents.length > delegateBefore, 'delegate click must create a Hub scheduling event');
  assert.equal(snapshot.cards.find(card => card.id === 12)?.state, 'closed', 'source card must be closed only after the event is accepted');
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole('button', { name: '调度规则', exact: true }).click(); await page.getByRole('button', { name: '新建规则', exact: true }).click();
  await page.getByLabel('规则名称').fill('手机创建测试'); await page.getByLabel('Cron 表达式').fill('0 9 * * *'); await page.getByLabel('工作目录').fill(root); await page.getByLabel('处理说明').fill('验证手机表单');
  await page.getByRole('button', { name: '创建规则', exact: true }).click();
  try { await page.locator('#rule-dialog').waitFor({ state: 'hidden', timeout: 5000 }); }
  catch (error) { console.log('DIALOG DIAGNOSTIC:', await page.locator('#rule-dialog').innerText()); console.log('HUB REQUESTS:', hub.requests.map(x => x.url)); throw error; }
  const saved = JSON.parse(readFileSync(rulesFile, 'utf8')); assert.equal(saved.rules.at(-1).name, '手机创建测试');
  await page.getByRole('button', { name: '会话管理', exact: false }).click();
  // 新建会话对话框全链（设计基线）：打开 → 输入首轮提示词 → 语义分类 → 手动覆盖 → 确认门 → 创建后出现在列表。
  await page.locator('#session-new').click();
  await page.locator('#new-session-dialog').waitFor({ state: 'visible' });
  // 步骤1 打开：对话框结构与初始态
  assert.ok((await page.locator('#new-session-dialog .dialog-heading').innerText()).includes('新建会话'), 'dialog heading must show 新建会话');
  assert.equal(await page.locator('#new-session-project').isVisible(), true, 'dialog project select must be visible');
  assert.equal(await page.locator('#new-session-request').isVisible(), true, 'dialog prompt textarea must be visible');
  assert.equal(await page.locator('#classification-title').innerText(), '等待输入', 'classification must start at waiting state');
  assert.equal(await page.locator('[data-type-override]').count(), 4, 'dialog must offer 4 override options');
  assert.equal(await page.locator('#create-session').isDisabled(), true, 'create button must be disabled before a prompt is entered');
  await page.locator('#new-session-project').selectOption(demoRepo);
  // 步骤2 输入首轮提示词：实时语义分类 + 理由 + 契约
  await page.locator('#new-session-request').fill('设计一个多租户计费方案并拆解为可并行的 DAG');
  await page.waitForFunction(() => document.querySelector('#classification-title')?.textContent?.includes('设计会话'), null, { timeout: 5000 });
  assert.ok((await page.locator('#classification-reason').innerText()).includes('PRD'), 'classification reason must be shown');
  assert.ok((await page.locator('#classification-contract').innerText()).includes('Plan Mode'), 'design contract must be shown');
  assert.equal(await page.locator('#create-session').isEnabled(), true, 'create button must enable after a prompt is entered');
  // 步骤3 手动覆盖：按钮态与标题、契约同步
  await page.locator('[data-type-override="normal"]').click();
  assert.ok((await page.locator('#classification-title').innerText()).includes('普通会话 · 手动指定'), 'manual override must mark the classification');
  assert.equal(await page.locator('[data-type-override="normal"]').getAttribute('aria-pressed'), 'true', 'override button must expose pressed state');
  assert.ok((await page.locator('#classification-contract').innerText()).includes('不组装额外提示词'), 'override must update the contract');
  await page.locator('[data-type-override="auto"]').click();
  assert.ok((await page.locator('#classification-title').innerText()).includes('设计会话 · 推荐'), 'returning to auto must restore the recommendation');
  // 步骤4 确认门：确认前不创建会话、不发送首轮
  await page.locator('#new-session-request').fill('排查失败任务并恢复调度规则');
  await page.waitForFunction(() => document.querySelector('#classification-title')?.textContent?.includes('调度会话'), null, { timeout: 5000 });
  assert.equal(schedulingSessions.startCalls?.length || 0, 0, 'no session turn may run before the user confirms');
  // 步骤5 确认创建：会话出现在对应 tab 与列表，对话框关闭
  await page.locator('#create-session').click();
  await page.locator('#new-session-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#toast').isVisible(), true, 'creating a session must show a toast confirmation');
  assert.ok((await page.locator('#toast').innerText()).includes('已创建'), 'toast must confirm the session was created');
  const sessionCard = page.locator('#session-workspace .run-card.session-card').filter({ hasText: 'browser-' });
  await sessionCard.waitFor();
  await page.locator('#session-items .session-item[data-session="browser-session"]').waitFor('attached');
  assert.equal(await page.locator('.session-kind-tabs [data-kind="scheduling"]').getAttribute('aria-selected'), 'true', 'creating a scheduling session must activate the scheduling kind tab');
  assert.deepEqual(schedulingSessions.startCalls, [{ prompt: '排查失败任务并恢复调度规则', project: demoRepo, kind: 'scheduling' }], 'first turn must be sent once with the confirmed kind');
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
  // 总览常驻 DAG 入口：当前没有运行中的 DAG 也能进入执行授权页（11-19：入口只藏在运行详情里，到不了）。
  assert.equal(await page.locator('#overview-dag-new').isVisible(), true, 'overview must always offer the new-DAG entry');
  await page.locator('#overview-dag-new').click();
  assert.equal(await page.locator('#view-authorize').isVisible(), true, 'the overview DAG entry must open the authorization screen');
  assert.equal(await page.locator('#authorize-load').isVisible(), true, 'authorization screen must offer 读取计划与预检');
  await page.getByRole('button', { name: '总览', exact: true }).click();
  // 项目任务进度：写入假串行状态文件，验证「环形扇区 + 单节点详情 + 固定高度」
  const chainFixture = (nodes, plan) => ({
    project: demoRepo,
    plan,
    lastNode: 'n2',
    lastEventAt: '2026-11-15T07:00:00Z',
    nodes: Object.fromEntries(nodes),
  });
  const threeNodes = [
    ['n1', { status: 'done', title: '节点一', label: '一', summary: '交付了第一块功能' }],
    ['n2', { status: 'dev_dispatched', title: '节点二', label: '二', part: '联调', percent: 50, summary: '正在实现第二块功能：补齐导出链路的异常分支并补充回归测试，完成后进入联调', pr_url: 'https://github.com/example-org/x/pull/9' }],
    ['n3', { status: 'pending', title: '节点三', label: '三' }],
  ];
  writeFileSync(path.join(root, 'demo-serial.json'), JSON.stringify(chainFixture(threeNodes, ['n1', 'n2', 'n3'])));
  await page.waitForTimeout(2600);
  const progressRow = page.locator('#progress-list .list-row').filter({ hasText: 'demo-repo' });
  await progressRow.waitFor();
  const progressText = await progressRow.innerText();
  assert.ok(progressText.includes('50%'), 'chain percent must be (done + current part) / total');
  assert.ok(progressText.includes('串行链'), 'serial chain uses the same badge language as DAG');
  assert.ok(progressText.includes('同一色相 · 深浅 = 状态'), 'serial ring keeps the unified segment language');
  // 环形扇区 = 节点；右侧只显示一个节点详情，默认当前活跃节点
  assert.equal(await progressRow.locator('.overview-ring').getAttribute('data-segments'), '3', 'one ring sector per node');
  assert.equal(await progressRow.locator('.ring-seg').count(), 3, 'every node is a clickable sector');
  assert.deepEqual(await progressRow.locator('.ring-label').evaluateAll(list => list.map(node => node.textContent)), ['节点一', '节点二', '节点三'], 'each sector carries its node name');
  assert.equal(await progressRow.locator('.ring-divider.wave').count(), 2, 'node group boundaries use solid dividers');
  assert.equal(await progressRow.locator('.ring-divider.node').count(), 0, 'single-node groups need no dashed dividers');
  const detailTitle = progressRow.locator('.overview-node-head strong');
  assert.equal(await detailTitle.innerText(), '节点二', 'default detail shows the current active node');
  for (const label of ['任务摘要', '执行 Agent', '模型', '费用 Token']) assert.ok(progressText.includes(label), `node detail must carry ${label}`);
  assert.ok(progressText.includes('正在实现第二块功能'), 'detail shows the real task summary');
  assert.ok(progressText.includes('联调'), 'detail keeps the node part');
  // 节点的执行者/用量只来自派给它自己的那一轮（假 Hub 历史页 #2：subject=n2 · fake · $0.10）；首页更新的 #5 没有节点编号，不能挂到节点上
  assert.equal(await progressRow.locator('.overview-node .node-agent').innerText(), '无模型 Agent', 'current node agent comes from its own latest Hub round');
  assert.match(await progressRow.locator('.overview-node .node-usage').innerText(), /^最近一轮 · 费用 \$0\.10 · Token 800/, 'current node usage is its own round self-report, not the chain-wide latest round');
  await progressRow.locator('.ring-seg[data-ring-node="n3"]').focus(); await page.keyboard.press('Enter');
  assert.equal(await progressRow.locator('.overview-node .node-agent').innerText(), '未上报', 'non-current nodes without data stay unreported, never fabricated');
  assert.equal(await progressRow.locator('.overview-node .node-usage').innerText(), '费用未上报 · Token 未上报');
  await progressRow.locator('.ring-seg[data-ring-node="n2"]').focus(); await page.keyboard.press('Enter');
  assert.ok(progressText.includes('待您处理') && progressText.includes('今日完成'), 'counts chips must stay');
  assert.ok(progressText.includes('链累计') && progressText.includes('1,666 Token') && progressText.includes('$0.21'), 'chain usage stays truthful');
  assert.ok(progressText.includes('项目今日 · 费用 $0.07 · Token 100（入 60 / 出 40）'), 'project today usage must come from runs finished today');
  assert.ok(progressText.includes('项目累计 · 费用 $0.21 · Token 1,666（入 1,234 / 出 432）'), 'project cumulative usage must come from the runs ledger across pages, not the today-window rule lines');
  assert.equal(await progressRow.locator('.node-pop').count(), 0, 'node-only popover is retired');
  // 固定高度：节点数量与切换都不改变卡片高度
  // 扇区是圆环描边（中空），按下标算出该扇区中角在描边上的绝对坐标再点。
  // 找扇区、滚入视口、算坐标在页面内一次同步完成（#132）：总览每 2 秒整块重建进度面板，
  // 分几次往返会撞上重建；同一同步脚本里重建插不进来。几何按本分支 280 环的 r/stroke 通用计算。
  const clickSector = async (rowText, id, index, count) => {
    const angle = (-90 + (index + 0.5) * (360 / count)) * Math.PI / 180;
    const point = await page.evaluate(({ rowText, id, radians }) => {
      const row = [...document.querySelectorAll('#progress-list .list-row')].find(node => node.textContent.includes(rowText));
      const el = row?.querySelector(`.ring-seg[data-ring-node="${CSS.escape(id)}"]`);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const box = el.getBoundingClientRect();
      const r = parseFloat(el.getAttribute('r'));
      const stroke = parseFloat(el.getAttribute('stroke-width')) || 0;
      const scale = box.width / (2 * r + stroke);
      return { x: box.x + box.width / 2 + r * scale * Math.cos(radians), y: box.y + box.height / 2 + r * scale * Math.sin(radians) };
    }, { rowText, id, radians: angle });
    assert.ok(point, `找不到 ${rowText} 的扇区 ${id}`);
    await page.mouse.click(point.x, point.y);
  };
  const fixedHeight = await progressRow.locator('.overview-progress').evaluate(node => node.getBoundingClientRect().height);
  assert.ok([280, 540].includes(Math.round(fixedHeight)), `overview progress uses a fixed design height (got ${fixedHeight})`);
  await clickSector('demo-repo', 'n1', 0, 3);
  assert.equal(await detailTitle.innerText(), '节点一', 'clicking a ring sector switches the node detail');
  assert.ok((await progressRow.locator('.overview-node').innerText()).includes('交付了第一块功能'), 'switched detail shows that node summary');
  assert.equal(await progressRow.locator('.overview-progress').evaluate(node => node.getBoundingClientRect().height), fixedHeight, 'switching nodes must not change the fixed height');
  assert.equal(await page.locator('#view-overview').isVisible(), true, 'ring click must stay on the overview');
  assert.equal(await page.locator('#view-dag').isVisible(), false, 'ring click must not open the detail view');
  // 键盘可达：Tab 到扇区按 Enter 同样切换
  await progressRow.locator('.ring-seg[data-ring-node="n2"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await detailTitle.innerText(), '节点二', 'keyboard selection switches the detail too');
  // 无摘要节点必须有兜底文案
  await clickSector('demo-repo', 'n3', 2, 3);
  assert.ok((await progressRow.locator('.overview-node').innerText()).includes('暂无任务摘要'), 'pending node summary falls back truthfully');
  // 节点数增加时高度不变：扩到 12 个节点再对比
  const manyNodes = [...threeNodes, ...Array.from({ length: 9 }, (_, index) => [`n${index + 4}`, { status: 'pending', title: `节点${index + 4}`, label: String(index + 4) }])];
  writeFileSync(path.join(root, 'demo-serial.json'), JSON.stringify(chainFixture(manyNodes, manyNodes.map(([id]) => id))));
  await page.waitForTimeout(2600);
  assert.equal(await progressRow.locator('.ring-seg').count(), 12, 'every node becomes a ring sector');
  assert.equal(await progressRow.locator('.overview-progress').evaluate(node => node.getBoundingClientRect().height), fixedHeight, 'height stays fixed with more nodes');
  // 恢复三节点夹具供后续断言
  writeFileSync(path.join(root, 'demo-serial.json'), JSON.stringify(chainFixture(threeNodes, ['n1', 'n2', 'n3'])));
  await page.waitForTimeout(2600);
  // 选中长摘要节点（n2）：面板必然溢出，用来验证 sticky 入口与滚动保持
  await clickSector('demo-repo', 'n2', 1, 3);
  const pane = progressRow.locator('.overview-node');
  // 等点击后的重绘落地（标题切到 n2 且面板确实溢出），再做滚动断言，避免和轮询/rAF 抢时序
  await page.waitForFunction(() => {
    const title = document.querySelector('#progress-list .overview-node-head strong')?.textContent;
    const panel = document.querySelector('#progress-list .overview-node');
    return title === '节点二' && panel && panel.scrollHeight > panel.clientHeight + 4;
  }, null, { timeout: 8000 });
  await pane.evaluate(node => { node.scrollTop = 30; });
  await page.waitForTimeout(120);
  const entryInside = await progressRow.locator('.overview-node [data-serial-node]').first().evaluate(el => {
    const paneEl = el.closest('.overview-node');
    const a = el.getBoundingClientRect(), b = paneEl.getBoundingClientRect();
    return a.bottom <= b.bottom + 1 && a.top >= b.top - 1;
  });
  assert.equal(entryInside, true, 'detail entry stays visible while the panel is scrolled');
  await page.waitForTimeout(2600);
  assert.ok(await pane.evaluate(node => node.scrollTop) > 0, 'panel scroll survives the polling re-render');
  await pane.evaluate(node => { node.scrollTop = 0; });
  // 打开运行详情：走面板里的入口按钮（环形点击只在总览内切换，不跳页）
  await clickSector('demo-repo', 'n2', 1, 3);
  await progressRow.locator('.overview-node [data-serial-node="n2"]').click();
  await page.locator('#view-dag').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#dag-detail .dag-detail').count(), 1);
  assert.equal(await page.locator('#dag-detail .dag-node[data-serial-node]').count(), 3, 'detail uses the same node-card component');
  assert.equal(await page.locator('#dag-detail .run-metrics').count(), 1, 'detail has the same metrics structure as DAG detail');
  const detail = page.locator('#dag-detail #dag-node-detail');
  assert.equal(await detail.locator('h3').innerText(), '节点二');
  assert.ok((await detail.innerText()).includes('正在实现第二块功能'), 'detail shows the task summary');
  assert.ok((await detail.innerText()).includes('联调') && (await detail.innerText()).includes('节点内进度'), 'detail shows part and inner progress');
  assert.ok((await detail.innerText()).includes('费用 / Token'), 'detail shows cost/token column');
  // 无摘要节点（pending）详情必须有兜底文案，不能是空面板
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await clickSector('demo-repo', 'n3', 2, 3);
  await progressRow.locator('.overview-node [data-serial-node="n3"]').click();
  await page.locator('#dag-node-detail').waitFor();
  assert.ok((await page.locator('#dag-node-detail').innerText()).includes('暂无任务摘要'), 'pending node without summary must show a truthful fallback');
  await page.getByRole('button', { name: '总览', exact: true }).click();
  // 失败态：读取失败时保留最后成功数据并提示重试，不把未知当完成
  await page.route('**/api/serial-progress', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
  await page.locator('#refresh').click();
  await page.waitForTimeout(300);
  assert.ok((await page.locator('#progress-state').innerText()).includes('加载失败'), 'progress panel must show an error state');
  assert.ok((await page.locator('#progress-state').innerText()).includes('保留最后成功数据'), 'error state must promise last-good data retained');
  assert.ok(await page.locator('#progress-list .serial-chain-row').count() >= 1, 'a failed refresh must not wipe the last successful chain');
  await page.unroute('**/api/serial-progress');
  await page.locator('#refresh').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#progress-state').isHidden(), true, 'recovered refresh must clear the error state');
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
  await page.getByRole('button', { name: '会话管理', exact: false }).click();
  await page.locator('#session-new').click();
  await page.locator('#new-session-dialog').waitFor({ state: 'visible' });
  await page.locator('#new-session-project').selectOption({ index: 0 }); // 占位项必须被拒绝
  await page.locator('#new-session-request').fill('占位项目测试');
  await page.locator('#create-session').click();
  await page.waitForTimeout(300);
  // 对话框是模态窗：错误必须显示在对话框里、对用户真的可见（页面顶部提示条会被遮住）。
  assert.equal(await page.locator('#new-session-error').isVisible(), true, 'placeholder rejection must be visible inside the modal dialog');
  assert.ok((await page.locator('#new-session-error').innerText()).includes('请先从列表选择'), 'placeholder selection must be rejected before starting a session');
  assert.equal(await page.locator('#session-workspace .run-card.session-card').count(), 1, 'no session must be created for placeholder selection');
  // 同项目同类型已有会话：确认框之前就在对话框里说明冲突，并给出「继续旧会话 / 关闭旧会话并新建」。
  const startsBeforeDuplicate = schedulingSessions.startCalls.length;
  const priorDraft = await page.evaluate(() => document.querySelector('form[data-action="session-message"][data-id="browser-session"] [name="message"]')?.value || '');
  await page.locator('#new-session-project').selectOption(demoRepo);
  await page.locator('#new-session-request').fill('再开一个调度会话看看');
  await page.locator('[data-type-override="scheduling"]').click();
  await page.locator('#create-session').click();
  await page.locator('#new-session-conflict').waitFor({ state: 'visible', timeout: 3000 });
  assert.ok((await page.locator('#new-session-conflict-text').innerText()).includes('已有一个进行中的调度会话'), 'conflict must explain the existing session inside the dialog');
  assert.equal(await page.locator('#conflict-continue').isVisible(), true, 'continue-old-session action must be offered');
  assert.equal(await page.locator('#conflict-replace').isVisible(), true, 'close-and-create action must be offered');
  assert.equal(schedulingSessions.startCalls.length, startsBeforeDuplicate, 'a conflicting request must not start a session or send a first turn');
  await page.locator('#new-session-request').fill('再开一个调度会话看看，改了一个字');
  assert.equal(await page.locator('#new-session-conflict').isHidden(), true, 'editing the request must clear a stale conflict');
  await page.locator('#create-session').click();
  await page.locator('#new-session-conflict').waitFor({ state: 'visible', timeout: 3000 });
  await page.locator('#conflict-continue').click();
  await page.locator('#new-session-dialog').waitFor({ state: 'hidden' });
  // 旧会话输入框里原有的草稿不被覆盖，新写的内容追加在后面。
  const expectedDraft = priorDraft.trim() ? `${priorDraft.trimEnd()}\n\n再开一个调度会话看看，改了一个字` : '再开一个调度会话看看，改了一个字';
  try {
    await page.waitForFunction(expected => document.querySelector('form[data-action="session-message"][data-id="browser-session"] [name="message"]')?.value === expected, expectedDraft, { timeout: 5000 });
  } catch (error) {
    console.log('CONTINUE DIAGNOSTIC:', JSON.stringify(await page.evaluate(() => ({
      view: [...document.querySelectorAll('.view')].find(v => !v.hidden)?.id,
      forms: [...document.querySelectorAll('form[data-action="session-message"]')].map(f => ({ id: f.dataset.id, value: f.elements.message?.value })),
      toast: document.querySelector('#toast')?.textContent,
      notice: document.querySelector('#notice')?.textContent,
    }))));
    throw error;
  }
  assert.equal(schedulingSessions.startCalls.length, startsBeforeDuplicate, 'continuing the old session must not create a new one');
  await page.getByLabel('发消息给会话 browser-session').fill('');
  // 「关闭旧会话并新建」：用同项目的一个设计会话当旧会话（browser-session 后续步骤还要用，不能关）。
  const designOld = { ...schedulingSessions.records[0], id: 'design-old', sessionId: 'acp-design-old', kind: 'design', prompt: '旧的设计会话', messages: [], queue: [], queued: [], queuedCount: 0 };
  schedulingSessions.records.push(designOld);
  const closeCallsOf = id => (schedulingSessions.closeCalls || []).filter(call => call === id).length;
  const originalClose = schedulingSessions.close;
  const originalStart = schedulingSessions.start;
  const callOrder = [];
  schedulingSessions.close = async function (id) { (this.closeCalls ||= []).push(id); callOrder.push(`close:${id}`); return originalClose.call(this, id); };
  // 真实服务端会回传 kind；假管理器默认不回传（既有用例依赖此行为），本段包装里补上，新会话才会落在设计 tab。
  schedulingSessions.start = async function (input) { callOrder.push('start'); const session = await originalStart.call(this, input); if (input?.kind) session.kind = input.kind; return session; };
  const openDesignConflict = async (request, designCount) => {
    await page.getByRole('button', { name: '会话管理', exact: false }).click();
    await page.locator('#refresh').click();
    // 等页面真的拿到含旧会话的列表（refresh 可能与后台 2 秒轮询撞车而空转），而不是固定等 300ms。
    await page.waitForFunction(count => document.querySelector('[data-kind-count="design"]')?.textContent === String(count), designCount, { timeout: 6000 });
    await page.locator('#session-new').click();
    await page.locator('#new-session-dialog').waitFor({ state: 'visible' });
    await page.locator('#new-session-project').selectOption(demoRepo);
    await page.locator('#new-session-request').fill(request);
    await page.locator('[data-type-override="design"]').click();
    await page.locator('#create-session').click();
    await page.locator('#new-session-conflict').waitFor({ state: 'visible', timeout: 3000 });
    assert.ok((await page.locator('#new-session-conflict-text').innerText()).includes('设计会话'), 'design conflict must name the session type');
  };
  // ① 关闭成功、新建失败：旧会话确实被关掉，对话框明说「旧会话已关闭」并保留输入，可重试。
  await openDesignConflict('重新设计一遍计费方案', 1);
  const startsBeforeReplace = schedulingSessions.startCalls.length;
  schedulingSessions.failNextStart = '模拟：Codex 启动失败';
  await page.locator('#conflict-replace').click();
  await page.locator('#new-session-error').waitFor({ state: 'visible', timeout: 5000 });
  const replaceError = await page.locator('#new-session-error').innerText();
  assert.ok(replaceError.includes('旧会话已关闭') && replaceError.includes('模拟：Codex 启动失败'), 'close-ok/create-failed must say the old session is already closed and why creation failed');
  assert.equal(closeCallsOf('design-old'), 1, 'replace must close the old session exactly once');
  assert.equal(schedulingSessions.startCalls.length, startsBeforeReplace + 1, 'replace must attempt exactly one create after closing');
  assert.equal(await page.locator('#new-session-dialog').isVisible(), true, 'a failed create must keep the dialog open');
  assert.equal(await page.locator('#new-session-request').inputValue(), '重新设计一遍计费方案', 'a failed create must keep what the user wrote');
  assert.equal(await page.locator('#new-session-conflict').isHidden(), true, 'the stale conflict must not reappear once the old session is closed');
  await page.locator('#new-session-dialog .js-close-new-session').first().click();
  await page.locator('#new-session-dialog').waitFor({ state: 'hidden' });
  // ② 正常路径：先关旧会话、再新建，新会话被选中，旧会话不再出现在进行中列表。
  // 诱饵：同项目、同类型、排在新会话前面的「关闭中」会话。本地查重跳过 closing，冲突仍指向 design-old；
  // 若新会话没被真正选中，侧栏会回退高亮列表第一项（诱饵），下面的选中断言就会变红。
  schedulingSessions.records.push({ ...designOld, id: 'design-decoy', sessionId: 'acp-design-decoy', status: 'closing', statusText: '关闭中', prompt: '关闭中的设计会话' });
  schedulingSessions.records.push({ ...designOld });
  await openDesignConflict('再设计一遍计费方案', 2);
  assert.ok((await page.locator('#new-session-conflict-text').innerText()).includes('design-o'), 'the conflict must point at the active old session, not the closing decoy');
  acceptDialogs = false;
  await page.locator('#conflict-replace').click();
  await page.waitForTimeout(300);
  assert.equal(closeCallsOf('design-old'), 1, 'cancelling the confirmation must not close the old session');
  assert.equal(await page.locator('#new-session-conflict').isVisible(), true, 'cancelling the confirmation must leave the choice in place');
  acceptDialogs = true;
  const startsBeforeOk = schedulingSessions.startCalls.length;
  callOrder.length = 0;
  schedulingSessions.nextStartId = 'design-new';
  await page.locator('#conflict-replace').click();
  await page.locator('#new-session-dialog').waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal(closeCallsOf('design-old'), 2, 'confirmed replace must close the old session');
  assert.equal(schedulingSessions.startCalls.length, startsBeforeOk + 1, 'confirmed replace must create exactly one new session');
  assert.deepEqual(schedulingSessions.startCalls.at(-1), { prompt: '再设计一遍计费方案', project: demoRepo, kind: 'design' }, 'the new session must carry the dialog request, project and kind');
  assert.deepEqual(callOrder, ['close:design-old', 'start'], 'replace must close the old session before creating the new one');
  assert.equal(schedulingSessions.records.some(session => session.id === 'design-old'), false, 'the old session must be gone from the live list');
  await page.waitForFunction(() => document.querySelector('form[data-action="session-message"][data-id="design-new"]'), null, { timeout: 5000 });
  assert.equal(await page.locator('.session-kind-tabs [data-kind="design"]').getAttribute('aria-selected'), 'true', 'a new design session must land in the design tab');
  assert.deepEqual(await page.locator('#session-items .session-item').evaluateAll(items => items.map(item => item.dataset.session)), ['design-decoy', 'design-new'], 'the decoy must be listed ahead of the new session for the selection check to mean anything');
  assert.equal(await page.locator('#session-items .session-item.active').getAttribute('data-session'), 'design-new', 'the newly created session must be the selected one');
  // 清场：移除本段造的设计会话，切回调度会话，后续步骤照旧使用 browser-session。
  schedulingSessions.records = schedulingSessions.records.filter(session => !['design-new', 'design-decoy'].includes(session.id));
  schedulingSessions.close = originalClose;
  schedulingSessions.start = originalStart;
  await page.locator('[data-kind="scheduling"]').first().click();
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('form[data-action="session-message"][data-id="browser-session"]'), null, { timeout: 5000 });
  await page.getByRole('button', { name: '会话管理', exact: false }).click();
  await page.locator('#session-new').click();
  await page.locator('#new-session-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#new-session-conflict').isHidden(), true, 'reopening the dialog must start without stale feedback');
  await page.locator('#new-session-dialog .js-close-new-session').first().click();
  await page.locator('#new-session-dialog').waitFor({ state: 'hidden' });
  await page.getByLabel('发消息给会话 browser-session').fill('重点看执行轮次');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#session-workspace').innerText.includes('重点看执行轮次'), null, { timeout: 6000 });
  assert.ok((await sessionCard.innerText()).includes('重点看执行轮次'), 'user message must appear in the conversation');
  // 回车必须直接发送（与 Codex 输入体验一致）；Alt/Option+回车必须换行而不是发送
  await page.getByLabel('发消息给会话 browser-session').fill('回车发送测试');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#session-workspace').innerText.includes('回车发送测试'), null, { timeout: 6000 });
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
  // 聊天框文本选定：进行中的文本选区必须跨后台刷新存活（否则无法精确复制）
  await page.getByLabel('发消息给会话 browser-session').fill(''); // 清掉草稿解冻卡片，模拟纯阅读选区场景
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const log = document.querySelector('#session-workspace .session-card .chat-log');
    const bubble = [...log.querySelectorAll('.bubble-text')].pop();
    const range = document.createRange();
    range.setStart(bubble.firstChild, 0);
    range.setEnd(bubble.firstChild, Math.min(6, bubble.firstChild.length));
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.waitForTimeout(2500); // 跨过至少一次 2s 后台刷新
  const selectionAlive = await page.evaluate(() => {
    const selection = document.getSelection();
    return !selection.isCollapsed && !!selection.anchorNode && selection.anchorNode.isConnected;
  });
  assert.equal(selectionAlive, true, 'an in-progress text selection in the chat log must survive background refreshes');
  await page.evaluate(() => document.getSelection().removeAllRanges());

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
  await page.getByRole('button', { name: '补充：先看 NAS 部署', exact: true }).waitFor({ timeout: 5000 });
  schedulingSessions.delayMs = 2300; // 真实网络节奏：打断请求跨过一次 2s 后台刷新
  await msgInput.fill('方向变了，停下');
  const draftNode = await msgInput.elementHandle();
  await page.getByRole('button', { name: '打断', exact: true }).click();
  for (let i = 0; i < 50 && !record.sendCalls?.some(call => call.interrupt); i++) await page.waitForTimeout(200); // 等打断请求送达（含注入延迟）
  assert.ok(record.sendCalls.some(call => call.interrupt), 'interrupt request must reach the session');
  await page.waitForTimeout(2600); // 等响应返回 + 两轮刷新
  assert.deepEqual(record.sendCalls.at(-1), { text: '', interrupt: true }, '打断必须是纯停止：不带草稿文本，Codex 原生 Stop 语义');
  assert.equal(await page.evaluate(node => node.isConnected, draftNode), false, 'card must rebuild during the slow interrupt request (click focuses the button, so the draft does not pin it)');
  assert.equal(await msgInput.inputValue(), '方向变了，停下', 'a pure stop must leave the draft untouched for re-editing');
  schedulingSessions.delayMs = 0;
  record.status = 'running'; record.busy = true; record.statusText = '运行中';
  await msgInput.fill(''); // 清空草稿解冻卡片，让运行中状态与打断按钮渲染出来
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: '打断', exact: true }).focus();
  await page.keyboard.press('Enter'); // 键盘可达性：按钮上的回车保持原生语义，必须是打断而不是发送
  await page.waitForTimeout(300);
  assert.deepEqual(record.sendCalls.at(-1), { text: '', interrupt: true }, 'Enter on the interrupt button must be a pure stop, not a queued send');

  // 队列可见、可 steer in（立即追加发送）、可单条删除（与 Codex 输入体验一致）
  record.status = 'running'; record.busy = true; record.statusText = '运行中';
  record.queue = []; record.queued = []; record.queuedCount = 0; // 隔离前面打断测试遗留的队列状态
  await msgInput.fill(''); // 解冻卡片
  await page.waitForTimeout(2500);
  const queueInput = page.getByLabel('发消息给会话 browser-session');
  await queueInput.fill('队列消息一');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await queueInput.fill('队列消息二');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const chipOne = page.getByRole('button', { name: '队列消息一', exact: true });
  const chipTwo = page.getByRole('button', { name: '队列消息二', exact: true });
  await chipOne.waitFor({ timeout: 5000 });
  await chipTwo.waitFor({ timeout: 5000 });
  await chipTwo.click(); // steer in：原生 steering 注入当前轮（不打断、不新开轮）
  await page.waitForTimeout(600);
  assert.deepEqual(record.steerCalls.map(call => call.text), ['队列消息二'], 'steer in must inject the queued message into the live turn via the steer API');
  assert.deepEqual(record.queue.map(item => item.text), ['队列消息一'], 'steered-in message leaves the queue and enters the live turn');
  assert.equal(await queueInput.inputValue(), '', 'steer in must not touch the input draft');
  // 编辑（行内原位编辑，与 Codex queue_edit 一致）
  await page.getByRole('button', { name: /编辑排队消息 队列消息一/ }).click();
  const editor = page.locator('.queue-editor');
  const editorBox = await editor.boundingBox();
  const cardBox = await page.locator('#session-workspace .session-card .queue-item-editing').boundingBox();
  assert.ok(editorBox.width >= cardBox.width * 0.55, `the queue editor must expand horizontally (>=55% of the row, got ${Math.round(editorBox.width / cardBox.width * 100)}%)`);
  assert.ok(editorBox.height <= 80, `the queue editor height must cap at about 3 lines (<=80px, got ${editorBox.height})`);
  await editor.fill('队列消息一（改）');
  await editor.press('Enter'); // 对齐 Codex queue_edit：编辑框内回车保存（不能误提交主输入框）
  await page.waitForTimeout(600);
  assert.equal(record.editCalls.at(-1).text, '队列消息一（改）', 'Enter in the inline editor must save the queued message edit');
  assert.deepEqual(record.queue.map(item => item.text), ['队列消息一（改）']);
  // 打断 = 纯停止：不带草稿、不动队列，轮次收尾后队列自动续跑（后端 settle 语义，单测覆盖）
  await page.getByRole('button', { name: '打断', exact: true }).click();
  await page.waitForTimeout(600);
  assert.deepEqual(record.sendCalls.at(-1), { text: '', interrupt: true }, 'interrupt must be a pure stop: no draft text, no queued send');
  assert.deepEqual(record.queue.map(item => item.text), ['队列消息一（改）'], 'interrupt must leave the queue untouched for automatic continuation');
  // 重新置为运行中，验证整批清空
  record.status = 'running'; record.busy = true; record.statusText = '运行中';
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: '清空队列', exact: true }).click(); // 确认弹窗由全局 dialog handler 接受
  await page.waitForTimeout(600);
  assert.equal(record.queue.length, 0, 'clear must empty the queue');
  assert.equal(record.clearCalls, 1, 'clear must call the clear API');

  // 会话产物：md/html 直接在会话界面打开查看
  await page.getByRole('button', { name: '产物', exact: true }).click();
  await page.getByRole('button', { name: /调度报告\.md/ }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: /看板\.html/ }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: /调度报告\.md/ }).click(); // md → 客户端渲染
  await page.locator('#artifact-dialog').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('#artifact-title').innerText(), '调度报告.md');
  assert.equal(await page.locator('.md-view h1').innerText(), '调度报告');
  assert.equal(await page.locator('.md-view li strong').innerText(), '事项一');
  assert.equal(await page.locator('.md-view a[href^="javascript:"]').count(), 0, 'javascript: links in artifacts must be neutralized to text');
  assert.equal(await page.locator('.md-view a[href="https://example.com"]').count(), 1, 'https links in artifacts must stay clickable');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('#artifact-dialog').waitFor({ state: 'hidden', timeout: 5000 });
  await page.getByRole('button', { name: /看板\.html/ }).click(); // html → sandbox iframe
  await page.locator('#artifact-dialog').waitFor({ state: 'visible', timeout: 5000 });
  const frame = page.locator('.artifact-frame');
  assert.equal(await frame.getAttribute('sandbox'), '', 'HTML artifacts must render in a sandboxed iframe');
  await page.waitForTimeout(300); // 若 sandbox 失效，srcdoc 内脚本会标记父文档
  assert.equal(await page.evaluate(() => document.documentElement.dataset.pwned), undefined, 'scripts inside artifact HTML must never run in the console origin');
  errors.length = 0; // Chrome 为被 sandbox 拦截的脚本记录 console error，属于本负向测试的预期噪音
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.locator('#session-items').getByText('还没有该类型的会话').waitFor();
  // 已归档与历史：默认折叠；查看进入右侧工作区（只读），恢复生成新会话
  assert.equal(await page.locator('#archived-entries').isHidden(), true, 'archived history must be collapsed by default');
  await page.getByRole('button', { name: /已归档与历史/ }).click();
  const archivedEntry = page.locator('.archived-entry').filter({ hasText: 'deadbeef' });
  await archivedEntry.getByRole('button', { name: '查看', exact: true }).click();
  const archivedCard = page.locator('#session-workspace .run-card.archived');
  await archivedCard.waitFor();
  assert.ok((await archivedCard.innerText()).includes('被重启中断'), 'archived sessions show why they stopped');
  assert.ok((await archivedCard.innerText()).includes('上次看到一半的计划'), 'archived transcripts stay readable');
  await archivedCard.getByRole('button', { name: '继续调度', exact: true }).click();
  await page.locator('#session-workspace .run-card.session-card').filter({ hasText: '项目 · demo-repo' }).waitFor();
  assert.ok(await archivedEntry.count() >= 1, 'the archive entry stays after continuing');
  await archivedEntry.getByRole('button', { name: '查看', exact: true }).click();
  const archiveLog = page.locator('#session-workspace .run-card.archived .chat-log').first();
  await archiveLog.waitFor();
  // 读写转录框必须在页面内一次同步完成：后台每 2 秒整张替换归档卡（再写回滚动位置），
  // locator.evaluate 先定位、后执行，两步之间撞上替换就会读到已摘除的旧框（scrollTop 恒为 0）或写进旧框（丢失）。
  // op：'read' 读位置；'quarter' 滚到明确不贴底的 1/4 处（短转录贴底会被「停在最新」合法重置）；'bottom' 滚到底；'atBottom' 是否贴底
  const archiveScroll = op => page.evaluate(op => {
    const node = document.querySelector('#session-workspace .run-card.archived .chat-log');
    if (!node) throw new Error('归档转录框不存在');
    const max = node.scrollHeight - node.clientHeight;
    if (op === 'quarter') { const top = Math.min(Math.max(1, Math.floor(max * 0.25)), Math.max(0, max - 1)); node.scrollTop = top; return { top, max }; }
    if (op === 'bottom') { node.scrollTop = node.scrollHeight; return node.scrollTop; }
    if (op === 'atBottom') return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
    if (op === 'read') return node.scrollTop;
    throw new Error(`未知的 archiveScroll 操作：${op}`);
  }, op);
  const scrollTarget = await archiveScroll('quarter');
  assert.ok(scrollTarget.max > 4, 'archived transcript must be scrollable to verify scroll survival');
  await page.waitForTimeout(4500); // 跨过后台刷新周期
  assert.equal(await archiveScroll('read'), scrollTarget.top, 'archived transcript scroll position must survive background refreshes');
  // 视图切换：离开再回来后转录框必须停在最新消息（隐藏视图零尺寸不能被误判为底部而重置）
  await archiveScroll('bottom');
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.waitForTimeout(4500); // 隐藏期间跨多次后台刷新
  await page.getByRole('button', { name: '会话管理', exact: false }).click();
  await page.waitForTimeout(400);
  const atBottom = await archiveScroll('atBottom');
  assert.equal(atBottom, true, 'returning to the sessions view must land the transcript at the latest message, not the top');
  // 已归档视图只读、没有关闭入口：先选中「继续调度」生成的活动会话，再关闭它
  await page.locator('#session-items .session-select').first().click();
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.locator('#session-items').getByText('还没有该类型的会话').waitFor();
  // 设备授权管理后台：生成真实二维码 → 解码校验 → 设备端提交绑定 → 查看 → 解除 → 审计。
  // 网页只负责出码与展示；绑定必须由设备端提交（网页不得消耗一次性码或丢弃设备凭证）。
  await page.locator('.header-actions [data-go="devices"]').click();
  await page.getByRole('heading', { name: '设备授权管理' }).waitFor();
  await page.locator('#device-list .empty').waitFor();
  assert.equal(await page.locator('#device-list .empty').isVisible(), true, 'device list starts empty');
  await page.getByRole('button', { name: '生成一次性二维码' }).click();
  const grid = page.locator('#device-qr .qr-grid');
  await grid.waitFor();
  const qrSize = Number(await grid.getAttribute('data-size'));
  const qrFlags = await grid.locator('span').evaluateAll(flags => flags.map(flag => flag.classList.contains('on')));
  assert.equal(qrFlags.length, qrSize * qrSize, 'QR DOM matrix is complete');
  const decoded = decodeQr(Array.from({ length: qrSize }, (_, y) => qrFlags.slice(y * qrSize, (y + 1) * qrSize)));
  assert.match(decoded, /^autoloop:\/\/bind\?token=[0-9a-f]{64}$/, 'rendered QR decodes to a real bind payload');
  const qrToken = decoded.slice('autoloop://bind?token='.length);
  assert.equal(await page.locator('#device-bind-submit').count(), 0, 'web must not expose a button that consumes the one-time code');

  // 模拟设备端扫码：用一次性码向服务端换取设备凭证，凭证由设备自己持有。
  const bindResponse = await fetch(`${url}/api/devices/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-request': '1' },
    body: JSON.stringify({ token: qrToken, name: 'Browser Test Phone', platform: 'Android' }),
  });
  assert.equal(bindResponse.status, 201, 'device-side bind succeeds');
  const bound = await bindResponse.json();
  assert.match(bound.deviceToken, /^[0-9a-f]{64}$/, 'device holds its own credential returned to the device');

  await page.locator('#device-refresh').click();
  const deviceRow = page.locator('#device-list .list-row').filter({ hasText: 'Browser Test Phone' });
  await deviceRow.waitFor();
  assert.ok((await deviceRow.innerText()).includes('已授权'), 'bound device shows authorized status');
  assert.equal(await page.locator('#device-qr').isHidden(), true, 'QR is cleared once the device consumed the code');
  const deviceViewText = await page.locator('#view-devices').innerText();
  assert.ok(!deviceViewText.includes(qrToken), 'binding code must not linger in the management page');
  assert.ok(!/tokenHash|deviceToken|server-secret/.test(deviceViewText), 'page must not expose keys or device credentials');
  assert.ok((await page.locator('#device-audit').innerText()).includes('绑定设备'), 'bind is audited');
  await deviceRow.getByRole('button', { name: '解除授权' }).click();
  await page.locator('#device-list .list-row').filter({ hasText: 'Browser Test Phone' }).getByText('已解除').waitFor();
  assert.ok((await page.locator('#device-audit').innerText()).includes('解除授权'), 'revoke is audited');
  assert.equal(await page.locator('#device-qr-token').count(), 0, 'no binding code is rendered after revoke');
  await page.screenshot({ path: path.join(output, 'console-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const paths = hub.requests.map(request => request.url);
  for (const expected of ['/v1/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/pause', '/v1/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/resume', '/v1/rules/%E6%81%A2%E5%A4%8D%E6%B5%8B%E8%AF%95/run', '/v1/runs/3/cancel', '/v1/cards/9/answer', '/v1/cards/10/resolve']) assert.ok(paths.includes(expected), expected);
  console.log('PASS browser: overview, run/pause/resume, cancel, card answer, mobile rule form, no console errors');
} finally {
  if (context) await context.close(); await close(consoleServer); await close(hub.server); rmSync(root, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
}
