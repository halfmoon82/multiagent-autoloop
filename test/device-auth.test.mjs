import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeviceStore, DeviceAuthError, BINDING_TTL_MS } from '../src/device-auth.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { listen, close } from './helpers.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'device-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'device-auth.json') };
}

// 确定性随机源：每次调用返回不同的 32 字节，便于断言 token 不被写进公开结构。
function seqRandom() {
  let seq = 0;
  return () => Buffer.from(`${String(++seq).padStart(64, '0')}`, 'hex');
}

function makeStore(t, overrides = {}) {
  const { file } = fixture(t);
  let clock = Date.parse('2026-11-19T00:00:00.000Z');
  const now = () => new Date(clock);
  const store = createDeviceStore({ file, now, random: seqRandom(), ...overrides });
  return { store, file, advance: ms => { clock += ms; } };
}

function bind(store, name = 'Pixel 8', platform = 'Android') {
  const qr = store.createBinding();
  const result = store.bindDevice({ token: qr.token, name, platform });
  return { qr, ...result };
}

test('createBinding 生成一次性二维码令牌并按 TTL 过期，令牌本身不进入公开结构', t => {
  const { store } = makeStore(t);
  const qr = store.createBinding();
  assert.match(qr.token, /^[0-9a-f]{64}$/);
  assert.ok(qr.qrPayload.includes(qr.token), '二维码载荷携带一次性令牌');
  assert.equal(Date.parse(qr.expiresAt) - Date.parse(qr.createdAt || '2026-11-19T00:00:00.000Z'), BINDING_TTL_MS);
  assert.ok(!JSON.stringify(store.listDevices()).includes(qr.token));
  assert.ok(!JSON.stringify(store.listAudit()).includes(qr.token));
});

test('绑定成功后二维码作废：重复使用、过期、未知令牌都给出可读错误', t => {
  const { store, advance } = makeStore(t);
  const qr = store.createBinding();
  const bound = store.bindDevice({ token: qr.token, name: 'Pixel 8', platform: 'Android' });
  assert.equal(bound.device.status, 'authorized');
  assert.match(bound.deviceToken, /^[0-9a-f]{64}$/);
  assert.throws(() => store.bindDevice({ token: qr.token, name: '其他设备', platform: 'iOS' }), error => error instanceof DeviceAuthError && error.code === 'BINDING_USED');

  const expired = store.createBinding();
  advance(BINDING_TTL_MS + 1);
  assert.throws(() => store.bindDevice({ token: expired.token, name: '过期设备', platform: 'Android' }), error => error instanceof DeviceAuthError && error.code === 'BINDING_EXPIRED');
  assert.throws(() => store.bindDevice({ token: 'unknown', name: 'x', platform: 'Android' }), error => error instanceof DeviceAuthError && error.code === 'BINDING_INVALID');
});

test('设备列表只返回公开字段，不暴露令牌或凭证哈希', t => {
  const { store } = makeStore(t);
  const { device, deviceToken } = bind(store);
  const list = store.listDevices();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['boundAt', 'id', 'lastActiveAt', 'name', 'platform', 'revokedAt', 'status'].sort());
  const dump = JSON.stringify(list) + JSON.stringify(store.listAudit());
  assert.ok(!dump.includes(deviceToken));
  assert.ok(!dump.includes('tokenHash'));
  assert.ok(!dump.includes('deviceToken'));
  assert.equal(device.name, 'Pixel 8');
});

test('解除授权后设备立即失去访问与通知资格，且解除可重复执行不报错', t => {
  const { store } = makeStore(t);
  const { device, deviceToken } = bind(store);
  assert.equal(store.isAuthorizedToken(deviceToken), true);
  assert.equal(store.touch(deviceToken)?.status, 'authorized');

  const revoked = store.revokeDevice(device.id, { type: 'admin' });
  assert.equal(revoked.status, 'revoked');
  assert.ok(revoked.revokedAt);
  assert.equal(store.isAuthorizedToken(deviceToken), false, 'revoked token must fail the access/notification gate immediately');
  assert.equal(store.touch(deviceToken), null);
  assert.equal(store.revokeDevice(device.id, { type: 'admin' }).status, 'revoked');
  assert.throws(() => store.revokeDevice('dev_missing'), error => error instanceof DeviceAuthError && error.status === 404);
});

test('设备凭据只能解除自身，不能解除其他设备；网页管理后台可解除任意设备', t => {
  const { store } = makeStore(t);
  const a = bind(store, '设备A', 'Android');
  const b = bind(store, '设备B', 'iOS');
  assert.throws(
    () => store.revokeDevice(b.device.id, { type: 'device', deviceId: a.device.id }),
    error => error instanceof DeviceAuthError && error.code === 'FORBIDDEN',
    'a device must not revoke another device',
  );
  assert.throws(
    () => store.revokeDevice(b.device.id, { type: 'device', token: a.deviceToken }),
    error => error instanceof DeviceAuthError && error.code === 'FORBIDDEN',
  );
  assert.equal(store.revokeDevice(b.device.id, { type: 'device', deviceId: b.device.id }).status, 'revoked');
  assert.equal(store.revokeDevice(a.device.id, { type: 'admin' }).status, 'revoked');
  assert.equal(a.device.status, 'authorized', 'returned public snapshot must not mutate with store state');
});

test('审计记录覆盖创建二维码、绑定、重命名与解除，操作来源可追溯且不含秘密', t => {
  const { store } = makeStore(t);
  const { qr, device, deviceToken } = bind(store, 'Pixel 8', 'Android');
  store.renameDevice(device.id, 'Pixel 8 Pro', { type: 'admin' });
  store.revokeDevice(device.id, { type: 'admin' });
  const audit = store.listAudit();
  assert.deepEqual(audit.map(item => item.action), ['qr.create', 'bind', 'rename', 'revoke']);
  assert.ok(audit.every(item => item.at && item.source));
  assert.equal(store.listDevices()[0].name, 'Pixel 8 Pro');
  const dump = JSON.stringify(audit);
  assert.ok(!dump.includes(qr.token) && !dump.includes(deviceToken));
});

test('绑定输入校验：缺少名称或平台、名称过长都拒绝且不改状态', t => {
  const { store } = makeStore(t);
  const qr = store.createBinding();
  assert.throws(() => store.bindDevice({ token: qr.token, name: '', platform: 'Android' }), error => error instanceof DeviceAuthError && error.status === 400);
  assert.throws(() => store.bindDevice({ token: qr.token, name: 'Pixel 8', platform: '' }), error => error instanceof DeviceAuthError && error.status === 400);
  assert.throws(() => store.bindDevice({ token: qr.token, name: 'x'.repeat(81), platform: 'Android' }), error => error instanceof DeviceAuthError && error.status === 400);
  assert.equal(store.listDevices().length, 0);
  // 校验失败不消耗二维码
  assert.equal(store.bindDevice({ token: qr.token, name: 'Pixel 8', platform: 'Android' }).device.status, 'authorized');
});

test('授权状态原子落盘：重启后用同一文件读到设备、审计与已作废的二维码', t => {
  const { store, file } = makeStore(t);
  const { qr, device } = bind(store);
  store.revokeDevice(device.id, { type: 'admin' });
  const reopened = createDeviceStore({ file, now: () => new Date('2026-11-19T01:00:00.000Z'), random: seqRandom() });
  assert.equal(reopened.listDevices()[0].status, 'revoked');
  assert.equal(reopened.listAudit().length, 3);
  assert.throws(() => reopened.bindDevice({ token: qr.token, name: '重复绑定', platform: 'Android' }), error => error.code === 'BINDING_USED');
});

test('台账损坏时按空表处理，不阻断读取与后续绑定', t => {
  const { root, file } = fixture(t);
  writeFileSync(file, '{corrupt');
  const store = createDeviceStore({ file, now: () => new Date(), random: seqRandom() });
  assert.deepEqual(store.listDevices(), []);
  assert.equal(bind(store).device.status, 'authorized');
  assert.equal(store.listDevices().length, 1);
  assert.equal(readFileSync(file, 'utf8').includes('tokenHash'), true, 'hash persisted, raw token not');
});

const base = { hubUrl: 'http://127.0.0.1:1', ownerKey: 'server-secret', host: '127.0.0.1' };
function writeHeaders(body) {
  return { 'content-type': 'application/json', 'x-console-request': '1' };
}

test('GET /api/devices 返回设备与审计，且不含任何令牌', async t => {
  const { root } = fixture(t);
  const store = createDeviceStore({ file: path.join(root, 'device-auth.json'), random: seqRandom() });
  const { deviceToken } = bind(store);
  const server = createConsoleServer({ ...base, root, deviceAuth: store });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/devices`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.devices.length, 1);
    assert.equal(body.audit.length, 2);
    assert.ok(!JSON.stringify(body).includes(deviceToken));
  } finally { await close(server); }
});

test('设备 API 写操作沿用现有安全校验，走通二维码→绑定→解除全链路', async t => {
  const { root } = fixture(t);
  const server = createConsoleServer({ ...base, root });
  const url = await listen(server);
  const post = (path, body, headers = writeHeaders()) => fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const denied = await post('/api/devices/bindings', {}, { 'content-type': 'application/json' });
    assert.equal(denied.status, 403, 'write endpoints keep the console request marker check');

    const qrResponse = await post('/api/devices/bindings', {});
    assert.equal(qrResponse.status, 201);
    const qr = await qrResponse.json();
    assert.match(qr.token, /^[0-9a-f]{64}$/);

    const badBind = await post('/api/devices/bind', { token: qr.token, name: '', platform: 'Android' });
    assert.equal(badBind.status, 400);

    const bindResponse = await post('/api/devices/bind', { token: qr.token, name: 'Pixel 8', platform: 'Android' });
    assert.equal(bindResponse.status, 201);
    const bound = await bindResponse.json();
    assert.equal(bound.device.status, 'authorized');

    let list = await (await fetch(`${url}/api/devices`)).json();
    assert.equal(list.devices.length, 1);
    assert.ok(!JSON.stringify(list).includes(bound.deviceToken));

    const reuse = await post('/api/devices/bind', { token: qr.token, name: '重复', platform: 'Android' });
    assert.equal(reuse.status, 409);

    const revokeResponse = await post(`/api/devices/${encodeURIComponent(bound.device.id)}/revoke`, {});
    assert.equal(revokeResponse.status, 200);
    assert.equal((await revokeResponse.json()).status, 'revoked');

    list = await (await fetch(`${url}/api/devices`)).json();
    assert.equal(list.devices[0].status, 'revoked');
    assert.deepEqual(list.audit.map(item => item.action), ['qr.create', 'bind', 'revoke']);
    assert.ok(!JSON.stringify(list).includes(bound.deviceToken));
  } finally { await close(server); }
});

test('设备重命名走同一后台校验，审计来源标记为管理后台', async t => {
  const { root } = fixture(t);
  const server = createConsoleServer({ ...base, root });
  const url = await listen(server);
  const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(body) });
  try {
    const qr = await (await post('/api/devices/bindings', {})).json();
    const bound = await (await post('/api/devices/bind', { token: qr.token, name: '旧名称', platform: 'Android' })).json();
    const renamed = await post(`/api/devices/${encodeURIComponent(bound.device.id)}/rename`, { name: '新名称' });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).name, '新名称');
    const list = await (await fetch(`${url}/api/devices`)).json();
    assert.equal(list.devices[0].name, '新名称');
    assert.equal(list.audit.find(item => item.action === 'rename').source, 'admin');
  } finally { await close(server); }
});
