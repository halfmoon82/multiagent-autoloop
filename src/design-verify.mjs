// 默认定向设计验证适配器：从精确 commit 建临时只读 worktree，
// 校验 verifier sha256 后在净化子进程执行；结果走专用 fd + nonce，不信任 stdout。
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { designContractDigest } from './design-baseline.mjs';
import { chmodSync } from 'node:fs';
import { createGitRunner, removeWorktree, restoreWorktree } from './git-safe.mjs';

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
  // 统一 hardened Git：禁 hooks/fsmonitor/untrackedCache，且不继承控制器环境。
  const safeGit = createGitRunner({ env: childEnv });

  let result = null; let execDir = null;
  try {
    await safeGit(project, ['worktree', 'add', '--no-checkout', '--detach', source, commit]);
    await restoreWorktree({ git: safeGit, cwd: source, commit });
    const root = realpathSync(source);
    const file = realpathSync(path.resolve(root, verifierPath));
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error('设计 verifier 逃逸精确 commit worktree');
    const sourceBytes = readFileSync(file);
    const actual = createHash('sha256').update(sourceBytes).digest('hex');
    if (actual !== expected) throw new Error(`设计 verifier sha256 摘要不符：${verifierPath}`);
    // 执行字节与 hash 字节一致：先读入，再写入 worker 不可写的临时执行目录。
    execDir = mkdtempSync(path.join(tmpdir(), 'design-verify-exec-'));
    cpSync(source, execDir, { recursive: true });
    rmSync(path.join(execDir, '.git'), { recursive: true, force: true });
    const execFile = path.join(execDir, verifierPath);
    writeFileSync(execFile, sourceBytes);
    chmodSync(execFile, 0o600);
    // 依赖从 exact commit 的 lockfile 安装到控制器临时目录，不 symlink worker 可写 node_modules。
    if (existsSync(path.join(execDir, 'package-lock.json'))) {
      await execFileAsync('npm', ['ci', '--ignore-scripts', '--prefer-offline'], {
        cwd: execDir, env: childEnv, timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
      });
    }

    const nonce = randomBytes(32).toString('hex');
    const verifierPayload = { nodeId, worktree: source, contract, designBaseline, evidenceDir, commit };
    const payload = { ...verifierPayload, verifierUrl: pathToFileURL(execFile).href, nonce };
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
      const primitiveStringify = JSON.stringify;
      const objectKeys = Object.keys;
      const isArray = Array.isArray;
      const fs = await import('node:fs');
      const writeResult = fs.writeSync;
      const payload = parse(input);
      const verifierPayload = { nodeId: payload.nodeId, worktree: payload.worktree, contract: payload.contract, designBaseline: payload.designBaseline, evidenceDir: payload.evidenceDir, commit: payload.commit };
      // 安全序列化：不调用 toJSON，不遍历继承属性，不使用可被项目替换的数组方法。
      const safeStringify = value => {
        if (value === null) return 'null';
        const type = typeof value;
        if (type === 'boolean' || type === 'number') return primitiveStringify(value);
        if (type === 'string') return primitiveStringify(value);
        if (isArray(value)) {
          let out = '[';
          for (let i = 0; i < value.length; i++) out += (i ? ',' : '') + safeStringify(value[i]);
          return out + ']';
        }
        if (type === 'object') {
          let out = '{'; let first = true;
          for (const key of objectKeys(value)) {
            if (key === 'toJSON' || key === '__proto__') continue;
            out += (first ? '' : ',') + primitiveStringify(key) + ':' + safeStringify(value[key]);
            first = false;
          }
          return out + '}';
        }
        return 'null';
      };
      try {
        const module = await import(payload.verifierUrl);
        const result = await module.verify(verifierPayload);
        writeResult(3, safeStringify({ nonce: payload.nonce, result }) + '\\n');
      } catch (error) {
        writeResult(3, safeStringify({ nonce: payload.nonce, result: { __error: String(error?.message || error) } }) + '\\n');
        process.exitCode = 1;
      }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: execDir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true,
    });
    child.stdin.on('error', () => {}); // 子进程提前退出时避免 EPIPE 掩盖真实错误
    child.stdin.end(JSON.stringify(payload));
    const stdout = new LimitedBuffer(LOG_LIMIT_BYTES, 'stdout');
    const stderr = new LimitedBuffer(LOG_LIMIT_BYTES, 'stderr');
    const resultChannel = new LimitedBuffer(RESULT_LIMIT_BYTES, 'result');
    let timedOut = false; let exitCode = null;
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, CHILD_TIMEOUT_MS);
    child.stdout.on('data', chunk => { if (!stdout.push(chunk)) killGroup(); });
    child.stderr.on('data', chunk => { if (!stderr.push(chunk)) killGroup(); });
    child.stdio[3].on('data', chunk => { if (!resultChannel.push(chunk)) killGroup(); });
    exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => resolve(code));
    }).finally(() => clearTimeout(timer));
    // 正常退出也清理整个进程组，防止 verifier 留下 Chrome 等孙进程。
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group 已退出 */ }
    if (timedOut) throw new Error(`设计 verifier 子进程超时（${CHILD_TIMEOUT_MS}ms）`);
    if (stdout.over || stderr.over || resultChannel.over) throw new Error('设计 verifier 输出超过上限，fail closed');
    const rawResult = resultChannel.text().trim();
    if (!rawResult) throw new Error(`设计 verifier 未返回结果：${stderr.text().slice(-500) || stdout.text().slice(-500)}`);
    const message = JSON.parse(rawResult);
    if (message?.nonce !== nonce) throw new Error('设计 verifier 结果 nonce 不匹配，拒绝不可信结果通道');
    result = message.result;
    if (createHash('sha256').update(readFileSync(execFile)).digest('hex') !== expected) throw new Error('设计 verifier 执行字节与批准 hash 不一致');
    if (result.__error) throw new Error(`设计 verifier 执行失败：${result.__error}`);
    if (exitCode !== 0) throw new Error(`设计 verifier 子进程退出码 ${exitCode}：${stderr.text().slice(-500) || stdout.text().slice(-500)}`);
    if (!result || typeof result.ok !== 'boolean' || !Array.isArray(result.checks) || result.checks.some(check => !check || typeof check.ok !== 'boolean')) throw new Error('设计 verifier 返回形态无效：需要 ok 与 checks');
  } finally {
    removeWorktree({ project, worktree: source });
    rmSync(childHome, { recursive: true, force: true });
    if (execDir) rmSync(execDir, { recursive: true, force: true });
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
