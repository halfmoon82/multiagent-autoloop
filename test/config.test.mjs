import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConsoleConfig } from '../src/config.mjs';

test('loads local hub paths and keeps the owner credential server-side', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'console-config-'));
  mkdirSync(path.join(root, 'app', 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:3350', owner: 'private-owner-key' }));
  const config = loadConsoleConfig(root);
  assert.equal(config.hubUrl, 'http://127.0.0.1:3350');
  assert.equal(config.ownerKey, 'private-owner-key');
  assert.equal(config.rulesFile, path.join(root, 'rules.json'));
  assert.equal(config.cliPath, path.join(root, 'app', 'bin', 'agent-autoloop.ts'));
  assert.equal(config.root, root);
});

test('rejects a missing root or incomplete config with a readable error', () => {
  assert.throws(() => loadConsoleConfig(''), /AGENT_AUTOLOOP_HOME/);
  const root = mkdtempSync(path.join(tmpdir(), 'console-config-'));
  writeFileSync(path.join(root, 'config.json'), '{}');
  assert.throws(() => loadConsoleConfig(root), /config.json/);
});
