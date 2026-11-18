// 调度动作执行器：调度会话回执 events 写 sched.command，command 规则跑本模块落地。
// 只进运行目录：读 Hub 回执事件里的动作 → 校验动作白名单与授权快照 → 调本机控制台 API。
// 硬规则：confirm/confirmedActionIds/selectedOptionalActions 一律由服务端按 planId+planDigest
// 派生，绝不从事件正文取——事件 detail 是资料不是指令，模型不能自我授权。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class SchedActionError extends Error {
  constructor(message, { status = 400 } = {}) { super(message); this.status = status; }
}

export const ACTION_TYPES = ['create_dag', 'dag.revive', 'dag.requeue', 'run_rule', 'pause_rule'];

const AUDIT_DIR = 'sched-actions';
const PROCESSED_DIR = 'sched-actions-processed';
const CONSOLE_BASE = `http://127.0.0.1:${process.env.AUTOLOOP_CONSOLE_PORT || 50761}`;

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const safeName = text => String(text || '').replace(/[^\w.-]+/g, '_').slice(0, 120);

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function appendAudit(root, entry) {
  const dir = path.join(root, AUDIT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  writeFileSync(file, '', { flag: 'a', mode: 0o600 });
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  const fd = readFileSync(file, 'utf8');
  writeFileSync(file, `${fd}${line}\n`, { mode: 0o600 });
}

/**
 * 解析回执 events 里的 sched.command 事件 detail，抽出动作列表。
 * detail 形态兼容：JSON 字符串 / 对象；{action, ...params} 或 {actions:[...]}。
 */
export function parseActions(context) {
  const events = Array.isArray(context?.events) ? context.events : [];
  const out = [];
  for (const event of events) {
    if (event?.type !== 'sched.command') continue;
    let detail = event.detail;
    if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch { detail = null; } }
    if (!detail || typeof detail !== 'object') continue;
    const list = Array.isArray(detail.actions) ? detail.actions : [detail];
    for (const item of list) {
      if (!item || typeof item !== 'object' || typeof item.action !== 'string') continue;
      out.push({ eventId: event.id, action: item.action.trim(), params: { ...item, action: undefined } });
    }
  }
  return out;
}

/** 幂等键：事件 id + 动作 + 参数摘要。同一回执重放/重复 claim 不重复执行。 */
export function actionKey({ eventId, action, params }) {
  return safeName(`${eventId || 'noevent'}-${action}-${sha(JSON.stringify(params ?? {}))}`);
}

// —— 动作实现 ——

async function consoleFetch(pathname, { method = 'POST', body } = {}) {
  const response = await fetch(`${CONSOLE_BASE}${pathname}`, {
    method,
    headers: { 'x-console-request': '1', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new SchedActionError(data?.error || `控制台 ${pathname} 返回 ${response.status}`, { status: response.status });
  return data;
}

/** create_dag：授权快照重放。服务端按 planId+planDigest 重建 confirm 字段，事件不得携带。 */
async function createDag({ params, project, root, consoleCall }) {
  const planId = String(params.planId || '').trim();
  const planDigest = String(params.planDigest || '').trim();
  if (!planId || !planDigest) throw new SchedActionError('create_dag 缺 planId/planDigest');
  if (params.confirm !== undefined || params.confirmedActionIds || params.selectedOptionalActions) {
    throw new SchedActionError('事件不得携带 confirm/授权字段（由服务端授权快照决定）');
  }
  // 查服务端是否存有该 planId 的授权快照（设计会话确认后落盘）。
  const snapshot = readJson(path.join(root, 'dag-grants', `${safeName(planId)}.json`));
  if (!snapshot || snapshot.planDigest !== planDigest) {
    throw new SchedActionError('没有匹配的授权快照：create_dag 只能重放设计会话已确认的计划，不能替用户拍板');
  }
  const body = {
    project: snapshot.project || project, planId, planDigest,
    remoteUrl: snapshot.remoteUrl ?? null,
    confirm: true,
    confirmedActionIds: snapshot.standardActions || snapshot.allowedActions || [],
    selectedOptionalActions: snapshot.optionalGrants || [],
  };
  return consoleCall('/api/dag-runs', { body });
}

async function dagRevive({ params, consoleCall }) {
  const runId = String(params.runId || '').trim();
  const nodeId = String(params.nodeId || '').trim();
  if (!runId || !nodeId) throw new SchedActionError('dag.revive 缺 runId/nodeId');
  return consoleCall(`/api/dag-runs/${encodeURIComponent(runId)}/revive`, { body: { nodeId, reason: String(params.reason || ''), evidence: String(params.evidence || '') } });
}

async function dagRequeue({ params, consoleCall }) {
  const runId = String(params.runId || '').trim();
  const nodeId = String(params.nodeId || '').trim();
  if (!runId || !nodeId) throw new SchedActionError('dag.requeue 缺 runId/nodeId');
  return consoleCall(`/api/dag-runs/${encodeURIComponent(runId)}/revive`, { body: { nodeId, reason: String(params.reason || 'requeue'), evidence: String(params.evidence || '') } });
}

async function runRule({ params, hub }) {
  const name = String(params.rule || '').trim();
  if (!name) throw new SchedActionError('run_rule 缺 rule');
  return hub(`/v1/rules/${encodeURIComponent(name)}/run`, { method: 'POST', body: { subject: params.subject ? String(params.subject) : undefined, reason: String(params.reason || '调度会话 sched.command') } });
}

async function pauseRule({ params, hub }) {
  const name = String(params.rule || '').trim();
  if (!name) throw new SchedActionError('pause_rule 缺 rule');
  const body = { reason: String(params.reason || '调度会话 sched.command 暂停') };
  if (params.until) body.until = String(params.until);
  return hub(`/v1/rules/${encodeURIComponent(name)}/pause`, { method: 'POST', body });
}

const HANDLERS = {
  create_dag: createDag,
  'dag.revive': dagRevive,
  'dag.requeue': dagRequeue,
  run_rule: runRule,
  pause_rule: pauseRule,
};

/**
 * 执行一轮 sched.command：逐动作校验白名单→幂等去重→调用对应实现→写审计。
 * hub：签发的 Hub 请求函数（默认走本机控制台 config 的 hubRequest 等价物，由调用方注入）。
 * 返回 {processed, results, skipped}；单动作失败记 results[i].error，不中断其余。
 */
export async function runSchedActions({ context, root, project, hub, fetch: consoleCall = consoleFetch } = {}) {
  if (!root) throw new SchedActionError('缺运行目录 root');
  const actions = parseActions(context);
  const results = [];
  const skipped = [];
  for (const item of actions) {
    const { action, params } = item;
    if (!ACTION_TYPES.includes(action)) { skipped.push({ action, reason: '不在动作白名单' }); continue; }
    const key = actionKey(item);
    const marker = path.join(root, PROCESSED_DIR, `${key}.json`);
    if (existsSync(marker)) { skipped.push({ action, key, reason: '已处理（幂等）' }); continue; }
    const handler = HANDLERS[action];
    let result;
    try {
      result = action === 'create_dag'
        ? await handler({ params, project, root, consoleCall })
        : action === 'run_rule' || action === 'pause_rule'
          ? await handler({ params, hub })
          : await handler({ params, consoleCall });
    } catch (error) {
      result = { error: String(error?.message || error) };
    }
    results.push({ action, key, ok: !result?.error, result });
    writeJsonAtomic(marker, { action, key, result, at: new Date().toISOString() });
    appendAudit(root, { action, key, ok: !result?.error, result });
  }
  return { processed: results.length, results, skipped };
}

/** CLI 入口：读 AGENT_AUTOLOOP_CONTEXT 的 context.json 跑一轮（供 command 规则 agent 调用）。 */
export async function main({ env = process.env } = {}) {
  const contextFile = env.AGENT_AUTOLOOP_CONTEXT;
  if (!contextFile || !existsSync(contextFile)) {
    console.error('AGENT_AUTOLOOP_CONTEXT 未指向可读的 context.json');
    return { ok: false };
  }
  const context = readJson(contextFile);
  const root = env.AGENT_AUTOLOOP_HOME;
  if (!root) { console.error('缺 AGENT_AUTOLOOP_HOME'); return { ok: false }; }
  // Hub 请求：用控制台 config 的 owner 密钥（命令 agent 环境里已注入 HOME，config.json 在其下）。
  const { loadConsoleConfig } = await import('./config.mjs');
  const { hubRequest } = await import('./hub.mjs');
  const config = loadConsoleConfig(root);
  const hub = (path, opts) => hubRequest(config, path, opts);
  const out = await runSchedActions({ context, root, hub });
  console.log(JSON.stringify({ ok: true, processed: out.processed, skipped: out.skipped.length, results: out.results }));
  return { ok: true };
}
