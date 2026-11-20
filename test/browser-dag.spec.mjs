// DAG 生产 UI 浏览器验收：授权范围确认 → 创建 → 总览分组/详情，桌面 1440×900 与移动 390×844。
// 使用真实 dagService + 临时 Git 仓库 + 假 Hub，不调用任何真实模型。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { createDagService } from '../src/dag-service.mjs';
import { createRunStore } from '../src/dag-run.mjs';
import { createPlanDigest } from '../src/vibe-plan.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

// 预检需要的能力记录：vibe 5.2.7 `vibe attest` 真实写出的形态（测试夹具，非控制台代写）。
function attestRecord() {
  return {
    adapter_id: 'codex',
    facts: {
      'codex.agent': true, 'codex.shell': true, 'codex.subprocess': true, 'codex.worktree': true,
      'codex.visible_task.create': false, 'codex.visible_task.enter': false,
      'codex.visible_task.resume': false, 'codex.visible_task.wait': false,
      'codex.in_session_sdd': true,
    },
    observed_at: new Date().toISOString(),
    provenance: 'browser spec fixture',
    schema_version: 1,
    session_id: 'browser-spec',
  };
}

const root = mkdtempSync(path.join(tmpdir(), 'dag-ui-data-'));
const profile = mkdtempSync(path.join(tmpdir(), 'dag-ui-profile-'));
const project = path.join(root, 'demo-repo'); mkdirSync(path.join(project, '.git'), { recursive: true });
const XSS = '<img src=x onerror="window.__xss=1">恶意标题';
const nodes = [
  { id: 'a', title: '账户模型', depends_on: [], contract: { input: 'i', output: '租户账户表', error_behavior: 'e', acceptance_example: 'x', files: ['src/a.mjs'] } },
  { id: 'b', title: XSS, depends_on: ['a'], contract: { input: 'i', output: '计费规则', error_behavior: 'e', acceptance_example: 'x', files: ['src/b.mjs'] } },
  { id: 'c', title: '审计日志', depends_on: ['a'], contract: { input: 'i', output: '审计', error_behavior: 'e', acceptance_example: 'x', files: ['src/c.mjs'] } },
  { id: 'integration-review', title: '整合审查', depends_on: ['b', 'c'], contract: { input: 'i', output: '只读审查', error_behavior: 'e', acceptance_example: 'x', files: [] } },
];
const dir = path.join(project, '.vibe', 'plans', 'plan-one'); mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ plan_id: 'plan-one', complexity_band: 'complex', decisions: [] }));
writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify(nodes));
writeFileSync(path.join(dir, 'product-spec.input.json'), JSON.stringify({ decisions: [] }));
const planDigest = createPlanDigest({ productSpec: { decisions: [] }, plan: { plan_id: 'plan-one', complexity_band: 'complex', decisions: [] }, nodes });
// 预检需要的 vibe 状态：初始化 + 真实 attest 形态的能力记录（测试夹具，非控制台代写）。
mkdirSync(path.join(project, '.vibe'), { recursive: true });
writeFileSync(path.join(project, '.vibe', 'state.json'), JSON.stringify({ workflow_version: 4, execution_mode: 'sdd_first', session_gate: 's0_required', capability_contract_required: true }));
mkdirSync(path.join(project, '.vibe', 'provider-actions'), { recursive: true });
writeFileSync(path.join(project, '.vibe', 'provider-actions', 'capabilities-codex.json'), JSON.stringify(attestRecord()));
writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ rules: [] }));

const store = createRunStore({ directory: path.join(root, 'dag-runs') });
const dagService = createDagService({ root, store });
const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { seq: 1, totals: {}, spending: { today: {} }, cards: [], agents: [], channels: [], lines: [], runs: [], timers: [] } : { ok: true }));
const sessionsFake = {
  record: null,
  async list() { return this.record ? [this.record] : []; },
  async listArchived() { return []; },
  async start({ prompt, project, kind } = {}) {
    const now = new Date().toISOString();
    this.record = { id: 'design-session', sessionId: 'acp-design', agent: 'Codex ACP', cwd: project, project, kind: kind || 'design', status: 'idle', statusText: '待命', prompt: prompt || '', messages: [{ role: 'user', text: prompt || '', at: now }], liveText: '', busy: false, queue: [], queued: [], queuedCount: 0, createdAt: now, updatedAt: now };
    return this.record;
  },
  dispose() {},
};
const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', rulesFile: path.join(root, 'rules.json'), root, projectRoots: [root], dagService }, sessionsFake);
const url = await listen(server);
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(); const errors = [];
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const noOverflow = async label => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: 页面主体不得横向溢出`);
  await page.goto(url); await page.getByRole('heading', { name: '今天的自动化' }).waitFor();

  // IA 基线：主导航恰好 6 项（2026-11-19 主人确认 v3 设计稿新增「管理后台」）；「DAG 运行」「执行授权」不得作为顶级导航项，只能是情境屏幕
  assert.deepEqual((await page.locator('.navigation .nav-item').allInnerTexts()).map(text => text.replace(/\s+/g, ' ').trim()),
    ['总览', '调度规则', '会话管理', '执行轮次', '待我处理', '管理后台'], '主导航必须是基线六项');
  assert.equal(await page.locator('.navigation .nav-item', { hasText: 'DAG 运行' }).count(), 0, '「DAG 运行」不得出现在主导航');
  assert.equal(await page.locator('.navigation .nav-item', { hasText: '执行授权' }).count(), 0, '「执行授权」不得出现在主导航');
  assert.equal(await page.locator('#view-dag').isHidden(), true, 'DAG 是情境屏幕，默认隐藏');
  assert.equal(await page.locator('#view-authorize').isHidden(), true, '授权是情境屏幕，默认隐藏');

  // 总览：没有 DAG 时旧四组与串行进度仍在，DAG 分组不凭空出现
  assert.equal(await page.locator('#dag-overview-list .dag-project').count(), 0);
  await page.getByRole('heading', { name: '正在运行' }).waitFor();

  // 会话管理屏：左侧类型 tab + 列表，右侧工作区（新建会话流与语义分类保留）
  await page.getByRole('button', { name: '会话管理', exact: false }).click();
  await page.locator('.session-kind-tabs [data-kind="scheduling"]').waitFor();
  await page.screenshot({ path: path.join(process.env.DAG_SHOTS || root, 'design-desktop.png'), fullPage: true });
  await noOverflow('sessions-desktop');

  // 授权范围确认页（情境屏幕）：设计会话 →「确认执行范围」进入，逐项展示，确认前不可创建
  await page.locator('#session-new').click();
  await page.locator('#new-session-dialog').waitFor({ state: 'visible' });
  await page.locator('#new-session-project').selectOption(project);
  await page.locator('#new-session-request').fill('设计一个多租户计费方案并进入 PRD、DAG 与授权确认');
  await page.waitForFunction(() => document.querySelector('#classification-title')?.textContent?.includes('设计会话'), null, { timeout: 5000 });
  await page.locator('#create-session').click();
  await page.locator('#session-workspace [data-action="design-authorize"]').waitFor({ timeout: 5000 });
  await page.locator('#session-workspace [data-action="design-authorize"]').click();
  assert.equal(await page.locator('#view-authorize').isVisible(), true);
  assert.equal(await page.locator('#view-sessions').isHidden(), true, '授权确认接管主区域，不再与导航页并列');
  await page.locator('#authorize-project').selectOption(project);
  await page.locator('#authorize-plan').fill('plan-one');
  await page.getByRole('button', { name: '读取计划与预检' }).click();
  await page.locator('[data-auth-repo]').waitFor();
  assert.equal(await page.locator('[data-auth-repo]').innerText(), project);
  assert.equal(await page.locator('[data-auth-node]').count(), 4);
  assert.match(await page.locator('[data-auth-node="a"]').innerText(), /src\/a\.mjs/);
  assert.match(await page.locator('[data-auth-node="integration-review"]').innerText(), /只读审查，无写入/);
  assert.equal(await page.locator('input[data-action-id]').count(), 8);
  const excluded = await page.locator('.excluded-tags').innerText();
  for (const word of ['部署', '发布', '生产数据写入', '其他凭据', '对外通信']) assert.ok(excluded.includes(word), word);
  assert.match(await page.locator('.confirmation-summary').innerText(), /5 路/);
  assert.equal(await page.locator('#authorize-button').isDisabled(), true, '未勾选阅读前不能创建');
  assert.equal(await page.locator('[data-plan-digest]').innerText(), planDigest);
  assert.equal(await page.evaluate(() => window.__xss), undefined, '上游节点标题不得作为 HTML 执行');
  await noOverflow('authorize-desktop');
  await page.screenshot({ path: path.join(process.env.DAG_SHOTS || root, 'authorize-desktop.png'), fullPage: true });

  await page.locator('#authorize-check').check();
  assert.equal(await page.locator('#authorize-button').isEnabled(), true);
  await page.locator('#authorize-button').click();
  await page.locator('#dag-detail .dag-detail').waitFor();
  assert.equal(await page.locator('.navigation .nav-item.active').count(), 0, '情境屏幕不点亮任何主导航项');
  assert.equal(hub.requests.some(r => r.url.includes('/v1/runs')), false, '创建 DAG 不触碰 Hub 旧通道');
  const runs = store.listRuns(); assert.equal(runs.length, 1);
  // 节点 PR：按发布器真实写法登记在根 run.prs（registerPr 新的、再把旧的标为被取代关闭），各轮 nodeRuns[].prs 保持为空。
  // 页面必须链到仍开着的 #7，不显示被取代的 #6；没有 PR 的节点如实显示「暂无 PR」（#142 回归）。
  const PR_OLD = 'https://github.com/example/demo/pull/6', PR_NEW = 'https://github.com/example/demo/pull/7';
  store.registerPr(runs[0].runId, 'a', PR_OLD);
  store.registerPr(runs[0].runId, 'a', PR_NEW);
  store.publishClosePr(runs[0].runId, 'a', PR_OLD, { supersededBy: PR_NEW });
  const prLinksIn = selector => page.evaluate(sel => [...document.querySelectorAll(`${sel} a`)].map(a => a.getAttribute('href')).filter(href => /\/pull\//.test(href || '')), selector);
  const textIn = selector => page.evaluate(sel => document.querySelector(sel)?.innerText || '', selector);
  assert.deepEqual(runs[0].authorizationSnapshot.allowedActions.includes('deploy'), false);

  // 总览分组：新 DAG 出现，旧区域保留
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.locator('#dag-overview-list .dag-project').waitFor();
  assert.equal(await page.locator('#dag-overview-list .overview-ring').getAttribute('data-segments'), '4');
  assert.equal(await page.locator('#dag-overview-list .ring-seg').count(), 4);
  assert.match(await page.locator('#dag-overview-list .overview-ring-center').innerText(), /%/, 'DAG ring keeps the total percent center');
  // 环上颜色语义：同波次同色相，不同波次不同色相（a=第1波，b/c=第2波，整合=第3波）
  const ringStrokes = await page.locator('#dag-overview-list .ring-seg').evaluateAll(list => list.map(node => node.getAttribute('stroke')));
  const hueOf = stroke => Number(/hsl\((\d+)/.exec(stroke)?.[1]);
  assert.equal(hueOf(ringStrokes[1]), hueOf(ringStrokes[2]), 'same wave shares one hue');
  assert.notEqual(hueOf(ringStrokes[0]), hueOf(ringStrokes[1]), 'different waves use different hues');
  const dagRingLabels = await page.locator('#dag-overview-list .ring-label').evaluateAll(list => list.map(node => node.textContent));
  assert.equal(dagRingLabels.length, 4, 'each sector carries its node name');
  assert.equal(dagRingLabels[0], '账户模型');
  assert.equal(dagRingLabels[3], '整合审查');
  assert.equal(await page.locator('#dag-overview-list .ring-label img').count(), 0, 'ring labels stay plain text');
  assert.equal(await page.locator('#dag-overview-list .ring-divider.wave').count(), 2, 'wave boundaries use solid dividers');
  assert.equal(await page.locator('#dag-overview-list .ring-divider.node').count(), 1, 'nodes inside a wave use dashed dividers');
  // DAG 内圈进度弧：每节点一段轨道 + 状态完成度档填充（此时全 pending，无指针）
  assert.equal(await page.locator('#dag-overview-list .ring-inner-seg').count(), 4, 'DAG 每节点一段内圈轨道');
  assert.equal(await page.locator('#dag-overview-list .ring-pointer').count(), 0, '无活跃节点时不画指针');
  assert.match(await page.locator('#dag-overview-list .dag-project').innerText(), /待派发/);
  assert.match(await page.locator('#dag-overview-list .dag-project').innerText(), /费用未上报 · Token 未上报/);
  // 与串行链同一套项目级计数与用量行：等待重试 / 今日完成 / 待您处理 / 今日费用 + 项目今日 / 项目累计
  const dagCardText = await textIn('#dag-overview-list .dag-project');
  for (const label of ['等待重试 0', '今日完成 0', '待您处理 0 张', '今日费用', '项目今日', '项目累计']) assert.ok(dagCardText.includes(label), `DAG 卡片缺少「${label}」`);
  // DAG 总览与串行总览同构：环形扇区切换右侧单个节点详情，不离开总览
  const dagDetailTitle = page.locator('#dag-overview-list .overview-node-head strong');
  assert.equal(await dagDetailTitle.innerText(), '账户模型', 'default DAG detail shows the current pending node');
  await page.waitForFunction(url => [...document.querySelectorAll('#dag-overview-list .overview-node a')].some(a => a.getAttribute('href') === url), PR_NEW, { timeout: 6000 });
  const overviewLinksA = await prLinksIn('#dag-overview-list .overview-node');
  assert.ok(overviewLinksA.length >= 1 && overviewLinksA.every(href => href === PR_NEW), `overview node detail links only the live PR #7 (got ${overviewLinksA.join(', ')})`);
  assert.match(await textIn('#dag-overview-list .overview-node'), /查看 PR/, 'overview node detail labels the evidence as 查看 PR');
  // 定位、滚入视口、算坐标在页面内一次同步完成（总览每 2 秒整块重建，原先靠 6 次重试兜底撞上重建的情况）。
  // 随后按坐标点击：即使其间重建，新扇区位置相同照样命中。
  const dagPoint = await page.evaluate(radians => {
    const el = document.querySelector('#dag-overview-list .ring-seg[data-ring-node="b"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const box = el.getBoundingClientRect();
    const r = parseFloat(el.getAttribute('r'));
    const stroke = parseFloat(el.getAttribute('stroke-width')) || 0;
    const scale = box.width / (2 * r + stroke);
    return { x: box.x + box.width / 2 + r * scale * Math.cos(radians), y: box.y + box.height / 2 + r * scale * Math.sin(radians) };
  }, (-90 + 1.5 * 90) * Math.PI / 180); // 4 个扇区里第 2 个（b）的中角
  assert.ok(dagPoint, 'DAG ring sector b must exist');
  await page.mouse.click(dagPoint.x, dagPoint.y);
  assert.equal(await dagDetailTitle.innerText(), XSS, 'clicking a DAG sector switches the detail');
  assert.deepEqual(await prLinksIn('#dag-overview-list .overview-node'), [], 'a node without a registered PR has no PR link');
  // 总览节点详情只在有 PR 时出现「查看 PR」链接（无 PR 不出文案）；「暂无 PR」文案在 DAG 详情的「证据」行断言
  assert.equal(await page.locator('#dag-overview-list .overview-node img').count(), 0, 'node title renders as text in the overview detail');
  assert.equal(await page.locator('#view-overview').isVisible(), true, 'DAG ring click stays on the overview');
  assert.equal(await page.locator('#view-dag').isVisible(), false, 'DAG ring click must not open the detail view');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await page.getByRole('heading', { name: '项目任务进度' }).waitFor();
  await noOverflow('overview-desktop');
  await page.screenshot({ path: path.join(process.env.DAG_SHOTS || root, 'overview-desktop.png'), fullPage: true });

  // 详情页：节点卡片、摘要、Agent/模型如实标注；点节点出详情；XSS 标题以文本呈现
  await page.locator('#dag-overview-list [data-dag-open]').first().click();
  await page.locator('#dag-detail .dag-node').first().waitFor();
  assert.equal(await page.locator('#dag-detail .dag-node').count(), 4);
  await page.locator('#dag-detail [data-dag-node="b"]').click();
  assert.equal(await page.locator('#dag-node-detail h3').innerText(), XSS);
  assert.equal(await page.locator('#dag-node-detail img').count(), 0);
  assert.match(await page.locator('#dag-node-detail').innerText(), /模型待选择/);
  assert.match(await page.locator('#dag-node-detail').innerText(), /产出契约：计费规则|计费规则/);
  assert.match(await textIn('#dag-node-detail'), /暂无 PR/, 'DAG detail: node without PR says 暂无 PR');
  assert.deepEqual(await prLinksIn('#dag-node-detail'), [], 'DAG detail: node without PR has no PR link');
  await page.locator('#dag-detail [data-dag-node="a"]').click();
  await page.waitForFunction(() => document.querySelector('#dag-node-detail h3')?.textContent === '账户模型', null, { timeout: 6000 });
  assert.deepEqual(await prLinksIn('#dag-node-detail'), [PR_NEW], 'DAG detail: node links the live PR #7, never the superseded #6');
  await page.locator('#dag-detail [data-dag-node="b"]').click();
  assert.match(await page.locator('.run-metrics').innerText(), /1 \/ 3|1 \/ 4|0 \/ 4/);
  await noOverflow('dag-desktop');
  await page.screenshot({ path: path.join(process.env.DAG_SHOTS || root, 'dag-desktop.png'), fullPage: true });

  // 取消运行：写操作带标记头，服务端记录取消请求
  await page.getByRole('button', { name: '取消运行', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.dag-detail .title-with-badge')?.textContent.includes('取消中'));
  assert.equal(store.listRuns()[0].publish.cancelRequested, true);
  // 历史区默认折叠
  assert.equal(await page.locator('#dag-history-list').isHidden(), true);
  await page.locator('[data-dag-history-toggle]').click();
  assert.equal(await page.locator('#dag-history-list').isVisible(), true);

  // 移动端 390×844：导航只有 5 项，DAG/授权经情境触达
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.waitForTimeout(250);
  await noOverflow('overview-mobile');
  await page.screenshot({ path: path.join(process.env.DAG_SHOTS || root, 'overview-mobile.png'), fullPage: true });
  await page.locator('#dag-overview-list [data-dag-open]').first().click();
  await page.waitForTimeout(250);
  await noOverflow('dag-mobile');
  await page.screenshot({ path: path.join(process.env.DAG_SHOTS || root, 'dag-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '会话管理', exact: false }).click();
  await page.waitForTimeout(250);
  await noOverflow('sessions-mobile');
  await page.screenshot({ path: path.join(process.env.DAG_SHOTS || root, 'design-mobile.png'), fullPage: true });
  await page.locator('#session-workspace [data-action="design-authorize"]').click();
  await page.waitForTimeout(250);
  await noOverflow('authorize-mobile');
  await page.screenshot({ path: path.join(process.env.DAG_SHOTS || root, 'authorize-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS browser-dag: authorize → create → overview group → detail → cancel, desktop+mobile, no console errors');
} finally {
  if (context) await context.close(); await close(server); await close(hub.server);
  rmSync(root, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
}

// ---- #67 execution-grants：轻量授权记录在 UI 呈现（独立用例，避免污染主流程）----
test('授权确认页呈现可选高风险动作收益/代价，DAG 详情显示轻量授权记录', async () => {
  const broot = mkdtempSync(path.join(tmpdir(), 'dag-grant-ui-'));
  const bprofile = mkdtempSync(path.join(tmpdir(), 'dag-grant-profile-'));
  const bproject = path.join(broot, 'demo-repo'); mkdirSync(path.join(bproject, '.git'), { recursive: true });
  const bnodes = [
    { id: 'a', title: '节点 A', depends_on: [], contract: { input: 'i', output: 'o', error_behavior: 'e', acceptance_example: 'x', files: ['src/a.mjs'] } },
  ];
  const bdir = path.join(bproject, '.vibe', 'plans', 'plan-one'); mkdirSync(bdir, { recursive: true });
  writeFileSync(path.join(bdir, 'plan.json'), JSON.stringify({ plan_id: 'plan-one', decisions: [], optionalHighRiskActions: ['deploy'] }));
  writeFileSync(path.join(bdir, 'nodes.json'), JSON.stringify(bnodes));
  writeFileSync(path.join(bdir, 'product-spec.input.json'), JSON.stringify({ decisions: [] }));
  writeFileSync(path.join(bproject, '.vibe', 'state.json'), JSON.stringify({ workflow_version: 4, execution_mode: 'sdd_first', session_gate: 's0_required', capability_contract_required: true }));
  mkdirSync(path.join(bproject, '.vibe', 'provider-actions'), { recursive: true });
  writeFileSync(path.join(bproject, '.vibe', 'provider-actions', 'capabilities-codex.json'), JSON.stringify(attestRecord()));
  writeFileSync(path.join(broot, 'rules.json'), JSON.stringify({ rules: [] }));
  const bstore = createRunStore({ directory: path.join(broot, 'dag-runs') });
  const bdagService = createDagService({ root: broot, store: bstore });
  const bhub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { seq: 1, totals: {}, spending: { today: {} }, cards: [], agents: [], channels: [], lines: [], runs: [], timers: [] } : { ok: true }));
  const bsessions = {
    record: null,
    async list() { return this.record ? [this.record] : []; },
    async listArchived() { return []; },
    async start({ prompt, project, kind } = {}) {
      const now = new Date().toISOString();
      this.record = { id: 'design-session', sessionId: 'acp-design', agent: 'Codex ACP', cwd: project, project, kind: kind || 'design', status: 'idle', statusText: '待命', prompt: prompt || '', messages: [{ role: 'user', text: prompt || '', at: now }], liveText: '', busy: false, queue: [], queued: [], queuedCount: 0, createdAt: now, updatedAt: now };
      return this.record;
    },
    dispose() {},
  };
  const bserver = createConsoleServer({ hubUrl: bhub.url, ownerKey: 'k', rulesFile: path.join(broot, 'rules.json'), root: broot, projectRoots: [broot], dagService: bdagService }, bsessions);
  const burl = await listen(bserver);
  let bctx;
  try {
    bctx = await chromium.launchPersistentContext(bprofile, { channel: 'chrome', headless: true, viewport: { width: 1440, height: 900 } });
    const page = await bctx.newPage();
    page.on('dialog', dialog => dialog.accept());
    await page.goto(burl); await page.getByRole('heading', { name: '今天的自动化' }).waitFor();
    await page.getByRole('button', { name: '会话管理', exact: false }).click();
    await page.locator('#session-new').click();
    await page.locator('#new-session-dialog').waitFor({ state: 'visible' });
    await page.locator('#new-session-project').selectOption(bproject);
    await page.locator('#new-session-request').fill('设计一个多租户计费方案并进入 PRD、DAG 与授权确认');
    await page.waitForFunction(() => document.querySelector('#classification-title')?.textContent?.includes('设计会话'), null, { timeout: 5000 });
    await page.locator('#create-session').click();
    await page.locator('#session-workspace [data-action="design-authorize"]').waitFor({ timeout: 5000 });
    await page.locator('#session-workspace [data-action="design-authorize"]').click();
    await page.locator('#authorize-project').selectOption(bproject);
    await page.locator('#authorize-plan').fill('plan-one');
    await page.getByRole('button', { name: '读取计划与预检' }).click();
    await page.locator('[data-optional-grant="deploy"]').waitFor();
    // 默认关闭、收益与代价在页面呈现
    assert.equal(await page.locator('[data-optional-grant="deploy"]').isChecked(), false, '高风险动作默认关闭');
    const optText = await page.locator('[data-optional-grant="deploy"]').locator('..').innerText();
    const preview = await (await fetch(`${burl}/api/dag-plan?project=${encodeURIComponent(bproject)}&planId=plan-one`)).json();
    const deploy = preview.optionalActions.find(a => a.id === 'deploy');
    assert.ok(optText.includes(deploy.benefit), '收益文案呈现');
    assert.ok(optText.includes(deploy.cost), '代价文案呈现');
    // 勾选后创建 → 授权记录含 deploy
    await page.locator('[data-optional-grant="deploy"]').check();
    await page.locator('#authorize-check').check();
    await page.locator('#authorize-button').click();
    await page.locator('#dag-detail .dag-detail').waitFor();
    const runs = bstore.listRuns();
    assert.deepEqual(runs[0].authorizationSnapshot.optionalGrants, ['deploy']);
    // DAG 详情显示轻量授权记录
    assert.ok((await page.locator('#dag-detail').innerText()).includes('执行授权记录'), '详情须显示轻量授权记录');
    assert.ok((await page.locator('#dag-detail').innerText()).includes('部署'), '详情须列出已选高风险动作');
  } finally {
    if (bctx) await bctx.close(); await close(bserver); await close(bhub.server);
    rmSync(broot, { recursive: true, force: true }); rmSync(bprofile, { recursive: true, force: true });
  }
});
