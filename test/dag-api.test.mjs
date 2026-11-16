import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { createDagService } from '../src/dag-service.mjs';
import { createRunStore, ALLOWED_ACTIONS, ROOT_NODE } from '../src/dag-run.mjs';
import { createPlanDigest } from '../src/vibe-plan.mjs';
import { listen, close } from './helpers.mjs';

const headers = { 'content-type': 'application/json', 'x-console-request': '1' };
const nodes = [{ id: 'a', depends_on: [], contract: { input: 'i', output: 'o', error_behavior: 'e', acceptance_example: 'a', files: ['src/a.mjs'] } }];

function setup(evidence = async () => ({})) {
  const root = mkdtempSync(path.join(tmpdir(), 'dag-api-'));
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'dag-api-proj-'));
  const project = path.join(projectRoot, 'demo'); mkdirSync(path.join(project, '.git'), { recursive: true });
  const dir = path.join(project, '.vibe', 'plans', 'plan-one'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ plan_id: 'plan-one', decisions: [] }));
  writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify(nodes));
  writeFileSync(path.join(dir, 'product-spec.input.json'), JSON.stringify({ decisions: [] }));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ rules: [] }));
  const planDigest = createPlanDigest({ productSpec: { decisions: [] }, plan: { plan_id: 'plan-one', decisions: [] }, nodes });
  const store = createRunStore({ directory: path.join(root, 'dag-runs') });
  const dagService = createDagService({ root, store, hubEvidence: evidence });
  const sessions = { async start() { return { id: 's' }; }, dispose() {} };
  const server = createConsoleServer({ hubUrl: 'http://127.0.0.1:1', ownerKey: 'k', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json'), projectRoots: [projectRoot], dagService }, sessions);
  const payload = over => JSON.stringify({ project, planId: 'plan-one', planDigest, confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true, ...over });
  return { server, project, store, root, payload, planDigest };
}
const post = (url, p, body, h = headers) => fetch(`${url}${p}`, { method: 'POST', headers: h, body });

test('POST /api/dag-runs 创建根 run、服务端生成快照；GET 列表/详情；同项目 409', async () => {
  const t = setup(); const url = await listen(t.server);
  try {
    const res = await post(url, '/api/dag-runs', t.payload());
    assert.equal(res.status, 201);
    const run = await res.json();
    assert.equal(run.nodeId, ROOT_NODE); assert.match(run.authorizationSnapshot.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(run.authorizationSnapshot.allowedActions, [...ALLOWED_ACTIONS].sort());
    assert.equal((await post(url, '/api/dag-runs', t.payload())).status, 409);
    const list = await (await fetch(`${url}/api/dag-runs`)).json();
    assert.equal(list.runs.length, 1);
    const detail = await (await fetch(`${url}/api/dag-runs/${run.runId}`)).json();
    assert.equal(detail.run.runId, run.runId); assert.deepEqual(detail.nodeRuns, []);
    assert.equal((await fetch(`${url}/api/dag-runs/nope`)).status, 404);
  } finally { await close(t.server); }
});

test('创建校验：缺 confirm、deploy/release 动作、planDigest 不符、未发现项目、写守卫', async () => {
  const t = setup(); const url = await listen(t.server);
  try {
    assert.equal((await post(url, '/api/dag-runs', t.payload({ confirm: false }))).status, 400);
    for (const bad of ['deploy', 'release', 'credentials', 'external-communication', 'unknown-x']) {
      assert.equal((await post(url, '/api/dag-runs', t.payload({ confirmedActionIds: ['worktree', bad] }))).status, 400, bad);
    }
    assert.equal((await post(url, '/api/dag-runs', t.payload({ planDigest: 'wrong' }))).status, 400);
    assert.equal((await post(url, '/api/dag-runs', t.payload({ project: '/etc' }))).status, 400);
    assert.equal((await post(url, '/api/dag-runs', t.payload(), { 'content-type': 'application/json' })).status, 403);
    assert.equal((await post(url, '/api/dag-runs', t.payload(), { ...headers, origin: 'http://evil.example' })).status, 403);
    assert.equal((await fetch(`${url}/api/dag-runs`)).status, 200);
    assert.equal(t.store.listRuns().length, 0, '任何拒绝都不落盘 run');
  } finally { await close(t.server); }
});

test('POST cancel 写取消请求，控制器据此推进；取消不存在的 run 404', async () => {
  const t = setup(); const url = await listen(t.server);
  try {
    const run = await (await post(url, '/api/dag-runs', t.payload())).json();
    const res = await post(url, `/api/dag-runs/${run.runId}/cancel`, '{}');
    assert.equal(res.status, 200);
    assert.equal(t.store.getRun(run.runId).publish.cancelRequested, true);
    assert.equal((await post(url, '/api/dag-runs/nope/cancel', '{}')).status, 404);
  } finally { await close(t.server); }
});

// 在根 run 下造一个占用槽位的节点 run。
const seed = async (t, url, patch) => {
  const root = await (await post(url, '/api/dag-runs', t.payload())).json();
  let node = t.store.createNodeRun(root.runId, { nodeId: 'a', role: 'dev' });
  node = t.store.claim(node.runId, { slot: 2 });
  if (patch === 'unknown') node = t.store.markUnknown(node.runId, { at: Date.now() - 25 * 3600 * 1000 });
  if (patch === 'unknown-recent') node = t.store.markUnknown(node.runId, { at: Date.now() - 3600 * 1000 });
  return { root, node };
};

test('slot-release：slot 仅 1-5；queued/在线 claimed 拒绝；证据缺失 fail closed', async () => {
  const t = setup(async () => ({ workerOnline: true })); const url = await listen(t.server);
  try {
    const { root, node } = await seed(t, url);
    const rel = (slot, body) => post(url, `/api/dag-runs/${root.runId}/slots/${slot}/slot-release`, JSON.stringify(body));
    for (const bad of [0, 6, 'x', '1.5']) assert.equal((await rel(bad, { processGroupVerified: true })).status, 400, `slot ${bad}`);
    assert.equal((await rel(3, { processGroupVerified: true })).status, 404, '槽位无活跃 run');
    assert.equal((await rel(2, { processGroupVerified: true })).status, 409, '在线 claimed 拒绝');
    assert.equal(t.store.getRun(node.runId).status, 'claimed');
  } finally { await close(t.server); }
});

test('slot-release：claimed 但离线证据缺失/不足 24h/无进程组依据均拒绝，齐备才放行并写审计', async () => {
  let ev = { workerOnline: false };
  const t = setup(async () => ev); const url = await listen(t.server);
  try {
    const { root, node } = await seed(t, url);
    const rel = body => post(url, `/api/dag-runs/${root.runId}/slots/2/slot-release`, JSON.stringify(body));
    assert.equal((await rel({ processGroupVerified: true })).status, 409, 'offlineSince 缺失 fail closed');
    ev = { workerOnline: false, offlineSince: Date.now() - 3600 * 1000 };
    assert.equal((await rel({ processGroupVerified: true })).status, 409, '未满 24h');
    ev = { workerOnline: false, offlineSince: Date.now() - 25 * 3600 * 1000 };
    assert.equal((await rel({})).status, 409, '无进程组依据');
    assert.equal(t.store.getRun(node.runId).status, 'claimed');
    const ok = await rel({ processGroupVerified: true, note: '已在 worker 机器核实进程组退出' });
    assert.equal(ok.status, 200);
    assert.equal(t.store.getRun(node.runId).status, 'abandoned');
    assert.equal(t.store.slotUsage(t.project), 0, '名额恢复');
    const audit = readdirSync(path.join(t.root, 'dag-commands'));
    assert.equal(audit.length, 1);
    assert.match(readFileSync(path.join(t.root, 'dag-commands', audit[0]), 'utf8'), /process|processGroupVerified/);
    const late = t.store.advance(node.runId, { advanceId: node.expectedAdvanceId, runId: node.runId, nodeId: 'a', role: 'dev', generation: 1, attempt: 1, outcome: 'done' });
    assert.notEqual(late.verdict, 'apply', 'abandoned 后晚到回执作废');
  } finally { await close(t.server); }
});

test('slot-release：unknown 超 24h + 进程组依据放行；未满 24h 拒绝', async () => {
  const t = setup(); const url = await listen(t.server);
  try {
    const { root } = await seed(t, url, "unknown-recent");
    const rel = body => post(url, `/api/dag-runs/${root.runId}/slots/2/slot-release`, JSON.stringify(body));
    assert.equal((await rel({ processGroupVerified: true })).status, 409);
    const fresh = await seedOld(t, root);
    assert.equal((await rel({ processGroupVerified: true })).status, 200);
    assert.equal(t.store.getRun(fresh.runId).status, 'abandoned');
  } finally { await close(t.server); }
});
async function seedOld(t, root) {
  const recent = t.store.listRuns().find(r => r.nodeId === 'a');
  // 用 unknownSince 早于 24h 的新 run 取代：直接改写落盘 JSON 不可行（digest 校验在快照上，不含 unknownSince）。
  const file = path.join(t.store.directory, `${recent.runId}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8')); raw.unknownSince = Date.now() - 25 * 3600 * 1000;
  writeFileSync(file, JSON.stringify(raw)); return recent;
}
