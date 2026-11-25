// 回归（节点 serial-chain-detail-restore，2026-11-25）：PR #315 在 renderProjectRow 加的
// 「串行链详情」toggle + 节点清单面板，被 #316 重写总览时整块删除（真机只剩一行百分比）。
// 本文件守住：详情入口恢复、节点清单/当前环节/整体进度、空态、渲染异常就地重试，
// 且恢复后的入口与 #316 的活跃 DAG 交互环并存、互不抢占。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 最小 DOM：core.mjs 的 node() 只用 createElement + 这些属性/方法，足够驱动详情面板。
function makeNode(tag) {
  return {
    tag, className: '', textContent: '', hidden: false,
    attrs: {}, children: [], handlers: {},
    setAttribute(key, value) {
      this.attrs[key] = String(value);
      if (key === 'hidden') this.hidden = true;
    },
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); },
    click() { for (const handler of this.handlers.click || []) handler(); },
    appendChild(child) { this.children.push(child); return child; },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
  };
}
globalThis.document = { createElement: makeNode };
const { buildChainDetail } = await import('../mobile/app/www/pages/core.mjs');

function walk(element, out = []) {
  out.push(element);
  for (const child of element.children || []) walk(child, out);
  return out;
}
const byAttr = (root, key) => walk(root).filter(el => el.attrs?.[key] !== undefined);
const byClass = (root, cls) => walk(root).filter(el => String(el.className || '').split(/\s+/).includes(cls));

const chainItem = (detail, runId = 'health-serial.json') => ({
  runId,
  projectLabel: '健康核心（串行链）',
  statusLabel: '67%',
  nodeCount: 3,
  dagEntry: null,
  chainEntry: { label: '串行链详情' },
  chainDetail: detail,
});

test('串行链详情入口：toggle 点开渲染节点清单、当前环节与整体进度', () => {
  const item = chainItem({
    percent: 67, empty: false, reason: null, nodes: [
      { id: 'a1', title: '环境检查', status: 'done', percent: 100, summary: '', isCurrent: false },
      { id: 'd1', title: '内存采样观测 14 天', status: 'in_progress', percent: 2, summary: '第 3 天', isCurrent: true },
      { id: 'd2', title: '双桥验证', status: 'queued', percent: 0, summary: '', isCurrent: false },
    ],
  });
  const { toggle, panel } = buildChainDetail(item);
  assert.equal(toggle.textContent, '串行链详情');
  assert.equal(toggle.attrs['data-chain-entry'], 'health-serial.json');
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.equal(panel.attrs['data-chain-detail'], 'health-serial.json');
  assert.equal(panel.hidden, true, '默认折叠，与 #316 环卡片并存不抢占首屏');

  toggle.click();
  assert.equal(panel.hidden, false);
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  assert.equal(byClass(panel, 'core-meta')[0].textContent, '整体进度 67%');
  const lines = byAttr(panel, 'data-chain-node');
  assert.deepEqual(lines.map(line => line.attrs['data-chain-node']), ['a1', 'd1', 'd2']);
  assert.match(lines[0].textContent, /环境检查/);
  assert.match(lines[0].textContent, /100%/);
  assert.match(lines[1].textContent, /当前环节/, '当前节点标注当前环节');
  assert.match(lines[1].textContent, /内存采样观测 14 天/);
  assert.match(lines[1].textContent, /2%/);
  assert.match(lines[1].textContent, /第 3 天/, '一句话进展来自真实摘要');

  toggle.click();
  assert.equal(panel.hidden, true, '再点收起');
  assert.equal(toggle.attrs['aria-expanded'], 'false');
});

test('详情为空显示如实空态，不编造节点', () => {
  const { toggle, panel } = buildChainDetail(chainItem({
    percent: 0, empty: true, reason: '该串行链暂无节点明细', nodes: [],
  }, 'empty.json'));
  toggle.click();
  assert.equal(byClass(panel, 'hint')[0].textContent, '该串行链暂无节点明细');
  assert.equal(byAttr(panel, 'data-chain-node').length, 0);
  assert.equal(byAttr(panel, 'data-chain-retry').length, 0);
});

test('渲染异常就地重试，不把整页拖垮', () => {
  let reads = 0;
  const detail = {
    percent: 50, empty: false, reason: null,
    get nodes() {
      reads += 1;
      if (reads === 1) throw new Error('节点清单暂时不可用');
      return [{ id: 'n1', title: '环境检查', status: 'in_progress', percent: 50, summary: '采样中', isCurrent: true }];
    },
  };
  const { toggle, panel } = buildChainDetail(chainItem(detail, 'retry.json'));
  toggle.click();
  assert.equal(byClass(panel, 'hint')[0].textContent, '节点清单暂时不可用');
  const retry = byAttr(panel, 'data-chain-retry')[0];
  assert.ok(retry, '异常时提供就地重试按钮');
  retry.click();
  assert.equal(byAttr(panel, 'data-chain-retry').length, 0);
  assert.equal(byAttr(panel, 'data-chain-node').length, 1);
  assert.match(byClass(panel, 'core-meta')[0].textContent, /整体进度 50%/);
});

test('恢复的详情入口与 #316 活跃 DAG 环卡片并存，样式随原 #315 合同保留', () => {
  const src = readFileSync(path.join(ROOT, 'mobile', 'app', 'www', 'pages', 'core.mjs'), 'utf8');
  const css = readFileSync(path.join(ROOT, 'mobile', 'app', 'www', 'pages', 'core.css'), 'utf8');
  const row = src.slice(src.indexOf('function renderProjectRow'), src.indexOf('function renderOverview'));
  assert.match(row, /item\.chainEntry && item\.chainDetail/, '串行链行恢复详情入口');
  assert.match(row, /buildChainDetail\(item\)/, '详情面板由导出的 buildChainDetail 渲染');
  assert.match(src, /buildDagRingCard\(item, card/, '#316 活跃 DAG 环路径仍在');
  assert.match(src, /else\s+refs\.projects\.appendChild\(renderProjectRow\(item\)\)/, '无环/无 dagEntry 才走行渲染');
  assert.match(css, /\.core-chain-detail\s*\{/, '详情面板布局样式保留');
  assert.match(css, /\.core-chain-detail\[hidden\]\s*\{\s*display:\s*none/, '收起时隐藏');
});

// rework 回归（review #323 P2）：#324 曾把同一详情面板内联进 renderProjectRow，
// 与本节点恢复的导出实现并存会在一条串行链上出现两个「串行链详情」按钮。
test('详情面板只创建一份，行渲染不内联重复实现（#324 去重）', () => {
  const src = readFileSync(path.join(ROOT, 'mobile', 'app', 'www', 'pages', 'core.mjs'), 'utf8');
  const row = src.slice(src.indexOf('function renderProjectRow'), src.indexOf('function renderOverview'));
  assert.doesNotMatch(row, /className: 'core-chain-detail'/, '详情面板只在 buildChainDetail 内创建');
  assert.equal((src.match(/data-chain-entry/g) || []).length, 1, '全页只有一个串行链详情入口');
  assert.equal((row.match(/buildChainDetail\(item\)/g) || []).length, 1, '行渲染只挂载一份详情面板');
});
