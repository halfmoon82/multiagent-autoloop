// publish：commit-pr / verify / merge 在真实 git（本地 bare 远端）+ 假 gh 上的行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunStore, ALLOWED_ACTIONS, ROOT_NODE } from '../src/dag-run.mjs';
import { createSlotRuntime } from '../src/dag-slots.mjs';
import { createPublisher, PublishError } from '../src/dag-publish.mjs';
import { makeRepo, sh } from './helpers-git.mjs';

const node = (id, files) => ({ id, depends_on: [], contract: { files } });
async function boot({ actions = ALLOWED_ACTIONS } = {}) {
  const { project, remote } = makeRepo();
  const store = createRunStore({ directory: mkdtempSync(path.join(tmpdir(), 'dag-pub-')) });
  const root = store.createRun({ project, planId: 'p', planDigest: 'd', confirmedActionIds: [...actions], confirm: true, nodeId: ROOT_NODE, role: 'dev', nodes: [node('a', ['src/a.mjs']), node('b', ['src/b.mjs'])] });
  const rt = createSlotRuntime({ project, runId: root.runId });
  await rt.ensureSlots();
  await rt.prepare({ slot: 1, nodeId: 'a', branch: 'feat/a', base: 'main' });
  const gh = { prs: new Map(), merged: [], async createPr(a) { const url = `https://gh/pr/${this.prs.size + 1}`; this.prs.set(url, { head: a.branch, sha: null }); return url; },
    async findPr(a) { return [...this.prs].find(([, p]) => p.head === a.branch)?.[0] ?? null; },
    async prHead(url) { return this.prs.get(url).sha; }, async mergePr(url) { this.merged.push(url); return {}; },
    closed: [], async closePr(url, a) { this.closed.push([url, a.comment]); } };
  const tests = []; const runTests = async (cwd) => { tests.push(cwd); return { exitCode: 0, summary: '1 passed' }; };
  const pub = createPublisher({ store, rootRunId: root.runId, rt, gh, runTests });
  const ctx = { nodeId: 'a', slot: 1, branch: 'feat/a', worktree: rt.slotPath(1), runId: root.runId };
  const write = (rel, c) => { mkdirSync(path.dirname(path.join(ctx.worktree, rel)), { recursive: true }); writeFileSync(path.join(ctx.worktree, rel), c); };
  return { project, remote, store, root, rt, gh, pub, ctx, write, tests };
}

test('commitPr：只提交文件范围内改动，推送分支，创建 PR 并回传 SHA；重复调用幂等', async () => {
  const t = await boot();
  t.write('src/a.mjs', 'export const a = 1;\n');
  const first = await t.pub.commitPr(t.ctx);
  assert.equal(first.commit, sh(t.rt.slotPath(1), 'rev-parse', 'HEAD'));
  assert.equal(sh(t.remote, 'rev-parse', 'feat/a'), first.commit, '已推送到远端分支');
  t.gh.prs.get(first.prUrl).sha = first.commit;
  const again = await t.pub.commitPr(t.ctx);
  assert.deepEqual(again, first); assert.equal(t.gh.prs.size, 1, 'PR 复用');
});

test('commitPr：范围外文件（含新文件）拒绝，且不提交不推送', async () => {
  const t = await boot();
  t.write('src/a.mjs', 'ok\n'); t.write('src/b.mjs', 'not mine\n');
  await assert.rejects(t.pub.commitPr(t.ctx), /范围/);
  assert.throws(() => sh(t.remote, 'rev-parse', 'feat/a'));
  assert.equal(sh(t.rt.slotPath(1), 'rev-parse', 'HEAD'), sh(t.project, 'rev-parse', 'main'));
});

test('commitPr：快照未授权 push-branch/create-pr 时拒绝', async () => {
  const t = await boot({ actions: ['worktree', 'run-tests'] });
  t.write('src/a.mjs', 'x\n');
  await assert.rejects(t.pub.commitPr(t.ctx), /未授权|授权/);
  assert.throws(() => sh(t.remote, 'rev-parse', 'feat/a'));
});

test('verify：在槽位跑离线测试并回传证据；前后槽位状态变化记录', async () => {
  const t = await boot();
  t.write('src/a.mjs', 'x\n'); await t.pub.commitPr(t.ctx);
  const ver = await t.pub.verify({ ...t.ctx, commit: 'whatever' });
  assert.equal(ver.ok, true); assert.equal(t.tests[0], t.ctx.worktree);
  assert.equal(ver.tests.exitCode, 0);
});

test('merge：远端 PR head 与已审 SHA 不一致拒绝；一致则合并，快照未授权 squash-merge 拒绝', async () => {
  const t = await boot();
  t.write('src/a.mjs', 'x\n');
  const pr = await t.pub.commitPr(t.ctx);
  t.gh.prs.get(pr.prUrl).sha = 'deadbeef';
  await assert.rejects(t.pub.merge({ ...t.ctx, prUrl: pr.prUrl, commit: pr.commit }), /head/);
  assert.equal(t.gh.merged.length, 0);
  t.gh.prs.get(pr.prUrl).sha = pr.commit;
  const out = await t.pub.merge({ ...t.ctx, prUrl: pr.prUrl, commit: pr.commit });
  assert.ok(out.mergeCommit); assert.deepEqual(t.gh.merged, [pr.prUrl]);
  const noMerge = await boot({ actions: ['worktree', 'push-branch', 'create-pr'] });
  await assert.rejects(noMerge.pub.merge({ ...noMerge.ctx, prUrl: 'u', commit: 'c' }), /squash-merge|授权/);
});

test('merge 拒绝未登记的 PR（publish 只处理 run.json 登记的 PR）', async () => {
  const t = await boot();
  await assert.rejects(t.pub.merge({ ...t.ctx, prUrl: 'https://gh/pr/999', commit: 'c' }), /未登记/);
});

test('commitPr：同节点换分支发新 PR 时关闭旧 PR 并注明被替代；已 merged/他节点 PR 不动；未授权则保留', async () => {
  const t = await boot();
  t.write('src/a.mjs', 'export const a = 1;\n');
  const first = await t.pub.commitPr(t.ctx);
  t.store.registerPr(t.root.runId, 'b', 'https://gh/pr/other');
  t.write('src/a.mjs', 'export const a = 2;\n');
  const second = await t.pub.commitPr({ ...t.ctx, branch: 'feat/a-att2' });
  assert.notEqual(second.prUrl, first.prUrl);
  assert.deepEqual(t.gh.closed.map(c => c[0]), [first.prUrl]);
  assert.match(t.gh.closed[0][1], new RegExp(second.prUrl.replace(/[/.]/g, '.')));
  const prs = t.store.getRun(t.root.runId).prs;
  assert.equal(prs.find(p => p.prUrl === first.prUrl).state, 'closed');
  assert.equal(prs.find(p => p.prUrl === first.prUrl).supersededBy, second.prUrl);
  assert.equal(prs.find(p => p.prUrl === 'https://gh/pr/other').state, 'open');
  await t.pub.commitPr({ ...t.ctx, branch: 'feat/a-att2' });
  assert.equal(t.gh.closed.length, 1, '重复调用幂等');
});

test('commitPr：快照未授权 close-superseded-pr 时旧 PR 保留', async () => {
  const t = await boot({ actions: ALLOWED_ACTIONS.filter(a => a !== 'close-superseded-pr') });
  t.write('src/a.mjs', 'export const a = 1;\n'); await t.pub.commitPr(t.ctx);
  t.write('src/a.mjs', 'export const a = 2;\n'); await t.pub.commitPr({ ...t.ctx, branch: 'feat/a-att2' });
  assert.equal(t.gh.closed.length, 0);
});

test('merge：fetch 失败即报错，不回退本地 baseRef tip', async () => {
  const t = await boot();
  t.write('src/a.mjs', 'export const a = 1;\n');
  const pr = await t.pub.commitPr(t.ctx); t.gh.prs.get(pr.prUrl).sha = pr.commit;
  const realGit = t.rt.git; t.rt.git = async (cwd, args) => { if (args[0] === 'fetch') throw new Error('network down'); return realGit(cwd, args); };
  await assert.rejects(t.pub.merge({ ...t.ctx, prUrl: pr.prUrl, commit: pr.commit }), /network down/);
});
