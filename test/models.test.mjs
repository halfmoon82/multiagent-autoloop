import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const moduleUrl = new URL('../src/models.mjs', import.meta.url).href;
const defaults = { codex: '默认模型', workbuddy: 'ACP 当前配置', claude: '默认模型' };

function readLabels(home) {
  const env = { ...process.env };
  delete env.HOME;
  if (home !== undefined) env.HOME = home;
  const output = execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { modelLabels } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(modelLabels()));`,
  ], { env, encoding: 'utf8' });
  return JSON.parse(output);
}

test('uses display defaults without HOME instead of reading a personal account', () => {
  assert.deepEqual(readLabels(undefined), defaults);
});

test('reads model labels from the configured HOME', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'autoloop-models-'));
  mkdirSync(path.join(home, '.codex'));
  mkdirSync(path.join(home, '.codebuddy'));
  mkdirSync(path.join(home, '.claude'));
  writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "codex-test"\n');
  writeFileSync(path.join(home, '.codebuddy', 'settings.json'), JSON.stringify({ modelId: 'workbuddy-test' }));
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ modelId: 'claude-test' }));
  assert.deepEqual(readLabels(home), { codex: 'codex-test', workbuddy: 'workbuddy-test', claude: 'claude-test' });
});
