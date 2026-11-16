// vibe 规划产物适配：只读加载已发布计划、校验产品决策与 DAG、生成确认摘要和运行快照。
// vibe 的授权卡/execution_engine 字段在此不作为执行授权或调度引擎。
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateDag } from './dag.mjs';

const PLAN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

function readJson(file) {
  if (statSync(file).size > MAX_JSON_BYTES) throw new Error(`vibe 计划文件过大：${path.basename(file)}`);
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`无法读取 vibe 计划 ${path.basename(file)}：${error.message}`); }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function validateDecisions(plan, productSpec) {
  for (const decision of [...(plan.decisions || []), ...(productSpec.decisions || [])]) {
    if (!decision || typeof decision !== 'object') throw new Error('PRD 产品决策记录损坏：存在空决策项');
    if (decision.status !== 'approved' || !String(decision.selected ?? '').trim()) {
      throw new Error(`PRD 仍有未闭合产品决策：${decision.question || decision.id || '未命名决策'}`);
    }
  }
}

export function loadVibePlan({ projectRoot, planId }) {
  if (!PLAN_ID.test(String(planId || ''))) throw new Error('planId 必须是 kebab-case ASCII');
  if (!String(projectRoot ?? '').trim()) throw new Error('projectRoot 不能为空');
  const root = path.resolve(String(projectRoot));
  const directory = path.join(root, '.vibe', 'plans', planId);
  const plan = readJson(path.join(directory, 'plan.json'));
  if (plan.plan_id && plan.plan_id !== planId) throw new Error(`plan.json 的 plan_id（${plan.plan_id}）与请求的 planId（${planId}）不一致`);
  const nodes = readJson(path.join(directory, 'nodes.json'));
  const productSpec = readJson(path.join(directory, 'product-spec.input.json'));
  if (!Array.isArray(nodes)) throw new Error('vibe nodes.json 必须是节点数组');
  validateDecisions(plan, productSpec);
  if (plan.complexity_band === 'complex' && !nodes.some(node => node.id === 'integration-review')) {
    throw new Error('complex 计划缺少 integration-review 节点');
  }
  const dag = validateDag(nodes);
  if (!dag.valid) throw new Error(`vibe DAG 校验失败：${dag.errors.join('；')}`);
  return { planId, plan, nodes, productSpec };
}

export function createPlanDigest({ productSpec, plan, nodes, authorizationSnapshot = null }) {
  return digest({ productSpec, plan, nodes, authorizationSnapshot });
}

export function createRunSnapshot(loaded, { authorizationSnapshot, maxParallel = 5 } = {}) {
  if (!authorizationSnapshot || !Array.isArray(authorizationSnapshot.actions)) throw new Error('缺少执行授权快照');
  // 契约底线：快照层即拒绝部署/发布/凭据/对外通信类动作，与后续 API 路由白名单互为双保险。
  const FORBIDDEN_ACTION = /deploy|release|credential|secret|token|external|network|publish/i;
  for (const action of authorizationSnapshot.actions) {
    const name = String(action?.id || action || '');
    if (FORBIDDEN_ACTION.test(name)) throw new Error(`授权快照包含永远禁止的动作：${name}`);
  }
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 5) throw new Error('DAG 最大并行必须在 1 到 5 之间');
  const planDigest = createPlanDigest({ ...loaded, authorizationSnapshot });
  return {
    version: 1,
    planId: loaded.planId,
    planDigest,
    maxParallel,
    authorizationSnapshot: JSON.parse(JSON.stringify(authorizationSnapshot)),
    nodes: Object.fromEntries(loaded.nodes.map(node => [node.id, {
      id: node.id,
      title: node.title,
      status: 'pending',
      depends_on: [...(node.depends_on || [])],
      integration_after: [...(node.integration_after || [])],
      contract: JSON.parse(JSON.stringify(node.contract || {})),
      generation: 0,
      attempt: 0,
    }])),
  };
}
