// 默认定向设计验证适配器：加载已批准且 hash 覆盖的项目内只读模块。
// 不开放任意 shell；证据身份由服务端补齐，项目 verifier 只返回 checks/visualDiffs。
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { designContractDigest } from './design-baseline.mjs';

export async function verifyDesign({ nodeId, worktree, commit, designBaseline, contract, evidenceDir } = {}) {
  const verifierPath = designBaseline?.manifest?.verifierPath;
  if (typeof verifierPath !== 'string' || !verifierPath.trim()) throw new Error('UI 设计清单缺少 verifierPath');
  if (!(designBaseline.readOnlyPaths || []).includes(verifierPath)) throw new Error(`设计 verifier 不在只读产物清单：${verifierPath}`);
  const root = realpathSync(worktree);
  const file = realpathSync(path.resolve(root, verifierPath));
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error('设计 verifier 逃逸 worktree');
  const loaded = await import(`${pathToFileURL(file).href}?dag-design=${encodeURIComponent(commit)}`);
  if (typeof loaded.verify !== 'function') throw new Error(`设计 verifier 必须导出 verify()：${verifierPath}`);
  const result = await loaded.verify({ nodeId, worktree, contract, designBaseline, evidenceDir, commit });
  if (!result || typeof result.ok !== 'boolean' || !Array.isArray(result.checks)) throw new Error('设计 verifier 返回形态无效：需要 ok 与 checks');
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
