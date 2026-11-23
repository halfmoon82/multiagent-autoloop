// 定向设计验证：精确 commit + 冻结基线 + 批准 verifier。
// 支持创建前批准样例 smoke、浏览器/依赖故障后的备用采集，以及完整 captures 校验。
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertNodeDesignSnapshot, designContractDigest, restoreDesignBaseline } from './design-baseline.mjs';
import { createGitRunner, removeWorktree, restoreWorktree } from './git-safe.mjs';

const execFileAsync = promisify(execFile);
const CHILD_TIMEOUT_MS = 5 * 60 * 1000;
const LOG_LIMIT_BYTES = 1024 * 1024;
const RESULT_LIMIT_BYTES = 4 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');

export class DesignVerifyError extends Error {
  constructor(message, { code = 'DESIGN_EVIDENCE_INFRASTRUCTURE', status = 'infrastructure-error', reason = message } = {}) {
    super(message); this.name = 'DesignVerifyError'; this.code = code; this.status = status; this.reason = reason;
  }
}

class LimitedBuffer {
  constructor(limit) { this.limit = limit; this.chunks = []; this.size = 0; this.over = false; }
  push(chunk) {
    if (this.over) return false;
    const buffer = Buffer.from(chunk);
    this.chunks.push(buffer); this.size += buffer.length;
    if (this.size > this.limit) { this.over = true; return false; }
    return true;
  }
  text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

const incomplete = message => new DesignVerifyError(message, { code: 'DESIGN_EVIDENCE_INCOMPLETE', status: 'incomplete' });
const contained = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

function verifierSpec(designBaseline, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new DesignVerifyError(`UI 设计清单缺少有效的 ${label}`);
  }
  if (!(designBaseline.readOnlyPaths || []).includes(relativePath)) throw new DesignVerifyError(`${label}不在只读产物清单：${relativePath}`);
  const expected = (designBaseline.manifest.artifacts || []).find(artifact => artifact?.path === relativePath)?.sha256;
  if (!expected) throw new DesignVerifyError(`${label}缺少 artifacts sha256：${relativePath}`);
  return { relativePath, expected };
}

function approvedSamples(designBaseline, source) {
  const artifacts = new Map((designBaseline.manifest.artifacts || []).map(artifact => [artifact.path, artifact.sha256]));
  return (designBaseline.manifest.surfaces || []).flatMap(surface => (surface.referencePaths || []).map(relativePath => {
    const file = realpathSync(path.resolve(source, relativePath));
    if (!contained(realpathSync(source), file)) throw new DesignVerifyError(`批准样例逃逸精确 commit：${relativePath}`);
    const expected = artifacts.get(relativePath);
    if (!expected || sha256(readFileSync(file)) !== expected) throw new DesignVerifyError(`批准样例 hash 不匹配：${relativePath}`);
    return {
      surfaceId: surface.id, route: surface.route, path: file, relativePath, sha256: expected,
      viewports: [...surface.viewports], states: [...surface.states], interactions: [...surface.interactions],
    };
  }));
}

// publisher 与真实 verifier 共用同一份完整性判定。缺文件、hash 变化、部分矩阵或逃逸路径均 fail closed。
export function validateDesignEvidence({ evidence, designBaseline, contract, nodeId = 'ui', evidenceDir, requireCaptures = true } = {}) {
  if (evidence?.knownDeviations !== undefined && !Array.isArray(evidence.knownDeviations)) throw incomplete('设计 knownDeviations 形态无效');
  if (!evidence || !Array.isArray(evidence.checks) || evidence.checks.length === 0 || evidence.checks.some(check => !check || typeof check.ok !== 'boolean')) {
    throw incomplete('设计证据缺少定向 checks 或 checks 形态无效');
  }
  // 兼容早期手写安全 fixture；真实 loadDesignManifest 必定带 surfaces。
  if (!Array.isArray(designBaseline?.manifest?.surfaces)) return { ...evidence, captures: Array.isArray(evidence.captures) ? evidence.captures : [] };
  const design = assertNodeDesignSnapshot({ designBaseline }, { id: nodeId, contract: { design: contract } }).design;
  if (!design) return evidence;
  const surfaces = design.surfaces || [];
  if (!surfaces.length) return { ...evidence, captures: Array.isArray(evidence.captures) ? evidence.captures : [] };
  if (!requireCaptures) return evidence;
  if (!String(evidenceDir ?? '').trim()) throw incomplete('设计证据缺少 evidenceDir，无法核对 captures');
  mkdirSync(evidenceDir, { recursive: true });
  const evidenceRoot = realpathSync(evidenceDir);
  const expected = new Map();
  for (const surface of surfaces) {
    for (const viewport of surface.viewports) for (const state of surface.states) expected.set(`${surface.id}\0${viewport}\0${state}`, { surfaceId: surface.id, viewport, state });
  }
  const captures = Array.isArray(evidence.captures) ? evidence.captures : (Array.isArray(evidence.artifacts) ? evidence.artifacts : []);
  const found = new Set(); const seenPaths = new Set();
  const normalized = captures.map(capture => {
    if (!capture || typeof capture.path !== 'string' || !capture.path.trim()) throw incomplete('设计 capture 缺少文件路径');
    const resolved = path.isAbsolute(capture.path) ? path.resolve(capture.path) : path.resolve(evidenceRoot, capture.path);
    if (!path.isAbsolute(capture.path) && !contained(evidenceRoot, resolved)) throw incomplete(`设计 capture 逃逸证据目录：${capture.path}`);
    let file;
    try { file = realpathSync(resolved); } catch { throw incomplete(`设计 capture 文件丢失：${capture.path}`); }
    if (!contained(evidenceRoot, file) || !statSync(file).isFile()) throw incomplete(`设计 capture 不是证据目录内文件：${capture.path}`);
    if (seenPaths.has(file)) throw incomplete(`设计 capture 路径重复：${capture.path}`);
    seenPaths.add(file);
    const surface = surfaces.find(item => item.id === capture.surfaceId);
    if (!surface) throw incomplete(`设计 capture surface 不属于合同：${String(capture.surfaceId)}`);
    const viewport = capture.viewport || (surface.viewports.length === 1 ? surface.viewports[0] : null);
    const state = capture.state || (surface.states.length === 1 ? surface.states[0] : null);
    const key = `${capture.surfaceId}\0${viewport}\0${state}`;
    if (!expected.has(key)) throw incomplete(`设计 capture 维度不属于合同：${capture.surfaceId}/${viewport}/${state}`);
    if (found.has(key)) throw incomplete(`设计 capture 维度重复：${capture.surfaceId}/${viewport}/${state}`);
    found.add(key);
    const actualSha256 = sha256(readFileSync(file));
    if (capture.sha256 && capture.sha256 !== actualSha256) throw incomplete(`设计 capture sha256 已变化：${capture.path}`);
    return { ...capture, viewport, state, path: file, sha256: actualSha256 };
  });
  const missing = [...expected].filter(([key]) => !found.has(key)).map(([, item]) => `${item.surfaceId}/${item.viewport}/${item.state}`);
  if (missing.length) throw incomplete(`设计 captures 不完整，缺少：${missing.join(', ')}`);
  for (const surface of surfaces) {
    for (const interaction of surface.interactions) {
      const covered = evidence.checks.some(check => check.surfaceId === surface.id && check.kind === 'interaction' && check.id === interaction);
      if (!covered) throw incomplete(`设计交互 checks 不完整：${surface.id}/${interaction}`);
    }
  }
  return {
    ...evidence, captures: normalized,
    coverage: { captures: normalized.length, requiredCaptures: expected.size, complete: true },
    collectedAt: evidence.collectedAt || new Date().toISOString(),
  };
}

async function executeVerifier({ source, execRoot, spec, exportKind, payload, childEnv, timeoutMs }) {
  const root = realpathSync(source);
  const file = realpathSync(path.resolve(root, spec.relativePath));
  if (!contained(root, file)) throw new DesignVerifyError(`设计 verifier 逃逸精确 commit worktree：${spec.relativePath}`);
  const sourceBytes = readFileSync(file);
  if (sha256(sourceBytes) !== spec.expected) throw new DesignVerifyError(`设计 verifier sha256 摘要不符：${spec.relativePath}`);
  const execDir = mkdtempSync(path.join(tmpdir(), 'design-verify-exec-'));
  try {
    cpSync(source, execDir, { recursive: true });
    rmSync(path.join(execDir, '.git'), { recursive: true, force: true });
    const executablePath = path.join(execDir, spec.relativePath);
    writeFileSync(executablePath, sourceBytes); chmodSync(executablePath, 0o600);
    if (existsSync(path.join(execDir, 'package-lock.json'))) {
      await execFileAsync('npm', ['ci', '--ignore-scripts', '--prefer-offline'], {
        cwd: execDir, env: childEnv, timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
      });
    }
    const nonce = randomBytes(32).toString('hex');
    const wirePayload = { ...payload, verifierUrl: pathToFileURL(executablePath).href, exportKind, nonce };
    // payload 只经 stdin；nonce 不进入 execArgv/env，也不传给项目 verifier。
    const script = `
      const readStdin = () => new Promise((resolve, reject) => {
        let text = ''; process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { text += chunk; });
        process.stdin.on('end', () => resolve(text)); process.stdin.on('error', reject);
      });
      const input = await readStdin();
      const parse = JSON.parse; const primitiveStringify = JSON.stringify;
      const objectKeys = Object.keys; const isArray = Array.isArray;
      const fs = await import('node:fs'); const writeResult = fs.writeSync;
      const payload = parse(input);
      const verifierPayload = { nodeId: payload.nodeId, worktree: payload.worktree, contract: payload.contract,
        designBaseline: payload.designBaseline, evidenceDir: payload.evidenceDir, commit: payload.commit,
        mode: payload.mode, approvedSamples: payload.approvedSamples };
      const safeStringify = value => {
        if (value === null) return 'null'; const type = typeof value;
        if (type === 'boolean' || type === 'number' || type === 'string') return primitiveStringify(value);
        if (isArray(value)) { let out = '['; for (let i = 0; i < value.length; i++) out += (i ? ',' : '') + safeStringify(value[i]); return out + ']'; }
        if (type === 'object') {
          let out = '{'; let first = true;
          for (const key of objectKeys(value)) { if (key === 'toJSON' || key === '__proto__') continue;
            out += (first ? '' : ',') + primitiveStringify(key) + ':' + safeStringify(value[key]); first = false; }
          return out + '}';
        } return 'null';
      };
      try {
        const module = await import(payload.verifierUrl);
        const names = payload.exportKind === 'fallback' ? ['capture', 'verify'] : payload.exportKind === 'smoke' ? ['smoke', 'verify'] : ['verify'];
        const name = names.find(candidate => typeof module[candidate] === 'function');
        if (!name) throw new Error(' verifier export missing: ' + names.join('/'));
        const result = await module[name](verifierPayload);
        writeResult(3, safeStringify({ nonce: payload.nonce, result }) + '\\n');
      } catch (error) {
        writeResult(3, safeStringify({ nonce: payload.nonce, result: { __error: String(error?.message || error) } }) + '\\n');
        process.exitCode = 1;
      }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: execDir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true,
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(wirePayload));
    const stdout = new LimitedBuffer(LOG_LIMIT_BYTES); const stderr = new LimitedBuffer(LOG_LIMIT_BYTES); const resultChannel = new LimitedBuffer(RESULT_LIMIT_BYTES);
    let timedOut = false;
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    child.stdout.on('data', chunk => { if (!stdout.push(chunk)) killGroup(); });
    child.stderr.on('data', chunk => { if (!stderr.push(chunk)) killGroup(); });
    child.stdio[3].on('data', chunk => { if (!resultChannel.push(chunk)) killGroup(); });
    const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); }).finally(() => clearTimeout(timer));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程组已退出 */ }
    if (timedOut) throw new DesignVerifyError(`设计 verifier 子进程超时（${timeoutMs}ms）`);
    if (stdout.over || stderr.over || resultChannel.over) throw new DesignVerifyError('设计 verifier 输出超过上限，fail closed');
    const rawResult = resultChannel.text().trim();
    if (!rawResult) throw new DesignVerifyError(`设计 verifier 未返回结果：${stderr.text().slice(-500) || stdout.text().slice(-500)}`);
    let message;
    try { message = JSON.parse(rawResult); } catch { throw new DesignVerifyError('设计 verifier 结果通道不是合法 JSON'); }
    if (message?.nonce !== nonce) throw new DesignVerifyError('设计 verifier 结果 nonce 不匹配，拒绝不可信结果通道');
    const result = message.result;
    if (sha256(readFileSync(executablePath)) !== spec.expected) throw new DesignVerifyError('设计 verifier 执行字节与批准 hash 不一致');
    if (result?.__error) throw new DesignVerifyError(`设计 verifier 执行失败：${result.__error}`, { reason: String(result.__error) });
    if (exitCode !== 0) throw new DesignVerifyError(`设计 verifier 子进程退出码 ${exitCode}：${stderr.text().slice(-500) || stdout.text().slice(-500)}`);
    if (!result || typeof result.ok !== 'boolean' || !Array.isArray(result.checks) || result.checks.some(check => !check || typeof check.ok !== 'boolean')) {
      throw new DesignVerifyError('设计 verifier 返回形态无效：需要 ok 与 checks');
    }
    return result;
  } finally { rmSync(execDir, { recursive: true, force: true }); }
}

async function runDesignVerification({ nodeId, project, commit, designBaseline, contract, evidenceDir, timeoutMs = CHILD_TIMEOUT_MS, smoke = false } = {}) {
  if (!String(project ?? '').trim()) throw new DesignVerifyError('设计 verifier 需要 project');
  if (!String(commit ?? '').trim()) throw new DesignVerifyError('设计 verifier 需要 commit');
  if (!String(evidenceDir ?? '').trim()) throw new DesignVerifyError('设计 verifier 需要 evidenceDir');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new DesignVerifyError('设计 verifier timeoutMs 必须为正数');
  mkdirSync(evidenceDir, { recursive: true });
  const primary = verifierSpec(designBaseline, designBaseline?.manifest?.verifierPath, 'verifierPath');
  const worktrees = path.join(project, '.worktrees'); mkdirSync(worktrees, { recursive: true });
  const source = mkdtempSync(path.join(worktrees, 'design-verify-'));
  const childHome = mkdtempSync(path.join(tmpdir(), 'design-verify-home-'));
  const childEnv = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: childHome, TMPDIR: tmpdir(), NODE_OPTIONS: '', GIT_TERMINAL_PROMPT: '0' };
  const safeGit = createGitRunner({ env: childEnv });
  try {
    await safeGit(project, ['worktree', 'add', '--no-checkout', '--detach', source, commit]);
    await restoreWorktree({ git: safeGit, cwd: source, commit });
    if (designBaseline.snapshotDirectory) restoreDesignBaseline({ designBaseline, targetRoot: source });
    const samples = smoke ? approvedSamples(designBaseline, source) : [];
    if (smoke && !samples.length) throw incomplete('批准样例 smoke 需要至少一个 hash-covered referencePath');
    const basePayload = { nodeId, worktree: source, contract, designBaseline, evidenceDir, commit, mode: smoke ? 'approved-sample' : 'implementation', approvedSamples: samples };
    const collect = async (spec, exportKind, directory) => {
      const result = await executeVerifier({ source, spec, exportKind, payload: { ...basePayload, evidenceDir: directory }, childEnv, timeoutMs });
      const rawEvidence = {
        commit, designDigest: designBaseline.designDigest,
        contractDigest: designContractDigest({ designDigest: designBaseline.designDigest, contract }),
        checks: result.checks,
        captures: Array.isArray(result.captures) ? result.captures : (Array.isArray(result.artifacts) ? result.artifacts : []),
        knownDeviations: Array.isArray(result.knownDeviations) ? result.knownDeviations : [],
        collector: smoke ? 'approved-sample' : exportKind, verifierOk: result.ok,
        ...(result.visualDiffs ? { visualDiffs: result.visualDiffs } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        ...(result.renderer ? { renderer: result.renderer } : {}),
        ...(result.collectedAt ? { collectedAt: result.collectedAt } : {}),
      };
      const evidence = validateDesignEvidence({ evidence: rawEvidence, designBaseline, contract, nodeId, evidenceDir: directory });
      const deviation = !result.ok || evidence.checks.some(check => !check.ok) || evidence.knownDeviations.length > 0;
      return { ok: result.ok, status: deviation ? 'deviation' : 'pass', evidence };
    };
    try {
      return await collect(primary, smoke ? 'smoke' : 'primary', evidenceDir);
    } catch (primaryError) {
      if (smoke || !designBaseline?.manifest?.fallbackVerifierPath) throw primaryError;
      const fallback = verifierSpec(designBaseline, designBaseline.manifest.fallbackVerifierPath, 'fallbackVerifierPath');
      const fallbackDir = path.join(evidenceDir, 'fallback'); mkdirSync(fallbackDir, { recursive: true });
      try {
        const recovered = await collect(fallback, 'fallback', fallbackDir);
        recovered.evidence.recovery = { primaryError: String(primaryError?.reason || primaryError?.message || primaryError).slice(0, 1000) };
        return recovered;
      } catch (fallbackError) {
        if (primaryError?.status === 'incomplete' && fallbackError?.status === 'incomplete') {
          throw incomplete(`主/备采集证据均不完整：${primaryError.message}；${fallbackError.message}`);
        }
        throw new DesignVerifyError(`主/备设计采集设施均失败：${primaryError?.message || primaryError}；${fallbackError?.message || fallbackError}`);
      }
    }
  } finally {
    removeWorktree({ project, worktree: source });
    rmSync(childHome, { recursive: true, force: true });
  }
}

export async function verifyDesign(options = {}) { return runDesignVerification(options); }
export async function smokeApprovedDesign(options = {}) { return runDesignVerification({ ...options, smoke: true }); }
