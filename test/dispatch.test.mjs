import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateDispatchInput, DispatchError, createDispatcher } from '../src/dispatch.mjs';

const valid = { subject: 'fix-login-bug', summary: '修复登录', detail: '详细说明', project: '/p/demo', model: 'gpt-5.6' };

test('validateDispatchInput accepts a well-formed request', () => {
  const out = validateDispatchInput(valid);
  assert.equal(out.subject, 'fix-login-bug');
  assert.equal(out.agent, 'Codex ACP');
});

test('validateDispatchInput rejects bad subject and missing fields', () => {
  for (const bad of [
    { ...valid, subject: 'has space' }, { ...valid, subject: '中文标识' }, { ...valid, subject: '' },
    { ...valid, subject: undefined }, { ...valid, summary: '' }, { ...valid, project: undefined }, { ...valid, model: undefined },
    { ...valid, subject: '-leading' }, { ...valid, detail: 5 },
  ]) assert.throws(() => validateDispatchInput(bad), DispatchError, JSON.stringify(bad));
});

function harness({ gitFail = false, startFail = false, rollbackFail = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dispatch-'));
  const gitCalls = []; const starts = [];
  const sessions = { fail: startFail, async start(args) { starts.push(args); if (sessions.fail) throw new Error('boom'); return { id: 'sess-1', status: 'running' }; } };
  const git = async (cwd, args) => { gitCalls.push({ cwd, args }); if (gitFail) throw new Error('git boom'); if (rollbackFail && args[0] !== 'worktree' || rollbackFail && args[1] === 'remove') throw new Error('rollback boom'); };
  const dispatcher = createDispatcher({ root, sessions, git, now: () => new Date('2026-11-16T00:00:00Z') });
  return { root, dispatcher: Object.assign(dispatcher, { sessions }), gitCalls, starts };
}

test('dispatch creates worktree + branch, starts a worker session and registers the task', async () => {
  const { root, dispatcher, gitCalls, starts } = harness();
  const task = await dispatcher.dispatch(validateDispatchInput(valid));
  assert.equal(task.status, 'running');
  assert.equal(task.sessionId, 'sess-1');
  assert.equal(task.branch, 'feat/fix-login-bug');
  assert.equal(task.worktree, path.join('/p/demo', '.worktrees', 'fix-login-bug'));
  assert.deepEqual(gitCalls[0].args, ['worktree', 'add', task.worktree, '-b', 'feat/fix-login-bug']);
  assert.equal(gitCalls[0].cwd, '/p/demo');
  assert.equal(starts[0].project, task.worktree);
  // 仅断言传给 sessions.start 的参数（mock）；真实 start 目前不识别 profile/model，依赖 PR #49，见 docs/dispatch-task.md
  assert.equal(starts[0].profile, 'worker');
  assert.match(starts[0].prompt, /修复登录/);
  assert.deepEqual(task.cost, { status: 'unreported' });
  assert.equal(task.model, 'gpt-5.6');
  assert.equal(task.agent, 'Codex ACP');
  const stored = JSON.parse(readFileSync(path.join(root, 'dispatch-tasks', `${task.id}.json`), 'utf8'));
  assert.equal(stored.subject, 'fix-login-bug');
  assert.equal(dispatcher.list().length, 1);
});

test('duplicate subject is rejected with 409 and does not touch git', async () => {
  const { dispatcher, gitCalls } = harness();
  await dispatcher.dispatch(validateDispatchInput(valid));
  await assert.rejects(dispatcher.dispatch(validateDispatchInput(valid)), e => e.status === 409);
  assert.equal(gitCalls.length, 1);
});

test('git failure registers a failed task and surfaces 502', async () => {
  const { dispatcher, starts } = harness({ gitFail: true });
  await assert.rejects(dispatcher.dispatch(validateDispatchInput(valid)), e => e.status === 502);
  assert.equal(starts.length, 0);
  assert.equal(dispatcher.list()[0].status, 'failed');
});

test('session start failure registers a failed task', async () => {
  const { dispatcher } = harness({ startFail: true });
  await assert.rejects(dispatcher.dispatch(validateDispatchInput(valid)), e => e.status === 502);
  const [task] = dispatcher.list();
  assert.equal(task.status, 'failed');
  assert.match(task.error, /boom/);
});

test('failed task does not block re-dispatching the same subject', async () => {
  const { dispatcher } = harness({ startFail: true });
  await assert.rejects(dispatcher.dispatch(validateDispatchInput(valid)), e => e.status === 502);
  dispatcher.sessions.fail = false;
  const task = await dispatcher.dispatch(validateDispatchInput(valid));
  assert.equal(task.status, 'running');
  assert.equal(dispatcher.list().length, 2);
  await assert.rejects(dispatcher.dispatch(validateDispatchInput(valid)), e => e.status === 409);
});

test('session start failure rolls back the worktree and branch', async () => {
  const { dispatcher, gitCalls } = harness({ startFail: true });
  await assert.rejects(dispatcher.dispatch(validateDispatchInput(valid)), e => e.status === 502);
  const wt = path.join('/p/demo', '.worktrees', 'fix-login-bug');
  assert.deepEqual(gitCalls[1].args, ['worktree', 'remove', '--force', wt]);
  assert.deepEqual(gitCalls[2].args, ['branch', '-D', 'feat/fix-login-bug']);
  assert.equal(gitCalls.every(c => c.cwd === '/p/demo'), true);
});

test('rollback git errors do not mask the original failure', async () => {
  const { dispatcher } = harness({ startFail: true, rollbackFail: true });
  await assert.rejects(dispatcher.dispatch(validateDispatchInput(valid)), e => e.status === 502 && /boom/.test(e.message));
});

test('cost is only taken from agent self-report, never estimated', async () => {
  const { dispatcher } = harness();
  const task = await dispatcher.dispatch(validateDispatchInput(valid));
  assert.deepEqual(dispatcher.get(task.id).cost, { status: 'unreported' });
  const updated = await dispatcher.reportCost(task.id, { tokens: 1200, costUsd: 0.5 });
  assert.deepEqual(updated.cost, { status: 'reported', tokens: 1200, costUsd: 0.5 });
  await assert.rejects(dispatcher.reportCost(task.id, { tokens: -1 }), DispatchError);
  await assert.rejects(dispatcher.reportCost(task.id, {}), DispatchError);
  await assert.rejects(dispatcher.reportCost('nope', { tokens: 1 }), e => e.status === 404);
});

test('registry survives a restart (reloads from disk)', async () => {
  const { root, dispatcher } = harness();
  await dispatcher.dispatch(validateDispatchInput(valid));
  const again = createDispatcher({ root, sessions: {}, git: async () => {} });
  assert.equal(again.list().length, 1);
  assert.ok(existsSync(path.join(root, 'dispatch-tasks')) && readdirSync(path.join(root, 'dispatch-tasks')).length === 1);
});
