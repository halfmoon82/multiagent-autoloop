// publish（无模型）：commit-pr / verify / merge / baseline。只执行授权快照内动作，幂等；
// 永远不做 deploy/release/凭据/对外通信。gh 与测试执行器由调用方注入（CI 离线用假实现）。
import path from 'node:path';
import { normalizeProjectPath } from './dag.mjs';
import { canClosePr, canExecuteAction } from './dag-run.mjs';
import { assertNodeDesignSnapshot, designContractDigest } from './design-baseline.mjs';
import { buildWorktreeTree, worktreeChanges } from './git-safe.mjs';

export class PublishError extends Error {
  constructor(message, code = 'PUBLISH_ERROR') { super(message); this.name = 'PublishError'; this.code = code; }
}

const inScope = (file, scopes) => scopes.some(scope => file === scope || file.startsWith(`${scope}/`));
// 只有这一类路径仍硬拦：凭据、CI 定义、发布/部署脚本、环境变量。业务代码一律只报告。
// 凭据类：任何情况下都硬拦，即使计划里显式声明也不放行。
const CREDENTIAL_PATH = [
  /^\.env($|\.)/, /\.(pem|key|p12|pfx|jks|keystore|crt)$/i, /(^|\/)id_(rsa|ed25519)($|\.)/,
  /^\.npmrc$/, /^\.netrc$/, /^\.yarnrc\.yml$/, /\.tfstate(\.backup)?$/,
  /^\.docker\//, /^k8s\/.*(secret|credential)/i,
];
// 高危但显式写进节点范围的可以放行（授权页能看到这一点）。
const GUARDED_PATH = [
  /^\.github\//, /^\.git\//, /^\.vibe\//, /^\.husky\//,
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

export function createPublisher({ store, rootRunId, rt, gh, runTests, verifyDesign, baseRef = 'origin/main' } = {}) {
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
  // 设计证据只做汇报，不阻断合并：证据缺失/不一致/未通过都记进结果，由审阅者判断。
  const evidenceIssues = (root, node, evidence, commit, { requirePassed = false } = {}) => {
    const design = assertNodeDesignSnapshot(root, node).design;
    if (!design) return null;
    if (!evidence) return 'UI 节点缺少设计验证证据';
    const expectedContract = designContractDigest({ designDigest: root.designBaseline.designDigest, contract: node.contract.design });
    if (evidence.commit !== commit || evidence.designDigest !== root.designBaseline.designDigest || evidence.contractDigest !== expectedContract) {
      return '设计证据 commit/designDigest/contractDigest 与当前已审身份不一致';
    }
    if (!Array.isArray(evidence.checks) || evidence.checks.length === 0 || evidence.checks.some(check => !check || typeof check.ok !== 'boolean')) {
      return '设计证据缺少定向 checks 或 checks 形态无效';
    }
    if (requirePassed && evidence.checks.some(check => !check.ok)) return '设计定向 checks 未全部通过';
    return null;
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
      let commit;
      if (uncommittedFiles.length) {
        // 不执行 git add/commit：用 no-filter hash-object + update-index + commit-tree，
        // 防止 worker 配置 clean filter 或 hooks 在控制器侧执行。
        const { tree } = await buildWorktreeTree({ git: rt.git, cwd: worktree, base: 'HEAD' });
        commit = String(await rt.git(worktree, ['commit-tree', tree, '-p', 'HEAD', '-m', `${nodeId}: ${root.runId}`], { env: {
          GIT_AUTHOR_NAME: 'dag-controller', GIT_AUTHOR_EMAIL: 'dag-controller@localhost',
          GIT_COMMITTER_NAME: 'dag-controller', GIT_COMMITTER_EMAIL: 'dag-controller@localhost',
        } })).trim();
        await rt.git(worktree, ['update-ref', `refs/heads/${branch}`, commit]);
        await rt.git(worktree, ['read-tree', commit]);
      } else commit = String(await rt.git(worktree, ['rev-parse', 'HEAD'])).trim();
      if (commit === baseCommit) throw new PublishError(`节点 ${nodeId} 没有任何提交可发 PR`, 'NOTHING_TO_PUBLISH');
      if (!root.remoteUrl) throw new PublishError('根 run 未冻结可信 remote URL，拒绝 push', 'REMOTE_NOT_FROZEN');
      await rt.git(worktree, ['push', '-q', root.remoteUrl, `${commit}:refs/heads/${branch}`]);
      let prUrl = await gh.findPr({ branch });
      if (!prUrl) prUrl = await gh.createPr({ branch, title: `${nodeId} (${root.runId})` });
      store.registerPr(root.runId, nodeId, prUrl);
      await closeSuperseded(root.runId, nodeId, prUrl);
      return { prUrl, commit, outOfScope: outside };
    },

    async verify({ nodeId, worktree, commit }) {
      const root = need(['run-tests'], 'verify');
      const before = (await changed(worktree)).sort().join('\n');
      const tests = await runTests(worktree);
      const node = nodeOf(root, nodeId);
      const design = assertNodeDesignSnapshot(root, node).design;
      if (!design || tests.exitCode !== 0) {
        const after = (await changed(worktree)).sort().join('\n');
        return { tests, slotStateChanged: before !== after, nodeId, ok: tests.exitCode === 0 };
      }
      // 设施缺失/抛错属于控制器可重试错误，不计 worker 实现失败。
      if (typeof verifyDesign !== 'function') throw new PublishError(`UI 节点 ${nodeId} 缺少设计 verifier`, 'DESIGN_VERIFIER_UNAVAILABLE');
      const head = (await rt.git(worktree, ['rev-parse', 'HEAD'])).trim();
      if (head !== commit) throw new PublishError(`UI 槽位 HEAD ${head} 与待验证 commit ${commit} 不一致`, 'DESIGN_WORKTREE_HEAD_MISMATCH');
      const currentFiles = await changed(worktree);
      if (currentFiles.length) throw new PublishError(`UI 槽位存在未提交改动：${currentFiles.join(', ')}`, 'DESIGN_WORKTREE_DIRTY');
      const evidenceDir = path.join(store.directory, 'design-evidence', rootRunId, nodeId);
      const result = await verifyDesign({ nodeId, worktree, project: rt.project, git: rt.git, commit, designBaseline: root.designBaseline, contract: node.contract.design, evidenceDir });
      const evidence = result?.evidence ?? null;
      const issue = evidence ? evidenceIssues(root, node, evidence, commit, { requirePassed: true }) : '设计 verifier 未返回证据';
      const after = (await changed(worktree)).sort().join('\n');
      // 设计证据只报不拦：节点是否继续由测试结果决定，证据问题记入警示。
      return { tests, slotStateChanged: before !== after, nodeId, ok: tests.exitCode === 0, designEvidence: evidence, ...(issue ? { designEvidenceWarning: issue } : {}) };
    },

    async merge({ nodeId, prUrl, commit, evidence }) {
      const root = need(['squash-merge'], 'merge');
      const pr = (store.getRun(root.runId).prs || []).find(entry => entry.prUrl === prUrl);
      if (!pr || pr.nodeId !== nodeId) throw new PublishError(`PR ${prUrl} 未登记或不属于节点 ${nodeId}，publish 拒绝`, 'PR_NOT_REGISTERED');
      if (pr.state === 'merged') return { mergeCommit: pr.mergeCommit };
      const head = await gh.prHead(prUrl);
      if (head !== commit) throw new PublishError(`远端 PR head ${head} 与已审 SHA ${commit} 不一致（head 变化），拒绝合并`, 'HEAD_MISMATCH');
      const designWarning = evidenceIssues(root, nodeOf(root, nodeId), evidence, commit, { requirePassed: true });
      const result = (await gh.mergePr(prUrl, { strategy: root.authorizationSnapshot.mergeStrategy })) || {};
      // fetch/rev-parse 失败直接抛错由控制器下一 tick 重试：mergePr 与 markPrMerged 均幂等，
      // 不再回退到本地陈旧 baseRef tip 冒充 mergeCommit。
      await rt.git(rt.project, ['fetch', '-q', root.remoteUrl, '+refs/heads/main:refs/heads/main']);
      const tip = (await rt.git(rt.project, ['rev-parse', baseRef])).trim();
      return { mergeCommit: result.mergeCommit || tip, ...(designWarning ? { designWarning } : {}) };
    },

    // 下游基线推进：fetch 更新后，后续 prepare 从合并后的基线建分支。
    async baseline() { await rt.git(rt.project, ['fetch', '-q', root.remoteUrl, '+refs/heads/main:refs/heads/main']); return {}; },
  };
}
