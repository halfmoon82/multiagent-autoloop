// artifacts-sync 节点回归（DAG 节点 artifacts-sync）：
// 1) 移动端只读产物路由 GET /api/mobile/sessions/:id/artifacts（设备鉴权 / 空会话 / 正常三路）；
// 2) 会话快照按会话分组聚合，单会话失败只影响该分组、全部失败给明确空态；
// 3) 全局产物页 hooks.artifacts 与会话入口 hooks.artifactsForSession 接上同一份快照；
// 4) 浏览器回归：全局页与会话入口显示与网页一致的产物列表。
// 全部走假 Hub + 临时目录 + 注入 fetch，不调用真实模型或真实规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { MOBILE_WRITE_ROUTES } from '../src/mobile-write.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';
import * as artifactsFeature from '../mobile/src/features/artifacts/index.mjs';
import { mount as mountArtifactsPage } from '../mobile/app/www/pages/artifacts.mjs';

const WORKTREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// 服务端：假 Hub + 注入会话管理器
// ---------------------------------------------------------------------------
function makeSessions(artifactFiles) {
  return {
    calls: [],
    async list() {
      return [
        { id: 's1', task: '梳理方案', project: WORKTREE, status: 'running' },
        { id: 's2', task: '验收报告', project: WORKTREE, status: 'running' },
      ];
    },
    async listArchived() { return []; },
    async listSessionArtifacts(id) {
      this.calls.push(['listSessionArtifacts', id]);
      if (id === 'missing') { const error = new Error('调度会话不存在'); error.status = 404; throw error; }
      if (id === 'boom') throw new Error('internal detail owner-key=secret stack=db-password');
      return artifactFiles[id] || [];
    },
  };
}

async function setup(t, { artifactFiles = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'artifacts-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ rules: [], agents: {}, sources: {} }));
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [] } : { ok: true }));
  const store = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const qr = store.createBinding();
  const bound = store.bindDevice({ token: qr.token, name: '测试手机', platform: 'Android' });
  const browserQr = store.createBinding(); // 绑定码一次性，浏览器回归用另一张未消费的
  const sessions = makeSessions(artifactFiles);
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'owner-key', sourceKey: 'source-key',
    host: '127.0.0.1', root, rulesFile, projectRoots: [WORKTREE], deviceAuth: store,
  }, sessions);
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); });
  return { url, sessions, deviceToken: bound.deviceToken, root, qrPayload: browserQr.qrPayload };
}

function mobileFetch(base, pathname, { token } = {}) {
  const target = new URL(base);
  return fetch(base + pathname, {
    method: 'GET',
    headers: {
      'x-console-request': '1', 'x-forwarded-proto': 'https', origin: target.origin,
      accept: 'application/json', ...(token ? { 'x-device-token': token } : {}),
    },
    signal: AbortSignal.timeout(6000),
  });
}

const FILE_S1 = [{ path: 'docs/plan.md', name: 'plan.md', size: 12, at: '2026-11-19T05:00:00.000Z', kind: 'doc' }];

test('路由表登记只读产物 GET 路由，不触碰既有下载路由', () => {
  const route = MOBILE_WRITE_ROUTES.find(item => item.key === 'session-artifacts' && item.method === 'GET');
  assert.ok(route, '新增 session-artifacts 只读路由');
  assert.ok(route.pattern.test('/api/mobile/sessions/s1/artifacts'));
  assert.ok(!route.pattern.test('/api/mobile/sessions/s1/download'), '不吞掉既有下载路由');
  assert.ok(MOBILE_WRITE_ROUTES.some(item => item.key === 'session-download' && item.method === 'GET'));
});

test('GET /api/mobile/sessions/:id/artifacts 未绑定设备一律 401', async t => {
  const ctx = await setup(t);
  const response = await mobileFetch(ctx.url, '/api/mobile/sessions/s1/artifacts');
  assert.equal(response.status, 401);
  assert.deepEqual(ctx.sessions.calls, [], '鉴权失败不触达会话管理器');
});

test('空会话（不存在）返回 404 且不回显内部错误', async t => {
  const ctx = await setup(t);
  const response = await mobileFetch(ctx.url, '/api/mobile/sessions/missing/artifacts', { token: ctx.deviceToken });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.ok(!/secret|owner-key|stack|db-password/.test(JSON.stringify(body)), '不回显 Hub/内部错误体');
});

test('正常会话返回与网页同一份只读列表，不读文件内容', async t => {
  const ctx = await setup(t, { artifactFiles: { s1: FILE_S1 } });
  const response = await mobileFetch(ctx.url, '/api/mobile/sessions/s1/artifacts', { token: ctx.deviceToken });
  assert.equal(response.status, 200);
  const mobile = await response.json();
  assert.deepEqual(mobile.files, FILE_S1);
  const web = await fetch(`${ctx.url}/api/scheduling-sessions/s1/artifacts`);
  assert.equal(web.status, 200);
  assert.deepEqual(mobile.files, (await web.json()).files, '与网页同一份数据');
  assert.ok(ctx.sessions.calls.some(call => call[0] === 'listSessionArtifacts' && call[1] === 's1'));
  assert.ok(!ctx.sessions.calls.some(call => call[0] === 'readSessionArtifact'), '只读列表不读文件内容');
  assert.ok(!('content' in mobile.files[0]), '列表项不含文件内容');
});

test('服务端抛内部错误时移动端只给固定可读文案', async t => {
  const ctx = await setup(t);
  const response = await mobileFetch(ctx.url, '/api/mobile/sessions/boom/artifacts', { token: ctx.deviceToken });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.ok(!/secret|owner-key|stack|db-password/.test(JSON.stringify(body)));
  assert.match(body.error, /操作暂时不可用|读取/);
});

// ---------------------------------------------------------------------------
// 纯逻辑：会话快照
// ---------------------------------------------------------------------------
const SNAPSHOT_SESSIONS = [{ id: 's1', task: '梳理方案' }, { id: 's2', task: '验收报告' }];
const SNAPSHOT_RESPONSES = {
  s1: { files: [{ path: 'docs/plan.md', name: 'plan.md', size: 12, at: '2026-11-19T05:00:00.000Z' }] },
  s2: { files: [{ path: 'docs/report.md', name: 'report.md', size: 8, at: '2026-11-19T06:00:00.000Z' }] },
};

test('会话快照按会话分组聚合，全局按时间倒序，单会话只取本组', () => {
  const build = artifactsFeature.buildSessionArtifactsSnapshot;
  const snapshot = build(SNAPSHOT_SESSIONS, SNAPSHOT_RESPONSES);
  assert.equal(typeof build, 'function', '快照构造器已导出');
  assert.equal(snapshot.groups.length, 2);
  assert.deepEqual(artifactsFeature.snapshotArtifacts(snapshot).map(item => item.path), ['docs/report.md', 'docs/plan.md']);
  assert.deepEqual(artifactsFeature.snapshotSessionArtifacts(snapshot, 's1').map(item => item.path), ['docs/plan.md']);
  assert.equal(artifactsFeature.snapshotSessionArtifacts(snapshot, 'unknown').length, 0);
  assert.equal(snapshot.artifacts[0].sessionId, 's2');
  assert.equal(snapshot.artifacts[0].task, '验收报告');
});

test('单会话读取失败只标记该分组，其余分组照常聚合', () => {
  const snapshot = artifactsFeature.buildSessionArtifactsSnapshot(SNAPSHOT_SESSIONS, {
    ...SNAPSHOT_RESPONSES, s2: { error: '读取失败，请重试' },
  });
  assert.equal(snapshot.artifacts.length, 1);
  assert.equal(snapshot.artifacts[0].sessionId, 's1');
  assert.equal(snapshot.allFailed, false);
  assert.deepEqual(snapshot.errors.map(item => item.sessionId), ['s2']);
  assert.equal(artifactsFeature.snapshotSessionError(snapshot, 's2'), '读取失败，请重试');
  assert.equal(artifactsFeature.snapshotSessionError(snapshot, 's1'), null);
});

test('全部会话失败：空产物列表 + 明确 allFailed，不编造内容', () => {
  const snapshot = artifactsFeature.buildSessionArtifactsSnapshot(SNAPSHOT_SESSIONS, {
    s1: { error: '读取失败' }, s2: { error: '读取失败' },
  });
  assert.equal(snapshot.artifacts.length, 0);
  assert.equal(snapshot.allFailed, true);
  assert.equal(snapshot.errors.length, 2);
});

test('无会话：空快照不报错', () => {
  const snapshot = artifactsFeature.buildSessionArtifactsSnapshot([], {});
  assert.deepEqual(artifactsFeature.snapshotArtifacts(snapshot), []);
  assert.equal(snapshot.allFailed, false);
});

// ---------------------------------------------------------------------------
// 页面接线（假 DOM）
// ---------------------------------------------------------------------------
function fakeEl(tag = 'div') {
  return {
    tag, children: [], _text: '', hidden: false, dataset: {}, attrs: {}, listeners: {},
    get textContent() { return this._text; },
    set textContent(value) { this._text = String(value ?? ''); this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    setAttribute(key, value) { this.attrs[key] = String(value); },
    getAttribute(key) { return this.attrs[key] ?? null; },
    click() { for (const fn of this.listeners.click || []) fn({ target: this }); },
  };
}
function fakeDoc() {
  const byId = {};
  return {
    getElementById(id) { return byId[id] || null; },
    createElement(tag) { return fakeEl(tag); },
    add(id) { byId[id] = fakeEl('div'); return byId[id]; },
  };
}
function collect(node, out = []) {
  out.push(node);
  for (const child of node.children || []) collect(child, out);
  return out;
}
const elText = node => collect(node).map(item => item.textContent || '').join(' ');
const buttonsNamed = (node, name) => collect(node).filter(item => item.tag === 'button' && (item.textContent || '').includes(name));

function fakeClient() {
  return {
    origin: 'https://auto.example',
    tokenStore: { async get() { return 'device-token'; } },
    async api(key) {
      if (key === 'sessions') return SNAPSHOT_SESSIONS.map(session => ({ ...session, project: WORKTREE, status: 'running' }));
      return { sessions: [] };
    },
  };
}
function makeFetch(files, { failing = new Set() } = {}) {
  let attempts = 0;
  const handler = async url => {
    const match = /^\/api\/mobile\/sessions\/([^/]+)\/artifacts$/.exec(new URL(url).pathname);
    assert.ok(match, '只打新的只读产物路由');
    const id = decodeURIComponent(match[1]);
    attempts += 1;
    if (failing.has(id)) return { ok: false, status: 502, json: async () => ({ error: '读取失败，请重试' }) };
    return { ok: true, status: 200, json: async () => ({ files: files[id] || [] }) };
  };
  handler.count = () => attempts;
  return handler;
}
function mountPage(hooks = {}, fetchImpl) {
  const doc = fakeDoc();
  const root = doc.add('page-artifacts');
  const win = {
    innerWidth: 400, location: { origin: 'https://auto.example' },
    addEventListener() {}, removeEventListener() {},
  };
  mountArtifactsPage({ client: fakeClient(), state: {}, hooks }, { doc, win, fetchImpl });
  return { root, hooks };
}

test('mount 接线两个钩子：全局页与会话入口显示同一份产物', async () => {
  const { root, hooks } = mountPage({}, makeFetch({
    s1: SNAPSHOT_RESPONSES.s1.files, s2: SNAPSHOT_RESPONSES.s2.files,
  }));
  await tick(); await tick(); await tick(); // 浏览器路径下视图模型为动态 import
  assert.equal(typeof hooks.artifacts, 'function', '全局页钩子被接线（RED：原先无赋值）');
  assert.equal(typeof hooks.artifactsForSession, 'function', '会话入口钩子被接线');
  await tick(); await tick(); await tick();
  assert.equal(hooks.artifacts().length, 2);
  assert.equal(hooks.artifactsForSession('s1').length, 1);
  assert.match(elText(root), /plan\.md/);
  assert.match(elText(root), /report\.md/);

  hooks.openSessionArtifacts('s1');
  await tick();
  assert.match(elText(root), /plan\.md/);
  assert.doesNotMatch(elText(root), /report\.md/, '会话入口只显示本会话产物');
});

test('单会话失败只影响该分组，失败分组就地重试后补齐', async () => {
  const failing = new Set(['s2']);
  const fetchImpl = makeFetch({ s1: SNAPSHOT_RESPONSES.s1.files, s2: SNAPSHOT_RESPONSES.s2.files }, { failing });
  const { root, hooks } = mountPage({}, fetchImpl);
  await tick(); await tick(); await tick();
  assert.equal(hooks.artifacts().length, 1, '失败的 s2 不影响 s1');
  assert.match(elText(root), /s2.*读取失败|读取失败/);
  const retry = buttonsNamed(root, '重试').find(item => item.getAttribute('class') === 'artifacts-group-retry');
  assert.ok(retry, '失败分组提供就地重试按钮');
  failing.clear();
  retry.click();
  await tick(); await tick(); await tick();
  assert.equal(hooks.artifacts().length, 2, '重试后补齐产物');
  assert.equal(fetchImpl.count(), 3, '重试只重取失败会话');
});

test('全部会话失败：明确空态，不编造产物', async () => {
  const { root, hooks } = mountPage({}, makeFetch({}, { failing: new Set(['s1', 's2']) }));
  await tick(); await tick(); await tick();
  assert.equal(hooks.artifacts().length, 0);
  assert.match(elText(root), /未能读取任何会话的产物|读取失败/);
  assert.doesNotMatch(elText(root), /plan\.md|report\.md/);
});

test('外部注入 hooks.artifacts 时保持原行为，不被同步加载覆盖', async () => {
  const injected = [{ id: 'x1', path: 'docs/injected.md', name: 'injected.md', sessionId: 's9' }];
  const hooks = { artifacts: () => injected };
  const { root } = mountPage(hooks, makeFetch({}));
  await tick(); await tick();
  assert.strictEqual(hooks.artifacts(), injected, '已有钩子不被覆盖');
  assert.match(elText(root), /injected\.md/);
});


// ---------------------------------------------------------------------------
// 浏览器回归（无 Chromium 显式跳过）
// ---------------------------------------------------------------------------
const browserSkip = (() => {
  try { return existsSync(chromium.executablePath()) ? false : '未安装 Playwright Chromium，跳过浏览器回归'; }
  catch { return '无法探测 Playwright Chromium，跳过浏览器回归'; }
})();

test('浏览器：全局页与会话入口显示与网页一致的产物', { skip: browserSkip }, async t => {
  const files = {
    s1: [{ path: 'docs/plan.md', name: 'plan.md', size: 12, at: '2026-11-19T05:00:00.000Z', kind: 'doc' }],
    s2: [{ path: 'docs/report.md', name: 'report.md', size: 8, at: '2026-11-19T06:00:00.000Z', kind: 'doc' }],
  };
  const ctx = await setup(t, { artifactFiles: files });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(value) { stored = value; }, async remove() { stored = null; } };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  await page.route('**/api/mobile/api/sessions', route => route.fulfill({ json: SNAPSHOT_SESSIONS.map(session => ({ ...session, project: WORKTREE, status: 'running' })) }));
  await page.goto(`${ctx.url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks), null, { timeout: 60000 });
  await page.locator('#bind-payload').fill(ctx.qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'), null, { timeout: 60000 });
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.waitForFunction(() => Boolean(window.AutoloopNav), null, { timeout: 60000 });
  await page.evaluate(() => window.AutoloopNav.selectTab('artifacts'));
  await page.waitForFunction(() => document.getElementById('page-artifacts')?.textContent?.includes('plan.md'), null, { timeout: 60000 });
  const global = await page.locator('#page-artifacts').innerText();
  assert.match(global, /plan\.md/);
  assert.match(global, /report\.md/);
  await page.evaluate(() => window.AutoloopHooks.openSessionArtifacts('s1'));
  const session = await page.locator('#page-artifacts').innerText();
  assert.match(session, /plan\.md/);
  assert.doesNotMatch(session, /report\.md/, '会话入口只显示本会话产物');
  assert.deepEqual(pageErrors, [], '无页面脚本错误');
});
