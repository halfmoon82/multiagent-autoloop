// 底部「已归档的任务环」区：只读展示，跟随顶部统一的项目筛选。
// 自包含挂载（#archive-section），不依赖 app.mjs 的渲染循环，避免与环形视图互相打断。
import { projectName } from './format.mjs';

const REFRESH_MS = 10000;
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
const REASON = { completed: { label: '全部完成', cls: 'good' }, cancelled: { label: '已取消', cls: 'warn' }, abandoned: { label: '已取消', cls: 'warn' } };

let items = [];
let timer = null;

function currentFilter() { const select = $('project-filter'); return select ? String(select.value || '') : ''; }

function summaryLine(list) {
  const done = list.filter(item => item.reason === 'completed').length;
  const cancelled = list.length - done;
  return cancelled ? `全部完成 ${done} · 已取消 ${cancelled}` : `全部完成 ${done}`;
}

function rowFor(item) {
  const row = el('div', 'arch-row');
  const title = el('div', 'arch-task');
  title.append(el('div', 'arch-task-name', item.title));
  const source = item.kind === 'dag' ? `${item.source} · ${item.nodes.total} 节点` : `${item.source}-serial · ${item.nodes.total} 节点`;
  title.append(el('div', 'arch-task-meta', source));
  const pct = el('div', 'arch-pct', `${item.percent}%`);
  const reason = el('span', `status ${REASON[item.reason]?.cls || ''}`, REASON[item.reason]?.label || item.reason);
  const reasonBox = el('div', 'arch-reason'); reasonBox.append(reason);
  const date = el('div', 'arch-date', item.archivedAt);
  row.append(title, pct, reasonBox, date);
  return row;
}

function render() {
  const host = $('archive-section');
  if (!host) return;
  const filter = currentFilter();
  if (!items.length && !filter) { host.replaceChildren(); host.hidden = true; return; }
  host.hidden = false;
  const list = filter ? items.filter(item => projectName(item.project) === filter) : items;
  const wasOpen = host.querySelector('details')?.open ?? false;
  const details = el('details', 'arch-section');
  details.open = wasOpen;
  const summary = el('summary', 'arch-summary');
  summary.append(el('span', 'arch-title', '已归档的任务环'));
  const count = el('span', 'status'); count.textContent = String(list.length); summary.append(count);
  summary.append(el('span', 'arch-sub', list.length ? summaryLine(list) : '该项目暂无归档'));
  if (filter) { const scope = el('span', 'arch-scope', `筛选：${filter}`); const spacer = el('span', 'arch-spacer'); summary.append(spacer, scope); }
  details.append(summary);
  const body = el('div', 'arch-body');
  if (!list.length) {
    body.append(el('div', 'arch-empty', filter ? '该项目还没有已归档的任务环。' : '还没有已归档的任务环。'));
  } else if (filter) {
    for (const item of list) body.append(rowFor(item));
  } else {
    const groups = new Map();
    for (const item of list) { const key = projectName(item.project); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
    for (const [name, rows] of groups) {
      const group = el('div', 'arch-group');
      group.append(el('div', 'arch-group-name', name));
      for (const item of rows) group.append(rowFor(item));
      body.append(group);
    }
  }
  details.append(body);
  host.replaceChildren(details);
}

async function load() {
  try {
    const response = await fetch('/api/archive');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    items = Array.isArray(data.archived) ? data.archived : [];
    render();
  } catch {
    const host = $('archive-section');
    if (host && !items.length) { host.hidden = true; }
  }
}

export function startArchiveView() { load(); if (!timer) timer = setInterval(load, REFRESH_MS); }
export function refreshArchiveView() { load(); }

if (typeof document !== 'undefined') {
  const boot = () => {
    if (!$('archive-section')) return;
    startArchiveView();
    const select = $('project-filter');
    if (select) select.addEventListener('change', render);
    const clear = $('clear-project-filter');
    if (clear) clear.addEventListener('click', () => setTimeout(render, 0));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
