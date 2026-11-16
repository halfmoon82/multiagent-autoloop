import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVibePlan, createPlanDigest, createRunSnapshot } from '../src/vibe-plan.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vibe-5.2.7');
function projectWithPlan() {
  const root = mkdtempSync(path.join(tmpdir(), 'vibe-plan-test-'));
  const target = path.join(root, '.vibe', 'plans', 'demo-plan');
  mkdirSync(target, { recursive: true });
  cpSync(fixture, target, { recursive: true });
  return root;
}

test('loads a real-shaped vibe 5.2.7 plan and creates deterministic digest and runtime snapshot', () => {
  const root = projectWithPlan();
  const loaded = loadVibePlan({ projectRoot: root, planId: 'demo-plan' });
  assert.equal(loaded.nodes.length, 3);
  assert.equal(loaded.plan.plan_id, 'demo-plan');
  const auth = { targetRepository: 'owner/repo', mergeStrategy: 'squash', actions: ['push', 'create-pr'] };
  const digest = createPlanDigest({ ...loaded, authorizationSnapshot: auth });
  assert.equal(digest, createPlanDigest({ ...loaded, authorizationSnapshot: auth }));
  const snapshot = createRunSnapshot(loaded, { authorizationSnapshot: auth, maxParallel: 5 });
  assert.equal(snapshot.planDigest, digest);
  assert.equal(snapshot.maxParallel, 5);
  assert.equal(snapshot.nodes['account-model'].status, 'pending');
  assert.deepEqual(snapshot.nodes['billing-api'].depends_on, ['account-model']);
  assert.equal(snapshot.authorizationSnapshot.targetRepository, 'owner/repo');
});

test('rejects plan traversal, unresolved product decisions and missing integration review', () => {
  const root = projectWithPlan();
  assert.throws(() => loadVibePlan({ projectRoot: root, planId: '../demo-plan' }), /planId/);
  const dir = path.join(root, '.vibe', 'plans', 'demo-plan');
  const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  plan.decisions[0].status = 'unresolved';
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  assert.throws(() => loadVibePlan({ projectRoot: root, planId: 'demo-plan' }), /决策/);
  plan.decisions[0].status = 'approved';
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  const nodes = JSON.parse(readFileSync(path.join(dir, 'nodes.json'), 'utf8')).filter(node => node.id !== 'integration-review');
  writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify(nodes));
  assert.throws(() => loadVibePlan({ projectRoot: root, planId: 'demo-plan' }), /integration-review/);
});

test('rejects malformed decision entries with a readable validation error', () => {
  const root = projectWithPlan();
  const dir = path.join(root, '.vibe', 'plans', 'demo-plan');
  const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  plan.decisions.push(null);
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  assert.throws(() => loadVibePlan({ projectRoot: root, planId: 'demo-plan' }), /决策/);
});

test('rejects an empty node list instead of producing a zero-node snapshot', () => {
  const root = projectWithPlan();
  const dir = path.join(root, '.vibe', 'plans', 'demo-plan');
  writeFileSync(path.join(dir, 'nodes.json'), '[]');
  assert.throws(() => loadVibePlan({ projectRoot: root, planId: 'demo-plan' }), /节点/);
});

test('createRunSnapshot enforces the parallel ceiling and the forever-forbidden action list', () => {
  const root = projectWithPlan();
  const loaded = loadVibePlan({ projectRoot: root, planId: 'demo-plan' });
  const auth = { targetRepository: 'owner/repo', mergeStrategy: 'squash', actions: ['push', 'create-pr'] };
  assert.throws(() => createRunSnapshot(loaded, { authorizationSnapshot: auth, maxParallel: 6 }), /1 到 5/);
  assert.throws(() => createRunSnapshot(loaded, { authorizationSnapshot: auth, maxParallel: 0 }), /1 到 5/);
  for (const forbidden of ['deploy', 'release', 'read-credentials', 'send-external-message']) {
    const bad = { ...auth, actions: [...auth.actions, forbidden] };
    assert.throws(() => createRunSnapshot(loaded, { authorizationSnapshot: bad }), /禁止/);
  }
});

test('rejects empty projectRoot and planId/plan.json mismatch', () => {
  assert.throws(() => loadVibePlan({ projectRoot: '', planId: 'demo-plan' }), /projectRoot/);
  const root = projectWithPlan();
  const dir = path.join(root, '.vibe', 'plans', 'demo-plan');
  const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  plan.plan_id = 'another-plan';
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  assert.throws(() => loadVibePlan({ projectRoot: root, planId: 'demo-plan' }), /plan_id/);
});
