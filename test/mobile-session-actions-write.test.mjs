// session-actions 节点：移动端关闭会话 / 放行落盘 / 授权创建 DAG / 计划只读 的写路由契约。
// 与网页共用 schedulingSessions.close/approvePlan 与 dagService.create/preview/preflight，
// 鉴权口径与 mobile-write 其它路由一致（x-device-token + 同源头 + JSON）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { DagServiceError } from '../src/dag-service.mjs';
import { SchedulingSessionError } from '../src/scheduling-session.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const WORKTREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST = 'd'.repeat(64);

function makeSessions() {
  return {
    calls: [],
    async list() { return [{ id: 'sess-live', kind: 'design', project: WORKTREE, status: 'running' }, { id: 'sess-done', kind: 'normal', project: WORKTREE, status: 'closed' }]; },
    async listArchived() { return [{ id: 'sess-archived', project: WORKTREE }]; },
    async close(id) { this.calls.push(['close', id]); return { id, status: 'closed' }; },
    async approvePlan(id) {
      this.calls.push(['approve', id]);
      if (id === 'sess-nodesign') throw new SchedulingSessionError('只有设计会话需要放行落盘', { status: 400 });
      return { id, planApproved: true };
    },
  };
}
function makeDag() {
  return {
    calls: [],
    async preview(project, planId) { this.calls.push(['preview', project, planId]); return { project, planId, planDigest: DIGEST, nodes: [], allowedActions: ['worktree'], deniedActions: ['deploy'], optionalActions: [] }; },
    preflight(project, planId) { this.calls.push(['preflight', project, planId]); return { project, planId, source: 'native', checks: [{ id: 'plan-source', ok: true }] }; },
    async create(body, project) {
      this.calls.push(['create', body, project]);
      if (body.planDigest !== DIGEST) { throw new DagServiceError('PLAN_DIGEST_MISMATCH：planDigest 与服务端计划不一致，计划已变化需重新确认', 400); }
      return { runId: 'dagrun-x', status: 'running' };
    },
  };
}

async function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-session-actions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ rules: [], agents: {}, sources: {} }));
  const hub = await fakeHub((req, res) => json(res, { cards: [] }));
  const store = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const bound = store.bindDevice({ token: store.createBinding().token, name: '测试手机', platform: 'Android' });
  const sessions = makeSessions();
  const dagService = makeDag();
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'owner-key', sourceKey: 'source-key', host: '127.0.0.1', root, rulesFile,
    projectRoots: [WORKTREE], deviceAuth: store, dagService,
  }, sessions);
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); });
  return { url, store, sessions, dagService, token: bound.deviceToken, deviceId: bound.device.id };
}

function call(base, pathname, { method = 'POST', token, body = {}, headers = {} } = {}) {
  const origin = new URL(base).origin;
  return fetch(base + pathname, {
    method,
    headers: {
      'x-console-request': '1', 'x-forwarded-proto': 'https', origin,
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(token ? { 'x-device-token': token } : {}), ...headers,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(6000),
  });
}

const WRITES = [
  ['/api/mobile/sessions/sess-live/close', {}],
  ['/api/mobile/sessions/sess-live/approve-plan', {}],
  ['/api/mobile/dag-runs', { project: WORKTREE, planId: 'p', planDigest: DIGEST, confirm: true, confirmedActionIds: ['worktree'] }],
];

test('三条新写路由：无设备凭据 401，跨站/缺标记/非 JSON 403/415，且不触达服务', async t => {
  const ctx = await setup(t);
  for (const [route, body] of WRITES) {
    assert.equal((await call(ctx.url, route, { body })).status, 401, `${route} 无令牌`);
    assert.equal((await call(ctx.url, route, { token: 'bogus', body })).status, 401, `${route} 伪造令牌`);
    assert.equal((await call(ctx.url, route, { token: ctx.token, body, headers: { 'x-console-request': '0' } })).status, 403, `${route} 缺标记`);
    assert.equal((await call(ctx.url, route, { token: ctx.token, body, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, `${route} 跨站`);
    assert.equal((await call(ctx.url, route, { token: ctx.token, body, headers: { 'content-type': 'text/plain' } })).status, 415, `${route} 非 JSON`);
  }
  assert.deepEqual(ctx.sessions.calls, []);
  assert.deepEqual(ctx.dagService.calls, []);
});

test('关闭会话：复用 schedulingSessions.close；已结束/已归档不重复操作；不存在 404', async t => {
  const ctx = await setup(t);
  const ok = await call(ctx.url, '/api/mobile/sessions/sess-live/close', { token: ctx.token });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { id: 'sess-live', status: 'closed', sourceDeviceId: ctx.deviceId });
  assert.deepEqual(ctx.sessions.calls, [['close', 'sess-live']]);

  for (const id of ['sess-done', 'sess-archived']) {
    const again = await call(ctx.url, `/api/mobile/sessions/${id}/close`, { token: ctx.token });
    assert.equal(again.status, 200);
    const payload = await again.json();
    assert.equal(payload.alreadyClosed, true);
    assert.equal(payload.status, 'closed');
  }
  assert.equal(ctx.sessions.calls.length, 1, '已结束会话不再调用 close');

  const missing = await call(ctx.url, '/api/mobile/sessions/sess-nope/close', { token: ctx.token });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /不存在|失效/);
});

test('放行落盘：复用 approvePlan；非设计会话的 400 文案透传', async t => {
  const ctx = await setup(t);
  const ok = await call(ctx.url, '/api/mobile/sessions/sess-live/approve-plan', { token: ctx.token });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).planApproved, true);
  const bad = await call(ctx.url, '/api/mobile/sessions/sess-nodesign/approve-plan', { token: ctx.token });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /设计会话/);
});

test('授权创建 DAG：只转发白名单字段；未勾选/未知项目不触达 create；planDigest 不符由服务端拒绝', async t => {
  const ctx = await setup(t);
  const body = { project: WORKTREE, planId: 'p', planDigest: DIGEST, remoteUrl: 'https://example.com/r.git', confirm: true, confirmedActionIds: ['worktree'], selectedOptionalActions: [], evil: 'x' };
  const ok = await call(ctx.url, '/api/mobile/dag-runs', { token: ctx.token, body });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).runId, 'dagrun-x');
  const [, forwarded, project] = ctx.dagService.calls.find(item => item[0] === 'create');
  assert.equal(project, WORKTREE);
  assert.equal(forwarded.evil, undefined, '未知字段不转发');
  assert.deepEqual(forwarded.confirmedActionIds, ['worktree']);

  const before = ctx.dagService.calls.length;
  assert.equal((await call(ctx.url, '/api/mobile/dag-runs', { token: ctx.token, body: { ...body, project: '/etc' } })).status, 400);
  assert.equal((await call(ctx.url, '/api/mobile/dag-runs', { token: ctx.token, body: { ...body, confirm: false } })).status, 400);
  assert.equal(ctx.dagService.calls.length, before, '未知项目与未确认不触达 create');
  const mismatch = await call(ctx.url, '/api/mobile/dag-runs', { token: ctx.token, body: { ...body, planDigest: 'e'.repeat(64) } });
  assert.equal(mismatch.status, 400);
  assert.match((await mismatch.json()).error, /planDigest/);
});

test('计划只读：dag-plan / dag-preflight 需设备令牌且项目必须在已发现列表', async t => {
  const ctx = await setup(t);
  const q = `project=${encodeURIComponent(WORKTREE)}&planId=p`;
  assert.equal((await call(ctx.url, `/api/mobile/dag-plan?${q}`, { method: 'GET' })).status, 401);
  const plan = await call(ctx.url, `/api/mobile/dag-plan?${q}`, { method: 'GET', token: ctx.token });
  assert.equal(plan.status, 200);
  assert.equal((await plan.json()).planDigest, DIGEST);
  const pre = await call(ctx.url, `/api/mobile/dag-preflight?${q}`, { method: 'GET', token: ctx.token });
  assert.equal(pre.status, 200);
  assert.equal((await pre.json()).source, 'native');
  assert.equal((await call(ctx.url, '/api/mobile/dag-plan?project=%2Fetc&planId=p', { method: 'GET', token: ctx.token })).status, 400);
});
