// #54 接线：生产 gh 适配器必须实现 closePr（publish 关闭被替代 PR 时调用）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGhAdapter } from '../src/dag-gh.mjs';
import { createRunStore, ALLOWED_ACTIONS, ROOT_NODE } from '../src/dag-run.mjs';
import { createSlotRuntime } from '../src/dag-slots.mjs';
import { createPublisher } from '../src/dag-publish.mjs';
import { makeRepo } from './helpers-git.mjs';
import { ensureMirror } from '../src/dag-mirror.mjs';

const PR = 'https://github.com/o/r/pull/12';

test('closePr：执行 gh pr close 并附替代说明', async () => {
  const calls = [];
  const runner = async (cmd, args) => { calls.push([cmd, args]); return { stdout: '' }; };
  const gh = createGhAdapter({ runner });
  await gh.closePr(PR, { comment: '被新 attempt 替代' });
  assert.deepEqual(calls, [['gh', ['pr', 'close', PR, '--comment', '被新 attempt 替代']]]);
});

test('closePr：无 comment 时不带 --comment；非法 PR 链接 fail closed', async () => {
  const calls = [];
  const gh = createGhAdapter({ runner: async (cmd, args) => { calls.push(args); return { stdout: '' }; } });
  await gh.closePr(PR);
  assert.deepEqual(calls, [['pr', 'close', PR]]);
  await assert.rejects(gh.closePr('not-a-url'), /PR 链接/);
  await assert.rejects(gh.closePr(`${PR}\n--evil`), /PR 链接/);
});

test('适配器其余方法契约：findPr/createPr/prHead/mergePr', async () => {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push(args);
    if (args[1] === 'list') return { stdout: JSON.stringify([{ url: PR, number: 12 }]) };
    if (args[1] === 'create') return { stdout: PR };
    if (args[1] === 'view') return { stdout: JSON.stringify({ headRefOid: 'sha-1' }) };
    return { stdout: '' };
  };
  const gh = createGhAdapter({ runner });
  assert.equal(await gh.findPr({ branch: 'feat/a' }), PR);
  assert.equal(await gh.createPr({ branch: 'feat/a', title: 'a' }), PR);
  assert.equal(await gh.prHead(PR), 'sha-1');
  await gh.mergePr(PR, { strategy: 'squash' });
  assert.ok(calls.some(a => a[1] === 'list' && a.includes('--head') && a.includes('feat/a')));
  assert.ok(calls.some(a => a[1] === 'create' && a.includes('--title')));
  assert.ok(calls.some(a => a[1] === 'merge' && a.includes('--squash')));
  await assert.rejects(gh.findPr({ branch: 'bad branch; rm' }), /分支/);
  await assert.rejects(gh.mergePr(PR, { strategy: 'rebase' }), /squash/);
});

test('createPr：非交互式必须带非空 --body（gh 缺 body 会直接失败）', async () => {
  const calls = [];
  const runner = async (cmd, args) => { calls.push(args); return { stdout: PR }; };
  const gh = createGhAdapter({ runner });
  await gh.createPr({ branch: 'feat/a', title: 'a (run-1)' });
  const args = calls[0];
  const bodyAt = args.indexOf('--body');
  assert.ok(bodyAt > 0, '必须传 --body');
  assert.ok(args[bodyAt + 1].trim().length > 0, '--body 不能为空');
  assert.equal(args[args.indexOf('--title') + 1], 'a (run-1)', '标题原样作为单参数传递');
  await gh.createPr({ branch: 'feat/a', title: 'a', base: 'main', body: '自定义说明' });
  assert.deepEqual(calls[1], ['pr', 'create', '--head', 'feat/a', '--title', 'a', '--body', '自定义说明', '--base', 'main']);
});

test('publisher 接入生产 gh 适配器：关闭被替代 PR 不 TypeError', async () => {
  const { project, remote } = makeRepo();
  const storeDirectory = mkdtempSync(path.join(tmpdir(), 'dag-gh-pub-'));
  const store = createRunStore({ directory: storeDirectory });
  const mirror = await ensureMirror({ root: storeDirectory, remoteUrl: remote, baseBranch: 'main' });
  const root = store.createRun({ project, remoteUrl: remote, mirrorPath: mirror.mirrorPath, baseBranch: mirror.baseBranch, baseCommit: mirror.baseCommit, planId: 'p', planDigest: 'd', confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true, nodeId: ROOT_NODE, role: 'dev', nodes: [{ id: 'a', depends_on: [], contract: { files: ['src/a.mjs'] } }] });
  const rt = createSlotRuntime({ project: mirror.mirrorPath, gitDir: mirror.mirrorPath, runId: root.runId });
  await rt.ensureSlots();
  const { baseCommit } = await rt.prepare({ slot: 1, nodeId: 'a', branch: 'feat/a', base: 'refs/heads/main' });
  store.updateRun(root.runId, { publish: { nodes: { a: { prepareBase: baseCommit } } } });
  const closed = []; const created = []; let prNo = 0;
  const runner = async (cmd, args) => {
    if (args[1] === 'list') return { stdout: '[]' };
    if (args[1] === 'create') { created.push(args); return { stdout: `https://gh/pr/${++prNo}` }; }
    if (args[1] === 'close') { closed.push(args[2]); return { stdout: '' }; }
    return { stdout: '' };
  };
  const pub = createPublisher({ store, rootRunId: root.runId, rt, gh: createGhAdapter({ runner }), runTests: async () => ({ exitCode: 0 }), baseRef: 'refs/heads/main', readToken: async () => 'test-gh-token' });
  const ctx = { nodeId: 'a', slot: 1, branch: 'feat/a', worktree: rt.slotPath(1), runId: root.runId, base: baseCommit };
  const write = c => { mkdirSync(path.join(ctx.worktree, 'src'), { recursive: true }); writeFileSync(path.join(ctx.worktree, 'src/a.mjs'), c); };
  write('export const a = 1;\n');
  await pub.commitPr(ctx);
  write('export const a = 2;\n');
  await pub.commitPr({ ...ctx, branch: 'feat/a-att2' });
  assert.equal(closed.length, 1, '旧 PR 被生产适配器关闭');
  assert.equal(prNo, 2);
  // publisher 必须把冻结基底透传给 gh（缺省 --base 会落到仓库默认分支）。
  assert.equal(created[0][created[0].indexOf('--base') + 1], 'main');
});

test('生产适配器 claimHolder：读 PR 评论里的有效审阅占位，无占位返回 null', async () => {
  const { claimMarker } = await import('../src/review-claim.mjs');
  let comments = [];
  const runner = async (cmd, args) => {
    if (args[1] === 'view') return { stdout: JSON.stringify({ comments }) };
    return { stdout: '' };
  };
  const gh = createGhAdapter({ runner });
  assert.equal(await gh.claimHolder(PR), null);
  comments = [{ body: claimMarker({ holder: 'codex-a', head: 'aaa1111', state: 'active' }), createdAt: new Date().toISOString() }];
  assert.equal(await gh.claimHolder(PR), 'codex-a');
  await assert.rejects(gh.claimHolder('not-a-url'), /PR 链接/);
});
