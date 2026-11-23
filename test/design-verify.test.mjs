import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultGit } from '../src/dag-slots.mjs';
import { verifyDesign as verifyDesignModule } from '../src/design-verify.mjs';
import { makeRepo, sh } from './helpers-git.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const verifierPath = 'docs/design/demo/verify.mjs';

function makeVerifierProject() {
  const { project } = makeRepo();
  mkdirSync(path.dirname(path.join(project, verifierPath)), { recursive: true });
  const approved = `import { mkdirSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';\nexport async function verify({ evidenceDir }) {\n  if (process.env.AGENT_AUTOLOOP_HOME !== undefined) return { ok: false, checks: [{ id: 'env', ok: false }] };\n  mkdirSync(evidenceDir, { recursive: true });\n  const capture = path.join(evidenceDir, 'overview-1440x900-normal.png');\n  writeFileSync(capture, 'approved-normal');\n  return { ok: true, checks: [{ id: 'normal', ok: true }], captures: [{ surfaceId: 'overview', viewport: '1440x900', state: 'normal', path: capture }] };\n}\n`;
  writeFileSync(path.join(project, verifierPath), approved);
  sh(project, 'add', verifierPath); sh(project, 'commit', '-qm', 'approved verifier');
  const approvedCommit = sh(project, 'rev-parse', 'HEAD');
  const designBaseline = {
    designDigest: 'a'.repeat(64), manifestPath: 'docs/design/demo/design-manifest.json',
    manifest: { schema: 1, designId: 'demo', verifierPath, artifacts: [{ path: verifierPath, sha256: sha256(approved) }], surfaces: [{ id: 'overview', route: '/', viewports: ['1440x900'], states: ['normal'], interactions: [], referencePaths: [] }] },
    readOnlyPaths: [verifierPath],
  };
  const contract = { surfaceIds: ['overview'], states: ['normal'], interactions: [] };
  return { project, approved, approvedCommit, designBaseline, contract };
}

test('design verifier runs in a sanitized child process and binds server identity', async () => {
  const f = makeVerifierProject();
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'design-verify-child-'));
  const previous = process.env.AGENT_AUTOLOOP_HOME;
  process.env.AGENT_AUTOLOOP_HOME = 'sentinel-must-not-cross';
  try {
    const result = await verifyDesignModule({
      nodeId: 'ui', worktree: f.project, project: f.project, git: defaultGit,
      commit: f.approvedCommit, designBaseline: f.designBaseline, contract: f.contract, evidenceDir,
    });
    assert.equal(result.ok, true, JSON.stringify(result.evidence));
    assert.equal(result.evidence.commit, f.approvedCommit);
    assert.equal(result.evidence.designDigest, f.designBaseline.designDigest);
    assert.match(result.evidence.contractDigest, /^[0-9a-f]{64}$/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_AUTOLOOP_HOME; else process.env.AGENT_AUTOLOOP_HOME = previous;
  }
});

test('a worker-committed verifier with a different hash is rejected before import', async () => {
  const f = makeVerifierProject();
  const attacker = `export async function verify() { return { ok: true, checks: [{ id: 'attacker', ok: true }] }; }\n`;
  writeFileSync(path.join(f.project, verifierPath), attacker);
  sh(f.project, 'add', verifierPath); sh(f.project, 'commit', '-qm', 'attacker verifier');
  const attackerCommit = sh(f.project, 'rev-parse', 'HEAD');
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'design-verify-attack-'));
  await assert.rejects(() => verifyDesignModule({
    nodeId: 'ui', worktree: f.project, project: f.project, git: defaultGit,
    commit: attackerCommit, designBaseline: f.designBaseline, contract: f.contract, evidenceDir,
  }), /sha256|hash|摘要/);
  assert.equal(readFileSync(path.join(f.project, verifierPath), 'utf8'), attacker);
});

test('a frozen baseline restores deleted verifier bytes without trusting the worker commit', async () => {
  const f = makeVerifierProject();
  const snapshotDirectory = mkdtempSync(path.join(tmpdir(), 'design-frozen-verifier-'));
  mkdirSync(path.join(snapshotDirectory, path.dirname(verifierPath)), { recursive: true });
  writeFileSync(path.join(snapshotDirectory, verifierPath), f.approved);
  f.designBaseline.snapshotDirectory = snapshotDirectory;
  f.designBaseline.snapshotFiles = { [verifierPath]: sha256(f.approved) };
  rmSync(path.join(f.project, verifierPath));
  sh(f.project, 'add', verifierPath); sh(f.project, 'commit', '-qm', 'delete baseline verifier');
  const commit = sh(f.project, 'rev-parse', 'HEAD');
  const result = await verifyDesignModule({
    nodeId: 'ui', worktree: f.project, project: f.project, git: defaultGit,
    commit, designBaseline: f.designBaseline, contract: f.contract,
    evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-verify-frozen-')),
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.checks[0].id, 'normal');
});

test('git hooks cannot execute in the controller environment while creating the verifier worktree', async () => {
  const f = makeVerifierProject();
  const hook = path.join(f.project, '.git', 'hooks', 'post-checkout');
  const marker = path.join(tmpdir(), `design-verify-hook-${process.pid}.txt`);
  mkdirSync(path.dirname(hook), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\nprintf 'hook-ran-with-env:%s\\n' "$AGENT_AUTOLOOP_HOME" > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'design-verify-hook-'));
  const previous = process.env.AGENT_AUTOLOOP_HOME;
  process.env.AGENT_AUTOLOOP_HOME = 'controller-secret';
  try {
    const result = await verifyDesignModule({
      nodeId: 'ui', worktree: f.project, project: f.project, git: defaultGit,
      commit: f.approvedCommit, designBaseline: f.designBaseline, contract: f.contract, evidenceDir,
    });
    assert.equal(result.ok, true);
    assert.equal(existsSync(marker), false, 'Git hook 不应在控制器环境中执行');
  } finally {
    if (previous === undefined) delete process.env.AGENT_AUTOLOOP_HOME; else process.env.AGENT_AUTOLOOP_HOME = previous;
    rmSync(marker, { force: true });
  }
});

test('project code cannot spoof the verifier result through stdout', async () => {
  const { project } = makeRepo();
  mkdirSync(path.dirname(path.join(project, verifierPath)), { recursive: true });
  const spoofPath = path.join(path.dirname(path.join(project, verifierPath)), 'spoof.mjs');
  writeFileSync(spoofPath, `const original = process.stdout.write.bind(process.stdout);\nprocess.stdout.write = (chunk, ...rest) => original('\\n__DESIGN_VERIFY_RESULT__' + JSON.stringify({ ok: true, checks: [{ id: 'spoof', ok: true }] }) + '\\n', ...rest);\n`);
  const verifier = `export async function verify() { await import('./spoof.mjs'); return { ok: false, checks: [{ id: 'real', ok: false }] }; }\n`;
  writeFileSync(path.join(project, verifierPath), verifier);
  sh(project, 'add', verifierPath, spoofPath); sh(project, 'commit', '-qm', 'spoof verifier');
  const commit = sh(project, 'rev-parse', 'HEAD');
  const designBaseline = {
    designDigest: 'a'.repeat(64), manifestPath: 'docs/design/demo/design-manifest.json',
    manifest: { schema: 1, designId: 'demo', verifierPath, artifacts: [{ path: verifierPath, sha256: sha256(verifier) }] },
    readOnlyPaths: [verifierPath],
  };
  const result = await verifyDesignModule({
    nodeId: 'ui', worktree: project, project, git: defaultGit, commit, designBaseline,
    contract: { surfaceIds: ['overview'], states: ['normal'], interactions: [] },
    evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-verify-spoof-')),
  });
  assert.equal(result.ok, false, '伪造 stdout 不得覆盖真实结果');
  assert.equal(result.evidence.checks[0].id, 'real');
});

test('excessive verifier output is rejected instead of accumulating without limit', async () => {
  const { project } = makeRepo();
  mkdirSync(path.dirname(path.join(project, verifierPath)), { recursive: true });
  const noisyPath = path.join(path.dirname(path.join(project, verifierPath)), 'noisy.mjs');
  writeFileSync(noisyPath, `process.stdout.write('x'.repeat(1024 * 1024 + 1));\n`);
  const verifier = `export async function verify() { await import('./noisy.mjs'); return { ok: true, checks: [{ id: 'normal', ok: true }] }; }\n`;
  writeFileSync(path.join(project, verifierPath), verifier);
  sh(project, 'add', verifierPath, noisyPath); sh(project, 'commit', '-qm', 'noisy verifier');
  const commit = sh(project, 'rev-parse', 'HEAD');
  const designBaseline = {
    designDigest: 'a'.repeat(64), manifestPath: 'docs/design/demo/design-manifest.json',
    manifest: { schema: 1, designId: 'demo', verifierPath, artifacts: [{ path: verifierPath, sha256: sha256(verifier) }] },
    readOnlyPaths: [verifierPath],
  };
  await assert.rejects(() => verifyDesignModule({
    nodeId: 'ui', worktree: project, project, git: defaultGit, commit, designBaseline,
    contract: { surfaceIds: ['overview'], states: ['normal'], interactions: [] },
    evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-verify-noisy-')),
  }), /输出|output/i);
});

test('project code cannot spoof fd3 results by monkeypatching JSON.stringify or reading execArgv', async () => {
  const { project } = makeRepo();
  mkdirSync(path.dirname(path.join(project, verifierPath)), { recursive: true });
  const verifier = `import { writeFileSync } from 'node:fs';\nimport path from 'node:path';\nexport async function verify({ evidenceDir }) {\n  writeFileSync(path.join(evidenceDir, 'execArgv.txt'), process.execArgv.join('\\\\n'));\n  const original = JSON.stringify;\n  JSON.stringify = () => original({ ok: true, checks: [{ id: 'forged', ok: true }] });\n  return { ok: false, checks: [{ id: 'real', ok: false }] };\n}\n`;
  writeFileSync(path.join(project, verifierPath), verifier);
  sh(project, 'add', verifierPath); sh(project, 'commit', '-qm', 'stringify spoof verifier');
  const commit = sh(project, 'rev-parse', 'HEAD');
  const designBaseline = {
    designDigest: 'a'.repeat(64), manifestPath: 'docs/design/demo/design-manifest.json',
    manifest: { schema: 1, designId: 'demo', verifierPath, artifacts: [{ path: verifierPath, sha256: sha256(verifier) }] },
    readOnlyPaths: [verifierPath],
  };
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'design-verify-stringify-'));
  const result = await verifyDesignModule({
    nodeId: 'ui', worktree: project, project, git: defaultGit, commit, designBaseline,
    contract: { surfaceIds: ['overview'], states: ['normal'], interactions: [] }, evidenceDir,
  });
  assert.equal(result.ok, false, 'JSON.stringify monkeypatch 不得伪造结果');
  assert.equal(result.evidence.checks[0].id, 'real');
  const execArgv = readFileSync(path.join(evidenceDir, 'execArgv.txt'), 'utf8');
  assert.doesNotMatch(execArgv, /\"nonce\"/, 'execArgv 不得暴露 payload JSON');
  assert.doesNotMatch(execArgv, /[0-9a-f]{64}/, 'execArgv 不得暴露一次性 nonce');
});

test('real verifyDesign does not execute config-driven fsmonitor while creating its worktree', async () => {
  const f = makeVerifierProject();
  const marker = path.join(tmpdir(), `design-verify-fsmonitor-${process.pid}.txt`);
  const script = path.join(tmpdir(), `design-verify-fsmonitor-${process.pid}.sh`);
  writeFileSync(script, `#!/bin/sh\nprintf 'fsmonitor-ran\\n' > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  sh(f.project, 'config', 'core.fsmonitor', script);
  try {
    const result = await verifyDesignModule({
      nodeId: 'ui', worktree: f.project, project: f.project, commit: f.approvedCommit,
      designBaseline: f.designBaseline, contract: f.contract,
      evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-verify-fsmonitor-')),
    });
    assert.equal(result.ok, true);
    assert.equal(existsSync(marker), false, 'verifyDesign 不得执行 core.fsmonitor');
  } finally { rmSync(marker, { force: true }); rmSync(script, { force: true }); }
});

test('project cannot spoof fd3 results through inherited or own toJSON', async () => {
  const { project } = makeRepo();
  mkdirSync(path.dirname(path.join(project, verifierPath)), { recursive: true });
  const verifier = `export async function verify() {\n  Object.prototype.toJSON = function () {\n    if ('nonce' in this) return { nonce: this.nonce, result: { ok: true, checks: [{ id: 'forged', ok: true }] } };\n    return this;\n  };\n  const result = { ok: false, checks: [{ id: 'real', ok: false }] };\n  result.toJSON = () => ({ ok: true, checks: [{ id: 'own-forged', ok: true }] });\n  return result;\n}\n`;
  writeFileSync(path.join(project, verifierPath), verifier);
  sh(project, 'add', verifierPath); sh(project, 'commit', '-qm', 'toJSON spoof verifier');
  const commit = sh(project, 'rev-parse', 'HEAD');
  const designBaseline = {
    designDigest: 'a'.repeat(64), manifestPath: 'docs/design/demo/design-manifest.json',
    manifest: { schema: 1, designId: 'demo', verifierPath, artifacts: [{ path: verifierPath, sha256: sha256(verifier) }] },
    readOnlyPaths: [verifierPath],
  };
  const result = await verifyDesignModule({
    nodeId: 'ui', worktree: project, project, commit, designBaseline,
    contract: { surfaceIds: ['overview'], states: ['normal'], interactions: [] },
    evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-verify-tojson-')),
  });
  assert.equal(result.ok, false, 'toJSON 不得伪造结果');
  assert.equal(result.evidence.checks[0].id, 'real');
});


function approveVerifier(f, primary, fallback = null) {
  writeFileSync(path.join(f.project, verifierPath), primary);
  f.designBaseline.manifest.artifacts.find(artifact => artifact.path === verifierPath).sha256 = sha256(primary);
  const files = [verifierPath];
  if (fallback) {
    const fallbackPath = 'docs/design/demo/fallback.mjs';
    writeFileSync(path.join(f.project, fallbackPath), fallback);
    f.designBaseline.manifest.fallbackVerifierPath = fallbackPath;
    f.designBaseline.manifest.artifacts.push({ path: fallbackPath, sha256: sha256(fallback) });
    f.designBaseline.readOnlyPaths.push(fallbackPath);
    files.push(fallbackPath);
  }
  sh(f.project, 'add', ...files); sh(f.project, 'commit', '-qm', 'approve resilient verifier');
  return sh(f.project, 'rev-parse', 'HEAD');
}

const throwingVerifier = message => `export async function verify() { throw new Error(${JSON.stringify(message)}); }\n`;
const capturingFallback = `import { mkdirSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';\nexport async function capture({ evidenceDir, commit }) {\n  mkdirSync(evidenceDir, { recursive: true });\n  const file = path.join(evidenceDir, 'fallback.png');\n  writeFileSync(file, 'fallback:' + commit);\n  return { ok: true, checks: [{ surfaceId: 'overview', kind: 'layout', id: 'normal', ok: true }], captures: [{ surfaceId: 'overview', viewport: '1440x900', state: 'normal', path: file }], renderer: { name: 'static-fallback', version: '1' } };\n}\n`;

test('approved reference samples support an isolated pre-creation verifier smoke', async () => {
  const f = makeVerifierProject();
  const primary = `import { mkdirSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';\nexport async function verify() { throw new Error('implementation verifier must not run during smoke'); }\nexport async function smoke({ evidenceDir, approvedSamples, mode }) {\n  if (mode !== 'approved-sample' || approvedSamples?.[0]?.surfaceId !== 'overview') throw new Error('approved sample missing');\n  mkdirSync(evidenceDir, { recursive: true });\n  const file = path.join(evidenceDir, 'smoke.png');\n  writeFileSync(file, 'smoke:' + approvedSamples[0].path);\n  return { ok: true, checks: [{ surfaceId: 'overview', kind: 'layout', id: 'normal', ok: true }], captures: [{ surfaceId: 'overview', viewport: '1440x900', state: 'normal', path: file }] };\n}\n`;
  // A hash-covered approved reference is the smoke input, not a worker-produced screenshot.
  const reference = 'docs/design/demo/reference.png';
  writeFileSync(path.join(f.project, reference), 'approved-reference');
  f.designBaseline.manifest.artifacts.push({ path: reference, sha256: sha256('approved-reference') });
  f.designBaseline.manifest.surfaces[0].referencePaths = [reference];
  f.designBaseline.readOnlyPaths.push(reference);
  sh(f.project, 'add', reference); sh(f.project, 'commit', '-qm', 'approved sample');
  const commit = approveVerifier(f, primary);
  const { smokeApprovedDesign } = await import('../src/design-verify.mjs');
  assert.equal(typeof smokeApprovedDesign, 'function', '必须导出批准样例 smoke 入口');
  const result = await smokeApprovedDesign({
    nodeId: 'ui', project: f.project, commit, designBaseline: f.designBaseline, contract: f.contract,
    evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-approved-smoke-')), timeoutMs: 1000,
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.evidence.collector, 'approved-sample');
  assert.match(result.evidence.captures[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(readFileSync(result.evidence.captures[0].path, 'utf8'), /reference\.png$/);
});

test('browser failure in the primary verifier falls back to approved full captures on the same commit', async () => {
  const f = makeVerifierProject();
  const commit = approveVerifier(f, throwingVerifier('browser executable missing'), capturingFallback);
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'design-fallback-success-'));
  const result = await verifyDesignModule({ nodeId: 'ui', project: f.project, commit, designBaseline: f.designBaseline, contract: f.contract, evidenceDir });
  assert.equal(result.status, 'pass');
  assert.equal(result.evidence.collector, 'fallback');
  assert.equal(result.evidence.recovery.primaryError, 'browser executable missing');
  assert.equal(readFileSync(result.evidence.captures[0].path, 'utf8'), `fallback:${commit}`);
});

test('verifier timeout and dependency failures use fallback; dual facility failure is not deviation', async () => {
  const recovered = makeVerifierProject();
  const recoveredCommit = approveVerifier(recovered, throwingVerifier('verifier timeout after dependency missing'), capturingFallback);
  const result = await verifyDesignModule({ nodeId: 'ui', project: recovered.project, commit: recoveredCommit, designBaseline: recovered.designBaseline, contract: recovered.contract, evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-timeout-fallback-')) });
  assert.equal(result.evidence.collector, 'fallback');
  const failed = makeVerifierProject();
  const failedCommit = approveVerifier(failed, throwingVerifier('browser missing'), throwingVerifier('fallback dependency missing'));
  await assert.rejects(() => verifyDesignModule({ nodeId: 'ui', project: failed.project, commit: failedCommit, designBaseline: failed.designBaseline, contract: failed.contract, evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-dual-failure-')) }), error => {
    assert.equal(error.status, 'infrastructure-error');
    assert.equal(error.code, 'DESIGN_EVIDENCE_INFRASTRUCTURE');
    assert.notEqual(error.status, 'deviation');
    return true;
  });
});

test('partial primary captures are incomplete and cannot bypass fallback recovery', async () => {
  const f = makeVerifierProject();
  const partial = `export async function verify() { return { ok: true, checks: [{ surfaceId: 'overview', kind: 'layout', id: 'normal', ok: true }], captures: [] }; }\n`;
  const commit = approveVerifier(f, partial);
  await assert.rejects(() => verifyDesignModule({ nodeId: 'ui', project: f.project, commit, designBaseline: f.designBaseline, contract: f.contract, evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-partial-captures-')) }), error => {
    assert.equal(error.status, 'incomplete');
    assert.equal(error.code, 'DESIGN_EVIDENCE_INCOMPLETE');
    assert.match(error.message, /captures|证据/);
    return true;
  });
});

test('evidence is rebuilt from the exact historical commit rather than the current checkout', async () => {
  const f = makeVerifierProject();
  writeFileSync(path.join(f.project, 'implementation.txt'), 'historical-commit\n');
  sh(f.project, 'add', 'implementation.txt'); sh(f.project, 'commit', '-qm', 'historical implementation');
  const historical = sh(f.project, 'rev-parse', 'HEAD');
  const primary = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';\nexport async function verify({ evidenceDir, worktree }) {\n  mkdirSync(evidenceDir, { recursive: true });\n  const file = path.join(evidenceDir, 'historical.png');\n  writeFileSync(file, readFileSync(path.join(worktree, 'implementation.txt')));\n  return { ok: true, checks: [{ surfaceId: 'overview', kind: 'layout', id: 'normal', ok: true }], captures: [{ surfaceId: 'overview', viewport: '1440x900', state: 'normal', path: file }] };\n}\n`;
  const approved = approveVerifier(f, primary);
  writeFileSync(path.join(f.project, 'implementation.txt'), 'current-checkout\n');
  const result = await verifyDesignModule({ nodeId: 'ui', project: f.project, commit: approved, designBaseline: f.designBaseline, contract: f.contract, evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-exact-rebuild-')) });
  assert.equal(result.evidence.commit, approved);
  assert.equal(readFileSync(result.evidence.captures[0].path, 'utf8'), 'historical-commit\n');
  assert.notEqual(approved, historical);
});

test('a real child timeout recovers through fallback with the full viewport/state capture matrix', async () => {
  const f = makeVerifierProject();
  f.designBaseline.manifest.surfaces[0].viewports = ['1440x900', '390x844'];
  f.designBaseline.manifest.surfaces[0].states = ['normal', 'empty'];
  f.designBaseline.manifest.surfaces[0].interactions = ['open'];
  f.contract = { surfaceIds: ['overview'], viewports: ['1440x900', '390x844'], states: ['normal', 'empty'], interactions: ['open'] };
  const hanging = `export async function verify() { setInterval(() => {}, 1000); await new Promise(() => {}); }\n`;
  const fallback = `import { mkdirSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';\nexport async function capture({ evidenceDir, contract }) {\n  mkdirSync(evidenceDir, { recursive: true }); const captures = [];\n  for (const viewport of contract.viewports) for (const state of contract.states) {\n    const file = path.join(evidenceDir, viewport + '-' + state + '.png'); writeFileSync(file, viewport + ':' + state);\n    captures.push({ surfaceId: 'overview', viewport, state, path: file });\n  }\n  return { ok: true, checks: [{ surfaceId: 'overview', kind: 'interaction', id: 'open', ok: true }], captures };\n}\n`;
  const commit = approveVerifier(f, hanging, fallback);
  const result = await verifyDesignModule({ nodeId: 'ui', project: f.project, commit, designBaseline: f.designBaseline, contract: f.contract, evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-real-timeout-')), timeoutMs: 1000 });
  assert.equal(result.evidence.collector, 'fallback');
  assert.equal(result.evidence.captures.length, 4);
  assert.equal(result.evidence.coverage.complete, true);
  assert.equal(result.evidence.coverage.requiredCaptures, 4);
  assert.match(result.evidence.recovery.primaryError, /超时/);
});

test('a real missing verifier dependency falls back instead of becoming an implementation deviation', async () => {
  const f = makeVerifierProject();
  const missingDependency = `export async function verify() { await import('design-verify-dependency-that-does-not-exist-256'); }\n`;
  const commit = approveVerifier(f, missingDependency, capturingFallback);
  const result = await verifyDesignModule({ nodeId: 'ui', project: f.project, commit, designBaseline: f.designBaseline, contract: f.contract, evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-real-dependency-')) });
  assert.equal(result.status, 'pass');
  assert.equal(result.evidence.collector, 'fallback');
  assert.match(result.evidence.recovery.primaryError, /design-verify-dependency-that-does-not-exist-256/);
});

test('a valid implementation deviation stays primary evidence and never invokes fallback', async () => {
  const f = makeVerifierProject();
  const deviation = `import { mkdirSync, writeFileSync } from 'node:fs';\nimport path from 'node:path';\nexport async function verify({ evidenceDir }) {\n  mkdirSync(evidenceDir, { recursive: true }); const file = path.join(evidenceDir, 'deviation.png'); writeFileSync(file, 'deviation');\n  return { ok: false, checks: [{ surfaceId: 'overview', kind: 'layout', id: 'normal', ok: false }], captures: [{ surfaceId: 'overview', viewport: '1440x900', state: 'normal', path: file }] };\n}\n`;
  const commit = approveVerifier(f, deviation, throwingVerifier('fallback must not hide deviation'));
  const result = await verifyDesignModule({ nodeId: 'ui', project: f.project, commit, designBaseline: f.designBaseline, contract: f.contract, evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-primary-deviation-')) });
  assert.equal(result.status, 'deviation');
  assert.equal(result.evidence.collector, 'primary');
  assert.equal(result.evidence.verifierOk, false);
  assert.equal(result.evidence.recovery, undefined);
});


test('rework1：主偏差与部分 captures 并存时 fallback 只补证据、不覆盖偏差', async () => {
  const f = makeVerifierProject();
  const primary = `export async function verify() { return { ok: false, checks: [{ surfaceId: 'overview', kind: 'layout', id: 'normal', ok: false }], knownDeviations: [{ id: 'spacing', status: 'open' }], captures: [] }; }\n`;
  const commit = approveVerifier(f, primary, capturingFallback);
  const result = await verifyDesignModule({ nodeId: 'ui', project: f.project, commit, designBaseline: f.designBaseline, contract: f.contract, evidenceDir: mkdtempSync(path.join(tmpdir(), 'design-deviation-partial-')) });
  assert.equal(result.status, 'deviation');
  assert.equal(result.ok, false);
  assert.equal(result.evidence.collector, 'fallback');
  assert.equal(result.evidence.verifierOk, false);
  assert.equal(result.evidence.checks.some(check => check.ok === false), true);
  assert.equal(result.evidence.knownDeviations.length, 1);
  assert.equal(result.evidence.coverage.complete, true);
});
