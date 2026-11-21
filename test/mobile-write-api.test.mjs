// mobile-write-api 节点契约测试：移动端写路由与网页控制台复用同一服务函数。
// 覆盖卡片回答/授权、会话恢复/下载、规则 run/pause/resume 的绑定设备成功路径，
// 以及未绑定全拒、非法 id 404、幂等、已失效 409、不暴露内部错误、不放宽网页侧校验。
// 全部走本机假 Hub 与注入会话管理器，不调用真实模型或真实规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { SchedulingSessionError } from '../src/scheduling-session.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const WORKTREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    async start(payload) { this.calls.push(['start', payload]); return { id: 'sess-new', ...payload }; },
    async list() { this.calls.push(['list']); return [{ id: 'sess-live', kind: 'scheduling', project: WORKTREE, status: 'running' }]; },
    async send(id, text, opts) {
      this.calls.push(['send', id, text, opts]);
      if (id === 'sess-closed') throw new SchedulingSessionError('会话已关闭，请开启新会话', { status: 409 });
      if (id !== 'sess-live') { const error = new Error('调度会话不存在'); error.status = 404; throw error; }
      return { id, status: 'running' };
    },
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

  // 隧道形态下 Origin 不再等值 Host（见 validate 注释），但跨站 sec-fetch-site 仍拦；
  // 直连形态伪造 Origin 的 403 由「无转发头的直连请求仍按 Host 严格校验 Origin」守门。
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/cards/30/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/cards/30/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 }, headers: { 'x-console-request': '' } })).status, 403);
  assert.equal((await mobileFetch(ctx.url, '/api/mobile/cards/30/answer', { method: 'POST', token: ctx.deviceToken, body: { choice: 0 }, headers: { 'content-type': 'text/plain' } })).status, 415);
});

// ---------- 会话创建 / 语义分类（经移动端网关，修复隧道只转发 /api/mobile/* 导致 404） ----------
test('绑定设备可经移动端网关创建会话，复用同一会话管理器并记录来源设备', async t => {
  const ctx = await setup(t);
  const response = await mobileFetch(ctx.url, '/api/mobile/sessions', {
    method: 'POST', token: ctx.deviceToken,
    body: { project: WORKTREE, prompt: '请调度失败任务', kind: 'scheduling' },
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.id, 'sess-new');
  assert.equal(payload.sourceDeviceId, ctx.deviceId);
  const startCall = ctx.sessions.calls.find(call => call[0] === 'start');
  assert.ok(startCall, '必须复用网页 /api/scheduling-sessions 的同一 sessions.start');
  assert.deepEqual(startCall[1], { kind: 'scheduling', prompt: '请调度失败任务', project: WORKTREE });
});

test('移动端创建会话：kind 缺省按首轮语义分类，非法 kind / 缺提示词 / 未知项目 400', async t => {
  const ctx = await setup(t);
  const auto = await mobileFetch(ctx.url, '/api/mobile/sessions', {
    method: 'POST', token: ctx.deviceToken, body: { project: WORKTREE, prompt: '请调度失败任务' },
  });
  assert.equal(auto.status, 201);
  assert.equal(ctx.sessions.calls.at(-1)[1].kind, 'scheduling');

  const badKind = await mobileFetch(ctx.url, '/api/mobile/sessions', {
    method: 'POST', token: ctx.deviceToken, body: { project: WORKTREE, prompt: 'x', kind: 'evil' },
  });
  assert.equal(badKind.status, 400);

  const noPrompt = await mobileFetch(ctx.url, '/api/mobile/sessions', {
    method: 'POST', token: ctx.deviceToken, body: { project: WORKTREE, prompt: '   ' },
  });
  assert.equal(noPrompt.status, 400);

  const unknownProject = await mobileFetch(ctx.url, '/api/mobile/sessions', {
    method: 'POST', token: ctx.deviceToken, body: { project: '/nowhere/x', prompt: '请调度失败任务' },
  });
  assert.equal(unknownProject.status, 400);

  const unbound = await mobileFetch(ctx.url, '/api/mobile/sessions', {
    method: 'POST', body: { project: WORKTREE, prompt: '请调度失败任务' },
  });
  assert.equal(unbound.status, 401);
  assert.equal(ctx.sessions.calls.filter(call => call[0] === 'start').length, 1, '失败路径不得创建会话');
});

test('绑定设备可经移动端网关做首轮语义分类，未绑定 401', async t => {
  const ctx = await setup(t);
  const bound = await mobileFetch(ctx.url, '/api/mobile/session-classify', {
    method: 'POST', token: ctx.deviceToken, body: { text: '请调度失败任务' },
  });
  assert.equal(bound.status, 200);
  assert.equal((await bound.json()).kind, 'scheduling');

  const unbound = await mobileFetch(ctx.url, '/api/mobile/session-classify', {
    method: 'POST', body: { text: '请调度失败任务' },
  });
  assert.equal(unbound.status, 401);
});

// ---------- 隧道形态 Origin（cloudflared 改写 Host 后 Origin 与 Host 必然不一致） ----------
test('隧道形态请求（x-forwarded-proto + 公网 Origin）不被误判跨站，创建会话成功', async t => {
  const ctx = await setup(t);
  const response = await mobileFetch(ctx.url, '/api/mobile/sessions', {
    method: 'POST', token: ctx.deviceToken,
    body: { project: WORKTREE, prompt: '请调度失败任务', kind: 'scheduling' },
    headers: { origin: 'https://auto.socialmore.net' },
  });
  assert.equal(response.status, 201);
});

test('无转发头的直连请求仍按 Host 严格校验 Origin，伪造公网 Origin 拒绝', async t => {
  const ctx = await setup(t);
  const target = new URL(ctx.url);
  const response = await fetch(ctx.url + '/api/mobile/sessions', {
    method: 'POST',
    headers: {
      'x-console-request': '1',
      'content-type': 'application/json',
      'x-device-token': ctx.deviceToken,
      origin: 'https://evil.example.com',
      host: target.host,
    },
    body: JSON.stringify({ project: WORKTREE, prompt: '请调度失败任务' }),
    signal: AbortSignal.timeout(6000),
  });
  assert.equal(response.status, 403);
  assert.equal(ctx.sessions.calls.filter(call => call[0] === 'start').length, 0, '被拒绝请求不得创建会话');
});

// ---------- 只读中继：会话列表与存档（经隧道可达，修复手机端列表 404） ----------
test('绑定设备可经 /api/mobile/api/<key> 中继读取会话列表与存档', async t => {
  const ctx = await setup(t);
  const auth = { token: ctx.deviceToken };
  const sessions = await mobileFetch(ctx.url, '/api/mobile/api/sessions', auth);
  assert.equal(sessions.status, 200);
  assert.equal((await sessions.json())[0].id, 'sess-live');
  const archives = await mobileFetch(ctx.url, '/api/mobile/api/session-archives', auth);
  assert.equal(archives.status, 200);
  assert.equal((await archives.json()).sessions.length, 2);

  const unbound = await mobileFetch(ctx.url, '/api/mobile/api/sessions');
  assert.equal(unbound.status, 401);
});

// ---------- 会话消息（composer 此前是纯本地回显，从未发送到服务器） ----------
test('绑定设备可经移动端网关向会话发消息，复用同一 sessions.send', async t => {
  const ctx = await setup(t);
  const response = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-live/messages', {
    method: 'POST', token: ctx.deviceToken, body: { text: '请继续完善 PRD 的边界章节' },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.sourceDeviceId, ctx.deviceId);
  const sendCall = ctx.sessions.calls.find(call => call[0] === 'send');
  assert.deepEqual(sendCall, ['send', 'sess-live', '请继续完善 PRD 的边界章节', { interrupt: false }]);

  const missing = await mobileFetch(ctx.url, '/api/mobile/sessions/nope/messages', {
    method: 'POST', token: ctx.deviceToken, body: { text: 'x' },
  });
  assert.equal(missing.status, 404);
  const empty = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-live/messages', {
    method: 'POST', token: ctx.deviceToken, body: { text: '   ' },
  });
  assert.equal(empty.status, 400, '空消息不得发送');
  const unbound = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-live/messages', {
    method: 'POST', body: { text: 'x' },
  });
  assert.equal(unbound.status, 401);

  const closed = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-closed/messages', {
    method: 'POST', token: ctx.deviceToken, body: { text: '还在吗' },
  });
  assert.equal(closed.status, 409);
  assert.equal((await closed.json()).error, '会话已关闭，请开启新会话', '本地会话态错误透传用户可读文案，与网页端同口径');
});
