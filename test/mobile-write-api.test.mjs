// mobile-write-api 节点契约测试：移动端写路由与网页控制台复用同一服务函数。
// 覆盖卡片回答/授权、会话恢复/下载、规则 run/pause/resume 的绑定设备成功路径，
// 以及未绑定全拒、非法 id 404、幂等、已失效 409、不暴露内部错误、不放宽网页侧校验。
// 全部走本机假 Hub 与注入会话管理器，不调用真实模型或真实规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const WORKTREE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function makeHub(state) {
  return (req, res, body) => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch { /* 交由被测代码处理畸形输入 */ }
    if (req.url === '/v1/state') return json(res, { cards: state.cards });
    let match;
    if ((match = /^\/v1\/cards\/(\d+)\/answer$/.exec(req.url))) {
      const card = state.cards.find(item => item.id === Number(match[1]));
      if (!card) return json(res, { error: '卡片不存在或已结案' }, 404);
      if (state.boomCards.has(card.id)) return json(res, { error: 'internal detail owner-key=secret', stack: 'db password' }, 500);
      if (card.state !== 'open') return json(res, { id: card.id, state: card.state, answer: card.answer, idempotent: true });
      if (state.conflictCards.has(card.id)) return json(res, { error: '事项已失效' }, 409);
      card.state = 'decided';
      card.answer = payload;
      return json(res, { changed: true, id: card.id, state: card.state });
    }
    if ((match = /^\/v1\/rules\/([^/]+)\/(run|pause|resume)$/.exec(req.url))) {
      return json(res, { ok: true, rule: decodeURIComponent(match[1]), action: match[2], body: payload });
    }
    if (req.url === '/v1/boom') return json(res, { error: 'internal detail owner-key=secret', stack: 'db password' }, 500);
    return json(res, { ok: true, body: payload });
  };
}

function makeSessions(artifact) {
  return {
    calls: [],
    async listArchived() { return [{ id: 'sess-1', project: WORKTREE }, { id: 'sess-2', project: WORKTREE }]; },
    async continueSession(id) { this.calls.push(['continue', id]); return { id, continued: true }; },
    async resolveSessionDownload(id, requested) {
      this.calls.push(['download', id, requested]);
      if (id !== 'sess-1') { const error = new Error('会话不存在'); error.status = 404; throw error; }
      return { name: artifact.name, size: artifact.size, real: artifact.real };
    },
    async notifyCardAnswered(info) { this.calls.push(['notify', info]); return true; },
  };
}

async function setup(t, { cards = [], conflictCards = new Set(), boomCards = new Set() } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-write-api-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactPath = path.join(root, '交付物.apk');
  const artifactBytes = Buffer.from('APK-BYTES-123456');
  writeFileSync(artifactPath, artifactBytes);
  const artifact = { name: '交付物.apk', size: artifactBytes.length, real: artifactPath };
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ rules: [], agents: {}, sources: {} }));

  const state = { cards, conflictCards, boomCards };
  const hub = await fakeHub(makeHub(state));
  const store = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const qr = store.createBinding();
  const bound = store.bindDevice({ token: qr.token, name: '测试手机', platform: 'Android' });
  const sessions = makeSessions(artifact);
  const server = createConsoleServer({
    hubUrl: hub.url,
    ownerKey: 'owner-key',
    sourceKey: 'source-key',
    host: '127.0.0.1',
    root,
    rulesFile,
    projectRoots: [WORKTREE],
    deviceAuth: store,
  }, sessions);
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); });
  return { url, hub, store, sessions, deviceToken: bound.deviceToken, deviceId: bound.device.id, artifactBytes };
}

function mobileFetch(base, pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const target = new URL(base);
  const finalHeaders = {
    'x-console-request': '1',
    'x-forwarded-proto': 'https',
    origin: target.origin,
    ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
    ...(token ? { 'x-device-token': token } : {}),
    ...headers,
  };
  return fetch(base + pathname, {
    method,
    headers: finalHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(6000),
  });
}

const webFetch = (base, pathname, body) => fetch(base + pathname, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-request': '1', origin: new URL(base).origin },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(6000),
});

// ---------- 卡片回答 / 授权 ----------
test('绑定设备可回答卡片，复用网页 /v1/cards/:id/answer 并记录来源设备 id', async t => {
  const ctx = await setup(t, { cards: [{ id: 8, state: 'open', title: '是否重试' }] });
  const response = await mobileFetch(ctx.url, '/api/mobile/cards/8/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 1 } });
  assert.equal(response.status, 200);
  const answerCall = ctx.hub.requests.find(request => request.url === '/v1/cards/8/answer');
  assert.ok(answerCall, '必须复用网页回答端点');
  assert.equal(answerCall.method, 'POST');
  assert.deepEqual(JSON.parse(answerCall.body), { choice: 1, sourceDeviceId: ctx.deviceId });
  assert.ok(ctx.sessions.calls.some(call => call[0] === 'notify'), '回答后唤醒调度会话与网页一致');
});

test('卡片授权走同一回答服务函数，未绑定设备全拒且 hub 零请求', async t => {
  const ctx = await setup(t, { cards: [{ id: 9, state: 'open', title: '授权发布' }] });
  const unbound = await mobileFetch(ctx.url, '/api/mobile/cards/9/authorize', { method: 'POST', body: { approved: true } });
  assert.equal(unbound.status, 401);
  assert.equal(ctx.hub.requests.length, 0);

  const bound = await mobileFetch(ctx.url, '/api/mobile/cards/9/authorize', { method: 'POST', token: ctx.deviceToken, body: { approved: true } });
  assert.equal(bound.status, 200);
  const answerCall = ctx.hub.requests.find(request => request.url === '/v1/cards/9/answer');
  assert.ok(answerCall, '授权必须复用同一回答服务函数，不另造状态');
  assert.equal(JSON.parse(answerCall.body).sourceDeviceId, ctx.deviceId);
});

test('非法卡片 id 404；重复提交幂等返回当前状态；已失效事项 409', async t => {
  const ctx = await setup(t, {
    cards: [{ id: 10, state: 'open' }, { id: 11, state: 'decided', answer: { choice: 0 } }, { id: 12, state: 'open' }],
    conflictCards: new Set([12]),
  });
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/cards/not-a-number/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 } })).status, 404);
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/cards/9999/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 } })).status, 404);

  const repeat = await mobileFetch(ctx.url, '/api/mobile/cards/11/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 1 } });
  assert.equal(repeat.status, 200);
  const body = await repeat.json();
  assert.equal(body.idempotent, true);
  assert.equal(body.state, 'decided');

  const stale = await mobileFetch(ctx.url, '/api/mobile/cards/12/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 } });
  assert.equal(stale.status, 409);
});

// ---------- 会话恢复 / 下载 ----------
test('绑定设备可恢复会话，复用同一 continueSession 服务函数', async t => {
  const ctx = await setup(t);
  const response = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-1/continue', { method: 'POST', token: ctx.deviceToken, body: {} });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).continued, true);
  assert.deepEqual(ctx.sessions.calls.find(call => call[0] === 'continue'), ['continue', 'sess-1']);
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/sessions/missing/continue', { method: 'POST', token: ctx.deviceToken, body: {} })).status, 404);
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/sessions/sess-2/continue', { method: 'POST', body: {} })).status, 401);
});

test('绑定设备可下载产物，未绑定全拒；下载走 x-device-token 不当页面跳转', async t => {
  const ctx = await setup(t);
  const denied = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-1/download?path=交付物.apk');
  assert.equal(denied.status, 401);
  const response = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-1/download?path=%E4%BA%A4%E4%BB%98%E7%89%A9.apk', { token: ctx.deviceToken });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /octet-stream/);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), ctx.artifactBytes);
  assert.ok(ctx.sessions.calls.some(call => call[0] === 'download' && call[1] === 'sess-1'));
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/sessions/missing/download', { token: ctx.deviceToken })).status, 404);
});

// ---------- 规则 run / pause / resume ----------
test('规则 run/pause/resume 复用网页同一规则操作并记录来源设备 id；未绑定全拒', async t => {
  const ctx = await setup(t);
  for (const action of ['run', 'pause', 'resume']) {
    const denied = await mobileFetch(ctx.url, `/api/mobile/rules/%E5%B7%A1%E6%A3%80/${action}`, { method: 'POST', body: {} });
    assert.equal(denied.status, 401, `${action} 未绑定必须 401`);
  }
  const response = await mobileFetch(ctx.url, '/api/mobile/rules/%E5%B7%A1%E6%A3%80/run', { method: 'POST', token: ctx.deviceToken, body: { subject: '#1' } });
  assert.equal(response.status, 200);
  const ruleCall = ctx.hub.requests.find(request => request.url === '/v1/rules/%E5%B7%A1%E6%A3%80/run');
  assert.ok(ruleCall);
  assert.equal(JSON.parse(ruleCall.body).sourceDeviceId, ctx.deviceId);
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/rules/x/delete', { method: 'POST', token: ctx.deviceToken, body: {} })).status, 404);
});

// ---------- 网页与移动端结果一致 / 错误脱敏 ----------
test('同一卡片网页与移动端先后提交结果一致', async t => {
  const ctx = await setup(t, { cards: [{ id: 20, state: 'open', title: '同一张卡' }] });
  const web = await webFetch(ctx.url, '/api/cards/20/answer', { choice: 0 });
  assert.equal(web.status, 200);
  const webBody = await web.json();
  const mobile = await mobileFetch(ctx.url, '/api/mobile/cards/20/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 } });
  assert.equal(mobile.status, 200);
  const mobileBody = await mobile.json();
  assert.equal(mobileBody.state, webBody.state);
  assert.equal(mobileBody.idempotent, true, '网页已结案，移动端重复提交返回当前状态');
});

test('中台内部错误不暴露内部详情，且不因移动端放宽网页侧校验', async t => {
  const ctx = await setup(t, { cards: [{ id: 30, state: 'open' }], boomCards: new Set([30]) });
  const response = await mobileFetch(ctx.url, '/api/mobile/cards/30/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 } });
  assert.ok(response.status >= 400 && response.status < 600);
  const text = await response.text();
  assert.doesNotMatch(text, /owner-key|password|stack|internal detail/i);

  assert.equal((await mobileFetch(ctx.url, '/api/mobile/cards/30/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/cards/30/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/cards/30/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 }, headers: { 'x-console-request': '' } })).status, 403);
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/cards/30/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 }, headers: { 'content-type': 'text/plain' } })).status, 415);
});
