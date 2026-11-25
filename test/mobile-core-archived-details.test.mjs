// 节点 archived-dag-details（2026-11-25）：App 已归档区显示创建日期、摘要、Token 与费用。
// 口径与网页 /api/archive、public/archive-view.mjs archiveUsageText 同源：只信上报值，不编造。
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSnapshot } from '../mobile/src/core/snapshot.mjs';
import { buildOverview } from '../mobile/src/core/pages.mjs';
import { archiveUsageLabel, archiveCreatedLabel } from '../mobile/src/core/contract.mjs';

const NOW = new Date('2026-11-25T12:00:00+08:00');
const dagRun = (runId, status = 'done') => ({ runId, project: '/work/p', planId: `plan-${runId}`, status, nodes: [{ id: 'a' }] });
// 与 core.mjs load() 同口径：assembleSnapshot 之后单独合并 archive 读取结果。
const base = ({ archive, archiveError, ...extra } = {}) => {
  const snap = assembleSnapshot({
    state: { runs: [], cards: [] }, projects: { projects: [] }, rules: { rules: [] },
    'dag-runs': { runs: [dagRun('r-usage'), dagRun('r-token'), dagRun('r-none')] },
    'serial-progress': { chains: [] }, ...extra,
  });
  const ok = Boolean(archive && Array.isArray(archive.archived));
  return {
    ...snap,
    available: { ...snap.available, archive: ok },
    errors: ok ? snap.errors : { ...snap.errors, archive: archiveError || '归档数据缺失' },
    archive: ok ? archive.archived : null,
  };
};
const entry = (runId, extra = {}) => ({ kind: 'dag', runId, source: `plan-${runId}`, project: '/work/p', title: `标题-${runId}`, reason: 'completed', nodes: { done: 1, total: 1 }, createdAt: '2026-11-20T10:00:00+08:00', ...extra });
const archive = { archived: [
  entry('r-usage', { usage: { input: 100, output: 50, tokens: 150, cost: 1.5 } }),
  entry('r-token', { usage: { input: 100, output: 50, tokens: 150, cost: null } }),
  entry('r-none', { usage: null, createdAt: null, title: '' }),
] };

test('archiveUsageLabel 三种上报口径', () => {
  assert.equal(archiveUsageLabel({ tokens: 1500, input: 1000, output: 500, cost: 1.5 }), '费用 $1.50 · Token 1,500');
  assert.equal(archiveUsageLabel({ tokens: 1500, cost: null }), 'Token 1,500 · 费用未上报');
  assert.equal(archiveUsageLabel(null), '用量未上报');
  assert.equal(archiveUsageLabel({ tokens: 0, cost: null }), '用量未上报');
});

test('archiveCreatedLabel：有日期显示日期，缺失/非法如实写未记录', () => {
  assert.match(archiveCreatedLabel('2026-11-20T10:00:00+08:00'), /^创建于 2026-11-\d\d$/);
  assert.equal(archiveCreatedLabel(null), '创建日期未记录');
  assert.equal(archiveCreatedLabel('garbage'), '创建日期未记录');
});

test('总览已归档行带 archiveDetail：日期、摘要、用量（三种口径 + 单项缺失默认文案）', () => {
  const items = buildOverview(base({ archive }), { now: NOW }).projects.items;
  const by = id => items.find(i => i.runId === id);
  assert.equal(by('r-usage').archived, true);
  assert.equal(by('r-usage').archiveDetail.summary, '标题-r-usage');
  assert.match(by('r-usage').archiveDetail.createdLabel, /^创建于 2026-11-/);
  assert.equal(by('r-usage').archiveDetail.usageLabel, '费用 $1.50 · Token 150');
  assert.equal(by('r-token').archiveDetail.usageLabel, 'Token 150 · 费用未上报');
  assert.equal(by('r-none').archiveDetail.usageLabel, '用量未上报');
  assert.equal(by('r-none').archiveDetail.summary, '暂无摘要');
  assert.equal(by('r-none').archiveDetail.createdLabel, '创建日期未记录');
});

test('串行链归档行按链词干匹配；接口独有的归档任务补成已归档行', () => {
  const snap = base({
    'dag-runs': { runs: [] },
    'serial-progress': { chains: [{ sourceFile: 'hc-serial.json', project: '/work/p', percent: 100, nodes: [{ id: 'n' }] }] },
    archive: { archived: [
      { kind: 'serial', source: 'hc', project: '/work/p', title: '健康核心', reason: 'completed', nodes: { done: 1, total: 1 }, createdAt: '2026-11-01T00:00:00Z', usage: { tokens: 10, cost: 0.2 } },
      entry('orphan', { usage: null }),
    ] },
  });
  const items = buildOverview(snap, { now: NOW }).projects.items;
  const chain = items.find(i => i.runId === 'hc-serial.json');
  assert.equal(chain.archiveDetail.summary, '健康核心');
  assert.equal(chain.archiveDetail.usageLabel, '费用 $0.20 · Token 10');
  const orphan = items.find(i => i.runId === 'orphan');
  assert.ok(orphan.archived);
  assert.equal(orphan.archiveDetail.usageLabel, '用量未上报');
});

test('archive 读取失败：已归档行仍在，不带编造详情，页面给出重试原因', () => {
  const page = buildOverview(base({ archive: undefined, archiveError: '网络断开' }), { now: NOW }).projects;
  assert.equal(page.archiveError, '网络断开');
  assert.ok(page.items.every(i => !i.archiveDetail));
});
