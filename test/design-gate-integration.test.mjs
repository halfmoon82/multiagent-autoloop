// Issue #260：跨节点集成复核。所有故障均在临时项目/假 Hub 中先触发目标失败，再验证安全收敛。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDagService } from '../src/dag-service.mjs';
import { createRunStore, ALLOWED_ACTIONS, ROOT_NODE } from '../src/dag-run.mjs';
import { loadNativePlan } from '../src/dag-plan.mjs';
import { createPlanDigest } from '../src/vibe-plan.mjs';
import { designContractDigest, loadDesignBaseline, loadDesignManifest } from '../src/design-baseline.mjs';
import { validateDesignEvidence, verifyDesign } from '../src/design-verify.mjs';
import { loadNodeStates } from '../src/dag-controller.mjs';
import { mkNode, setup } from './dag-fakes.mjs';

const PLAN_ID = 'integration-ui';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const contract = (file, design) => ({ input: 'i', output: 'o', error_behavior: 'e', acceptance_example: 'a', files: [file], ...(design ? { design } : {}) });
const uiDesign = (surfaceIds = ['overview', 'detail']) => ({ surfaceIds });

function verifierSource(kind, behavior = 'pass') {
  const common = String.raw`
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
async function collect(input) {
  mkdirSync(input.evidenceDir, { recursive: true });
  const captures = []; const checks = [{ id: 'matrix', ok: true }];
  const selected = input.designBaseline.manifest.surfaces.filter(surface => input.contract.surfaceIds.includes(surface.id));
  for (const surface of selected) {
    const viewports = input.contract.viewports || surface.viewports;
    const states = input.contract.states || surface.states;
    const interactions = input.contract.interactions === undefined ? surface.interactions : input.contract.interactions;
    for (const viewport of viewports) for (const state of states) {
      const file = path.join(input.evidenceDir, surface.id + '-' + viewport + '-' + state + '.png');
      writeFileSync(file, 'capture:' + surface.id + ':' + viewport + ':' + state);
      captures.push({ surfaceId: surface.id, viewport, state, path: file });
    }
    for (const id of interactions) checks.push({ surfaceId: surface.id, kind: 'interaction', id, ok: true });
  }
  return { ok: true, checks, captures };
}
`;
  const action = {
    pass: 'return collect(input);',
    missing: "throw new Error(\"Cannot find module 'approved-verifier'\");",
    browser: "throw new Error('playwright browser missing');",
    dependency: "throw new Error(\"Cannot find package 'playwright'\");",
    screenshot: "throw new Error('screenshot failed: target closed');",
    timeout: 'await new Promise(resolve => setTimeout(resolve, 5000)); return collect(input);',
    'deviation-partial': `const result = await collect(input); result.captures.pop(); result.ok = false; result.checks[0].ok = false; result.knownDeviations = [{ id: 'spacing', status: 'open' }]; return result;`,
    fail: "throw new Error('fallback browser dependency missing');",
  }[behavior];
  if (!action) throw new Error(`unknown verifier behavior ${behavior}`);
  return `${common}\nexport async function smoke(input) { return collect(input); }\nexport async function ${kind === 'primary' ? 'verify' : 'capture'}(input) { ${action} }\n`;
}

function makeProject({ primary = 'pass', fallback = 'pass', surfaces = ['overview', 'detail'], design = uiDesign() } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'issue-260-design-'));
  const manifestPath = 'docs/design/demo/design-manifest.json';
  const approvalPath = 'docs/prd/demo/design-approval.json';
  const verifierPath = 'docs/design/demo/primary.mjs';
  const fallbackVerifierPath = 'docs/design/demo/fallback.mjs';
  const referencePath = 'docs/design/demo/reference.png';
  for (const directory of ['docs/design/demo', 'docs/prd/demo', 'docs/dag-plans']) mkdirSync(path.join(root, directory), { recursive: true });
  const primarySource = verifierSource('primary', primary);
  const fallbackSource = verifierSource('fallback', fallback);
  writeFileSync(path.join(root, verifierPath), primarySource);
  writeFileSync(path.join(root, fallbackVerifierPath), fallbackSource);
  writeFileSync(path.join(root, referencePath), 'approved-reference');
  const surfaceData = surfaces.map((id, index) => ({
    id, route: `#${id}`, viewports: ['1440x900', '390x844'], states: ['normal', 'empty'],
    interactions: [id === 'overview' ? 'open' : 'close'], referencePaths: [referencePath],
  }));
  const manifest = {
    schema: 1, designId: 'issue-260', verifierPath, fallbackVerifierPath,
    artifacts: [referencePath, verifierPath, fallbackVerifierPath].map(file => ({ path: file, sha256: sha256(readFileSync(path.join(root, file))) })),
    surfaces: surfaceData,
  };
  writeFileSync(path.join(root, manifestPath), JSON.stringify(manifest));
  const designDigest = loadDesignManifest({ projectRoot: root, manifestPath }).designDigest;
  writeFileSync(path.join(root, approvalPath), JSON.stringify({ schema: 1, designDigest, confirmedAt: '2026-11-24T00:00:00.000Z' }));
  const node = { id: 'ui', depends_on: [], status: 'pending', contract: contract('src/App.js', design) };
  const plan = { plan_id: PLAN_ID, title: 'Issue 260 integration', design: { manifestPath, approvalPath }, nodes: [node] };
  writeFileSync(path.join(root, 'docs/dag-plans', `${PLAN_ID}.json`), JSON.stringify(plan));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  git('init', '-q'); git('config', 'user.name', 'Issue 260'); git('config', 'user.email', 'issue-260@example.invalid');
  git('add', '.'); git('commit', '-qm', 'integration fixture');
  return { root, git, commit: git('rev-parse', 'HEAD'), manifestPath, approvalPath, verifierPath, fallbackVerifierPath, referencePath, manifest, plan, node };
}

function serviceHarness(fixture, overrides = {}) {
  const store = createRunStore({ directory: mkdtempSync(path.join(tmpdir(), 'issue-260-store-')) });
  const service = createDagService({ root: mkdtempSync(path.join(tmpdir(), 'issue-260-service-')), store, log() {}, ...overrides });
  const create = async () => {
    const loaded = loadNativePlan({ projectRoot: fixture.root, planId: PLAN_ID });
    return service.create({
      planId: PLAN_ID, planDigest: createPlanDigest({ ...loaded, authorizationSnapshot: null }),
      confirmedActionIds: [...ALLOWED_ACTIONS], confirm: true,
    }, fixture.root);
  };
  return { store, service, create };
}

async function expectCreationRejection(fixture, code, overrides) {
  const harness = serviceHarness(fixture, overrides);
  await assert.rejects(harness.create, error => {
    assert.equal(error.code, code, String(error));
    return true;
  });
  assert.equal(harness.store.listRuns().length, 0, `${code} 后不得留下可派发 run`);
}

async function runVerifier(fixture, behaviorOptions = {}) {
  const designBaseline = loadDesignBaseline({ projectRoot: fixture.root, manifestPath: fixture.manifestPath, approvalPath: fixture.approvalPath });
  return verifyDesign({
    nodeId: 'ui', project: fixture.root, commit: fixture.commit, designBaseline,
    contract: fixture.node.contract.design,
    evidenceDir: mkdtempSync(path.join(tmpdir(), 'issue-260-evidence-')),
    ...behaviorOptions,
  });
}

function writePlan(fixture, plan) {
  writeFileSync(path.join(fixture.root, 'docs/dag-plans', `${PLAN_ID}.json`), JSON.stringify(plan));
}

const controllerBaseline = () => ({
  designDigest: 'a'.repeat(64), manifestPath: 'docs/design/demo/design-manifest.json',
  manifest: { schema: 1, designId: 'demo', artifacts: [], surfaces: [{ id: 'overview', route: '/', viewports: ['1440x900'], states: ['normal'], interactions: ['open'], referencePaths: [] }] },
  readOnlyPaths: ['docs/design/demo/design-manifest.json'],
});
const controllerEvidence = (input, baseline, design, extra = {}) => ({
  commit: input.commit, designDigest: baseline.designDigest,
  contractDigest: designContractDigest({ designDigest: baseline.designDigest, contract: design }),
  checks: [{ id: 'visual', ok: true }], captures: [], knownDeviations: [], ...extra,
});

test('integration：批准样例、真实备用采集与完整 UI 归属在创建前通过并冻结基线', async () => {
  const fixture = makeProject();
  const harness = serviceHarness(fixture);
  const run = await harness.create();
  assert.equal(run.nodeId, ROOT_NODE);
  assert.equal(run.status, 'queued');
  assert.equal(run.gated, undefined);
  assert.equal(run.designBaseline.snapshotFiles[fixture.fallbackVerifierPath], sha256(verifierSource('fallback')));
  assert.ok(existsSync(path.join(run.designBaseline.snapshotDirectory, fixture.referencePath)));
  writeFileSync(path.join(fixture.root, fixture.referencePath), 'mutable-source-changed');
  assert.equal(readFileSync(path.join(run.designBaseline.snapshotDirectory, fixture.referencePath), 'utf8'), 'approved-reference');
});

test('fault-injection：UI 覆盖漏项与重复归属双向拒绝，且不创建 run', async () => {
  const missing = makeProject({ design: uiDesign(['overview']) });
  await expectCreationRejection(missing, 'DESIGN_COVERAGE_MISSING');

  const duplicate = makeProject();
  duplicate.plan.nodes.push({ id: 'other-ui', depends_on: [], status: 'pending', contract: contract('src/pages/other.js', uiDesign(['overview'])) });
  writePlan(duplicate, duplicate.plan);
  await expectCreationRejection(duplicate, 'DESIGN_COVERAGE_DUPLICATE');
});

test('fault-injection：NoMoTo 同类 UI 写范围漏 design 与合同字段缺失在创建前发现', async () => {
  const omitted = makeProject();
  omitted.plan.nodes.push({ id: 'nomoto-ui', depends_on: [], status: 'pending', contract: contract('mobile/app/www/pages/sessions.mjs') });
  writePlan(omitted, omitted.plan);
  await expectCreationRejection(omitted, 'DESIGN_CONTRACT_MISSING');

  const missingFields = makeProject({ design: {} });
  await expectCreationRejection(missingFields, 'INVALID_DESIGN_MANIFEST');
});

test('fault-injection：基线丢失与批准产物损坏均在采集前拒绝', async () => {
  const missing = makeProject();
  rmSync(path.join(missing.root, missing.manifestPath));
  await expectCreationRejection(missing, 'DESIGN_FILE_MISSING');

  const corrupt = makeProject();
  writeFileSync(path.join(corrupt.root, corrupt.referencePath), 'corrupted-approved-reference');
  await expectCreationRejection(corrupt, 'DESIGN_ARTIFACT_DIGEST_MISMATCH');
});

test('fault-injection：verifier/浏览器/依赖/截图/超时目标失败后由备用采集恢复', async t => {
  for (const [primary, pattern, options] of [
    ['missing', /Cannot find module|approved-verifier/, {}],
    ['browser', /browser missing/, {}],
    ['dependency', /Cannot find package|playwright/, {}],
    ['screenshot', /screenshot failed/, {}],
    ['timeout', /超时/, { timeoutMs: 500 }],
  ]) {
    await t.test(primary, async () => {
      const fixture = makeProject({ primary });
      const result = await runVerifier(fixture, options);
      assert.equal(result.status, 'pass');
      assert.equal(result.evidence.collector, 'fallback');
      assert.equal(result.evidence.coverage.complete, true);
      assert.equal(result.evidence.coverage.captures, result.evidence.coverage.requiredCaptures);
      assert.match(result.evidence.recovery.primaryError, pattern, '必须先观察到主路径目标性失败');
    });
  }
});

test('fault-injection：主备设施双失败在创建前拒绝，不能变成实现偏差或运行后门禁', async () => {
  const fixture = makeProject({ primary: 'browser', fallback: 'fail' });
  await expectCreationRejection(fixture, 'DESIGN_EVIDENCE_PREFLIGHT');
});

test('fault-injection：部分 captures 与主实现偏差并存时备用只补证据、不洗绿偏差', async () => {
  const fixture = makeProject({ primary: 'deviation-partial' });
  const result = await runVerifier(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'deviation');
  assert.equal(result.evidence.collector, 'fallback');
  assert.equal(result.evidence.recovery.primaryDeviationPreserved, true);
  assert.equal(result.evidence.coverage.complete, true);
  assert.ok(result.evidence.checks.some(check => check.ok === false));
  assert.deepEqual(result.evidence.knownDeviations.map(item => item.id), ['spacing']);
});

test('fault-injection：证据形态无效、部分矩阵与不同 SHA 全部 fail closed', async () => {
  const fixture = makeProject();
  const designBaseline = loadDesignBaseline({ projectRoot: fixture.root, manifestPath: fixture.manifestPath, approvalPath: fixture.approvalPath });
  const result = await runVerifier(fixture);
  const input = { designBaseline, contract: fixture.node.contract.design, evidenceDir: path.dirname(result.evidence.captures[0].path) };
  assert.throws(() => validateDesignEvidence({ ...input, evidence: { ...result.evidence, checks: [] } }), error => error.code === 'DESIGN_EVIDENCE_INCOMPLETE');
  assert.throws(() => validateDesignEvidence({ ...input, evidence: { ...result.evidence, captures: result.evidence.captures.slice(1) } }), error => error.code === 'DESIGN_EVIDENCE_INCOMPLETE');
  assert.throws(() => validateDesignEvidence({ ...input, evidence: { ...result.evidence, knownDeviations: {} } }), error => error.code === 'DESIGN_EVIDENCE_INCOMPLETE');

  const ui = mkNode('ui'); ui.contract.design = { surfaceIds: ['overview'] };
  const baseline = controllerBaseline();
  const commit = 'a'.repeat(40);
  const evidence = controllerEvidence({ commit: 'b'.repeat(40) }, baseline, ui.contract.design);
  const states = loadNodeStates({ nodes: [ui], designBaseline: baseline, publish: { nodes: { ui: {
    state: 'accepted', commit, codeReviewAccepted: true,
    codeReviewEvidence: { source: 'independent-review', commit: 'b'.repeat(40), runId: 'old-review' },
    designConformance: true, designEvidence: evidence,
  } } } });
  assert.equal(states.nodes.ui.codeReviewAccepted, false);
  assert.equal(states.nodes.ui.codeReviewStatus, 'stale');
  assert.equal(states.nodes.ui.designConformance, false);
  assert.equal(states.nodes.ui.designEvidenceState, 'stale');
});

test('integration：两项独立结论同 SHA 才 merge，设计偏差只走正常返工', async () => {
  const ui = mkNode('ui'); ui.contract.design = { surfaceIds: ['overview'] };
  const baseline = controllerBaseline();
  const s = setup([ui], { designBaseline: baseline });
  let mergeInput;
  s.publisher.verify = async input => ({
    ok: true, tests: { exitCode: 0 }, designStatus: 'pass', designConformance: true,
    designEvidence: controllerEvidence(input, baseline, ui.contract.design),
  });
  s.publisher.merge = async input => { mergeInput = input; return { mergeCommit: 'merge-ui' }; };
  await s.ctl.tick(); s.claimAll(); s.receipt('ui', 'dev', 'done'); await s.ctl.tick();
  s.receipt('ui', 'review', 'accepted'); await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.ui.state, 'accepted');
  assert.equal(mergeInput.codeReviewAccepted, true);
  assert.equal(mergeInput.designConformance, true);
  assert.equal(mergeInput.codeReviewEvidence.source, 'independent-review');
  assert.equal(mergeInput.evidence.commit, mergeInput.commit);

  const rework = setup([ui], { designBaseline: baseline });
  rework.publisher.verify = async input => ({
    ok: true, tests: { exitCode: 0 }, designStatus: 'deviation', designConformance: false,
    designEvidence: controllerEvidence(input, baseline, ui.contract.design, { checks: [{ id: 'visual', ok: false }] }),
  });
  await rework.ctl.tick(); rework.claimAll(); rework.receipt('ui', 'dev', 'done'); await rework.ctl.tick();
  rework.receipt('ui', 'review', 'accepted'); await rework.ctl.tick();
  assert.equal(rework.ctl.snapshot().nodes.ui.state, 'dev');
  assert.equal(rework.ctl.snapshot().nodes.ui.codeReviewAccepted, true);
  assert.equal(rework.ctl.snapshot().nodes.ui.designConformance, false);
  assert.equal(rework.runOf('ui', 'dev').attemptReason, 'design-deviation');
  assert.equal(rework.publisher.calls.some(call => call[0] === 'merge'), false);
});

test('integration #252：运行中设施失败自动恢复，证据丢失补验重审，无设计专用 blocked/gated', async () => {
  const ui = mkNode('ui'); ui.contract.design = { surfaceIds: ['overview'] };
  const baseline = controllerBaseline();
  const s = setup([ui], { designBaseline: baseline });
  let failInfrastructure = true;
  let mergeFailures = 0;
  s.publisher.merge = async () => { mergeFailures++; const error = new Error('evidence disappeared before merge'); error.code = 'DESIGN_EVIDENCE_INCOMPLETE'; throw error; };
  s.publisher.verify = async input => {
    if (failInfrastructure) throw new Error('browser unavailable');
    return { ok: true, tests: { exitCode: 0 }, designStatus: 'pass', designConformance: true, designEvidence: controllerEvidence(input, baseline, ui.contract.design) };
  };
  await s.ctl.tick(); s.claimAll(); s.receipt('ui', 'dev', 'done'); await s.ctl.tick();
  assert.match(s.ctl.snapshot().nodes.ui.lastError, /browser unavailable/);
  assert.equal(s.runOf('ui', 'dev').failures, 0);
  failInfrastructure = false; await s.ctl.tick();
  assert.ok(s.hub.last('ui', 'review'));
  assert.equal(s.runOf('ui', 'dev').attempt, 1);

  const snapshot = s.ctl.snapshot(); snapshot.nodes.ui.designEvidence = null;
  s.store.updateRun(s.root.runId, { publish: { nodes: snapshot.nodes, approachChanges: snapshot.approachChanges } });
  s.receipt('ui', 'review', 'accepted'); await s.ctl.tick();
  assert.equal(mergeFailures, 0, '补验后必须先重新独立审阅，不能直接 merge');
  assert.equal(s.runOf('ui', 'review').attempt, 2);
  assert.equal(s.ctl.snapshot().nodes.ui.codeReviewStatus, 'pending');
  s.receipt('ui', 'review', 'accepted'); await s.ctl.tick();
  assert.equal(mergeFailures, 1, 'merge 前必须真实触发证据失效');
  assert.equal(s.ctl.snapshot().nodes.ui.designEvidenceState, 'missing');
  await s.ctl.tick();
  assert.equal(s.runOf('ui', 'review').attempt, 3);
  assert.ok(!['blocked', 'gated'].includes(s.ctl.snapshot().nodes.ui.state));
});

test('fault-injection：worker 多次失败只沿用通用换打法/gate，不产生设计专用门禁', async () => {
  const s = setup([mkNode('worker')]);
  await s.ctl.tick();
  for (let index = 0; index < 3; index++) { s.claimAll(); s.receipt('worker', 'dev', 'rework'); await s.ctl.tick(); }
  assert.equal(s.ctl.snapshot().nodes.worker.state, 'dev');
  assert.equal(s.runOf('worker').generation, 2);
  assert.equal(s.store.getRun(s.root.runId).publish.approachChanges.length, 1);
  for (let index = 0; index < 3; index++) { s.claimAll(); s.receipt('worker', 'dev', 'rework'); await s.ctl.tick(); }
  const node = s.ctl.snapshot().nodes.worker;
  assert.equal(node.state, 'gated');
  assert.doesNotMatch(JSON.stringify(node), /design[-_ ]?(?:blocked|gated)/i);
  assert.equal(node.designConformance, null);
});

test('integration：纯后端创建与审阅保持零设计设施影响', async () => {
  const fixture = makeProject();
  fixture.plan = { plan_id: PLAN_ID, title: 'backend only', nodes: [
    { id: 'server', depends_on: [], status: 'pending', contract: contract('src/server.ts') },
    { id: 'api', depends_on: ['server'], status: 'pending', contract: contract('src/pages/api/users.ts') },
  ] };
  writePlan(fixture, fixture.plan);
  let designCalls = 0;
  const harness = serviceHarness(fixture, {
    smokeApprovedDesign: async () => { designCalls++; throw new Error('backend must not smoke'); },
    verifyDesign: async () => { designCalls++; throw new Error('backend must not verify design'); },
  });
  const run = await harness.create();
  assert.equal(run.designBaseline, null);
  assert.equal(designCalls, 0);

  const s = setup([mkNode('backend')]);
  await s.ctl.tick(); s.claimAll(); s.receipt('backend', 'dev', 'done'); await s.ctl.tick();
  s.receipt('backend', 'review', 'accepted'); await s.ctl.tick();
  assert.equal(s.ctl.snapshot().nodes.backend.state, 'accepted');
  assert.equal(s.ctl.snapshot().nodes.backend.designConformance, null);
  assert.equal(s.ctl.snapshot().nodes.backend.designEvidenceState, 'not-required');
  assert.doesNotMatch(s.hub.last('backend').prompt, /设计基线|设计合同/);
});
