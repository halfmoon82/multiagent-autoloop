// #54 生产装配：Hub 适配（经 /v1/events，不起 ACP）、启动恢复、有界轮询、blocked 证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALLOWED_ACTIONS, ROOT_NODE, createRunStore } from '../src/dag-run.mjs';
import { createBlockedEvidence, createHubAdapter, createDagRuntime, dagEventType, defaultRunTests, startDagControllers, MIN_POLL_MS } from '../src/dag-runtime.mjs';
import { designContractDigest } from '../src/design-baseline.mjs';
import { makeRepo } from './helpers-git.mjs';
import { mkNode } from './dag-fakes.mjs';

const recorder = (responses = {}) => {
  const calls = [];
  const request = async (config, p, opts = {}) => {
    calls.push({ p, method: opts.method || 'GET', body: opts.body });
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
  await assert.rejects(() => hub.dispatch({ run, slot: 1, worktree: '/w', branch: 'b', prompt: 'x'.repeat(4001) }), /4000/);
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

test('hub.cancel 只取消未终态 run', async () => {
  const { calls, request } = recorder({ 'GET /v1/events/1': { event: 1, runs: [{ run: 3, state: 'done', events: [] }, { run: 4, state: 'queued', events: [] }, { run: 5, state: 'unknown', events: [] }] } });
  await createHubAdapter({ config: {}, request }).cancel(1);
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => c.p), ['/v1/runs/4/cancel']);
});

test('blocked 证据：已派发的保持阻塞；从未派发且 Hub 可达才自动复活；Hub 不可达抛错', async () => {
  const ok = createBlockedEvidence({ request: recorder().request, config: {} });
  assert.equal((await ok({ run: { hub: { hubRunId: 7 } } })).blocked, true);
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

test('createDagRuntime：真实 publisher 装配接收 verifyDesign 与服务端证据目录', async () => {
  const { project } = makeRepo();
  const store = createRunStore({ directory: mkdtempSync(path.join(tmpdir(), 'dag-runtime-design-')) });
  const designBaseline = {
    designDigest: 'a'.repeat(64), manifestPath: 'docs/design/demo/design-manifest.json',
    manifest: { schema: 1, designId: 'demo', artifacts: [{ path: 'docs/design/demo/reference.png', sha256: 'b'.repeat(64) }], surfaces: [{ id: 'overview', route: '/', viewports: ['1440x900'], states: ['normal'], interactions: [], referencePaths: ['docs/design/demo/reference.png'] }] },
    readOnlyPaths: ['docs/design/demo/design-manifest.json', 'docs/design/demo/reference.png'],
  };
  const ui = mkNode('a'); ui.contract.design = { surfaceIds: ['overview'] };
  const root = store.createRun({ project, planId: 'p1', planDigest: 'd', confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true, nodeId: ROOT_NODE, role: 'dev', nodes: [ui], designBaseline });
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
  const ctl = await createDagRuntime({ rootRun: root, config: {}, store, request, gh, runTests: async () => ({ exitCode: 0 }), verifyDesign });
  await ctl.tick();
  const slot = path.join(project, '.worktrees', `dag-${root.runId}-slot-1`);
  mkdirSync(path.join(slot, 'src'), { recursive: true }); writeFileSync(path.join(slot, 'src', 'a.mjs'), 'export const a = 1;\n');
  await ctl.tick();
  assert.equal(called, 1);
  assert.equal(received.nodeId, 'a');
  assert.match(received.evidenceDir, /design-evidence/);
  assert.equal(ctl.snapshot().nodes.a.state, 'review');
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
