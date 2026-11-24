// publish（无模型）：commit-pr / verify / merge / baseline。只执行授权快照内动作，幂等；
// 永远不做 deploy/release/凭据/对外通信。gh 与测试执行器由调用方注入（CI 离线用假实现）。
import path from 'node:path';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { normalizeProjectPath } from './dag.mjs';
import { canClosePr, canExecuteAction } from './dag-run.mjs';
import { assertNodeDesignSnapshot, designContractDigest } from './design-baseline.mjs';
import { buildWorktreeTree, worktreeChanges } from './git-safe.mjs';
import { dagReviewHolder } from './review-claim.mjs';
import { validateDesignEvidence } from './design-verify.mjs';

export class PublishError extends Error {
  constructor(message, code = 'PUBLISH_ERROR') { super(message); this.name = 'PublishError'; this.code = code; }
}

// knownDeviations 不是自由文本豁免：每一项都必须落到本节点批准合同的 surface/维度或失败 check。
// controller 也复用此纯映射，保证 fake/旧适配器与真实 verifier 留下同一种返工记录。
export function mapKnownDeviations({ root, node, evidence } = {}) {
  const design = assertNodeDesignSnapshot(root, node).design;
  if (!design || !Array.isArray(evidence?.knownDeviations) || !evidence.knownDeviations.length) return evidence;
  const invalid = message => new PublishError(message, 'DESIGN_EVIDENCE_INCOMPLETE');
  const mapped = evidence.knownDeviations.map((deviation, index) => {
    if (!deviation || typeof deviation !== 'object' || Array.isArray(deviation)) throw invalid(`设计 knownDeviations[${index}] 必须是对象`);
    const failedChecks = (evidence.checks || []).filter(check => check && check.ok === false);
    const linkedCheck = failedChecks.find(check => check.id === deviation.checkId)
      || (failedChecks.length === 1 ? failedChecks[0] : null);
    const explicit = deviation.contractItem;
    if (explicit !== undefined && (!explicit || typeof explicit !== 'object' || Array.isArray(explicit))) throw invalid(`设计 knownDeviations[${index}].contractItem 形态无效`);
    const surfaceId = explicit?.surfaceId || deviation.surfaceId || linkedCheck?.surfaceId || (design.surfaces.length === 1 ? design.surfaces[0].id : null);
    const surface = design.surfaces.find(item => item.id === surfaceId);
    if (!surface) throw invalid(`设计 knownDeviations[${index}] 无法映射批准合同 surface`);
    const contractItem = { ...(explicit || {}), surfaceId };
    for (const [field, approved] of [['viewport', surface.viewports], ['state', surface.states], ['interaction', surface.interactions]]) {
      const value = contractItem[field] ?? deviation[field];
      if (value !== undefined && !approved.includes(value)) throw invalid(`设计 knownDeviations[${index}] 的 ${field} 不属于批准合同`);
      if (value !== undefined) contractItem[field] = value;
    }
    if (linkedCheck) contractItem.check = { kind: linkedCheck.kind, id: linkedCheck.id };
    return { ...deviation, contractItem };
  });
  return { ...evidence, knownDeviations: mapped };
}

const execFileAsync = promisify(execFile);
const TOKEN_UNAVAILABLE = '无法读取发布凭据（gh 登录 token）：push 已取消';
// 默认凭据源：gh CLI 已登录态。只取 token 字符串，任何失败/输出都不带进错误信息，避免泄露。
export const defaultGhToken = async () => {
  let stdout;
  try { ({ stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 15000, maxBuffer: 64 * 1024 })); }
  catch { throw new PublishError(TOKEN_UNAVAILABLE, 'PUBLISH_TOKEN_UNAVAILABLE'); }
  const token = String(stdout ?? '').trim();
  if (!token) throw new PublishError(TOKEN_UNAVAILABLE, 'PUBLISH_TOKEN_UNAVAILABLE');
  return token;
};

const inScope = (file, scopes) => scopes.some(scope => file === scope || file.startsWith(`${scope}/`));
// 只有这一类路径仍硬拦：凭据、CI 定义、发布/部署脚本、环境变量。业务代码一律只报告。
// 凭据类：任何情况下都硬拦，即使计划里显式声明也不放行。
const CREDENTIAL_PATH = [
  /^\.env($|\.)/, /\.(pem|p12|pfx|jks|keystore|crt)$/i, /(^|\/)id_(rsa|ed25519)($|\.)/,
  /^\.npmrc$/, /^\.netrc$/, /^\.yarnrc\.yml$/, /\.tfstate(\.backup)?$/,
  /^\.docker\//, /^k8s\/.*(secret|credential)/i,
];
// 高危但显式写进节点范围的可以放行（授权页能看到这一点）。
const GUARDED_PATH = [
  /^\.github\//, /^\.git\//, /^\.vibe\//, /^\.husky\//, /\.key$/i,
  /^scripts\/(deploy|release|publish)(\.|$)/i,
];
const hitAny = (path, patterns) => patterns.some(pattern => pattern.test(path));
const scopeGuard = (files, scopes) => {
  const credentials = files.filter(file => hitAny(file, CREDENTIAL_PATH) && !/\.env\.(example|sample|template)$/.test(file));
  const guarded = files.filter(file => hitAny(file, GUARDED_PATH) && !inScope(file, scopes));
  return [...new Set([...credentials, ...guarded])];
};
const parseStatus = out => {
  const parts = out.split('\0').filter(Boolean); const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2); files.push(parts[i].slice(3));
    if (code[0] === 'R' || code[0] === 'C') files.push(parts[++i]); // 重命名带原路径
  }
  return files;
};

export function createPublisher({ store, rootRunId, rt, gh, runTests, verifyDesign, baseRef = 'origin/main', readToken = defaultGhToken } = {}) {
  const need = (actions, why) => {
    const root = store.getRun(rootRunId); // 读取时已校验快照 digest，被篡改直接抛错
    const allowed = root.authorizationSnapshot.allowedActions;
    const missing = actions.filter(action => !allowed.includes(action));
    if (missing.length) throw new PublishError(`授权快照未包含 ${missing.join('/')}，${why}被拒绝`, 'NOT_AUTHORIZED');
    return root;
  };
  const scopesOf = (root, nodeId) => {
    const node = (root.nodes || []).find(item => item.id === nodeId);
    if (!node) throw new PublishError(`节点 ${nodeId} 不在快照中`, 'UNKNOWN_NODE');
    return [...(node.contract?.files || []), ...(node.files || [])].map(normalizeProjectPath);
  };
  const changed = async cwd => worktreeChanges({ git: rt.git, cwd });
  // worker 可能先 git commit：scope 必须同时覆盖未提交状态和 base..HEAD 已提交差异。
  const committed = async (cwd, base) => String(await rt.git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, 'HEAD']) ?? '').split('\0').filter(Boolean);
  const nodeOf = (root, nodeId) => {
    const node = (root.nodes || []).find(item => item.id === nodeId);
    if (!node) throw new PublishError(`节点 ${nodeId} 不在快照中`, 'UNKNOWN_NODE');
    return node;
  };
  // 证据问题分两类：incomplete 交设施补验，deviation 交正常实现返工；不得混用重试通道。
  const evidenceDirectory = (root, nodeId) => path.join(store.directory, 'design-evidence', root.runId, nodeId);
  const evidenceKey = (root, node, commit) => `${commit}-${designContractDigest({ designDigest: root.designBaseline.designDigest, contract: node.contract.design })}`;
  const inspectEvidence = (root, node, evidence, commit, { requirePassed = false, requireCaptures = true } = {}) => {
    const incomplete = message => ({ kind: 'incomplete', message });
    const deviation = message => ({ kind: 'deviation', message });
    const design = assertNodeDesignSnapshot(root, node).design;
    if (!design) return { evidence, issue: null };
    if (!evidence) return { evidence, issue: incomplete('UI 节点缺少设计验证证据') };
    const expectedContract = designContractDigest({ designDigest: root.designBaseline.designDigest, contract: node.contract.design });
    if (evidence.commit !== commit || evidence.designDigest !== root.designBaseline.designDigest || evidence.contractDigest !== expectedContract) {
      return { evidence, issue: incomplete('设计证据 commit/designDigest/contractDigest 与当前已审身份不一致') };
    }
    let normalized;
    try {
      normalized = validateDesignEvidence({ evidence, designBaseline: root.designBaseline, contract: node.contract.design, nodeId: node.id, evidenceDir: evidenceDirectory(root, node.id), requireCaptures });
      normalized = mapKnownDeviations({ root, node, evidence: normalized });
    } catch (error) { return { evidence, issue: incomplete(error?.message || '设计证据不完整') }; }
    if (requirePassed && normalized.verifierOk === false) return { evidence: normalized, issue: deviation('设计 verifier 总结论未全部通过') };
    if (requirePassed && normalized.checks.some(check => !check.ok)) return { evidence: normalized, issue: deviation('设计定向 checks 未全部通过') };
    if (requirePassed && Array.isArray(normalized.knownDeviations) && normalized.knownDeviations.length) return { evidence: normalized, issue: deviation('设计 knownDeviations 未清零') };
    return { evidence: normalized, issue: null };
  };
  const evidenceIssues = (root, node, evidence, commit, options) => inspectEvidence(root, node, evidence, commit, options).issue;
  const readEvidenceCache = (root, node, commit) => {
    const base = evidenceDirectory(root, node.id);
    const file = path.join(base, 'cache', `${evidenceKey(root, node, commit)}.json`);
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const cached = parsed?.evidence || parsed;
      const inspected = inspectEvidence(root, node, cached, commit);
      return inspected.issue ? null : { evidence: inspected.evidence, status: parsed?.status === 'deviation' ? 'deviation' : evidenceStatus(cached) };
    } catch { return null; }
  };
  const writeEvidenceCache = (root, node, commit, evidence, status) => {
    const directory = path.join(evidenceDirectory(root, node.id), 'cache'); mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${evidenceKey(root, node, commit)}.json`);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try { writeFileSync(temporary, `${JSON.stringify({ evidence, status })}\n`, { mode: 0o600 }); renameSync(temporary, file); }
    finally { rmSync(temporary, { force: true }); }
  };
  const evidenceStatus = evidence => (evidence.verifierOk === false || evidence.checks.some(check => !check.ok) || (Array.isArray(evidence.knownDeviations) && evidence.knownDeviations.length) ? 'deviation' : 'pass');
  const evidenceIdentity = (evidence, status) => evidence ? {
    source: 'publisher.verify', commit: evidence.commit, designDigest: evidence.designDigest,
    contractDigest: evidence.contractDigest, status,
  } : null;
  const facilityError = error => {
    const kind = error?.status === 'incomplete' || error?.code === 'DESIGN_EVIDENCE_INCOMPLETE' ? 'incomplete' : 'infrastructure-error';
    const code = kind === 'incomplete' ? 'DESIGN_EVIDENCE_INCOMPLETE' : 'DESIGN_EVIDENCE_INFRASTRUCTURE';
    const wrapped = new PublishError(error?.message || '设计证据设施失败', code); wrapped.status = kind; return wrapped;
  };

  // 换分支后的新 attempt 发布新 PR 时，关闭同节点旧 PR 并注明被替代。仅关 run.json 登记且归属本节点的 PR；
  // 快照未授权 close-superseded-pr 则保留旧 PR（fail closed）。幂等：已 closed 的跳过。
  const closeSuperseded = async (runId, nodeId, newUrl) => {
    const run = store.getRun(runId);
    for (const pr of (run.prs || []).filter(entry => entry.nodeId === nodeId && entry.prUrl !== newUrl && entry.state === 'open')) {
      if (!canClosePr(run, nodeId, pr.prUrl).ok) continue;
      await gh.closePr(pr.prUrl, { comment: `被同节点新 attempt 的 PR ${newUrl} 替代（superseded-by），由 DAG publish 自动关闭。` });
      store.publishClosePr(runId, nodeId, pr.prUrl, { supersededBy: newUrl });
    }
  };

  return {
    // 执行层高风险动作门禁：不只靠 UI，须按授权记录逐项判定（显式选中且摘要一致才放行）。
    requireOptionalGrant(action, why = '执行') {
      const root = store.getRun(rootRunId); // 读取时已校验摘要一致性
      const decision = canExecuteAction(root.authorizationSnapshot, action);
      if (!decision.ok) throw new PublishError(`${why}：未选高风险动作 "${action}"（${decision.reason}），执行层拒绝`, 'HIGH_RISK_NOT_GRANTED');
      return decision;
    },
    async commitPr({ nodeId, branch, worktree, base }) {
      const root = need(['push-branch', 'create-pr'], 'commit-pr');
      const scopes = scopesOf(root, nodeId);
      const uncommittedFiles = await changed(worktree);
      if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(String(base ?? ''))) throw new PublishError(`prepare base 必须是冻结 commit SHA，不能是符号 ref：${String(base ?? '')}`, 'BASE_NOT_COMMIT');
      const baseCommit = (await rt.git(worktree, ['rev-parse', '--verify', `${base}^{commit}`]).catch(() => '')).trim();
      const frozenRootBase = root.publish?.nodes?.[nodeId]?.prepareBase;
      if (frozenRootBase !== base) throw new PublishError(`prepare base 与服务端根 run 冻结值不一致：${base} / ${frozenRootBase}`, 'BASE_MISMATCH');
      if (!baseCommit) throw new PublishError(`冻结基准 commit ${base} 不存在，无法核对本节点提交范围`, 'BASE_REF_MISSING');
      const files = [...new Set([...uncommittedFiles, ...await committed(worktree, baseCommit)])];
      const readOnlyDesign = new Set((root.designBaseline?.readOnlyPaths || []).map(normalizeProjectPath));
      const protectedDesign = files.filter(file => readOnlyDesign.has(file));
      if (protectedDesign.length) throw new PublishError(`设计基线/参考产物只读：${protectedDesign.join(', ')}`, 'DESIGN_BASELINE_READONLY');
      // 敏感路径（凭据/CI/发布脚本）仍硬拦；其余越界只汇报，由 PR 审阅兜底。
      const sensitive = scopeGuard(files, scopes);
      if (sensitive.length) throw new PublishError(`敏感路径改动被拒绝：${sensitive.join(', ')}`, 'SENSITIVE_PATH');
      const outside = files.filter(file => !inScope(file, scopes));
      // 目标分支先指向当前 HEAD 并成为本 worktree HEAD，避免跨分支重试生成 sibling commit。
      const currentHead = String(await rt.git(worktree, ['rev-parse', 'HEAD'])).trim();
      await rt.git(worktree, ['update-ref', `refs/heads/${branch}`, currentHead]);
      await rt.git(worktree, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      let commit, warnings = [];
      if (uncommittedFiles.length) {
        // 不执行 git add/commit：用 no-filter hash-object + update-index + commit-tree，
        // 防止 worker 配置 clean filter 或 hooks 在控制器侧执行。
        const built = await buildWorktreeTree({ git: rt.git, cwd: worktree, base: 'HEAD' });
        const { tree } = built;
        warnings = built.warnings || [];
        commit = String(await rt.git(worktree, ['commit-tree', tree, '-p', 'HEAD', '-m', `${nodeId}: ${root.runId}`], { env: {
          GIT_AUTHOR_NAME: 'dag-controller', GIT_AUTHOR_EMAIL: 'dag-controller@localhost',
          GIT_COMMITTER_NAME: 'dag-controller', GIT_COMMITTER_EMAIL: 'dag-controller@localhost',
        } })).trim();
        await rt.git(worktree, ['update-ref', `refs/heads/${branch}`, commit]);
        await rt.git(worktree, ['read-tree', commit]);
      } else commit = String(await rt.git(worktree, ['rev-parse', 'HEAD'])).trim();
      if (commit === baseCommit) throw new PublishError(`节点 ${nodeId} 没有任何提交可发 PR`, 'NOTHING_TO_PUBLISH');
      if (!root.remoteUrl) throw new PublishError('根 run 未冻结可信 remote URL，拒绝 push', 'REMOTE_NOT_FROZEN');
      // push 凭据只经内存 token + 0700 临时 askpass 脚本传给 git：
      // token 不写仓库/worktree/git config，也不进任何错误文本或日志。
      let token;
      try { token = await readToken(); }
      catch { throw new PublishError(TOKEN_UNAVAILABLE, 'PUBLISH_TOKEN_UNAVAILABLE'); }
      if (!token || typeof token !== 'string') throw new PublishError(TOKEN_UNAVAILABLE, 'PUBLISH_TOKEN_UNAVAILABLE');
      const authDir = mkdtempSync(path.join(tmpdir(), 'dag-push-auth-'));
      const askpass = path.join(authDir, 'askpass.sh');
      try {
        chmodSync(authDir, 0o700);
        const escaped = token.replace(/'/g, "'\\''");
        writeFileSync(askpass, `#!/bin/sh\nprintf '%s' '${escaped}'\n`, { mode: 0o700 });
        chmodSync(askpass, 0o700);
        await rt.git(worktree, ['push', '-q', root.remoteUrl, `${commit}:refs/heads/${branch}`], { env: { GIT_ASKPASS: askpass } });
      } finally { rmSync(authDir, { recursive: true, force: true }); }
      let prUrl = await gh.findPr({ branch });
      if (!prUrl) prUrl = await gh.createPr({ branch, title: `${nodeId} (${root.runId})`, base: root.baseBranch });
      store.registerPr(root.runId, nodeId, prUrl);
      await closeSuperseded(root.runId, nodeId, prUrl);
      return { prUrl, commit, outOfScope: outside, ...(warnings.length ? { warnings } : {}) };
    },

    // 变基/强推后的 PR head 往往只存在于远端（worker 在自己仓库提交后强推），
    // 控制器 mirror 没有这些对象。按分支取回到控制器自有 ref，再以精确 SHA 作为审阅基准。
    async fetchHead({ nodeId, branch }) {
      const root = store.getRun(rootRunId);
      const name = String(branch || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) throw new PublishError(`分支名无效（只允许 [A-Za-z0-9][A-Za-z0-9._/-]*）：${name}`, 'BAD_BRANCH');
      if (!root.remoteUrl) throw new PublishError('根 run 未冻结可信 remote URL，拒绝 fetch', 'REMOTE_NOT_FROZEN');
      let token;
      try { token = await readToken(); }
      catch { throw new PublishError(TOKEN_UNAVAILABLE, 'PUBLISH_TOKEN_UNAVAILABLE'); }
      if (!token || typeof token !== 'string') throw new PublishError(TOKEN_UNAVAILABLE, 'PUBLISH_TOKEN_UNAVAILABLE');
      const authDir = mkdtempSync(path.join(tmpdir(), 'dag-fetch-auth-'));
      const askpass = path.join(authDir, 'askpass.sh');
      const ref = `refs/dag-head/${String(nodeId).replace(/[^A-Za-z0-9._-]/g, '-')}`;
      try {
        chmodSync(authDir, 0o700);
        const escaped = token.replace(/'/g, "'\\''");
        writeFileSync(askpass, `#!/bin/sh\nprintf '%s' '${escaped}'\n`, { mode: 0o700 });
        chmodSync(askpass, 0o700);
        await rt.git(rt.project, ['fetch', '-q', root.remoteUrl, `+refs/heads/${name}:${ref}`], { env: { GIT_ASKPASS: askpass } });
      } finally { rmSync(authDir, { recursive: true, force: true }); }
      const head = String(await rt.git(rt.project, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
      if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(head)) throw new PublishError('取回的 PR head 不是有效 commit，拒绝作为审阅基准', 'HEAD_INVALID');
      return head;
    },

    async verify({ nodeId, worktree, commit }) {
      const root = need(['run-tests'], 'verify');
      const before = (await changed(worktree)).sort().join('\n');
      const tests = await runTests(worktree);
      const node = nodeOf(root, nodeId);
      const design = assertNodeDesignSnapshot(root, node).design;
      if (!design || tests.exitCode !== 0) {
        const after = (await changed(worktree)).sort().join('\n');
        return { tests, slotStateChanged: before !== after, nodeId, ok: tests.exitCode === 0,
          designConformance: design ? false : null, designEvidenceIdentity: null };
      }
      // 设施缺失/抛错属于控制器可重试错误，不计 worker 实现失败。
      if (typeof verifyDesign !== 'function') { const error = new PublishError(`UI 节点 ${nodeId} 缺少设计 verifier`, 'DESIGN_VERIFIER_UNAVAILABLE'); error.status = 'infrastructure-error'; throw error; }
      const head = (await rt.git(worktree, ['rev-parse', 'HEAD'])).trim();
      if (head !== commit) throw new PublishError(`UI 槽位 HEAD ${head} 与待验证 commit ${commit} 不一致`, 'DESIGN_WORKTREE_HEAD_MISMATCH');
      const currentFiles = await changed(worktree);
      if (currentFiles.length) throw new PublishError(`UI 槽位存在未提交改动：${currentFiles.join(', ')}`, 'DESIGN_WORKTREE_DIRTY');
      const evidenceDir = evidenceDirectory(root, nodeId);
      const cached = readEvidenceCache(root, node, commit);
      let evidence = cached?.evidence ?? null; let designStatus = cached?.status ?? null; let cacheState = 'hit'; let legacyAdapter = false;
      if (!evidence) {
        const key = evidenceKey(root, node, commit);
        const attemptEvidenceDir = path.join(evidenceDir, key);
        let result;
        try {
          result = await verifyDesign({ nodeId, worktree, project: rt.project, git: rt.git, commit, designBaseline: root.designBaseline, contract: node.contract.design, evidenceDir: attemptEvidenceDir });
        } catch (error) { throw facilityError(error); }
        legacyAdapter = !result?.status && result?.evidence && result.evidence.captures === undefined && result.evidence.artifacts === undefined
          && result.evidence.checks?.every(check => check?.surfaceId === undefined)
          && Object.keys(node.contract.design).length === 1 && Array.isArray(node.contract.design.surfaceIds);
        const inspected = inspectEvidence(root, node, result?.evidence ?? null, commit, { requireCaptures: !legacyAdapter });
        if (inspected.issue) throw facilityError(inspected.issue.kind === 'incomplete' ? { message: inspected.issue.message, status: 'incomplete' } : inspected.issue);
        evidence = { ...inspected.evidence, verifierOk: result?.ok !== false }; cacheState = 'rebuilt';
        designStatus = result?.status === 'deviation' || result?.ok === false ? 'deviation' : evidenceStatus(evidence);
        // 旧嵌入适配器不含采集证据时保持运行兼容，但不写完整缓存；merge 仍按新合同 fail closed。
        if (!legacyAdapter) writeEvidenceCache(root, node, commit, evidence, designStatus);
        else cacheState = 'legacy';
      }
      const issue = evidenceIssues(root, node, evidence, commit, { requirePassed: true, requireCaptures: !legacyAdapter });
      const after = (await changed(worktree)).sort().join('\n');
      // 无证据、身份错位或部分 captures 属于设施故障；checks/deviations 才是实现返工。
      if (issue?.kind === 'incomplete') throw facilityError({ message: issue.message, status: 'incomplete' });
      return {
        tests, slotStateChanged: before !== after, nodeId, ok: tests.exitCode === 0,
        designStatus, designEvidence: evidence, designEvidenceCache: cacheState,
        designConformance: !issue && designStatus === 'pass',
        designEvidenceIdentity: evidenceIdentity(evidence, designStatus),
        ...(issue ? { designEvidenceWarning: issue.message } : {}),
      };
    },

    async merge({ nodeId, prUrl, commit, evidence, codeReviewAccepted, codeReviewEvidence, designConformance }) {
      const root = need(['squash-merge'], 'merge');
      const pr = (store.getRun(root.runId).prs || []).find(entry => entry.prUrl === prUrl);
      if (!pr || pr.nodeId !== nodeId) throw new PublishError(`PR ${prUrl} 未登记或不属于节点 ${nodeId}，publish 拒绝`, 'PR_NOT_REGISTERED');
      if (pr.state === 'merged') return { mergeCommit: pr.mergeCommit };
      const head = await gh.prHead(prUrl);
      if (head !== commit) {
        // 带上远端 head，交由控制器决定是否在新 head 上重审；publish 自身绝不合并未审提交。
        const error = new PublishError(`远端 PR head ${head} 与已审 SHA ${commit} 不一致（head 变化），拒绝合并`, 'HEAD_MISMATCH');
        error.head = head;
        throw error;
      }
      if (codeReviewAccepted !== true || !codeReviewEvidence || codeReviewEvidence.source !== 'independent-review'
        || typeof codeReviewEvidence.runId !== 'string' || !codeReviewEvidence.runId || codeReviewEvidence.commit !== commit) {
        throw new PublishError(`PR ${prUrl} 缺少同一 SHA 的有效独立代码审阅结论，拒绝合并`, 'CODE_REVIEW_REQUIRED');
      }
      // 审阅占位：他人（非本节点 DAG 审阅）正在审时暂缓合并，抛错由控制器下一 tick 重试，节点状态不变。
      if (typeof gh.claimHolder === 'function') {
        const holder = await gh.claimHolder(prUrl);
        if (holder && holder !== dagReviewHolder(nodeId)) throw new PublishError(`PR ${prUrl} 正被 ${holder} 审阅占位，暂缓合并（占位释放或过期后自动重试）`, 'REVIEW_CLAIMED');
      }
      const designWarning = evidenceIssues(root, nodeOf(root, nodeId), evidence, commit, { requirePassed: true });
      if (designWarning) {
        const code = designWarning.kind === 'deviation' ? 'DESIGN_DEVIATION' : 'DESIGN_EVIDENCE_INCOMPLETE';
        const error = new PublishError(designWarning.message, code); error.status = designWarning.kind === 'deviation' ? 'deviation' : 'incomplete'; throw error;
      }
      const design = assertNodeDesignSnapshot(root, nodeOf(root, nodeId)).design;
      if (design && designConformance !== true) {
        const error = new PublishError(`PR ${prUrl} 缺少同一 SHA 的有效 designConformance 结论，拒绝合并`, 'DESIGN_CONFORMANCE_REQUIRED');
        error.status = 'incomplete'; throw error;
      }
      const result = (await gh.mergePr(prUrl, { strategy: root.authorizationSnapshot.mergeStrategy })) || {};
      // fetch/rev-parse 失败直接抛错由控制器下一 tick 重试：mergePr 与 markPrMerged 均幂等，
      // 不再回退到本地陈旧 baseRef tip 冒充 mergeCommit。
      await rt.git(rt.project, ['fetch', '-q', root.remoteUrl, '+refs/heads/main:refs/heads/main']);
      const tip = (await rt.git(rt.project, ['rev-parse', baseRef])).trim();
      return { mergeCommit: result.mergeCommit || tip };
    },

    // 下游基线推进：fetch 更新后，后续 prepare 从合并后的基线建分支。
    async baseline() {
      const root = store.getRun(rootRunId);
      await rt.git(rt.project, ['fetch', '-q', root.remoteUrl, '+refs/heads/main:refs/heads/main']);
      return {};
    },
  };
}
