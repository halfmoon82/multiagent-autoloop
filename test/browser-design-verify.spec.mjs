// 当前原生 DAG 的真实生产 UI 定向验证：使用假 Hub、临时 profile 和独立证据目录。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNativePlan } from '../src/dag-plan.mjs';
import { verifyDesign } from '../src/design-verify.mjs';
import { defaultGit } from '../src/dag-slots.mjs';
import { assertNodeDesignSnapshot, designContractDigest } from '../src/design-baseline.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loaded = loadNativePlan({ projectRoot, planId: 'console-hub-native-and-card-routing' });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
for (const nodeId of ['execution-grants', 'card-delegation']) {
  const node = loaded.nodes.find(item => item.id === nodeId);
  const evidenceDir = mkdtempSync(path.join(tmpdir(), `design-evidence-${nodeId}-`));
  try {
    const result = await verifyDesign({ nodeId, worktree: projectRoot, project: projectRoot, git: defaultGit, commit, designBaseline: loaded.designBaseline, contract: node.contract.design, evidenceDir });
    assert.equal(result.ok, true, JSON.stringify(result.evidence));
    assert.ok(result.evidence.checks.length > 0);
    assert.ok(result.evidence.checks.every(check => check.ok));
    assert.ok(result.evidence.artifacts.every(file => existsSync(file.path)));
    assert.equal(result.evidence.commit, commit);
    assert.equal(result.evidence.designDigest, loaded.designBaseline.designDigest);
    assert.equal(result.evidence.contractDigest, designContractDigest({ designDigest: loaded.designBaseline.designDigest, contract: node.contract.design }));

    // 双向覆盖：合同要求的每个 viewport/state 都有且仅有一个 capture；额外维度同样失败。
    const design = assertNodeDesignSnapshot({ designBaseline: loaded.designBaseline }, node).design;
    const expectedCaptures = new Set(design.surfaces.flatMap(surface => surface.viewports.flatMap(viewport => surface.states.map(state => `${surface.id}/${viewport}/${state}`))));
    const captureKeys = result.evidence.captures.map(capture => `${capture.surfaceId}/${capture.viewport}/${capture.state}`);
    assert.equal(new Set(captureKeys).size, captureKeys.length, 'capture 维度不得重复');
    assert.deepEqual(new Set(captureKeys), expectedCaptures);
    assert.equal(result.evidence.coverage.complete, true);
    assert.equal(result.evidence.coverage.captures, expectedCaptures.size);
    const expectedInteractions = new Set(design.surfaces.flatMap(surface => surface.viewports.flatMap(viewport => surface.interactions.map(id => `${surface.id}/${viewport}/${id}`))));
    const interactionKeys = result.evidence.checks.filter(check => check.kind === 'interaction').map(check => `${check.surfaceId}/${check.viewport}/${check.id}`);
    assert.deepEqual(new Set(interactionKeys), expectedInteractions);
    assert.equal(new Set(interactionKeys).size, interactionKeys.length, '交互 check 不得重复');
    console.log(`PASS design-verify: ${nodeId} (${result.evidence.checks.length} checks, ${captureKeys.length} captures, bidirectional coverage)`);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
}
