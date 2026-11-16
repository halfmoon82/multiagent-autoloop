import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listArtifacts, readArtifact } from '../src/artifacts.mjs';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'artifacts-'));
  mkdirSync(path.join(root, 'docs', 'nested'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# 项目说明\n');
  writeFileSync(path.join(root, 'docs', 'report.md'), '# 报告\n');
  writeFileSync(path.join(root, 'docs', 'dashboard.html'), '<h1>看板</h1>');
  writeFileSync(path.join(root, 'docs', 'deep.txt'), '不是产物');
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'pkg', 'readme.md'), '# 依赖文档\n');
  mkdirSync(path.join(root, '.worktrees', 'w1'), { recursive: true });
  writeFileSync(path.join(root, '.worktrees', 'w1', 'draft.md'), '# 草稿\n');
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'note.md'), '# git\n');
  mkdirSync(path.join(root, 'd1', 'd2', 'd3'), { recursive: true });
  writeFileSync(path.join(root, 'd1', 'd2', 'd3', 'toodeep.md'), '# 太深\n');
  return root;
}

test('listArtifacts finds md/html files within depth, excluding VCS/dependency/worktree dirs', () => {
  const root = fixture();
  const files = listArtifacts(root);
  const names = files.map(file => file.path).sort();
  assert.deepEqual(names, ['README.md', 'docs/dashboard.html', 'docs/report.md']);
  assert.ok(files.every(file => typeof file.size === 'number' && typeof file.at === 'string'));
});

test('readArtifact reads a file and rejects traversal, absolute escape and unknown extensions', () => {
  const root = fixture();
  const content = readArtifact(root, 'docs/report.md');
  assert.match(content.content, /# 报告/);
  assert.equal(content.name, 'report.md');
  assert.throws(() => readArtifact(root, '../outside.md'), /越界/);
  assert.throws(() => readArtifact(root, '/etc/passwd'), /越界/);
  assert.throws(() => readArtifact(root, 'docs/deep.txt'), /不支持/);
  assert.throws(() => readArtifact(root, 'missing.md'), /不存在/);
  // 符号链接逃逸同样被拒
  symlinkSync('/etc/passwd', path.join(root, 'docs', 'evil.md'));
  assert.throws(() => readArtifact(root, 'docs/evil.md'), /越界/);
});
