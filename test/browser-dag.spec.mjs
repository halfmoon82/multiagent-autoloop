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
writeFileSync(path.join(project, '.vibe', 'state.json'), JSON.stringify({ capabilities: { adapter: 'codex', attest_command: 'vibe attest', attested_at: new Date().toISOString(), host_major_version: 5, dispatch: 'visible' } }));
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

  // IA 基线：主导航恰好 5 项；「DAG 运行」「执行授权」不得作为顶级导航项，只能是情境屏幕
  assert.deepEqual((await page.locator('.navigation .nav-item').allInnerTexts()).map(text => text.replace(/\s+/g, ' ').trim()),
    ['总览', '调度规则', '会话管理', '执行轮次', '待我处理'], '主导航必须是基线五项');
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
  assert.deepEqual(runs[0].authorizationSnapshot.allowedActions.includes('deploy'), false);

  // 总览分组：新 DAG 出现，旧区域保留
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.locator('#dag-overview-list .dag-project').waitFor();
  assert.equal(await page.locator('#dag-overview-list .dag-donut').getAttribute('data-segments'), '4');
  assert.match(await page.locator('#dag-overview-list .dag-project').innerText(), /待派发/);
  assert.match(await page.locator('#dag-overview-list .dag-project').innerText(), /费用未上报 · Token 未上报/);
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
  writeFileSync(path.join(bproject, '.vibe', 'state.json'), JSON.stringify({ capabilities: { adapter: 'codex', attest_command: 'vibe attest', attested_at: new Date().toISOString(), host_major_version: 5, dispatch: 'visible' } }));
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
