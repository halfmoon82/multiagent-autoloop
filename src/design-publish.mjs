// 设计会话 publish：product-spec 确认后，把 PRD/spec 以独立分支 + PR 形式推到目标项目 Git，形成 open 事项。
// 设计会话自身保持 read-only；本模块是服务端代行的落地通道，只执行服务端生成的授权快照内动作：
// push-branch（仅 docs/<planId>）与 create-pr。不 merge、不 deploy/release、不碰凭据、不做对外通信。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { extractProductSpec, resolveProjectRoot, runVibe, sanitizeHostEnv } from './vibe-adapter.mjs';
import { loadVibePlan } from './vibe-plan.mjs';
import { buildWorktreeTree, defaultGit, removeWorktree, restoreWorktree } from './git-safe.mjs';
import { loadDesignManifest } from './design-baseline.mjs';

const execFileAsync = promisify(execFile);
const PLAN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const FORBIDDEN_ACTION = /deploy|release|credential|secret|token|external|network|merge|force/i;

export const PUBLISH_ACTIONS = Object.freeze(['push-branch', 'create-pr']);
export const PUBLISH_EXCLUDED = Object.freeze(['merge', 'deploy', 'release', 'production-write', 'credentials', 'external-communication']);

const fail = (code, message, remediation = null) => ({ ok: false, error: { code, message, ...(remediation ? { remediation } : {}) } });

export function publishBranchName(planId) {
  if (!PLAN_ID.test(String(planId || ''))) throw new Error('planId 必须是 kebab-case ASCII');
  return `docs/${planId}`;
}

/** 授权快照由服务端按白名单生成；调用方传入的 actions 只用于校验，超出白名单一律拒绝。 */
export function buildPublishSnapshot({ planId, baseBranch, actions = PUBLISH_ACTIONS }) {
  const branch = publishBranchName(planId);
  if (!BRANCH.test(String(baseBranch || '')) || baseBranch === branch || baseBranch === 'HEAD' || baseBranch.startsWith('docs/')) {
    throw new Error(`发布基线分支无效（不能是游离 HEAD 或 docs/ 发布分支）：${String(baseBranch)}`);
  }
  for (const action of actions) {
    if (FORBIDDEN_ACTION.test(String(action))) throw new Error(`授权快照包含永远禁止的动作：${action}`);
    if (!PUBLISH_ACTIONS.includes(action)) throw new Error(`动作不在已授权发布范围：${action}`);
  }
  return { kind: 'design-publish', planId, branch, baseBranch, actions: [...PUBLISH_ACTIONS], excluded: [...PUBLISH_EXCLUDED] };
}

async function defaultRunner(command, args, { cwd, env } = {}) {
  // Git 一律走 hardened runner；gh/vibe 仍由原 runner 执行。
  if (command === 'git') return { stdout: await defaultGit(cwd, args, { env }) };
  const { stdout } = await execFileAsync(command, args, { cwd, env, maxBuffer: 4 * 1024 * 1024 });
  return { stdout };
}

const json = value => `${JSON.stringify(value, null, 2)}\n`;

export async function publishProductSpec({
  projectRoot, planId, transcript, specDigest, designDigest, confirm, runner = defaultRunner, vibeCommand = 'vibe', env, now = Date.now,
} = {}) {
  if (confirm !== true) return fail('confirmation_required', 'publish 需要 confirm=true');
  let root;
  let branch;
  try { root = resolveProjectRoot(projectRoot); branch = publishBranchName(planId); }
  catch (error) { return fail(error.code || 'invalid_arguments', error.message); }
  let extracted;
  try { extracted = extractProductSpec(transcript); } catch (error) { return fail(error.code || 'invalid_arguments', error.message); }
  if (!extracted.ok) return extracted;
  if (extracted.specDigest !== specDigest) return fail('spec_digest_mismatch', 'specDigest 与会话转录中的 product-spec 不一致，请重新确认');
  let design = null;
  let designSnapshot = null;
  const designRef = extracted.productSpec.design;
  if (designRef != null) {
    if (typeof designRef !== 'object' || !String(designRef.manifestPath || '').trim()) return fail('invalid_design_reference', 'productSpec.design 必须声明 manifestPath');
    try { design = loadDesignManifest({ projectRoot: root, manifestPath: designRef.manifestPath }); }
    catch (error) { return fail(error.code || 'invalid_design_baseline', error.message); }
    if (!designDigest) return fail('design_confirmation_required', '声明了设计基线，publish 需要当前 designDigest 与 confirm=true');
    if (design.designDigest !== designDigest) return fail('design_digest_mismatch', 'designDigest 与当前设计产物不一致，请重新确认');
    const reserved = new Set(['product-spec.json', 'plan.json', 'nodes.json', 'design-approval.json'].map(name => `docs/prd/${planId}/${name}`));
    const collisions = design.readOnlyPaths.filter(file => reserved.has(file));
    if (collisions.length) return fail('design_output_conflict', `设计产物不得覆盖 PRD 生成文件：${collisions.join(', ')}`);
    // hash 后立即快照到控制器目录，避免 vibe plan/copy 之间的 TOCTOU。
    designSnapshot = mkdtempSync(path.join(tmpdir(), 'design-snapshot-'));
    const artifactHashes = new Map((design.manifest.artifacts || []).map(artifact => [artifact.path, artifact.sha256]));
    for (const relative of design.readOnlyPaths) {
      const target = path.join(designSnapshot, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, relative), target);
      const expectedHash = artifactHashes.get(relative);
      if (expectedHash) {
        const actualHash = createHash('sha256').update(readFileSync(target)).digest('hex');
        if (actualHash !== expectedHash) return fail('design_artifact_changed', `设计产物在确认后发生变化：${relative}`);
      }
    }
  }

  // 既有链路：转录原文 → product-spec.input.json → vibe plan --from-prd（产物留在目标项目 .vibe/，不入提交）。
  const planDir = path.join(root, '.vibe', 'plans', planId);
  const prdPath = path.join(planDir, 'product-spec.input.json');
  mkdirSync(planDir, { recursive: true });
  writeFileSync(prdPath, json(extracted.productSpec));
  const planned = await runVibe('plan', { projectRoot: root, prdPath, command: vibeCommand, env, runner: (argv, o = {}) => runner(o.command ?? vibeCommand, argv, { cwd: root, env: o.env }) });
  if (!planned.ok) return planned;
  let loaded;
  try { loaded = loadVibePlan({ projectRoot: root, planId }); }
  catch (error) { return fail('plan_invalid', error.message); }

  const cleanEnv = { ...sanitizeHostEnv(env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
  const run = (command, args, cwd = root) => runner(command, args, { cwd, env: cleanEnv });
  const out = async (command, args, cwd) => String((await run(command, args, cwd)).stdout ?? '').trim();

  let snapshot;
  let worktree = null;
  try {
    const baseBranch = await out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    try { snapshot = buildPublishSnapshot({ planId, baseBranch }); }
    catch (error) { return fail('invalid_base_branch', error.message, '切到项目基线分支（如 main）后重试；不会从 docs/ 分支或游离 HEAD 发布'); }

    const remoteUrl = await out('git', ['remote', 'get-url', 'origin']);
    const remoteHas = (await out('git', ['ls-remote', '--heads', remoteUrl, branch])) !== '';
    let start = 'HEAD';
    if (remoteHas) {
      await run('git', ['fetch', remoteUrl, `refs/heads/${branch}`]);
      start = 'FETCH_HEAD';
    }
    const startCommit = await out('git', ['rev-parse', `${start}^{commit}`]);
    worktree = path.join(mkdtempSync(path.join(tmpdir(), 'design-publish-wt-')), 'wt');
    await run('git', ['worktree', 'add', '--no-checkout', '--detach', worktree, startCommit]);
    await restoreWorktree({ git: (cwd, args, env) => runner('git', args, { cwd, env }).then(result => result.stdout), cwd: worktree, commit: startCommit });
    const dir = path.join(worktree, 'docs', 'prd', planId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'product-spec.json'), json(loaded.productSpec));
    writeFileSync(path.join(dir, 'plan.json'), json(loaded.plan));
    writeFileSync(path.join(dir, 'nodes.json'), json(loaded.nodes));
    const designPaths = [];
    if (design) {
      for (const relative of design.readOnlyPaths) {
        designPaths.push(relative);
        const target = path.join(worktree, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(path.join(designSnapshot, relative), target);
      }
      const approvalPath = path.join(dir, 'design-approval.json');
      let approval = null;
      if (existsSync(approvalPath)) {
        try {
          const previous = JSON.parse(readFileSync(approvalPath, 'utf8'));
          if (previous.schema === 1 && previous.designDigest === design.designDigest && Number.isFinite(Date.parse(previous.confirmedAt))) approval = previous;
        } catch { /* 损坏旧记录由本次明确确认替换 */ }
      }
      approval ||= { schema: 1, designDigest: design.designDigest, confirmedAt: new Date(now()).toISOString() };
      writeFileSync(approvalPath, json(approval));
    }
    const git = (cwd, args, env) => runner('git', args, { cwd, env }).then(result => result.stdout);
    const { tree, entries } = await buildWorktreeTree({ git, cwd: worktree, base: 'HEAD' });
    if (entries.length) {
      const commit = (await run('git', ['commit-tree', tree, '-p', 'HEAD', '-m', `docs(prd): ${planId} product-spec`], worktree)).stdout.trim();
      await run('git', ['push', remoteUrl, `${commit}:refs/heads/${branch}`], worktree);
    }
    const existing = JSON.parse((await out('gh', ['pr', 'list', '--head', branch, '--base', snapshot.baseBranch, '--state', 'open', '--json', 'url,number'])) || '[]');
    if (existing.length > 0) {
      return { ok: true, branch, baseBranch: snapshot.baseBranch, prUrl: existing[0].url, reused: true, designDigest: design?.designDigest || null, authorizationSnapshot: snapshot };
    }
    const title = `docs(prd): ${String(loaded.productSpec.title || planId).slice(0, 80)}`;
    const body = `由设计会话 product-spec 确认后发布。\n\n- planId: ${planId}\n- specDigest: ${specDigest}${design ? `\n- designDigest: ${design.designDigest}` : ''}\n\n仅包含 PRD/spec${design ? '、已确认设计产物' : ''}与计划产物；未授权 merge/deploy/release。`;
    const prUrl = (await out('gh', ['pr', 'create', '--base', snapshot.baseBranch, '--head', branch, '--title', title, '--body', body])).split('\n').pop();
    return { ok: true, branch, baseBranch: snapshot.baseBranch, prUrl, reused: false, designDigest: design?.designDigest || null, authorizationSnapshot: snapshot };
  } catch (error) {
    return fail('publish_failed', `publish 失败：${error.message}`);
  } finally {
    if (designSnapshot) rmSync(designSnapshot, { recursive: true, force: true });
    if (worktree) {
      // 不执行 git worktree remove：该命令可能触发 worker 配置的 filter；直接删除后 prune 元数据。
      removeWorktree({ project: root, worktree });
      rmSync(path.dirname(worktree), { recursive: true, force: true });
    }
  }
}
