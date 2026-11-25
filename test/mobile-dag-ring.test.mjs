// dag-ring 节点（Spec §8.2 / 计划 2026-11-18-mobile-device-admin §dag-ring）边界测试：
// 环形进度图与节点详情的服务端模型 + 移动端只读视图模型。
// 覆盖：环与现有 DAG 基线一一对应、波次/槽位/费用/证据/节点详情如实、点击节点看契约与证据、
// DAG 数据缺失显示空态且不用串行链条替代、旧授权 digest/schema1 只读不改。
// 不调用真实模型、不操作真实规则；全部为纯函数，可在 Node 里直接做边界测试。
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
import { buildDagRing } from '../src/dag-model.mjs';
import { mobileDagSummaries } from '../src/dag-service.mjs';
import {
  buildDagRingView, selectRing, buildNodeDetailView, RING_TASK_PREFIX,
} from '../mobile/src/features/dag-ring/index.mjs';

const planNodes = [
  { id: 'a', title: '账户', depends_on: [], contract: {
    input: 'Spec §8.2、账户需求', output: '账户表', error_behavior: '失败保留原状态',
    acceptance_example: '生成账户表', files: ['src/a.mjs'],
  } },
  { id: 'b', title: '计费', depends_on: ['a'], contract: {
    input: '计费需求', output: '计费规则', error_behavior: '失败不扣费',
    acceptance_example: '计费正确', files: [],
  } },
  { id: 'c', title: '审计', depends_on: ['a'], contract: {
    input: '审计需求', output: '审计日志', error_behavior: '失败不丢日志',
    acceptance_example: '审计可查', files: [],
  } },
];
const run = {
  runId: 'dagrun-r1', nodeId: '__root__', project: '/work/demo', planId: 'demo-plan',
  status: 'claimed', createdAt: '2026-11-19T09:00:00+08:00',
  authorizationSnapshot: { schema: 1, planDigest: 'f'.repeat(64), allowedActions: ['worktree'], digest: 'e'.repeat(64) },
  nodes: planNodes,
  publish: { nodes: {
    a: { state: 'accepted', slot: 1, branch: 'feat/a', model: 'K3', mergeCommit: 'abc123' },
    b: { state: 'dev', slot: 2 },
    c: { state: 'blocked', slot: null, blockedReason: 'blocked_unknown' },
  } },
  prs: [{ prUrl: 'https://example.com/pr/9', nodeId: 'a', state: 'merged' }],
};
const nodeRuns = [
  { runId: 'n1', nodeId: 'a', role: 'dev', status: 'done', agent: 'Codex', usage: { cost: 1, input: 50, output: 20 } },
  { runId: 'n2', nodeId: 'b', role: 'dev', status: 'claimed', slot: 2, agent: 'Workbuddy', usage: { cost: 0.5, input: 10, output: 5 } },
];
const withSummary = { ...run, mobileSummary: mobileDagSummaries([run], nodeRuns)[0] };

// ---------------------------------------------------------------------------
// RED 1：服务端环模型——环/波次与现有 DAG 基线一一对应，槽位/费用/证据/节点详情如实
// ---------------------------------------------------------------------------
test('buildDagRing：节点一段、波次来自依赖、完成度计入节点内进度；槽位/分支/PR/模型如实', () => {
  const ring = buildDagRing(run, nodeRuns);
  assert.equal(ring.runId, 'dagrun-r1');
  assert.equal(ring.ring.segments, 3);
  assert.equal(ring.ring.percent, 57, 'a=1,b=dev=.5,c=blocked=.2 → 1.7/3≈57%');
  assert.match(ring.ring.gradient, /^conic-gradient\(/);
  assert.deepEqual(ring.waves.map(w => w.nodes.map(n => n.id)), [['a'], ['b', 'c']]);
  const a = ring.nodes.find(n => n.id === 'a');
  assert.equal(a.slot, 1);
  assert.equal(a.branch, 'feat/a');
  assert.equal(a.mergeCommit, 'abc123');
  assert.equal(a.prUrl, 'https://example.com/pr/9');
  assert.equal(a.agent, 'Codex');
  assert.equal(a.model, 'K3');
  assert.match(a.contract.output, /账户表/);
  assert.ok(a.evidence.some(e => e.value === 'https://example.com/pr/9'), '证据含 PR');
  const c = ring.nodes.find(n => n.id === 'c');
  assert.match(c.summary, /阻塞/);
});

test('buildDagRing：汇总节点数/完成数/占用槽位与用量文案，全部来自真实字段', () => {
  const ring = buildDagRing(run, nodeRuns);
  assert.equal(ring.summary.nodeCount, 3);
  assert.equal(ring.summary.doneCount, 1);
  assert.equal(ring.summary.slotsUsed, 1);
  assert.match(ring.summary.usageText, /费用 \$1\.50/);
});

// run 级汇总：App 运行详情头卡（对齐网页版详卡）需要本次运行费用与 PR 列表。
test('mobileDagSummaries：带出 run 级 usageText 汇总与 prs 清单，供 App 运行详情头卡使用', () => {
  assert.match(withSummary.mobileSummary.usageText, /费用 \$1\.50/, 'run 级费用为全部节点 run 之和');
  assert.match(withSummary.mobileSummary.usageText, /Token 85/, '50+20+10+5=85');
  assert.deepEqual(withSummary.mobileSummary.prs, [{ nodeId: 'a', prUrl: 'https://example.com/pr/9' }]);
});

test('buildDagRing：无节点给明确空环，不用串行链条替代、不编造进度', () => {
  const ring = buildDagRing({}, []);
  assert.deepEqual(ring.ring, { segments: 0, percent: 0, gradient: '' });
  assert.equal(ring.empty, true);
  assert.match(ring.emptyReason, /缺失/);
  assert.deepEqual(ring.waves, []);
});

// ---------------------------------------------------------------------------
// RED 2：服务端接线——mobileSummary 注入 ring，但 schema1/digest 只读原样保留
// ---------------------------------------------------------------------------
test('mobileDagSummaries：注入 ring，授权/digest 字段与不注入时逐字一致', () => {
  const base = mobileDagSummaries([run])[0];
  const injected = mobileDagSummaries([run], nodeRuns)[0];
  assert.equal(injected.ring.ring.segments, 3);
  for (const key of ['planDigest', 'allowedActions', 'deniedActions', 'authorizationPresent', 'remoteUrl']) {
    assert.deepEqual(injected[key], base[key], `${key} 不得被环形模型改动`);
  }
  assert.equal(run.authorizationSnapshot.schema, 1);
  assert.equal(run.authorizationSnapshot.digest, 'e'.repeat(64), '旧 run 的 schema1 digest 原样保留');
});

// ---------------------------------------------------------------------------
// RED 3：移动端只读视图——按项目+planId 成环取最新 run、空态、切换节点详情
// ---------------------------------------------------------------------------
test('buildDagRingView：同任务多次运行只成一个环（取最新 run），环与基线一致', () => {
  const at = (runId, createdAt) => {
    const one = { ...run, runId, createdAt };
    return { ...one, mobileSummary: mobileDagSummaries([one], nodeRuns)[0] };
  };
  const older = at('dagrun-r0', '2026-11-18T09:00:00+08:00');
  const current = at('dagrun-r1', '2026-11-19T09:00:00+08:00');
  const newer = at('dagrun-r2', '2026-11-19T12:00:00+08:00');
  const view = buildDagRingView({ available: { 'dag-runs': true }, errors: {}, dagRuns: [older, current, newer] });
  assert.equal(view.rings.items.length, 1);
  const card = view.rings.items[0];
  assert.equal(card.taskId, `${RING_TASK_PREFIX}/work/demo:demo-plan`);
  assert.equal(card.runId, 'dagrun-r2', '取最新一次运行');
  assert.equal(card.ring.percent, 57);
  assert.equal(card.projectLabel, 'demo');
  assert.equal(card.selected, false);
});

test('buildDagRingView：DAG 数据缺失显示明确空态，绝不用串行链条替代', () => {
  const view = buildDagRingView({ available: { 'dag-runs': false }, errors: { 'dag-runs': 'DAG 数据缺失，未读取到项目 DAG 进度' }, dagRuns: null });
  assert.equal(view.rings.empty, true);
  assert.equal(view.rings.items.length, 0);
  assert.match(view.rings.reason, /DAG 数据缺失/);
  // 即便混入一条没有 ring 的旧数据，也不凭空造环
  const noRing = buildDagRingView({ available: { 'dag-runs': true }, errors: {}, dagRuns: [{ runId: 'r', nodes: [] }] });
  assert.equal(noRing.rings.empty, true);
});

test('selectRing：切换选中环只改选中态，节点明细可点击查看契约与证据', () => {
  const view = buildDagRingView({ available: { 'dag-runs': true }, errors: {}, dagRuns: [withSummary] });
  const taskId = view.rings.items[0].taskId;
  const selected = selectRing(view, taskId);
  assert.equal(selected.selectedId, taskId);
  assert.equal(selected.selected.taskId, taskId);
  assert.equal(view.selectedId, null, '不可变：原视图不被改写');

  const node = selected.selected.nodes.find(n => n.id === 'a');
  const detail = buildNodeDetailView(node);
  assert.deepEqual(detail.contract.map(row => row.label), ['输入', '输出', '异常行为', '验收示例']);
  assert.match(detail.contract.find(row => row.label === '输入').value, /账户需求/);
  assert.ok(detail.evidence.some(row => row.value === 'https://example.com/pr/9'));
  assert.ok(detail.evidence.every(row => typeof row.value === 'string'), '全部证据为可安全渲染的纯字符串');
});

// ---------------------------------------------------------------------------
// RED 4：浏览器回归——环渲染（中心进度/波次/节点）、点节点看契约、切项目同步过滤
// ---------------------------------------------------------------------------
const browserSkip = (() => {
  try {
    return existsSync(chromium.executablePath())
      ? false
      : 'npm test 阶段未安装 Playwright Chromium，跳过浏览器回归';
  } catch {
    return '无法探测 Playwright Chromium，跳过浏览器回归';
  }
})();

test('浏览器：DAG 环中心进度与节点契约、切项目后各页同步过滤', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-dag-filter-'));
  const profile = mkdtempSync(path.join(tmpdir(), 'mobile-dag-filter-profile-'));
  const projectA = path.join(root, 'proj-alpha');
  const projectB = path.join(root, 'proj-beta');
  mkdirSync(path.join(projectA, '.git'), { recursive: true });
  mkdirSync(path.join(projectB, '.git'), { recursive: true });

  const hubState = { runs: [], cards: [], lines: [], spending: { today: {} } };
  const hub = await fakeHub((req, res) => {
    if (req.url === '/v1/state') return json(res, hubState);
    return json(res, { ok: true });
  });
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({
    sources: {}, agents: { codex: { name: 'Codex', use: 'acp', access: 'edit' } },
    rules: [{ name: 'A 计划', when: { cron: '*/10 * * * *' }, to: 'codex', cwd: projectA, prompt: '推进' }, { name: 'B 计划', when: { cron: '*/10 * * * *' }, to: 'codex', cwd: projectB, prompt: '推进' }],
  }));

  const mkRun = (runId, project, planId, nodeId) => ({
    runId, nodeId: '__root__', project, planId, status: 'running',
    createdAt: '2026-11-20T09:00:00+08:00',
    authorizationSnapshot: { schema: 2, planDigest: 'a'.repeat(64), allowedActions: ['worktree'], deniedActions: ['deploy'] },
    nodes: [{
      id: nodeId, title: `${nodeId} 标题`, depends_on: [], contract: {
        input: `${nodeId} 输入需求`, output: `${nodeId} 输出`,
        error_behavior: `${nodeId} 失败保留状态`, acceptance_example: `${nodeId} 验收示例`,
      },
    }],
    publish: { nodes: { [nodeId]: { state: 'accepted', slot: 1, branch: `feat/${nodeId}`, model: 'K3', mergeCommit: 'abc123' } } },
  });
  const rootA = mkRun('dagrun-alpha', projectA, 'plan-a', 'node-a');
  const rootB = mkRun('dagrun-beta', projectB, 'plan-b', 'node-b');
  const nodeRunA = { runId: 'n-a', nodeId: 'node-a', project: projectA, planId: 'plan-a', role: 'dev', status: 'done', agent: 'Codex', usage: { cost: 1 } };
  const nodeRunB = { runId: 'n-b', nodeId: 'node-b', project: projectB, planId: 'plan-b', role: 'dev', status: 'done', agent: 'Codex', usage: { cost: 1 } };
  const sessionsFake = {
    async list() { return [
      { id: 'session-a', kind: 'normal', project: projectA, prompt: '项目 A 会话', status: 'idle', messages: [], createdAt: '2026-11-20T09:00:00Z', updatedAt: '2026-11-20T09:00:00Z' },
      { id: 'session-b', kind: 'normal', project: projectB, prompt: '项目 B 会话', status: 'idle', messages: [], createdAt: '2026-11-20T09:00:00Z', updatedAt: '2026-11-20T09:00:00Z' },
    ]; },
    async listArchived() { return []; },
  };
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, rulesFile, deviceAuth,
    projectRoots: [projectA, projectB],
    dagService: createDagService({ root, store: { listRuns: () => [rootA, rootB, nodeRunA, nodeRunB] } }),
  }, sessionsFake);
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
      async get() { return stored; }, async set(value) { stored = value; }, async remove() { stored = null; },
    };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  await page.locator('#bind-payload').fill(qr.qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#connection-status')?.getAttribute('aria-label')?.includes('已安全连接'));

  // 头部全局筛选：「全部」+ 两个真实项目，挂载在 scaffold 预留点。
  await page.waitForFunction(() => document.querySelectorAll('#project-filter option').length >= 3);
  const options = await page.locator('#project-filter option').evaluateAll(list => list.map(o => o.value));
  assert.equal(options.length, 3);
  assert.equal(options[0], '全部');

  await page.evaluate(() => window.AutoloopNav.selectTab('dag')); // DAG 不再是 Tab，经路由进入
  await page.waitForFunction(() => document.querySelectorAll('#page-dag [data-ring-task-id]').length === 2);
  const ring = page.locator('#page-dag [data-ring-task-id]').first();
  assert.match(await ring.locator('.dag-ring-grad').getAttribute('style'), /conic-gradient/);
  assert.match(await ring.locator('.dag-ring-center').innerText(), /%/);
  assert.match(await ring.innerText(), /node-a/);

  // 点环 → 点节点看契约四段（输入/输出/异常行为/验收示例）。
  await ring.click();
  await page.waitForFunction(() => Boolean(document.querySelector('#page-dag [data-node-id]')));
  await page.locator('#page-dag [data-node-id]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('#page-dag [data-contract-key]').length >= 4);
  const detail = await page.locator('#page-dag .dag-node-detail').innerText();
  for (const label of ['输入', '输出', '异常行为', '验收示例']) assert.match(detail, new RegExp(label));
  assert.match(detail, /node-a 输入需求/);

  // 切项目：订阅页面收到广播，DAG 页只显示该项目的环。
  await page.evaluate(() => {
    window.__filterEvents = [];
    window.AutoloopHooks.projectFilter.onChange(f => window.__filterEvents.push(f.selectedId));
  });
  await page.locator('#project-filter').selectOption(projectB);
  await page.waitForFunction(() => document.querySelectorAll('#page-dag [data-ring-task-id]').length === 1);
  assert.equal(await page.locator('#page-dag [data-ring-task-id]').first().getAttribute('data-project'), projectB);
  assert.equal(await page.locator('#project-filter option:checked').innerText(), 'proj-beta');
  assert.equal(await page.locator('#clear-project-filter').isVisible(), false, '重置走同一个下拉的全部选项，不再画第二个按钮');
  await page.locator('[data-tab="core"]').click();
  await page.waitForTimeout(150);
  const scopedProjects = await page.locator('[data-core-section="projects"]').innerText();
  assert.match(scopedProjects, /proj-beta/);
  assert.doesNotMatch(scopedProjects, /proj-alpha/);
  await page.locator('[data-tab="rules"]').click();
  await page.waitForTimeout(150);
  const scopedRules = await page.locator('[data-core-section="rules"]').innerText();
  assert.match(scopedRules, /B 计划/);
  assert.doesNotMatch(scopedRules, /A 计划/);
  await page.locator('[data-tab="sessions"]').click();
  await page.waitForTimeout(150);
  const scopedSessions = await page.locator('#page-sessions').innerText();
  assert.match(scopedSessions, /项目 B 会话/);
  assert.doesNotMatch(scopedSessions, /项目 A 会话/);
  assert.deepEqual(await page.evaluate(() => window.__filterEvents.at(-1)), projectB);
  assert.equal(await page.evaluate(() => window.AutoloopHooks.projectFilter.current().selectedId), projectB);
  assert.deepEqual(pageErrors, []);
});

// 总览活跃 DAG 交互环（2026-11-25 用户定）：环渲染扇区、点节点膨出节点卡（干嘛的）、
// 查看详情跳 DAG 页选中该环与节点；已完成 DAG 收进「已归档」折叠区。
test('浏览器：总览活跃环点节点膨出说明、详情跳 DAG 页；已完成 DAG 折叠进已归档', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-dagov-'));
  const projectA = path.join(root, 'proj-alpha');
  const projectB = path.join(root, 'proj-beta');
  mkdirSync(path.join(projectA, '.git'), { recursive: true });
  mkdirSync(path.join(projectB, '.git'), { recursive: true });
  const hub = await fakeHub((req, res) => json(res, { runs: [], cards: [], lines: [], spending: { today: {} } }));
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const mkRun = (runId, project, planId, nodeId, status) => ({
    runId, nodeId: '__root__', project, planId, status,
    createdAt: '2026-11-20T09:00:00+08:00',
    authorizationSnapshot: { schema: 2, planDigest: 'a'.repeat(64), allowedActions: ['worktree'], deniedActions: ['deploy'] },
    nodes: [{ id: nodeId, title: `${nodeId} 标题`, depends_on: [], contract: { input: `${nodeId} 输入`, output: `${nodeId} 输出`, error_behavior: '保留', acceptance_example: '验收' } }],
    publish: { nodes: { [nodeId]: { state: status === 'done' ? 'accepted' : 'dev', slot: 1 } } },
  });
  const rootA = mkRun('dagrun-live', projectA, 'plan-a', 'node-a', 'running');
  const rootB = mkRun('dagrun-dead', projectB, 'plan-b', 'node-b', 'done');
  const sessionsFake = { async list() { return []; }, async listArchived() { return []; } };
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, rulesFile, deviceAuth,
    projectRoots: [projectA, projectB],
    dagService: createDagService({ root, store: { listRuns: () => [rootA, rootB] } }),
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
  page.on('pageerror', e => console.log('PAGE_ERROR', e.message.slice(0, 200)));
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

  // 活跃环卡片渲染：SVG 扇区数 = 节点数，中心有总进度。
  const ringCard = page.locator('.dagov-card[data-dagov-run="dagrun-live"]');
  await ringCard.waitFor({ timeout: 6000 });
  assert.equal(await ringCard.locator('.dagov-seg').count(), 1, '一个节点一个扇区');
  assert.match(await ringCard.innerText(), /总进度/);
  // 活跃节点带箭头（未完成节点）。
  assert.equal(await ringCard.locator('polygon').count(), 1, '进行中节点的箭头标记');

  // 点节点 → 膨出节点卡：标题 + 状态（干嘛的摘要缺失时至少有标题与状态，不编造）。
  await ringCard.locator('.dagov-seg').first().dispatchEvent('click'); // SVG path 的可见性判定不稳定，直接派发点击
  const nodeCard = ringCard.locator('.dagov-node-card');
  await nodeCard.waitFor({ timeout: 4000 });
  assert.match(await nodeCard.innerText(), /node-a 标题/);
  assert.match(await nodeCard.innerText(), /已完成|进行中|排队中|未知|开发中|待派发/);

  // 查看详情 → DAG 页选中该环与节点，节点契约可见。
  await nodeCard.getByRole('button', { name: /查看详情/ }).click();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.querySelector('#app-main')?.dataset.activeTab), 'dag', '应切到 DAG 页');
  await page.waitForFunction(() => {
    const pressed = document.querySelector('#page-dag .dag-node[aria-pressed="true"]');
    return pressed && pressed.textContent.includes('node-a');
  }, null, { timeout: 6000 });
  const dagText = await page.locator('#page-dag .dag-detail').innerText();
  assert.match(dagText, /node-a 输入/, 'DAG 页节点契约（输入）可见');

  // 已完成 DAG 不在活跃环里，收进「已归档」折叠区。
  await page.evaluate(() => window.AutoloopNav.selectTab('core'));
  const archived = page.locator('.dagov-archived');
  await archived.waitFor({ timeout: 4000 });
  assert.match(await archived.locator('.dagov-archived-toggle').innerText(), /已归档（1）/);
  assert.equal(await archived.locator('.dagov-archived-body .core-item').count(), 1, '归档区内一条（已完成 DAG）');
  assert.equal(await archived.locator('.dagov-archived-body').isHidden(), true, '默认折叠');
  await archived.locator('.dagov-archived-toggle').click();
  assert.match(await archived.locator('.dagov-archived-body').innerText(), /dagrun-dead|proj-beta/);
});

// fix4 回归（2026-11-25）：#316 重写总览时误删 #315 的串行链详情入口与无活跃链空态——
// 视图模型仍在产出 chainEntry/chainDetail/serialNote，页面却不渲染。此处做整页防回归。
test('浏览器：总览串行链条目渲染详情入口与节点清单，活跃链不误报空态（fix4）', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-serial-entry-'));
  const projectA = path.join(root, 'proj-alpha');
  mkdirSync(path.join(projectA, '.git'), { recursive: true });
  // 真实 /api/serial-progress 形状：current 是节点对象、nodes 带 kind/percent。
  writeFileSync(path.join(root, 'alpha-serial.json'), JSON.stringify({
    project: projectA,
    lastEventAt: '2026-11-25T10:00:00+08:00',
    plan: ['n1', 'n2'],
    nodes: {
      n1: { title: '需求确认', status: 'done', summary: '已确认' },
      n2: { title: '开发实现', status: 'in_progress', summary: '开发中' },
    },
  }));
  const hub = await fakeHub((req, res) => json(res, { runs: [], cards: [], lines: [], spending: { today: {} } }));
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const sessionsFake = { async list() { return []; }, async listArchived() { return []; } };
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, rulesFile, deviceAuth,
    projectRoots: [projectA],
    dagService: createDagService({ root, store: { listRuns: () => [] } }),
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
  page.on('pageerror', e => console.log('PAGE_ERROR', e.message.slice(0, 200)));
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

  // 串行链条目在活跃区，带「串行链详情」入口（#316 误删的正是这个按钮）。
  const row = page.locator('.core-item[data-project-run="alpha-serial.json"]');
  await row.waitFor({ timeout: 6000 });
  const toggle = row.locator('[data-chain-entry="alpha-serial.json"]');
  await toggle.waitFor({ timeout: 4000 });
  assert.match(await toggle.innerText(), /串行链详情/);
  // 点开详情：整体进度 + 节点清单 + 当前环节（真实 API 的 current 是节点对象）。
  await toggle.click();
  const panel = row.locator('[data-chain-detail="alpha-serial.json"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-chain-detail="alpha-serial.json"]');
    return el && !el.hidden && el.textContent.includes('需求确认');
  }, null, { timeout: 4000 });
  const detailText = await panel.innerText();
  assert.match(detailText, /整体进度 65%/);
  assert.match(detailText, /需求确认/);
  assert.match(detailText, /开发实现/);
  assert.match(detailText, /当前环节/, '当前节点必须标注（current 为节点对象也要认）');
  // 有活跃链时不显示「暂无活跃串行链」空态。
  assert.equal(await page.locator('[data-serial-note]').count(), 0, '有活跃串行链时不显示空态');
});
