// 控制器拥有的项目 mirror：base 与 push 不再读取 worker 可写的项目 .git/config/ref。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createGitRunner } from './git-safe.mjs';

export class DagMirrorError extends Error {
  constructor(message) { super(message); this.name = 'DagMirrorError'; }
}

export function validateRemoteUrl(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  if (!value) throw new DagMirrorError('缺少 remote URL');
  if (value.includes('::') || value.startsWith('ext::')) throw new DagMirrorError('禁止 ext transport');
  if (!value.startsWith('https://') && !value.startsWith('/')) throw new DagMirrorError('remote URL 仅支持 https 或本机绝对路径');
  return value;
}

export async function ensureMirror({ root, remoteUrl, baseBranch = 'main' } = {}) {
  const url = validateRemoteUrl(remoteUrl);
  const branch = String(baseBranch || 'main').replace(/[^a-z0-9._/-]+/gi, '-');
  const id = createHash('sha256').update(`${url}\0${branch}`).digest('hex').slice(0, 24);
  const directory = path.join(root, 'dag-mirrors', id);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const git = createGitRunner({ env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  if (!existsSync(path.join(directory, 'HEAD'))) await git(directory, ['init', '-q', '--bare', '-b', branch]);
  await git(directory, ['fetch', '--quiet', url, `+refs/heads/${branch}:refs/heads/${branch}`]);
  await git(directory, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  const baseCommit = String(await git(directory, ['rev-parse', 'HEAD'])).trim();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(baseCommit)) throw new DagMirrorError('mirror 未取得有效 base commit');
  return { mirrorPath: directory, baseBranch: branch, baseCommit, remoteUrl: url };
}
