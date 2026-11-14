import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MAX_DEPTH = 4;
const CACHE_TTL_MS = 30000;
let cache = { key: null, at: 0, value: [] };
const SKIP_DIRS = new Set(['node_modules', 'Library', 'Pods', 'vendor']);
// 临时产物命名约定：探针/排练/工作流状态目录与标记待删的目录不是可调度项目
const JUNK_NAME = /(待删|-(workflow-state|probe|rehearsal)(-r\d+)?$)/;

export function discoverGitProjects({ roots = [], rules = [] } = {}) {
  const cacheKey = roots.join('|');
  if (cache.key === cacheKey && Date.now() - cache.at < CACHE_TTL_MS) {
    return mergeRuleProjects(cache.value, rules);
  }
  const found = new Map();
  const consider = dir => {
    if (!dir || /[\x00-\x1f\x7f]/.test(dir)) return false;
    if (JUNK_NAME.test(path.basename(dir))) return false;
    if (!existsSync(path.join(dir, '.git'))) return false;
    const key = path.resolve(dir);
    if (!found.has(key)) found.set(key, { name: path.basename(key), path: key });
    return true;
  };
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || consider(dir)) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots) walk(path.resolve(root), 0);
  const discovered = [...found.values()];
  cache = { key: cacheKey, at: Date.now(), value: discovered };
  return mergeRuleProjects(discovered, rules);
}

function mergeRuleProjects(discovered, rules) {
  const found = new Map(discovered.map(project => [project.path, project]));
  for (const rule of rules || []) {
    const cwd = rule?.cwd;
    if (!cwd || /[\x00-\x1f\x7f]/.test(cwd)) continue;
    if (!existsSync(path.join(cwd, '.git'))) continue;
    const key = path.resolve(cwd);
    if (!found.has(key)) found.set(key, { name: path.basename(key), path: key });
  }
  return dedupeShallowest([...found.values()]).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function dedupeShallowest(projects) {
  const byName = new Map();
  for (const project of projects) {
    const depth = project.path.split(path.sep).length;
    const current = byName.get(project.name);
    if (!current || depth < current.depth) byName.set(project.name, { project, depth });
  }
  return [...byName.values()].map(entry => entry.project);
}

const DOC_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'Readme.md', 'readme.md'];
const DOC_MAX_BYTES = 8 * 1024;

export function readProjectDocs(dir) {
  if (!dir || !existsSync(dir)) return `未找到该项目资料（${dir || '无路径'} 不存在或不可读）。`;
  const sections = [];
  for (const name of DOC_FILES) {
    const file = path.join(dir, name);
    try {
      if (!statSync(file).isFile() || statSync(file).size > DOC_MAX_BYTES) continue;
      const text = readFileSync(file, 'utf8').trim();
      if (text) sections.push(`----- ${name} -----\n${text}`);
    } catch { /* 缺失或不可读则跳过 */ }
  }
  return sections.length ? sections.join('\n\n') : `未找到该项目资料（${dir} 下没有 AGENTS.md、CLAUDE.md 或 README）。`;
}
