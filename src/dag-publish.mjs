// publish（无模型）：commit-pr / verify / merge / baseline。只执行授权快照内动作，幂等；
// 永远不做 deploy/release/凭据/对外通信。gh 与测试执行器由调用方注入（CI 离线用假实现）。
import { normalizeProjectPath } from './dag.mjs';

export class PublishError extends Error {
  constructor(message, code = 'PUBLISH_ERROR') { super(message); this.name = 'PublishError'; this.code = code; }
}

const inScope = (file, scopes) => scopes.some(scope => file === scope || file.startsWith(`${scope}/`));
const parseStatus = out => {
  const parts = out.split('\0').filter(Boolean); const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2); files.push(parts[i].slice(3));
    if (code[0] === 'R' || code[0] === 'C') files.push(parts[++i]); // 重命名带原路径
  }
  return files;
};

export function createPublisher({ store, rootRunId, rt, gh, runTests, baseRef = 'origin/main' } = {}) {
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
  const changed = async cwd => parseStatus(await rt.git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']));

  return {
    async commitPr({ nodeId, branch, worktree }) {
      const root = need(['push-branch', 'create-pr'], 'commit-pr');
      const scopes = scopesOf(root, nodeId);
      const files = await changed(worktree);
      const outside = files.filter(file => !inScope(file, scopes));
      if (outside.length) throw new PublishError(`改动超出节点文件范围：${outside.join(', ')}`, 'OUT_OF_SCOPE');
      if (files.length) {
        await rt.git(worktree, ['add', '--', ...files]);
        await rt.git(worktree, ['-c', 'user.name=dag-controller', '-c', 'user.email=dag-controller@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `${nodeId}: ${root.runId}`]);
      }
      const commit = (await rt.git(worktree, ['rev-parse', 'HEAD'])).trim();
      const base = (await rt.git(worktree, ['rev-parse', baseRef]).catch(() => '')).trim();
      if (commit === base) throw new PublishError(`节点 ${nodeId} 没有任何提交可发 PR`, 'NOTHING_TO_PUBLISH');
      await rt.git(worktree, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
      let prUrl = await gh.findPr({ branch });
      if (!prUrl) prUrl = await gh.createPr({ branch, title: `${nodeId} (${root.runId})` });
      store.registerPr(root.runId, nodeId, prUrl);
      return { prUrl, commit };
    },

    async verify({ nodeId, worktree }) {
      need(['run-tests'], 'verify');
      const before = (await changed(worktree)).sort().join('\n');
      const tests = await runTests(worktree);
      const after = (await changed(worktree)).sort().join('\n');
      return { ok: tests.exitCode === 0, tests, slotStateChanged: before !== after, nodeId };
    },

    async merge({ nodeId, prUrl, commit }) {
      const root = need(['squash-merge'], 'merge');
      const pr = (store.getRun(root.runId).prs || []).find(entry => entry.prUrl === prUrl);
      if (!pr || pr.nodeId !== nodeId) throw new PublishError(`PR ${prUrl} 未登记或不属于节点 ${nodeId}，publish 拒绝`, 'PR_NOT_REGISTERED');
      if (pr.state === 'merged') return { mergeCommit: pr.mergeCommit };
      const head = await gh.prHead(prUrl);
      if (head !== commit) throw new PublishError(`远端 PR head ${head} 与已审 SHA ${commit} 不一致（head 变化），拒绝合并`, 'HEAD_MISMATCH');
      const result = (await gh.mergePr(prUrl, { strategy: root.authorizationSnapshot.mergeStrategy })) || {};
      await rt.git(rt.project, ['fetch', '-q', 'origin']).catch(() => {});
      const tip = (await rt.git(rt.project, ['rev-parse', baseRef]).catch(() => commit)).trim();
      return { mergeCommit: result.mergeCommit || tip };
    },

    // 下游基线推进：fetch 更新后，后续 prepare 从合并后的基线建分支。
    async baseline() { await rt.git(rt.project, ['fetch', '-q', 'origin']); return {}; },
  };
}
