// card-two-places-consistency 节点回归（2026-11-26 晨两个缺陷）：
// ①在「待办」答完决策卡后卡仍留在会话窗（两处展示不同步）；
// ②同一张卡两处出现，一处处理后另一处点「已处理」报 409/「目标不存在或已失效」且卡永久残留。
// 口径：任一处办结后所有展示位置同步收起；409（已办结）幂等成功并给轻提示；真失败保留卡片。
// 纯逻辑 + 假 Hub + 假 fetch，不调用真实模型、不操作真实规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createSessionsWrite, openCardsBySession, pruneQuestionGroup,
  markCardAnswered, markCardAnsweredLocal, isCardAnsweredLocal, locallyAnsweredIds, resetLocallyAnswered,
  onLocallyAnsweredChange,
} from '../mobile/src/features/sessions/browser.mjs';
import { buildCardAnsweredNotice } from '../mobile/src/features/sessions/views.mjs';
import { cardsForSession, cardsToQuestionGroup } from '../mobile/src/features/question-group/index.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const fakeClient = () => ({ origin: 'https://console.example', tokenStore: { get: async () => 'device-token' } });
const openCard = (id, extra = {}) => ({
  id, state: 'open', title: `决策卡 ${id}`, options: ['同意', '拒绝'],
  project: '/work/p', lane: 'scheduling:sess-a', createdAt: '2026-11-26T08:00:00Z', ...extra,
});
const sessionA = { id: 'sess-a', project: '/work/p', hubSubject: 'scheduling:sess-a' };

test('统一状态源变化订阅：登记即通知、可退订、单个监听器异常不影响他人（review P2-1）', () => {
  resetLocallyAnswered();
  const seen = [];
  const offBroken = onLocallyAnsweredChange(() => { throw new Error('监听器自身异常'); });
  const off = onLocallyAnsweredChange(id => seen.push(id));
  assert.equal(onLocallyAnsweredChange(null)(), undefined, '非函数入参返回空退订不抛错');
  markCardAnsweredLocal(91, { choice: 0 });
  assert.deepEqual(seen, ['91'], '登记统一状态源即通知订阅方（待办页据此重渲染）');
  off();
  offBroken();
  markCardAnsweredLocal(92, { text: '好' });
  assert.deepEqual(seen, ['91'], '退订后不再通知');
  resetLocallyAnswered();
});

test('统一「卡已答」状态源：待办回答后会话卡归属过滤同步收起该卡', () => {
  resetLocallyAnswered();
  const cards = [openCard(7), openCard(8)];
  assert.deepEqual(openCardsBySession(cards, sessionA, cardsForSession).map(item => item.id), [7, 8]);
  // 与 fix4 markCardAnswered 合并：卡片本地标记已答 + 登记统一状态源，不改原数组。
  const marked = markCardAnswered(cards, 7, { choice: 1 });
  assert.equal(marked[0].state, 'answered');
  assert.equal(cards[0].state, 'open', '不修改原卡片');
  assert.deepEqual(locallyAnsweredIds(), ['7']);
  assert.equal(isCardAnsweredLocal(7), true);
  assert.deepEqual(openCardsBySession(cards, sessionA, cardsForSession).map(item => item.id), [8], '会话窗不再显示已答卡');
  // 会话卡组剔除后，焦点落到剩余未答题。
  const group = cardsToQuestionGroup(cards, { sessionId: 'sess-a' });
  const pruned = pruneQuestionGroup(group, openCardsBySession(cards, sessionA, cardsForSession).map(item => String(item.id)));
  assert.deepEqual(pruned.questions.map(item => item.id), ['8']);
  resetLocallyAnswered();
});

test('写客户端任何一处办结成功都登记统一状态源（回答/已处理/结案/退回）', async () => {
  resetLocallyAnswered();
  const calls = [];
  const write = createSessionsWrite(fakeClient(), {
    fetchImpl: async (url, init) => {
      calls.push(new URL(url).pathname);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await write.answerCard(11, { choice: 1 });
  await write.markHandled(12);
  await write.resolveCard(13);
  await write.delegateCard(14);
  assert.deepEqual(locallyAnsweredIds(), ['11', '12', '13', '14']);
  assert.deepEqual(calls, [
    '/api/mobile/cards/11/answer', '/api/mobile/cards/12/resolve',
    '/api/mobile/cards/13/resolve', '/api/mobile/cards/14/delegate',
  ]);
  resetLocallyAnswered();
});

test('409 幂等成功：服务端明示 idempotent 的 409 视为办结、本地收起且不残留', async () => {
  resetLocallyAnswered();
  const write = createSessionsWrite(fakeClient(), {
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ ok: true, idempotent: true, state: 'decided' }) }),
  });
  const result = await write.markHandled(15);
  assert.equal(result.idempotent, true);
  assert.equal(isCardAnsweredLocal(15), true, '另一处已办结也收起本地卡');
  const notice = buildCardAnsweredNotice(result, openCard(15));
  assert.match(notice.text, /已在别处办结/);
  assert.equal(notice.tone, 'ok');
  resetLocallyAnswered();
});

test('选项回答（answerCard）遇 409 幂等同样静默收起：登记统一状态源并给轻提示', async () => {
  resetLocallyAnswered();
  const write = createSessionsWrite(fakeClient(), {
    fetchImpl: async () => ({
      ok: false, status: 409,
      json: async () => ({ error: '目标不存在或已失效', idempotent: true, state: 'decided' }),
    }),
  });
  const result = await write.answerCard(21, { choice: 1 });
  assert.equal(result.ok, true, '409 幂等按成功返回，不抛错');
  assert.equal(result.idempotent, true);
  assert.equal(isCardAnsweredLocal(21), true, '选项回答遇 409 也收起本地卡');
  assert.equal(isCardAnsweredLocal('21'), true, '数字/字符串 id 同一口径，待办与会话窗共享过滤');
  const notice = buildCardAnsweredNotice(result, openCard(21));
  assert.match(notice.text, /已在别处办结/);
  assert.equal(notice.tone, 'ok');
  assert.equal(buildCardAnsweredNotice({ idempotent: false }, openCard(21)), null, '真失败不出轻提示');
  resetLocallyAnswered();
});

test('真失败（502/无 idempotent 标记的 409）报错并保留卡片，不进已答源', async () => {
  resetLocallyAnswered();
  const offline = createSessionsWrite(fakeClient(), {
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ error: '操作暂时不可用，请稍后重试' }) }),
  });
  await assert.rejects(() => offline.answerCard(16, { choice: 0 }), /操作暂时不可用/);
  assert.equal(isCardAnsweredLocal(16), false);
  const stale = createSessionsWrite(fakeClient(), {
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: '事项已失效' }) }),
  });
  await assert.rejects(() => stale.answerCard(17, { choice: 0 }), /事项已失效/);
  assert.equal(isCardAnsweredLocal(17), false);
  assert.equal(buildCardAnsweredNotice({ idempotent: false }), null, '真失败不出轻提示');
  resetLocallyAnswered();
});

// ---------- 服务端：Hub 409/卡已不在状态 → 幂等成功，不再把卡永久留在界面 ----------
async function setup(t, { cards = [], resolveHandler = null, answerHandler = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'card-two-places-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ rules: [], agents: {}, sources: {} }));
  const resolves = [];
  const answers = [];
  const hub = await fakeHub((req, res, body) => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch { /* 交由被测代码处理 */ }
    if (req.url === '/v1/state') return json(res, { cards, runs: [], lines: [] });
    let match;
    if ((match = /^\/v1\/cards\/(\d+)\/resolve$/.exec(req.url))) {
      resolves.push({ id: Number(match[1]), payload });
      return resolveHandler ? resolveHandler(req, res, payload, Number(match[1])) : json(res, { ok: true });
    }
    if ((match = /^\/v1\/cards\/(\d+)\/answer$/.exec(req.url))) {
      answers.push({ id: Number(match[1]), payload });
      return answerHandler ? answerHandler(req, res, payload, Number(match[1])) : json(res, { ok: true });
    }
    return json(res, { ok: true });
  });
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const bound = deviceAuth.bindDevice({ token: deviceAuth.createBinding().token, name: '测试手机', platform: 'Android' });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', host: '127.0.0.1', root, rulesFile, deviceAuth });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); });
  const post = (cardId, action, body) => fetch(`${url}/api/mobile/cards/${cardId}/${action}`, {
    method: 'POST',
    headers: {
      'x-console-request': '1', 'x-forwarded-proto': 'https', origin: new URL(url).origin,
      'content-type': 'application/json', 'x-device-token': bound.deviceToken,
    },
    body: JSON.stringify(body),
  });
  return { post, resolves, answers };
}

test('一处已处理后另一处点「已处理」：Hub 409 响应标幂等，卡不再残留', async t => {
  const ctx = await setup(t, {
    cards: [openCard(31)],
    resolveHandler: (req, res) => json(res, { error: '目标不存在或已失效' }, 409),
  });
  const response = await ctx.post(31, 'resolve', { reason: '已处理' });
  // 状态码保持 409（网页/旧客户端契约不变），响应体标 idempotent 供新客户端静默收起。
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.idempotent, true);
  assert.equal(body.state, 'decided');
  assert.equal(ctx.resolves.length, 1);
});

test('选项回答遇到 Hub 409 也标幂等；Hub 不可用（502）仍报错保留卡片', async t => {
  const conflict = await setup(t, {
    cards: [openCard(32)],
    answerHandler: (req, res) => json(res, { error: '事项已失效或已处理' }, 409),
  });
  const ok = await conflict.post(32, 'answer', { choice: 0 });
  assert.equal(ok.status, 409);
  assert.equal((await ok.json()).idempotent, true);

  const down = await setup(t, {
    cards: [openCard(33)],
    resolveHandler: (req, res) => json(res, { error: '中台暂不可用' }, 500),
  });
  const failed = await down.post(33, 'resolve', { reason: '结案' });
  assert.equal(failed.status >= 400, true, '真失败不是幂等成功');
  assert.equal((await failed.json()).idempotent, undefined);
});

test('卡已从 Hub 状态消失（valid id 但查无此卡）按办结幂等收起，非法 id 仍 404', async t => {
  const ctx = await setup(t, { cards: [] });
  const missing = await ctx.post(34, 'resolve', { reason: '已处理' });
  assert.equal(missing.status, 200);
  assert.equal((await missing.json()).idempotent, true);
  const invalid = await ctx.post('not-a-number', 'resolve', { reason: '已处理' });
  assert.equal(invalid.status, 404);
});

// ---------- 待办页写客户端（core/write.mjs）：与会话窗同一状态源 ----------
test('待办页 createCoreWrite.answerCard：成功与幂等 409 都登记统一已答源，真失败不登记', async () => {
  const { createCoreWrite } = await import('../mobile/src/core/write.mjs');
  resetLocallyAnswered();
  const mk = res => createCoreWrite({ ...fakeClient(), api: async () => ({}) }, { fetchImpl: async () => res });
  const ok = await mk({ ok: true, status: 200, json: async () => ({ id: 31 }) }).answerCard(31, { choice: 0 });
  assert.equal(ok.id, 31);
  assert.equal(isCardAnsweredLocal(31), true);
  const idem = await mk({ ok: false, status: 409, json: async () => ({ error: 'x', idempotent: true }) }).answerCard(32, { choice: 1 });
  assert.equal(idem.ok, true);
  assert.equal(idem.idempotent, true);
  assert.equal(isCardAnsweredLocal(32), true, '待办页 409 幂等收起并与会话窗同源');
  await assert.rejects(() => mk({ ok: false, status: 409, json: async () => ({ error: '事项已失效' }) }).answerCard(33, { choice: 0 }), /事项已失效/);
  await assert.rejects(() => mk({ ok: false, status: 502, json: async () => ({ error: '不可用' }) }).answerCard(34, { choice: 0 }), /不可用/);
  assert.equal(isCardAnsweredLocal(33) || isCardAnsweredLocal(34), false);
  resetLocallyAnswered();
});
