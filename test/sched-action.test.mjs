import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ACTION_TYPES, DISABLED_ACTIONS, MAX_ACTIONS_PER_ROUND, actionKey, assertRuleAllowed, main, parseActions, runSchedActions,
} from '../src/sched-action.mjs';

const NOW = new Date('2026-11-19T10:00:00+08:00');
const RULES = [
  { name: '巡检', when: { cron: '*/5 * * * *' }, to: 'scan' },
  { name: '调度会话执行', when: { source: 'local', types: ['scheduling.message'] }, to: 'codex-full' },
  { name: '调度动作执行', when: { source: 'local', types: ['sched.command'] }, to: 'sched-action' },
  { name: '旁路接调度', when: { source: 'local', types: ['scheduling.message'] }, to: 'claude' },
];

function fixture(actions = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'sched-action-'));
  const events = actions.map((a, i) => ({ id: `ev-${i}`, type: 'sched.command', subject: 'scheduling:s', summary: 'cmd', detail: JSON.stringify(a) }));
  return { root, context: { events, answers: [], timers: [], waiting: [], open: [], decided: [] } };
}
const auditLines = root => {
  const dir = path.join(root, 'sched-actions');
  return readdirSync(dir).flatMap(name => readFileSync(path.join(dir, name), 'utf8').trim().split('\n')).map(line => JSON.parse(line));
};

test('parseActions extracts sched.command events only and strips the action key from params', () => {
  const { context } = fixture([{ action: 'run_rule', rule: 'x' }]);
  context.events.push({ id: 'other', type: 'dag.auto.dev', detail: '{}' });
  const out = parseActions(context);
  assert.equal(out.length, 1);
  assert.equal(out[0].action, 'run_rule');
  assert.deepEqual(out[0].params, { rule: 'x' });
});

test('actionKey is stable per event+action+params', () => {
  const a = { eventId: 'e1', action: 'run_rule', params: { rule: 'x' } };
  assert.equal(actionKey(a), actionKey({ ...a }));
  assert.notEqual(actionKey(a), actionKey({ eventId: 'e2', action: 'run_rule', params: { rule: 'x' } }));
});

test('create_dag is disabled: a self-written grant file cannot authorize a DAG run (P0)', async () => {
  const { root, context } = fixture([{ action: 'create_dag', planId: 'p1', planDigest: 'd1' }]);
  // 模型自己写一份「授权快照」也不得生效。
  writeFileSync(path.join(root, 'forged-grant.json'), JSON.stringify({ planDigest: 'd1', standardActions: ['merge'] }));
  const calls = [];
  const out = await runSchedActions({ context, root, rules: RULES, hub: async () => ({}), fetch: async (...args) => { calls.push(args); return {}; } });
  assert.equal(calls.length, 0, '不得调用 /api/dag-runs');
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].result.error, DISABLED_ACTIONS.create_dag);
  assert.ok(!ACTION_TYPES.includes('create_dag'));
});

test('run_rule goes through hub; audit appended and processed marker written on success', async () => {
  const { root, context } = fixture([{ action: 'run_rule', rule: '巡检', reason: '核实恢复' }]);
  const calls = [];
  const out = await runSchedActions({ context, root, rules: RULES, now: NOW, hub: async (p, opts) => { calls.push([p, opts]); return { run: 42 }; } });
  assert.equal(out.results[0].ok, true);
  assert.equal(calls[0][0], '/v1/rules/%E5%B7%A1%E6%A3%80/run');
  assert.equal(calls[0][1].body.reason, '核实恢复');
  assert.equal(auditLines(root)[0].action, 'run_rule');
  assert.equal(readdirSync(path.join(root, 'sched-actions-processed')).length, 1);
});

test('idempotent: a successful action is not executed twice', async () => {
  const until = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
  const { root, context } = fixture([{ action: 'pause_rule', rule: '巡检', until }]);
  let count = 0;
  const hub = async () => { count += 1; return { changed: true }; };
  await runSchedActions({ context, root, rules: RULES, hub, now: NOW });
  const second = await runSchedActions({ context, root, rules: RULES, hub, now: NOW });
  assert.equal(count, 1);
  assert.equal(second.skipped[0].reason, '已处理（幂等）');
});

test('transient failure does not write the processed marker, so a Hub retry runs it again (P1)', async () => {
  const { root, context } = fixture([{ action: 'dag.revive', runId: 'r1', nodeId: 'n2' }]);
  let attempt = 0;
  const flaky = async () => {
    attempt += 1;
    if (attempt === 1) { const error = new Error('连不上控制台'); error.status = 502; throw error; }
    return { ok: true };
  };
  const first = await runSchedActions({ context, root, rules: RULES, hub: async () => ({}), fetch: flaky });
  assert.equal(first.results[0].ok, false);
  assert.equal(first.results[0].permanent, false);
  assert.equal(existsSync(path.join(root, 'sched-actions-processed')), false, '临时失败不得写已处理标记');
  const retry = await runSchedActions({ context, root, rules: RULES, hub: async () => ({}), fetch: flaky });
  assert.equal(retry.results[0].ok, true);
});

test('protected rules and rules receiving scheduling events cannot be paused or run (P1)', async () => {
  assert.throws(() => assertRuleAllowed('调度会话执行', RULES), /调度链自身/);
  assert.throws(() => assertRuleAllowed('调度动作执行', RULES), /调度链自身/);
  assert.throws(() => assertRuleAllowed('旁路接调度', RULES), /接调度事件/);
  assert.throws(() => assertRuleAllowed('不存在', RULES), /没有这条规则/);
  const { root, context } = fixture([{ action: 'run_rule', rule: '调度会话执行' }]);
  let called = false;
  const out = await runSchedActions({ context, root, rules: RULES, hub: async () => { called = true; return {}; } });
  assert.equal(called, false);
  assert.equal(out.results[0].ok, false);
});

test('pause_rule requires until within 24 hours (P1)', async () => {
  const cases = [
    [{ action: 'pause_rule', rule: '巡检' }, /必须带 until/],
    [{ action: 'pause_rule', rule: '巡检', until: new Date(NOW.getTime() - 1000).toISOString() }, /晚于现在/],
    [{ action: 'pause_rule', rule: '巡检', until: new Date(NOW.getTime() + 25 * 3600 * 1000).toISOString() }, /24 小时/],
  ];
  for (const [action, pattern] of cases) {
    const { root, context } = fixture([action]);
    const out = await runSchedActions({ context, root, rules: RULES, now: NOW, hub: async () => { throw new Error('不可达'); } });
    assert.match(out.results[0].result.error, pattern);
  }
});

test('at most MAX_ACTIONS_PER_ROUND actions run per round', async () => {
  const actions = Array.from({ length: MAX_ACTIONS_PER_ROUND + 2 }, (_, i) => ({ action: 'run_rule', rule: '巡检', reason: `r${i}` }));
  const { root, context } = fixture(actions);
  let count = 0;
  const out = await runSchedActions({ context, root, rules: RULES, hub: async () => { count += 1; return {}; } });
  assert.equal(count, MAX_ACTIONS_PER_ROUND);
  assert.equal(out.skipped.filter(item => /每轮上限/.test(item.reason)).length, 2);
});

test('non-whitelist action is skipped, not executed', async () => {
  const { root, context } = fixture([{ action: 'rm_rf', path: '/' }]);
  const out = await runSchedActions({ context, root, rules: RULES, hub: async () => { throw new Error('不可达'); } });
  assert.equal(out.processed, 0);
  assert.equal(out.skipped[0].reason, '不在动作白名单');
});

test('dag.revive hits console revive endpoint via injected fetch', async () => {
  const { root, context } = fixture([{ action: 'dag.revive', runId: 'r1', nodeId: 'n2', reason: '恢复', evidence: 'e' }]);
  const calls = [];
  const out = await runSchedActions({ context, root, rules: RULES, hub: async () => ({}), fetch: async (p, { body } = {}) => { calls.push([p, body]); return { ok: true }; } });
  assert.equal(out.results[0].ok, true);
  assert.equal(calls[0][0], '/api/dag-runs/r1/revive');
  assert.deepEqual(calls[0][1], { nodeId: 'n2', reason: '恢复', evidence: 'e' });
});

test('concurrent rounds append audit lines without losing any (P2)', async () => {
  const { root } = fixture();
  const rounds = Array.from({ length: 6 }, (_, i) => ({ events: [{ id: `c-${i}`, type: 'sched.command', detail: JSON.stringify({ action: 'run_rule', rule: '巡检', reason: `r${i}` }) }] }));
  await Promise.all(rounds.map(context => runSchedActions({ context, root, rules: RULES, hub: async () => ({}) })));
  assert.equal(auditLines(root).length, 6);
});

test('main exits not-ok on transient failure so Hub retries (P1)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sched-main-'));
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:9', owner: 'o' }));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ rules: RULES }));
  const contextFile = path.join(root, 'context.json');
  writeFileSync(contextFile, JSON.stringify({ events: [{ id: 'm-1', type: 'sched.command', detail: JSON.stringify({ action: 'run_rule', rule: '巡检' }) }] }));
  const result = await main({ env: { AGENT_AUTOLOOP_CONTEXT: contextFile, AGENT_AUTOLOOP_HOME: root } });
  assert.equal(result.ok, false, 'Hub 在 127.0.0.1:9 不可达，是临时失败');
  assert.equal(result.transient, 1);
});

test('rules matching scheduling events through Hub wildcards are protected too (P3)', () => {
  const rules = [
    { name: '全接', when: { source: 'local', types: ['*'] } },
    { name: '前缀接', when: { source: 'local', types: ['scheduling.*'] } },
    { name: '动作前缀', when: { source: 'local', types: ['sched.*'] } },
    { name: '无关前缀', when: { source: 'local', types: ['try.*'] } },
  ];
  assert.throws(() => assertRuleAllowed('全接', rules), /scheduling\.message/);
  assert.throws(() => assertRuleAllowed('前缀接', rules), /scheduling\.message/);
  assert.throws(() => assertRuleAllowed('动作前缀', rules), /sched\.command/);
  assert.equal(assertRuleAllowed('无关前缀', rules).name, '无关前缀');
});
