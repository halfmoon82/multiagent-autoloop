// 原生 DAG 计划：只读加载 docs/dag-plans/<planId>.json，不依赖 .vibe。
// 计划定义只是需求/拓扑定义，不记录运行进度；节点状态仍只写 dag-runs/run.json。
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateDag } from './dag.mjs';

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
  return { planId, plan, nodes, productSpec: {} };
}
