// 没有节点计划的项目不再出现在项目任务进度：这块面板只画有真实进度（串行链）的项目。
// 无计划的空壳行只有计数、没有任务，随规则运行/卡片忽隐忽现，被误认为无法归档的幽灵任务；
// 运行中、等待重试、待处理卡片在「正在运行 / 等待重试 / 待调度处理」等面板里各有归处。
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

test('无计划项目不论有何活动都不显示', () => {
  assert.equal(rowsFor({ ...base, queued: 9, doneToday: 75 }).length, 0, '只有排队/今日完成');
  assert.equal(rowsFor({ ...base, running: 1, doneToday: 75 }).length, 0, '有任务在跑');
  const cards = [{ id: 1, state: 'open', title: 't', rule: '巡检', options: [] }];
  assert.equal(rowsFor({ ...base, queued: 2 }, { cards }).length, 0, '有待处理卡片');
});

// 串行链行的正向渲染需要真实 DOM，由 test/browser.spec.mjs 覆盖。
test('只有无计划项目有活动时给出空态', () => {
  const nodes = renderProjectProgress({ rules, snapshot: { lines: [lineOf({ ...base, running: 1 })], cards: [], runs: [] } });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].dataset?.chain, undefined, '只剩空态提示');
  assert.ok(String(nodes[0].textContent).includes('还没有节点计划'));
});
