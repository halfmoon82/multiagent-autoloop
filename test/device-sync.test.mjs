// device-sync 节点（Spec §7 / DAG plan wave-5 / issue 12）边界测试：
// 多设备同步（任意一台提交后其他设备同步）、审计完善、设备丢失后授权解除不影响其他设备。
// 异常行为：同步失败保留最新一致状态并提示；解除授权立即生效。
// 全部是纯逻辑 / 注入 transport，不调用真实模型、真机推送或生物识别。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
