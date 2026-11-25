// decision-card-lifecycle 节点回归（2026-11-25 真机反馈）：
// ①决策卡回答/结案后仍残留在「待我处理」与会话卡组；②卡未绑定会话，按项目串到别的会话。
// 覆盖：回答后过滤、本机刚答隐藏与角标计数同口径、按会话 lane 归属过滤、恢复草稿组剔除已结案卡、
// 移动端回答（选项/文字结案）payload 原样转发 Hub 且重复提交幂等。纯逻辑 + 假 Hub，不调用真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildTodos, buildOverview, buildPages, pendingCards, cardSourceLabel } from '../mobile/src/core/pages.mjs';
import { openCardsBySession, pruneQuestionGroup, createSessionsReader } from '../mobile/src/features/sessions/browser.mjs';
import { cardsToQuestionGroup, submitAnswer, cardsForSession } from '../mobile/src/features/question-group/index.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const card = (id, extra = {}) => ({ id, title: `卡${id}`, state: 'open', options: ['继续', '结案'], project: '/work/p', ...extra });
const snap = cards => ({ available: { state: true }, errors: {}, state: { runs: [], lines: [], cards } });

test('待我处理只列 open 卡：已回答/已结案的卡离开列表，角标与列表同口径', () => {
  const cards = [card(1), card(2, { state: 'decided', choice: '继续' }), card(3, { state: 'closed' }), card(4)];
  const todos = buildTodos(snap(cards));
  assert.deepEqual(todos.items.items.map(item => item.id), [1, 4]);
  assert.ok(todos.items.items.every(item => item.state === 'open' && item.readOnly === false));
  assert.equal(buildOverview(snap(cards)).openTodoCount, 2);
});

test('本机刚回答成功的卡立即隐藏（Hub 重读前），列表与角标计数一起减', () => {
  const cards = [card(1), card(2), card(3)];
  const pages = buildPages(snap(cards), { hiddenIds: new Set(['2']) });
  assert.deepEqual(pages.todos.items.items.map(item => item.id), [1, 3]);
  assert.equal(pages.overview.openTodoCount, 2);
  assert.equal(pages.todos.items.items.filter(item => item.state === 'open').length, 2, 'core 页角标按 todos open 数计');
  assert.equal(buildTodos(snap([card(9)]), { hiddenIds: ['9'] }).items.empty, true);
  assert.deepEqual(pendingCards([card(1), { state: 'open' }], []).map(item => item.id), [1], '无 id 的卡不进待办');
});

test('待我处理标注来源会话：会话 lane 标「来自会话」，系统 lane 与无 lane 不冒充', () => {
  assert.equal(cardSourceLabel(card(1, { lane: 'scheduling:abcdef12-3456' })), '来自会话 abcdef12');
  assert.equal(cardSourceLabel(card(1, { lane: 'scheduling:dag:run-1' })), '');
  assert.equal(cardSourceLabel(card(1, { lane: 'scheduling:card-delegate:7' })), '');
  assert.equal(cardSourceLabel(card(1)), '');
  const [item] = buildTodos(snap([card(5, { lane: 'scheduling:sess-a' })])).items.items;
  assert.equal(item.sourceLabel, '来自会话 sess-a');
  assert.equal(item.lane, 'scheduling:sess-a');
});

test('会话卡按 lane 归属：同项目别的会话的卡、已答卡都不进本会话；无 lane 卡按项目', () => {
  const cards = [
    card(1, { lane: 'scheduling:sess-a' }),
    card(2, { lane: 'scheduling:sess-b' }),
    card(3),
    card(4, { lane: 'scheduling:sess-a', state: 'decided' }),
    card(5, { project: '/work/q' }),
  ];
  const sessionA = { id: 'sess-a', project: '/work/p', hubSubject: 'scheduling:sess-a' };
  const sessionB = { id: 'sess-b', project: '/work/p', hubSubject: 'scheduling:sess-b' };
  assert.deepEqual(openCardsBySession(cards, sessionA, cardsForSession).map(item => item.id), [1, 3]);
  assert.deepEqual(openCardsBySession(cards, sessionB, cardsForSession).map(item => item.id), [2, 3]);
  assert.deepEqual(openCardsBySession(cards, { id: 'sess-x', project: '/work/p' }, cardsForSession).map(item => item.id), [3], '无 hubSubject 不抢别的会话的卡');
  assert.deepEqual(openCardsBySession(cards, sessionA), [], '未给归属口径时不编造');
  assert.deepEqual(openCardsBySession(null, sessionA, cardsForSession), []);
  // 过滤不丢数据：所有 open 卡（含跨会话与规则卡）仍完整在待我处理。
  assert.deepEqual(buildTodos(snap(cards)).items.items.map(item => item.id), [1, 2, 3, 5]);
});

test('会话卡组剔除已结案卡：已答回看行与待答题都去掉，焦点落到剩余未答题', () => {
  let group = cardsToQuestionGroup([card(1), card(2), card(3)], { sessionId: 'sess-a' });
  group = submitAnswer(group, '1', '继续', { ok: true });
  const pruned = pruneQuestionGroup(group, ['3']);
  assert.deepEqual(pruned.questions.map(item => item.id), ['3']);
  assert.deepEqual(pruned.answered, []);
  assert.equal(pruned.activeId, '3');
  assert.equal(pruneQuestionGroup(pruned, ['3']), pruned, '无变化返回原对象');
  assert.equal(pruneQuestionGroup(pruned, []).questions.length, 0, '全部结案后卡组为空（界面隐藏）');
  assert.equal(pruneQuestionGroup(null, []), null);
});

test('会话列表透传 hubSubject，供会话页按事项归属卡片', async () => {
  const reader = createSessionsReader({
    origin: 'https://console.test',
    fetchImpl: async url => ({ ok: true, json: async () => (url.endsWith('/sessions')
      ? { sessions: [{ id: 'sess-a', kind: 'scheduling', hubSubject: 'scheduling:sess-a', updatedAt: '2026-11-25T01:00:00Z' }, { id: 'sess-n', kind: 'normal' }] }
      : { sessions: [] }) }),
  });
  const { snapshot } = await reader.load();
  const byId = Object.fromEntries(snapshot.sessions.map(item => [item.id, item]));
  assert.equal(byId['sess-a'].hubSubject, 'scheduling:sess-a');
  assert.equal(byId['sess-n'].hubSubject, null, '无事项 subject 的会话为 null，不编造');
});

test('移动端回答：选项与文字结案 payload 原样转发 Hub，回答后状态离开 open，重复提交幂等不再写', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-card-lifecycle-'));
  const cards = [card(41, { lane: 'scheduling:sess-a' }), card(42)];
  const answers = [];
  const hub = await fakeHub((req, res, body) => {
    if (req.url === '/v1/state') return json(res, { runs: [], lines: [], cards });
    const match = /^\/v1\/cards\/(\d+)\/answer$/.exec(req.url);
    if (match) {
      const target = cards.find(item => item.id === Number(match[1]));
      answers.push({ id: target.id, body: JSON.parse(body) });
      target.state = 'decided';
      return json(res, { changed: true, id: target.id, state: 'decided' });
    }
    return json(res, { ok: true });
  });
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'k', host: '127.0.0.1', root, deviceAuth, projectRoots: [root] });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); });
  const { deviceToken } = deviceAuth.bindDevice({ token: deviceAuth.createBinding().token, name: '测试手机', platform: 'Android' });
  const post = (id, body) => fetch(`${url}/api/mobile/cards/${id}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-request': '1', 'x-forwarded-proto': 'https', 'x-device-token': deviceToken, origin: new URL(url).origin },
    body: JSON.stringify(body),
  });

  assert.equal((await post(41, { choice: 1 })).status, 200);
  assert.equal((await post(42, { text: '不用做了，结案' })).status, 200);
  assert.deepEqual(answers.map(item => [item.id, item.body.choice ?? item.body.text]), [[41, 1], [42, '不用做了，结案']]);
  assert.ok(answers.every(item => typeof item.body.sourceDeviceId === 'string'));
  const repeat = await post(41, { choice: 0 });
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).idempotent, true);
  assert.equal(answers.length, 2, '已答卡重复提交不再写 Hub');
  assert.equal(buildTodos(snap(cards)).items.empty, true, '回答后待我处理为空');
});

// 冻结设计基线的 verifier（只读）对本节点两项交互必须通过：上一轮返工原因即 answer-vanish/session-bind 标记未命中。
test('设计 verifier：decision-cards 的 answer-vanish 与 session-bind 在实现里命中约定标记', async t => {
  const baseline = path.join(REPO_ROOT, 'docs', 'design', '2026-11-25-nomoto-fix4-baseline');
  const { verify } = await import(pathToFileURL(path.join(baseline, 'verifiers', 'fix4-design.verify.mjs')).href);
  const manifest = JSON.parse(readFileSync(path.join(baseline, 'design-manifest.json'), 'utf8'));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'card-lifecycle-verify-'));
  t.after(() => rmSync(evidenceDir, { recursive: true, force: true }));
  const result = await verify({ worktree: REPO_ROOT, evidenceDir, contract: { surfaceIds: ['decision-cards'] }, designBaseline: { manifest } });
  const byId = Object.fromEntries(result.checks.map(check => [check.id, check.ok]));
  assert.deepEqual(byId, { 'answer-vanish': true, 'session-bind': true });
  assert.equal(result.ok, true);
});
