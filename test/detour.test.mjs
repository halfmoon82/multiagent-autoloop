import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DetourError, readDetours, recordDetour, dueForProbe, markProbeResult, revertDetour,
} from '../src/detour.mjs';

const T0 = new Date('2026-11-15T08:00:00+08:00');

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'console-detour-'));
  const rulesFile = path.join(root, 'rules.json');
  const initial = {
    sources: { local: { name: '本机' } },
    agents: { workbuddy: { name: 'WorkBuddy' }, claude: { name: 'Claude Code' } },
    rules: [
      { name: '开发', when: { source: 'local', types: ['dev'] }, to: 'workbuddy', cwd: '/tmp/a', prompt: '写代码', emits: { source: 'local', types: ['review'] } },
      { name: '审阅', when: { source: 'local', types: ['review'] }, to: 'workbuddy', cwd: '/tmp/a', prompt: '审阅', resume: false },
      { name: '扫描', when: { cron: '*/5 * * * *' }, to: 'claude', cwd: '/tmp/b', prompt: '扫描' },
    ],
  };
  writeFileSync(rulesFile, JSON.stringify(initial, null, 2));
  return { config: { rulesFile, cliPath: '/unused', root }, initial };
}

const input = {
  id: 'wb-hy4-1', blockedAgent: 'workbuddy', blockedModel: 'hy4free',
  evidence: 'WP8 连续 5 次 refusal（429 配额）',
  fallbackAgent: 'claude', ruleNames: ['开发', '审阅'],
  probe: { command: ['/bin/true'], cooldownMinutes: 30 },
};

test('recordDetour flips named rules to the fallback and snapshots the original agent', () => {
  const { config, initial } = fixture();
  const record = recordDetour(config, input, T0);
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.equal(saved.rules[0].to, 'claude');
  assert.equal(saved.rules[1].to, 'claude');
  assert.equal(saved.rules[2].to, 'claude'); // 扫描本来就在 claude，未被记录却也不动
  assert.deepEqual(saved.rules[0].emits, initial.rules[0].emits); // 不动规则其他字段
  assert.equal(saved.rules[1].resume, false);
  assert.deepEqual(record.rules, [{ name: '开发', originalTo: 'workbuddy' }, { name: '审阅', originalTo: 'workbuddy' }]);
  assert.equal(record.status, 'detoured');
  assert.equal(record.fallbackAgent, 'claude');
  assert.equal(record.blockedModel, 'hy4free');
  assert.ok(existsSync(path.join(config.root, 'rules.json.bak-detour-wb-hy4-1')));
  assert.equal(JSON.parse(readFileSync(path.join(config.root, 'rules.json.bak-detour-wb-hy4-1'), 'utf8')).rules[0].to, 'workbuddy');
});

test('recordDetour keeps the rest of rules.json (agents/sources/other rules) intact', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.deepEqual(saved.agents, { workbuddy: { name: 'WorkBuddy' }, claude: { name: 'Claude Code' } });
  assert.deepEqual(saved.sources, { local: { name: '本机' } });
});

test('recordDetour refuses unknown rule names and duplicate active ids', () => {
  const { config } = fixture();
  assert.throws(() => recordDetour(config, { ...input, ruleNames: ['不存在'] }, T0), DetourError);
  recordDetour(config, input, T0);
  assert.throws(() => recordDetour(config, { ...input, id: 'wb-hy4-1' }, T0), /已有同名/);
});

test('recordDetour refuses when a named rule is already on the fallback', () => {
  const { config } = fixture();
  assert.throws(() => recordDetour(config, { ...input, ruleNames: ['扫描'] }, T0), /已经不在被拦 Agent/);
});

test('readDetours tolerates a missing file and round-trips what was recorded', () => {
  const { config } = fixture();
  assert.deepEqual(readDetours(config), []);
  recordDetour(config, input, T0);
  const detours = readDetours(config);
  assert.equal(detours.length, 1);
  assert.equal(detours[0].id, 'wb-hy4-1');
});

test('dueForProbe fires immediately for a fresh detour and then only after cooldown', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  const at = (min) => new Date(T0.getTime() + min * 60000);
  assert.deepEqual(dueForProbe(config, at(0)).map((d) => d.id), ['wb-hy4-1']);
  markProbeResult(config, 'wb-hy4-1', false, at(0));
  assert.deepEqual(dueForProbe(config, at(29)), []);
  assert.deepEqual(dueForProbe(config, at(30)).map((d) => d.id), ['wb-hy4-1']);
});

test('markProbeResult ok reverts rules to the original agent and closes the detour', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  const result = markProbeResult(config, 'wb-hy4-1', true, T0);
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.equal(saved.rules[0].to, 'workbuddy');
  assert.equal(saved.rules[1].to, 'workbuddy');
  assert.equal(saved.rules[2].to, 'claude');
  assert.equal(result.record.status, 'reverted');
  assert.deepEqual(result.reverted, ['开发', '审阅']);
  assert.deepEqual(result.skipped, []);
});

test('markProbeResult skips rules that left the fallback and reports them', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  const raw = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  raw.rules[1].to = 'codex'; // 期间被人手工改去别处
  writeFileSync(config.rulesFile, JSON.stringify(raw, null, 2));
  const result = markProbeResult(config, 'wb-hy4-1', true, T0);
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.equal(saved.rules[0].to, 'workbuddy');
  assert.equal(saved.rules[1].to, 'codex'); // 不强行拽回
  assert.deepEqual(result.skipped, [{ name: '审阅', currentTo: 'codex' }]);
});

test('markProbeResult fail keeps the fallback and stays detoured', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  markProbeResult(config, 'wb-hy4-1', false, T0);
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.equal(saved.rules[0].to, 'claude');
  const [detour] = readDetours(config);
  assert.equal(detour.status, 'detoured');
  assert.equal(detour.lastProbeOk, false);
});

test('revertDetour forces the rules back without a probe', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  revertDetour(config, 'wb-hy4-1', T0);
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.equal(saved.rules[0].to, 'workbuddy');
  assert.equal(readDetours(config)[0].status, 'reverted');
});

test('repeated probe failures accumulate history; revert writes a history entry', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  markProbeResult(config, 'wb-hy4-1', false, T0);
  revertDetour(config, 'wb-hy4-1', new Date(T0.getTime() + 3600000));
  const [detour] = readDetours(config);
  assert.equal(detour.history.length, 3);
  assert.equal(detour.history.at(-1).event, 'reverted');
});
