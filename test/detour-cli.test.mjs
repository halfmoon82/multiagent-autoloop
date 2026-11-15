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
