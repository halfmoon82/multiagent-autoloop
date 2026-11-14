import test from 'node:test';
import assert from 'node:assert/strict';
import { CardNotifier } from '../src/notifier.mjs';

const openCard = (id, title, createdAt = '2026-11-14T01:00:00Z', project = '/workspace/demo') => ({ id, state: 'open', title, createdAt, project });

test('first poll only seeds, then new open cards notify exactly once', async () => {
  const calls = [];
  const states = [
    { cards: [openCard(1, '旧卡片')] },
    { cards: [openCard(1, '旧卡片'), openCard(2, '是否上线新定价')] },
    { cards: [openCard(1, '旧卡片'), openCard(2, '是否上线新定价')] },
    { cards: [openCard(1, '旧卡片'), openCard(2, '是否上线新定价')] },
  ];
  const notifier = new CardNotifier({ intervalMs: 60000, fetchState: async () => states.shift() ?? states.at(-1), notify: item => calls.push(item) });
  await notifier.poll();
  assert.deepEqual(calls, [], 'initial snapshot must seed without notifying');
  await notifier.poll();
  assert.equal(calls.length, 1, 'exactly one notification for the new card');
  assert.match(calls[0].title, /待/);
  assert.match(calls[0].body, /是否上线新定价/);
  assert.match(calls[0].body, /demo/);
  await notifier.poll();
  assert.equal(calls.length, 1, 'the same open card must not notify again');
});

test('a closed card that reopens with a new createdAt notifies again', async () => {
  const calls = [];
  const states = [
    { cards: [openCard(1, '凭据过期')] },
    { cards: [] },
    { cards: [openCard(1, '凭据过期', '2026-11-14T03:00:00Z')] },
  ];
  const notifier = new CardNotifier({ intervalMs: 60000, fetchState: async () => states.shift() ?? states.at(-1), notify: item => calls.push(item) });
  await notifier.poll();
  await notifier.poll();
  assert.equal(calls.length, 0, 'card disappearing must not notify');
  await notifier.poll();
  assert.equal(calls.length, 1, 'reopened card with a new createdAt is a new decision');
});

test('hub failures are swallowed and notification errors never break polling', async () => {
  const calls = [];
  let failFetch = true;
  let step = 0;
  const states = [
    { cards: [openCard(1, '新卡片')] },
    { cards: [openCard(1, '新卡片'), openCard(2, '凭据门禁')] },
    { cards: [openCard(1, '新卡片'), openCard(2, '凭据门禁')] },
  ];
  const notifier = new CardNotifier({
    intervalMs: 60000,
    fetchState: async () => {
      if (failFetch) throw new Error('中台断线');
      return states[Math.min(step++, states.length - 1)];
    },
    notify: item => { calls.push(item); throw new Error('通知失败'); },
  });
  await notifier.poll();
  failFetch = false;
  await notifier.poll();
  assert.equal(calls.length, 0, 'the first successful poll after an outage only seeds');
  await notifier.poll();
  assert.equal(calls.length, 1, 'notification attempted exactly once despite notifier errors');
  await notifier.poll();
  assert.equal(calls.length, 1, 'a throwing notifier must not break later dedupe');
});

test('the polling handle is unref’d so notifications never keep the process alive', () => {
  let captured = null;
  const fakeTimer = { unref: () => { fakeTimer.unrefCalled = true; } };
  const notifier = new CardNotifier({
    intervalMs: 60000,
    fetchState: async () => ({ cards: [] }),
    setTimer: () => captured = fakeTimer,
    clearTimer: () => {},
  });
  notifier.start();
  assert.equal(captured, fakeTimer);
  assert.equal(fakeTimer.unrefCalled, true, 'interval handle must be unref’d');
  notifier.stop();
});
