// WIP 精确保留（refs/dag-wip）与 slot-release 还原：含新文件可找回，不丢改动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { createSlotRuntime } from '../src/dag-slots.mjs';
import { saveWip, releaseSlotWorktree, wipRef } from '../src/dag-wip.mjs';
import { makeRepo, sh } from './helpers-git.mjs';

const boot = async () => {
  const { project } = makeRepo();
  const rt = createSlotRuntime({ project, runId: 'run1' });
  await rt.ensureSlots();
  await rt.prepare({ slot: 1, nodeId: 'a', branch: 'feat/a', base: 'main' });
  const dir = rt.slotPath(1);
  writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  writeFileSync(path.join(dir, 'new-file.txt'), 'brand new\n');
  return { project, rt, dir };
};

test('saveWip 保存含新文件的完整 WIP，不改动槽位工作区，ref 精确可找回', async () => {
  const { project, rt, dir } = await boot();
  const ref = await saveWip(rt, { slot: 1, nodeId: 'a', attempt: 2 });
  assert.equal(ref, wipRef('run1', 'a', 2));
  assert.match(ref, /^refs\/dag-wip\/run1\/a\/2$/);
  assert.equal(readFileSync(path.join(dir, 'new-file.txt'), 'utf8'), 'brand new\n'); // 保存不动工作区
  assert.equal(sh(project, 'show', `${ref}:new-file.txt`), 'brand new');
  assert.equal(sh(project, 'show', `${ref}:README.md`), 'changed');
  assert.equal(sh(project, 'rev-parse', `${ref}^`), sh(dir, 'rev-parse', 'HEAD'));
  // 不污染真实索引/分支历史
  assert.match(sh(dir, 'status', '--porcelain'), /new-file\.txt/);
});

test('saveWip 对干净槽位返回 null 且不建 ref', async () => {
  const { project, rt, dir } = await boot();
  sh(dir, 'checkout', '-q', '--', '.'); sh(dir, 'clean', '-fdq');
  assert.equal(await saveWip(rt, { slot: 1, nodeId: 'a', attempt: 1 }), null);
  assert.equal(sh(project, 'for-each-ref', 'refs/dag-wip'), '');
});

test('releaseSlotWorktree：先存 WIP，核验后还原并清理；新文件仍可从 ref 找回', async () => {
  const { project, rt, dir } = await boot();
  const out = await releaseSlotWorktree(rt, { slot: 1, nodeId: 'a', attempt: 1 });
  assert.match(out.wipRef, /dag-wip/);
  assert.equal(sh(dir, 'status', '--porcelain'), '');
  assert.ok(!existsSync(path.join(dir, 'new-file.txt')));
  assert.equal(sh(project, 'show', `${out.wipRef}:new-file.txt`), 'brand new');
  assert.equal(rt.loadState()[1], undefined); // 槽位已释放
  // 释放后另一节点可 prepare
  await rt.prepare({ slot: 1, nodeId: 'b', branch: 'feat/b', base: 'main' });
});

test('releaseSlotWorktree 在 WIP 保存失败时不清理工作区（fail closed）', async () => {
  const { rt, dir } = await boot();
  const broken = { ...rt, git: async (cwd, args, o) => { if (args[0] === 'update-ref') throw new Error('boom'); return rt.git(cwd, args, o); } };
  await assert.rejects(releaseSlotWorktree(broken, { slot: 1, nodeId: 'a', attempt: 1 }), /boom|失败/);
  assert.equal(readFileSync(path.join(dir, 'new-file.txt'), 'utf8'), 'brand new\n');
});

test('saveWip does not execute Git clean filters configured by worker', async () => {
  const { rt, dir } = await boot();
  const marker = path.join(tmpdir(), `wip-filter-${process.pid}.txt`);
  const script = path.join(tmpdir(), `wip-filter-${process.pid}.sh`);
  writeFileSync(script, `#!/bin/sh\nprintf 'filter-ran\\n' > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  mkdirSync(path.join(rt.project, '.git', 'info'), { recursive: true });
  writeFileSync(path.join(rt.project, '.git', 'info', 'attributes'), '*.txt filter=bad\n');
  sh(rt.project, 'config', 'filter.bad.clean', script);
  try {
    const ref = await saveWip(rt, { slot: 1, nodeId: 'a', attempt: 1 });
    assert.ok(ref);
    assert.equal(existsSync(marker), false, 'WIP 不得执行 clean filter');
  } finally { rmSync(marker, { force: true }); rmSync(script, { force: true }); }
});

test('slot restore does not execute Git smudge filters', async () => {
  const { rt, dir } = await boot();
  const marker = path.join(tmpdir(), `restore-smudge-${process.pid}.txt`);
  const script = path.join(tmpdir(), `restore-smudge-${process.pid}.sh`);
  writeFileSync(script, `#!/bin/sh\nprintf 'smudge-ran\\n' > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  mkdirSync(path.join(rt.project, '.git', 'info'), { recursive: true });
  writeFileSync(path.join(rt.project, '.git', 'info', 'attributes'), '*.md filter=bad\n');
  sh(rt.project, 'config', 'filter.bad.smudge', script);
  try {
    writeFileSync(path.join(dir, 'README.md'), 'changed\n');
    await releaseSlotWorktree(rt, { slot: 1, nodeId: 'a', attempt: 1 });
    assert.equal(existsSync(marker), false, 'restore 不得执行 smudge filter');
  } finally { rmSync(marker, { force: true }); rmSync(script, { force: true }); }
});
