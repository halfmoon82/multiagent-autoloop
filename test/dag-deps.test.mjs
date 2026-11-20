// 共享依赖缓存：按锁文件内容装一份、后台安装原子启用、失败冷却，并与槽位 prepare 联动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSharedDeps, lockDigest, FAILURE_COOLDOWN_MS } from '../src/dag-deps.mjs';
import { createSlotRuntime } from '../src/dag-slots.mjs';
import { makeRepo, sh } from './helpers-git.mjs';

const fakeInstall = calls => async ({ dir }) => {
  calls.push(dir);
  mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
};
const inputs = { packageText: '{"name":"p"}', lockText: '{"lockfileVersion":3,"packages":{"a":1}}' };

test('未就绪返回 null 并在后台安装；装好后返回按锁文件摘要命名的目录；并发只装一次', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dag-deps-'));
  const calls = [];
  const deps = createSharedDeps({ root, install: fakeInstall(calls) });
  assert.equal(deps.resolve(inputs), null);
  assert.equal(deps.resolve(inputs), null, '安装中不重复触发');
  await Promise.all(deps.pending.values());
  assert.equal(calls.length, 1);
  const dir = deps.resolve(inputs);
  assert.equal(dir, path.join(root, 'dag-deps', lockDigest(inputs.lockText)));
  assert.ok(existsSync(path.join(dir, 'node_modules', 'pkg', 'index.js')));
  assert.deepEqual(readdirSync(path.join(root, 'dag-deps')).filter(name => name.startsWith('.tmp-')), [], '临时目录不残留');
});

test('锁文件不同各装一份；安装失败不缓存、冷却期内不重试、过冷却再试', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dag-deps-'));
  let clock = 1000; let fail = true; const calls = [];
  const install = async ({ dir }) => { calls.push(dir); if (fail) throw new Error('网络断开'); await fakeInstall([])({ dir }); };
  const deps = createSharedDeps({ root, install, now: () => clock });
  deps.resolve(inputs); await Promise.all(deps.pending.values());
  assert.equal(deps.resolve(inputs), null);
  assert.equal(calls.length, 1, '冷却期内不重试');
  assert.ok(!existsSync(path.join(root, 'dag-deps', lockDigest(inputs.lockText))));
  clock += FAILURE_COOLDOWN_MS + 1; fail = false;
  deps.resolve(inputs); await Promise.all(deps.pending.values());
  assert.ok(deps.resolve(inputs));
  const other = { ...inputs, lockText: '{"lockfileVersion":3,"packages":{"b":2}}' };
  deps.resolve(other); await Promise.all(deps.pending.values());
  assert.notEqual(deps.resolve(other), deps.resolve(inputs));
});

test('槽位 prepare 用共享缓存：首次未就绪不建软链，就绪后换节点即软链到缓存', async () => {
  const { project } = makeRepo();
  writeFileSync(path.join(project, 'package.json'), inputs.packageText);
  writeFileSync(path.join(project, 'package-lock.json'), inputs.lockText);
  sh(project, 'add', '-A'); sh(project, 'commit', '-qm', 'deps');
  const root = mkdtempSync(path.join(tmpdir(), 'dag-deps-'));
  const deps = createSharedDeps({ root, install: fakeInstall([]) });
  const rt = createSlotRuntime({ project, runId: 'r1', depsSource: deps.resolve });
  await rt.ensureSlots();
  assert.equal((await rt.prepare({ slot: 1, nodeId: 'a', branch: 'dag/a', base: 'HEAD' })).sharedDeps, 'no-source');
  await Promise.all(deps.pending.values());
  assert.equal((await rt.prepare({ slot: 1, nodeId: 'b', branch: 'dag/b', base: 'HEAD' })).sharedDeps, 'linked');
  const link = path.join(rt.slotPath(1), 'node_modules');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), path.join(root, 'dag-deps', lockDigest(inputs.lockText), 'node_modules'));
  assert.equal(await rt.dirty(1), false);
});
