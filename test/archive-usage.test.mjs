import test from 'node:test';
import assert from 'node:assert/strict';
import { sumRunUsage, attachArchiveUsage } from '../src/archive-usage.mjs';
import { archiveUsageText } from '../public/archive-view.mjs';

test('sumRunUsage 只累加上报值，费用全缺失保持 null', () => {
  assert.deepEqual(sumRunUsage([{ usage: { input: 10, output: 5, cost: 0.5 } }, { usage: { input: 1, output: 1 } }, {}]),
    { input: 11, output: 6, tokens: 17, cost: 0.5, rounds: 3, missingCostRounds: 2, tokenReported: true });
  assert.equal(sumRunUsage([{}, {}]).cost, null);
  assert.equal(sumRunUsage([{}]).tokens, 0);
});

test('attachArchiveUsage：串行读台账、DAG 汇总并按 runId 缓存、失败给 null', async () => {
  let calls = 0;
  const items = [{ kind: 'serial', source: 's' }, { kind: 'dag', runId: 'run-cache-1' }, { kind: 'dag', runId: 'run-bad' }];
  const opts = { chainUsageFor: () => ({ tokens: 9 }), dagUsageFor: async item => { calls += 1; if (item.runId === 'run-bad') throw new Error('x'); return { tokens: 3 }; } };
  const first = await attachArchiveUsage(items, opts);
  await attachArchiveUsage(items, opts);
  assert.equal(first[0].usage.tokens, 9);
  assert.equal(first[1].usage.tokens, 3);
  assert.equal(first[2].usage, null);
  assert.equal(calls, 3, 'run-cache-1 第二次走缓存，失败的不缓存（再试一次）');
});

test('archiveUsageText 如实标注未上报，不当 0', () => {
  assert.equal(archiveUsageText(null), '用量未上报');
  assert.equal(archiveUsageText({ tokens: 0, cost: null }), '费用未上报 · Token 未上报');
  assert.match(archiveUsageText({ tokens: 1500, input: 1000, output: 500, cost: 2.5, missingCostRounds: 4 }), /费用 \$2\.50（4 轮未上报费用，实际更高） · Token 1,500（入 1,000 \/ 出 500）/);
});

test('sumRunUsage：不需要模型的轮次不算漏报费用', () => {
  const sum = sumRunUsage([{ usage: { cost: 1 } }, { usageNoModel: true }, { usage: { input: 5 } }]);
  assert.equal(sum.missingCostRounds, 1);
});
