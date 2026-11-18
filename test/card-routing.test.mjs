import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// ---- 发布入口（issue #93）：评测通过才注册版本、原子落盘、不默认 activate、幂等 ----
const PUB_RULES = () => [{ id: 'eng-bug', route: 'scheduler', tags: ['eng:bug'], confidence: 0.9 }];
const pubRouting = file => createCardRouting({
  persistFile: file, postEvent: async () => ({}), resolveCard: async () => {}, onError: () => {},
});

test('publish：评测通过才注册 v1（parentVersion=null），不默认 activate，原子落盘', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'card-pub-')), 'card-router', 'store.json');
  const routing = pubRouting(file);
  const r = await routing.publish({ rules: PUB_RULES() });
  assert.equal(r.published, true);
  assert.equal(r.created, true);
  assert.equal(r.version, 'v1');
  assert.equal(r.mode, 'shadow', '发布不得自动 activate');
  const v1 = routing.store.getVersion('v1');
  assert.equal(v1.parentVersion, null);
  assert.equal(v1.validation.passed, true);
  assert.equal(v1.validation.humanGateFalseAuto, 0);
  assert.equal(routing.status().mode, 'shadow');
  assert.ok(existsSync(file));
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.versions.length, 1);
  assert.equal(disk.versions[0].version, 'v1');
  assert.equal(disk.versions[0].validation.passed, true);
});

test('publish 幂等：同规则重复发布不产生 v2；规则变化才生成 v2 并带 parentVersion', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'card-pub-')), 'card-router', 'store.json');
  const routing = pubRouting(file);
  const rulesA = PUB_RULES();
  const first = await routing.publish({ rules: rulesA });
  const again = await routing.publish({ rules: rulesA });
  assert.equal(again.published, true);
  assert.equal(again.created, false);
  assert.equal(again.version, first.version);
  assert.equal(routing.store.versions().length, 1);
  const rulesB = [{ id: 'eng-test', route: 'scheduler', tags: ['eng:test'], confidence: 0.9 }];
  const second = await routing.publish({ rules: rulesB });
  assert.equal(second.created, true);
  assert.equal(second.version, 'v2');
  assert.equal(routing.store.getVersion('v2').parentVersion, 'v1');
});

test('publish：评测未通过不注册版本，activate 仍拒绝不存在的版本', async () => {
  const routing = pubRouting(null);
  const r = await routing.publish({ samples: [{ title: '修复测试', expected: 'human' }] });
  assert.equal(r.published, false);
  assert.equal(r.version, null);
  assert.equal(r.created, false);
  assert.equal(routing.store.versions().length, 0);
  assert.throws(() => routing.activate('v1'), { code: 'VERSION_MISSING' });
});

test('publish：快照写入失败抛可读错误，不静默吞掉', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'card-pub-err-'));
  const blocker = path.join(dir, 'file');
  writeFileSync(blocker, 'x');
  const file = path.join(blocker, 'card-router', 'store.json'); // 父路径是文件 → 写入必失败
  const routing = pubRouting(file);
  await assert.rejects(
    () => routing.publish({ rules: PUB_RULES() }),
    error => error.code === 'SNAPSHOT_WRITE_FAILED' && /快照写入失败/.test(error.message),
  );
});

test('publish 落盘后重启可见：GET 状态含 validation 摘要，activate 成功且不放松门禁', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'card-pub-')), 'card-router', 'store.json');
  await pubRouting(file).publish({ rules: PUB_RULES() });
  const b = pubRouting(file);
  const status = b.status();
  assert.equal(status.mode, 'shadow', '发布后未激活');
  assert.equal(status.version, null);
  assert.equal(status.versions.length, 1);
  assert.equal(status.versions[0].version, 'v1');
  assert.equal(status.versions[0].validation.passed, true);
  assert.equal(status.versions[0].validation.humanGateFalseAuto, 0);
  assert.equal(b.activate('v1').mode, 'active');
  assert.equal(b.status().version, 'v1');
  assert.equal(b.status().mode, 'active');
  // activate 既有校验未放松：无 validation 的新版本仍被拒
  const v2 = b.store.createVersion({ rules: [] });
  assert.throws(() => b.activate(v2.version), { code: 'VALIDATION_REQUIRED' });
});

test('API：publish 后 GET 显示 v1 与 validation 摘要，POST activate 返回 mode=active', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'card-pub-api-'));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const file = path.join(root, 'card-router', 'store.json');
  const routing = pubRouting(file);
  await routing.publish({ rules: PUB_RULES() });
  const hub = await fakeHub((req, res) => json(res, { ok: true }));
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', root, cardRouting: routing });
  const url = await listen(server);
  const headers = { 'x-console-request': '1', 'content-type': 'application/json' };
  try {
    const status = await (await fetch(`${url}/api/card-router`)).json();
    assert.equal(status.mode, 'shadow');
    assert.equal(status.versions.length, 1);
    assert.equal(status.versions[0].version, 'v1');
    assert.equal(status.versions[0].validation.passed, true);
    const ok = await fetch(`${url}/api/card-router/activate`, { method: 'POST', headers, body: JSON.stringify({ version: 'v1' }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).mode, 'active');
    assert.equal((await (await fetch(`${url}/api/card-router`)).json()).version, 'v1');
  } finally { await close(server); await close(hub.server); }
});

// ---- 服务端 publish 路由与单一写者（issue #97）----
test('API：POST publish → POST activate v1 → GET mode=active 全程无需重启；写入需控制台标记', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'card-pub-api97-'));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const file = path.join(root, 'card-router', 'store.json');
  const routing = pubRouting(file);
  const hub = await fakeHub((req, res) => json(res, { ok: true }));
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', root, cardRouting: routing });
  const url = await listen(server);
  const headers = { 'x-console-request': '1', 'content-type': 'application/json' };
  const post = (p, body, h = headers) => fetch(`${url}${p}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  try {
    // 缺控制台标记 → 403（沿用既有写操作校验门）
    assert.equal((await post('/api/card-router/publish', { rules: PUB_RULES() }, { 'content-type': 'application/json' })).status, 403);
    // 服务端 publish：评测通过注册 v1，不默认 activate
    const pub = await post('/api/card-router/publish', { rules: PUB_RULES() });
    assert.equal(pub.status, 200);
    const pubBody = await pub.json();
    assert.equal(pubBody.version, 'v1');
    assert.equal(pubBody.mode, 'shadow');
    // 同进程 activate v1（无需重启）
    const act = await post('/api/card-router/activate', { version: 'v1' });
    assert.equal(act.status, 200);
    assert.equal((await act.json()).mode, 'active');
    // GET 显示 active
    const status = await (await fetch(`${url}/api/card-router`)).json();
    assert.equal(status.mode, 'active');
    assert.equal(status.version, 'v1');
  } finally { await close(server); await close(hub.server); }
});

test('API：publish 评测未通过不注册版本，仍返回 published=false', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'card-pub-api97b-'));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const routing = pubRouting(null);
  const hub = await fakeHub((req, res) => json(res, { ok: true }));
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', root, cardRouting: routing });
  const url = await listen(server);
  const headers = { 'x-console-request': '1', 'content-type': 'application/json' };
  try {
    const pub = await fetch(`${url}/api/card-router/publish`, { method: 'POST', headers, body: JSON.stringify({ samples: [{ title: '修复测试', expected: 'human' }] }) });
    assert.equal(pub.status, 200);
    const body = await pub.json();
    assert.equal(body.published, false);
    assert.equal(body.version, null);
    assert.equal(routing.store.versions().length, 0);
  } finally { await close(server); await close(hub.server); }
});

test('跨进程双写：CLI 发布 v1 落盘后，server 记录决策重读快照不丢 v1 且可直接 activate', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'card-dual97-')), 'card-router', 'store.json');
  const make = () => createCardRouting({ persistFile: file, postEvent: async () => ({}), resolveCard: async () => {}, onError: () => {} });
  // 运行中 server：启动时文件不存在，内存无版本
  const server = make();
  assert.equal(server.status().versions.length, 0);
  // CLI 进程：独立实例发布 v1 写盘
  const cli = make();
  const pub = await cli.publish({ rules: PUB_RULES() });
  assert.equal(pub.version, 'v1');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).versions.length, 1);
  // server 记录一条决策并持久化（模拟 notifier 轮询）
  await server.routeOpenCards([eng(1)]);
  // 任一侧 persist 不得抹去另一侧已落盘的通过版本
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(disk.versions.some(v => v.version === 'v1' && v.validation?.passed));
  assert.equal(server.status().versions.length, 1);
  assert.equal(server.status().versions[0].version, 'v1');
  // 修复「activate 报版本不存在」：重读后同进程直接激活
  assert.equal(server.activate('v1').mode, 'active');
});

test('CLI --publish 输出注明运行中 server 需重读/重启方生效的影响边界', () => {
  const script = path.resolve('scripts/card-filter-evaluate.mjs');
  const home = mkdtempSync(path.join(tmpdir(), 'cfe-notice97-'));
  const res = spawnSync('node', [script, '--publish', '--home', home], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /重启|重读|生效/);
});
