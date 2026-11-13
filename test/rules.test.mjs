import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRuleOptions, saveRule } from '../src/rules.mjs';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'console-rules-'));
  const rulesFile = path.join(root, 'rules.json');
  const initial = { sources: { local: { name: '本机' } }, agents: { fake: { name: 'Fake', worker: 'local', use: 'command', access: 'read' } }, rules: [{ name: '旧规则', when: { source: 'local', types: ['old'] }, to: 'fake', cwd: root, prompt: '旧提示', custom: 'keep' }], elsewhere: [] };
  writeFileSync(rulesFile, JSON.stringify(initial));
  return { config: { rulesFile, cliPath: '/unused', root }, initial };
}
const input = { name: '日报', trigger: 'cron', cron: '0 9 * * *', to: 'fake', cwd: '/tmp', prompt: '生成日报', parallel: '2', resume: false };

test('reads public rule options and Agent access without exposing internal Agent commands', () => {
  const { config } = fixture(); const data = readRuleOptions(config);
  assert.equal(data.rules[0].name, '旧规则'); assert.equal(data.agents[0].access, 'read'); assert.equal(data.agents[0].command, undefined);
});

test('creates a rule from form fields and preserves the rest of the file', async () => {
  const { config } = fixture(); await saveRule(config, input, null, async () => {});
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.deepEqual(saved.rules[1], { name: '日报', when: { cron: '0 9 * * *' }, to: 'fake', cwd: '/tmp', prompt: '生成日报', parallel: 2, resume: false });
  assert.deepEqual(saved.sources, { local: { name: '本机' } });
});

test('edits a rule without dropping fields not represented by the form', async () => {
  const { config } = fixture(); await saveRule(config, { ...input, name: '旧规则', trigger: 'event', source: 'local', types: 'new, updated', parallel: '' }, '旧规则', async () => {});
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.equal(saved.rules[0].custom, 'keep'); assert.deepEqual(saved.rules[0].when, { source: 'local', types: ['new', 'updated'] }); assert.equal(saved.rules[0].parallel, undefined);
});

test('rejects duplicate names and invalid form fields before checking or writing', async () => {
  const { config } = fixture(); const before = readFileSync(config.rulesFile, 'utf8');
  await assert.rejects(saveRule(config, { ...input, name: '旧规则' }, null, async () => { throw new Error('must not run'); }), /同名/);
  await assert.rejects(saveRule(config, { ...input, cwd: 'relative/path' }, null, async () => {}), /绝对路径/);
  assert.equal(readFileSync(config.rulesFile, 'utf8'), before);
});

test('a failed draft check leaves the real rules byte-for-byte unchanged', async () => {
  const { config } = fixture(); const before = readFileSync(config.rulesFile);
  await assert.rejects(saveRule(config, input, null, async () => { throw new Error('cron 无效'); }), /cron 无效/);
  assert.deepEqual(readFileSync(config.rulesFile), before);
});
