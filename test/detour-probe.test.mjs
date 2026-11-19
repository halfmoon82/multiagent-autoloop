// detour-probe.mjs 单测：拼探测命令与 CLI 退出码语义。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { probeCommand } from '../scripts/detour-probe.mjs';

const CLI = decodeURIComponent(new URL('../scripts/detour-probe.mjs', import.meta.url).pathname);

test('acp agent 去掉 --acp，追加 -p ping 与 --model', () => {
  const command = probeCommand({
    use: 'acp',
    command: ['/pilot/bin/workbuddy-ai-acp.sh', '--acp', '--model', 'hy4flash-free'],
  });
  assert.deepEqual(command, ['/pilot/bin/workbuddy-ai-acp.sh', '--model', 'hy4flash-free', '-p', '只回复ok两个字母']);
});

test('claude program 追加 -p ping 与 --model', () => {
  const command = probeCommand({ use: 'claude', program: '/pilot/bin/claude-real-home.sh', model: 'opus' });
  assert.deepEqual(command, ['/pilot/bin/claude-real-home.sh', '-p', '只回复ok两个字母', '--model', 'opus']);
});

test('codex program 用 exec 子命令', () => {
  const command = probeCommand({ use: 'codex', program: '/pilot/bin/codex-pilot.sh', model: 'deepseek-v4.1-flash' });
  assert.deepEqual(command, ['/pilot/bin/codex-pilot.sh', 'exec', '只回复ok两个字母', '--model', 'deepseek-v4.1-flash']);
});

test('command/program/未知 use 返回 null', () => {
  assert.equal(probeCommand(null), null);
  assert.equal(probeCommand({ use: 'command', command: ['/bin/echo'] }), null);
  assert.equal(probeCommand({ use: 'claude' }), null);
});

test('CLI：agent 不存在退出 1，未知 agent id 提示', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'probe-'));
  const rulesFile = path.join(dir, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ agents: {} }));
  const result = spawnSync(process.execPath, [CLI, 'missing', '--rules-file', rulesFile], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /没有可探测的 Agent/);
});
