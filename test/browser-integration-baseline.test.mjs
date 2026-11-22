// Integration-verify：六栏新基线批准记录与不可变 run 快照的存在性与一致性契约。
// 本文件只校验设计基线的冻结/批准/快照链，不渲染浏览器，不判定 PRD 语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDesignManifest, loadDesignBaseline } from '../src/design-baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = path.join(ROOT, 'docs', 'design', '2026-11-22-nomoto-6tab-baseline');
const MANIFEST = 'docs/design/2026-11-22-nomoto-6tab-baseline/design-manifest.json';
const APPROVAL = 'docs/design/2026-11-22-nomoto-6tab-baseline/design-approval.json';
const SNAPSHOT = 'docs/design/2026-11-22-nomoto-6tab-baseline/run-snapshot.json';

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('六栏新基线：manifest 通过校验且恰好覆盖六个 Tab surface', () => {
  const loaded = loadDesignManifest({ projectRoot: ROOT, manifestPath: MANIFEST });
  assert.equal(loaded.manifest.schema, 1);
  const ids = loaded.manifest.surfaces.map(s => s.id);
  assert.deepEqual(ids, ['overview', 'rules', 'sessions', 'rounds', 'todos', 'admin']);
  for (const surface of loaded.manifest.surfaces) {
    assert.ok(surface.viewports.includes('390x844'), `${surface.id} 缺少手机 viewport`);
    assert.ok(surface.states.length > 0, `${surface.id} 缺少状态`);
    assert.ok(surface.referencePaths.length > 0, `${surface.id} 缺少参考产物`);
  }
});

test('六栏新基线：批准记录 designDigest 与 manifest 一致（走一次批准流程）', () => {
  const loaded = loadDesignManifest({ projectRoot: ROOT, manifestPath: MANIFEST });
  const baseline = loadDesignBaseline({ projectRoot: ROOT, manifestPath: MANIFEST, approvalPath: APPROVAL });
  assert.equal(baseline.approval.schema, 1);
  assert.equal(baseline.approval.designDigest, loaded.designDigest);
  assert.ok(Number.isFinite(Date.parse(baseline.approval.confirmedAt)));
});

test('不可变 run 快照：自摘要可重算、且锚定同一 designDigest 与 run/commit', () => {
  const baseline = loadDesignBaseline({ projectRoot: ROOT, manifestPath: MANIFEST, approvalPath: APPROVAL });
  const snap = JSON.parse(readFileSync(path.join(BASE, 'run-snapshot.json'), 'utf8'));
  assert.equal(snap.schema, 1);
  assert.equal(snap.designDigest, baseline.designDigest);
  assert.equal(snap.runId, 'dagrun-mwr4beq5-b8e78ae6');
  assert.match(snap.commit, /^[0-9a-f]{40}$/);
  const { digest, ...body } = snap;
  assert.equal(sha256(canonical(body)), digest, '快照 self-digest 必须可重算，任何改动即失配');
});

// 复审 P3：g2a1 换打法本轮实跑，5 spec + APK 16 项逐一重跑留证，非沿用旧快照记录、非开发方转述。
test('不可变 run 快照：记录 g2a1 当轮实跑证据，5 spec 与 APK 逐项新鲜、红项仍归属 wave-1', () => {
  const snap = JSON.parse(readFileSync(path.join(BASE, 'run-snapshot.json'), 'utf8'));
  assert.equal(snap.rerun.runId, 'dagrun-mwr66hkz-be133346');
  assert.equal(snap.rerun.generation, 2);
  assert.equal(snap.rerun.attempt, 1);
  assert.ok(Date.parse(snap.rerun.capturedAt) > Date.parse('2026-11-22T01:40:12.046Z'), '证据须在 g2a1 派发后采集');
  assert.match(snap.rerun.source, /实跑/);
  assert.match(snap.rerun.source, /不沿用/);

  const specs = snap.verification.browser.specs;
  assert.deepEqual(specs.map(s => s.file), [
    'test/browser.spec.mjs',
    'test/browser-dag.spec.mjs',
    'test/browser-archive.spec.mjs',
    'test/browser-design-verify.spec.mjs',
    'test/browser-admin.spec.mjs',
  ], '5 个浏览器 spec 必须逐个实跑并记录');
  const failed = specs.filter(s => s.exit !== 0);
  assert.equal(failed.length, 1, '本轮实际重跑恰有 1 个浏览器 spec 红');
  assert.equal(failed[0].owner, 'session-inputs', '红项归属 wave-1 的 session-inputs 节点');
  assert.match(failed[0].failure, /超出视口/);

  // 逐项新鲜证据：4 绿 spec 与 APK 16 项本轮逐一重跑，不是从旧快照抄来。
  assert.deepEqual(snap.rerun.fresh.specs, specs.map(s => ({ file: s.file, exit: s.exit })));
  assert.equal(snap.rerun.fresh.apk, '16/16');
  assert.equal(snap.rerun.fresh.unit, '1401/1402');
  assert.equal(snap.verification.unit.fail, 1, 'unit 唯一失败为 wave-1 tab-swipe 吸底回归');
  assert.equal(snap.verification.apk.pass, 16);
  assert.equal(snap.verification.baseline.pass, 4);
});
