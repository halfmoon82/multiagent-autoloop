#!/usr/bin/env node
// PR 审阅占位 CLI：审阅前 claim、合并用 merge、放弃用 release。所有审阅方（Codex/Claude/Hub 规则）共用。
//   node scripts/review-claim.mjs claim   --pr 116 [--repo owner/name] --holder <审阅方标识>
//   node scripts/review-claim.mjs merge   --pr 116 [--repo owner/name] --holder <标识> --head <审过的提交> [--delete-branch]
//   node scripts/review-claim.mjs release --pr 116 [--repo owner/name] --holder <标识>
// 退出码：0 成功；3 被他人占位/非持有者/提交已变（应停止，不审不合并）；1 参数或 gh 错误。
import { createReviewClaims } from '../src/review-claim.mjs';

const [action, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const key = rest[i].replace(/^--/, '');
  if (key === 'delete-branch') opts.deleteBranch = true;
  else opts[key] = rest[++i];
}
const claims = createReviewClaims();
const actions = { claim: claims.claim, merge: claims.merge, release: claims.release };
if (!actions[action]) {
  console.error('用法：review-claim.mjs <claim|merge|release> --pr <号> [--repo owner/name] --holder <标识> [--head <sha>] [--delete-branch]');
  process.exit(1);
}
try {
  const result = await actions[action](opts);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 3);
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}
