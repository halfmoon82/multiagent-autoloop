import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const writeHeaders = { 'x-console-request': '1', 'content-type': 'application/json' };

// 管理器假件：记录 notifyCardAnswered 调用，模拟「找到/找不到目标会话」两种结果。
function managerStub({ found = true, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async notifyCardAnswered(payload) {
      calls.push(payload);
      if (fail) throw fail;
      return found ? { id: 'sess-1' } : null;
    },
  };
}

async function apiFixture(handler, { sessions } = {}) {
  const hub = await fakeHub(handler);
  const root = mkdtempSync(path.join(tmpdir(), 'card-answer-wake-'));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const server = createConsoleServer(
    { hubUrl: hub.url, ownerKey: 'server-secret', root },
    sessions || managerStub(),
  );
  const url = await listen(server);
  return { hub, server, url, root };
}

const openCard = (id, extra = {}) => ({ id, state: 'open', title: '是否继续', lane: 'scheduling:s1', options: ['继续', '暂停'], ...extra });

test('POST /api/cards/:id/answer(choice) 结案后按 card.lane 唤醒对应调度会话', async () => {
  const sessions = managerStub();
  const { hub, server, url } = await apiFixture((req, res, body) => {
    if (req.url === '/v1/cards/31/answer') return json(res, { changed: true });
    if (req.url === '/v1/state') return json(res, { cards: [openCard(31)], runs: [], lines: [] });
    return json(res, { ok: true });
  }, { sessions });
  try {
    const response = await fetch(`${url}/api/cards/31/answer`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ choice: 0 }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.changed, true);
    assert.equal(result.schedulingWake, 'sent');
    assert.equal(sessions.calls.length, 1, 'answer 必须尝试唤醒一次调度会话');
    assert.equal(sessions.calls[0].card.id, 31);
    assert.equal(sessions.calls[0].answerText, '继续', '选项答案应回传选项文字而不是序号');
  } finally { await close(server); await close(hub.server); }
});

test('POST /api/cards/:id/answer(text) 回传用户原文给调度会话', async () => {
  const sessions = managerStub();
  const { hub, server, url } = await apiFixture((req, res) => {
    if (req.url === '/v1/cards/32/answer') return json(res, { changed: true });
    if (req.url === '/v1/state') return json(res, { cards: [openCard(32)], runs: [], lines: [] });
    return json(res, { ok: true });
  }, { sessions });
  try {
    const response = await fetch(`${url}/api/cards/32/answer`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text: '先暂停观察' }) });
    assert.equal(response.status, 200);
    assert.equal(sessions.calls[0].answerText, '先暂停观察');
  } finally { await close(server); await close(hub.server); }
});

test('卡片没有 lane 或没有活跃调度会话时 answer 仍成功并标记 no-session', async () => {
  const sessions = managerStub({ found: false });
  const { hub, server, url } = await apiFixture((req, res) => {
    if (req.url === '/v1/cards/33/answer') return json(res, { changed: true });
    if (req.url === '/v1/state') return json(res, { cards: [openCard(33)], runs: [], lines: [] });
    return json(res, { ok: true });
  }, { sessions });
  try {
    const response = await fetch(`${url}/api/cards/33/answer`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ choice: 1 }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).schedulingWake, 'no-session');
  } finally { await close(server); await close(hub.server); }
});

test('状态读取或唤醒失败不影响卡片已结案的结果', async () => {
  const sessions = managerStub({ fail: new Error('hub down') });
  const { hub, server, url } = await apiFixture((req, res) => {
    if (req.url === '/v1/cards/34/answer') return json(res, { changed: true });
    if (req.url === '/v1/state') return json(res, { cards: [openCard(34)], runs: [], lines: [] });
    return json(res, { ok: true });
  }, { sessions });
  try {
    const response = await fetch(`${url}/api/cards/34/answer`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ text: 'OK' }) });
    assert.equal(response.status, 200, '唤醒失败不能让已成功的 answer 变成 5xx');
    assert.equal((await response.json()).schedulingWake, 'failed');
  } finally { await close(server); await close(hub.server); }
});

test('resolve 结案不触发调度唤醒', async () => {
  const sessions = managerStub();
  const { hub, server, url } = await apiFixture((req, res) => {
    if (req.url === '/v1/cards/35/resolve') return json(res, { changed: true });
    if (req.url === '/v1/state') return json(res, { cards: [openCard(35)], runs: [], lines: [] });
    return json(res, { ok: true });
  }, { sessions });
  try {
    const response = await fetch(`${url}/api/cards/35/resolve`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ reason: '已处理' }) });
    assert.equal(response.status, 200);
    assert.equal(sessions.calls.length, 0, 'resolve 是无决策的结案，不应唤醒调度会话');
  } finally { await close(server); await close(hub.server); }
});
