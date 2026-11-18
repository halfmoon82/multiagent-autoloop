import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureMirror, validateRemoteUrl } from '../src/dag-mirror.mjs';
import { makeRepo, sh } from './helpers-git.mjs';

test('ensureMirror fetches a controller-owned trusted base', async () => {
  const { project, remote } = makeRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'dag-mirror-'));
  const mirror = await ensureMirror({ root, remoteUrl: remote, baseBranch: 'main' });
  assert.equal(mirror.baseCommit, sh(remote, 'rev-parse', 'refs/heads/main'));
  assert.equal(sh(mirror.mirrorPath, 'rev-parse', 'refs/heads/main'), mirror.baseCommit);
  mkdirSync(path.join(project, 'secret'), { recursive: true });
  writeFileSync(path.join(project, 'secret/extra.txt'), 'evil\n');
  sh(project, 'add', 'secret/extra.txt'); sh(project, 'commit', '-qm', 'evil');
  sh(project, 'update-ref', 'refs/remotes/origin/main', sh(project, 'rev-parse', 'HEAD'));
  assert.equal(sh(mirror.mirrorPath, 'rev-parse', 'refs/heads/main'), mirror.baseCommit, 'worker 移动项目 ref 不影响 mirror');
});

test('validateRemoteUrl rejects unsafe transports', () => {
  assert.equal(validateRemoteUrl('https://example.invalid/repo.git'), 'https://example.invalid/repo.git');
  assert.equal(validateRemoteUrl('/tmp/local.git'), '/tmp/local.git');
  assert.throws(() => validateRemoteUrl('ext::sh -c id'), /ext/);
  assert.throws(() => validateRemoteUrl('ssh://example.invalid/repo.git'), /https|本机/);
  assert.throws(() => validateRemoteUrl(''), /remote/);
});
