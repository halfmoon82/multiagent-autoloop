import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  writeFileSync(path.join(root, 'docs', 'design', 'demo', 'verifier.mjs'), 'export async function verify() {}');
  writeFileSync(path.join(root, 'docs', 'design', 'demo', 'fallback.mjs'), 'export async function capture() {}');
  const manifest = {
    schema: 1, designId: 'demo', verifierPath: 'docs/design/demo/verifier.mjs', fallbackVerifierPath: 'docs/design/demo/fallback.mjs',
    artifacts: [
      { path: 'docs/design/demo/reference.png', sha256: createHash('sha256').update('reference').digest('hex') },
      { path: 'docs/design/demo/verifier.mjs', sha256: createHash('sha256').update('export async function verify() {}').digest('hex') },
      { path: 'docs/design/demo/fallback.mjs', sha256: createHash('sha256').update('export async function capture() {}').digest('hex') },
    ],
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
  const service = createDagService({
    store, resolveDesignCommit: async () => 'a'.repeat(40),
    smokeApprovedDesign: async () => ({ ok: true, status: 'pass', evidence: { collector: 'approved-sample' } }),
    verifyDesign: async () => ({ ok: true, status: 'pass', evidence: { collector: 'fallback' } }),
  });
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
  assert.throws(() => loadNativePlan({ projectRoot: root, planId: 'native-ui' }), error => {
    assert.match(error.message, /design|设计/);
    assert.equal(error.code, 'DESIGN_BASELINE_MISSING');
    return true;
  });
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

// ---- Issue #255：批准覆盖矩阵与创建前证据能力预检 ----

const sha256 = value => createHash('sha256').update(value).digest('hex');

function coverageProject({ nodes, surfaces, fallback = true } = {}) {
  const root = nativeProject('native-coverage', []);
  const designDir = path.join(root, 'docs', 'design', 'coverage');
  mkdirSync(designDir, { recursive: true });
  const files = {
    'docs/design/coverage/reference.png': 'approved-reference',
    'docs/design/coverage/verifier.mjs': 'export async function verify() {}',
    'docs/design/coverage/fallback.mjs': 'export async function capture() {}',
  };
  for (const [relative, bytes] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), bytes);
  }
  const manifest = {
    schema: 1, designId: 'coverage', verifierPath: 'docs/design/coverage/verifier.mjs',
    ...(fallback ? { fallbackVerifierPath: 'docs/design/coverage/fallback.mjs' } : {}),
    artifacts: Object.entries(files).filter(([relative]) => fallback || !relative.endsWith('fallback.mjs')).map(([relative, bytes]) => ({ path: relative, sha256: sha256(bytes) })),
    surfaces: surfaces || [
      { id: 'overview', route: '/overview', viewports: ['1440x900', '390x844'], states: ['normal', 'empty'], interactions: ['open'], referencePaths: ['docs/design/coverage/reference.png'] },
      { id: 'sessions', route: '/sessions', viewports: ['390x844'], states: ['normal', 'answered'], interactions: ['search', 'answer'], referencePaths: ['docs/design/coverage/reference.png'] },
    ],
  };
  const manifestPath = 'docs/design/coverage/design-manifest.json';
  const approvalPath = 'docs/prd/native-coverage/design-approval.json';
  writeFileSync(path.join(root, manifestPath), JSON.stringify(manifest));
  mkdirSync(path.dirname(path.join(root, approvalPath)), { recursive: true });
  writeFileSync(path.join(root, approvalPath), JSON.stringify({ schema: 1, designDigest: loadDesignManifest({ projectRoot: root, manifestPath }).designDigest, confirmedAt: '2026-11-23T00:00:00.000Z' }));
  const defaultNodes = [
    { id: 'overview-ui', contract: { ...contract('public/overview.mjs'), design: { surfaceIds: ['overview'] } } },
    { id: 'sessions-ui', contract: { ...contract('mobile/app/www/pages/sessions.mjs'), design: { surfaceIds: ['sessions'] } } },
  ];
  writeFileSync(path.join(root, 'docs', 'dag-plans', 'native-coverage.json'), JSON.stringify({
    plan_id: 'native-coverage', title: 'coverage', nodes: nodes || defaultNodes,
    design: { manifestPath, approvalPath },
  }));
  return { root, manifest, manifestPath, approvalPath };
}

function coverageService(overrides = {}) {
  const store = createRunStore({ directory: mkdtempSync(path.join(tmpdir(), 'dag-coverage-store-')) });
  const calls = { smoke: [], fallback: [] };
  const service = createDagService({
    root: mkdtempSync(path.join(tmpdir(), 'dag-coverage-root-')), store,
    resolveDesignCommit: async () => 'a'.repeat(40),
    smokeApprovedDesign: async input => { calls.smoke.push(input); return { ok: true, status: 'pass', evidence: { collector: 'approved-sample' } }; },
    verifyDesign: async input => { calls.fallback.push(input); return { ok: true, status: 'pass', evidence: { collector: 'fallback' } }; },
    ...overrides,
  });
  return { service, store, calls };
}

async function createCoverage(fixture, harness) {
  const loaded = loadNativePlan({ projectRoot: fixture.root, planId: 'native-coverage' });
  const planDigest = createPlanDigest({ ...loaded, authorizationSnapshot: null });
  return harness.service.create({ planId: 'native-coverage', planDigest, confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true }, fixture.root);
}

test('coverage preflight creates only after full bidirectional coverage and approved/fallback smoke', async () => {
  const fixture = coverageProject();
  const harness = coverageService();
  const run = await createCoverage(fixture, harness);
  assert.equal(run.nodeId, ROOT_NODE);
  assert.equal(harness.calls.smoke.length, 2, '每个 UI 节点执行批准样例 smoke');
  assert.equal(harness.calls.fallback.length, 2, '每个 UI 节点通过 #256 verifyDesign 预检备用采集');
  for (const call of [...harness.calls.smoke, ...harness.calls.fallback]) {
    assert.equal(call.commit, 'a'.repeat(40));
    assert.ok(call.designBaseline.snapshotDirectory, '只能使用冻结基线');
    assert.ok(call.evidenceDir.includes('design-preflight'));
  }
  for (const call of harness.calls.fallback) {
    const primary = call.designBaseline.manifest.artifacts.find(item => item.path === call.designBaseline.manifest.verifierPath);
    assert.equal(primary.sha256, '0'.repeat(64), '仅以内存坏 hash 强制 #256 走备用采集，不改冻结副本');
  }
  assert.notEqual(run.designBaseline.manifest.artifacts.find(item => item.path === run.designBaseline.manifest.verifierPath).sha256, '0'.repeat(64));
  assert.equal(harness.store.listRuns().length, 1);
});

test('coverage preflight rejects an omitted approved surface before evidence collection or run creation', async () => {
  const fixture = coverageProject({ nodes: [
    { id: 'overview-ui', contract: { ...contract('public/overview.mjs'), design: { surfaceIds: ['overview'] } } },
  ] });
  const harness = coverageService();
  await assert.rejects(() => createCoverage(fixture, harness), error => {
    assert.equal(error.code, 'DESIGN_COVERAGE_MISSING');
    assert.ok(error.details.missing.some(item => item.surfaceId === 'sessions'));
    return true;
  });
  assert.equal(harness.calls.smoke.length, 0);
  assert.equal(harness.store.listRuns().length, 0);
});

test('coverage preflight rejects duplicate surface/state/viewport/interaction ownership', async () => {
  const fixture = coverageProject({ nodes: [
    { id: 'overview-ui', contract: { ...contract('public/overview.mjs'), design: { surfaceIds: ['overview'] } } },
    { id: 'sessions-ui', contract: { ...contract('mobile/app/www/pages/sessions.mjs'), design: { surfaceIds: ['sessions'] } } },
    { id: 'overview-duplicate', depends_on: ['overview-ui'], contract: { ...contract('public/overview-duplicate.mjs'), design: { surfaceIds: ['overview'] } } },
  ] });
  const harness = coverageService();
  await assert.rejects(() => createCoverage(fixture, harness), error => {
    assert.equal(error.code, 'DESIGN_COVERAGE_DUPLICATE');
    assert.ok(error.details.duplicate.some(item => item.surfaceId === 'overview' && item.kind === 'surface'));
    assert.ok(error.details.duplicate.some(item => item.surfaceId === 'overview' && item.kind === 'state'));
    assert.ok(error.details.duplicate.some(item => item.surfaceId === 'overview' && item.kind === 'viewport'));
    assert.ok(error.details.duplicate.some(item => item.surfaceId === 'overview' && item.kind === 'interaction'));
    return true;
  });
  assert.equal(harness.store.listRuns().length, 0);
});

test('coverage preflight reports structured omissions for viewport, state and interaction', async () => {
  for (const [field, kind, omitted] of [
    ['viewports', 'viewport', '390x844'], ['states', 'state', 'empty'], ['interactions', 'interaction', 'open'],
  ]) {
    const design = { surfaceIds: ['overview'] };
    design[field] = field === 'viewports' ? ['1440x900'] : field === 'states' ? ['normal'] : [];
    const fixture = coverageProject({ nodes: [
      { id: 'overview-ui', contract: { ...contract('public/overview.mjs'), design } },
      { id: 'sessions-ui', contract: { ...contract('mobile/app/www/pages/sessions.mjs'), design: { surfaceIds: ['sessions'] } } },
    ] });
    const harness = coverageService();
    await assert.rejects(() => createCoverage(fixture, harness), error => {
      assert.equal(error.code, 'DESIGN_COVERAGE_MISSING', kind);
      assert.ok(error.details.missing.some(item => item.surfaceId === 'overview' && item.kind === kind && item.id === omitted), JSON.stringify(error.details));
      return true;
    });
    assert.equal(harness.store.listRuns().length, 0, kind);
  }
});

test('coverage preflight rejects out-of-bounds ownership with structured existing error', () => {
  const fixture = coverageProject({ nodes: [
    { id: 'overview-ui', contract: { ...contract('public/overview.mjs'), design: { surfaceIds: ['outside'] } } },
    { id: 'sessions-ui', contract: { ...contract('mobile/app/www/pages/sessions.mjs'), design: { surfaceIds: ['sessions'] } } },
  ] });
  assert.throws(() => loadNativePlan({ projectRoot: fixture.root, planId: 'native-coverage' }), error => {
    assert.equal(error.code, 'DESIGN_CONTRACT_MISMATCH');
    return true;
  });
});

test('NoMoTo-style UI write scope without contract.design is rejected even when another node has design', () => {
  const fixture = coverageProject({ nodes: [
    { id: 'overview-ui', contract: { ...contract('public/overview.mjs'), design: { surfaceIds: ['overview'] } } },
    { id: 'sessions-ui', contract: contract('mobile/app/www/pages/sessions.mjs') },
  ] });
  assert.throws(() => loadNativePlan({ projectRoot: fixture.root, planId: 'native-coverage' }), error => {
    assert.equal(error.code, 'DESIGN_CONTRACT_MISSING');
    assert.equal(error.details.nodeId, 'sessions-ui');
    return true;
  });
});

test('digest mismatch is structured and happens before evidence collection or run creation', async () => {
  const fixture = coverageProject();
  const harness = coverageService();
  await assert.rejects(() => harness.service.create({ planId: 'native-coverage', planDigest: 'wrong', confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true }, fixture.root), error => {
    assert.equal(error.code, 'DESIGN_DIGEST_MISMATCH');
    return true;
  });
  assert.equal(harness.calls.smoke.length, 0);
  assert.equal(harness.store.listRuns().length, 0);
});

test('missing fallback capability and primary/fallback preflight failures are atomic', async () => {
  const noFallback = coverageProject({ fallback: false });
  const noFallbackHarness = coverageService();
  await assert.rejects(() => createCoverage(noFallback, noFallbackHarness), error => error.code === 'DESIGN_FALLBACK_MISSING');
  assert.equal(noFallbackHarness.store.listRuns().length, 0);

  const primaryFixture = coverageProject();
  const primaryHarness = coverageService({ smokeApprovedDesign: async () => { throw new Error('browser missing'); } });
  await assert.rejects(() => createCoverage(primaryFixture, primaryHarness), error => {
    assert.equal(error.code, 'DESIGN_EVIDENCE_PREFLIGHT');
    assert.equal(error.details.stage, 'approved-sample');
    return true;
  });
  assert.equal(primaryHarness.store.listRuns().length, 0);

  const fallbackFixture = coverageProject();
  const fallbackHarness = coverageService({ verifyDesign: async () => { throw new Error('fallback unavailable'); } });
  await assert.rejects(() => createCoverage(fallbackFixture, fallbackHarness), error => {
    assert.equal(error.code, 'DESIGN_EVIDENCE_PREFLIGHT');
    assert.equal(error.details.stage, 'fallback');
    return true;
  });
  assert.equal(fallbackHarness.store.listRuns().length, 0);
});

test('frozen recovery failure is a structured service rejection without a run', async () => {
  const fixture = coverageProject();
  const harness = coverageService();
  const loaded = loadNativePlan({ projectRoot: fixture.root, planId: 'native-coverage' });
  const existing = path.join(harness.store.directory, 'design-baselines', loaded.designBaseline.designDigest);
  mkdirSync(existing, { recursive: true });
  writeFileSync(path.join(existing, 'corrupt'), 'not a restorable baseline');
  await assert.rejects(() => createCoverage(fixture, harness), error => {
    assert.equal(error.name, 'DagServiceError');
    assert.match(error.code, /^DESIGN_/);
    return true;
  });
  assert.equal(harness.store.listRuns().length, 0);
});

test('default #256 wiring runs approved-sample smoke and capture-only fallback from a real exact commit', async () => {
  const fixture = coverageProject();
  const collector = exportName => `import { mkdirSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';\nfunction collect({ contract, designBaseline, evidenceDir }) {\n  mkdirSync(evidenceDir, { recursive: true });\n  const captures = []; const checks = [];\n  for (const surfaceId of contract.surfaceIds) {\n    const surface = designBaseline.manifest.surfaces.find(item => item.id === surfaceId);\n    for (const viewport of surface.viewports) for (const state of surface.states) {\n      const file = path.join(evidenceDir, surfaceId + '-' + viewport + '-' + state + '.png');\n      writeFileSync(file, surfaceId + ':' + viewport + ':' + state);\n      captures.push({ surfaceId, viewport, state, path: file });\n    }\n    for (const id of surface.interactions) checks.push({ surfaceId, kind: 'interaction', id, ok: true });\n  }\n  return { ok: true, checks, captures };\n}\nexport async function ${exportName}(input) { return collect(input); }\n`;
  writeFileSync(path.join(fixture.root, fixture.manifest.verifierPath), collector('smoke'));
  writeFileSync(path.join(fixture.root, fixture.manifest.fallbackVerifierPath), collector('capture'));
  fixture.manifest.artifacts.find(item => item.path === fixture.manifest.verifierPath).sha256 = sha256(collector('smoke'));
  fixture.manifest.artifacts.find(item => item.path === fixture.manifest.fallbackVerifierPath).sha256 = sha256(collector('capture'));
  writeFileSync(path.join(fixture.root, fixture.manifestPath), JSON.stringify(fixture.manifest));
  writeFileSync(path.join(fixture.root, fixture.approvalPath), JSON.stringify({
    schema: 1, designDigest: loadDesignManifest({ projectRoot: fixture.root, manifestPath: fixture.manifestPath }).designDigest,
    confirmedAt: '2026-11-23T00:00:00.000Z',
  }));
  const git = (...args) => execFileSync('git', args, { cwd: fixture.root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Issue 255 Test');
  git('config', 'user.email', 'issue-255@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'coverage preflight fixture');
  const store = createRunStore({ directory: mkdtempSync(path.join(tmpdir(), 'dag-coverage-real-store-')) });
  const service = createDagService({ root: mkdtempSync(path.join(tmpdir(), 'dag-coverage-real-root-')), store });
  const loaded = loadNativePlan({ projectRoot: fixture.root, planId: 'native-coverage' });
  const run = await service.create({
    planId: 'native-coverage', planDigest: createPlanDigest({ ...loaded, authorizationSnapshot: null }),
    confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true,
  }, fixture.root);
  assert.equal(run.nodeId, ROOT_NODE);
  assert.equal(run.status, 'queued');
  assert.equal(run.designBaseline.snapshotFiles[fixture.manifest.fallbackVerifierPath], sha256(collector('capture')));
  assert.equal(run.gated, undefined);
  writeFileSync(path.join(fixture.root, 'docs', 'design', 'coverage', 'reference.png'), 'changed after create');
  assert.equal(readFileSync(path.join(run.designBaseline.snapshotDirectory, 'docs', 'design', 'coverage', 'reference.png'), 'utf8'), 'approved-reference');
});

test('evidence directory failure is structured and leaves no dispatchable run', async () => {
  const fixture = coverageProject();
  let harness;
  harness = coverageService({ resolveDesignCommit: async () => {
    rmSync(harness.store.directory, { recursive: true, force: true });
    writeFileSync(harness.store.directory, 'not-a-directory');
    return 'a'.repeat(40);
  } });
  await assert.rejects(() => createCoverage(fixture, harness), error => {
    assert.equal(error.name, 'DagServiceError');
    assert.equal(error.code, 'DESIGN_EVIDENCE_PREFLIGHT');
    assert.equal(error.details.stage, 'evidence-directory');
    return true;
  });
  rmSync(harness.store.directory, { force: true });
  mkdirSync(harness.store.directory);
  assert.equal(harness.store.listRuns().length, 0);
});

// ---- Issue #255 rework 1：所有 DAG 文件来源与常见前端 JS/TS 入口不得绕过 ----

const reworkUiPaths = [
  'public/app.js',
  'mobile/app/www/pages/sessions.mjs',
  'src/App.js',
  'src/App.ts',
  'src/components/session-list.js',
  'src/pages/session-view.ts',
  'client/main.js',
  'frontend/main.ts',
];

function reworkNode(path, source, design) {
  const nodeContract = { ...contract(source === 'contract' ? path : 'src/backend.mjs') };
  if (design) nodeContract.design = design;
  return {
    id: 'entry-ui',
    ...(source === 'node' ? { files: [path] } : {}),
    contract: nodeContract,
  };
}

test('rework1 rejects missing design from contract.files and top-level node.files without creating a run', async t => {
  for (const source of ['contract', 'node']) {
    for (const file of reworkUiPaths) {
      await t.test(`${source}.files: ${file}`, async () => {
        const fixture = coverageProject({ nodes: [reworkNode(file, source)] });
        const harness = coverageService();
        await assert.rejects(() => createCoverage(fixture, harness), error => {
          assert.equal(error.code, 'DESIGN_CONTRACT_MISSING');
          assert.equal(error.details.nodeId, 'entry-ui');
          return true;
        });
        assert.equal(harness.store.listRuns().length, 0);
        assert.equal(harness.calls.smoke.length, 0);
      });
    }
  }
});

test('rework1 accepts the same UI paths when a legal design covers the full approved matrix', async t => {
  for (const source of ['contract', 'node']) {
    for (const file of reworkUiPaths) {
      await t.test(`${source}.files: ${file}`, async () => {
        const fixture = coverageProject({ nodes: [reworkNode(file, source, { surfaceIds: ['overview', 'sessions'] })] });
        const harness = coverageService();
        const run = await createCoverage(fixture, harness);
        assert.equal(run.nodeId, ROOT_NODE);
        assert.equal(harness.store.listRuns().length, 1);
        assert.equal(harness.calls.smoke.length, 1);
        assert.equal(harness.calls.fallback.length, 1);
      });
    }
  }
});

test('rework1 keeps pure backend JavaScript and TypeScript on the original no-design path', async t => {
  for (const file of ['src/server.js', 'src/server.ts', 'src/index.js', 'src/main.ts', 'src/dag-controller.js', 'src/dag-controller.ts']) {
    await t.test(file, async () => {
      const fixture = coverageProject({ nodes: [reworkNode(file, 'contract')] });
      const harness = coverageService();
      const loaded = loadNativePlan({ projectRoot: fixture.root, planId: 'native-coverage' });
      assert.equal(loaded.designBaseline, null);
      const run = await createCoverage(fixture, harness);
      assert.equal(run.nodeId, ROOT_NODE);
      assert.equal(run.designBaseline, null);
      assert.equal(harness.calls.smoke.length, 0);
      assert.equal(harness.calls.fallback.length, 0);
    });
  }
});
