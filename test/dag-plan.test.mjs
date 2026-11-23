import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadDesignManifest } from '../src/design-baseline.mjs';
import { createDagService } from '../src/dag-service.mjs';
import { createRunStore, ALLOWED_ACTIONS, ROOT_NODE } from '../src/dag-run.mjs';
import { loadNativePlan } from '../src/dag-plan.mjs';
import { createPlanDigest } from '../src/vibe-plan.mjs';
import { parallelShape } from '../src/dag.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP_PLAN_ID = 'console-hub-native-and-card-routing';
const bootstrapFile = path.join(repoRoot, 'docs', 'dag-plans', `${BOOTSTRAP_PLAN_ID}.json`);

const contract = file => ({ input: 'i', output: 'o', error_behavior: 'e', acceptance_example: 'a', files: [file] });
const simpleNodes = [
  { id: 'alpha', contract: contract('src/alpha.mjs') },
  { id: 'beta', depends_on: ['alpha'], contract: contract('src/beta.mjs') },
];

function nativeProject(planId, data) {
  const root = mkdtempSync(path.join(tmpdir(), 'dag-native-'));
  const dir = path.join(root, 'docs', 'dag-plans');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${planId}.json`), typeof data === 'string' ? data : JSON.stringify(data));
  return root;
}

test('loads a native plan with no .vibe and returns native metadata and empty productSpec', () => {
  const root = nativeProject('native-demo', simpleNodes);
  const loaded = loadNativePlan({ projectRoot: root, planId: 'native-demo' });
  assert.equal(loaded.planId, 'native-demo');
  assert.deepEqual(loaded.plan, { plan_id: 'native-demo', title: 'native-demo', source: 'native' });
  assert.deepEqual(loaded.productSpec, {});
  assert.deepEqual(loaded.nodes, simpleNodes);
  assert.ok(!readFileSync(path.join(root, 'docs', 'dag-plans', 'native-demo.json'), 'utf8').includes('vibe'));
});

test('native plan digest is deterministic with productSpec {} and native plan metadata', () => {
  const root = nativeProject('native-demo', simpleNodes);
  const loaded = loadNativePlan({ projectRoot: root, planId: 'native-demo' });
  const expected = createPlanDigest({
    productSpec: {},
    plan: { plan_id: 'native-demo', title: 'native-demo', source: 'native' },
    nodes: simpleNodes,
    authorizationSnapshot: null,
  });
  assert.equal(expected, '6e9c92fd39ca1b09ab9172cb564ac48f9c7ae52846ff56519ce1f5df339f3d5d');
  assert.equal(createPlanDigest({ ...loaded, authorizationSnapshot: null }), expected);
  assert.equal(createPlanDigest({ ...loaded, authorizationSnapshot: null }), expected);
});

test('rejects malformed native JSON with a readable error', () => {
  const root = nativeProject('native-demo', '{not json');
  assert.throws(() => loadNativePlan({ projectRoot: root, planId: 'native-demo' }), /合法 JSON/);
});

test('rejects unknown planId with a readable error', () => {
  const root = nativeProject('native-demo', simpleNodes);
  assert.throws(() => loadNativePlan({ projectRoot: root, planId: 'missing-plan' }), /未找到原生计划/);
});

test('rejects a native plan that fails validateDag (overlapping write scopes without dependency)', () => {
  const nodes = [
    { id: 'one', contract: contract('src/shared.mjs') },
    { id: 'two', contract: contract('src/shared.mjs') },
  ];
  const root = nativeProject('native-demo', nodes);
  assert.throws(() => loadNativePlan({ projectRoot: root, planId: 'native-demo' }), /DAG 校验失败/);
});

test('rejects path traversal planId and empty inputs', () => {
  assert.throws(() => loadNativePlan({ projectRoot: '.', planId: '../native-demo' }), /planId/);
  assert.throws(() => loadNativePlan({ projectRoot: '', planId: 'native-demo' }), /projectRoot/);
});

test('loads the committed bootstrap plan with six nodes and parallel waves', () => {
  const loaded = loadNativePlan({ projectRoot: repoRoot, planId: BOOTSTRAP_PLAN_ID });
  assert.equal(loaded.nodes.length, 6);
  const shape = parallelShape(loaded.nodes);
  assert.deepEqual(shape.parallelWaves, [
    ['execution-grants', 'hub-scheduling', 'card-delegation'],
    ['dag-recovery', 'card-routing-filter'],
  ]);
});

// ---- #67 execution-grants：原生计划声明可选高风险动作 ----

test('native plan object form carries declared optional high-risk actions and keeps digest stable for array form', () => {
  const root = nativeProject('native-demo', { plan_id: 'native-demo', title: '带授权', nodes: simpleNodes, optionalHighRiskActions: ['deploy', 'release'] });
  const loaded = loadNativePlan({ projectRoot: root, planId: 'native-demo' });
  assert.deepEqual(loaded.optionalHighRiskActions, ['deploy', 'release']);
  assert.equal(loaded.plan.title, '带授权');
  // array form has no declared optional actions → default []
  const root2 = nativeProject('native-demo', simpleNodes);
  const loaded2 = loadNativePlan({ projectRoot: root2, planId: 'native-demo' });
  assert.deepEqual(loaded2.optionalHighRiskActions, []);
  assert.equal(createPlanDigest({ ...loaded2, authorizationSnapshot: null }), createPlanDigest({
    productSpec: {}, plan: { plan_id: 'native-demo', title: 'native-demo', source: 'native' }, nodes: simpleNodes, authorizationSnapshot: null,
  }), 'array 形态 digest 口径不变');
});

// ---- 可选设计基线：只有 UI 合同触发加载，旧计划不受影响 ----

test('native UI plan binds the approved design baseline into planDigest', async () => {
  const root = nativeProject('native-ui', []);
  mkdirSync(path.join(root, 'docs', 'design', 'demo'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'design', 'demo', 'reference.png'), 'reference');
  const manifest = {
    schema: 1, designId: 'demo',
    artifacts: [{ path: 'docs/design/demo/reference.png', sha256: createHash('sha256').update('reference').digest('hex') }],
    surfaces: [{ id: 'overview', route: '/', viewports: ['1440x900'], states: ['normal'], interactions: [], referencePaths: ['docs/design/demo/reference.png'] }],
  };
  writeFileSync(path.join(root, 'docs', 'design', 'demo', 'design-manifest.json'), JSON.stringify(manifest));
  const nodes = [{ id: 'ui', contract: { ...contract('src/ui.mjs'), design: { surfaceIds: ['overview'] } } }];
  const data = { plan_id: 'native-ui', title: 'UI', nodes, design: { manifestPath: 'docs/design/demo/design-manifest.json', approvalPath: 'docs/prd/native-ui/design-approval.json' } };
  writeFileSync(path.join(root, 'docs', 'dag-plans', 'native-ui.json'), JSON.stringify(data));
  const manifestLoad = loadDesignManifest({ projectRoot: root, manifestPath: data.design.manifestPath });
  mkdirSync(path.join(root, 'docs', 'prd', 'native-ui'), { recursive: true });
  writeFileSync(path.join(root, data.design.approvalPath), JSON.stringify({ schema: 1, designDigest: manifestLoad.designDigest, confirmedAt: '2026-11-17T12:00:00.000Z' }));
  const loaded = loadNativePlan({ projectRoot: root, planId: 'native-ui' });
  assert.equal(loaded.designBaseline.designDigest, manifestLoad.designDigest);
  const planDigest = createPlanDigest({ ...loaded, authorizationSnapshot: null });
  assert.notEqual(planDigest, createPlanDigest({ productSpec: {}, plan: loaded.plan, nodes, authorizationSnapshot: null }));
  const store = createRunStore({ directory: mkdtempSync(path.join(tmpdir(), 'dag-design-service-')) });
  const service = createDagService({ store });
  const created = await service.create({ planId: 'native-ui', planDigest, confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true }, root);
  assert.equal(created.nodeId, ROOT_NODE);
  assert.equal(created.designBaseline.designDigest, loaded.designBaseline.designDigest);
  assert.ok(created.designBaseline.snapshotDirectory);
  for (const relative of loaded.designBaseline.readOnlyPaths) {
    assert.ok(created.designBaseline.snapshotFiles[relative]);
    assert.equal(readFileSync(path.join(created.designBaseline.snapshotDirectory, relative), 'utf8'), readFileSync(path.join(root, relative), 'utf8'));
  }
});

test('native plans without UI contracts do not load design facilities', () => {
  const root = nativeProject('native-backend', {
    plan_id: 'native-backend', nodes: simpleNodes,
    design: { manifestPath: 'docs/missing/design-manifest.json', approvalPath: 'docs/missing/approval.json' },
  });
  const loaded = loadNativePlan({ projectRoot: root, planId: 'native-backend' });
  assert.equal(loaded.designBaseline, null);
});

test('native UI contracts require a declared valid design baseline', () => {
  const nodes = [{ id: 'ui', contract: { ...contract('src/ui.mjs'), design: { surfaceIds: ['overview'] } } }];
  const root = nativeProject('native-ui', { plan_id: 'native-ui', nodes });
  assert.throws(() => loadNativePlan({ projectRoot: root, planId: 'native-ui' }), /design|设计/);
});

test('committed bootstrap binds only its UI-writing nodes to the approved scoped surfaces', () => {
  const loaded = loadNativePlan({ projectRoot: repoRoot, planId: BOOTSTRAP_PLAN_ID });
  assert.ok(loaded.designBaseline?.designDigest);
  const byId = Object.fromEntries(loaded.nodes.map(node => [node.id, node]));
  assert.deepEqual(byId['execution-grants'].contract.design.surfaceIds, ['authorize']);
  assert.deepEqual(byId['card-delegation'].contract.design.surfaceIds, ['overview']);
  for (const id of ['hub-scheduling', 'dag-recovery', 'card-routing-filter', 'integration-review']) {
    assert.equal(byId[id].contract.design, undefined, `${id} 不得被设计设施阻塞`);
  }
});
