// 没有节点计划的项目行：只有此刻真在跑或有待处理卡片才显示；
// 仅有等待重试/今日完成的巡检活动不再像未归档任务一样常驻项目进度。
import test from 'node:test';
import assert from 'node:assert/strict';

const makeNode = tag => ({
  tag, className: '', textContent: '', dataset: {}, children: [],
  append(...items) { this.children.push(...items); },
  appendChild(item) { this.children.push(item); return item; },
  setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} },
});
globalThis.document = { createElement: makeNode, createTextNode: text => ({ textContent: String(text) }) };
const { renderProjectProgress } = await import('../public/views.mjs');

const rules = [{ name: '巡检', cwd: '/p/patrol', when: { cron: '*/15 * * * *' }, to: 'a' }];
const lineOf = totals => ({ name: '巡检', totals });
const rowsFor = (totals, extra = {}) => renderProjectProgress({ rules, snapshot: { lines: [lineOf(totals)], cards: [], runs: [], ...extra } })
  .filter(node => node.dataset?.chain);
const base = { running: 0, queued: 0, retrying: 0, unknown: 0, done: 0, nothing: 0, doneToday: 0 };

test('只有等待重试与今日完成的无计划项目不显示', () => {
  assert.equal(rowsFor({ ...base, queued: 9, doneToday: 75 }).length, 0);
});

test('无计划项目此刻有任务在跑时显示', () => {
  assert.equal(rowsFor({ ...base, running: 1, doneToday: 75 }).length, 1);
});

test('无计划项目有待处理卡片时显示', () => {
  const cards = [{ id: 1, state: 'open', title: 't', rule: '巡检', options: [] }];
  assert.equal(rowsFor({ ...base, queued: 2 }, { cards }).length, 1);
});
