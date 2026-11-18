import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCardRouting } from '../src/card-routing.mjs';
import { createCardDelegateStore } from '../src/card-delegate.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const eng = (id, extra = {}) => ({ id, state: 'open', title: '修复构建报错', text: '测试失败，需要修复 bug', project: '/w/demo', ...extra });
const gate = id => ({ id, state: 'open', title: '修复 bug 需要提供登录密码', text: '请给出密码', project: '/w/demo' });

function setup({ activate = true, fail = false } = {}) {
  const events = []; const resolves = [];
  const routing = createCardRouting({
    delegateStore: createCardDelegateStore(),
    postEvent: async event => { if (fail) throw new Error('hub down'); events.push(event); return { runId: 1 }; },
    resolveCard: async (id, reason) => { resolves.push({ id, reason }); },
    onError: () => {},
  });
  if (activate) {
    const v = routing.store.createVersion({ rules: [{ id: 'eng-bug', route: 'scheduler', tags: ['eng:bug'], confidence: 0.9 }] });
    routing.store.recordValidation(v.version, { total: 17, humanGateFalseAuto: 0, passed: true });
    routing.activate(v.version);
  }
  return { routing, events, resolves };
}

test('active 版本下工程类开放卡自动退回调度并留脱敏决策记录', async () => {
  const { routing, events, resolves } = setup();
  const delegated = await routing.routeOpenCards([eng(1)]);
  assert.deepEqual(delegated, [1]);
  assert.equal(events.length, 1);
  assert.equal(resolves.length, 1);
  const [record] = routing.store.decisions();
  assert.equal(record.route, 'scheduler');
  assert.equal(record.mode, 'active');
  assert.equal(record.ruleVersion, 'v1');
  assert.doesNotMatch(JSON.stringify(record), /密码|测试失败|修复构建/);
});

test('无生效版本即 shadow：卡片不动，但记录影子决策', async () => {
  const { routing, events, resolves } = setup({ activate: false });
  assert.deepEqual(await routing.routeOpenCards([eng(1)]), []);
  assert.equal(events.length + resolves.length, 0);
  assert.equal(routing.store.decisions()[0].mode, 'shadow');
});

test('命中人工门禁词绝不自动交调度', async () => {
  const { routing, events, resolves } = setup();
  assert.deepEqual(await routing.routeOpenCards([gate(2)]), []);
  assert.equal(events.length + resolves.length, 0);
  assert.equal(routing.store.decisions()[0].route, 'human');
});

test('同一卡重复轮询只记一条决策，且不重复派发', async () => {
  const { routing, events } = setup();
  await routing.routeOpenCards([eng(1)]);
  await routing.routeOpenCards([eng(1)]);
  assert.equal(routing.store.decisions().length, 1);
  assert.equal(events.length, 1);
});

test('退回失败不抛出、卡片保持开放，退避期内不重试', async () => {
  const { routing, events } = setup({ fail: true });
  let calls = 0;
  const r = createCardRouting({ store: routing.store, postEvent: async () => { calls += 1; throw new Error('x'); }, resolveCard: async () => {}, delegateStore: createCardDelegateStore(), onError: () => {} });
  assert.deepEqual(await r.routeOpenCards([eng(1)]), []);
  await r.routeOpenCards([eng(1)]);
  assert.equal(calls, 1);
  assert.equal(events.length, 0);
});

test('重启后从持久化文件恢复版本与模式', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'card-routing-')), 'sub', 'store.json');
  const make = () => createCardRouting({ persistFile: file, postEvent: async () => ({}), resolveCard: async () => {}, onError: () => {} });
  const a = make();
  const v = a.store.createVersion({ rules: [{ id: 'eng-bug', route: 'scheduler', tags: ['eng:bug'], confidence: 0.9 }] });
  a.store.recordValidation(v.version, { total: 17, humanGateFalseAuto: 0, passed: true });
  a.activate(v.version);
  const b = make();
  assert.equal(b.status().mode, 'active');
  assert.equal(b.status().version, 'v1');
});

test('activate 未通过评测或有人工门禁误路由时被拒；rollback 回到 shadow', async () => {
  const { routing } = setup({ activate: false });
  const v1 = routing.store.createVersion({ rules: [] });
  assert.throws(() => routing.activate(v1.version), { code: 'VALIDATION_REQUIRED' });
  routing.store.recordValidation(v1.version, { total: 17, humanGateFalseAuto: 1, passed: true });
  assert.throws(() => routing.activate(v1.version), { code: 'VALIDATION_REQUIRED' });
  routing.store.recordValidation(v1.version, { total: 17, humanGateFalseAuto: 0, passed: true });
  assert.equal(routing.activate(v1.version).mode, 'active');
  assert.equal(routing.rollback().mode, 'shadow');
});

test('API：GET 状态、activate 校验失败 400、成功后 rollback；写入需控制台标记', async () => {
  const hub = await fakeHub((req, res) => json(res, { ok: true }));
  const root = mkdtempSync(path.join(tmpdir(), 'card-routing-api-'));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const routing = createCardRouting({ postEvent: async () => ({}), resolveCard: async () => {}, onError: () => {} });
  const bad = routing.store.createVersion({ rules: [] });
  const good = routing.store.createVersion({ rules: [] });
  routing.store.recordValidation(good.version, { total: 17, humanGateFalseAuto: 0, passed: true });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', root, cardRouting: routing });
  const url = await listen(server);
  const headers = { 'x-console-request': '1', 'content-type': 'application/json' };
  const post = (p, body) => fetch(`${url}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const status = await (await fetch(`${url}/api/card-router`)).json();
    assert.equal(status.mode, 'shadow');
    assert.equal((await fetch(`${url}/api/card-router/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"version":"v2"}' })).status, 403);
    assert.equal((await post('/api/card-router/activate', { version: bad.version })).status, 400);
    assert.equal((await post('/api/card-router/activate', { version: 'v99' })).status, 404);
    assert.equal((await post('/api/card-router/activate', {})).status, 400);
    const ok = await post('/api/card-router/activate', { version: good.version });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).mode, 'active');
    assert.equal((await (await post('/api/card-router/rollback', {})).json()).mode, 'shadow');
  } finally { await close(server); await close(hub.server); }
});
