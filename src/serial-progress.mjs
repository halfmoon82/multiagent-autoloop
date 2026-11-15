// 串行编排状态读取：发现 <AGENT_AUTOLOOP_HOME>/*-serial.json，解析校验、映射项目、
// 计算整体百分比。只读、白名单字段出服务端；编排器可并发写，小文件整体读入。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const FILE_PATTERN = /^[A-Za-z0-9_-]+-serial\.json$/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_NODES = 100;
const CACHE_TTL_MS = 1000;

// 与 public/ 渲染层约定一致的状态→节点内默认百分比。
export const STATUS_DEFAULTS = {
  done: 100,
  dev_dispatched: 30,
  in_progress: 30,
  in_review: 60,
  review: 60,
  rework: 75,
  external_in_progress: 40,
  blocked: 20,
  pending: 0,
};
export const STATUS_KINDS = {
  done: 'done', dev_dispatched: 'dev', in_progress: 'dev',
  in_review: 'review', review: 'review', rework: 'rework',
  external_in_progress: 'external', blocked: 'blocked', pending: 'pending',
};

const text = (value, max = 300) => String(value ?? '').slice(0, max);
const validPercent = value => Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;

export function effectiveNodePercent(node) {
  return validPercent(node?.percent) ?? STATUS_DEFAULTS[node?.status] ?? 0;
}

export function chainNodeOrder(chain) {
  const ids = Object.keys(chain?.nodes || {});
  if (Array.isArray(chain?.plan) && chain.plan.length) {
    const planned = chain.plan.filter(id => ids.includes(id));
    if (planned.length) return [...planned, ...ids.filter(id => !planned.includes(id))];
  }
  return ids;
}

export function computeChainProgress(chain) {
  const order = chainNodeOrder(chain);
  const weights = new Map(order.map(id => {
    const raw = Number(chain.nodes[id]?.weight);
    return [id, Number.isInteger(raw) && raw > 0 ? raw : 1];
  }));
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0) || 1;
  let lastNode = typeof chain?.lastNode === 'string' && order.includes(chain.lastNode) ? chain.lastNode : null;
  if (!lastNode || chain.nodes[lastNode]?.status === 'done') {
    lastNode = order.find(id => chain.nodes[id]?.status !== 'done') ?? order[order.length - 1] ?? null;
  }
  let doneWeight = 0;
  let currentContribution = 0;
  for (const id of order) {
    const node = chain.nodes[id] || {};
    if (id === lastNode) currentContribution = (effectiveNodePercent(node) / 100) * weights.get(id);
    else if (node.status === 'done') doneWeight += weights.get(id);
  }
  const percent = Math.round(((doneWeight + currentContribution) / total) * 1000) / 10;
  return { percent, currentId: lastNode };
}

export function mapChainProject(fileName, data, rules = []) {
  const direct = text(data?.project, 500).trim();
  if (direct) return direct;
  const meta = text(data?.meta?.project, 500).trim();
  if (meta) return meta;
  const stem = fileName.replace(/-serial\.json$/i, '').toLowerCase();
  if (stem) {
    const rule = rules.find(item => text(item?.name).toLowerCase().startsWith(stem));
    if (rule) return text(rule.cwd, 500).trim() || '未识别';
  }
  return '未识别';
}

export function parseChainFile(raw, sourceFile, rules = []) {
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error(`${sourceFile}：不是有效的 JSON`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${sourceFile}：顶层必须是对象`);
  if (!data.nodes || typeof data.nodes !== 'object' || Array.isArray(data.nodes)) throw new Error(`${sourceFile}：缺少 nodes 对象`);
  const ids = Object.keys(data.nodes);
  if (!ids.length) throw new Error(`${sourceFile}：nodes 为空`);
  if (ids.length > MAX_NODES) throw new Error(`${sourceFile}：节点超过 ${MAX_NODES} 个`);
  const nodes = ids.map(id => {
    const node = data.nodes[id] || {};
    return {
      id: text(id, 80),
      label: text(node.label ?? id, 24),
      title: text(node.title ?? id, 120),
      status: text(node.status ?? 'pending', 40),
      kind: STATUS_KINDS[node.status] ?? 'pending',
      percent: effectiveNodePercent(node),
      weight: (() => { const raw = Number(node.weight); return Number.isInteger(raw) && raw > 0 ? raw : 1; })(),
      part: text(node.part, 60) || null,
      summary: text(node.summary, 300) || null,
      prUrl: /^https?:\/\//.test(node.pr_url || '') ? text(node.pr_url, 300) : null,
    };
  });
  const { percent, currentId } = computeChainProgress(data);
  const current = nodes.find(node => node.id === currentId) ?? null;
  return {
    sourceFile,
    project: mapChainProject(sourceFile, data, rules),
    nodes,
    order: chainNodeOrder(data),
    percent,
    current,
    updatedAt: text(data.lastEventAt, 40) || null,
  };
}

const cache = new Map();

export async function loadChains({ root, rules = [], now = () => Date.now() } = {}) {
  if (!root) return { chains: [], errors: [] };
  let files;
  try { files = readdirSync(root).filter(name => FILE_PATTERN.test(name)); }
  catch { return { chains: [], errors: [] }; }
  const chains = [];
  const errors = [];
  for (const file of files) {
    const full = path.join(root, file);
    try {
      const stat = statSync(full);
      if (stat.size > MAX_FILE_BYTES) { errors.push(`${file}：文件超过 256KB，已跳过`); continue; }
      const cached = cache.get(full);
      let chain;
      if (cached && cached.mtimeMs === stat.mtimeMs && now() - cached.at < CACHE_TTL_MS * 10) {
        chain = cached.chain;
      } else {
        chain = parseChainFile(readFileSync(full, 'utf8'), file, rules);
        cache.set(full, { mtimeMs: stat.mtimeMs, at: now(), chain });
      }
      chains.push(chain);
    } catch (error) {
      errors.push(error.message);
    }
  }
  chains.sort((a, b) => a.project.localeCompare(b.project, 'zh-CN'));
  return { chains, errors };
}
