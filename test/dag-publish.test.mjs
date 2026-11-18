// publish：commit-pr / verify / merge 在真实 git（本地 bare 远端）+ 假 gh 上的行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunStore, ALLOWED_ACTIONS, ROOT_NODE } from '../src/dag-run.mjs';
import { createSlotRuntime } from '../src/dag-slots.mjs';
import { createPublisher, PublishError } from '../src/dag-publish.mjs';
import { designContractDigest } from '../src/design-baseline.mjs';
import { ensureMirror } from '../src/dag-mirror.mjs';
import { makeRepo, sh } from './helpers-git.mjs';

const node = (id, files) => ({ id, depends_on: [], contract: { files } });
async function boot({ actions = ALLOWED_ACTIONS, designBaseline = null, designInScope = false, verifyDesign, ui = false } = {}) {
  const { project, remote } = makeRepo();
  const storeDirectory = mkdtempSync(path.join(tmpdir(), 'dag-pub-'));
  const store = createRunStore({ directory: storeDirectory });
  const mirror = await ensureMirror({ root: storeDirectory, remoteUrl: remote, baseBranch: 'main' });
  const root = store.createRun({
    project, remoteUrl: remote, mirrorPath: mirror.mirrorPath, baseBranch: mirror.baseBranch, baseCommit: mirror.baseCommit,
    planId: 'p', planDigest: 'd', confirmedActionIds: [...actions], confirm: true, nodeId: ROOT_NODE, role: 'dev',
    nodes: [{ ...node('a', designInScope ? ['src/a.mjs', 'docs/design/demo/design-manifest.json'] : ['src/a.mjs']), contract: { files: designInScope ? ['src/a.mjs', 'docs/design/demo/design-manifest.json'] : ['src/a.mjs'], ...(ui ? { design: { surfaceIds: ['overview'], states: ['normal'], interactions: ['open'] } } : {}) } }, node('b', ['src/b.mjs'])], designBaseline,
  });
  const rt = createSlotRuntime({ project: mirror.mirrorPath, gitDir: mirror.mirrorPath, runId: root.runId });
  await rt.ensureSlots();
  const prepared = await rt.prepare({ slot: 1, nodeId: 'a', branch: 'feat/a', base: 'refs/heads/main' });
  store.updateRun(root.runId, { publish: { nodes: { a: { prepareBase: prepared.baseCommit } } } });
  const gh = { prs: new Map(), merged: [], async createPr(a) { const url = `https://gh/pr/${this.prs.size + 1}`; this.prs.set(url, { head: a.branch, sha: null }); return url; },
    async findPr(a) { return [...this.prs].find(([, p]) => p.head === a.branch)?.[0] ?? null; },
    async prHead(url) { return this.prs.get(url).sha; }, async mergePr(url) { this.merged.push(url); return {}; },
    closed: [], async closePr(url, a) { this.closed.push([url, a.comment]); } };
  const tests = []; const runTests = async (cwd) => { tests.push(cwd); return { exitCode: 0, summary: '1 passed' }; };
  const pub = createPublisher({ store, rootRunId: root.runId, rt, gh, runTests, verifyDesign, baseRef: 'refs/heads/main' });
  const ctx = { nodeId: 'a', slot: 1, branch: 'feat/a', worktree: rt.slotPath(1), runId: root.runId, base: prepared.baseCommit };
  const write = (rel, c) => { mkdirSync(path.dirname(path.join(ctx.worktree, rel)), { recursive: true }); writeFileSync(path.join(ctx.worktree, rel), c); };
  return { project, remote, store, root, rt, gh, pub, ctx, write, tests, mirror };
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

// ---- #67 execution-grants：执行层拒绝未选高风险动作 ----
import { buildGrantRecord as buildGrantRecordForPub, canExecuteAction as canExecForPub } from '../src/dag-run.mjs';

test('requireOptionalGrant：执行层按授权记录拒绝未选高风险动作，即使快照有该目录项', async () => {
  const t = await boot();
  // 标准动作授权记录 default 无 deploy，执行层拒绝
  assert.equal(canExecForPub(t.store.getRun(t.root.runId).authorizationSnapshot, 'deploy').reason, 'HIGH_RISK_NOT_SELECTED');
  assert.throws(() => t.pub.requireOptionalGrant('deploy', '部署'), /未选高风险动作|拒绝/);
  // 选中后执行层放行
  const grant = buildGrantRecordForPub({ project: 'p', planDigest: 'd', confirmedActionIds: [...ALLOWED_ACTIONS], selectedOptionalActions: ['deploy'], planOptionalActions: ['deploy'] });
  assert.equal(canExecForPub(grant, 'deploy').ok, true);
});

test('commitPr：设计清单、批准记录和参考产物始终只读，即使误加入节点 scope', async () => {
  const designBaseline = { designDigest: 'a'.repeat(64), readOnlyPaths: ['docs/design/demo/design-manifest.json', 'docs/design/demo/reference.png', 'docs/prd/demo/design-approval.json'] };
  const t = await boot({ designBaseline, designInScope: true });
  t.write('src/a.mjs', 'ok\n');
  t.write('docs/design/demo/design-manifest.json', 'changed\n');
  t.write('docs/design/demo/reference.png', 'changed\n');
  t.write('docs/prd/demo/design-approval.json', 'changed\n');
  await assert.rejects(t.pub.commitPr(t.ctx), error => error.code === 'DESIGN_BASELINE_READONLY');
  assert.throws(() => sh(t.remote, 'rev-parse', 'feat/a'));
});

const uiDesign = () => ({
  designDigest: 'a'.repeat(64), manifestPath: 'docs/design/demo/design-manifest.json',
  manifest: { schema: 1, designId: 'demo', artifacts: [{ path: 'docs/design/demo/reference.png', sha256: 'b'.repeat(64) }], surfaces: [{ id: 'overview', route: '/', viewports: ['1440x900'], states: ['normal'], interactions: ['open'], referencePaths: ['docs/design/demo/reference.png'] }] },
  readOnlyPaths: ['docs/design/demo/design-manifest.json', 'docs/design/demo/reference.png'],
});
const evidenceFor = (root, commit, over = {}) => ({
  commit, designDigest: root.designBaseline.designDigest,
  contractDigest: designContractDigest({ designDigest: root.designBaseline.designDigest, contract: root.nodes[0].contract.design }),
  checks: [{ surfaceId: 'overview', kind: 'interaction', id: 'open', ok: true }], ...over,
});

test('verify：非 UI 节点完全不调用设计 verifier', async () => {
  let calls = 0;
  const t = await boot({ verifyDesign: async () => { calls++; throw new Error('must not run'); } });
  t.write('src/a.mjs', 'x\n'); await t.pub.commitPr(t.ctx);
  const result = await t.pub.verify({ ...t.ctx, commit: 'sha' });
  assert.equal(result.ok, true); assert.equal(calls, 0);
  assert.equal(result.designEvidence, undefined);
});

test('verify：UI 节点只跑定向 checks，visualDiffs 默认不形成硬失败', async () => {
  const designBaseline = uiDesign(); let received;
  const verifyDesign = async input => {
    received = input;
    return { ok: true, evidence: { ...evidenceFor(input.designBaseline ? { designBaseline, nodes: [{ contract: { design: input.contract } }] } : null, input.commit), visualDiffs: [{ surfaceId: 'overview', ok: false, note: 'review-only' }] } };
  };
  const t = await boot({ designBaseline, ui: true, verifyDesign });
  t.write('src/a.mjs', 'x\n'); const pr = await t.pub.commitPr(t.ctx);
  const result = await t.pub.verify({ ...t.ctx, commit: pr.commit });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(received.contract.surfaceIds[0], 'overview');
  assert.equal(result.designEvidence.visualDiffs[0].ok, false);
});

test('verify：UI 缺 verifier 属设施错误；定向断言失败才返回实现失败', async () => {
  const missing = await boot({ designBaseline: uiDesign(), ui: true });
  missing.write('src/a.mjs', 'x\n'); const missingPr = await missing.pub.commitPr(missing.ctx);
  await assert.rejects(missing.pub.verify({ ...missing.ctx, commit: missingPr.commit }), error => error.code === 'DESIGN_VERIFIER_UNAVAILABLE');
  const failing = await boot({ designBaseline: uiDesign(), ui: true, verifyDesign: async input => ({ ok: false, evidence: evidenceFor({ designBaseline: uiDesign(), nodes: [{ contract: { design: input.contract } }] }, input.commit, { checks: [{ surfaceId: 'overview', kind: 'layout', id: 'normal', ok: false }] }) }) });
  failing.write('src/a.mjs', 'x\n'); const failingPr = await failing.pub.commitPr(failing.ctx);
  const result = await failing.pub.verify({ ...failing.ctx, commit: failingPr.commit });
  assert.equal(result.ok, true, '定向 checks 只记录，节点继续由测试结果决定');
  assert.equal(result.designEvidence.checks[0].ok, false);
  assert.match(result.designEvidenceWarning || '', /未全部通过/);
  const noEvidence = await boot({ designBaseline: uiDesign(), ui: true, verifyDesign: async () => ({ ok: true }) });
  noEvidence.write('src/a.mjs', 'x\n'); const ne = await noEvidence.pub.commitPr(noEvidence.ctx);
  const neResult = await noEvidence.pub.verify({ ...noEvidence.ctx, commit: ne.commit });
  assert.equal(neResult.ok, true, 'verifier 不返回证据时不抛裸错，只记警示');
  assert.match(neResult.designEvidenceWarning || '', /未返回证据/);
});

test('merge：设计证据只作汇报，不阻断合并，merge 本身不重跑验证', async () => {
  let verifyCalls = 0;
  const designBaseline = uiDesign();
  const t = await boot({ designBaseline, ui: true, verifyDesign: async input => { verifyCalls++; return { ok: true, evidence: evidenceFor({ designBaseline, nodes: [{ contract: { design: input.contract } }] }, input.commit) }; } });
  t.write('src/a.mjs', 'x\n'); const pr = await t.pub.commitPr(t.ctx); t.gh.prs.get(pr.prUrl).sha = pr.commit;
  const noEvidence = await t.pub.merge({ ...t.ctx, prUrl: pr.prUrl, commit: pr.commit });
  assert.ok(noEvidence.mergeCommit); assert.match(noEvidence.designWarning || '', /证据/);
  const evidence = evidenceFor(t.store.getRun(t.root.runId), pr.commit);
  t.gh.merged.length = 0;
  const mismatch = await t.pub.merge({ ...t.ctx, prUrl: pr.prUrl, commit: pr.commit, evidence: { ...evidence, designDigest: 'c'.repeat(64) } });
  assert.ok(mismatch.mergeCommit); assert.match(mismatch.designWarning || '', /不一致/);
  assert.equal(verifyCalls, 0, 'merge 不得重跑浏览器验证');
});

test('merge：失败 checks 依然合并，但结果里带警示', async () => {
  const designBaseline = uiDesign();
  const t = await boot({ designBaseline, ui: true, verifyDesign: async () => { throw new Error('not called'); } });
  t.write('src/a.mjs', 'x\n'); const pr = await t.pub.commitPr(t.ctx); t.gh.prs.get(pr.prUrl).sha = pr.commit;
  const evidence = evidenceFor(t.store.getRun(t.root.runId), pr.commit, { checks: [{ surfaceId: 'overview', kind: 'layout', id: 'normal', ok: false }] });
  const out = await t.pub.merge({ ...t.ctx, prUrl: pr.prUrl, commit: pr.commit, evidence });
  assert.ok(out.mergeCommit); assert.match(out.designWarning || '', /未全部通过/);
  assert.equal(t.gh.merged.length, 1);
});

test('commitPr：越界文件只汇报、不阻断', async () => {
  const t = await boot();
  t.write('src/a.mjs', 'ok\n'); t.write('src/b.mjs', 'not mine\n');
  const out = await t.pub.commitPr(t.ctx);
  assert.deepEqual(out.outOfScope, ['src/b.mjs']);
  assert.equal(sh(t.remote, 'rev-parse', 'feat/a'), out.commit, '越界也照常推送，由 PR 审阅兜底');
});

test('verify：设计 verifier 造成的槽位变化同样被记录', async () => {
  const designBaseline = uiDesign();
  const verifyDesign = async input => {
    writeFileSync(path.join(input.worktree, 'src', 'a.mjs'), 'verifier mutation\n');
    return { ok: true, evidence: evidenceFor({ designBaseline, nodes: [{ contract: { design: input.contract } }] }, input.commit) };
  };
  const t = await boot({ designBaseline, ui: true, verifyDesign });
  t.write('src/a.mjs', 'x\n'); const pr = await t.pub.commitPr(t.ctx);
  const result = await t.pub.verify({ ...t.ctx, commit: pr.commit });
  assert.equal(result.slotStateChanged, true);
});

test('commitPr：worker 先提交的范围外文件被汇报，但不再阻断推送', async () => {
  const t = await boot();
  t.write('src/b.mjs', 'not mine\n');
  sh(t.ctx.worktree, 'add', 'src/b.mjs'); sh(t.ctx.worktree, 'commit', '-qm', 'worker precommit');
  const out = await t.pub.commitPr(t.ctx);
  assert.deepEqual(out.outOfScope, ['src/b.mjs']);
  assert.equal(sh(t.remote, 'rev-parse', 'feat/a'), out.commit);
});

test('commitPr：worker 先提交的设计只读文件仍拒绝，不推送不建 PR', async () => {
  const t = await boot({ designBaseline: uiDesign(), ui: true });
  t.write('docs/design/demo/reference.png', 'changed\n');
  sh(t.ctx.worktree, 'add', 'docs/design/demo/reference.png'); sh(t.ctx.worktree, 'commit', '-qm', 'worker precommit design');
  await assert.rejects(t.pub.commitPr(t.ctx), error => error.code === 'DESIGN_BASELINE_READONLY');
  assert.throws(() => sh(t.remote, 'rev-parse', 'feat/a'));
});

test('verify：UI verifier 执行前槽位 HEAD 必须等于待验证 commit', async () => {
  const designBaseline = uiDesign();
  const verifyDesign = async input => evidenceFor({ designBaseline, nodes: [{ contract: { design: input.contract } }] }, input.commit);
  const t = await boot({ designBaseline, ui: true, verifyDesign });
  t.write('src/a.mjs', 'x\n'); const pr = await t.pub.commitPr(t.ctx);
  t.write('src/a.mjs', 'post-commit\n'); sh(t.ctx.worktree, 'add', 'src/a.mjs'); sh(t.ctx.worktree, 'commit', '-qm', 'post commit');
  await assert.rejects(t.pub.verify({ ...t.ctx, commit: pr.commit }), error => error.code === 'DESIGN_WORKTREE_HEAD_MISMATCH');
});

test('verify：UI verifier 执行前槽位必须干净', async () => {
  const designBaseline = uiDesign();
  const verifyDesign = async input => evidenceFor({ designBaseline, nodes: [{ contract: { design: input.contract } }] }, input.commit);
  const t = await boot({ designBaseline, ui: true, verifyDesign });
  t.write('src/a.mjs', 'x\n'); const pr = await t.pub.commitPr(t.ctx);
  t.write('src/a.mjs', 'dirty after commit\n');
  await assert.rejects(t.pub.verify({ ...t.ctx, commit: pr.commit }), error => error.code === 'DESIGN_WORKTREE_DIRTY');
});

test('commitPr：worker 移动 origin/main 也按冻结 base 汇报越界文件', async () => {
  const t = await boot();
  const frozenBase = sh(t.project, 'rev-parse', 'main');
  t.write('secret/extra.txt', 'out of scope\n');
  sh(t.ctx.worktree, 'add', 'secret/extra.txt'); sh(t.ctx.worktree, 'commit', '-qm', 'out of scope');
  const moved = sh(t.ctx.worktree, 'rev-parse', 'HEAD');
  sh(t.mirror.mirrorPath, 'update-ref', 'refs/heads/main', moved);
  t.write('src/a.mjs', 'in scope\n');
  sh(t.ctx.worktree, 'add', 'src/a.mjs'); sh(t.ctx.worktree, 'commit', '-qm', 'in scope');
  const out = await t.pub.commitPr({ ...t.ctx, base: frozenBase });
  assert.deepEqual(out.outOfScope, ['secret/extra.txt'], '越界判定仍基于冻结 base');
  assert.equal(sh(t.remote, 'rev-parse', 'feat/a'), out.commit);
});

test('commitPr rejects symbolic base refs such as origin/main', async () => {
  const t = await boot();
  t.write('src/a.mjs', 'x\n');
  await assert.rejects(t.pub.commitPr({ ...t.ctx, base: 'origin/main' }), error => error.code === 'BASE_NOT_COMMIT');
  assert.throws(() => sh(t.remote, 'rev-parse', 'feat/a'));
});

test('commitPr does not execute Git clean filters configured by worker', async () => {
  const t = await boot();
  const marker = path.join(tmpdir(), `commit-filter-${process.pid}.txt`);
  const script = path.join(tmpdir(), `commit-filter-${process.pid}.sh`);
  writeFileSync(script, `#!/bin/sh\nprintf 'filter-ran\\n' > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  mkdirSync(path.join(t.project, '.git', 'info'), { recursive: true });
  writeFileSync(path.join(t.project, '.git', 'info', 'attributes'), 'src/a.mjs filter=bad\n');
  sh(t.project, 'config', 'filter.bad.clean', script);
  try {
    t.write('src/a.mjs', 'export const a = 1;\n');
    await t.pub.commitPr(t.ctx);
    assert.equal(existsSync(marker), false, 'commitPr 不得执行 clean filter');
  } finally { rmSync(marker, { force: true }); rmSync(script, { force: true }); }
});

test('commitPr requires the base frozen in the server-side root run', async () => {
  const t = await boot();
  t.write('src/a.mjs', 'x\n');
  const other = sh(t.project, 'commit-tree', sh(t.project, 'rev-parse', 'main^{tree}'), '-m', 'other');
  await assert.rejects(t.pub.commitPr({ ...t.ctx, base: other }), error => error.code === 'BASE_MISMATCH');
  assert.throws(() => sh(t.remote, 'rev-parse', 'feat/a'));
});

test('commitPr pushes to the remote URL frozen in the root run, not worker-modified origin', async () => {
  const t = await boot();
  const evil = `${t.remote}-evil`;
  sh(path.dirname(t.remote), 'init', '-q', '--bare', evil);
  sh(t.project, 'remote', 'set-url', 'origin', evil);
  t.write('src/a.mjs', 'export const a = 1;\n');
  const pr = await t.pub.commitPr(t.ctx);
  assert.equal(sh(t.remote, 'rev-parse', 'feat/a'), pr.commit);
  assert.throws(() => sh(evil, 'rev-parse', 'feat/a'));
});

test('commitPr：凭据/CI/发布脚本类敏感路径仍然硬拦', async () => {
  const t = await boot();
  t.write('src/a.mjs', 'ok\n');
  t.write('.github/workflows/ci.yml', 'name: ci\n');
  await assert.rejects(t.pub.commitPr(t.ctx), error => error.code === 'SENSITIVE_PATH');
  assert.throws(() => sh(t.remote, 'rev-parse', 'feat/a'));
});
