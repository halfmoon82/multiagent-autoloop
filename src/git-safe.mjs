// 控制器侧安全 Git：禁 hooks/fsmonitor/untrackedCache/external diff/textconv，
// 并提供无 clean filter 的工作区树构造。不要在不可信 worktree 上执行 git add。
import { execFile } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const GIT_HARDENING = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
const ALLOWED_ENV = new Set([
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'GIT_TERMINAL_PROMPT', 'NODE_OPTIONS',
  'GIT_INDEX_FILE', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
]);

export function hardenedGitArgs(args = []) {
  const command = args[0];
  const rest = command === 'diff' ? ['--no-ext-diff', '--no-textconv', ...args.slice(1)] : args.slice(1);
  return [...GIT_HARDENING, command, ...rest];
}

export function sanitizedGitEnv(env = {}) {
  const clean = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || tmpdir(), TMPDIR: process.env.TMPDIR || tmpdir(),
    LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, GIT_TERMINAL_PROMPT: '0', NODE_OPTIONS: '',
  };
  for (const key of ALLOWED_ENV) if (env[key] !== undefined) clean[key] = env[key];
  return clean;
}

export const defaultGit = async (cwd, args, { env = {} } = {}) => {
  const { stdout } = await execFileAsync('git', hardenedGitArgs(args), { cwd, env: sanitizedGitEnv(env), timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

export function createGitRunner({ env = {} } = {}) {
  const defaults = sanitizedGitEnv(env);
  return async (cwd, args, extraEnv = {}) => {
    const { stdout } = await execFileAsync('git', hardenedGitArgs(args), { cwd, env: { ...defaults, ...sanitizedGitEnv({ ...env, ...extraEnv }) }, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  };
}

const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
export function parseStatusEntries(output = '') {
  const parts = String(output).split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const file = parts[i].slice(3);
    if ((code[0] === 'R' || code[1] === 'R') && i + 1 < parts.length) {
      const oldFile = parts[++i];
      entries.push({ file, deleted: false });
      entries.push({ file: oldFile, deleted: true });
      continue;
    }
    entries.push({ file, deleted: code.includes('D') });
  }
  return entries;
}

/** 从 worktree 状态构造 Git tree，不执行 git add，因此不会触发 clean filter。 */
export async function buildWorktreeTree({ git, cwd, base = 'HEAD' } = {}) {
  const root = path.resolve(cwd);
  const status = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const entries = parseStatusEntries(status);
  const dir = mkdtempSync(path.join(tmpdir(), 'dag-safe-index-'));
  const index = path.join(dir, 'index');
  try {
    await git(cwd, ['read-tree', base], { GIT_INDEX_FILE: index });
    for (const entry of entries) {
      if (entry.deleted) {
        await git(cwd, ['update-index', '--force-remove', '--', entry.file], { GIT_INDEX_FILE: index });
        continue;
      }
      const file = path.resolve(root, entry.file);
      if (!inside(root, file)) throw new Error(`工作区路径逃逸：${entry.file}`);
      const stat = lstatSync(file);
      if (!stat.isFile()) throw new Error(`暂不支持该工作区文件类型：${entry.file}`);
      const mode = (stat.mode & 0o111) ? '100755' : '100644';
      const blob = String(await git(cwd, ['hash-object', '-w', '--no-filters', '--', entry.file], { GIT_INDEX_FILE: index })).trim();
      await git(cwd, ['update-index', '--add', '--cacheinfo', mode, blob, entry.file], { GIT_INDEX_FILE: index });
    }
    const tree = String(await git(cwd, ['write-tree'], { GIT_INDEX_FILE: index })).trim();
    return { tree, entries };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 用 ls-tree + cat-file blob 恢复工作区；不执行 checkout/restore/archive 的 smudge filter。 */
export async function restoreWorktree({ git = defaultGit, cwd, commit = 'HEAD' } = {}) {
  const root = path.resolve(cwd);
  const rawTree = String(await git(root, ['ls-tree', '-r', '-z', commit]));
  const entries = rawTree.split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new Error(`无效 ls-tree 条目：${entry.slice(0, 80)}`);
    const [mode, type, sha] = entry.slice(0, tab).split(' ');
    const file = entry.slice(tab + 1);
    return { mode, type, sha, file };
  });
  await git(root, ['read-tree', commit]);
  for (const entry of readdirSync(root)) {
    if (entry === '.git') continue;
    rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  for (const entry of entries) {
    const file = path.resolve(root, entry.file);
    if (!inside(root, file)) throw new Error(`恢复路径逃逸：${entry.file}`);
    if (entry.type !== 'blob') throw new Error(`暂不支持恢复非 blob 对象：${entry.file}`);
    const { stdout } = await execFileAsync('git', hardenedGitArgs(['cat-file', 'blob', entry.sha]), {
      cwd: root, env: sanitizedGitEnv(), timeout: 60000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer',
    });
    mkdirSync(path.dirname(file), { recursive: true });
    if (entry.mode === '120000') symlinkSync(stdout.toString('utf8'), file);
    else writeFileSync(file, stdout);
    if (entry.mode === '100755') chmodSync(file, 0o755);
  }
}
