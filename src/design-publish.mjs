// 设计会话 publish：product-spec 确认后，把 PRD/spec 以独立分支 + PR 形式推到目标项目 Git，形成 open 事项。
// 设计会话自身保持 read-only；本模块是服务端代行的落地通道，只执行服务端生成的授权快照内动作：
// push-branch（仅 docs/<planId>）与 create-pr。不 merge、不 deploy/release、不碰凭据、不做对外通信。
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { extractProductSpec, checkCapabilities, resolveProjectRoot, runVibe, sanitizeHostEnv } from './vibe-adapter.mjs';
import { loadVibePlan } from './vibe-plan.mjs';
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
  const capability = checkCapabilities({ projectRoot: root });
  if (!capability.ok) return capability;
  let design = null;
  const designRef = extracted.productSpec.design;
  if (designRef != null) {
    if (typeof designRef !== 'object' || !String(designRef.manifestPath || '').trim()) return fail('invalid_design_reference', 'productSpec.design 必须声明 manifestPath');
    try { design = loadDesignManifest({ projectRoot: root, manifestPath: designRef.manifestPath }); }
    catch (error) { return fail(error.code || 'invalid_design_baseline', error.message); }
    if (!designDigest) return fail('design_confirmation_required', '声明了设计基线，publish 需要当前 designDigest 与 confirm=true');
    if (design.designDigest !== designDigest) return fail('design_digest_mismatch', 'designDigest 与当前设计产物不一致，请重新确认');
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

    const remoteHas = (await out('git', ['ls-remote', '--heads', 'origin', branch])) !== '';
    let start = 'HEAD';
    if (remoteHas) {
      await run('git', ['fetch', 'origin', `refs/heads/${branch}`]);
      start = 'FETCH_HEAD';
    }
    worktree = path.join(mkdtempSync(path.join(tmpdir(), 'design-publish-wt-')), 'wt');
    await run('git', ['worktree', 'add', '--detach', worktree, start]);
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
        copyFileSync(path.join(root, relative), target);
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
    await run('git', ['add', '--', `docs/prd/${planId}`, ...designPaths], worktree);
    const dirty = await out('git', ['status', '--porcelain', '--', `docs/prd/${planId}`, ...designPaths], worktree);
    if (dirty) {
      await run('git', ['commit', '-m', `docs(prd): ${planId} product-spec`], worktree);
      await run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], worktree);
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
    if (worktree) {
      try { await run('git', ['worktree', 'remove', '--force', worktree]); } catch { /* 下面兜底 */ }
      rmSync(path.dirname(worktree), { recursive: true, force: true });
      try { await run('git', ['worktree', 'prune']); } catch { /* ignore */ }
    }
  }
}
