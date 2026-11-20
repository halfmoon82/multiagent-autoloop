import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DELEGATE_REASON, CardDelegateError, createCardDelegateStore, delegateEventId, settleDelegations,
  delegateOpenCard, delegateSubject, buildEscalationCard,
} from '../src/card-delegate.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const openCard = (id, extra = {}) => ({ id, state: 'open', title: '是否继续', text: '业务背景', options: ['继续', '暂停'], project: '/demo', ...extra });

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    store: createCardDelegateStore(),
    postEvent: async event => { calls.push(['event', event]); return { runId: 42 }; },
    resolveCard: async (id, reason) => { calls.push(['resolve', id, reason]); return { ok: true }; },
    now: () => new Date('2026-11-17T12:00:00Z'),
    ...overrides,
  };
}

test('退回事务先落调度事件，Hub 接受后才结案原卡，reason 为已退回调度', async () => {
  const d = deps();
  const result = await delegateOpenCard({ card: openCard(7), ...d });
  assert.deepEqual(d.calls.map(call => call[0]), ['event', 'resolve']);
  const event = d.calls[0][1];
  assert.equal(typeof event.detail, 'string', 'hub requires detail as JSON string (#89)');
  assert.equal(event.id, 'console:card:7:delegate:r1');
  assert.equal(event.subject, delegateSubject(7));
  assert.match(event.subject, /^scheduling:card-delegate:7$/);
  assert.equal(event.type, 'scheduling.message');
  const detail = JSON.parse(event.detail);
  assert.equal(detail.cardId, 7);
  assert.equal(detail.project, '/demo');
  assert.deepEqual(detail.options, ['继续', '暂停']);
  assert.equal(detail.reason, DELEGATE_REASON);
  assert.equal(detail.quality.ok, false, 'delegate event must carry the quality gate result for the scheduler to rewrite');
  assert.deepEqual(d.calls[1].slice(1), [7, DELEGATE_REASON]);
  assert.equal(result.runId, 42);
  assert.equal(result.idempotent, false);
});

test('事件失败时原卡保持开放且不结案，失败键可复用重试', async () => {
  const d = deps({ postEvent: async () => { throw new Error('hub down'); } });
  await assert.rejects(() => delegateOpenCard({ card: openCard(8), ...d }), /hub down/);
  assert.equal(d.calls.some(call => call[0] === 'resolve'), false);
  const record = d.store.get(delegateEventId(8, 1));
  assert.equal(record.status, 'failed');
});

test('重复退回不重复产生 Hub run，结案也只做一次', async () => {
  const d = deps();
  const options = { card: openCard(9), ...d };
  const first = await delegateOpenCard(options);
  const second = await delegateOpenCard(options);
  assert.equal(d.calls.filter(call => call[0] === 'event').length, 1);
  assert.equal(d.calls.filter(call => call[0] === 'resolve').length, 1);
  assert.equal(second.idempotent, true);
  assert.equal(second.eventId, first.eventId);
});

test('事件已接受但结案失败时，重试复用同一幂等键且不再派发', async () => {
  let resolveAttempts = 0;
  const d = deps({
    resolveCard: async (id, reason) => {
      d.calls.push(['resolve', id, reason]);
      if (++resolveAttempts === 1) throw new Error('结案接口暂时不可用');
      return { ok: true };
    },
  });
  await assert.rejects(() => delegateOpenCard({ card: openCard(10), ...d }), /调度事件已创建/);
  const retry = await delegateOpenCard({ card: openCard(10), ...d });
  assert.equal(retry.ok, true);
  assert.equal(d.calls.filter(call => call[0] === 'event').length, 1);
  assert.equal(d.calls.filter(call => call[0] === 'resolve').length, 2);
  assert.equal(retry.eventId, delegateEventId(10, 1));
});

test('同一链往返超过上限触发循环检测，不再产生新事件', async () => {
  const d = deps({ cooldownMs: 0, maxDelegations: 3 });
  for (const id of [11, 12, 13]) await delegateOpenCard({ card: openCard(id, { originId: 100, revision: id - 10 }), ...d });
  assert.equal(d.calls.filter(call => call[0] === 'event').length, 3);
  await assert.rejects(
    () => delegateOpenCard({ card: openCard(14, { originId: 100, revision: 4 }), ...d }),
    error => error instanceof CardDelegateError && error.code === 'DELEGATE_LOOP',
  );
  assert.equal(d.calls.filter(call => call[0] === 'event').length, 3);
});

test('冷却期内新 revision 的再次退回被拦截', async () => {
  const d = deps({ maxDelegations: 5 });
  await delegateOpenCard({ card: openCard(15, { originId: 200, revision: 1 }), ...d });
  await assert.rejects(
    () => delegateOpenCard({ card: openCard(16, { originId: 200, revision: 2 }), ...d }),
    error => error instanceof CardDelegateError && error.code === 'DELEGATE_COOLDOWN',
  );
  assert.equal(d.calls.filter(call => call[0] === 'event').length, 1);
});

test('调度重新升级形成 revision+1 新卡并链接原卡', () => {
  const source = { id: 41, originId: 40, revision: 2, title: '是否继续', project: '/demo', options: ['继续'] };
  const next = buildEscalationCard({
    source,
    background: '调度已处理但仍有产品决策需要本人确认。',
    reason: '涉及定价，属于人工门禁。',
    options: [{ label: '继续', benefit: '本周上线', cost: '需确认预算' }],
    evidence: ['Hub run #99 已完成'],
  });
  assert.equal(next.revision, 3);
  assert.equal(next.originId, 40);
  assert.equal(next.sourceCardId, 41);
  assert.equal(next.state, 'open');
  assert.equal(next.title, source.title);
  assert.deepEqual(next.evidence, ['Hub run #99 已完成']);
});

test('非开放卡不能退回', async () => {
  await assert.rejects(
    () => delegateOpenCard({ card: openCard(17, { state: 'decided' }), ...deps() }),
    error => error instanceof CardDelegateError && error.status === 409,
  );
});

async function apiFixture(handler, store = createCardDelegateStore()) {
  const hub = await fakeHub(handler);
  const root = mkdtempSync(path.join(tmpdir(), 'card-delegate-api-'));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret', sourceKey: 'source-key', root, cardDelegateStore: store });
  const url = await listen(server);
  return { hub, server, url, root };
}

const writeHeaders = { 'x-console-request': '1', 'content-type': 'application/json' };

test('POST /api/cards/:id/delegate 走同源校验并对开放卡完成退回', async () => {
  const events = []; const resolves = [];
  const { hub, server, url } = await apiFixture((req, res, body) => {
    if (req.url === '/v1/state') return json(res, { cards: [openCard(21)] });
    if (req.url === '/v1/events') { events.push(JSON.parse(body)); return json(res, { runId: 77 }); }
    if (req.url === '/v1/cards/21/resolve') { resolves.push(JSON.parse(body)); return json(res, { ok: true }); }
    return json(res, { ok: true });
  });
  try {
    const response = await fetch(`${url}/api/cards/21/delegate`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.runId, 77);
    assert.equal(events.length, 1);
    assert.equal(resolves.length, 1);
    assert.equal(resolves[0].reason, DELEGATE_REASON);
  } finally { await close(server); await close(hub.server); }
});

test('退回 API 拒绝缺少控制台标记或非 JSON 的写请求', async () => {
  const events = []; const resolves = [];
  const { hub, server, url } = await apiFixture((req, res, body) => {
    if (req.url === '/v1/state') return json(res, { cards: [openCard(22)] });
    if (req.url === '/v1/events') { events.push(body); return json(res, { runId: 78 }); }
    if (req.url === '/v1/cards/22/resolve') { resolves.push(body); return json(res, { ok: true }); }
    return json(res, { ok: true });
  });
  try {
    const noHeader = await fetch(`${url}/api/cards/22/delegate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403);
    const wrongType = await fetch(`${url}/api/cards/22/delegate`, { method: 'POST', headers: { 'x-console-request': '1', 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(wrongType.status, 415);
    assert.equal(events.length, 0);
    assert.equal(resolves.length, 0);
  } finally { await close(server); await close(hub.server); }
});

test('退回事件被 Hub 拒绝时 API 返回错误，原卡仍开放不结案', async () => {
  const resolves = [];
  const { hub, server, url } = await apiFixture((req, res) => {
    if (req.url === '/v1/state') return json(res, { cards: [openCard(23)] });
    if (req.url === '/v1/events') return json(res, { error: '中台暂不可用' }, 500);
    if (req.url === '/v1/cards/23/resolve') { resolves.push('called'); return json(res, { ok: true }); }
    return json(res, { ok: true });
  });
  try {
    const response = await fetch(`${url}/api/cards/23/delegate`, { method: 'POST', headers: writeHeaders, body: '{}' });
    assert.equal(response.status, 502);
    assert.deepEqual(resolves, []);
  } finally { await close(server); await close(hub.server); }
});

test('persistent store reloads delegated records across instances (待代理决策列表重启不丢)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'delegate-store-'));
  const file = path.join(dir, 'card-delegates.json');
  const first = createCardDelegateStore({ file });
  first.set('console:card:7:delegate:r1', { cardId: 7, originId: 7, revision: 1, at: '2026-11-18T10:00:00Z', status: 'delegated' });
  const second = createCardDelegateStore({ file });
  assert.equal(second.listPending().length, 1);
  assert.equal(second.listPending()[0].cardId, 7);
});

test('GET /api/delegated-cards lists pending delegations', async () => {
  const store = createCardDelegateStore();
  store.set('console:card:9:delegate:r1', { cardId: 9, originId: 9, revision: 1, at: '2026-11-18T10:00:00Z', status: 'delegated' });
  store.set('x', { cardId: 8, originId: 8, revision: 1, at: 'x', status: 'failed' });
  const root = mkdtempSync(path.join(tmpdir(), 'delegated-api-'));
  const server = createConsoleServer({ hubUrl: 'http://127.0.0.1:9', ownerKey: 'o', root, cardDelegateStore: store });
  const url = await listen(server);
  try {
    const res = await fetch(`${url}/api/delegated-cards`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cards.length, 1);
    assert.equal(body.cards[0].cardId, 9);
  } finally { server.close(); }
});

test('settleDelegations moves a delegation out of the pending list once its scheduling run finishes (P2)', () => {
  const store = createCardDelegateStore();
  store.set('console:card:21:delegate:r1', { cardId: 21, originId: 21, revision: 1, at: '2026-11-19T01:00:00Z', status: 'delegated' });
  store.set('console:card:22:delegate:r1', { cardId: 22, originId: 22, revision: 1, at: '2026-11-19T01:00:00Z', status: 'delegated' });
  const state = { runs: [
    { id: 50, state: 'done', finishedAt: '2026-11-19T01:05:00Z', events: [{ subject: delegateSubject(21) }] },
    { id: 51, state: 'claimed', finishedAt: null, events: [{ subject: delegateSubject(22) }] },
    { id: 40, state: 'done', finishedAt: '2026-11-18T23:00:00Z', events: [{ subject: delegateSubject(22) }] },
  ] };
  const settled = settleDelegations(store, state);
  assert.deepEqual(settled.map(record => record.cardId), [21]);
  assert.deepEqual(store.listPending().map(record => record.cardId), [22], '仍在跑的、以及退回之前就结束的旧轮次都不算收口');
  assert.equal(store.listByOrigin(21).length, 1, '记录保留给冷却与循环检测');
});

test('GET /api/delegated-cards settles finished delegations through Hub state', async () => {
  const store = createCardDelegateStore();
  store.set('console:card:31:delegate:r1', { cardId: 31, originId: 31, revision: 1, at: '2026-11-19T01:00:00Z', status: 'delegated' });
  const { hub, server, url } = await apiFixture((req, res) => {
    if (req.url === '/v1/state') return json(res, { cards: [], runs: [{ id: 60, state: 'nothing', finishedAt: '2026-11-19T02:00:00Z', events: [{ subject: delegateSubject(31) }] }] });
    return json(res, {}, 404);
  }, store);
  try {
    const body = await (await fetch(`${url}/api/delegated-cards`)).json();
    assert.equal(body.cards.length, 0);
  } finally { await close(server); await close(hub.server); }
});
