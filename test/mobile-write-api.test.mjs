// mobile-write-api 节点契约测试：移动端写路由与网页控制台复用同一服务函数。
// 覆盖卡片回答/授权、会话恢复/下载、规则 run/pause/resume 的绑定设备成功路径，
// 以及未绑定全拒、非法 id 404、幂等、已失效 409、不暴露内部错误、不放宽网页侧校验。
// 全部走本机假 Hub 与注入会话管理器，不调用真实模型或真实规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  const workspace = mkdtempSync(path.join(tmpdir(), 'artifact-ws-'));
  writeFileSync(path.join(workspace, '旧文档.md'), '会话之前就存在的仓库文档');
  // mtime 明确早于时间界，避免与同毫秒写入的时间界判定 flaky。
  utimesSync(path.join(workspace, '旧文档.md'), new Date(Date.now() - 3600 * 1000), new Date(Date.now() - 3600 * 1000));
  const since = new Date().toISOString();
  // 新产物 mtime 显式拨到 since 之后 5 秒：CI 上同毫秒写入会让 mtime<=since 被时间界排除（秒/毫秒精度差异 flaky）。
  const fresh = path.join(workspace, '新产物.md');
  writeFileSync(fresh, '本会话产出');
  const future = new Date(Date.parse(since) + 5000);
  utimesSync(fresh, future, future);
  return {
    workspace,
    workspaceSince: since,
    calls: [],
    async listArchived() { return [{ id: 'sess-1', project: WORKTREE }, { id: 'sess-2', project: WORKTREE }]; },
    async continueSession(id) { this.calls.push(['continue', id]); return { id, continued: true }; },
    async start(payload) { this.calls.push(['start', payload]); return { id: 'sess-new', ...payload }; },
    async list() {
      this.calls.push(['list']);
      return [{ id: 'sess-live', kind: 'scheduling', project: WORKTREE, status: 'running',
        cwd: this.workspace, createdAt: this.workspaceSince, prompt: '首行任务摘要\n更多细节' }];
    },
    async listSessionArtifacts(id) {
      this.calls.push(['listSessionArtifacts', id]);
      if (id !== 'sess-live') { const e = new Error('调度会话不存在'); e.status = 404; throw e; }
      return [{ path: 'docs/看板.html', name: '看板.html', size: 120, at: '2026-11-24T00:00:00Z', kind: 'doc', sessionId: 'sess-live', taskLabel: '核心任务' }];
    },
    async readSessionArtifact(id, p) {
      this.calls.push(['readSessionArtifact', id, p]);
      if (id !== 'sess-live') { const e = new Error('调度会话不存在'); e.status = 404; throw e; }
      // volatile：第二次读取抛 404，模拟签发后被 worker 删除（P2：兑换分支不得击落进程）。
      if (p === 'docs/volatile.html') {
        this.volatileReads = (this.volatileReads || 0) + 1;
        if (this.volatileReads > 1) { const e = new Error('调度会话不存在'); e.status = 404; throw e; }
        return { path: p, name: 'volatile.html', content: '<p>即将删除</p>' };
      }
      return { path: p, name: String(p).split('/').pop(), content: '<h1>数据看板</h1><script>document.body.dataset.ran=1</script>' };
    },
    async updateQueued(id, itemId, text) { this.calls.push(['updateQueued', id, itemId, text]); return { id }; },
    async moveQueued(id, itemId, direction) { this.calls.push(['moveQueued', id, itemId, direction]); return { id }; },
    async steerQueued(id, itemId) { this.calls.push(['steerQueued', id, itemId]); return { id }; },
    async removeQueued(id, itemId) { this.calls.push(['removeQueued', id, itemId]); return { id }; },
    async clearQueued(id) { this.calls.push(['clearQueued', id]); return { id }; },
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
    // 平台模型保存的 CLI 校验换成桩：本测试只验网关与审计链路，不跑真实 cli check。
    platformCheck: async () => {},
  }, sessions);
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); rmSync(sessions.workspace, { recursive: true, force: true }); });
  return { url, hub, store, sessions, deviceToken: bound.deviceToken, deviceId: bound.device.id, artifactBytes, root };
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
  assert.deepEqual(JSON.parse(ruleCall.body), { subject: '#1' });
  assert.doesNotMatch(ruleCall.body, /sourceDeviceId/, '规则 Hub 白名单字段外不得额外注入 sourceDeviceId');
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

test('绑定设备可编辑、排序、删除、清空并 steer 排队消息，复用同一会话管理器', async t => {
  const ctx = await setup(t);
  const base = '/api/mobile/sessions/sess-live/queue';
  const cases = [
    ['PUT', `${base}/q1`, { text: '改后' }, 'updateQueued'],
    ['POST', `${base}/q1/move`, { direction: 'up' }, 'moveQueued'],
    ['POST', `${base}/q1/steer`, {}, 'steerQueued'],
    ['DELETE', `${base}/q1`, {}, 'removeQueued'],
    ['POST', `${base}/clear`, {}, 'clearQueued'],
  ];
  for (const [method, route, body, name] of cases) {
    const response = await mobileFetch(ctx.url, route, { method, token: ctx.deviceToken, body });
    assert.equal(response.status, 200, `${method} ${route}`);
    assert.ok(ctx.sessions.calls.some(call => call[0] === name && call[1] === 'sess-live'), `缺少 ${name} 调用`);
  }
  const unbound = await mobileFetch(ctx.url, `${base}/clear`, { method: 'POST', body: {} });
  assert.equal(unbound.status, 401);
});

test('平台与模型走设备鉴权移动网关：未绑定 401，绑定可读且保存仍校验', async t => {
  const ctx = await setup(t);
  const route = '/api/mobile/admin/platform-models';
  assert.equal((await mobileFetch(ctx.url, route)).status, 401);
  const response = await mobileFetch(ctx.url, route, { token: ctx.deviceToken });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.enabled, 'boolean');
  assert.ok(Array.isArray(body.platforms));
  const save = await mobileFetch(ctx.url, route, { method: 'PUT', token: ctx.deviceToken, body: { enabled: true, platforms: [] } });
  assert.notEqual(save.status, 404, '保存必须到达既有平台模型处理逻辑');
});

// 回归：保存成功路径的审计动作名必须过 device-auth 的 /^[a-z][a-z.]{1,40}$/ 校验。
// 曾用带连字符的 'admin.platform-models'，保存实际写盘成功后审计抛 400，
// 手机端收到「请求无效」误以为保存失败（2026-11-23 真机事故）。
test('平台与模型经移动网关保存成功：200、落盘且审计留痕', async t => {
  const ctx = await setup(t);
  writeFileSync(path.join(ctx.root, 'rules.json'), JSON.stringify({
    sources: { local: { name: 'local' } },
    agents: {
      workbuddy: { name: 'WorkBuddy AI', worker: 'w', use: 'acp', command: ['/bin/wb.sh', '--acp'], access: 'full' },
      claude: { name: 'Claude Code', worker: 'w', use: 'claude', access: 'full', model: 'claude-sonnet-5-5' },
      'codex-full': { name: 'Codex 可写调度', worker: 'w', use: 'codex', access: 'full' },
    },
    rules: [
      { name: 'DAG自动开发', when: { source: 'local', types: ['dag.auto.dev'] }, to: 'workbuddy', cwd: WORKTREE, prompt: 'dev', parallel: 5, resume: false },
      { name: '调度会话执行', when: { source: 'local', types: ['scheduling.message'] }, to: 'codex-full', cwd: WORKTREE, prompt: 's', resume: true },
    ],
  }));
  const payload = {
    enabled: true,
    platforms: {
      workbuddy: { light: 'hy4flash-free', standard: 'hy4std', heavy: 'deepseek-v4-pro' },
      claude: { light: 'haiku', standard: 'claude-sonnet-5-5', heavy: 'opus' },
      'codex-full': { light: 'deepseek-v4.1-flash', standard: 'kimi-for-coding', heavy: 'k3.1-pro' },
    },
    roles: { dev: { primary: 'workbuddy', fallback: 'claude' }, review: { primary: 'claude', fallback: 'codex-full' }, coord: { primary: 'codex-full', fallback: 'claude' } },
    sessions: { coord: { tier: 'light' }, design: { platform: 'codex-full', tier: 'standard' }, normal: { platform: 'codex-full', tier: 'light' } },
  };
  const save = await mobileFetch(ctx.url, '/api/mobile/admin/platform-models', { method: 'PUT', token: ctx.deviceToken, body: payload });
  if (save.status !== 200) assert.fail(`保存应成功：${await save.text()}`);
  const body = await save.json();
  assert.equal(body.saved, true);
  assert.ok(body.backup, '应返回备份名');
  const audit = JSON.parse(readFileSync(path.join(ctx.root, 'device-auth.json'), 'utf8')).audit || [];
  const hits = audit.filter(entry => String(entry.action || '').includes('platform'));
  assert.equal(hits.length, 1, '成功保存必须留一条审计');
  assert.equal(hits[0].result, 'ok');
});

test('会话消息附件经移动网关原样传给会话管理器', async t => {
  const ctx = await setup(t);
  const attachment = { name: '说明.md', type: 'text/markdown', size: 4, dataBase64: Buffer.from('正文').toString('base64') };
  const response = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-live/messages', { method: 'POST', token: ctx.deviceToken, body: { text: '看附件', attachments: [attachment] } });
  assert.equal(response.status, 200);
  assert.deepEqual(ctx.sessions.calls.find(call => call[0] === 'send'), ['send', 'sess-live', '看附件', { interrupt: false, attachments: [attachment] }]);
});

test('会话附件请求不再被旧 64KB 上限误拦截', async t => {
  const ctx = await setup(t);
  const dataBase64 = Buffer.alloc(100 * 1024, 7).toString('base64');
  const response = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-live/messages', { method: 'POST', token: ctx.deviceToken, body: { text: '大附件', attachments: [{ name: '大文件.bin', type: 'application/octet-stream', dataBase64 }] } });
  assert.equal(response.status, 200);
  assert.equal(ctx.sessions.calls.find(call => call[0] === 'send')[3].attachments[0].dataBase64.length, dataBase64.length);
});

// ---------- 会话产物（artifacts-sync）：全局汇总 / 会话列表 / 文件内容，全部设备鉴权 ----------
test('产物读取走设备鉴权移动网关：未绑定 401，绑定可读全局汇总、会话列表与文件内容', async t => {
  const ctx = await setup(t);
  const auth = { token: ctx.deviceToken };

  for (const p of ['/api/mobile/artifacts', '/api/mobile/sessions/sess-live/artifacts', '/api/mobile/sessions/sess-live/file?path=docs%2F看板.html']) {
    const unbound = await mobileFetch(ctx.url, p);
    assert.equal(unbound.status, 401, p);
  }

  const global = await mobileFetch(ctx.url, '/api/mobile/artifacts', auth);
  assert.equal(global.status, 200);
  const globalBody = await global.json();
  // P1 回归：list() 是对外视图（cwd/createdAt/prompt），聚合必须映射为内部形态并以 createdAt 作
  // startedAt 时间界——只收会话后的新产物，任务标签取 prompt 首行；历史旧文档不得混入。
  assert.deepEqual(globalBody.files.map(f => f.name), ['新产物.md']);
  assert.equal(globalBody.files[0].sessionId, 'sess-live');
  assert.equal(globalBody.files[0].task, '首行任务摘要');

  const list = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-live/artifacts', auth);
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.files.length, 1);
  assert.equal(listBody.files[0].name, '看板.html');
  assert.equal(listBody.files[0].sessionId, 'sess-live');

  const file = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-live/file?path=docs%2F看板.html', auth);
  assert.equal(file.status, 200);
  const fileBody = await file.json();
  assert.match(fileBody.content, /数据看板/);

  const missing = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-gone/artifacts', auth);
  assert.equal(missing.status, 404);
});

// ---------- A+ 预览票据：签发/兑换/一次性/兑换期文件消失不坠毁 ----------
test('预览票据：设备鉴权签发，兑换一次性，HTML 流仅预览放宽 CSP，文件消失返回 404 不击落进程', async t => {
  const ctx = await setup(t);
  const auth = { token: ctx.deviceToken };

  const unbound = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-live/preview-ticket?path=docs%2F看板.html', { method: 'POST', body: {} });
  assert.equal(unbound.status, 401);

  const issued = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-live/preview-ticket?path=docs%2F看板.html', { method: 'POST', body: {}, ...auth });
  assert.equal(issued.status, 200);
  const { url } = await issued.json();
  assert.match(url, /^\/mobile\/preview\?ticket=[0-9a-f]{48}$/);

  // 兑换：无需任何头（iframe 场景），HTML 流 + 宽松 CSP；第二次兑换必须 404（一次性）。
  const first = await fetch(ctx.url + url);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /text\/html/);
  assert.match(first.headers.get('content-security-policy'), /default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'/);
  // 沙箱 iframe sandbox="allow-scripts" 没有 allow-same-origin，帧内文档是不透明源；
  // XFO: SAMEORIGIN 的源比对必然失败，浏览器直接拒绝渲染。预览响应不得再带该响应头。
  assert.equal(first.headers.get('x-frame-options'), null, '预览 HTML 不得带拦截沙箱帧的 X-Frame-Options');
  assert.match(await first.text(), /数据看板/);
  // 网页控制台同源预览走同一发送函数，同样不能带 XFO（设计稿门 artifacts-preview）。
  const sameOrigin = await fetch(ctx.url + '/api/scheduling-sessions/sess-live/preview?path=' + encodeURIComponent('docs/看板.html'));
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.headers.get('x-frame-options'), null, '同源预览也不得带拦截沙箱帧的 X-Frame-Options');
  assert.match(sameOrigin.headers.get('content-security-policy'), /default-src 'none'; script-src 'unsafe-inline'/);
  const replay = await fetch(ctx.url + url);
  assert.equal(replay.status, 404, '票据一次性，重放必须失效');
  const bad = await fetch(ctx.url + '/mobile/preview?ticket=' + '0'.repeat(48));
  assert.equal(bad.status, 404);

  // P2 回归：签发后文件被删除（第二次读取抛 404）→ 兑换返回 404 JSON，进程继续服务。
  const volatile = await mobileFetch(ctx.url, '/api/mobile/sessions/sess-live/preview-ticket?path=docs%2Fvolatile.html', { method: 'POST', body: {}, ...auth });
  const volatileBody = await volatile.json();
  const gone = await fetch(ctx.url + volatileBody.url);
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /不可用/);
  const after = await mobileFetch(ctx.url, '/api/mobile/api/sessions', auth);
  assert.equal(after.status, 200, '兑换异常不得击落控制台进程');
});

// 设计门回归：artifacts-preview 的 open-preview 检查扫描整个 src/mobile-write.mjs，
// 要求保留 sendPreviewHtml 标记，且整文件不得再出现旧式帧隔离响应头字面量
// （通用安全头定义与说明注释都算，见 fix3-design.verify.mjs 的 notAny）。
test('预览实现文件满足设计门 open-preview 标记：保留 sendPreviewHtml，整文件无 x-frame-options 字面量', () => {
  const source = readFileSync(path.join(WORKTREE, 'src/mobile-write.mjs'), 'utf8');
  assert.match(source, /sendPreviewHtml/, '预览发送函数标记必须仍在写范围内');
  assert.equal(
    source.includes('x-frame-options'),
    false,
    'src/mobile-write.mjs 整文件不得出现 x-frame-options：通用安全头已由 CSP frame-ancestors none 覆盖，注释也不得重引该字面量'
  );
});
