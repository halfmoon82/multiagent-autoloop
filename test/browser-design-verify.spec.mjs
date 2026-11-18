// 当前原生 DAG 的真实生产 UI 定向验证：使用假 Hub、临时 profile 和独立证据目录。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNativePlan } from '../src/dag-plan.mjs';
import { verifyDesign } from '../src/design-verify.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loaded = loadNativePlan({ projectRoot, planId: 'console-hub-native-and-card-routing' });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
for (const nodeId of ['execution-grants', 'card-delegation']) {
  const node = loaded.nodes.find(item => item.id === nodeId);
  const evidenceDir = mkdtempSync(path.join(tmpdir(), `design-evidence-${nodeId}-`));
  try {
    const result = await verifyDesign({ nodeId, worktree: projectRoot, commit, designBaseline: loaded.designBaseline, contract: node.contract.design, evidenceDir });
    assert.equal(result.ok, true, JSON.stringify(result.evidence));
    assert.ok(result.evidence.checks.length > 0);
    assert.ok(result.evidence.checks.every(check => check.ok));
    assert.ok(result.evidence.artifacts.every(file => existsSync(file.path)));
    console.log(`PASS design-verify: ${nodeId} (${result.evidence.checks.length} checks)`);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
}
