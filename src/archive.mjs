// 归档判定（只读）：把「任务定义」聚成可归档的环。
// 任务 = 串行链文件词干 / DAG planId；run 只是执行记录，不单独成任务。
// 判定：全部节点 done → completed；已归档但没跑完 → abandoned；所有运行都取消 → cancelled。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { computeChainProgress } from './serial-progress.mjs';

const SERIAL_RE = /^([A-Za-z0-9_-]+)-serial\.json(?:\.done-(\d{4})(\d{2})(\d{2}))?$/;
const DAG_RUN_RE = /^dagrun-[A-Za-z0-9-]+\.json$/;
const MAX_BYTES = 256 * 1024;
const MAX_ITEMS = 500;
const TERMINAL_CANCEL = new Set(['cancelled', 'abandoned', 'blocked_unknown', 'unknown']);
const ACTIVE = new Set(['queued', 'claimed']);

const readJson = file => {
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
};

export function serialEntries(root) {
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    const match = SERIAL_RE.exec(name);
    if (!match) continue;
    const data = readJson(path.join(root, name));
    if (!data || typeof data !== 'object') continue;
    out.push({ sourceFile: name, stem: match[1], archivedAt: match[2] ? `${match[2]}-${match[3]}-${match[4]}` : null, data });
  }
  return out;
}

export function dagRuns(directory) {
  let names = [];
  try { names = readdirSync(directory); } catch { return []; }
  return names.filter(name => DAG_RUN_RE.test(name)).map(name => readJson(path.join(directory, name))).filter(Boolean);
}

const allDone = nodes => nodes.length > 0 && nodes.every(node => node?.status === 'done');

// 串行任务 → 归档条目（未完成且未归档返回 null，留给主视图）。
export function archiveSerial(entry, { now = new Date() } = {}) {
  const chain = entry?.data || {};
  const nodes = Object.values(chain.nodes || {});
  if (!nodes.length) return null;
  const done = nodes.filter(node => node?.status === 'done').length;
  const percent = nodes.length ? Math.round(computeChainProgress(chain).percent) : 0;
  const completed = allDone(nodes) || percent === 100;
  if (!completed && !entry.archivedAt) return null;
  const stamp = entry.archivedAt || String(chain.lastEventAt || chain.updatedAt || now.toISOString()).slice(0, 10);
  return {
    taskId: `serial:${entry.stem}`, kind: 'serial', source: entry.stem,
    project: String(chain.project || ''),
    title: String(chain.title || entry.stem),
    percent, nodes: { done, total: nodes.length },
    reason: completed ? 'completed' : 'abandoned',
    archivedAt: stamp,
  };
}

// DAG 任务 → 归档条目。只看计划级运行（nodeId === '__root__'），按 planId 归成一个任务。
export function archiveDag(runs, { titles = {}, now = new Date() } = {}) {
  const roots = runs.filter(run => run && run.nodeId === '__root__' && run.planId);
  const latest = new Map();
  for (const run of roots) {
    const key = String(run.planId);
    const prev = latest.get(key);
    const at = String(run.createdAt || '');
    const prevAt = String(prev?.createdAt || '');
    if (!prev || at > prevAt) latest.set(key, run);
  }
  const out = [];
  for (const [planId, run] of latest) {
    const status = String(run.status || '');
    if (ACTIVE.has(status)) continue;
    const total = Array.isArray(run.nodes) ? run.nodes.length : 0;
    if (!total) continue;
    const states = Object.values(run.publish?.nodes || {}).map(node => String(node?.state || ''));
    const done = states.length ? states.filter(state => state === 'done').length : (status === 'done' ? total : 0);
    const completed = status === 'done' && (done === total || !states.length);
    if (!completed && !TERMINAL_CANCEL.has(status)) continue;
    out.push({
      taskId: `dag:${planId}`, kind: 'dag', source: planId,
      project: String(run.project || ''),
      title: String(titles[planId] || planId),
      percent: Math.round((done / total) * 100), nodes: { done, total },
      reason: completed ? 'completed' : 'cancelled',
      archivedAt: String(run.finishedAt || run.updatedAt || run.createdAt || now.toISOString()).slice(0, 10),
    });
  }
  return out;
}

export function buildArchive({ serial = [], runs = [], titles = {}, now = new Date() } = {}) {
  const items = [
    ...serial.map(entry => archiveSerial(entry, { now })),
    ...archiveDag(runs, { titles, now }),
  ].filter(Boolean);
  const seen = new Set();
  return items
    .filter(item => (seen.has(item.taskId) ? false : seen.add(item.taskId)))
    .sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)) || String(a.title).localeCompare(String(b.title)))
    .slice(0, MAX_ITEMS);
}

// 计划标题（可选）：<project>/docs/dag-plans/<planId>.json 的 title，读不到就用 planId。
export function planTitles(projects = []) {
  const titles = {};
  for (const project of projects) {
    const dir = path.join(String(project || ''), 'docs', 'dag-plans');
    let names = [];
    try { names = readdirSync(dir).filter(name => name.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      const plan = readJson(path.join(dir, name));
      const planId = String(plan?.plan_id || name.replace(/\.json$/, ''));
      if (plan?.title) titles[planId] = String(plan.title).slice(0, 120);
    }
  }
  return titles;
}

export function readArchive({ root, projects = [], now = new Date() } = {}) {
  if (!root) return { archived: [] };
  const serial = serialEntries(root);
  const runs = dagRuns(path.join(root, 'dag-runs'));
  return { archived: buildArchive({ serial, runs, titles: planTitles(projects), now }) };
}
