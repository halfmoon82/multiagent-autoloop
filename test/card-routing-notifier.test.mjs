import test from 'node:test';
import assert from 'node:assert/strict';
import { CardNotifier } from '../src/notifier.mjs';
import { createCardRouting } from '../src/card-routing.mjs';
import { createCardDelegateStore } from '../src/card-delegate.mjs';

const card = (id, title, text = '') => ({ id, state: 'open', title, text, createdAt: '2026-11-18T01:00:00Z', project: '/w/demo' });

function build({ active }) {
  const hub = { events: [], resolved: [], cards: [card(1, '旧卡')] };
  const routing = createCardRouting({
    delegateStore: createCardDelegateStore(),
    postEvent: async event => { hub.events.push(event); return {}; },
    resolveCard: async id => { hub.resolved.push(id); hub.cards = hub.cards.filter(c => c.id !== id); },
    onError: () => {},
  });
  if (active) {
    const v = routing.store.createVersion({ rules: [{ id: 'eng-bug', route: 'scheduler', tags: ['eng:bug'], confidence: 0.9 }] });
    routing.store.recordValidation(v.version, { total: 17, humanGateFalseAuto: 0, passed: true });
    routing.activate(v.version);
  }
  const notes = [];
  const notifier = new CardNotifier({ routing, fetchState: async () => ({ cards: hub.cards }), notify: n => notes.push(n) });
  return { hub, notifier, notes, routing };
}

test('轮询发现工程类 open 卡且 active：自动退回，不再打扰人', async () => {
  const { hub, notifier, notes } = build({ active: true });
  await notifier.poll();
  hub.cards.push(card(2, '修复构建 bug', '测试报错'));
  await notifier.poll();
  assert.deepEqual(hub.resolved, [2]);
  assert.equal(hub.events.length, 1);
  assert.deepEqual(notes, []);
});

test('shadow：卡片不动，仍正常通知', async () => {
  const { hub, notifier, notes } = build({ active: false });
  await notifier.poll();
  hub.cards.push(card(2, '修复构建 bug', '测试报错'));
  await notifier.poll();
  assert.equal(hub.events.length, 0);
  assert.equal(notes.length, 1);
});

test('人工门禁词：不自动路由，仍通知人', async () => {
  const { hub, notifier, notes } = build({ active: true });
  await notifier.poll();
  hub.cards.push(card(3, '修复 bug 前需要登录密码'));
  await notifier.poll();
  assert.equal(hub.events.length, 0);
  assert.equal(notes.length, 1);
});

test('路由装配抛错不影响通知', async () => {
  const { hub, notifier, notes } = build({ active: true });
  notifier.routing = { routeOpenCards: async () => { throw new Error('boom'); } };
  await notifier.poll();
  hub.cards.push(card(2, '新事项'));
  await notifier.poll();
  assert.equal(notes.length, 1);
});
