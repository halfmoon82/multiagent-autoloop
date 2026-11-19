import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TIERS, nodeTier, bumpTier, loadEnabledTiers } from '../src/dag-tier.mjs';
import { createHubAdapter, dagEventType } from '../src/dag-runtime.mjs';
import { setup, mkNode } from './dag-fakes.mjs';

const node = (files, extra = {}) => ({ id: 'n', depends_on: [], contract: { input: 'i', output: 'o', error_behavior: 'e', acceptance_example: 'a', files }, ...extra });

test('成本优先：小改动开发默认最便宜档 light', () => {
  assert.deepEqual(TIERS, ['light', 'standard', 'heavy']);
  assert.equal(nodeTier(node(['src/a.mjs']), 'dev'), 'light');
  assert.equal(nodeTier(node(['src/a.mjs', 'test/a.test.mjs']), 'dev'), 'light');
});

test('按改动范围推断：3–6 个文件 standard，更多 heavy', () => {
  assert.equal(nodeTier(node(['a', 'b', 'c'].map(f => `src/${f}.mjs`)), 'dev'), 'standard');
  assert.equal(nodeTier(node(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(f => `src/${f}.mjs`)), 'dev'), 'heavy');
});

test('节点显式 complexity 优先于推断；非法值忽略并回落推断', () => {
  assert.equal(nodeTier(node(['a', 'b', 'c', 'd', 'e', 'f', 'g'], { complexity: 'light' }), 'dev'), 'light');
  assert.equal(nodeTier(node(['src/a.mjs'], { complexity: 'heavy' }), 'dev'), 'heavy');
  assert.equal(nodeTier(node(['src/a.mjs'], { complexity: 'huge' }), 'dev'), 'light');
});

test('审阅底线：审阅至少 standard，不为省钱降低审阅质量', () => {
  assert.equal(nodeTier(node(['src/a.mjs']), 'review'), 'standard');
  assert.equal(nodeTier(node(['src/a.mjs'], { complexity: 'light' }), 'review'), 'standard');
});

test('资金/数据/安全节点：开发至少 standard，审阅 heavy（显式 risk 或敏感路径）', () => {
  const flagged = node(['src/a.mjs'], { risk: ['funds'] });
  assert.equal(nodeTier(flagged, 'dev'), 'standard');
  assert.equal(nodeTier(flagged, 'review'), 'heavy');
  for (const file of ['src/payment.mjs', 'src/auth/session.mjs', 'db/migrations/001.sql', 'src/ledger.mjs', 'src/credential-store.mjs']) {
    assert.equal(nodeTier(node([file]), 'review'), 'heavy', file);
    assert.equal(nodeTier(node([file], { complexity: 'light' }), 'dev'), 'standard', file);
  }
  assert.equal(nodeTier(node(['src/author-list.mjs']), 'review'), 'standard', '不能把 author 误判为 auth');
  for (const file of ['src/paymentService.ts', 'src/AuthProvider.tsx', 'src/userAuth.ts', 'src/authentication.mjs', 'src/password-reset.mjs', '.env.local']) {
    assert.equal(nodeTier(node([file]), 'review'), 'heavy', file);
  }
});

test('整合审阅节点（空文件、以 dev 派发）固定 heavy，不被判成最便宜档', () => {
  const ir = { id: 'integration-review', depends_on: ['a'], contract: { input: 'i', output: 'o', error_behavior: 'e', acceptance_example: 'a', files: [] } };
  assert.equal(nodeTier(ir, 'dev'), 'heavy');
  assert.equal(nodeTier({ ...ir, id: 'final-check', integration_review: true }, 'dev'), 'heavy');
});

test('升档：light→standard→heavy，heavy 封顶；升档不低于底线', () => {
  assert.equal(bumpTier('light', 1), 'standard');
  assert.equal(bumpTier('light', 2), 'heavy');
  assert.equal(bumpTier('heavy', 3), 'heavy');
  assert.equal(bumpTier('standard', 0), 'standard');
  assert.equal(nodeTier(node(['src/a.mjs']), 'dev', { bump: 1 }), 'standard');
  assert.equal(nodeTier(node(['src/a.mjs']), 'review', { bump: 1 }), 'standard', '先升档再套底线，不叠加');
  assert.equal(nodeTier(node(['src/a.mjs']), 'review', { bump: 2 }), 'heavy');
});

test('分档开关：缺文件/坏文件/非法档位都视为未启用（保持旧事件类型）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tier-'));
  assert.deepEqual([...loadEnabledTiers(dir)], []);
  writeFileSync(path.join(dir, 'dag-tiers.json'), 'not json');
  assert.deepEqual([...loadEnabledTiers(dir)], []);
  writeFileSync(path.join(dir, 'dag-tiers.json'), JSON.stringify({ enabled: ['light', 'bogus', 'heavy'] }));
  assert.deepEqual([...loadEnabledTiers(dir)].sort(), ['heavy', 'light']);
  assert.deepEqual([...loadEnabledTiers(undefined)], []);
});

const recorder = () => { const calls = []; return { calls, request: async (cfg, p, opts = {}) => { calls.push({ p, ...opts }); return { event: calls.length }; } }; };
const run = { runId: 'r1', project: '/p/My Project', nodeId: 'n1', role: 'dev', generation: 1, attempt: 1 };

test('派发：档位已启用时事件类型带档位后缀，detail 记录档位；未启用时保持原类型', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tier-'));
  writeFileSync(path.join(dir, 'dag-tiers.json'), JSON.stringify({ enabled: ['light'] }));
  const { calls, request } = recorder();
  const hub = createHubAdapter({ config: { root: dir }, request });
  await hub.dispatch({ run, slot: 1, worktree: '/w', branch: 'b', expectedAdvanceId: 'e', tier: 'light', prompt: 'p' });
  await hub.dispatch({ run, slot: 1, worktree: '/w', branch: 'b', expectedAdvanceId: 'e', tier: 'heavy', prompt: 'p' });
  await hub.dispatch({ run, slot: 1, worktree: '/w', branch: 'b', expectedAdvanceId: 'e', prompt: 'p' });
  assert.equal(calls[0].body.type, 'dag.my-project.dev.light');
  assert.equal(JSON.parse(calls[0].body.detail).tier, 'light');
  assert.equal(calls[1].body.type, 'dag.my-project.dev', 'heavy 未启用：回落原类型，不派到不存在的规则');
  assert.equal(JSON.parse(calls[1].body.detail).tier, 'heavy');
  assert.equal(calls[2].body.type, 'dag.my-project.dev');
  const long = dagEventType('/p/' + 'x'.repeat(200), 'review.standard');
  assert.ok(long.length <= 64 && long.endsWith('.review.standard'));
});

test('控制器：首次派发按节点档位，审阅至少 standard', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick();
  assert.equal(s.hub.last('a').tier, 'light');
  s.claimAll(); s.receipt('a', 'dev', 'done');
  await s.ctl.tick(); await s.ctl.tick();
  assert.equal(s.hub.last('a', 'review').tier, 'standard');
});

test('控制器：失败 3 次换打法时默认升一档并留痕', async () => {
  const s = setup([mkNode('a')]);
  await s.ctl.tick();
  for (let i = 0; i < 3; i++) {
    s.claimAll(); s.receipt('a', 'dev', 'failed');
    await s.ctl.tick();
  }
  assert.equal(s.runOf('a').generation, 2);
  assert.equal(s.hub.last('a').tier, 'standard');
  const change = s.ctl.snapshot().approachChanges.find(c => c.nodeId === 'a');
  assert.equal(change.tier, 'standard');
  assert.match(change.reason, /升/);
});
