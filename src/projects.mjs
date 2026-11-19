import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const MAX_DEPTH = 4;
const CACHE_TTL_MS = 30000;
let cache = { key: null, at: 0, value: [] };
const SKIP_DIRS = new Set(['node_modules', 'Library', 'Pods', 'vendor']);
// 临时产物命名约定：探针/排练/工作流状态目录与标记待删的目录不是可调度项目
const JUNK_NAME = /(待删|-(workflow-state|probe|rehearsal)(-r\d+)?$)/;

// 全局一级项目筛选的「全部」哨兵（Spec §8.2）：不是任何真实项目，表示不过滤。
// 与 mobile/src/features/project-filter 的视图模型共用同一常量值，由测试守门一致性。
export const ALL_PROJECTS_ID = '全部';
export const ALL_PROJECTS_LABEL = '全部';

// 移动端只读摘要（Spec §8.2）：项目作为全局一级筛选的稳定标识与显示名。
// 只由真实 name/path 投影；无效或缺失条目不生成，绝不编造项目或状态。
export function mobileProjectSummary(project) {
  const id = String(project?.path ?? project?.id ?? '').trim();
  const label = String(project?.name ?? project?.label ?? '').trim();
  return id && label ? { id, label } : null;
}
export function mobileProjectSummaries(projects = []) {
  return (Array.isArray(projects) ? projects : []).map(mobileProjectSummary).filter(Boolean);
}
export function mobileProjectOptions(projects = []) {
  return [{ id: ALL_PROJECTS_ID, label: ALL_PROJECTS_LABEL }, ...mobileProjectSummaries(projects)];
}
// 全局项目筛选选项：移动端与网页控制台共用 /api/projects 的真实项目，绝不编造。
// 项目列表为空时给明确空态（empty/reason），由视图显示，而不是混进占位项目。
export function mobileProjectFilterOptions(projects = []) {
  const options = mobileProjectOptions(projects);
  return {
    all: options[0],
    options,
    empty: options.length === 1,
    reason: options.length === 1 ? '暂无可筛选的项目' : null,
  };
}
// 把只读摘要附到既有 /api/projects 输出的每个项目上，移动端与网页控制台共用同一后端数据。
function withMobileSummaries(projects) {
  return projects.map(project => ({ ...project, mobileSummary: mobileProjectSummary(project) }));
}

export function discoverGitProjects({ roots = [], rules = [] } = {}) {
  const cacheKey = roots.join('|');
  if (cache.key === cacheKey && Date.now() - cache.at < CACHE_TTL_MS) {
    return withMobileSummaries(mergeRuleProjects(cache.value, rules));
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
  return withMobileSummaries(mergeRuleProjects(discovered, rules));
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
