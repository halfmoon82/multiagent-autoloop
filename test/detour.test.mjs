import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DetourError, readDetours, recordDetour, dueForProbe, markProbeResult, revertDetour,
  setDetourPersisterForTest,
} from '../src/detour.mjs';
import { saveRule } from '../src/rules.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const T0 = new Date('2026-11-15T08:00:00+08:00');

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'console-detour-'));
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:50494', owner: 'test' }));
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
  assert.throws(() => recordDetour(config, { ...input, ruleNames: ['扫描'] }, T0), /不在被拦 Agent/);
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
  assert.deepEqual(result.skipped, [{ name: '审阅', currentTo: 'codex', reason: 'left-fallback' }]);
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

// ---- reviewer 复审修复的回归测试 ----

test('recordDetour rejects ids that could escape the backup filename', () => {
  const { config } = fixture();
  for (const bad of ['../evil', 'a/b', 'a\\b', 'a b', '..']) {
    assert.throws(() => recordDetour(config, { ...input, id: bad }, T0), DetourError);
  }
});

test('recordDetour rejects a reused id even after the first detour reverted', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  revertDetour(config, 'wb-hy4-1', T0);
  assert.throws(() => recordDetour(config, input, T0), /已有同名绕行记录/);
});

test('recordDetour refuses rules that are on a third agent, not the blocked one', () => {
  const { config } = fixture();
  const raw = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  raw.rules[0].to = 'codex';
  raw.agents.codex = { name: 'Codex' };
  writeFileSync(config.rulesFile, JSON.stringify(raw, null, 2));
  assert.throws(() => recordDetour(config, input, T0), /不在被拦 Agent/);
});

test('dueForProbe tolerates hand-edited records without a probe block', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  const file = path.join(config.root, 'detours.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  delete raw.detours[0].probe;
  writeFileSync(file, JSON.stringify(raw, null, 2));
  const at = (min) => new Date(T0.getTime() + min * 60000);
  assert.deepEqual(dueForProbe(config, at(0)).map((d) => d.id), ['wb-hy4-1']);
});

test('readDetours refuses a corrupt file loudly; a locked write path quarantines it and proceeds', () => {
  const { config } = fixture();
  const file = path.join(config.root, 'detours.json');
  writeFileSync(file, '{not json');
  assert.throws(() => readDetours(config), DetourError);
  recordDetour(config, input, T0); // 持锁写路径留档隔离后照常登记
  const [quarantine] = readdirSync(config.root).filter((name) => name.startsWith('detours.json.corrupt-'));
  assert.ok(quarantine);
  assert.equal(readFileSync(path.join(config.root, quarantine), 'utf8'), '{not json');
  assert.equal(readDetours(config)[0].id, 'wb-hy4-1');
});

test('markProbeResult on a reverted record says there is no active detour', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  revertDetour(config, 'wb-hy4-1', T0);
  assert.throws(() => markProbeResult(config, 'wb-hy4-1', true, T0), /没有进行中的绕行/);
});

test('revertDetour on an already reverted record reports it plainly', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  const first = revertDetour(config, 'wb-hy4-1', T0);
  const second = revertDetour(config, 'wb-hy4-1', T0);
  assert.equal(second.already, true);
  assert.equal(second.record.status, 'reverted');
  assert.deepEqual(first.reverted, ['开发', '审阅']);
});


// ---- 第二轮复审修复的回归测试 ----

test('recordDetour rolls rules.json back when the detours write fails', () => {
  const { config, initial } = fixture();
  setDetourPersisterForTest(() => { throw new Error('磁盘满'); });
  try {
    assert.throws(() => recordDetour(config, input, T0), /已回滚/);
  } finally { setDetourPersisterForTest(null); }
  assert.deepEqual(JSON.parse(readFileSync(config.rulesFile, 'utf8')), initial); // 一字未动
  assert.deepEqual(readDetours(config), []); // 也没有半截登记
});

test('markProbeResult ok rolls rules.json back when the detours write fails', () => {
  const { config } = fixture();
  recordDetour(config, input, T0);
  setDetourPersisterForTest(() => { throw new Error('磁盘满'); });
  try {
    assert.throws(() => markProbeResult(config, 'wb-hy4-1', true, T0), /已回滚/);
  } finally { setDetourPersisterForTest(null); }
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.deepEqual(saved.rules.map((rule) => rule.to), ['claude', 'claude', 'claude']); // 仍绕行
  assert.equal(readDetours(config)[0].status, 'detoured');
});

test('saveRule holds the lock across a slow draft check; a concurrent detour in another process survives', async () => {
  const { config } = fixture();
  const slow = () => new Promise((resolve) => setTimeout(resolve, 2000)); // 拉开窗口：慢机上无锁变异也能被子进程抓到
  const saving = saveRule(config, { name: '新规则', trigger: 'cron', cron: '0 9 * * *', to: 'claude', cwd: '/tmp', prompt: '新', parallel: '', resume: false }, null, slow);
  // 模拟生产形态：绕行 CLI 是独立进程，与本进程内 server 的表单保存竞争同一把锁
  // （spawn 保持异步，父进程事件循环不被堵，锁才能按时交接）
  const childDone = new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { loadConsoleConfig } = await import('./src/config.mjs');
      const { recordDetour } = await import('./src/detour.mjs');
      recordDetour(loadConsoleConfig(), ${JSON.stringify(input)});
    `], { cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))), env: { ...process.env, AGENT_AUTOLOOP_HOME: config.root }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => resolve({ code, err }));
  });
  const [child] = await Promise.all([childDone, saving.then(() => null)]);
  assert.equal(child.code, 0, child.err);
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  const detoured = saved.rules.find((rule) => rule.name === '开发');
  const added = saved.rules.find((rule) => rule.name === '新规则');
  assert.equal(detoured.to, 'claude'); // 两种变更都存活
  assert.ok(added);
});
