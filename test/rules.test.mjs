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

test('rejects a write-intent prompt on a read-only Agent (契约错配防护)', async () => {
  const { config } = fixture();
  const before = readFileSync(config.rulesFile, 'utf8');
  await assert.rejects(
    saveRule(config, { ...input, name: '门禁登记', prompt: '收到授权后把授权结论写入 state.nodes[node]' }, null, async () => {}),
    /只读/,
  );
  await assert.rejects(
    saveRule(config, { ...input, name: '台账登记', prompt: '把授权登记进 mtexec-serial.json 台账' }, null, async () => {}),
    /只读/,
  );
  assert.equal(readFileSync(config.rulesFile, 'utf8'), before);
});

test('write-intent lint has no false positives on prose mentions or writable Agents', async () => {
  const { config } = fixture();
  await saveRule(config, { ...input, name: '日报', prompt: '生成日报' }, null, async () => {});
  await saveRule(config, { ...input, name: '汇报', prompt: '把选择结果写进你的汇报，不要修改任何文件' }, null, async () => {});
  const raw = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  raw.agents.fullbot = { name: 'Full', worker: 'local', use: 'command', access: 'full' };
  writeFileSync(config.rulesFile, JSON.stringify(raw));
  await saveRule(config, { ...input, name: '可写门禁', to: 'fullbot', prompt: '把授权结论写入 state.nodes[node]' }, null, async () => {});
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.equal(saved.rules.at(-1).to, 'fullbot');
});

test('negation heuristics: only verb-adjacent prohibitions are exempt', async () => {
  const { config } = fixture();
  // 紧邻动词的否定 → 豁免，可保存
  await saveRule(config, { ...input, name: '否定豁免', prompt: '不要修改 rules.json，只汇报' }, null, async () => {});
  // 否定的是别的词、命中动词跨桥接词 → 仍算写意图，拒绝
  const before = readFileSync(config.rulesFile, 'utf8');
  await assert.rejects(
    saveRule(config, { ...input, name: '跨桥否定', prompt: '别犹豫，把授权写入台账文件' }, null, async () => {}),
    /只读/,
  );
  await assert.rejects(
    saveRule(config, { ...input, name: '跨桥否定2', prompt: '不得延误，尽快修改 rules.json' }, null, async () => {}),
    /只读/,
  );
  assert.equal(readFileSync(config.rulesFile, 'utf8'), before);
});

test('read-only mention of serial.json without a write verb is not write intent', async () => {
  const { config } = fixture();
  await saveRule(config, { ...input, name: '只读控制器', prompt: '无模型读取 V6 串行状态（state/v6-serial.json），只读不写' }, null, async () => {});
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.equal(saved.rules.at(-1).name, '只读控制器');
});
