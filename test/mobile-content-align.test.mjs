// content-align 节点：移动端各页视图模型与网页版 public/ 输出对齐（总览四组与空态、DAG 角色标签、
// 费用三态、项目 DAG 入口、管理后台两分区、保存确认流）。不调用真实模型、不操作真实规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
  buildOverview, buildPages, runTaskInfo, dagRoleLabel, OVERVIEW_GROUP_EMPTY,
  buildAdminPlatformPage, buildAdminRuntime, adminPreviewLines, buildAdminSavePayload, initialAdminDraft, createCoreWrite,
} from '../mobile/src/core/index.mjs';
import { splitRunSections, runTaskInfo as webRunTaskInfo, billingText as webBilling } from '../public/status-sections.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const NOW = new Date('2026-11-21T12:00:00+08:00');
const snap = (state, extra = {}) => ({
  available: { state: true, rules: true, projects: true, 'dag-runs': true }, errors: {}, state, rules: { rules: [], models: {} }, projects: [], dagRuns: [], ...extra,
});
const run = (id, state, extra = {}) => ({ id, state, rule: `规则${id}`, attempts: 0, createdAt: '2026-11-21T09:00:00+08:00', events: [{ subject: `s${id}`, summary: `任务${id}` }], ...extra });

test('四组口径与网页版 splitRunSections 一致，空态文案逐字相同', () => {
  const runs = [run(1, 'claimed'), run(2, 'queued', { attempts: 1 }), run(3, 'done', { finishedAt: '2026-11-21T10:00:00+08:00' }), run(4, 'unknown'), run(5, 'cancelled'), run(6, 'nothing', { finishedAt: '2026-11-20T10:00:00+08:00' })];
  const web = splitRunSections({ runs }, {}, NOW);
  const page = buildOverview(snap({ runs, cards: [{ id: 1, state: 'open', title: '卡' }] }), { now: NOW });
  const byId = Object.fromEntries(page.metrics.items.map(g => [g.id, g]));
  assert.deepEqual(page.metrics.items.map(g => g.label), ['正在运行', '等待重试', '今日完成', '待调度处理']);
  assert.equal(byId.running.count, web.running.length);
  assert.equal(byId.retrying.count, web.retrying.length);
  assert.equal(byId.doneToday.count, web.doneToday.length);
  assert.equal(byId.attention.count, web.needsAttention.length);
  assert.equal(page.openTodoCount, 1, '待用户处理另计，不混进待调度处理');
  const empty = buildOverview(snap({ runs: [], cards: [] }), { now: NOW });
  for (const group of empty.metrics.items) assert.equal(group.emptyReason, OVERVIEW_GROUP_EMPTY[group.id]);
  assert.deepEqual({ ...OVERVIEW_GROUP_EMPTY }, { running: '没有正在运行的任务。', retrying: '没有等待重试的任务。', doneToday: '今天还没有完成任务。', attention: '没有等待调度处理的事。' });
});

test('每组最多 5 条标题；DAG 派发角色标签与网页版 runTaskInfo 同口径', () => {
  const many = Array.from({ length: 8 }, (_, i) => run(i + 1, 'claimed'));
  const page = buildOverview(snap({ runs: many, cards: [] }), { now: NOW });
  assert.equal(page.metrics.items[0].titles.length, 5);
  const dev = run(9, 'claimed', { events: [{ type: 'dag.auto.dev.standard', subject: 'dag-x', summary: '开发 x' }] });
  const ack = run(10, 'claimed', { events: [{ type: 'dag.node.advance', subject: 'dag-x', summary: '回执' }] });
  for (const r of [dev, ack, run(11, 'claimed')]) {
    assert.equal(runTaskInfo(r).taskSummary, webRunTaskInfo(r).taskSummary);
    assert.equal(runTaskInfo(r).taskNumber, webRunTaskInfo(r).taskNumber);
  }
  assert.equal(dagRoleLabel(dev), '开发');
  assert.equal(dagRoleLabel(ack), '');
});

test('轮次费用三态与网页版 billingText 一致（已上报 / 仅 Token / 未上报）', () => {
  const cases = [{ usage: { cost: 0.5 } }, { usage: { input: 10, output: 5 } }, {}];
  const pages = cases.map((extra, i) => buildPages(snap({ runs: [run(i + 1, 'done', extra)], cards: [] }), { now: NOW }).runs.items.items[0].billing);
  assert.match(pages[0], /^\$0\.50$/);
  assert.match(pages[1], /Token · 费用未上报$/);
  assert.equal(pages[2], '费用未上报');
  assert.equal(pages[0], webBilling(cases[0]));
  assert.equal(pages[2], webBilling(cases[2]));
});

test('总览项目卡带「项目 DAG」入口，指向既有 dag 页与对应 runId', () => {
  const page = buildOverview(snap({ runs: [], cards: [] }, { dagRuns: [{ runId: 'dagrun-1', project: '/w/p', planId: 'plan', status: 'running', nodes: [{}, {}] }] }), { now: NOW });
  const item = page.projects.items[0];
  assert.deepEqual(item.dagEntry, { label: '项目 DAG', page: 'dag', runId: 'dagrun-1' });
});

const PLATFORM_DATA = () => ({
  enabled: false, lastSaved: null,
  platforms: [
    { id: 'codex-full', name: 'Codex', defaultModel: 'gpt-x', models: ['m1', 'm2', 'm3'], sessionCapable: true, access: 'edit', tiers: null },
    { id: 'claude', name: 'Claude', defaultModel: null, models: null, sessionCapable: true, access: 'edit', tiers: { light: 'a', standard: 'b', heavy: 'c' } },
  ],
  roles: { dev: { primary: 'claude', fallback: 'codex-full' }, review: { primary: 'claude', fallback: 'codex-full' }, coord: { primary: 'claude', fallback: 'codex-full' } },
  sessions: { coord: { tier: 'light' }, design: {}, normal: {} },
  suggested: { platforms: { 'codex-full': { light: 'm1', standard: 'm2', heavy: 'm3' } }, sessions: { design: { platform: 'claude', tier: 'standard' }, normal: { platform: 'claude', tier: 'light' } } },
});

test('管理后台·平台与模型：只读字段取真实值、草稿预填建议值、预览与保存体口径同网页版', () => {
  const page = buildAdminPlatformPage(PLATFORM_DATA());
  assert.equal(page.platforms[0].modelCount, 3);
  assert.equal(page.platforms[1].defaultModel, '未配置');
  assert.equal(page.platforms[1].modelCount, null, '读不到清单时不编造数量');
  assert.deepEqual(page.draft.platforms['codex-full'], { light: 'm1', standard: 'm2', heavy: 'm3' });
  assert.deepEqual(page.draft.sessions.design, { platform: 'claude', tier: 'standard' });
  assert.equal(page.draft.enabled, false);
  assert.deepEqual(adminPreviewLines(PLATFORM_DATA(), page.draft), ['分档已关闭：所有工作沿用各平台默认模型。']);
  const on = { ...page.draft, enabled: true };
  assert.match(adminPreviewLines(PLATFORM_DATA(), on)[0], /小节点开发 → Claude · a/);
  const draft = initialAdminDraft(PLATFORM_DATA());
  draft.platforms['codex-full'] = { light: '', standard: '', heavy: '' };
  assert.deepEqual(Object.keys(buildAdminSavePayload(draft).platforms), ['claude'], '一档都没配的平台不进保存体');
  assert.match(page.confirm, /先自动备份/);
});

test('管理后台：数据形态不对直接报错，不用默认值掩盖', () => {
  assert.throws(() => buildAdminPlatformPage({}), /格式不正确/);
  assert.throws(() => buildAdminPlatformPage(null), /格式不正确/);
});

test('管理后台·运行环境：在线/离线与待复查取真实字段，缺失给网页版同款空态', () => {
  const view = buildAdminRuntime(snap({ agents: [{ id: 'a', name: 'Codex', worker: 'acp', online: true }], channels: [{ id: 'c', online: false }], timers: [] }));
  assert.deepEqual(view.environment.map(e => [e.name, e.kind, e.statusLabel]), [['Codex', 'acp', '在线'], ['c', '通知通道', '离线']]);
  assert.equal(view.timersReason, '没有等待到期的复查。');
  assert.equal(buildAdminRuntime(snap({})).environmentReason, '还没有在线运行环境。');
  const down = buildAdminRuntime({ available: { state: false }, errors: { state: '挂了' }, state: null });
  assert.equal(down.ready, false);
  assert.match(down.environmentReason, /挂了/);
});

test('管理后台写：只走既有 /api/mobile/admin/platform-models，失败回显服务端原因', async () => {
  const calls = [];
  const client = { api() {}, origin: 'https://c.example', tokenStore: { get: async () => 't' } };
  const ok = createCoreWrite(client, { fetchImpl: async (url, init) => { calls.push([init.method, new URL(url).pathname, init.body]); return { ok: true, json: async () => ({ backup: 'b1' }) }; } });
  await ok.getPlatformModels();
  await ok.savePlatformModels({ enabled: true });
  assert.deepEqual(calls, [['GET', '/api/mobile/admin/platform-models', undefined], ['PUT', '/api/mobile/admin/platform-models', '{"enabled":true}']]);
  const bad = createCoreWrite(client, { fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: '平台未配齐三档' }) }) });
  await assert.rejects(() => bad.savePlatformModels({}), /平台未配齐三档/);
  const offline = createCoreWrite(client, { fetchImpl: async () => { throw new Error('x'); } });
  await assert.rejects(() => offline.savePlatformModels({}), /未保存/);
});

const browserSkip = (() => {
  try { return existsSync(chromium.executablePath()) ? false : 'npm test 阶段未安装 Playwright Chromium，跳过浏览器回归'; } catch { return '无法探测 Playwright Chromium，跳过浏览器回归'; }
})();

test('浏览器：管理后台分区切换、保存前确认、失败保留表单、成功后回显备份', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-align-'));
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [], lines: [], agents: [{ id: 'a', name: 'Codex', worker: 'acp', online: true }], channels: [], timers: [] } : { ok: true }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json'), deviceAuth, projectRoots: [root] });
  const url = await listen(server);
  let browser;
  t.after(async () => { if (browser) await browser.close(); await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); });
  const qr = deviceAuth.createBinding();
  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const puts = [];
  let failNext = true;
  await page.route('**/api/mobile/admin/platform-models', async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PLATFORM_DATA()) });
    puts.push(request.postData());
    if (failNext) { failNext = false; return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '平台未配齐三档' }) }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ backup: 'rules.json.bak-1' }) });
  });
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(v) { stored = v; }, async remove() { stored = null; } };
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

  // 总览：四组 + 空态 + 项目 DAG 入口所在区。
  await page.waitForFunction(() => document.querySelector('[data-core-section="metrics"]')?.textContent?.includes('待调度处理'));
  assert.match(await page.locator('[data-core-section="metrics"]').innerText(), /没有等待调度处理的事。/);

  await page.locator('[data-tab="admin"]').click();
  await page.waitForFunction(() => document.querySelector('#admin-pane-platform [data-platform="claude"]'));
  assert.match(await page.locator('#admin-pane-platform').innerText(), /读不到模型清单，请手填/);

  // 改一个字段，点保存只出确认，不发请求。
  await page.locator('#admin-pane-platform [data-admin-toggle]').click();
  await page.locator('#admin-pane-platform [data-admin-save]').click();
  await page.waitForFunction(() => document.querySelector('#admin-pane-platform [data-admin-confirm]'));
  assert.equal(puts.length, 0, '确认前不能写入');
  assert.match(await page.locator('#admin-pane-platform [data-admin-confirm]').innerText(), /先自动备份/);

  // 确认后服务端拒绝：回显原因，表单内容（开关已开）保留。
  await page.locator('#admin-pane-platform [data-admin-confirm-save]').click();
  await page.waitForFunction(() => document.querySelector('#admin-pane-platform [data-admin-error]'));
  assert.match(await page.locator('#admin-pane-platform [data-admin-error]').innerText(), /平台未配齐三档/);
  assert.equal(await page.locator('#admin-pane-platform [data-admin-toggle]').getAttribute('aria-checked'), 'true');
  assert.equal(puts.length, 1);

  // 重试成功：显示备份，保存体带开关状态。
  await page.locator('#admin-pane-platform [data-admin-save]').click();
  await page.locator('#admin-pane-platform [data-admin-confirm-save]').click();
  await page.waitForFunction(() => document.querySelector('#admin-pane-platform [data-admin-notice]'));
  assert.match(await page.locator('#admin-pane-platform [data-admin-notice]').innerText(), /rules\.json\.bak-1/);
  assert.equal(JSON.parse(puts[1]).enabled, true);

  // 分区切换：运行环境只读展示在线状态，平台分区隐藏。
  await page.locator('[data-admin-pane="admin-pane-runtime"]').click();
  await page.waitForFunction(() => document.querySelector('#admin-pane-runtime [data-env="Codex"]'));
  assert.match(await page.locator('#admin-pane-runtime').innerText(), /在线/);
  assert.equal(await page.locator('#admin-pane-platform').isHidden(), true);
  assert.deepEqual(pageErrors, []);
});
