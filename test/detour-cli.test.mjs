import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/detour.mjs', import.meta.url));
const passProbe = `["${process.execPath}", "-e", "process.exit(0)"]`;
const failProbe = `["${process.execPath}", "-e", "process.exit(1)"]`;

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'console-detour-cli-'));
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:50494', owner: 'test' }));
  writeFileSync(path.join(root, 'rules.json'), JSON.stringify({
    sources: { local: { name: '本机' } },
    agents: { workbuddy: { name: 'WorkBuddy' }, claude: { name: 'Claude' } },
    rules: [
      { name: '开发', when: { source: 'local', types: ['dev'] }, to: 'workbuddy', cwd: '/tmp', prompt: '写' },
      { name: '审阅', when: { source: 'local', types: ['rev'] }, to: 'workbuddy', cwd: '/tmp', prompt: '审' },
    ],
  }, null, 2));
  return root;
}

const run = (root, ...argv) => spawnSync(process.execPath, [cli, ...argv], { env: { ...process.env, AGENT_AUTOLOOP_HOME: root }, encoding: 'utf8' });
const record = (root, probe) => run(root, 'record', '--id', 'c1', '--blocked-agent', 'workbuddy', '--blocked-model', 'hy4free', '--fallback', 'claude', '--rules', '开发,审阅', '--evidence', '429 测试', '--probe', probe, '--cooldown', '1');
const rulesTo = (root) => JSON.parse(readFileSync(path.join(root, 'rules.json'), 'utf8')).rules.map((rule) => rule.to);

test('CLI record switches rules and status lists the detour', () => {
  const root = fixture();
  const result = record(root, passProbe);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(rulesTo(root), ['claude', 'claude']);
  const status = run(root, 'status');
  assert.match(status.stdout, /绕行中/);
  assert.match(status.stdout, /workbuddy\/hy4free/);
});

test('CLI verify with a failing probe keeps the detour, then a passing probe reverts', () => {
  const root = fixture();
  record(root, passProbe);
  // 先换成失败探测：直接改 detours.json 里的探测命令
  const file = path.join(root, 'detours.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.detours[0].probe.command = [process.execPath, '-e', 'process.exit(1)'];
  raw.detours[0].lastProbeAt = null;
  writeFileSync(file, JSON.stringify(raw, null, 2));
  const fail = run(root, 'verify');
  assert.equal(fail.status, 0, fail.stderr);
  assert.match(fail.stdout, /未通过，继续绕行/);
  assert.deepEqual(rulesTo(root), ['claude', 'claude']);
  // 第二次 verify 前再清一次冷却，模拟下一轮核实窗口
  const raw2 = JSON.parse(readFileSync(file, 'utf8'));
  raw2.detours[0].lastProbeAt = null;
  raw2.detours[0].probe.command = JSON.parse(passProbe);
  writeFileSync(file, JSON.stringify(raw2, null, 2));
  const ok = run(root, 'verify');
  assert.match(ok.stdout, /通过，已回归/);
  assert.deepEqual(rulesTo(root), ['workbuddy', 'workbuddy']);
  const again = run(root, 'revert', '--id', 'c1');
  assert.match(again.stdout, /无需重复操作/);
});

test('CLI record rejects a malformed --probe with a clean error', () => {
  const root = fixture();
  const result = record(root, "['/bin/true']");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--probe 要是 JSON 数组/);
  assert.deepEqual(rulesTo(root), ['workbuddy', 'workbuddy']); // 规则未被改动
});

// ---- 定时探针批量核实入口 verify-all 与退出码约定 ----
function clearCooldown(root) {
  const file = path.join(root, 'detours.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  for (const detour of raw.detours) detour.lastProbeAt = null;
  writeFileSync(file, JSON.stringify(raw, null, 2));
}

test('verify-all reverts all due detours and exits 0 when probes pass', () => {
  const root = fixture();
  record(root, passProbe);
  clearCooldown(root);
  const result = run(root, 'verify-all');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /通过，已回归/);
  assert.deepEqual(rulesTo(root), ['workbuddy', 'workbuddy']);
});

test('verify-all exits 1 when a due probe fails but keeps the detour', () => {
  const root = fixture();
  record(root, failProbe);
  clearCooldown(root);
  const result = run(root, 'verify-all');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /未通过，继续绕行/);
  assert.deepEqual(rulesTo(root), ['claude', 'claude']);
});

// 2026-11-24/25 事故回归：codebuddy/ACP 被拒时把「429 额度已用尽」打到输出但退出码仍是 0，
// 只看退出码会把永久拒答误判为已恢复，绕行被自动回归后真实派发再次 refusal。
test('verify-all treats exit-0 refusal output as a failed probe', () => {
  const root = fixture();
  const refusalExit0 = '["' + process.execPath + '", "-e", "console.log(String.fromCharCode(39069,24230,24050,29992,23613)); process.exit(0)"]';
  record(root, refusalExit0);
  clearCooldown(root);
  const result = run(root, 'verify-all');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /未通过，继续绕行/);
  assert.deepEqual(rulesTo(root), ['claude', 'claude']);
});

test('verify-all exits 0 with a clear message when nothing is due', () => {
  const root = fixture();
  const result = run(root, 'verify-all');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /没有到期的绕行要核实/);
});

test('verify-all --json emits a machine-readable summary', () => {
  const root = fixture();
  record(root, passProbe);
  clearCooldown(root);
  const result = run(root, 'verify-all', '--json');
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.due, 1);
  assert.equal(summary.ok, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.exitCode, 0);
});

test('verify-all rejects an illegal timeout with exit code 2', () => {
  const root = fixture();
  record(root, passProbe);
  clearCooldown(root);
  const result = run(root, 'verify-all', '--timeout', '5');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--timeout/);
});
