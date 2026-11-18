import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyDesign as verifyDesignModule } from '../src/design-verify.mjs';

function fixture() {
  const worktree = mkdtempSync(path.join(tmpdir(), 'design-verify-'));
  const verifierPath = 'docs/design/demo/verify.mjs';
  mkdirSync(path.dirname(path.join(worktree, verifierPath)), { recursive: true });
  writeFileSync(path.join(worktree, verifierPath), `export async function verify({ evidenceDir }) { return { ok: true, checks: [{ kind: 'layout', id: evidenceDir ? 'normal' : 'missing', ok: true }], visualDiffs: [{ id: 'informational', ok: false }] }; }`);
  const designBaseline = { designDigest: 'a'.repeat(64), manifest: { verifierPath }, readOnlyPaths: [verifierPath] };
  const contract = { surfaceIds: ['overview'], states: ['normal'], interactions: [] };
  return { worktree, verifierPath, designBaseline, contract, evidenceDir: path.join(worktree, 'evidence') };
}

test('default design verifier loads only the approved read-only module and binds server identity', async () => {
  const f = fixture();
  const result = await verifyDesignModule({ ...f, commit: 'sha-1', nodeId: 'ui' });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.commit, 'sha-1');
  assert.equal(result.evidence.designDigest, 'a'.repeat(64));
  assert.match(result.evidence.contractDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.evidence.visualDiffs[0].ok, false);
  f.designBaseline.readOnlyPaths = [];
  await assert.rejects(() => verifyDesignModule({ ...f, commit: 'sha-1', nodeId: 'ui' }), /只读|readOnly/);
  f.designBaseline.readOnlyPaths = [f.verifierPath]; f.designBaseline.manifest.verifierPath = null;
  await assert.rejects(() => verifyDesignModule({ ...f, commit: 'sha-1', nodeId: 'ui' }), /verifierPath/);
});
