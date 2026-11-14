import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverGitProjects } from '../src/projects.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { listen, close } from './helpers.mjs';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'projects-fixture-'));
  mkdirSync(path.join(root, 'alpha', '.git'), { recursive: true });
  mkdirSync(path.join(root, 'plain-dir'));
  mkdirSync(path.join(root, '.hidden', '.git'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
  mkdirSync(path.join(root, 'group', 'sub', 'beta', '.git'), { recursive: true });
  mkdirSync(path.join(root, 'deep1', 'deep2', 'deep3', 'deep4', 'gamma', '.git'), { recursive: true });
  return root;
}

test('discovers git repos under roots up to depth 4, skipping hidden and node_modules', () => {
  const root = fixture();
  const projects = discoverGitProjects({ roots: [root] });
  const names = projects.map(project => project.name);
  assert.deepEqual(names, ['alpha', 'beta']);
  assert.ok(projects.every(project => project.path.startsWith(root)));
});

test('allows repos whose path contains whitespace', () => {
  const root = fixture();
  mkdirSync(path.join(root, 'my project', '.git'), { recursive: true });
  const projects = discoverGitProjects({ roots: [root] });
  assert.ok(projects.some(project => project.name === 'my project'));
});

test('skips transient probe, rehearsal and workflow-state directories', () => {
  const root = fixture();
  for (const name of ['vibe-handoff-probe', 'vibe-rehearsal-r4', 'vga-fix-workflow-state', '旧库-待删-20261027']) mkdirSync(path.join(root, name, '.git'), { recursive: true });
  const projects = discoverGitProjects({ roots: [root] });
  for (const name of ['vibe-handoff-probe', 'vibe-rehearsal-r4', 'vga-fix-workflow-state', '旧库-待删-20261027']) assert.ok(!projects.some(project => project.name === name), name);
});

test('skips dated work directories and keeps the shallower repo on name collisions', () => {
  const root = fixture();
  mkdirSync(path.join(root, '2026-08-17', 'an-z', 'work', 'stale', '.git'), { recursive: true });
  mkdirSync(path.join(root, 'holder', 'alpha', '.git'), { recursive: true });
  const projects = discoverGitProjects({ roots: [root] });
  assert.ok(!projects.some(project => project.name === 'stale'));
  assert.deepEqual(projects.filter(project => project.name === 'alpha').map(project => project.path), [path.join(root, 'alpha')]);
});

test('merges rule workdirs that are git repos even without roots', () => {
  const root = fixture();
  const projects = discoverGitProjects({ roots: [], rules: [{ name: 'r1', cwd: path.join(root, 'plain-dir') }, { name: 'r2', cwd: path.join(root, 'alpha') }] });
  assert.deepEqual(projects.map(project => project.name), ['alpha']);
});

test('merges rule workdirs whose path contains whitespace', () => {
  const root = fixture();
  mkdirSync(path.join(root, 'spaced rule', '.git'), { recursive: true });
  const projects = discoverGitProjects({ roots: [], rules: [{ name: 'spaced', cwd: path.join(root, 'spaced rule') }] });
  assert.deepEqual(projects.map(project => project.name), ['spaced rule']);
});

test('GET /api/projects lists discovered git projects', async () => {
  const root = fixture();
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [], elsewhere: [] }));
  const config = { hubUrl: 'http://127.0.0.1:1', ownerKey: 'server-secret', host: '127.0.0.1', projectRoots: [root], rulesFile };
  const server = createConsoleServer(config, { list: async () => [], start: async () => { throw new Error('unused'); }, close: async () => { throw new Error('unused'); } });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/api/projects`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.projects.map(project => project.name), ['alpha', 'beta']);
  } finally { await close(server); }
});

test('readProjectDocs returns AGENTS.md and README content with size caps', async () => {
  const { readProjectDocs } = await import('../src/projects.mjs');
  const root = fixture();
  const repo = path.join(root, 'alpha');
  writeFileSync(path.join(repo, 'AGENTS.md'), '# 项目约定\n运行 npm test');
  writeFileSync(path.join(repo, 'README.md'), 'x'.repeat(10 * 1024));
  const docs = readProjectDocs(repo);
  assert.match(docs, /# 项目约定/);
  assert.match(docs, /运行 npm test/);
  assert.ok(!docs.includes('x'.repeat(10 * 1024)), 'oversized README must be omitted');
});

test('readProjectDocs reports missing docs instead of throwing', async () => {
  const { readProjectDocs } = await import('../src/projects.mjs');
  const root = fixture();
  assert.match(readProjectDocs(path.join(root, 'plain-dir')), /未找到/);
  assert.match(readProjectDocs('/no/such/path'), /未找到/);
});

test('readConsoleDocs bundles AGENTS.md and scheduling contract with caps', async () => {
  const { readConsoleDocs } = await import('../src/projects.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'console-docs-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), '# 调度纪律\n重试最多 3 次');
  writeFileSync(path.join(root, 'docs', 'scheduling-contract.md'), '# 调度契约\n事件链不变量');
  writeFileSync(path.join(root, 'docs', 'architecture.md'), 'z'.repeat(20 * 1024));
  const docs = readConsoleDocs(root);
  assert.match(docs, /# 调度纪律/);
  assert.match(docs, /重试最多 3 次/);
  assert.match(docs, /事件链不变量/);
  assert.ok(!docs.includes('z'.repeat(20 * 1024)), 'oversized architecture.md must be omitted');
  assert.match(readConsoleDocs('/no/such/path'), /未找到/);
});
