// DAG 槽位共享依赖与收尾回收（2026-11-20：worker 各自 npm ci，每槽位 395MB；结束的 DAG 槽位从不回收）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSlotRuntime } from '../src/dag-slots.mjs';
import { makeRepo, sh } from './helpers-git.mjs';

function fixture({ lockfile = true, deps = true } = {}) {
  const { project } = makeRepo();
  if (lockfile) {
    writeFileSync(path.join(project, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
    writeFileSync(path.join(project, '.gitignore'), '.worktrees/\nnode_modules/\n');
    sh(project, 'add', '-A'); sh(project, 'commit', '-qm', 'lock');
  }
  const source = mkdtempSync(path.join(tmpdir(), 'dag-deps-src-'));
  if (deps) { mkdirSync(path.join(source, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(path.join(source, 'node_modules', 'pkg', 'index.js'), 'x'); }
  return { project, source };
}

test('prepare 把共享依赖软链进槽位，槽位保持干净；已有软链幂等', async () => {
  const { project, source } = fixture();
  const rt = createSlotRuntime({ project, runId: 'r1', depsSource: source });
  await rt.ensureSlots();
  const prepared = await rt.prepare({ slot: 1, nodeId: 'a', branch: 'dag/a', base: 'HEAD' });
  const link = path.join(rt.slotPath(1), 'node_modules');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), path.join(source, 'node_modules'));
  assert.equal(prepared.sharedDeps, 'linked');
  assert.equal(await rt.dirty(1), false, '软链不得让槽位变脏');
  assert.equal((await rt.prepare({ slot: 1, nodeId: 'a', branch: 'dag/a', base: 'HEAD' })).reused, true);
  assert.ok(lstatSync(link).isSymbolicLink());
});

test('换节点 prepare 会清空槽位（含上一节点 worker 自装的 node_modules），之后重新软链共享依赖而不是让 worker 重装', async () => {
  const { project, source } = fixture();
  const rt = createSlotRuntime({ project, runId: 'r1', depsSource: source });
  await rt.ensureSlots();
  await rt.prepare({ slot: 2, nodeId: 'a', branch: 'dag/a', base: 'HEAD' });
  const link = path.join(rt.slotPath(2), 'node_modules');
  rmSync(link);
  mkdirSync(path.join(link, 'mine'), { recursive: true });   // 模拟上一节点 worker 自己 npm ci
  writeFileSync(path.join(link, 'mine', 'index.js'), 'x');
  const prepared = await rt.prepare({ slot: 2, nodeId: 'b', branch: 'dag/b', base: 'HEAD' });
  assert.equal(prepared.sharedDeps, 'linked');
  assert.ok(lstatSync(link).isSymbolicLink(), '换节点后槽位拿到共享依赖软链');
  assert.ok(existsSync(path.join(source, 'node_modules', 'pkg', 'index.js')), '清空槽位不会删到共享依赖源');
});

test('没有锁文件、没有共享源或源不存在时不建软链', async () => {
  for (const [options, reason] of [[{ lockfile: false }, 'no-lockfile'], [{ deps: false }, 'no-source']]) {
    const { project, source } = fixture(options);
    const rt = createSlotRuntime({ project, runId: 'r1', depsSource: source });
    await rt.ensureSlots();
    const prepared = await rt.prepare({ slot: 1, nodeId: 'a', branch: 'dag/a', base: 'HEAD' });
    assert.equal(prepared.sharedDeps, reason);
    assert.ok(!existsSync(path.join(rt.slotPath(1), 'node_modules')));
  }
  const { project } = fixture();
  const rt = createSlotRuntime({ project, runId: 'r1' });
  await rt.ensureSlots();
  assert.equal((await rt.prepare({ slot: 1, nodeId: 'a', branch: 'dag/a', base: 'HEAD' })).sharedDeps, 'no-source');
});

test('removeSlots：DAG 收尾回收全部槽位 worktree 与槽位状态；有未保存改动的槽位保留并报告', async () => {
  const { project, source } = fixture();
  const rt = createSlotRuntime({ project, runId: 'r1', depsSource: source });
  await rt.ensureSlots();
  await rt.prepare({ slot: 1, nodeId: 'a', branch: 'dag/a', base: 'HEAD' });
  writeFileSync(path.join(rt.slotPath(3), 'unsaved.txt'), 'wip');
  const result = await rt.removeSlots();
  assert.deepEqual(result.kept, [3]);
  assert.deepEqual(result.removed, [1, 2, 4, 5]);
  for (const slot of [1, 2, 4, 5]) assert.ok(!existsSync(rt.slotPath(slot)));
  assert.ok(existsSync(path.join(rt.slotPath(3), 'unsaved.txt')), '脏槽位不删');
  assert.ok(existsSync(path.join(source, 'node_modules', 'pkg', 'index.js')), '回收不得删到共享源');
  assert.equal(sh(project, 'worktree', 'list').trim().split('\n').length, 2, '只剩主 checkout 与脏槽位');
  assert.ok(existsSync(path.join(rt.gitDir, 'dag-r1-slots.json')), '仍有脏槽位时保留状态文件');
  rmSync(path.join(rt.slotPath(3), 'unsaved.txt'));
  const again = await rt.removeSlots();
  assert.deepEqual(again.removed, [3]);
  assert.ok(!existsSync(path.join(rt.gitDir, 'dag-r1-slots.json')), '全部回收后删除状态文件');
});

test('removeSlots 对已不存在的槽位幂等，不碰其他 DAG 的槽位', async () => {
  const { project, source } = fixture();
  const a = createSlotRuntime({ project, runId: 'ra', depsSource: source });
  const b = createSlotRuntime({ project, runId: 'rb', depsSource: source });
  await a.ensureSlots(); await b.ensureSlots();
  await a.removeSlots();
  assert.deepEqual((await a.removeSlots()).removed, []);
  for (let slot = 1; slot <= 5; slot++) assert.ok(existsSync(b.slotPath(slot)));
});

test('startDagControllers：已终结的 DAG 回收槽位，每条 run 只回收一次；未终结的不动', async () => {
  const { startDagControllers } = await import('../src/dag-runtime.mjs');
  const calls = [];
  const runs = [
    { runId: 'done-1', nodeId: '__root__', status: 'done', mirrorPath: '/m' },
    { runId: 'nomirror', nodeId: '__root__', status: 'cancelled' },
  ];
  const store = { directory: mkdtempSync(path.join(tmpdir(), 'dag-prune-')), listRuns: () => runs };
  const logs = [];
  const mgr = startDagControllers({
    config: { root: store.directory }, store, intervalMs: 1, log: line => logs.push(line),
    build: async () => { throw new Error('不应为已终结 run 建控制器'); },
    removeSlots: async run => { calls.push(run.runId); return { removed: [1, 2], kept: [3] }; },
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn() {},
  });
  await mgr.tick?.(); await mgr.tick?.();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['done-1'], '只回收有 mirror 的已终结 run，且只一次');
  assert.ok(logs.some(line => line.includes('done-1') && line.includes('保留有未保存改动的槽位 3')));
  mgr.stop?.();
});
