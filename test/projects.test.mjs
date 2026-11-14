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

test('skips repos whose path contains whitespace or control characters', () => {
  const root = fixture();
  mkdirSync(path.join(root, 'my project', '.git'), { recursive: true });
  const projects = discoverGitProjects({ roots: [root] });
  assert.ok(!projects.some(project => project.name === 'my project'));
  assert.deepEqual(projects.map(project => project.name), ['alpha', 'beta']);
});

test('merges rule workdirs that are git repos even without roots', () => {
  const root = fixture();
  const projects = discoverGitProjects({ roots: [], rules: [{ name: 'r1', cwd: path.join(root, 'plain-dir') }, { name: 'r2', cwd: path.join(root, 'alpha') }] });
  assert.deepEqual(projects.map(project => project.name), ['alpha']);
});

test('skips rule workdirs whose path contains whitespace', () => {
  const root = fixture();
  mkdirSync(path.join(root, 'spaced rule', '.git'), { recursive: true });
  const projects = discoverGitProjects({ roots: [], rules: [{ name: 'spaced', cwd: path.join(root, 'spaced rule') }] });
  assert.deepEqual(projects, []);
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
