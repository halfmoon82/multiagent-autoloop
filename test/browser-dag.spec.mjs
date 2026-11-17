// DAG 生产 UI 浏览器验收：授权范围确认 → 创建 → 总览分组/详情，桌面 1440×900 与移动 390×844。
// 使用真实 dagService + 临时 Git 仓库 + 假 Hub，不调用任何真实模型。
import assert from 'node:assert/strict';
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
const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', rulesFile: path.join(root, 'rules.json'), root, projectRoots: [root], dagService }, { async list() { return []; }, async listArchived() { return []; }, dispose() {} });
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

  // 总览：没有 DAG 时旧四组与串行进度仍在，DAG 分组不凭空出现
  assert.equal(await page.locator('#dag-overview-list .dag-project').count(), 0);
  await page.getByRole('heading', { name: '正在运行' }).waitFor();

  // 授权范围确认页：逐项展示，确认前不可创建
  await page.getByRole('button', { name: '执行授权', exact: true }).click();
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

  // 移动端 390×844
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [view, name] of [['overview', '总览'], ['dag', 'DAG 运行'], ['authorize', '执行授权']]) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(250);
    await noOverflow(`${view}-mobile`);
    await page.screenshot({ path: path.join(process.env.DAG_SHOTS || root, `${view}-mobile.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('PASS browser-dag: authorize → create → overview group → detail → cancel, desktop+mobile, no console errors');
} finally {
  if (context) await context.close(); await close(server); await close(hub.server);
  rmSync(root, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
}
