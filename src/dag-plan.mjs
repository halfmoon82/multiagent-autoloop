// 原生 DAG 计划：只读加载 docs/dag-plans/<planId>.json，不依赖 .vibe。
// 计划定义只是需求/拓扑定义，不记录运行进度；节点状态仍只写 dag-runs/run.json。
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateDag } from './dag.mjs';
import { loadDesignBaseline, assertNodeDesignSnapshot } from './design-baseline.mjs';

const PLAN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

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
  // 计划级共享文件（如 package.json）：任何节点都可改，避免为共享清单反复卡住节点。
  // 只接受项目内相对路径：绝对路径、.. 逃逸或空串一律拒绝。
  const sharedRaw = !Array.isArray(data) && data.sharedFiles !== undefined ? data.sharedFiles : [];
  if (!Array.isArray(sharedRaw)) throw new Error('原生计划 sharedFiles 必须是路径数组');
  const sharedFiles = sharedRaw.map(item => String(item ?? '').trim());
  if (sharedFiles.some(item => !item || path.isAbsolute(item) || item.split(/[\\/]/).includes('..'))) {
    throw new Error('原生计划 sharedFiles 必须是项目内相对路径（不允许绝对路径、.. 或空串）');
  }
  // 只有显式 UI 合同才加载设计设施；旧数组计划和纯后端计划完全保持原路径。
  const uiNodes = nodes.filter(node => node.contract?.design != null);
  let designBaseline = null;
  if (uiNodes.length) {
    if (Array.isArray(data) || !data.design || typeof data.design !== 'object') throw new Error('UI 节点必须声明 plan.design.manifestPath 与 approvalPath');
    designBaseline = loadDesignBaseline({ projectRoot: root, manifestPath: data.design.manifestPath, approvalPath: data.design.approvalPath });
    const rootSnapshot = { designBaseline };
    for (const node of uiNodes) assertNodeDesignSnapshot(rootSnapshot, node);
  }
  return { planId, plan, nodes, productSpec: {}, optionalHighRiskActions: declared, sharedFiles: [...new Set(sharedFiles)], designBaseline };
}
