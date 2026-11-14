import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const MAX_DEPTH = 4;
const CACHE_TTL_MS = 30000;
let cache = { key: null, at: 0, value: [] };
const SKIP_DIRS = new Set(['node_modules', 'Library', 'Pods', 'vendor']);

export function discoverGitProjects({ roots = [], rules = [] } = {}) {
  const cacheKey = roots.join('|');
  if (cache.key === cacheKey && Date.now() - cache.at < CACHE_TTL_MS) {
    return mergeRuleProjects(cache.value, rules);
  }
  const found = new Map();
  const consider = dir => {
    if (!dir || !existsSync(path.join(dir, '.git'))) return false;
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
    if (!cwd || !existsSync(path.join(cwd, '.git'))) continue;
    const key = path.resolve(cwd);
    if (!found.has(key)) found.set(key, { name: path.basename(key), path: key });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}
