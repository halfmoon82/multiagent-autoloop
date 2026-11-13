import test from 'node:test';
import assert from 'node:assert/strict';
import { formatState, formatNumber, statusLabel, scheduleLabel } from '../public/format.mjs';

test('formatState summarizes workload, attention and spending', () => {
  const view = formatState({
    totals: { running: 2, queued: 3, retrying: 1, unknown: 1, doneToday: 8 },
    spending: { today: { rounds: 9, tokens: 12345, cost: 1.25, missingCost: 1 } },
    cards: [{ id: 1, state: 'open' }, { id: 2, state: 'decided' }],
    agents: [{ online: true }], channels: [{ online: false }],
  });
  assert.equal(view.active, 2);
  assert.equal(view.waiting, 4);
  assert.equal(view.unknown, 1);
  assert.equal(view.doneToday, 8);
  assert.equal(view.openCards, 1);
  assert.equal(view.tokens, '12,345');
  assert.equal(view.cost, '$1.25（1 轮未报）');
});

test('empty and partial state remains readable', () => {
  const view = formatState({});
  assert.equal(view.active, 0);
  assert.equal(view.openCards, 0);
  assert.equal(view.cost, '未上报');
  assert.equal(formatNumber(undefined), '0');
});

test('statuses and schedules use plain Chinese labels', () => {
  assert.equal(statusLabel('claimed'), '运行中');
  assert.equal(statusLabel('unknown'), '失联待核实');
  assert.equal(scheduleLabel({ when: { cron: '0 9 * * *' } }), '定时 · 0 9 * * *');
  assert.equal(scheduleLabel({ when: { source: 'github', types: ['issues.opened'] } }), 'github · issues.opened');
});
