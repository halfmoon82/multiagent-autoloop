// #54 生产装配：Hub 适配（经 /v1/events，不起 ACP）、启动恢复、有界轮询、blocked 证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALLOWED_ACTIONS, ROOT_NODE, createRunStore } from '../src/dag-run.mjs';
import { createBlockedEvidence, createHubAdapter, createDagRuntime, dagEventType, defaultRunTests, startDagControllers, MIN_POLL_MS } from '../src/dag-runtime.mjs';
import { designContractDigest } from '../src/design-baseline.mjs';
import { ensureMirror } from '../src/dag-mirror.mjs';
import { makeRepo, sh } from './helpers-git.mjs';
import { mkNode } from './dag-fakes.mjs';

const recorder = (responses = {}) => {
  const calls = [];
  const request = async (config, p, opts = {}) => {
    calls.push({ p, method: opts.method || 'GET', body: opts.body, auth: opts.auth });
    const r = responses[`${opts.method || 'GET'} ${p}`];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(opts) : r ?? {};
  };
  return { calls, request };
};
const run = { runId: 'r1', project: '/p/My Project', nodeId: 'n1', role: 'dev', generation: 1, attempt: 1 };

test('dagEventType：只含安全字符且不超过 64 字符', () => {
  assert.equal(dagEventType('/p/My Project', 'dev'), 'dag.my-project.dev');
  const long = dagEventType('/p/' + 'x'.repeat(200), 'review');
  assert.ok(long.length <= 64 && /^dag\.[a-z0-9-]+\.review$/.test(long));
});

test('hub.dispatch 走 POST /v1/events，事件 id 由 runId 决定（幂等）', async () => {
  const { calls, request } = recorder({ 'POST /v1/events': { event: 42, duplicate: false, routed: ['x'] } });
  const hub = createHubAdapter({ config: {}, request });
  const res = await hub.dispatch({ run, slot: 2, worktree: '/w', branch: 'b', expectedAdvanceId: 'e1', model: null, prompt: 'p' });
  assert.deepEqual(res, { hubRunId: 42 });
  assert.equal(calls[0].body.id, 'dag:r1');
  assert.equal(calls[0].body.type, 'dag.my-project.dev');
  assert.equal(JSON.parse(calls[0].body.detail).expectedAdvanceId, 'e1');
  await assert.rejects(() => createHubAdapter({ config: {}, request: recorder({ 'POST /v1/events': {} }).request }).dispatch({ run, slot: 1, worktree: '/w', branch: 'b', prompt: 'p' }), /未确认/);
});

test('hub.dispatch：提示超 4000 字符不截断，全文落盘、事件正文只放读取路径', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dag-spill-'));
  const { calls, request } = recorder({ 'POST /v1/events': { event: 7 } });
  const hub = createHubAdapter({ config: { root }, request });
  const big = '节点契约'.repeat(2000);
  const res = await hub.dispatch({ run, slot: 1, worktree: '/w', branch: 'b', expectedAdvanceId: 'e1', prompt: big });
  assert.deepEqual(res, { hubRunId: 7 });
  const detail = JSON.parse(calls[0].body.detail);
  assert.ok(calls[0].body.detail.length <= 4000);
  const file = detail.prompt.slice(detail.prompt.lastIndexOf(root));
  assert.equal(readFileSync(file, 'utf8').trim(), big);
  assert.equal(detail.expectedAdvanceId, 'e1');
  rmSync(root, { recursive: true, force: true });
});

test('hub.getRun：无 run=queued，终态与回执映射；404=unknown；不可达抛错不改状态', async () => {
  const outcomes = [{ event: 1, runs: [] }, { event: 1, runs: [{ run: 3, state: 'done', events: [{ type: 'dag.x.advance', detail: '{"outcome":"done"}' }, { type: 'dag.x.advance', detail: 'not json' }] }] }];
  let i = 0;
  const { request } = recorder({ 'GET /v1/events/1': () => outcomes[i++] });
  const hub = createHubAdapter({ config: {}, request });
  assert.equal((await hub.getRun(1)).status, 'queued');
  const done = await hub.getRun(1);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.receipts, [{ outcome: 'done' }, { malformed: true }]);
  const notFound = Object.assign(new Error('x'), { status: 404 });
  assert.equal((await createHubAdapter({ config: {}, request: recorder({ 'GET /v1/events/9': notFound }).request }).getRun(9)).status, 'unknown');
  await assert.rejects(() => createHubAdapter({ config: {}, request: recorder({ 'GET /v1/events/9': new Error('down') }).request }).getRun(9), /down/);
});

test('getRun 回执解析：纯文本 key=value 回执被解析为合法对象，非回执文本标记 malformed', async () => {
  const receipt = 'advanceId=r:a:dev:1:1 runId=r nodeId=a role=dev generation=1 attempt=1 outcome=done prUrl=https://x/pr/1';
  const outcomes = [{ event: 1, runs: [{ run: 3, state: 'done', events: [
    { type: 'dag.node.advance', detail: receipt },
    { type: 'dag.node.advance', detail: 'a=b c=d' },           // 无 advanceId → malformed
    { type: 'dag.auto.review.advance', detail: 'not json' },   // 非回执事件类型也走同一解析 → malformed
  ] }] }];
  let i = 0; const { request } = recorder({ 'GET /v1/events/1': () => outcomes[i++] });
  const hub = createHubAdapter({ config: {}, request });
  const { receipts } = await hub.getRun(1);
  assert.deepEqual(receipts[0], { advanceId: 'r:a:dev:1:1', runId: 'r', nodeId: 'a', role: 'dev', generation: 1, attempt: 1, outcome: 'done', prUrl: 'https://x/pr/1' });
  assert.deepEqual(receipts[1], { malformed: true });
  assert.deepEqual(receipts[2], { malformed: true });
});

test('getRun 回执解析：纯文本 advanceId 空值仍标记 malformed', async () => {
  const outcomes = [{ event: 1, runs: [{ run: 3, state: 'done', events: [{ type: 'dag.node.advance', detail: 'advanceId= runId=r outcome=done' }] }] }];
  let i = 0; const { request } = recorder({ 'GET /v1/events/1': () => outcomes[i++] });
  const { receipts } = await createHubAdapter({ config: {}, request }).getRun(1);
  assert.deepEqual(receipts, [{ malformed: true }]);
});

test('getRun 回执解析：JSON detail 含 advanceId 优先走 JSON 路径，不走纯文本', async () => {
  const outcomes = [{ event: 1, runs: [{ run: 3, state: 'done', events: [{ type: 'dag.node.advance', detail: '{"advanceId":"r:a:dev:1:1","custom":"x"}' }] }] }];
  let i = 0; const { request } = recorder({ 'GET /v1/events/1': () => outcomes[i++] });
  const { receipts } = await createHubAdapter({ config: {}, request }).getRun(1);
  assert.deepEqual(receipts, [{ advanceId: 'r:a:dev:1:1', custom: 'x' }]);
});

test('hub.cancel 只取消未终态 run', async () => {
  const { calls, request } = recorder({ 'GET /v1/events/1': { event: 1, runs: [{ run: 3, state: 'done', events: [] }, { run: 4, state: 'queued', events: [] }, { run: 5, state: 'unknown', events: [] }] } });
  await createHubAdapter({ config: {}, request }).cancel(1);
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => c.p), ['/v1/runs/4/cancel']);
});

// 中台授权规则（不改 hub.mjs 的前提下由调用点选密钥）：
//   /v1/events 读与写 → source；/v1/runs/:id/cancel、/v1/state → owner（默认）。
test('hub 适配器按中台授权规则选密钥：事件读写用 source，cancel/state 保持 owner 默认', async () => {
  {
    const { calls, request } = recorder({ 'POST /v1/events': { event: 42 } });
    await createHubAdapter({ config: {}, request }).dispatch({ run, slot: 2, worktree: '/w', branch: 'b', expectedAdvanceId: 'e1', model: null, prompt: 'p' });
    const post = calls.find(c => c.p === '/v1/events' && c.method === 'POST');
    assert.equal(post.auth, 'source', '派发事件必须带 source 密钥，否则中台回「要来源自己的密钥」401');
  }
  {
    const { calls, request } = recorder({ 'GET /v1/events/1': { event: 1, runs: [] } });
    await createHubAdapter({ config: {}, request }).getRun(1);
    const get = calls.find(c => c.p === '/v1/events/1' && c.method === 'GET');
    assert.equal(get.auth, 'source', '读取事件结果必须带 source 密钥，否则中台回 401');
  }
  {
    const { calls, request } = recorder({ 'GET /v1/events/1': { event: 1, runs: [{ run: 4, state: 'queued', events: [] }] } });
    await createHubAdapter({ config: {}, request }).cancel(1);
    const cancelPost = calls.find(c => c.p === '/v1/runs/4/cancel' && c.method === 'POST');
    assert.ok(cancelPost, '应发出 run cancel POST');
    assert.equal(cancelPost.auth, undefined, 'run cancel 必须走 owner 默认，不能带 source（否则中台回「要本人自己的密钥」401）');
  }
  {
    const { calls, request } = recorder({ 'GET /v1/state': {} });
    await createBlockedEvidence({ config: {}, request })({ run: {} });
    const state = calls.find(c => c.p === '/v1/state' && c.method === 'GET');
    assert.equal(state.auth, undefined, 'state 读取保持 owner 默认');
  }
});

test('blocked 证据（2026-11-22 回执韧性）：已派发以 Hub run 活性为证据，终态即自动复活；从未派发且 Hub 可达自动复活；Hub 不可达抛错', async () => {
  // 已派发 + Hub run 仍存活（claimed/queued）→ 保持阻塞
  const alive = createBlockedEvidence({ request: recorder({ 'GET /v1/events/7': { runs: [{ run: 3, state: 'claimed' }] } }).request, config: {} });
  assert.deepEqual(await alive({ run: { hub: { hubRunId: 7 } } }), { blocked: true, detail: 'Hub run 3 仍 claimed，worker 未交回，维持阻塞' });
  // 已派发 + Hub run 终态（done/nothing/cancelled/failed）→ 证据消失，自动复活
  for (const state of ['done', 'nothing', 'cancelled', 'failed']) {
    const done = createBlockedEvidence({ request: recorder({ 'GET /v1/events/7': { runs: [{ run: 3, state }] } }).request, config: {} });
    const verdict = await done({ run: { hub: { hubRunId: 7 } } });
    assert.equal(verdict.blocked, false, `Hub run ${state} 应视为证据消失`);
    assert.match(verdict.detail, /终态/);
  }
  // 已派发 + Hub 事件无 run 记录（派发未落地）→ 自动复活
  const empty = createBlockedEvidence({ request: recorder({ 'GET /v1/events/7': { runs: [] } }).request, config: {} });
  assert.equal((await empty({ run: { hub: { hubRunId: 7 } } })).blocked, false);
  // 已派发 + 事件 404 → 自动复活
  const gone = createBlockedEvidence({ request: recorder({ 'GET /v1/events/7': Object.assign(new Error('not found'), { status: 404 }) }).request, config: {} });
  assert.equal((await gone({ run: { hub: { hubRunId: 7 } } })).blocked, false);
  // 已派发 + Hub 探测出错（非 404）→ 保守维持阻塞
  const err = createBlockedEvidence({ request: recorder({ 'GET /v1/events/7': new Error('boom') }).request, config: {} });
  assert.equal((await err({ run: { hub: { hubRunId: 7 } } })).blocked, true);
  // 事件读取必须带 source 密钥（否则中台 401）
  const { calls, request } = recorder({ 'GET /v1/events/7': { runs: [{ run: 3, state: 'claimed' }] } });
  await createBlockedEvidence({ request, config: {} })({ run: { hub: { hubRunId: 7 } } });
  assert.equal(calls.find(c => c.p === '/v1/events/7').auth, 'source');
  // 从未派发：保持原口径（Hub 可达即复活；Hub 不可达抛错由控制器记 lastError）
  const ok = createBlockedEvidence({ request: recorder({ 'GET /v1/state': {} }).request, config: {} });
  assert.equal((await ok({ run: {} })).blocked, false);
  const down = createBlockedEvidence({ request: recorder({ 'GET /v1/state': new Error('down') }).request, config: {} });
  await assert.rejects(() => down({ run: {} }));
});

const mkRoot = (store, project = '/proj') => store.createRun({ project, planId: 'p1', planDigest: 'd', confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true, nodeId: ROOT_NODE, role: 'dev', nodes: [mkNode('a')] });

test('startDagControllers：启动恢复未终结 DAG、有界频率、重复 tick 幂等、终结后释放', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dag-rt-'));
  const store = createRunStore({ directory: path.join(dir, 'dag-runs') });
  const root = mkRoot(store);
  const ticks = []; let intervalMs = null;
  const build = async ({ rootRun }) => ({ async tick() { ticks.push(rootRun.runId); } });
  const mgr = startDagControllers({ config: { root: dir }, store, intervalMs: 1, build, setIntervalFn: (fn, ms) => { intervalMs = ms; return { unref() {} }; }, clearIntervalFn() {}, directory: path.join(dir, 'dag-runs') });
  assert.equal(intervalMs, MIN_POLL_MS, '轮询频率有下限');
  await mgr.tickOnce(); await mgr.tickOnce();
  assert.ok(ticks.length >= 2 && ticks.every(id => id === root.runId));
  store.finishRoot(root.runId, 'cancelled');
  const before = ticks.length;
  await mgr.tickOnce();
  assert.equal(ticks.length, before, '终结的 DAG 不再 tick');
  mgr.stop();
});

test('startDagControllers：另一进程持锁时不接管；装配失败只记日志不影响其它', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dag-rt-'));
  const directory = path.join(dir, 'dag-runs');
  const store = createRunStore({ directory });
  mkRoot(store, '/p1');
  const logs = [];
  const mgr = startDagControllers({ config: { root: dir }, store, directory, build: async () => { throw new Error('boom'); }, log: m => logs.push(m), setIntervalFn: () => ({ unref() {} }), clearIntervalFn() {} });
  await mgr.tickOnce();
  assert.ok(logs.some(m => /恢复控制器失败.*boom/.test(m)));
  mgr.stop();
});

test('createDagRuntime：真实 publisher 使用控制器 mirror，不受 worker 移动 origin/main 影响', async () => {
  const { project, remote } = makeRepo();
  const stateRoot = mkdtempSync(path.join(tmpdir(), 'dag-runtime-mirror-'));
  const mirror = await ensureMirror({ root: stateRoot, remoteUrl: remote, baseBranch: 'main' });
  const store = createRunStore({ directory: path.join(stateRoot, 'dag-runs') });
  const designBaseline = {
    designDigest: 'a'.repeat(64), manifestPath: 'docs/design/demo/design-manifest.json',
    manifest: { schema: 1, designId: 'demo', artifacts: [{ path: 'docs/design/demo/reference.png', sha256: 'b'.repeat(64) }], surfaces: [{ id: 'overview', route: '/', viewports: ['1440x900'], states: ['normal'], interactions: [], referencePaths: ['docs/design/demo/reference.png'] }] },
    readOnlyPaths: ['docs/design/demo/design-manifest.json', 'docs/design/demo/reference.png'],
  };
  const ui = mkNode('a'); ui.contract.design = { surfaceIds: ['overview'] };
  const root = store.createRun({
    project, remoteUrl: remote, mirrorPath: mirror.mirrorPath, baseBranch: mirror.baseBranch, baseCommit: mirror.baseCommit,
    planId: 'p1', planDigest: 'd', confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true,
    nodeId: ROOT_NODE, role: 'dev', nodes: [ui], designBaseline,
  });
  // worker 在目标项目移动 origin/main，控制器 mirror 不受影响。
  mkdirSync(path.join(project, 'secret'), { recursive: true }); writeFileSync(path.join(project, 'secret/extra.txt'), 'evil\n');
  sh(project, 'add', 'secret/extra.txt'); sh(project, 'commit', '-qm', 'evil base');
  sh(project, 'update-ref', 'refs/remotes/origin/main', sh(project, 'rev-parse', 'HEAD'));
  const gh = { async findPr() { return null; }, async createPr() { return 'https://gh/pr/1'; }, async closePr() {} };
  const request = async (config, p, opts = {}) => {
    if (p === '/v1/events' && opts.method === 'POST') return { event: 42 };
    if (p === '/v1/events/42') {
      const current = store.listRuns().find(item => item.nodeId === 'a');
      const receipt = { advanceId: current.expectedAdvanceId, runId: current.runId, nodeId: 'a', role: 'dev', generation: 1, attempt: 1, outcome: 'done' };
      return { event: 42, runs: [{ run: 7, state: 'done', events: [{ type: 'dag.a.advance', detail: JSON.stringify(receipt) }] }] };
    }
    return {};
  };
  let called = 0; let received;
  const verifyDesign = async input => {
    called++; received = input;
    return { ok: true, evidence: { commit: input.commit, designDigest: designBaseline.designDigest, contractDigest: designContractDigest({ designDigest: designBaseline.designDigest, contract: ui.contract.design }), checks: [{ ok: true }] } };
  };
  const ctl = await createDagRuntime({ rootRun: root, config: {}, store, request, gh, runTests: async () => ({ exitCode: 0 }), verifyDesign, readToken: async () => 'test-gh-token' });
  await ctl.tick();
  const slotDir = path.join(mirror.mirrorPath, '.worktrees', `dag-${root.runId}-slot-1`);
  mkdirSync(path.join(slotDir, 'src'), { recursive: true }); writeFileSync(path.join(slotDir, 'src', 'a.mjs'), 'export const a = 1;\n');
  await ctl.tick();
  assert.equal(called, 1);
  assert.equal(received.project, mirror.mirrorPath);
  assert.match(received.evidenceDir, /design-evidence/);
  assert.equal(ctl.snapshot().nodes.a.state, 'review');
  assert.equal(sh(mirror.mirrorPath, 'rev-parse', 'refs/heads/main'), mirror.baseCommit);
});

test('defaultRunTests uses a sanitized environment without controller-only variables', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dag-run-tests-env-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    private: true, type: 'module',
    scripts: { test: 'node -e "if (process.env.AGENT_AUTOLOOP_HOME !== undefined) process.exit(1)"' },
  }));
  const previous = process.env.AGENT_AUTOLOOP_HOME;
  process.env.AGENT_AUTOLOOP_HOME = 'controller-secret';
  try {
    const result = await defaultRunTests(root);
    assert.equal(result.exitCode, 0);
  } finally {
    if (previous === undefined) delete process.env.AGENT_AUTOLOOP_HOME; else process.env.AGENT_AUTOLOOP_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
