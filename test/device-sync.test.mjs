// device-sync 节点（Spec §7 / DAG plan wave-5 / issue 12）边界测试：
// 多设备同步（任意一台提交后其他设备同步）、审计完善、设备丢失后授权解除不影响其他设备。
// 异常行为：同步失败保留最新一致状态并提示；解除授权立即生效。
// 全部是纯逻辑 / 注入 transport，不调用真实模型、真机推送或生物识别。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DECISION_KINDS, createSyncState, normalizeSyncState, applySubmission,
  reconcile, syncPrompt, processedCardKeys, SyncStateError,
} from '../mobile/src/features/device-sync/index.mjs';
import { createDeviceStore, DeviceAuthError } from '../src/device-auth.mjs';
import { CardNotifier } from '../src/notifier.mjs';

const AT = '2026-11-19T02:00:00.000Z';

// 确定性随机源：token 只在创建时出现一次。
function seqRandom() {
  let seq = 0;
  return () => Buffer.from(`${String(++seq).padStart(64, '0')}`, 'hex');
}
function makeStore(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'device-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = Date.parse(AT);
  const store = createDeviceStore({ file: path.join(root, 'device-auth.json'), now: () => new Date(clock), random: seqRandom() });
  return { store, root, file: path.join(root, 'device-auth.json') };
}
function bind(store, name, platform = 'Android') {
  const qr = store.createBinding();
  const result = store.bindDevice({ token: qr.token, name, platform });
  return { ...result, qr };
}

// ---------------------------------------------------------------------------
// 纯状态机
// ---------------------------------------------------------------------------
test('createSyncState 是空且一致的初始状态；normalizeSyncState 对损坏输入回退空态', () => {
  const s = createSyncState();
  assert.equal(s.revision, 0);
  assert.deepEqual(s.decisions, {});
  assert.equal(s.updatedAt, null);
  for (const bad of [null, undefined, 'x', 42, [], { revision: -3, decisions: [] }]) {
    const n = normalizeSyncState(bad);
    assert.equal(n.revision, 0);
    assert.deepEqual(n.decisions, {});
  }
});

test('applySubmission 任意一台提交即推进版本并记录结论，重复提交幂等', () => {
  const s0 = createSyncState();
  const s1 = applySubmission(s0, { cardId: 'c-7', decision: 'approve', deviceId: 'dev_A' }, AT);
  assert.equal(s1.revision, 1);
  assert.equal(s1.decisions['c-7'].value, 'approve');
  assert.equal(s1.decisions['c-7'].byDevice, 'dev_A');
  assert.equal(s1.updatedAt, AT);
  const s2 = applySubmission(s1, { cardId: 'c-7', decision: 'approve', deviceId: 'dev_A' }, AT);
  assert.equal(s2.revision, 1, '同一设备同一结论不重复推进版本');
  const s3 = applySubmission(s1, { cardId: 'c-7', decision: 'reject', deviceId: 'dev_B' }, AT);
  assert.equal(s3.revision, 2, '另一台改判推进版本');
  assert.equal(s3.decisions['c-7'].value, 'reject');
  assert.deepEqual(s0.decisions, {}, '纯函数不修改入参');
});

test('applySubmission 校验 cardId/结论/设备，非法输入不改状态', () => {
  const s = createSyncState();
  assert.throws(() => applySubmission(s, { cardId: '', decision: 'approve', deviceId: 'dev_A' }, AT), e => e instanceof SyncStateError && e.code === 'INVALID_SUBMISSION');
  assert.throws(() => applySubmission(s, { cardId: 'c', decision: 'token=secret', deviceId: 'dev_A' }, AT), e => e instanceof SyncStateError && e.code === 'INVALID_DECISION');
  assert.throws(() => applySubmission(s, { cardId: 'c', decision: 'approve', deviceId: '' }, AT), e => e instanceof SyncStateError && e.code === 'INVALID_DEVICE');
  assert.deepEqual(DECISION_KINDS, ['approve', 'reject', 'note']);
});

test('reconcile 永不回退：远端缺失/更旧/相同都保留本地最新一致状态，更新更采纳远端', () => {
  const newer = applySubmission(createSyncState(), { cardId: 'c', decision: 'approve', deviceId: 'dev_A' }, AT);
  assert.equal(reconcile(newer, null).revision, 1);
  assert.equal(reconcile(newer, { revision: 0, decisions: {} }).revision, 1);
  assert.equal(reconcile(newer, newer).revision, 1);
  const newer2 = applySubmission(newer, { cardId: 'd', decision: 'note', deviceId: 'dev_B' }, AT);
  assert.equal(reconcile(newer, newer2).revision, 2);
  // 远端即便携带可疑字段也不原样采纳：去敏后只留白名单结论
  const tainted = { revision: 3, decisions: { x: { value: 'approve', byDevice: 'dev_A', at: AT, token: 'LEAK' } } };
  const merged = reconcile(newer, tainted);
  assert.ok(!JSON.stringify(merged).includes('LEAK'), 'reconcile 不把远端可疑字段透传');
});

test('syncPrompt 失败时提示保留上次一致状态且不含秘密', () => {
  const s = applySubmission(createSyncState(), { cardId: 'c', decision: 'approve', deviceId: 'dev_A' }, AT);
  const prompt = syncPrompt(s, new Error('token=SECRET_VALUE'));
  assert.equal(prompt.kind, 'stale');
  assert.equal(prompt.revision, 1);
  assert.match(prompt.text, /保留/);
  assert.ok(!prompt.text.includes('SECRET_VALUE'), '提示不得泄露错误里的秘密');
  assert.equal(syncPrompt(s).kind, 'ok');
});

test('processedCardKeys 返回已决卡片标识', () => {
  const s = applySubmission(createSyncState(), { cardId: 'c-7', decision: 'approve', deviceId: 'dev_A' }, AT);
  assert.deepEqual([...processedCardKeys(s)], ['c-7']);
});

// ---------------------------------------------------------------------------
// src/device-auth.mjs：后端是唯一状态源，token 门禁 + 审计 + 落盘
// ---------------------------------------------------------------------------
test('多设备绑定后任意一台提交，其他设备立即可读到一致状态；审计不含令牌', t => {
  const { store } = makeStore(t);
  const a = bind(store, '设备A');
  const b = bind(store, '设备B', 'iOS');
  assert.equal(createSyncState().revision, 0);

  const submitted = store.submitDecision(a.deviceToken, { cardId: 'c-1', decision: 'approve' });
  assert.equal(submitted.revision, 1);
  assert.equal(submitted.decisions['c-1'].byDevice, a.device.id);

  const seen = store.getSyncState(b.deviceToken);
  assert.equal(seen.revision, 1, '另一台 immediately 同步到同一版本');
  assert.equal(seen.decisions['c-1'].value, 'approve');
  const audit = store.listAudit();
  const syncEntry = audit.find(item => item.action === 'sync.submit');
  assert.ok(syncEntry, '提交写入同步审计');
  assert.equal(syncEntry.byDevice, a.device.id);
  const dump = JSON.stringify(audit) + JSON.stringify(seen);
  assert.ok(!dump.includes(a.deviceToken) && !dump.includes(b.deviceToken), '审计与状态不得含设备令牌');
  assert.ok(!dump.includes('tokenHash'));
});

test('设备丢失：解除授权立即生效，且不影响其他设备的同步与状态', t => {
  const { store } = makeStore(t);
  const a = bind(store, '设备A');
  const b = bind(store, '设备B', 'iOS');
  store.submitDecision(a.deviceToken, { cardId: 'c-1', decision: 'approve' });
  const before = store.getSyncState(b.deviceToken);

  const revoked = store.revokeDevice(a.device.id, { type: 'admin' });
  assert.equal(revoked.status, 'revoked');
  assert.throws(() => store.submitDecision(a.deviceToken, { cardId: 'c-2', decision: 'note' }), e => e instanceof DeviceAuthError && e.code === 'FORBIDDEN', '被解除设备立即不能提交');
  assert.throws(() => store.getSyncState(a.deviceToken), e => e instanceof DeviceAuthError && e.code === 'FORBIDDEN', '被解除设备立即不能读取');

  const after = store.getSyncState(b.deviceToken);
  assert.deepEqual(after, before, '解除 A 不改变共享状态，B 视图不受影响');
  const bSubmit = store.submitDecision(b.deviceToken, { cardId: 'c-2', decision: 'note' });
  assert.equal(bSubmit.revision, 2, 'B 仍可继续提交');
  assert.equal(bSubmit.decisions['c-2'].byDevice, b.device.id);
});

test('同步状态原子落盘：重启后版本与结论保留', t => {
  const { store, file } = makeStore(t);
  const a = bind(store, '设备A');
  store.submitDecision(a.deviceToken, { cardId: 'c-9', decision: 'reject' });
  const reopened = createDeviceStore({ file, now: () => new Date(Date.parse(AT) + 1000), random: seqRandom() });
  const state = reopened.getSyncState(a.deviceToken);
  assert.equal(state.revision, 1);
  assert.equal(state.decisions['c-9'].value, 'reject');
  assert.ok(reopened.listAudit().some(item => item.action === 'sync.submit'));
});

// ---------------------------------------------------------------------------
// src/notifier.mjs：跨设备同步与失败保留最新一致状态
// ---------------------------------------------------------------------------
const openCard = (id, title) => ({ id, state: 'open', title, text: '请确认', options: ['同意'], createdAt: AT, project: '/work/demo' });

function notifierWith({ provider, cards }) {
  const notes = [];
  const badges = [];
  const prompts = [];
  const notifier = new CardNotifier({
    intervalMs: 60000,
    routing: null,
    fetchState: async () => ({ cards, nodeEvents: [] }),
    notify: d => notes.push(d),
    setBadge: n => badges.push(n),
    syncState: provider,
    onSyncPrompt: p => prompts.push(p),
  });
  return { notes, badges, prompts, notifier };
}

test('任意一台提交后其他设备同步：已决卡片从通知与角标中消失', async () => {
  let shared = createSyncState();
  const cards = [openCard(1, '待审批'), openCard(2, '待确认')];
  const { notes, badges, prompts, notifier } = notifierWith({ provider: async () => shared, cards });
  await notifier.poll(); // seed
  assert.equal(badges.at(-1), 2);

  // 另一台设备提交了对卡片 1 的决定
  shared = applySubmission(shared, { cardId: '1', decision: 'approve', deviceId: 'dev_A' }, AT);
  await notifier.poll();
  assert.equal(badges.at(-1), 1, '设备 B 角标随其他设备提交同步减少');
  assert.equal(notes.length, 0, '已决卡片不再产生待办通知');
  assert.equal(prompts.length, 0);
});

test('同步失败保留最新一致状态并提示，不回退到旧状态', async () => {
  let shared = applySubmission(createSyncState(), { cardId: '1', decision: 'approve', deviceId: 'dev_A' }, AT);
  let fail = false;
  const cards = [openCard(1, '待审批'), openCard(2, '待确认')];
  const { badges, prompts, notifier } = notifierWith({ provider: async () => { if (fail) throw new Error('同步不可用'); return shared; }, cards });
  await notifier.poll();
  assert.equal(badges.at(-1), 1, '已同步到卡片 1 已决');

  fail = true;
  await assert.doesNotReject(() => notifier.poll());
  assert.equal(badges.at(-1), 1, '同步失败仍保留上次一致状态，不回退');
  assert.equal(prompts.at(-1).kind, 'stale');
  assert.match(prompts.at(-1).text, /保留/);
});

test('无 syncState 提供者时 notifier 行为不变', async () => {
  const notes = [];
  let cards = [openCard(1, '待审批')];
  const notifier = new CardNotifier({
    intervalMs: 60000, routing: null,
    fetchState: async () => ({ cards, nodeEvents: [] }),
    notify: d => notes.push(d),
  });
  await notifier.poll(); // seed
  await notifier.poll();
  assert.equal(notes.length, 0, '未注入跨设备同步时维持原有去重行为');
  cards = [openCard(1, '待审批'), openCard(2, '新待办')];
  await notifier.poll();
  assert.equal(notes.length, 1, '新增待办仍按原有逻辑通知一次');
});

// ---------------------------------------------------------------------------
// sync-audit 节点：GET/POST /api/mobile/sync 路由 + 关键操作审计（来源设备/时间/结果）
// ---------------------------------------------------------------------------
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json as hubJson, listen, close } from './helpers.mjs';

async function syncSetup(t, { failAuditFor = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'device-sync-http-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cards = [{ id: 7, state: 'open', title: 't', options: ['a', 'b'] }];
  const hub = await fakeHub((req, res) => {
    if (req.url === '/v1/state') return hubJson(res, { cards });
    if (/^\/v1\/cards\/\d+\/answer$/.test(req.url)) { cards[0].state = 'decided'; return hubJson(res, { changed: true }); }
    return hubJson(res, { ok: true });
  });
  const store = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const a = store.bindDevice({ token: store.createBinding().token, name: '手机A', platform: 'Android' });
  const b = store.bindDevice({ token: store.createBinding().token, name: '手机B', platform: 'Android' });
  if (failAuditFor) {
    const original = store.recordDeviceEvent;
    store.recordDeviceEvent = (...args) => { if (args[1] === failAuditFor) throw new Error('disk full'); return original(...args); };
  }
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ rules: [], agents: {}, sources: {} }));
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'k', sourceKey: 's', host: '127.0.0.1', root, rulesFile, projectRoots: [], deviceAuth: store,
  }, { async notifyCardAnswered() { return true; }, async listArchived() { return []; } });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); });
  return { url, store, a, b };
}

function call(base, pathname, { method = 'GET', token, body } = {}) {
  const origin = new URL(base).origin;
  return fetch(base + pathname, {
    method,
    headers: {
      'x-console-request': '1', 'x-forwarded-proto': 'https', origin, connection: 'close',
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(token ? { 'x-device-token': token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(6000),
  });
}

test('sync 路由：A 设备提交后 B 设备 GET 拿到新版本与来源设备', async t => {
  const { url, a, b } = await syncSetup(t);
  const posted = await call(url, '/api/mobile/sync', { method: 'POST', token: a.deviceToken, body: { cardId: 'c-1', decision: 'approve' } });
  assert.equal(posted.status, 200);
  const postBody = await posted.json();
  assert.equal(postBody.state.revision, 1);
  assert.equal(postBody.conflict, false);
  const got = await (await call(url, '/api/mobile/sync', { token: b.deviceToken })).json();
  assert.equal(got.state.revision, 1);
  assert.equal(got.state.decisions['c-1'].byDevice, a.device.id);
  assert.equal(got.device.id, b.device.id, '只返回自身设备信息');
  assert.equal(JSON.stringify(got).includes(a.deviceToken), false);
});

test('sync 路由：基于旧版本的提交冲突取最新、不双写，并提示 conflict', async t => {
  const { url, a, b } = await syncSetup(t);
  await call(url, '/api/mobile/sync', { method: 'POST', token: a.deviceToken, body: { cardId: 'c-1', decision: 'approve' } });
  const stale = await (await call(url, '/api/mobile/sync', { method: 'POST', token: b.deviceToken, body: { cardId: 'c-1', decision: 'reject', baseRevision: 0 } })).json();
  assert.equal(stale.conflict, true);
  assert.equal(stale.state.decisions['c-1'].value, 'reject', '最新提交为准');
  assert.equal(stale.state.revision, 2);
  const again = await (await call(url, '/api/mobile/sync', { method: 'POST', token: b.deviceToken, body: { cardId: 'c-1', decision: 'reject', baseRevision: 2 } })).json();
  assert.equal(again.state.revision, 2, '重复提交不双写');
  assert.equal(again.conflict, false);
});

test('sync 路由：移动端访问他人设备 403；非法结论 400', async t => {
  const { url, a, b } = await syncSetup(t);
  assert.equal((await call(url, `/api/mobile/sync?deviceId=${encodeURIComponent(b.device.id)}`, { token: a.deviceToken })).status, 403);
  assert.equal((await call(url, `/api/mobile/sync?deviceId=${encodeURIComponent(a.device.id)}`, { token: a.deviceToken })).status, 200);
  assert.equal((await call(url, '/api/mobile/sync', { method: 'POST', token: a.deviceToken, body: { cardId: 'c-1', decision: 'approve', deviceId: b.device.id } })).status, 403);
  assert.equal((await call(url, '/api/mobile/sync', { method: 'POST', token: a.deviceToken, body: { cardId: 'c-1', decision: 'nuke' } })).status, 400);
});

test('审计：绑定/解除/重命名/同步提交均含来源设备、时间、结果；被拒操作记 denied', async t => {
  const { store, a, b } = await syncSetup(t);
  store.renameDevice(a.device.id, '新名字', { type: 'device', deviceId: a.device.id });
  assert.throws(() => store.revokeDevice(b.device.id, { type: 'device', deviceId: a.device.id }), error => error.status === 403);
  store.revokeDevice(a.device.id, { type: 'admin' });
  const audit = store.listAudit();
  const bindA = audit.find(item => item.action === 'bind' && item.deviceId === a.device.id);
  assert.ok(bindA.at && bindA.result === 'ok' && bindA.source);
  const rename = audit.find(item => item.action === 'rename');
  assert.equal(rename.byDevice, a.device.id);
  const denied = audit.find(item => item.action === 'revoke' && item.result === 'denied');
  assert.equal(denied.byDevice, a.device.id);
  assert.equal(denied.deviceId, b.device.id);
  assert.equal(store.listDevices().find(item => item.id === b.device.id).status, 'authorized', '他人设备未被解除');
});

test('审计：移动端卡片回答写审计（来源设备+结果）；审计写失败不吞为成功', async t => {
  const ok = await syncSetup(t);
  const res = await call(ok.url, '/api/mobile/cards/7/answer', { method: 'POST', token: ok.a.deviceToken, body: { choice: 0 } });
  assert.equal(res.status, 200);
  const entry = ok.store.listAudit().find(item => item.action === 'card.answer');
  assert.equal(entry.byDevice, ok.a.device.id);
  assert.equal(entry.cardId, '7');
  assert.equal(entry.result, 'ok');

  const bad = await syncSetup(t, { failAuditFor: 'card.answer' });
  const failed = await call(bad.url, '/api/mobile/cards/7/answer', { method: 'POST', token: bad.a.deviceToken, body: { choice: 0 } });
  assert.ok(failed.status >= 500, `审计写失败必须报错，实际 ${failed.status}`);
  assert.equal(JSON.stringify(await failed.json()).includes('disk full'), false);
});

// ---- 移动端设备页视图模型与同步客户端 ----
import { buildDeviceView, createDeviceSyncClient } from '../mobile/src/features/device-sync/index.mjs';

test('buildDeviceView 展示本机绑定信息与同步版本；失败保留版本并提示', () => {
  const payload = { device: { name: '手机A', platform: 'Android', status: 'authorized', boundAt: AT, lastActiveAt: null }, state: { revision: 3, decisions: {}, updatedAt: AT } };
  const ok = buildDeviceView(payload);
  assert.equal(ok.kind, 'ok');
  assert.deepEqual(ok.rows.find(row => row[0] === '同步版本'), ['同步版本', '3']);
  const stale = buildDeviceView(payload, new Error('boom token=secret'));
  assert.equal(stale.kind, 'stale');
  assert.match(stale.syncText, /版本 3/);
  assert.equal(JSON.stringify(stale).includes('secret'), false);
  assert.deepEqual(buildDeviceView(null).rows, []);
});

test('createDeviceSyncClient 只打 /api/mobile/sync 并带设备令牌；未绑定不发请求；错误可读', async () => {
  const calls = [];
  const client = { origin: 'https://console.example', tokenStore: { get: async () => 'tok' } };
  const api = createDeviceSyncClient(client, { fetchImpl: async (url, init) => { calls.push([url, init]); return { ok: true, json: async () => ({ state: { revision: 1 } }) }; } });
  assert.equal((await api.fetchSync()).state.revision, 1);
  assert.equal(calls[0][0], 'https://console.example/api/mobile/sync');
  assert.equal(calls[0][1].headers['x-device-token'], 'tok');
  const none = createDeviceSyncClient({ ...client, tokenStore: { get: async () => null } }, { fetchImpl: async () => { throw new Error('不应发请求'); } });
  await assert.rejects(none.fetchSync(), /尚未绑定/);
  const denied = createDeviceSyncClient(client, { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: '移动端只能访问本机设备的同步信息' }) }) });
  await assert.rejects(denied.fetchSync(), /只能访问本机/);
});
