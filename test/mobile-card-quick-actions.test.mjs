// card-quick-actions 节点回归：决策卡三内置操作（已处理/结案/退回调度）的视图模型、
// 移动端写客户端与设备鉴权服务端链路。全部走假 Hub 与假 fetch，不调用真实模型/真实规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTodos, pendingCards } from '../mobile/src/core/pages.mjs';
import { createSessionsWrite } from '../mobile/src/features/sessions/browser.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { createCardDelegateStore, DELEGATE_REASON, delegateSubject } from '../src/card-delegate.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const WORKTREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openCard = (id, extra = {}) => ({
  id, state: 'open', title: `决策卡 ${id}`, text: '业务背景', options: ['同意', '拒绝'],
  project: WORKTREE, createdAt: '2026-11-25T10:00:00Z', ...extra,
});
const snapshot = cards => ({ available: { state: true }, state: { cards, runs: [], lines: [] }, errors: {} });
const fakeClient = () => ({ origin: 'https://console.example', tokenStore: { get: async () => 'device-token' } });

// ---------- 视图模型：三操作语义 ----------
test('buildTodos 每张决策卡暴露已处理/结案/退回调度三内置操作与中文标签', () => {
  const [item] = buildTodos(snapshot([openCard(7)])).items.items;
  assert.deepEqual(item.actions, ['answer-choice', 'answer-text', 'mark-handled', 'resolve', 'delegate-return']);
  assert.deepEqual(item.quickActions.map(action => action.id), ['mark-handled', 'resolve', 'delegate-return']);
  assert.deepEqual(item.quickActions.map(action => action.label), ['已处理', '结案', '退回调度']);
});

test('三操作不改动回答语义：选项与文字回答仍在，隐藏口径不变', () => {
  const [item] = buildTodos(snapshot([openCard(8)])).items.items;
  assert.deepEqual(item.options, ['同意', '拒绝']);
  assert.equal(item.choice, null);
  assert.deepEqual(pendingCards([openCard(8), openCard(9)], ['8']).map(card => card.id), [9]);
});

// ---------- 写客户端：固定路由、设备头、错误转可读文案 ----------
test('markHandled 走 resolve 路由并带无需文字的已处理原因', async () => {
  const calls = [];
  const write = createSessionsWrite(fakeClient(), {
    fetchImpl: async (url, init) => {
      calls.push([new URL(url).pathname, init.method, JSON.parse(init.body), init.headers]);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await write.markHandled(7);
  assert.deepEqual(calls[0][0], '/api/mobile/cards/7/resolve');
  assert.equal(calls[0][1], 'POST');
  assert.deepEqual(calls[0][2], { reason: '已处理' });
  assert.equal(calls[0][3]['x-console-request'], '1');
  assert.equal(calls[0][3]['x-device-token'], 'device-token');
});

test('resolveCard 与 delegateCard 走各自固定写路由且只信本机 origin', async () => {
  const calls = [];
  const write = createSessionsWrite(fakeClient(), {
    fetchImpl: async (url, init) => {
      calls.push([new URL(url).pathname, init.method, JSON.parse(init.body)]);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await write.resolveCard(9);
  await write.delegateCard(10);
  assert.deepEqual(calls, [
    ['/api/mobile/cards/9/resolve', 'POST', { reason: '结案' }],
    ['/api/mobile/cards/10/delegate', 'POST', {}],
  ]);
});

test('三操作失败保留卡片：403 用服务端文案、断网提示可重试、无 id 不发包', async () => {
  const bound = fakeClient();
  const denied = createSessionsWrite(bound, {
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: '拒绝跨站操作' }) }),
  });
  await assert.rejects(() => denied.delegateCard(7), /拒绝跨站操作/);
  const offline = createSessionsWrite(bound, { fetchImpl: async () => { throw new Error('network down'); } });
  await assert.rejects(() => offline.markHandled(7), /无法连接控制台，操作未提交，请重试/);
  const write = createSessionsWrite(bound, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.throws(() => write.delegateCard(''), /不存在或已失效/);
});

// ---------- 服务端：设备鉴权写路由与代理 delegate 链路 ----------
async function setup(t, { cards = [], eventHandler = null, resolveHandler = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'card-quick-actions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ rules: [], agents: {}, sources: {} }));

  const events = [];
  const resolves = [];
  const hub = await fakeHub((req, res, body) => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch { /* 交由被测代码处理 */ }
    if (req.url === '/v1/state') return json(res, { cards });
    let match;
    if ((match = /^\/v1\/cards\/(\d+)\/resolve$/.exec(req.url))) {
      const id = Number(match[1]);
      resolves.push({ id, payload });
      return resolveHandler ? resolveHandler(req, res, payload, id) : json(res, { ok: true, id, state: 'decided' });
    }
    if (req.url === '/v1/events') {
      events.push(payload);
      return eventHandler ? eventHandler(req, res, payload) : json(res, { runId: 99 });
    }
    return json(res, { ok: true, body: payload });
  });

  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const qr = deviceAuth.createBinding();
  const bound = deviceAuth.bindDevice({ token: qr.token, name: '测试手机', platform: 'Android' });
  const delegateStore = createCardDelegateStore({ file: path.join(root, 'card-delegates.json') });
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'owner-key', sourceKey: 'source-key', host: '127.0.0.1',
    root, rulesFile, deviceAuth, cardDelegateStore: delegateStore,
  });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); });
  return { url, hub, events, resolves, delegateStore, deviceToken: bound.deviceToken, deviceId: bound.device.id };
}

function mobileFetch(base, pathname, { method = 'POST', token, body } = {}) {
  const target = new URL(base);
  return fetch(base + pathname, {
    method,
    headers: {
      'x-console-request': '1', 'x-forwarded-proto': 'https', origin: target.origin,
      'content-type': 'application/json', ...(token ? { 'x-device-token': token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(6000),
  });
}

test('绑定设备结案/已处理复用网页 /v1/cards/:id/resolve，未绑定全拒且 hub 零请求', async t => {
  const ctx = await setup(t, { cards: [openCard(7), openCard(8)] });
  const unbound = await mobileFetch(ctx.url, '/api/mobile/cards/7/resolve', { body: { reason: '已处理' } });
  assert.equal(unbound.status, 401);
  assert.equal(ctx.hub.requests.length, 0);

  assert.equal((await mobileFetch(ctx.url, '/api/mobile/cards/7/resolve', { token: ctx.deviceToken, body: { reason: '已处理' } })).status, 200);
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/cards/8/resolve', { token: ctx.deviceToken, body: { reason: '结案' } })).status, 200);
  assert.deepEqual(ctx.resolves, [
    { id: 7, payload: { reason: '已处理' } },
    { id: 8, payload: { reason: '结案' } },
  ]);
});

test('退回调度：设备鉴权后写代理控制台 delegate 能力，入待代理列表并结案原卡', async t => {
  const ctx = await setup(t, { cards: [openCard(21)] });
  const response = await mobileFetch(ctx.url, '/api/mobile/cards/21/delegate', { token: ctx.deviceToken, body: {} });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.runId, 99);

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].subject, delegateSubject(21));
  assert.equal(ctx.events[0].type, 'scheduling.message');
  assert.equal(JSON.parse(ctx.events[0].detail).kind, 'card.delegate');
  assert.equal(ctx.resolves.length, 1);
  assert.equal(ctx.resolves[0].payload.reason, DELEGATE_REASON);
  assert.equal(ctx.delegateStore.listPending().length, 1, '卡片进入待代理决策列表');

  const repeat = await mobileFetch(ctx.url, '/api/mobile/cards/21/delegate', { token: ctx.deviceToken, body: {} });
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).idempotent, true);
  assert.equal(ctx.events.length, 1, '重复退回不重复派发');
});

test('退回调度拒绝跨站与未绑定设备，事件/结案零请求', async t => {
  const ctx = await setup(t, { cards: [openCard(22)] });
  const noDevice = await mobileFetch(ctx.url, '/api/mobile/cards/22/delegate', { body: {} });
  assert.equal(noDevice.status, 401);
  const crossSite = await fetch(ctx.url + '/api/mobile/cards/22/delegate', {
    method: 'POST', headers: { 'x-console-request': '1', 'x-device-token': ctx.deviceToken,
      'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}',
  });
  assert.equal(crossSite.status, 403);
  assert.equal(ctx.events.length, 0);
  assert.equal(ctx.resolves.length, 0);
});

test('退回事件被 Hub 拒绝时 502，原卡不结案（卡片保留可重试）', async t => {
  const ctx = await setup(t, {
    cards: [openCard(23)],
    eventHandler: (req, res) => json(res, { error: '中台暂不可用' }, 500),
  });
  const response = await mobileFetch(ctx.url, '/api/mobile/cards/23/delegate', { token: ctx.deviceToken, body: {} });
  assert.equal(response.status, 502);
  assert.deepEqual(ctx.resolves, []);
  assert.equal(ctx.delegateStore.listPending().length, 0);
});
