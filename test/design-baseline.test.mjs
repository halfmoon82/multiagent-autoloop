import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadDesignManifest, loadDesignBaseline, assertNodeDesignSnapshot, designContractDigest,
} from '../src/design-baseline.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'design-baseline-'));
  mkdirSync(path.join(root, 'docs', 'design', 'demo'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'design', 'demo', 'reference.png'), 'png-fixture');
  const manifest = {
    schema: 1,
    designId: 'demo',
    artifacts: [{ path: 'docs/design/demo/reference.png', sha256: sha256('png-fixture') }],
    surfaces: [{
      id: 'dag-detail', route: '/dag/:id', viewports: ['1440x900', '390x844'],
      states: ['normal', 'blocked'], interactions: ['open-node'],
      referencePaths: ['docs/design/demo/reference.png'],
    }],
  };
  const manifestPath = 'docs/design/demo/design-manifest.json';
  writeFileSync(path.join(root, manifestPath), JSON.stringify(manifest));
  return { root, projectRoot: root, manifest, manifestPath };
}

function approvedProject() {
  const fixture = project();
  const loaded = loadDesignManifest({ projectRoot: fixture.root, manifestPath: fixture.manifestPath });
  const approvalPath = 'docs/prd/demo/design-approval.json';
  mkdirSync(path.join(fixture.root, path.dirname(approvalPath)), { recursive: true });
  writeFileSync(path.join(fixture.root, approvalPath), JSON.stringify({
    schema: 1, designDigest: loaded.designDigest, confirmedAt: '2026-11-17T12:00:00.000Z',
  }));
  return { ...fixture, loaded, approvalPath };
}

test('loads a content-hashed design manifest and its matching approval', () => {
  const fixture = approvedProject();
  const baseline = loadDesignBaseline(fixture);
  assert.match(baseline.designDigest, /^[0-9a-f]{64}$/);
  assert.equal(baseline.designDigest, fixture.loaded.designDigest);
  assert.equal(baseline.approval.confirmedAt, '2026-11-17T12:00:00.000Z');
  assert.deepEqual(baseline.readOnlyPaths.sort(), [
    'docs/design/demo/design-manifest.json',
    'docs/design/demo/reference.png',
    'docs/prd/demo/design-approval.json',
  ].sort());
});

test('rejects modified artifacts and references not covered by artifact hashes', () => {
  const changed = project();
  writeFileSync(path.join(changed.root, 'docs/design/demo/reference.png'), 'changed');
  assert.throws(() => loadDesignManifest(changed), /sha256|摘要不符/);
  const uncovered = project();
  const manifest = { ...uncovered.manifest, artifacts: [] };
  writeFileSync(path.join(uncovered.root, uncovered.manifestPath), JSON.stringify(manifest));
  assert.throws(() => loadDesignManifest(uncovered), /referencePaths|产物/);
});

test('rejects absolute, traversal and symlink-escaping design paths', () => {
  const traversal = project();
  assert.throws(() => loadDesignManifest({ projectRoot: traversal.root, manifestPath: '../outside.json' }), /路径/);
  const linked = project();
  const outside = path.join(tmpdir(), `outside-${process.pid}.json`);
  writeFileSync(outside, '{}');
  const link = path.join(linked.root, 'docs', 'design', 'demo', 'linked.json');
  symlinkSync(outside, link);
  assert.throws(() => loadDesignManifest({ projectRoot: linked.root, manifestPath: 'docs/design/demo/linked.json' }), /逃逸|项目根/);
});

test('requires a matching explicit approval only for a declared design', () => {
  const fixture = project();
  assert.throws(() => loadDesignBaseline({ ...fixture, approvalPath: 'docs/prd/demo/missing.json' }), /批准|确认/);
  const mismatch = approvedProject();
  writeFileSync(path.join(mismatch.root, mismatch.approvalPath), JSON.stringify({
    schema: 1, designDigest: '0'.repeat(64), confirmedAt: '2026-11-17T12:00:00.000Z',
  }));
  assert.throws(() => loadDesignBaseline(mismatch), /designDigest|批准/);
});

test('validates node surface, viewport, state and interaction subsets from the frozen snapshot', () => {
  const fixture = approvedProject();
  const baseline = loadDesignBaseline(fixture);
  const root = { designBaseline: baseline };
  const node = { id: 'ui', contract: { design: { surfaceIds: ['dag-detail'], viewports: ['390x844'], states: ['blocked'], interactions: ['open-node'] } } };
  assert.equal(assertNodeDesignSnapshot(root, node).ok, true);
  assert.equal(assertNodeDesignSnapshot(root, { id: 'backend', contract: {} }).ok, true);
  assert.throws(() => assertNodeDesignSnapshot(root, { id: 'bad', contract: { design: { surfaceIds: ['missing'] } } }), /surfaceIds|surface/);
  assert.throws(() => assertNodeDesignSnapshot(root, { id: 'bad', contract: { design: { surfaceIds: ['dag-detail'], states: ['loading'] } } }), /states|state/);
  const first = designContractDigest({ designDigest: baseline.designDigest, contract: node.contract.design });
  assert.equal(first, designContractDigest({ designDigest: baseline.designDigest, contract: node.contract.design }));
  assert.notEqual(first, designContractDigest({ designDigest: '0'.repeat(64), contract: node.contract.design }));
});
