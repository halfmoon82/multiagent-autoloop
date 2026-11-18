// 固定槽位运行时：槽位=worktree、沙箱拒绝越界写、同节点保留改动、WIP 精确保留与新文件找回。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSlotRuntime, defaultGit, SlotError } from '../src/dag-slots.mjs';
import { makeRepo, sh } from './helpers-git.mjs';

const boot = async () => {
  const { project } = makeRepo();
  const rt = createSlotRuntime({ project, runId: 'run1' });
  await rt.ensureSlots();
  return { project, rt };
};

test('ensureSlots 建 5 个 .worktrees/dag-<runId>-slot-n，slot 仅 1-5，幂等', async () => {
  const { project, rt } = await boot();
  for (let n = 1; n <= 5; n++) assert.ok(existsSync(path.join(project, '.worktrees', `dag-run1-slot-${n}`, 'README.md')));
  await rt.ensureSlots();
  assert.equal(sh(project, 'worktree', 'list').split('\n').length, 6);
  for (const bad of [0, 6, 1.5, '2']) assert.throws(() => rt.slotPath(bad), SlotError);
});

test('沙箱：写主 checkout 与兄弟槽位被拒，写本槽位允许，符号链接逃逸被拒', async () => {
  const { project, rt } = await boot();
  const own = path.join(rt.slotPath(1), 'a.txt');
  assert.doesNotThrow(() => rt.writeAs(1, own, 'x'));
  assert.equal(readFileSync(own, 'utf8'), 'x');
  assert.throws(() => rt.writeAs(1, path.join(project, 'evil.txt'), 'x'), /沙箱/);
  assert.throws(() => rt.writeAs(1, path.join(rt.slotPath(2), 'evil.txt'), 'x'), /沙箱/);
  assert.throws(() => rt.writeAs(1, path.join(rt.slotPath(1), '..', 'dag-run1-slot-2', 'e.txt'), 'x'), /沙箱/);
  assert.ok(!existsSync(path.join(project, 'evil.txt')));
  const { symlinkSync } = await import('node:fs');
  symlinkSync(project, path.join(rt.slotPath(1), 'link'));
  assert.throws(() => rt.writeAs(1, path.join(rt.slotPath(1), 'link', 'evil.txt'), 'x'), /沙箱/);
});

test('prepare：节点分支从基线创建；同节点重试保留未提交改动；换节点遇脏槽位阻塞', async () => {
  const { rt } = await boot();
  await rt.prepare({ slot: 1, nodeId: 'a', branch: 'feat/a', base: 'origin/main' });
  rt.writeAs(1, path.join(rt.slotPath(1), 'work.txt'), 'wip');
  await rt.prepare({ slot: 1, nodeId: 'a', branch: 'feat/a', base: 'origin/main' }); // 同节点重派
  assert.equal(readFileSync(path.join(rt.slotPath(1), 'work.txt'), 'utf8'), 'wip');
  await assert.rejects(rt.prepare({ slot: 1, nodeId: 'b', branch: 'feat/b', base: 'origin/main' }), /脏/);
});

test('prepare 基线核对：基线 ref 不存在时拒绝', async () => {
  const { rt } = await boot();
  await assert.rejects(rt.prepare({ slot: 2, nodeId: 'a', branch: 'feat/a', base: 'origin/nope' }), /基线/);
});

test('defaultGit disables repository hooks and does not inherit controller-only environment', async () => {
  const { project } = makeRepo();
  const hook = path.join(project, '.git', 'hooks', 'post-checkout');
  const marker = path.join(tmpdir(), `default-git-hook-${process.pid}.txt`);
  mkdirSync(path.dirname(hook), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\nprintf 'hook-ran-with-env:%s\\n' "$AGENT_AUTOLOOP_HOME" > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const target = path.join(project, '.worktrees', 'default-git-hook-test');
  const previous = process.env.AGENT_AUTOLOOP_HOME;
  process.env.AGENT_AUTOLOOP_HOME = 'controller-secret';
  try {
    await defaultGit(project, ['worktree', 'add', '--detach', target, 'HEAD']);
    assert.equal(existsSync(marker), false, 'defaultGit 不得执行仓库 hooks');
  } finally {
    if (previous === undefined) delete process.env.AGENT_AUTOLOOP_HOME; else process.env.AGENT_AUTOLOOP_HOME = previous;
    await defaultGit(project, ['worktree', 'remove', '--force', target]).catch(() => {});
    rmSync(marker, { force: true });
  }
});
