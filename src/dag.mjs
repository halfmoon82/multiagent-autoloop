// DAG 纯逻辑：结构/契约校验、写范围串行、ready 计算、并行波与依赖图。
// 运行态写入属于 dag-run；本模块不读写文件，也不调用模型。
import { createHash } from 'node:crypto';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const text = value => String(value ?? '').trim();

export function normalizeProjectPath(value) {
  const raw = text(value).replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || raw.startsWith('~') || /^[A-Za-z]:\//.test(raw) || raw.includes('\0')) {
    throw new Error(`非法项目相对路径：${value}`);
  }
  const parts = raw.split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.includes('..')) throw new Error(`非法项目相对路径：${value}`);
  return parts.join('/');
}

export function writeScopeOverlap(left, right) {
  try {
    const a = normalizeProjectPath(left); const b = normalizeProjectPath(right);
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  } catch { return false; }
}

function nodeFiles(node) {
  if (node?.id === 'integration-review' || node?.integration_review) return [];
  const values = [...(node?.contract?.files || []), ...(node?.files || [])];
  return values.map(normalizeProjectPath);
}

function contractError(node) {
  for (const field of ['input', 'output', 'error_behavior', 'acceptance_example']) {
    if (!text(node?.contract?.[field])) return `节点 ${node.id} 的契约缺少 ${field}`;
  }
  try { nodeFiles(node); } catch (error) { return `节点 ${node.id}：${error.message}`; }
  return null;
}

function structuralErrors(nodes) {
  const errors = [];
  const ids = nodes.map(node => text(node?.id));
  if (new Set(ids).size !== ids.length) errors.push('DAG 节点 id 必须唯一');
  for (const id of ids) if (!ID.test(id)) errors.push(`节点 id 必须是 kebab-case ASCII：${id || '空'}`);
  const known = new Set(ids);
  const graph = Object.fromEntries(nodes.map(node => [node.id, (node.depends_on || []).map(text)]));
  for (const node of nodes) {
    for (const dependency of node.depends_on || []) {
      if (!known.has(text(dependency))) errors.push(`节点 ${node.id} 有未知依赖：${dependency}`);
    }
  }
  const visiting = new Set(); const visited = new Set();
  const visit = id => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph[id] || []) {
      if (graph[dependency] !== undefined && visit(dependency)) return true;
    }
    visiting.delete(id); visited.add(id); return false;
  };
  if (Object.keys(graph).some(id => !visited.has(id) && visit(id))) errors.push('DAG 硬依赖存在环');
  return errors;
}

export function validateDag(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const errors = structuralErrors(list);
  for (const node of list) {
    const error = contractError(node);
    if (error) errors.push(error);
  }
  for (let left = 0; left < list.length; left++) {
    for (let right = left + 1; right < list.length; right++) {
      const a = list[left]; const b = list[right];
      let filesA = []; let filesB = [];
      try { filesA = nodeFiles(a); filesB = nodeFiles(b); } catch { /* 契约错误已在上方报告 */ }
      const overlap = filesA.some(file => filesB.some(other => writeScopeOverlap(file, other)));
      if (!overlap) continue;
      const serialized = (a.depends_on || []).includes(b.id) || (b.depends_on || []).includes(a.id);
      if (!serialized) errors.push(`节点 ${a.id} 与 ${b.id} 写范围重叠，必须用 depends_on 串行`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function dependencyClosure(nodes, blockedIds = []) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Set(list.map(node => node.id));
  const closure = new Set([...blockedIds].filter(id => byId.has(id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of list) {
      if (!closure.has(node.id) && (node.depends_on || []).some(id => closure.has(id))) {
        closure.add(node.id); changed = true;
      }
    }
  }
  return closure;
}

export function readyNodes(nodes, { blockedIds = [] } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!validateDag(list).valid) return [];
  const byId = new Map(list.map(node => [node.id, node]));
  const closure = dependencyClosure(list, blockedIds);
  return list.filter(node => {
    if (closure.has(node.id) || !['pending', 'planned', 'ready'].includes(node.status)) return false;
    return (node.depends_on || []).every(id => byId.get(id)?.status === 'done');
  });
}

export function parallelShape(nodes) {
  const list = (Array.isArray(nodes) ? nodes : []).filter(node => node.id !== 'integration-review' && !node.integration_review);
  const byId = new Map(list.map(node => [node.id, node]));
  const depths = new Map(); const busy = new Set();
  const visit = id => {
    if (depths.has(id)) return depths.get(id);
    if (busy.has(id)) return null;
    busy.add(id);
    let best = 0;
    for (const dependency of byId.get(id)?.depends_on || []) {
      if (!byId.has(dependency)) continue;
      const depth = visit(dependency);
      if (depth === null) return null;
      best = Math.max(best, depth);
    }
    busy.delete(id); depths.set(id, best + 1); return best + 1;
  };
  for (const node of list) {
    if (visit(node.id) === null) return { parallelWaves: null, maxParallelWidth: null, criticalPathLength: null };
  }
  const waves = [];
  for (const node of list) {
    const level = depths.get(node.id);
    while (waves.length < level) waves.push([]);
    waves[level - 1].push(node.id);
  }
  return { parallelWaves: waves, maxParallelWidth: Math.max(0, ...waves.map(wave => wave.length)), criticalPathLength: waves.length };
}

export function dependencyGraph(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) throw new Error('依赖图渲染失败：计划没有节点');
  const structural = structuralErrors(list);
  if (structural.length) throw new Error(`依赖图渲染失败：${structural.join('；')}`);
  const shape = parallelShape(list);
  const waveOf = new Map();
  shape.parallelWaves.forEach((wave, index) => wave.forEach(id => waveOf.set(id, index + 1)));
  const groups = {};
  const graphNodes = [...list].sort((a, b) => a.id.localeCompare(b.id)).map(node => {
    const group = text(node.parallel_group || node.metadata?.parallel_group) || null;
    if (group) (groups[group] ||= []).push(node.id);
    return {
      id: node.id,
      depends_on: [...new Set((node.depends_on || []).map(text))].sort(),
      parallel_group: group,
      wave: waveOf.get(node.id) ?? null,
      integration_review: node.id === 'integration-review' || Boolean(node.integration_review),
    };
  });
  return {
    schema: 1, nodes: graphNodes,
    parallelWaves: shape.parallelWaves.map(wave => [...wave].sort()),
    parallelGroups: Object.fromEntries(Object.entries(groups).map(([name, members]) => [name, members.sort()])),
    maxParallelWidth: shape.maxParallelWidth, criticalPathLength: shape.criticalPathLength,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function dependencyGraphDigest(graph) {
  return createHash('sha256').update(canonical(graph)).digest('hex');
}
