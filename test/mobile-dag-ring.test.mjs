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
    rules: [{ name: 'A 计划', when: { cron: '*/10 * * * *' }, to: 'codex', cwd: projectA, prompt: '推进' }],
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
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, rulesFile, deviceAuth,
    projectRoots: [projectA, projectB],
    dagService: createDagService({ root, store: { listRuns: () => [rootA, rootB, nodeRunA, nodeRunB] } }),
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
  assert.deepEqual(await page.evaluate(() => window.__filterEvents.at(-1)), projectB);
  assert.equal(await page.evaluate(() => window.AutoloopHooks.projectFilter.current().selectedId), projectB);
  assert.deepEqual(pageErrors, []);
});
