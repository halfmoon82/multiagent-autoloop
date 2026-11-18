import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ACTION_TYPES, actionKey, parseActions, runSchedActions, SchedActionError,
} from '../src/sched-action.mjs';

const grant = (over = {}) => ({
  schema: 2, project: '/proj/a', repo: null, mergeStrategy: 'squash',
  planDigest: 'digest-1', standardActions: ['dispatch', 'merge'], optionalGrants: [],
  allowedActions: ['dispatch', 'merge'], revision: 1, digest: 'gd', createdAt: 'x', ...over,
});

function fixture({ grants = [], actions = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'sched-action-'));
  if (grants.length) {
    mkdirSync(path.join(root, 'dag-grants'), { recursive: true });
    for (const g of grants) writeFileSync(path.join(root, 'dag-grants', `${g.planId || 'p1'}.json`), JSON.stringify(g));
  }
  const events = actions.map((a, i) => ({
    id: `ev-${i}`, type: 'sched.command', subject: 'scheduling:s', summary: 'cmd',
    detail: JSON.stringify(a),
  }));
  return { root, context: { events, answers: [], timers: [], waiting: [], open: [], decided: [] } };
}

test('parseActions extracts sched.command events only', () => {
  const { context } = fixture({ actions: [{ action: 'run_rule', rule: 'x' }] });
  context.events.push({ id: 'other', type: 'dag.auto.dev', detail: '{}' });
  const out = parseActions(context);
  assert.equal(out.length, 1);
  assert.equal(out[0].action, 'run_rule');
  assert.equal(out[0].params.rule, 'x');
  assert.equal(out[0].eventId, 'ev-0');
});

test('actionKey is stable per event+action+params', () => {
  const a = { eventId: 'e1', action: 'run_rule', params: { rule: 'x' } };
  assert.equal(actionKey(a), actionKey({ ...a }));
  assert.notEqual(actionKey(a), actionKey({ eventId: 'e2', action: 'run_rule', params: { rule: 'x' } }));
});

test('create_dag replays server-side grant; event must not carry confirm/授权 fields', async () => {
  const { root, context } = fixture({
    grants: [grant({ planId: 'p1' })],
    actions: [{ action: 'create_dag', planId: 'p1', planDigest: 'digest-1' }],
  });
  const calls = [];
  const consoleCall = async (pathname, { body } = {}) => { calls.push([pathname, body]); return { runId: 'run-9' }; };
  const ok = await runSchedActions({ context, root, hub: async () => ({}), fetch: consoleCall });
  assert.equal(ok.results[0].ok, true);
  assert.equal(calls[0][0], '/api/dag-runs');
  assert.equal(calls[0][1].confirm, true);
  assert.deepEqual(calls[0][1].confirmedActionIds, ['dispatch', 'merge']);
  assert.equal(calls[0][1].selectedOptionalActions.length, 0);
  // 事件携带授权字段被拒
  const bad = await runSchedActions({ context: fixture({
    actions: [{ action: 'create_dag', planId: 'p1', planDigest: 'digest-1', confirmedActionIds: ['x'] }],
  }).context, root, hub: async () => ({}) });
  assert.equal(bad.results[0].ok, false);
  assert.match(bad.results[0].result.error, /不得携带 confirm|授权字段/);
});

test('create_dag without grant snapshot fails closed', async () => {
  const { root, context } = fixture({ actions: [{ action: 'create_dag', planId: 'p9', planDigest: 'x' }] });
  const out = await runSchedActions({ context, root, hub: async () => ({}) });
  assert.equal(out.results[0].ok, false);
  assert.match(out.results[0].result.error, /授权快照/);
});

test('run_rule / pause_rule go through injected hub; writes audit + processed marker', async () => {
  const { root, context } = fixture({ actions: [{ action: 'run_rule', rule: '巡检', reason: '核实恢复' }] });
  const calls = [];
  const hub = async (p, opts) => { calls.push([p, opts]); return { run: 42 }; };
  const out = await runSchedActions({ context, root, hub });
  assert.equal(out.processed, 1);
  assert.equal(out.results[0].ok, true);
  assert.equal(calls[0][0], '/v1/rules/%E5%B7%A1%E6%A3%80/run');
  assert.equal(calls[0][1].body.reason, '核实恢复');
  const audit = readFileSync(path.join(root, 'sched-actions', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  assert.match(audit, /run_rule/);
  assert.ok(existsSync(path.join(root, 'sched-actions-processed')) || existsSync(path.join(root, 'sched-actions-processed')));
});

test('idempotent: same event id + action replays are skipped', async () => {
  const { root, context } = fixture({ actions: [{ action: 'pause_rule', rule: 'r1' }] });
  const hub = async () => ({ changed: true });
  const first = await runSchedActions({ context, root, hub });
  const second = await runSchedActions({ context, root, hub });
  assert.equal(first.processed, 1);
  assert.equal(second.processed, 0);
  assert.equal(second.skipped[0].reason, '已处理（幂等）');
});

test('non-whitelist action is skipped, not executed', async () => {
  const { root, context } = fixture({ actions: [{ action: 'rm_rf', path: '/' }] });
  const out = await runSchedActions({ context, root, hub: async () => { throw new Error('不可达'); } });
  assert.equal(out.processed, 0);
  assert.equal(out.skipped[0].reason, '不在动作白名单');
});

test('dag.revive hits console revive endpoint via injected fetch', async () => {
  const { root, context } = fixture({ actions: [{ action: 'dag.revive', runId: 'r1', nodeId: 'n2', reason: '恢复', evidence: 'e' }] });
  const calls = [];
  const consoleCall = async (pathname, { body } = {}) => { calls.push([pathname, body]); return { ok: true }; };
  const out = await runSchedActions({ context, root, hub: async () => ({}), fetch: consoleCall });
  assert.equal(out.results[0].ok, true);
  assert.equal(calls[0][0], '/api/dag-runs/r1/revive');
  assert.deepEqual(calls[0][1], { nodeId: 'n2', reason: '恢复', evidence: 'e' });
});
