import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PATTERNS, matchesPattern, readRunFailures, scanForQuotaDetours,
} from '../src/quota-scan.mjs';

const NOW = new Date('2026-11-17T12:00:00+08:00');

function fixture({ runs = [], ruleDefs, policy } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'quota-scan-'));
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:1', owner: 't' }));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({
    sources: { local: { name: '本机' } },
    agents: { workbuddy: {}, claude: {}, 'codex-full': {} },
    rules: ruleDefs || [
      { name: '执行波开发', when: { source: 'local', types: ['dev'] }, to: 'workbuddy', cwd: '/proj/a', prompt: '写' },
      { name: 'V6审阅', when: { source: 'local', types: ['review'] }, to: 'workbuddy', cwd: '/proj/a', prompt: '审' },
    ],
  }, null, 2));
  if (policy) writeFileSync(path.join(root, 'detour-policy.json'), JSON.stringify(policy, null, 2));
  for (const run of runs) makeRun(root, run);
  return { root, config: { root, rulesFile: path.join(root, 'rules.json') } };
}

function makeRun(root, { n, attempt = 1, agent = 'workbuddy', model = 'hy4free', rule = '执行波开发', error = 'ACP 没有完成这一轮：refusal', exitCode = 1, stdout, noExit = false }) {
  const dir = path.join(root, 'worker', 'runs', `${n}-${attempt}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'entry.json'), JSON.stringify({
    run: n, attempt,
    job: { rule: { name: rule, cwd: '/proj/a' }, agent: { id: agent, model } },
  }));
  const line = stdout !== undefined
    ? stdout
    : (error ? `{"session":"s","started":true}\n{"session":"s","finished":true,"error":${JSON.stringify(error)}}\n` : '{"session":"s","started":true}\n{"session":"s","finished":true}\n');
  writeFileSync(path.join(dir, 'stdout-1.log'), line);
  writeFileSync(path.join(dir, 'stderr-1.log'), error || '');
  if (!noExit) writeFileSync(path.join(dir, 'exit-1'), String(exitCode));
  writeFileSync(path.join(dir, 'context.json'), JSON.stringify({ events: [], answers: [], timers: [], waiting: [], open: [], decided: [] }));
  return dir;
}

const threeQuota = [
  { n: 100 }, { n: 101 }, { n: 102 },
];

test('DEFAULT_PATTERNS covers 429/refusal/配额/quota', () => {
  for (const word of ['429', 'refusal', '配额', 'quota']) assert.ok(DEFAULT_PATTERNS.some((p) => new RegExp(p, 'i').test(word)), word);
});

test('readRunFailures extracts agent/model/kind/quota and keeps evidence text', () => {
  const { root } = fixture({ runs: [{ n: 200, model: 'hy4flash', rule: 'V6审阅' }] });
  const failures = readRunFailures({ root });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].agent, 'workbuddy');
  assert.equal(failures[0].model, 'hy4flash');
  assert.equal(failures[0].kind, 'review');
  assert.equal(failures[0].quota, true);
  assert.match(failures[0].evidence, /refusal/);
  assert.match(failures[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('configurable patterns decide quota hits (non-quota failures do not match)', () => {
  const { root } = fixture({ runs: [{ n: 200, error: 'boom 编译失败' }] });
  assert.equal(readRunFailures({ root })[0].quota, false);
  assert.equal(readRunFailures({ root, patterns: ['boom'] })[0].quota, true);
});

test('exit-0 rounds with quota patterns in stdout are not misjudged as failures or counted (P1-a)', () => {
  // 成功轮次（exit 0）的 stdout 含 429/quota 等模式，但没有 error 行——
  // 不得判为 failed/quota，三轮也不得触发改派（真钱风险）。
  const okLog = '{"session":"s","started":true}\n{"level":"info","msg":"GET /api 429 quota handled"}\n{"session":"s","finished":true}\n';
  const { root, config } = fixture({ runs: [
    { n: 100, exitCode: 0, error: '', stdout: okLog },
    { n: 101, exitCode: 0, error: '', stdout: okLog },
    { n: 102, exitCode: 0, error: '', stdout: okLog },
  ] });
  const failures = readRunFailures({ root });
  assert.equal(failures.length, 3);
  for (const failure of failures) {
    assert.equal(failure.failed, false, `run ${failure.id} 不该判为失败`);
    assert.equal(failure.quota, false, `run ${failure.id} 不该判为额度命中`);
  }
  const result = scanForQuotaDetours(config, { now: NOW });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.detours.length, 0);
});

test('missing exit code degrades to error lines only, not raw log text (P1-a)', () => {
  const infoLog = '{"session":"s","started":true}\n{"level":"info","msg":"quota 429 seen but handled"}\n{"session":"s","finished":true}\n';
  const { root } = fixture({ runs: [{ n: 100, error: '', noExit: true, stdout: infoLog }] });
  const failure = readRunFailures({ root })[0];
  assert.equal(failure.failed, false); // 无 error 行、无退出码 → 不算失败
  assert.equal(failure.quota, false);
});

test('matchesPattern anchors bare numeric patterns with word boundaries (P1-a)', () => {
  assert.equal(matchesPattern('HTTP 429 Too Many Requests', ['429']), true);
  assert.equal(matchesPattern('429', ['429']), true);
  assert.equal(matchesPattern('order 4291 failed', ['429']), false); // 词边界：4291 不算 429
  assert.equal(matchesPattern('code 14290', ['429']), false);
});

test('three consecutive quota hits register a detour with §12 fields and policy fallback', () => {
  const { config } = fixture({ runs: threeQuota });
  const result = scanForQuotaDetours(config, { now: NOW });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.detours.length, 1);
  const record = result.detours[0];
  assert.equal(record.origin, 'auto-scan');
  assert.equal(record.blockedAgent, 'workbuddy');
  assert.equal(record.blockedModel, 'hy4free');
  assert.match(record.blockedAt, /^\d{4}-/);
  assert.match(record.evidence, /refusal/);
  assert.equal(record.fallbackAgent, 'claude');
  assert.deepEqual(record.rules, [{ name: '执行波开发', originalTo: 'workbuddy' }]); // 只切 dev，不碰审阅
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.equal(saved.rules[0].to, 'claude');
  assert.equal(saved.rules[1].to, 'workbuddy');
});

test('three quota hits on a non-primary agent do not register a detour (P1-b)', () => {
  // dev 主=workbuddy，但规则派在 codex（第三 Agent）上；即便连续额度命中也不自动改派到 claude。
  const { config } = fixture({
    runs: [
      { n: 100, agent: 'codex' }, { n: 101, agent: 'codex' }, { n: 102, agent: 'codex' },
    ],
    ruleDefs: [{ name: '执行波开发', when: { source: 'local', types: ['dev'] }, to: 'codex', cwd: '/proj/a', prompt: '写' }],
  });
  const result = scanForQuotaDetours(config, { now: NOW });
  assert.equal(result.candidates.length, 1); // 候选人被识别
  assert.equal(result.detours.length, 0); // 但非主 Agent 不改派、不登记
  assert.ok(result.skipped.some((s) => /非主 Agent/.test(s.reason)));
});

test('a non-quota failure between hits breaks the consecutive chain', () => {
  const { config } = fixture({ runs: [
    { n: 100 }, { n: 101 }, { n: 102, error: '编译失败 module not found' }, { n: 103 },
  ] });
  const result = scanForQuotaDetours(config, { now: NOW });
  assert.equal(result.detours.length, 0);
  assert.equal(result.candidates.length, 0);
});

test('a different agent+model with fewer than threshold hits does not trigger its own detour', () => {
  const { config } = fixture({ runs: [
    { n: 100, model: 'hy4free' }, { n: 101, model: 'hy4flash' }, { n: 102, model: 'hy4free' },
  ] });
  const result = scanForQuotaDetours(config, { now: NOW });
  assert.equal(result.detours.length, 0); // hy4free 2 次、hy4flash 1 次，都不到 3
});

test('three hits on another model trigger a separate detour with that model recorded', () => {
  const { config } = fixture({ runs: [
    { n: 100, model: 'hy4flash' }, { n: 101, model: 'hy4flash' }, { n: 102, model: 'hy4flash' },
  ] });
  const result = scanForQuotaDetours(config, { now: NOW });
  assert.equal(result.detours.length, 1);
  assert.equal(result.detours[0].blockedModel, 'hy4flash');
});

test('repeated scans are idempotent: one active detour per agent+model', () => {
  const { config } = fixture({ runs: threeQuota });
  const first = scanForQuotaDetours(config, { now: NOW });
  const second = scanForQuotaDetours(config, { now: NOW });
  assert.equal(first.detours.length, 1);
  assert.equal(second.detours.length, 0);
  const detours = JSON.parse(readFileSync(path.join(config.root, 'detours.json'), 'utf8')).detours;
  assert.equal(detours.length, 1);
});

test('per-project policy override picks the project fallback', () => {
  const { config } = fixture({
    runs: threeQuota,
    policy: { projects: { '/proj/a': { dev: { primary: 'workbuddy', fallback: 'codex-full' } } } },
  });
  const result = scanForQuotaDetours(config, { now: NOW });
  assert.equal(result.detours[0].fallbackAgent, 'codex-full');
});

test('rules already on the fallback are not re-detoured', () => {
  const { config } = fixture({
    runs: threeQuota,
    ruleDefs: [{ name: '开发', to: 'claude', cwd: '/proj/a', prompt: '写' }],
  });
  const result = scanForQuotaDetours(config, { now: NOW });
  assert.equal(result.detours.length, 0);
});

test('dryRun reports candidates without writing rules or detours', () => {
  const { config } = fixture({ runs: threeQuota });
  const result = scanForQuotaDetours(config, { now: NOW, dryRun: true });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.detours.length, 0);
  assert.equal(JSON.parse(readFileSync(config.rulesFile, 'utf8')).rules[0].to, 'workbuddy');
  assert.equal(existsSync(path.join(config.root, 'detours.json')), false);
});

test('custom threshold is honored', () => {
  const { config } = fixture({ runs: [{ n: 100 }, { n: 101 }] });
  assert.equal(scanForQuotaDetours(config, { now: NOW, threshold: 2 }).detours.length, 1);
  const other = fixture({ runs: [{ n: 100 }, { n: 101 }] });
  assert.equal(scanForQuotaDetours(other.config, { now: NOW, threshold: 3 }).detours.length, 0);
});

// ---- CLI 端到端 ----
const scanCli = fileURLToPath(new URL('../scripts/quota-scan.mjs', import.meta.url));

test('CLI --json reports dry-run candidates then a real registration', () => {
  const { root } = fixture({ runs: threeQuota });
  const env = { ...process.env, AGENT_AUTOLOOP_HOME: root };
  const dry = spawnSync(process.execPath, [scanCli, '--dry-run', '--json'], { env, encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  const dryBody = JSON.parse(dry.stdout);
  assert.equal(dryBody.candidates.length, 1);
  assert.equal(dryBody.detours.length, 0);
  assert.equal(existsSync(path.join(root, 'detours.json')), false);

  const real = spawnSync(process.execPath, [scanCli, '--json'], { env, encoding: 'utf8' });
  assert.equal(real.status, 0, real.stderr);
  assert.equal(JSON.parse(real.stdout).detours.length, 1);
});

test('CLI accepts configurable patterns and rejects a bad JSON probe', () => {
  const { root } = fixture({ runs: [{ n: 100 }, { n: 101 }, { n: 102 }] });
  const env = { ...process.env, AGENT_AUTOLOOP_HOME: root };
  const bad = spawnSync(process.execPath, [scanCli, '--probe', '[{oops]'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /JSON 解析失败/);
  const custom = spawnSync(process.execPath, [scanCli, '--patterns', 'boom', '--dry-run', '--json'], { env, encoding: 'utf8' });
  assert.equal(custom.status, 0, custom.stderr);
  assert.equal(JSON.parse(custom.stdout).candidates.length, 0); // 默认 refusal 被自定义模式替换
});

test('coord kind: quota hits on codex-full reroute 调度会话执行 to claude', () => {
  const { config } = fixture({
    runs: [
      { n: 100, agent: 'codex-full', rule: '调度会话执行' },
      { n: 101, agent: 'codex-full', rule: '调度会话执行' },
      { n: 102, agent: 'codex-full', rule: '调度会话执行' },
    ],
    ruleDefs: [{ name: '调度会话执行', when: { source: 'local', types: ['scheduling.message'] }, to: 'codex-full', cwd: '/proj/a', prompt: '协调' }],
  });
  const result = scanForQuotaDetours(config, { now: NOW });
  assert.equal(result.detours.length, 1);
  const record = result.detours[0];
  assert.equal(record.blockedAgent, 'codex-full');
  assert.equal(record.fallbackAgent, 'claude');
  assert.deepEqual(record.rules, [{ name: '调度会话执行', originalTo: 'codex-full' }]);
  const saved = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  assert.equal(saved.rules[0].to, 'claude');
});

test('coord hits on claude (fallback agent) do not register a detour', () => {
  const { config } = fixture({
    runs: [
      { n: 100, agent: 'claude', rule: '调度会话执行' },
      { n: 101, agent: 'claude', rule: '调度会话执行' },
      { n: 102, agent: 'claude', rule: '调度会话执行' },
    ],
    ruleDefs: [{ name: '调度会话执行', when: { source: 'local', types: ['scheduling.message'] }, to: 'claude', cwd: '/proj/a', prompt: '协调' }],
  });
  const result = scanForQuotaDetours(config, { now: NOW });
  assert.equal(result.detours.length, 0);
  assert.ok(result.skipped.some((s) => /非主 Agent/.test(s.reason)));
});
