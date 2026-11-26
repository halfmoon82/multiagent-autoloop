// fix10 / issue #356（2026-11-26 主人定）：所有环路径统一 segmentColor(kind, wave)。
// 回归：fix6 移植环时串行链与归档占位环误用 SERIAL_COLORS 绿色系十六进制色板，
// 覆盖了 segmentColor(kind, wave) 的按波次定色，导致总览环全绿、归档并行 DAG 丢失波次多彩。
// 本文件先于实现写：当前代码必须 FAIL（RED），修复后全绿（GREEN）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSerialRingView, buildDagRunRingView, buildArchivedRings, segmentColor, completionOf,
} from '../mobile/src/features/dag-ring/progress.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 从 hsl(...) 取色相，便于断言「波次各异 / 绿系回落」而不绑定具体实现字符串。
const hueOf = color => {
  const match = /^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/.exec(String(color || ''));
  assert.ok(match, `期望 hsl 色值，实际 ${color}`);
  return Number(match[1]);
};

const SERIAL_CHAIN = {
  sourceFile: 'x-serial.json', project: '/work/x', percent: 50,
  order: ['a', 'b', 'c'], current: { id: 'b' },
  nodes: [
    { id: 'a', status: 'done' },
    { id: 'b', status: 'in_progress' },
    { id: 'c', status: 'pending' },
  ],
};

const dagRun = (waves) => ({
  runId: 'dagrun-fix10', project: '/work/x', planId: 'fix10', status: 'running',
  mobileSummary: {
    runId: 'dagrun-fix10', planId: 'fix10',
    ring: {
      summary: {},
      nodes: waves.map((wave, index) => ({
        id: `n${index + 1}`, title: `节点 ${index + 1}`, statusKind: index === 0 ? 'done' : 'active', wave,
      })),
    },
  },
});

test('RED 1 串行链：每个扇区走 segmentColor(kind, null)，绿系 hsl，不再用 SERIAL_COLORS 十六进制', () => {
  const nodes = buildSerialRingView(SERIAL_CHAIN).nodes;
  assert.equal(nodes.length, 3);
  for (const node of nodes) {
    assert.equal(node.color, segmentColor(node.status.kind, null), `节点 ${node.id} 颜色应等于 segmentColor(kind, null)`);
    assert.match(node.color, /^hsl\(\d+, 52%, \d+%\)$/, '统一为 hsl 波次配色公式');
    assert.equal(hueOf(node.color), 168, '串行 wave=null → 色相 168 绿系（与网页版一致）');
    assert.equal(node.wave, null, '串行链节点仍不带波次');
  }
  // 完成度驱动明度：done 最深、pending 最浅。
  assert.ok(hueOf(nodes[0].color) === hueOf(nodes[2].color));
  const lightness = c => Number(/^hsl\(\d+, 52%, (\d+)%\)$/.exec(c)[1]);
  assert.ok(lightness(nodes[0].color) < lightness(nodes[2].color), 'done 明度低于 pending');
  assert.equal(nodes[0].completion, completionOf('done'));
});

test('RED 2 归档无明细占位环：同样走 segmentColor，不再用 SERIAL_COLORS 十六进制', () => {
  // archive 里的 DAG 已归档且运行记录不在 dagRuns 中 → 走占位环路径。
  const archived = buildArchivedRings([
    { taskId: 'dag:/work/x:gone', kind: 'dag', source: 'gone', runId: 'dagrun-gone', project: '/work/x', nodes: { done: 3, total: 3 }, reason: 'completed' },
  ], { dagRuns: [] });
  const item = archived.items[0];
  assert.equal(item.nodes.length, 3);
  for (const node of item.nodes) {
    assert.equal(node.color, segmentColor(node.status.kind, null), `占位节点 ${node.id} 颜色应等于 segmentColor(kind, null)`);
    assert.match(node.color, /^hsl\(/, '占位环用统一 hsl 配色，不再是 #157a65 等十六进制');
  }
});

test('RED 3 源码守门：progress.mjs 移除 SERIAL_COLORS 状态色板，所有颜色来自 segmentColor', () => {
  const src = readFileSync(path.join(ROOT, 'mobile', 'src', 'features', 'dag-ring', 'progress.mjs'), 'utf8');
  assert.doesNotMatch(src, /SERIAL_COLORS/, 'SERIAL_COLORS 绿色状态色板必须移除');
  assert.match(src, /segmentColor\(status\.kind, null\)/, '串行链显式按 wave=null 回落绿系');
  assert.match(src, /segmentColor\(kind, null\)/, '归档占位环显式按 wave=null 回落绿系');
  assert.match(src, /waveHue/, '保留波次定色函数');
});

test('RED 4 活跃并行 DAG：按波次多彩，不同波次色相各异', () => {
  const view = buildDagRunRingView(dagRun([1, 2, 3, 4]));
  const hues = view.nodes.map(node => hueOf(node.color));
  assert.equal(new Set(hues).size, 4, '四个波次四种色相（多彩）');
  view.nodes.forEach((node, index) => {
    assert.equal(node.color, segmentColor(node.status.kind, index + 1));
  });
});

test('RED 5 归档并行 DAG：有运行记录时按波次多彩，与活跃路径同一口径', () => {
  const run = dagRun([1, 2, 3]);
  const archived = buildArchivedRings([
    { taskId: 'dag:/work/x:fix10', kind: 'dag', source: 'fix10', runId: 'dagrun-fix10', project: '/work/x', nodes: { done: 3, total: 3 }, reason: 'completed' },
  ], { dagRuns: [run] });
  const item = archived.items[0];
  const hues = item.nodes.map(node => hueOf(node.color));
  assert.equal(new Set(hues).size, 3, '归档并行 DAG 扇区色相按波次各异（不再全绿）');
  item.nodes.forEach((node, index) => {
    assert.equal(node.color, segmentColor(node.status.kind, index + 1));
  });
});

test('RED 6 无 wave 数据回落绿系，不报错', () => {
  const run = dagRun([undefined, null, 0]);
  const view = buildDagRunRingView(run);
  assert.equal(view.nodes.length, 3);
  for (const node of view.nodes) {
    assert.equal(hueOf(node.color), 168, '缺波次按网页口径回落绿系色相 168');
  }
});
