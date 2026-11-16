// 测试用真实 git 仓夹具（本地 bare 远端 + 工作仓），离线。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
export function makeRepo() {
  const base = mkdtempSync(path.join(tmpdir(), 'dag-git-'));
  const remote = path.join(base, 'remote.git'); const project = path.join(base, 'proj');
  sh(base, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(base, 'init', '-q', '-b', 'main', project);
  writeFileSync(path.join(project, 'README.md'), 'hi\n');
  writeFileSync(path.join(project, '.gitignore'), '.worktrees/\n');
  sh(project, 'add', '-A'); sh(project, 'commit', '-qm', 'init');
  sh(project, 'remote', 'add', 'origin', remote); sh(project, 'push', '-q', 'origin', 'main');
  return { base, remote, project };
}
