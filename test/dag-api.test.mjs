import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleServer } from '../src/server.mjs';
import { createDagService, withHubUsage } from '../src/dag-service.mjs';
import { createRunStore, ALLOWED_ACTIONS, ROOT_NODE } from '../src/dag-run.mjs';
import { createPlanDigest } from '../src/vibe-plan.mjs';
import { loadNativePlan } from '../src/dag-plan.mjs';
import { fileURLToPath } from 'node:url';
import { listen, close } from './helpers.mjs';

const headers = { 'content-type': 'application/json', 'x-console-request': '1' };
const nodes = [{ id: 'a', depends_on: [], contract: { input: 'i', output: 'o', error_behavior: 'e', acceptance_example: 'a', files: ['src/a.mjs'] } }];

function setup(evidence = async () => ({}), extra = {}) {
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
  const dagService = createDagService({ root, store, hubEvidence: evidence, ...extra });
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
    assert.ok(!existsSync(path.join(t.root, 'dag-commands')), '被拒绝的释放不落审计文件');
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

test('GET /api/dag-plan 只读预览：服务端 planDigest、节点文件范围、允许/排除动作与预检', async () => {
  const t = setup(); const url = await listen(t.server);
  try {
    const res = await fetch(`${url}/api/dag-plan?project=${encodeURIComponent(t.project)}&planId=plan-one`);
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.equal(plan.planDigest, t.planDigest);
    assert.equal(plan.maxParallel, 5);
    assert.deepEqual(plan.nodes.map(n => [n.id, n.files, n.wave]), [['a', ['src/a.mjs'], 1]]);
    assert.deepEqual(plan.allowedActions, [...ALLOWED_ACTIONS]);    assert.deepEqual(plan.deniedActions, ['deploy', 'release', 'production-write', 'credentials', 'external-communication']);
    assert.equal(plan.project, t.project);
    assert.equal((await fetch(`${url}/api/dag-plan?project=${encodeURIComponent(t.project)}&planId=nope-plan`)).status, 400);
    assert.equal((await fetch(`${url}/api/dag-plan?project=%2Fetc&planId=plan-one`)).status, 400);
  } finally { await close(t.server); }
});

test('GET /api/dag-preflight 如实返回初始化与能力记录检查，不代写', async () => {
  const t = setup(); const url = await listen(t.server);
  try {
    const res = await fetch(`${url}/api/dag-preflight?project=${encodeURIComponent(t.project)}`);
    assert.equal(res.status, 200);
    const { checks } = await res.json();
    const byId = Object.fromEntries(checks.map(c => [c.id, c]));
    assert.equal(byId.initialized.ok, false);
    assert.equal(byId.capabilities.ok, false);
    assert.match(byId.capabilities.message, /vibe attest/);
  } finally { await close(t.server); }
});

// ---------- #54 revive 入口 ----------
async function seedBlocked(t, url) {
  const root = await (await post(url, '/api/dag-runs', t.payload())).json();
  let node = t.store.createNodeRun(root.runId, { nodeId: 'a', role: 'dev' });
  node = t.store.claim(node.runId, { slot: 2 });
  t.store.advance(node.runId, { advanceId: node.expectedAdvanceId, runId: node.runId, nodeId: 'a', role: 'dev', generation: 1, attempt: 1, outcome: 'weird-outcome' });
  assert.equal(t.store.getRun(node.runId).status, 'blocked_unknown');
  t.store.updateRun(root.runId, { publish: { nodes: { a: { state: 'blocked', blockedRole: 'dev', slot: null, todo: null } } } });
  return { root, node };
}

test('POST revive：blocked 节点按 blocked-resolved 留痕并写审计命令', async () => {
  const t = setup(); const url = await listen(t.server);
  try {
    const { root } = await seedBlocked(t, url);
    const res = await post(url, `/api/dag-runs/${root.runId}/revive`, JSON.stringify({ nodeId: 'a', reason: 'blocked-resolved', evidence: 'Hub 阻塞卡片已消除' }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { nodeId: 'a', reason: 'blocked-resolved' });
    const todo = t.store.getRun(root.runId).publish.nodes.a.todo;
    assert.equal(todo.reason, 'blocked-resolved');
    assert.equal(todo.evidence, 'Hub 阻塞卡片已消除');
    const files = readdirSync(path.join(t.root, 'dag-commands'));
    assert.equal(files.length, 1);
    const audit = readFileSync(path.join(t.root, 'dag-commands', files[0]), 'utf8');
    assert.match(audit, /blocked-resolved/);
    assert.match(audit, /Hub 阻塞卡片已消除/);
  } finally { await close(t.server); }
});

test('POST revive：非法 reason / 非 blocked 节点 / 写守卫均拒绝且不写审计', async () => {
  const t = setup(); const url = await listen(t.server);
  try {
    const { root } = await seedBlocked(t, url);
    const bad = await post(url, `/api/dag-runs/${root.runId}/revive`, JSON.stringify({ nodeId: 'a', reason: 'whatever' }));
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /reason/);
    const none = await post(url, `/api/dag-runs/${root.runId}/revive`, JSON.stringify({ nodeId: 'b', reason: 'blocked-resolved' }));
    assert.equal(none.status, 400);
    const guard = await post(url, `/api/dag-runs/${root.runId}/revive`, JSON.stringify({ nodeId: 'a', reason: 'blocked-resolved' }), { 'content-type': 'application/json' });
    assert.equal(guard.status, 403);
    assert.ok(!existsSync(path.join(t.root, 'dag-commands')), '拒绝不写审计');
  } finally { await close(t.server); }
});

test('审计写失败（磁盘满）：已释放仍返回成功，但留日志标出无审计', async () => {
  const logs = [];
  const t = setup(undefined, { log: m => logs.push(m), writeAudit: () => { throw new Error('磁盘满'); } });
  const url = await listen(t.server);
  try {
    const { root, node } = await seed(t, url, 'unknown');
    const res = await post(url, `/api/dag-runs/${root.runId}/slots/2/slot-release`, JSON.stringify({ processGroupVerified: true }));
    assert.equal(res.status, 200, '槽位已释放，审计失败不回 5xx');
    assert.equal(t.store.getRun(node.runId).status, 'abandoned');
    assert.ok(logs.some(l => /审计写入失败/.test(l) && /磁盘满/.test(l)), '写失败必须留日志');
  } finally { await close(t.server); }
});

test('revive 审计写失败：复活待办已落盘，仍返回成功但留日志', async () => {
  const logs = [];
  const t = setup(undefined, { log: m => logs.push(m), writeAudit: () => { throw new Error('磁盘满'); } });
  const url = await listen(t.server);
  try {
    const { root } = await seedBlocked(t, url);
    const res = await post(url, `/api/dag-runs/${root.runId}/revive`, JSON.stringify({ nodeId: 'a', reason: 'blocked-resolved', evidence: 'x' }));
    assert.equal(res.status, 200);
    assert.equal(t.store.getRun(root.runId).publish.nodes.a.todo.reason, 'blocked-resolved');
    assert.ok(logs.some(l => /审计写入失败/.test(l) && /磁盘满/.test(l)));
  } finally { await close(t.server); }
});

// ---- 原生 DAG 计划入口（无需 .vibe）----
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP_PLAN_ID = 'console-hub-native-and-card-routing';
const bootstrapPlan = () => JSON.parse(readFileSync(path.join(repoRoot, 'docs', 'dag-plans', `${BOOTSTRAP_PLAN_ID}.json`), 'utf8'));

function setupNative() {
  const root = mkdtempSync(path.join(tmpdir(), 'dag-native-api-'));
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'dag-native-api-proj-'));
  const project = path.join(projectRoot, 'native-demo');
  mkdirSync(path.join(project, '.git'), { recursive: true });
  const plans = path.join(project, 'docs', 'dag-plans'); mkdirSync(plans, { recursive: true });
  writeFileSync(path.join(plans, `${BOOTSTRAP_PLAN_ID}.json`), JSON.stringify(bootstrapPlan()));
  cpSync(path.join(repoRoot, 'docs', 'design', '2026-11-16-parallel-dag'), path.join(project, 'docs', 'design', '2026-11-16-parallel-dag'), { recursive: true });
  cpSync(path.join(repoRoot, 'docs', 'prd', BOOTSTRAP_PLAN_ID), path.join(project, 'docs', 'prd', BOOTSTRAP_PLAN_ID), { recursive: true });
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ rules: [] }));
  const loaded = loadNativePlan({ projectRoot: project, planId: BOOTSTRAP_PLAN_ID });
  const planDigest = createPlanDigest({ ...loaded, authorizationSnapshot: null });
  const store = createRunStore({ directory: path.join(root, 'dag-runs') });
  const dagService = createDagService({ root, store });
  const sessions = { async start() { return { id: 's' }; }, dispose() {} };
  const server = createConsoleServer({ hubUrl: 'http://127.0.0.1:1', ownerKey: 'k', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json'), projectRoots: [projectRoot], dagService }, sessions);
  const payload = over => JSON.stringify({ project, planId: BOOTSTRAP_PLAN_ID, planDigest, confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true, ...over });
  return { server, project, store, planDigest, payload };
}

test('GET /api/dag-plan 原生计划无需 .vibe：返回六节点、波次与一致 digest', async () => {
  const t = setupNative(); const url = await listen(t.server);
  try {
    assert.ok(!existsSync(path.join(t.project, '.vibe')), '夹具无 .vibe 目录');
    const res = await fetch(`${url}/api/dag-plan?project=${encodeURIComponent(t.project)}&planId=${BOOTSTRAP_PLAN_ID}`);
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.equal(plan.planDigest, t.planDigest);
    assert.equal(plan.nodes.length, 6);
    assert.deepEqual(plan.nodes.map(n => [n.id, n.wave]), [
      ['execution-grants', 1], ['hub-scheduling', 1], ['card-delegation', 1],
      ['dag-recovery', 2], ['card-routing-filter', 2], ['integration-review', 3],
    ]);
    assert.deepEqual(plan.allowedActions, [...ALLOWED_ACTIONS]);
  } finally { await close(t.server); }
});

test('POST /api/dag-runs 原生 planId+planDigest 创建成功，digest 不符拒绝', async () => {
  const t = setupNative(); const url = await listen(t.server);
  try {
    const res = await post(url, '/api/dag-runs', t.payload());
    assert.equal(res.status, 201);
    const run = await res.json();
    assert.equal(run.planId, BOOTSTRAP_PLAN_ID);
    assert.equal(run.planDigest, t.planDigest);
    assert.equal((await post(url, '/api/dag-runs', t.payload({ planDigest: 'wrong' }))).status, 400);
    assert.equal(t.store.listRuns().filter(r => r.nodeId === ROOT_NODE).length, 1);
  } finally { await close(t.server); }
});

test('GET /api/dag-plan 无原生计划也无 vibe 计划时返回可读 400', async () => {
  const t = setup(); const url = await listen(t.server);
  try {
    const res = await fetch(`${url}/api/dag-plan?project=${encodeURIComponent(t.project)}&planId=no-such-plan`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /无法加载计划/);
    assert.match(body.error, /原生/);
    assert.match(body.error, /vibe/);
  } finally { await close(t.server); }
});

// ---- #67 execution-grants：高风险动作需计划声明且明确选择 ----

test('GET /api/dag-plan 返回可选高风险动作（含收益/代价）；deploy 默认关闭', async () => {
  const t = setupWithOptions({ optionalHighRiskActions: ['deploy'] }); const url = await listen(t.server);
  try {
    const res = await fetch(`${url}/api/dag-plan?project=${encodeURIComponent(t.project)}&planId=plan-one`);
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.ok(Array.isArray(plan.optionalActions));
    const deploy = plan.optionalActions.find(a => a.id === 'deploy');
    assert.ok(deploy, '计划须声明可用的可选高风险动作');
    assert.match(deploy.benefit, /\S/); assert.match(deploy.cost, /\S/);
    assert.equal(deploy.selectedByDefault, false, '高风险动作默认关闭');
  } finally { await close(t.server); }
});

test('POST /api/dag-runs 只有计划声明且勾选的高风险动作才写入授权记录；未声明/未勾选则拒绝或关闭', async () => {
  const t = setup(); const url = await listen(t.server);
  try {
    // 未勾选 deploy → 授权记录无高风险动作
    const plain = await (await post(url, '/api/dag-runs', t.payload())).json();
    assert.deepEqual(plain.authorizationSnapshot.optionalGrants, []);
    assert.equal(plain.authorizationSnapshot.allowedActions.includes('deploy'), false);
  } finally { await close(t.server); }

  // 勾选未声明的 release：计划未声明 → 400；勾选声明的 deploy → 成功写入
  const t2 = setupWithOptions({ optionalHighRiskActions: ['deploy'] }); const url2 = await listen(t2.server);
  try {
    const denied = await post(url2, '/api/dag-runs', t2.payload({ selectedOptionalActions: ['release'] }));
    assert.equal(denied.status, 400);
    assert.match((await denied.json()).error, /计划/);
    const ok = await (await post(url2, '/api/dag-runs', t2.payload({ selectedOptionalActions: ['deploy'] }))).json();
    assert.deepEqual(ok.authorizationSnapshot.optionalGrants, ['deploy']);
    assert.equal(ok.authorizationSnapshot.allowedActions.includes('deploy'), true);
  } finally { await close(t2.server); }
});

function setupWithOptions(planExtra, evidence = async () => ({})) {
  const root = mkdtempSync(path.join(tmpdir(), 'dag-api-opt-'));
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'dag-api-opt-proj-'));
  const project = path.join(projectRoot, 'demo'); mkdirSync(path.join(project, '.git'), { recursive: true });
  const dir = path.join(project, '.vibe', 'plans', 'plan-one'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ plan_id: 'plan-one', decisions: [], ...planExtra }));
  writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify(nodes));
  writeFileSync(path.join(dir, 'product-spec.input.json'), JSON.stringify({ decisions: [] }));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ rules: [] }));
  const planDigest = createPlanDigest({ productSpec: { decisions: [] }, plan: { plan_id: 'plan-one', decisions: [], ...planExtra }, nodes });
  const store = createRunStore({ directory: path.join(root, 'dag-runs') });
  const dagService = createDagService({ root, store, hubEvidence: evidence });
  const sessions = { async start() { return { id: 's' }; }, dispose() {} };
  const server = createConsoleServer({ hubUrl: 'http://127.0.0.1:1', ownerKey: 'k', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json'), projectRoots: [projectRoot], dagService }, sessions);
  const payload = over => JSON.stringify({ project, planId: 'plan-one', planDigest, confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true, ...over });
  return { server, project, store, root, payload, planDigest };
}

test('GET /api/dag-preflight 对原生计划不要求 vibe 规划环境', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dag-api-native-'));
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'dag-api-native-proj-'));
  const project = path.join(projectRoot, 'demo'); mkdirSync(path.join(project, '.git'), { recursive: true });
  mkdirSync(path.join(project, 'docs', 'dag-plans'), { recursive: true });
  writeFileSync(path.join(project, 'docs', 'dag-plans', 'native-one.json'), JSON.stringify([{ id: 'a', depends_on: [], contract: { input: 'i', output: 'o', error_behavior: 'e', acceptance_example: 'a', files: ['src/a.mjs'] } }]));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({ rules: [] }));
  const store = createRunStore({ directory: path.join(root, 'dag-runs') });
  const dagService = createDagService({ root, store });
  const sessions = { async start() { return { id: 's' }; }, dispose() {} };
  const server = createConsoleServer({ hubUrl: 'http://127.0.0.1:1', ownerKey: 'k', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json'), projectRoots: [projectRoot], dagService }, sessions);
  const url = await listen(server);
  try {
    const res = await fetch(`${url}/api/dag-preflight?project=${encodeURIComponent(project)}&planId=native-one`);
    assert.equal(res.status, 200);
    const { checks } = await res.json();
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, true);
    assert.match(checks[0].message, /原生计划/);
    assert.equal(checks.some(c => c.id === 'capabilities'), false, '原生计划不查 vibe 能力记录');
  } finally { await close(server); }
});

test('预检不通过也照常创建 DAG（预检只报不拦）', async () => {
  const t = setup(); const url = await listen(t.server);
  try {
    const pre = await (await fetch(`${url}/api/dag-preflight?project=${encodeURIComponent(t.project)}`)).json();
    assert.ok(pre.checks.some(check => !check.ok), '夹具本身预检为红');
    const res = await post(url, '/api/dag-runs', t.payload());
    assert.equal(res.status, 201, '预检红不阻止创建');
  } finally { await close(t.server); }
});

test('withHubUsage 按 Hub 轮次号补节点执行 Agent/模型/自报用量；查不到或无执行者保持原样', () => {
  const detail = { run: { runId: 'r' }, nodeRuns: [
    { runId: 'a', nodeId: 'n1', hub: { hubRunId: 11, hubRun: 501 } },
    { runId: 'b', nodeId: 'n2', hub: { hubRunId: 12, hubRun: 999 } },
    { runId: 'c', nodeId: 'n3', hub: { hubRunId: 13 } },
  ] };
  const hubRuns = [{ id: 501, agent: 'claude', usage: { input: 3, output: 4, cost: 0.01 } }, { id: 999, agent: '' }];
  const out = withHubUsage(detail, hubRuns, { claude: 'opus' });
  assert.deepEqual([out.nodeRuns[0].agent, out.nodeRuns[0].model, out.nodeRuns[0].usage], ['claude', 'opus', { input: 3, output: 4, cost: 0.01 }]);
  assert.equal(out.nodeRuns[1], detail.nodeRuns[1]);
  assert.equal(out.nodeRuns[2], detail.nodeRuns[2]);
  assert.equal(withHubUsage(detail, [{ id: 501, agent: 'codex-full', usage: null }], {}).nodeRuns[0].model, '未配置');
});

test('withHubUsage 分两类标注：跑模型无用量 → unreportable，不跑模型 → noModel', () => {
  const detail = { run: { runId: 'r' }, nodeRuns: [
    { runId: 'a', nodeId: 'n1', hub: { hubRunId: 11, hubRun: 501 } }, // workbuddy，acp 通道
    { runId: 'b', nodeId: 'n2', hub: { hubRunId: 12, hubRun: 502 } }, // remote-watch，command 通道
    { runId: 'c', nodeId: 'n3', hub: { hubRunId: 13, hubRun: 503 } }, // workbuddy 但有用量（防御：不标）
    { runId: 'd', nodeId: 'n4', hub: { hubRunId: 14, hubRun: 504 } }, // codex，可上报但暂无数据
  ] };
  const hubRuns = [
    { id: 501, agent: 'workbuddy', usage: null },
    { id: 502, agent: 'remote-watch', usage: null },
    { id: 503, agent: 'workbuddy', usage: { input: 5, output: 1 } },
    { id: 504, agent: 'codex-full', usage: null },
  ];
  const adapters = { workbuddy: 'acp', 'remote-watch': 'command', 'codex-full': 'codex' };
  const out = withHubUsage(detail, hubRuns, {}, adapters);
  assert.equal(out.nodeRuns[0].usageUnreportable, true, 'acp 无用量 → 终态不上报');
  assert.equal(out.nodeRuns[0].usageNoModel, undefined);
  assert.equal(out.nodeRuns[1].usageNoModel, true, 'command 无用量 → 不需要模型');
  assert.equal(out.nodeRuns[1].usageUnreportable, undefined);
  assert.equal(out.nodeRuns[2].usageUnreportable, undefined, '有用量则不标');
  assert.equal(out.nodeRuns[3].usageUnreportable, undefined, 'codex 无用量 → 仍是「未上报」');
  assert.equal(out.nodeRuns[3].usageNoModel, undefined);
  // adapters 缺数据时按未知处理，不误标
  const bare = withHubUsage(detail, hubRuns);
  assert.equal(bare.nodeRuns[0].usageUnreportable, undefined);
  assert.equal(bare.nodeRuns[1].usageNoModel, undefined);
});
