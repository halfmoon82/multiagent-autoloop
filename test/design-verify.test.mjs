import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
