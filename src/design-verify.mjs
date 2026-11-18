// 默认定向设计验证适配器：从精确 commit 建临时只读 worktree，
// 校验 verifier sha256 后在净化子进程执行；结果走专用 fd + nonce，不信任 stdout。
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { designContractDigest } from './design-baseline.mjs';

const execFileAsync = promisify(execFile);
const CHILD_TIMEOUT_MS = 5 * 60 * 1000;
const LOG_LIMIT_BYTES = 1024 * 1024;
const RESULT_LIMIT_BYTES = 4 * 1024 * 1024;

class LimitedBuffer {
  constructor(limit, label) { this.limit = limit; this.label = label; this.chunks = []; this.size = 0; this.over = false; }
  push(chunk) {
    if (this.over) return false;
    const buffer = Buffer.from(chunk);
    this.chunks.push(buffer); this.size += buffer.length;
    if (this.size > this.limit) { this.over = true; return false; }
    return true;
  }
  text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

export async function verifyDesign({ nodeId, project, commit, designBaseline, contract, evidenceDir } = {}) {
  const verifierPath = designBaseline?.manifest?.verifierPath;
  if (typeof verifierPath !== 'string' || !verifierPath.trim()) throw new Error('UI 设计清单缺少 verifierPath');
  if (!(designBaseline.readOnlyPaths || []).includes(verifierPath)) throw new Error(`设计 verifier 不在只读产物清单：${verifierPath}`);
  if (!String(project ?? '').trim()) throw new Error('设计 verifier 需要 project');
  if (!String(commit ?? '').trim()) throw new Error('设计 verifier 需要 commit');
  if (!String(evidenceDir ?? '').trim()) throw new Error('设计 verifier 需要 evidenceDir');
  const expected = (designBaseline.manifest.artifacts || []).find(artifact => artifact?.path === verifierPath)?.sha256;
  if (!expected) throw new Error(`设计 verifier 缺少 artifacts sha256：${verifierPath}`);

  const worktrees = path.join(project, '.worktrees');
  mkdirSync(worktrees, { recursive: true });
  const source = mkdtempSync(path.join(worktrees, 'design-verify-'));
  const childHome = mkdtempSync(path.join(tmpdir(), 'design-verify-home-'));
  const childEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: childHome, TMPDIR: tmpdir(),
    NODE_OPTIONS: '', GIT_TERMINAL_PROMPT: '0',
  };
  // Git 操作不继承控制器环境，并显式禁用仓库 hooks，防止 worker 修改 post-checkout 等钩子。
  const safeGit = (cwd, args) => execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env: childEnv, timeout: 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  });

  let result = null;
  try {
    await safeGit(project, ['worktree', 'add', '--detach', source, commit]);
    const root = realpathSync(source);
    const file = realpathSync(path.resolve(root, verifierPath));
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error('设计 verifier 逃逸精确 commit worktree');
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== expected) throw new Error(`设计 verifier sha256 摘要不符：${verifierPath}`);

    const nonce = randomBytes(32).toString('hex');
    const verifierPayload = { nodeId, worktree: source, contract, designBaseline, evidenceDir, commit };
    const payload = { ...verifierPayload, verifierUrl: pathToFileURL(file).href, nonce };
    // payload 只经 stdin 进入子进程；nonce 不进入 execArgv/env，也不传给项目 verifier。
    const script = `
      const readStdin = () => new Promise((resolve, reject) => {
        let text = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { text += chunk; });
        process.stdin.on('end', () => resolve(text));
        process.stdin.on('error', reject);
      });
      const input = await readStdin();
      const parse = JSON.parse;
      const stringify = JSON.stringify;
      const fs = await import('node:fs');
      const writeResult = fs.writeSync;
      const payload = parse(input);
      const verifierPayload = { nodeId: payload.nodeId, worktree: payload.worktree, contract: payload.contract, designBaseline: payload.designBaseline, evidenceDir: payload.evidenceDir, commit: payload.commit };
      try {
        const module = await import(payload.verifierUrl);
        const result = await module.verify(verifierPayload);
        writeResult(3, stringify({ nonce: payload.nonce, result }) + '\\n');
      } catch (error) {
        writeResult(3, stringify({ nonce: payload.nonce, result: { __error: String(error?.message || error) } }) + '\\n');
        process.exitCode = 1;
      }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: source, env: childEnv, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => {}); // 子进程提前退出时避免 EPIPE 掩盖真实错误
    child.stdin.end(JSON.stringify(payload));
    const stdout = new LimitedBuffer(LOG_LIMIT_BYTES, 'stdout');
    const stderr = new LimitedBuffer(LOG_LIMIT_BYTES, 'stderr');
    const resultChannel = new LimitedBuffer(RESULT_LIMIT_BYTES, 'result');
    let timedOut = false; let exitCode = null;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CHILD_TIMEOUT_MS);
    child.stdout.on('data', chunk => { if (!stdout.push(chunk)) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { if (!stderr.push(chunk)) child.kill('SIGKILL'); });
    child.stdio[3].on('data', chunk => { if (!resultChannel.push(chunk)) child.kill('SIGKILL'); });
    exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => resolve(code));
    }).finally(() => clearTimeout(timer));
    if (timedOut) throw new Error(`设计 verifier 子进程超时（${CHILD_TIMEOUT_MS}ms）`);
    if (stdout.over || stderr.over || resultChannel.over) throw new Error('设计 verifier 输出超过上限，fail closed');
    if (exitCode !== 0) throw new Error(`设计 verifier 子进程退出码 ${exitCode}：${stderr.text().slice(-500) || stdout.text().slice(-500)}`);
    const rawResult = resultChannel.text().trim();
    if (!rawResult) throw new Error(`设计 verifier 未返回结果：${stderr.text().slice(-500) || stdout.text().slice(-500)}`);
    const message = JSON.parse(rawResult);
    if (message?.nonce !== nonce) throw new Error('设计 verifier 结果 nonce 不匹配，拒绝不可信结果通道');
    result = message.result;
    if (result.__error) throw new Error(`设计 verifier 执行失败：${result.__error}`);
    if (!result || typeof result.ok !== 'boolean' || !Array.isArray(result.checks)) throw new Error('设计 verifier 返回形态无效：需要 ok 与 checks');
  } finally {
    try { await safeGit(project, ['worktree', 'remove', '--force', source]); } catch { /* rmSync 兜底 */ }
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
