import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const nodes = JSON.parse(readFileSync(bootstrapFile, 'utf8'));
  const root = nativeProject(BOOTSTRAP_PLAN_ID, nodes);
  const loaded = loadNativePlan({ projectRoot: root, planId: BOOTSTRAP_PLAN_ID });
  assert.equal(loaded.nodes.length, 6);
  const shape = parallelShape(loaded.nodes);
  assert.deepEqual(shape.parallelWaves, [
    ['execution-grants', 'hub-scheduling', 'card-delegation'],
    ['dag-recovery', 'card-routing-filter'],
  ]);
});
