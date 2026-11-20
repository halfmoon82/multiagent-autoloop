import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
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
  mkdirSync(path.join(root, '.hidden-dir'), { recursive: true });
  writeFileSync(path.join(root, '.hidden-dir', 'secret.md'), '# 秘密\n');
  writeFileSync(path.join(root, '.dotfile.md'), '# 点文件\n');
  return root;
}

test('listArtifacts finds md/html files within depth, excluding VCS/dependency/worktree dirs', () => {
  const root = fixture();
  const files = listArtifacts(root);
  const names = files.map(file => file.path).sort();
  assert.deepEqual(names, ['README.md', 'docs/dashboard.html', 'docs/report.md']);
  assert.ok(files.every(file => typeof file.size === 'number' && typeof file.at === 'string'));
});

test('listArtifacts with since keeps only files touched after session start, newest first', () => {
  const root = fixture();
  const old = new Date('2026-01-01T00:00:00Z');
  for (const rel of ['README.md', 'docs/report.md', 'docs/dashboard.html']) utimesSync(path.join(root, rel), old, old);
  writeFileSync(path.join(root, 'docs', 'session-plan.md'), '# 本会话计划\n');
  writeFileSync(path.join(root, 'summary.html'), '<p>本会话总结</p>');
  utimesSync(path.join(root, 'docs', 'session-plan.md'), new Date('2026-11-19T03:00:00Z'), new Date('2026-11-19T03:00:00Z'));
  utimesSync(path.join(root, 'summary.html'), new Date('2026-11-19T04:00:00Z'), new Date('2026-11-19T04:00:00Z'));
  const files = listArtifacts(root, { since: '2026-11-19T02:00:00.000Z' });
  assert.deepEqual(files.map(file => file.path), ['summary.html', 'docs/session-plan.md']);
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

import { resolveDownload, DOWNLOAD_EXTENSIONS, MAX_DOWNLOAD_BYTES } from '../src/artifacts.mjs';

function binFixture() {
  const root = fixture();
  mkdirSync(path.join(root, 'work', 'apk'), { recursive: true });
  writeFileSync(path.join(root, 'work', 'apk', 'app.apk'), Buffer.from([0x50, 0x4b, 3, 4]));
  writeFileSync(path.join(root, 'work', 'apk', 'app.apk.sha256'), 'abc  app.apk\n');
  writeFileSync(path.join(root, 'docs', 'shot.png'), Buffer.from([0x89, 0x50]));
  return root;
}

test('listArtifacts 默认只列文档（手机产物页口径不变），includeFiles 才带二进制交付物并标 kind', () => {
  const root = binFixture();
  assert.ok(listArtifacts(root).every(file => /\.(md|html)$/.test(file.path)), '默认口径不得出现 apk/png');
  const files = listArtifacts(root, { includeFiles: true });
  const byPath = Object.fromEntries(files.map(file => [file.path, file.kind]));
  assert.equal(byPath['work/apk/app.apk'], 'file');
  assert.equal(byPath['docs/shot.png'], 'file');
  assert.equal(byPath['docs/report.md'], 'doc');
  assert.equal(byPath['work/apk/app.apk.sha256'], undefined, '.sha256 不是交付物类型');
  assert.equal(byPath['docs/deep.txt'], undefined, 'txt 仍不算产物');
});

test('resolveDownload 返回真实路径与大小，拒绝越界、符号链接逃逸、未知类型、过大文件', () => {
  const root = binFixture();
  const ok = resolveDownload(root, 'work/apk/app.apk');
  assert.equal(ok.name, 'app.apk');
  assert.equal(ok.size, 4);
  assert.throws(() => resolveDownload(root, '../outside.apk'), /越界/);
  assert.throws(() => resolveDownload(root, '/etc/hosts'), /越界/);
  assert.throws(() => resolveDownload(root, 'docs/deep.txt'), /不支持/);
  assert.throws(() => resolveDownload(root, 'missing.apk'), /不存在/);
  symlinkSync('/bin/ls', path.join(root, 'work', 'evil.apk'));
  assert.throws(() => resolveDownload(root, 'work/evil.apk'), /越界/);
  assert.throws(() => resolveDownload(root, 'work/apk/app.apk', { maxBytes: 3 }), /过大/);
  assert.ok(DOWNLOAD_EXTENSIONS.has('.apk') && MAX_DOWNLOAD_BYTES >= 100 * 1024 * 1024);
});
