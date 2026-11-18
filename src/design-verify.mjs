// 默认定向设计验证适配器：从精确 commit 建临时只读 worktree，
// 校验 verifier sha256 后在净化子进程执行；控制器进程不导入槽位/项目代码。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { designContractDigest } from './design-baseline.mjs';

const MARKER = '__DESIGN_VERIFY_RESULT__';
const CHILD_TIMEOUT_MS = 5 * 60 * 1000;

export async function verifyDesign({ nodeId, worktree, project, git, commit, designBaseline, contract, evidenceDir } = {}) {
  const verifierPath = designBaseline?.manifest?.verifierPath;
  if (typeof verifierPath !== 'string' || !verifierPath.trim()) throw new Error('UI 设计清单缺少 verifierPath');
  if (!(designBaseline.readOnlyPaths || []).includes(verifierPath)) throw new Error(`设计 verifier 不在只读产物清单：${verifierPath}`);
  if (typeof git !== 'function') throw new Error('设计 verifier 需要 git 运行时');
  if (!String(project ?? '').trim()) throw new Error('设计 verifier 需要 project');
  if (!String(commit ?? '').trim()) throw new Error('设计 verifier 需要 commit');
  if (!String(evidenceDir ?? '').trim()) throw new Error('设计 verifier 需要 evidenceDir');

  const expected = (designBaseline.manifest.artifacts || []).find(artifact => artifact?.path === verifierPath)?.sha256;
  if (!expected) throw new Error(`设计 verifier 缺少 artifacts sha256：${verifierPath}`);

  const worktrees = path.join(project, '.worktrees');
  mkdirSync(worktrees, { recursive: true });
  const source = mkdtempSync(path.join(worktrees, 'design-verify-'));
  const childHome = mkdtempSync(path.join(tmpdir(), 'design-verify-home-'));
  let result = null;
  try {
    await git(project, ['worktree', 'add', '--detach', source, commit]);
    const root = realpathSync(source);
    const file = realpathSync(path.resolve(root, verifierPath));
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error('设计 verifier 逃逸精确 commit worktree');
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== expected) throw new Error(`设计 verifier sha256 摘要不符：${verifierPath}`);

    const payload = {
      nodeId, worktree: source, contract, designBaseline, evidenceDir, commit,
      verifierUrl: pathToFileURL(file).href,
    };
    const script = `
      const payload = ${JSON.stringify(payload)};
      try {
        const module = await import(payload.verifierUrl);
        const result = await module.verify(payload);
        process.stdout.write('\\n${MARKER}' + JSON.stringify(result) + '\\n');
      } catch (error) {
        process.stdout.write('\\n${MARKER}' + JSON.stringify({ __error: String(error?.message || error) }) + '\\n');
        process.exitCode = 1;
      }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: source,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: childHome, TMPDIR: tmpdir(), NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CHILD_TIMEOUT_MS);
    await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve());
    }).finally(() => clearTimeout(timer));
    if (timedOut) throw new Error(`设计 verifier 子进程超时（${CHILD_TIMEOUT_MS}ms）`);
    const line = stdout.split(/\r?\n/).reverse().find(item => item.startsWith(MARKER));
    if (!line) throw new Error(`设计 verifier 未返回结果：${stderr.trim() || stdout.slice(-500)}`);
    result = JSON.parse(line.slice(MARKER.length));
    if (result.__error) throw new Error(`设计 verifier 执行失败：${result.__error}`);
    if (!result || typeof result.ok !== 'boolean' || !Array.isArray(result.checks)) throw new Error('设计 verifier 返回形态无效：需要 ok 与 checks');
  } finally {
    try { await git(project, ['worktree', 'remove', '--force', source]); } catch { /* rmSync 兜底 */ }
    rmSync(source, { recursive: true, force: true });
    rmSync(childHome, { recursive: true, force: true });
  }

  return {
    ok: result.ok,
    evidence: {
      commit, designDigest: designBaseline.designDigest,
      contractDigest: designContractDigest({ designDigest: designBaseline.designDigest, contract }),
      checks: result.checks,
      ...(result.visualDiffs ? { visualDiffs: result.visualDiffs } : {}),
      ...(result.artifacts ? { artifacts: result.artifacts } : {}),
    },
  };
}
