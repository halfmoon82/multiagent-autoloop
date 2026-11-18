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
  const approved = `export async function verify() {\n  if (process.env.AGENT_AUTOLOOP_HOME !== undefined) return { ok: false, checks: [{ id: 'env', ok: false }] };\n  return { ok: true, checks: [{ id: 'normal', ok: true }] };\n}\n`;
  writeFileSync(path.join(project, verifierPath), approved);
  sh(project, 'add', verifierPath); sh(project, 'commit', '-qm', 'approved verifier');
  const approvedCommit = sh(project, 'rev-parse', 'HEAD');
  const designBaseline = {
    designDigest: 'a'.repeat(64), manifestPath: 'docs/design/demo/design-manifest.json',
    manifest: { schema: 1, designId: 'demo', verifierPath, artifacts: [{ path: verifierPath, sha256: sha256(approved) }] },
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
