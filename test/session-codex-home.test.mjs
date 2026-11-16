import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SchedulingSessionManager } from '../src/scheduling-session.mjs';
import { prepareSessionCodexHome } from '../src/session-codex-home.mjs';
import { fakeAcp } from './fake-acp.mjs';

const USER_CONFIG = `model = "kimi-for-coding"
model_provider = "kimi"
web_search = "live"
notify = ["/usr/local/bin/some-hook", "turn-ended"]
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.kimi]
name = "Kimi"
base_url = "http://127.0.0.1:15723/coding/v1"
wire_api = "responses"

[mcp_servers.node_repl]
command = "/Applications/x/node_repl"

[projects."/Volumes/Storage/auto调度"]
trust_level = "trusted"

[model_providers.custom]
name = "Kimi"
base_url = "http://127.0.0.1:15723/coding/v1"
`;

function userHome({ config = USER_CONFIG, auth = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'user-codex-'));
  if (config !== null) writeFileSync(path.join(dir, 'config.toml'), config);
  if (auth) writeFileSync(path.join(dir, 'auth.json'), '{"fake":true}');
  return dir;
}
const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), 'console-home-')), 'codex-home');

test('dedicated CODEX_HOME forces approval_policy=on-request even when the user config says never', () => {
  const user = userHome();
  const target = tmp();
  const before = readFileSync(path.join(user, 'config.toml'), 'utf8');
  prepareSessionCodexHome({ targetDir: target, userCodexHome: user });
  const out = readFileSync(path.join(target, 'config.toml'), 'utf8');
  assert.deepEqual(out.match(/^\s*approval_policy\s*=.*$/gm), ['approval_policy = "on-request"']);
  assert.doesNotMatch(out, /never/);
  assert.match(out, /^sandbox_mode = "workspace-write"$/m);
  assert.doesNotMatch(out, /danger-full-access/);
  assert.equal(readFileSync(path.join(user, 'config.toml'), 'utf8'), before, 'user global config must stay untouched');
});

test('dedicated CODEX_HOME inherits model provider config but drops hooks, MCP servers and trust entries', () => {
  const target = tmp();
  prepareSessionCodexHome({ targetDir: target, userCodexHome: userHome() });
  const out = readFileSync(path.join(target, 'config.toml'), 'utf8');
  assert.match(out, /^model = "kimi-for-coding"$/m);
  assert.match(out, /^model_provider = "kimi"$/m);
  assert.match(out, /^web_search = "live"$/m);
  assert.match(out, /\[model_providers\.kimi\]/);
  assert.match(out, /base_url = "http:\/\/127\.0\.0\.1:15723\/coding\/v1"/);
  assert.match(out, /\[model_providers\.custom\]/);
  assert.doesNotMatch(out, /notify/);
  assert.doesNotMatch(out, /mcp_servers/);
  assert.doesNotMatch(out, /trust_level|projects\./);
});

test('dedicated CODEX_HOME links the user auth.json and tolerates a missing user config', () => {
  const user = userHome({ config: null });
  const target = tmp();
  prepareSessionCodexHome({ targetDir: target, userCodexHome: user });
  assert.equal(lstatSync(path.join(target, 'auth.json')).isSymbolicLink(), true);
  assert.equal(readFileSync(path.join(target, 'auth.json'), 'utf8'), '{"fake":true}');
  assert.match(readFileSync(path.join(target, 'config.toml'), 'utf8'), /^approval_policy = "on-request"$/m);
  // 幂等：重复准备不报错、内容稳定
  const first = readFileSync(path.join(target, 'config.toml'), 'utf8');
  prepareSessionCodexHome({ targetDir: target, userCodexHome: user });
  assert.equal(readFileSync(path.join(target, 'config.toml'), 'utf8'), first);
});

test('a tampered dedicated config is rewritten on every preparation (never trusts leftover state)', () => {
  const target = tmp();
  const user = userHome();
  prepareSessionCodexHome({ targetDir: target, userCodexHome: user });
  writeFileSync(path.join(target, 'config.toml'), 'approval_policy = "never"\n');
  prepareSessionCodexHome({ targetDir: target, userCodexHome: user });
  assert.doesNotMatch(readFileSync(path.join(target, 'config.toml'), 'utf8'), /never/);
});

for (const kind of ['normal', 'scheduling', 'design']) {
  test(`${kind} session spawns the adapter with the console-managed CODEX_HOME, overriding any inherited one`, async () => {
    const user = userHome();
    const target = tmp();
    const fake = fakeAcp();
    let seenEnv = null; let configAtSpawn = null;
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = user; // 事故复现：控制台进程环境里带着用户全局 CODEX_HOME
    try {
      const manager = new SchedulingSessionManager({
        cwd: '/workspace/demo', adapterPath: '/fixed/acp.js', codexHomeDir: target, userCodexHome: user,
        spawnFn: (command, args, options) => {
          seenEnv = options.env;
          configAtSpawn = existsSync(path.join(target, 'config.toml')) ? readFileSync(path.join(target, 'config.toml'), 'utf8') : null;
          return fake.child;
        },
      });
      await manager.start({ kind, project: '/workspace/demo', prompt: '开始' });
      assert.equal(seenEnv.CODEX_HOME, target);
      assert.notEqual(seenEnv.CODEX_HOME, user);
      assert.match(configAtSpawn || '', /^approval_policy = "on-request"$/m, 'config must be in place before the adapter process starts');
      manager.dispose();
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    }
  });
}

test('default CODEX_HOME lives under the runtime home (<archiveRoot>/codex-home)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'autoloop-home-'));
  const fake = fakeAcp();
  let seenEnv = null;
  const manager = new SchedulingSessionManager({ cwd: '/workspace/demo', adapterPath: '/fixed/acp.js', archiveRoot: root, userCodexHome: userHome(), spawnFn: (c, a, o) => { seenEnv = o.env; return fake.child; } });
  await manager.start({ kind: 'normal', project: '/workspace/demo', prompt: '开始' });
  assert.equal(seenEnv.CODEX_HOME, path.join(root, 'codex-home'));
  manager.dispose();
});

test('fails closed: when the dedicated home cannot be prepared the adapter is never spawned with the global home', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'blocked-'));
  const blocker = path.join(base, 'file');
  writeFileSync(blocker, 'x');
  let spawned = false;
  const manager = new SchedulingSessionManager({ cwd: '/workspace/demo', adapterPath: '/fixed/acp.js', codexHomeDir: path.join(blocker, 'codex-home'), userCodexHome: userHome(), spawnFn: () => { spawned = true; return fakeAcp().child; } });
  await assert.rejects(() => manager.start({ kind: 'normal', project: '/workspace/demo', prompt: '开始' }), /CODEX_HOME/);
  assert.equal(spawned, false);
  assert.equal(manager.list().length, 0);
  mkdirSync(path.join(base, 'ok'));
});
