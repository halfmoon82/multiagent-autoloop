import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PolicyError, DEFAULT_POLICY, classifyKind, loadPolicy, effectivePolicy, resolveFallback,
} from '../src/detour-policy.mjs';

function rootWithPolicy(doc) {
  const root = mkdtempSync(path.join(tmpdir(), 'detour-policy-'));
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:1', owner: 't' }));
  if (doc !== undefined) writeFileSync(path.join(root, 'detour-policy.json'), JSON.stringify(doc, null, 2));
  return { root, config: { root } };
}

test('DEFAULT_POLICY fixes dev=workbuddy/claude and review=claude/codex-full', () => {
  assert.deepEqual({ ...DEFAULT_POLICY.dev }, { primary: 'workbuddy', fallback: 'claude' });
  assert.deepEqual({ ...DEFAULT_POLICY.review }, { primary: 'claude', fallback: 'codex-full' });
});

test('classifyKind recognizes Chinese and English rule names and explicit override', () => {
  assert.equal(classifyKind('Phase1开发'), 'dev');
  assert.equal(classifyKind('V6审阅'), 'review');
  assert.equal(classifyKind('MT开发'), 'dev');
  assert.equal(classifyKind('执行波审阅返工'), 'review');
  assert.equal(classifyKind('frontend dev work'), 'dev');
  assert.equal(classifyKind('independent code review'), 'review');
  assert.equal(classifyKind('审阅', 'dev'), 'dev'); // 显式参数优先
  assert.equal(classifyKind('扫描'), null);
  assert.equal(classifyKind(''), null);
});

test('loadPolicy without a file returns pure defaults', () => {
  const { config } = rootWithPolicy();
  const policy = loadPolicy(config);
  assert.deepEqual(policy.defaults, { dev: { primary: 'workbuddy', fallback: 'claude' }, review: { primary: 'claude', fallback: 'codex-full' } });
  assert.deepEqual(policy.projects, {});
});

test('loadPolicy merges project overrides on top of defaults', () => {
  const { config } = rootWithPolicy({
    projects: { '/proj/a': { dev: { primary: 'codex', fallback: 'claude' } } },
  });
  const policy = loadPolicy(config);
  assert.equal(policy.projects['/proj/a'].dev.primary, 'codex');
  assert.equal(policy.projects['/proj/a'].dev.fallback, 'claude');
  assert.deepEqual(effectivePolicy(policy, '/proj/a').review, { primary: 'claude', fallback: 'codex-full' });
  assert.deepEqual(effectivePolicy(policy, '/other').dev, { primary: 'workbuddy', fallback: 'claude' });
});

test('effectivePolicy prefers the longest matching project cwd prefix', () => {
  const { config } = rootWithPolicy({
    projects: {
      '/proj': { dev: { primary: 'codex', fallback: 'claude' } },
      '/proj/sub': { dev: { primary: 'codex-full', fallback: 'workbuddy' } },
    },
  });
  const policy = loadPolicy(config);
  assert.equal(effectivePolicy(policy, '/proj/sub/rules').dev.primary, 'codex-full');
  assert.equal(effectivePolicy(policy, '/proj/other').dev.primary, 'codex');
});

test('resolveFallback routes primary to backup and refuses further hops', () => {
  const { config } = rootWithPolicy();
  const policy = loadPolicy(config);
  assert.equal(resolveFallback('dev', 'workbuddy', { policy }), 'claude');
  assert.equal(resolveFallback('review', 'claude', { policy }), 'codex-full');
  assert.equal(resolveFallback('dev', 'claude', { policy }), null); // 已在备选，不再往下绕
  assert.equal(resolveFallback('review', 'codex-full', { policy }), null);
  assert.throws(() => resolveFallback('scan', 'workbuddy', { policy }), PolicyError);
});

test('resolveFallback applies per-project override only to matching cwd', () => {
  const { config } = rootWithPolicy({
    projects: { '/proj/a': { dev: { primary: 'codex', fallback: 'claude' } } },
  });
  const policy = loadPolicy(config);
  assert.equal(resolveFallback('dev', 'codex', { policy, cwd: '/proj/a' }), 'claude');
  assert.equal(resolveFallback('dev', 'codex', { policy, cwd: '/elsewhere' }), 'claude'); // 默认 dev 主=workbuddy，codex 非主也走备选 claude
});

test('loadPolicy rejects malformed override files loudly', () => {
  const { config } = rootWithPolicy({ projects: { '/p': { dev: { primary: 'x' } } } });
  assert.throws(() => loadPolicy(config), PolicyError);
});
