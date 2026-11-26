// 回归（节点 serial-chain-detail-restore，2026-11-25；fix6 project-ring-web-parity 2026-11-26 改写）：
// 串行链详情曾在 #316 重写总览时整块丢失。fix6 起串行链与网页版一样画成节点环，详情改为
// 「点扇区 → 环下方节点详情」+「查看运行详情 →」就地展开按执行顺序分组的全部节点。
// 本文件守住：串行链必定有详情入口、节点清单/当前节点/整体进度、空态、渲染异常就地重试，且全页只有一套实现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, byAttr, byClass, textOf, walk } from './mobile-dag-ring-fake-dom.test.mjs';

installFakeDom();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildProjectRingCard, buildRingNodePanel } = await import('../mobile/app/www/pages/core.mjs');
const { buildProjectProgress } = await import('../mobile/src/features/dag-ring/index.mjs');

const snapshotWith = chains => ({
  available: { state: true, rules: true, 'dag-runs': true, 'serial-progress': true, archive: true },
  errors: {}, state: { runs: [], cards: [], lines: [] }, rules: { rules: [] },
  serial: { chains }, dagRuns: [], archive: [],
});
const HEALTH = {
  sourceFile: 'health-serial.json', project: '/work/健康核心', percent: 67, current: { id: 'd1' },
  order: ['a1', 'd1', 'd2'],
  nodes: [
    { id: 'a1', title: '环境检查', status: 'done', percent: 100 },
    { id: 'd1', title: '内存采样观测 14 天', status: 'in_progress', percent: 2, summary: '第 3 天' },
    { id: 'd2', title: '双桥验证', status: 'pending', percent: 0 },
  ],
};
const cardOf = chain => buildProjectProgress(snapshotWith([chain])).cards[0];

test('串行链详情：默认选中当前节点，「查看运行详情」就地展开分组节点清单，再点收起', () => {
  const card = cardOf(HEALTH);
  const el = buildProjectRingCard(card, { defaultId: card.defaultId });
  assert.equal(textOf(byClass(el, 'pring-pct')[0]), '67%', '整体进度');
  const detail = byAttr(el, 'data-ring-detail')[0];
  assert.equal(detail.attrs['data-ring-detail'], 'd1', '默认详情 = 当前节点');
  assert.match(textOf(detail), /第 3 天/, '一句话进展来自真实摘要');
  const panel = byAttr(el, 'data-ring-run-detail')[0];
  assert.equal(panel.hidden, true, '运行详情默认折叠');
  const open = walk(el).find(n => n.textContent === '查看运行详情 →');
  open.click();
  assert.equal(panel.hidden, false);
  assert.deepEqual(byAttr(panel, 'data-ring-run-row').map(r => r.attrs['data-ring-run-row']), ['a1', 'd1', 'd2']);
  assert.match(textOf(panel), /当前 · 1 个节点/, '当前节点单独成组');
  assert.match(textOf(panel), /内存采样观测 14 天 · 进行中 · 2%/);
  open.click();
  assert.equal(panel.hidden, true, '再点收起');
});

test('串行链无节点明细：不画空环、不编造节点，如实空态', () => {
  const progress = buildProjectProgress(snapshotWith([{ ...HEALTH, nodes: [], order: [] }]));
  assert.equal(progress.cards.length, 0);
  assert.match(progress.reason, /暂无活跃项目/);
});

test('节点详情渲染异常就地重试，不把整页拖垮', () => {
  const card = cardOf(HEALTH);
  let reads = 0;
  const sector = { ...card.nodes[1], get agent() { reads += 1; if (reads === 1) throw new Error('执行者暂时不可用'); return 'Codex'; } };
  const panel = buildRingNodePanel(sector, card, {});
  assert.match(textOf(panel), /节点详情加载失败：执行者暂时不可用/);
  byAttr(panel, 'data-ring-detail-retry')[0].click();
  assert.equal(byAttr(panel, 'data-ring-detail-retry').length, 0);
  assert.match(textOf(panel), /Codex/);
});

test('全页只有一套串行链详情实现：环卡片内创建，不再有旧的列表行入口', () => {
  const src = readFileSync(path.join(ROOT, 'mobile', 'app', 'www', 'pages', 'core.mjs'), 'utf8');
  const css = readFileSync(path.join(ROOT, 'mobile', 'app', 'www', 'pages', 'core.css'), 'utf8');
  assert.equal((src.match(/function buildSerialRunDetail/g) || []).length, 1);
  assert.doesNotMatch(src, /data-chain-entry|function renderProjectRow|buildChainDetail/, '旧列表行实现已移除');
  assert.match(css, /\.pring-run-detail\[hidden\]\s*\{\s*display:\s*none/, '收起时隐藏');
});
