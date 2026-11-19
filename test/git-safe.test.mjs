// git-safe：树构造的安全边界——跳过根外依赖软链，但不静默吞掉真实改动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWorktreeTree, defaultGit } from '../src/git-safe.mjs';
import { makeRepo, sh } from './helpers-git.mjs';

const setup = () => {
  const base = makeRepo();
  const cwd = path.join(base.base, 'wt');
  sh(base.project, 'worktree', 'add', '-q', '-b', 'wt-branch', cwd, 'HEAD');
  mkdirSync(path.join(cwd, 'src'), { recursive: true });
  return { ...base, cwd };
};

test('buildWorktreeTree：未跟踪且指向根外的 node_modules 软链跳过，正常文件照常入树', async () => {
  const t = setup();
  try {
    const external = mkdtempSync(path.join(tmpdir(), 'gs-external-nm-'));
    try {
      writeFileSync(path.join(t.cwd, 'src', 'a.mjs'), 'export const a = 1;\n');
      symlinkSync(external, path.join(t.cwd, 'node_modules'), 'dir');
      const result = await buildWorktreeTree({ git: defaultGit, cwd: t.cwd, base: 'HEAD' });
      assert.equal(result.skipped.includes('node_modules'), true, 'skipped 含 node_modules');
      assert.equal(result.entries.find(e => e.file === 'node_modules')?.skipped, true, 'entries 标出 skipped');
      assert.equal(result.entries.find(e => e.file === 'src/a.mjs')?.skipped, undefined, '正常文件未标 skipped');
      assert.match((result.warnings || []).join('\n'), /node_modules/, 'warnings 可汇报');
      const treeFiles = sh(t.cwd, 'ls-tree', '-r', '--name-only', result.tree).split('\n').filter(Boolean);
      assert.equal(treeFiles.includes('src/a.mjs'), true, '正常文件入树');
      assert.equal(treeFiles.includes('node_modules'), false, '树里没有 node_modules');
    } finally { rmSync(external, { recursive: true, force: true }); }
  } finally { rmSync(t.base, { recursive: true, force: true }); }
});

test('buildWorktreeTree：工作区内部软链仍抛错', async () => {
  const t = setup();
  try {
    writeFileSync(path.join(t.cwd, 'src', 'a.mjs'), 'x\n');
    writeFileSync(path.join(t.cwd, 'target.txt'), 'inside\n');
    symlinkSync(path.join(t.cwd, 'target.txt'), path.join(t.cwd, 'link-in'));
    await assert.rejects(buildWorktreeTree({ git: defaultGit, cwd: t.cwd, base: 'HEAD' }), /符号链接|文件类型|暂不支持/);
  } finally { rmSync(t.base, { recursive: true, force: true }); }
});

test('buildWorktreeTree：已跟踪文件改成软链仍抛错，不静默吞掉真实改动', async () => {
  const t = setup();
  try {
    writeFileSync(path.join(t.cwd, 'src', 'a.mjs'), 'x\n');
    sh(t.cwd, 'add', '-A'); sh(t.cwd, 'commit', '-qm', 'init wt');
    const external = mkdtempSync(path.join(tmpdir(), 'gs-external-track-'));
    try {
      rmSync(path.join(t.cwd, 'src', 'a.mjs'));
      symlinkSync(external, path.join(t.cwd, 'src', 'a.mjs'), 'dir');
      await assert.rejects(buildWorktreeTree({ git: defaultGit, cwd: t.cwd, base: 'HEAD' }), /符号链接|文件类型|暂不支持/);
    } finally { rmSync(external, { recursive: true, force: true }); }
  } finally { rmSync(t.base, { recursive: true, force: true }); }
});
