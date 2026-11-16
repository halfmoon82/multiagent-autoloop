// dag-run 控制器所需的增量方法：节点 run 派生、publish 字段写回、PR 合并登记。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunStore, ALLOWED_ACTIONS } from '../src/dag-run.mjs';

const setup = () => createRunStore({ directory: mkdtempSync(path.join(tmpdir(), 'dag-ext-')) });
const input = { project: '/p', planId: 'plan-1', planDigest: 'd1', confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true, nodeId: 'a', role: 'dev' };

test('createNodeRun 继承授权快照，同节点同角色重复创建被拒，不触发项目级 409', () => {
  const store = setup();
  const root = store.createRun(input);
  const b = store.createNodeRun(root.runId, { nodeId: 'b', role: 'dev' });
  assert.equal(b.status, 'queued');
  assert.equal(b.authorizationSnapshot.digest, root.authorizationSnapshot.digest);
  assert.equal(b.generation, 1);
  assert.throws(() => store.createNodeRun(root.runId, { nodeId: 'b', role: 'dev' }), /已存在/);
  assert.throws(() => store.createNodeRun(root.runId, { nodeId: 'c', role: 'bogus' }), /role/);
});

test('updateRun 只允许写 publish 白名单字段并合并', () => {
  const store = setup();
  const run = store.createRun(input);
  const a = store.updateRun(run.runId, { publish: { commit: 'abc', branch: 'feat/x' } });
  const b = store.updateRun(run.runId, { publish: { tests: { exitCode: 0 } } });
  assert.deepEqual([b.publish.commit, b.publish.branch, b.publish.tests.exitCode], ['abc', 'feat/x', 0]);
  assert.equal(a.runId, b.runId);
  assert.throws(() => store.updateRun(run.runId, { status: 'done' }), /不允许/);
  assert.throws(() => store.updateRun(run.runId, { authorizationSnapshot: {} }), /不允许/);
});

test('markPrMerged 只作用于已登记 PR 且幂等', () => {
  const store = setup();
  const run = store.createRun(input);
  assert.throws(() => store.markPrMerged(run.runId, 'https://x/pr/1', { mergeCommit: 'm1' }), /未登记/);
  store.registerPr(run.runId, 'a', 'https://x/pr/1');
  const pr = store.markPrMerged(run.runId, 'https://x/pr/1', { mergeCommit: 'm1' });
  assert.deepEqual([pr.state, pr.mergeCommit], ['merged', 'm1']);
  assert.equal(store.markPrMerged(run.runId, 'https://x/pr/1', { mergeCommit: 'm2' }).mergeCommit, 'm1');
});
