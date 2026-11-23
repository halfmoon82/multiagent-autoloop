// 原生 DAG 计划：只读加载 docs/dag-plans/<planId>.json，不依赖 .vibe。
// 计划定义只是需求/拓扑定义，不记录运行进度；节点状态仍只写 dag-runs/run.json。
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateDag } from './dag.mjs';
import { loadDesignBaseline, assertNodeDesignSnapshot } from './design-baseline.mjs';

const PLAN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export class DesignCoverageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DesignCoverageError';
    this.code = code;
    this.details = details;
  }
}

const coverageFail = (code, message, details) => { throw new DesignCoverageError(code, message, details); };

// 只用确定的写入范围识别 UI 节点，不猜测产品语义。已有 design 的节点始终属于 UI；
// 常见前端源码后缀与仓库既有 public/、NoMoTo mobile/app/www/ 写入范围必须显式绑定合同。
function isUiNode(node) {
  if (node?.contract?.design != null) return true;
  const files = Array.isArray(node?.contract?.files) ? node.contract.files : [];
  return files.some(file => {
    const name = String(file || '').replaceAll('\\', '/');
    return name.startsWith('public/') || name.startsWith('mobile/app/www/') || /\.(?:html|css|jsx|tsx|vue|svelte)$/i.test(name);
  });
}

// 批准 manifest 是全集，节点合同是归属关系。每个 surface 及其三个维度都必须恰好有一个节点 owner。
// 单个节点的重复数组项也不能被 assertNodeDesignSnapshot 的 Set 规范化静默吞掉。
export function assertDesignCoverage({ designBaseline, nodes } = {}) {
  if (!designBaseline?.manifest || !Array.isArray(nodes)) coverageFail('DESIGN_BASELINE_MISSING', 'UI 计划缺少设计基线或节点合同', {});
  const owners = new Map();
  const add = (kind, surfaceId, id, nodeId) => {
    const key = `${kind}\0${surfaceId}\0${id}`;
    const item = owners.get(key) || { kind, surfaceId, id, nodeIds: [] };
    item.nodeIds.push(nodeId);
    owners.set(key, item);
  };
  const uiNodes = nodes.filter(node => node?.contract?.design != null);
  for (const node of uiNodes) {
    assertNodeDesignSnapshot({ designBaseline }, node);
    const contract = node.contract.design;
    for (const surfaceId of contract.surfaceIds) {
      const surface = designBaseline.manifest.surfaces.find(item => item.id === surfaceId);
      add('surface', surfaceId, surfaceId, node.id);
      for (const [field, kind] of [['viewports', 'viewport'], ['states', 'state'], ['interactions', 'interaction']]) {
        const values = contract[field] === undefined ? surface[field] : contract[field];
        for (const id of values) add(kind, surfaceId, id, node.id);
      }
    }
  }
  const missing = [];
  for (const surface of designBaseline.manifest.surfaces) {
    const required = [
      ['surface', surface.id, surface.id],
      ...surface.viewports.map(id => ['viewport', surface.id, id]),
      ...surface.states.map(id => ['state', surface.id, id]),
      ...surface.interactions.map(id => ['interaction', surface.id, id]),
    ];
    for (const [kind, surfaceId, id] of required) {
      if (!owners.has(`${kind}\0${surfaceId}\0${id}`)) missing.push({ kind, surfaceId, id });
    }
  }
  const duplicate = [...owners.values()].filter(item => item.nodeIds.length > 1).map(item => ({
    kind: item.kind, surfaceId: item.surfaceId, id: item.id, nodeIds: [...new Set(item.nodeIds)],
  }));
  if (missing.length || duplicate.length) {
    const code = duplicate.length ? 'DESIGN_COVERAGE_DUPLICATE' : 'DESIGN_COVERAGE_MISSING';
    coverageFail(code, `${code}：批准设计覆盖必须完整且每项只能归属一个 UI 节点`, { missing, duplicate });
  }
  return { ok: true, covered: owners.size, nodeIds: uiNodes.map(node => node.id) };
}

function readJson(file) {
  const name = path.basename(file);
  let size;
  try { size = statSync(file).size; }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`未找到原生计划 ${name}`);
    throw new Error(`无法读取原生计划 ${name}`);
  }
  if (size > MAX_JSON_BYTES) throw new Error(`原生计划文件过大：${name}`);
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`原生计划 ${name} 不是合法 JSON：${error.message}`); }
}

// 原生计划没有 vibe 产品决策记录：productSpec 固定为空对象，planDigest 口径与 createPlanDigest 一致。
// 计划文件是节点数组（本迭代确认的机器可读节点源）；也接受含 nodes 的对象形式以携带 title。
export function loadNativePlan({ projectRoot, planId }) {
  if (!PLAN_ID.test(String(planId || ''))) throw new Error('planId 必须是 kebab-case ASCII');
  if (!String(projectRoot ?? '').trim()) throw new Error('projectRoot 不能为空');
  const root = path.resolve(String(projectRoot));
  const data = readJson(path.join(root, 'docs', 'dag-plans', `${planId}.json`));
  const nodes = Array.isArray(data) ? data : data?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`原生计划 ${planId} 必须是节点数组`);
  if (!Array.isArray(data) && data.plan_id && data.plan_id !== planId) {
    throw new Error(`原生计划的 plan_id（${data.plan_id}）与请求的 planId（${planId}）不一致`);
  }
  const plan = {
    plan_id: planId,
    title: !Array.isArray(data) && data.title ? String(data.title) : planId,
    source: 'native',
  };
  const dag = validateDag(nodes);
  if (!dag.valid) throw new Error(`原生 DAG 校验失败：${dag.errors.join('；')}`);
  // 原生计划可用 optionalHighRiskActions 声明本计划开放哪些高风险动作（默认关闭）。
  const declared = !Array.isArray(data) && Array.isArray(data.optionalHighRiskActions)
    ? data.optionalHighRiskActions.filter(id => typeof id === 'string') : [];
  // 显式 UI 合同或确定的 UI 写入范围加载设计设施；旧数组计划和纯后端计划完全保持原路径。
  const uiNodes = nodes.filter(isUiNode);
  let designBaseline = null;
  if (uiNodes.length) {
    if (Array.isArray(data) || !data.design || typeof data.design !== 'object') coverageFail('DESIGN_BASELINE_MISSING', 'UI 节点必须声明 plan.design.manifestPath 与 approvalPath', {});
    designBaseline = loadDesignBaseline({ projectRoot: root, manifestPath: data.design.manifestPath, approvalPath: data.design.approvalPath });
    const rootSnapshot = { designBaseline };
    for (const node of uiNodes) {
      if (node.contract?.design == null) coverageFail('DESIGN_CONTRACT_MISSING', `UI 节点 ${node.id} 缺少 contract.design`, { nodeId: node.id });
      assertNodeDesignSnapshot(rootSnapshot, node);
    }

  }
  return { planId, plan, nodes, productSpec: {}, optionalHighRiskActions: declared, designBaseline };
}
