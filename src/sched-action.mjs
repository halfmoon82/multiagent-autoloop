// 调度动作执行器：调度会话回执 events 写 sched.command，command 规则跑本模块落地。
// 只做受控动作：DAG 节点复活/创建、规则立即运行/限时暂停。
// DAG 创建经 dag.create → POST /api/dag-runs：planDigest/planOptionalActions 由服务端
// 校验（调度会话不能伪造授权），且要求会话已在会话里向用户逐字出示执行范围（见调度提示词）。
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class SchedActionError extends Error {
  constructor(message, { status = 400, permanent = true } = {}) { super(message); this.status = status; this.permanent = permanent; }
}

export const ACTION_TYPES = ['dag.revive', 'dag.create', 'run_rule', 'pause_rule'];
// 显式拒绝（带可读原因）的动作：不是白名单外的乱写，而是有意关闭的能力。
export const DISABLED_ACTIONS = {
  // 旧名字 create_dag 永久禁用：历史/注入动作不得绕过新白名单 dag.create 的服务端校验。
  create_dag: 'create_dag 已关闭：请改用 dag.create（planDigest 由服务端校验，且必须先向用户出示执行范围）',
  'dag.requeue': 'dag.requeue 已并入 dag.revive，请改用 dag.revive',
};
// 调度链自身的规则不可被调度动作暂停或立即运行：防止自我禁用与绕过 Hub hops 循环保护。
export const PROTECTED_RULES = new Set(['调度会话执行', '调度动作执行']);
const PROTECTED_EVENT_TYPES = new Set(['scheduling.message', 'sched.command']);
export const MAX_ACTIONS_PER_ROUND = 5;
export const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;

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

// 追加写：并行轮次各自 append 一行，不读改写，不丢行。
function appendAudit(root, entry) {
  const dir = path.join(root, AUDIT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
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
      const { action, ...params } = item;
      out.push({ eventId: event.id, action: action.trim(), params });
    }
  }
  return out;
}

/** 幂等键：事件 id + 动作 + 参数摘要。同一回执重放/重复 claim 不重复执行。 */
export function actionKey({ eventId, action, params }) {
  return safeName(`${eventId || 'noevent'}-${action}-${sha(JSON.stringify(params ?? {}))}`);
}

async function consoleFetch(pathname, { method = 'POST', body } = {}) {
  let response;
  try {
    response = await fetch(`${CONSOLE_BASE}${pathname}`, {
      method,
      headers: { 'x-console-request': '1', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // dag.create 服务端要做设计预检与 mirror git fetch，实测落盘约 38s；8s 客户端超时会把
      // 已成功创建误判为临时失败并触发 Hub 重派（2026-11-28 run 18600 假失败事故）。放宽到 90s。
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    throw new SchedActionError(`连不上控制台：${error.message}`, { status: 502, permanent: false });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SchedActionError(data?.error || `控制台 ${pathname} 返回 ${response.status}`, { status: response.status, permanent: response.status < 500 });
  }
  return data;
}

async function dagCreate({ params, consoleCall }) {
  const required = ['project', 'planId', 'planDigest'];
  const missing = required.filter(key => !String(params[key] || '').trim());
  if (missing.length) throw new SchedActionError(`dag.create 缺参数：${missing.join('、')}`);
  // 可选高风险动作（部署/发布/生产数据等）只能由用户在确认页逐项勾选，调度会话不得代选。
  if (Array.isArray(params.selectedOptionalActions) && params.selectedOptionalActions.length) {
    throw new SchedActionError('dag.create 不能携带 selectedOptionalActions：可选高风险动作只能由用户在控制台确认页勾选');
  }
  if (!Array.isArray(params.confirmedActionIds) || !params.confirmedActionIds.length) throw new SchedActionError('dag.create 缺 confirmedActionIds（须来自 GET /api/dag-plan 的 allowedActions）');
  // 服务端强制 confirm=true + planDigest/confirmedActionIds 与计划一致，伪造的授权快照过不去。
  return consoleCall('/api/dag-runs', { body: {
    project: String(params.project),
    planId: String(params.planId),
    planDigest: String(params.planDigest),
    remoteUrl: String(params.remoteUrl || ''),
    confirm: true,
    confirmedActionIds: params.confirmedActionIds,
    selectedOptionalActions: [],
  } });
}

async function dagRevive({ params, consoleCall }) {
  const runId = String(params.runId || '').trim();
  const nodeId = String(params.nodeId || '').trim();
  if (!runId || !nodeId) throw new SchedActionError('dag.revive 缺 runId/nodeId');
  return consoleCall(`/api/dag-runs/${encodeURIComponent(runId)}/revive`, { body: { nodeId, reason: String(params.reason || ''), evidence: String(params.evidence || '') } });
}

/** 与 Hub kernel/rules.ts 的 typeMatch 同口径：'*' 全匹配、'x.*' 前缀匹配、其余精确匹配。 */
export function typePatternMatches(pattern, type) {
  const value = String(pattern ?? '');
  return value === '*' || value === type || (value.endsWith('.*') && type.startsWith(value.slice(0, -1)));
}

/** 规则级守卫：规则必须存在于 rules.json，不得是调度链自身，也不得是接调度事件的规则（含通配）。 */
export function assertRuleAllowed(name, rules = []) {
  if (!name) throw new SchedActionError('缺 rule');
  if (PROTECTED_RULES.has(name)) throw new SchedActionError(`规则「${name}」属于调度链自身，不允许由调度动作暂停或立即运行`);
  const rule = rules.find(item => item?.name === name);
  if (!rule) throw new SchedActionError(`没有这条规则：${name}`);
  const patterns = Array.isArray(rule.when?.types) ? rule.when.types : [];
  const hit = [...PROTECTED_EVENT_TYPES].find(type => patterns.some(pattern => typePatternMatches(pattern, type)));
  if (hit) throw new SchedActionError(`规则「${name}」会接调度事件 ${hit}，不允许由调度动作触发`);
  return rule;
}

async function runRule({ params, hub, rules }) {
  const name = String(params.rule || '').trim();
  assertRuleAllowed(name, rules);
  return hub(`/v1/rules/${encodeURIComponent(name)}/run`, { method: 'POST', body: { ...(params.subject ? { subject: String(params.subject) } : {}), reason: String(params.reason || '调度会话 sched.command') } });
}

async function pauseRule({ params, hub, rules, now }) {
  const name = String(params.rule || '').trim();
  assertRuleAllowed(name, rules);
  const until = Date.parse(String(params.until || ''));
  if (!Number.isFinite(until)) throw new SchedActionError('pause_rule 必须带 until（带时区的 ISO 时间），不允许无限期暂停');
  if (until <= now.getTime()) throw new SchedActionError('pause_rule 的 until 必须晚于现在');
  if (until - now.getTime() > MAX_PAUSE_MS) throw new SchedActionError('pause_rule 最长暂停 24 小时');
  return hub(`/v1/rules/${encodeURIComponent(name)}/pause`, { method: 'POST', body: { reason: String(params.reason || '调度会话 sched.command 暂停'), until: String(params.until) } });
}

const HANDLERS = { 'dag.revive': dagRevive, 'dag.create': dagCreate, run_rule: runRule, pause_rule: pauseRule };

/**
 * 执行一轮 sched.command：逐动作校验白名单→幂等去重→调用对应实现→写审计。
 * 幂等标记只在「成功」或「永久失败（4xx/校验拒绝）」时写入；临时失败（连不上、5xx）不写标记，
 * 交由 Hub 重派后再试。返回 {processed, results, skipped, failed}。
 */
export async function runSchedActions({ context, root, hub, rules = [], fetch: consoleCall = consoleFetch, now = new Date() } = {}) {
  if (!root) throw new SchedActionError('缺运行目录 root');
  const actions = parseActions(context);
  const results = [];
  const skipped = [];
  actions.forEach((item, index) => { if (index >= MAX_ACTIONS_PER_ROUND) skipped.push({ action: item.action, reason: `超过每轮上限 ${MAX_ACTIONS_PER_ROUND} 个动作` }); });
  for (const item of actions.slice(0, MAX_ACTIONS_PER_ROUND)) {
    const { action, params } = item;
    const key = actionKey(item);
    if (DISABLED_ACTIONS[action]) {
      const result = { error: DISABLED_ACTIONS[action] };
      results.push({ action, key, ok: false, permanent: true, result });
      appendAudit(root, { action, key, ok: false, result });
      continue;
    }
    if (!ACTION_TYPES.includes(action)) { skipped.push({ action, reason: '不在动作白名单' }); continue; }
    const marker = path.join(root, PROCESSED_DIR, `${key}.json`);
    if (existsSync(marker)) { skipped.push({ action, key, reason: '已处理（幂等）' }); continue; }
    let result;
    let permanent = true;
    try {
      result = await HANDLERS[action]({ params, hub, rules, consoleCall, now });
    } catch (error) {
      result = { error: String(error?.message || error) };
      // 校验拒绝与 4xx 是永久失败；连不上、5xx、无状态码的异常按临时失败交给 Hub 重派。
      permanent = error instanceof SchedActionError ? error.permanent !== false : Number(error?.status) >= 400 && Number(error?.status) < 500;
    }
    const ok = !result?.error;
    results.push({ action, key, ok, permanent, result });
    if (ok || permanent) writeJsonAtomic(marker, { action, key, ok, result, at: new Date().toISOString() });
    appendAudit(root, { action, key, ok, permanent, result });
  }
  const failed = results.filter(item => !item.ok);
  return { processed: results.length, results, skipped, failed };
}

/** CLI 入口：读 AGENT_AUTOLOOP_CONTEXT 的 context.json 跑一轮（供 command 规则 agent 调用）。 */
export async function main({ env = process.env } = {}) {
  const contextFile = env.AGENT_AUTOLOOP_CONTEXT;
  if (!contextFile || !existsSync(contextFile)) {
    console.error('没跑成：AGENT_AUTOLOOP_CONTEXT 未指向可读的 context.json');
    return { ok: false };
  }
  const context = readJson(contextFile);
  const root = env.AGENT_AUTOLOOP_HOME;
  if (!root) { console.error('没跑成：缺 AGENT_AUTOLOOP_HOME'); return { ok: false }; }
  const { loadConsoleConfig } = await import('./config.mjs');
  const { hubRequest } = await import('./hub.mjs');
  const config = loadConsoleConfig(root);
  const rules = readJson(config.rulesFile)?.rules || [];
  const hub = (pathname, opts) => hubRequest(config, pathname, opts);
  const out = await runSchedActions({ context, root, hub, rules });
  const transient = out.failed.filter(item => !item.permanent);
  // 第一行结论遵循 Hub 回执协议：临时失败写「没跑成」并以非零退出让中台重派；永久拒绝如实记录但不重派。
  if (transient.length) console.log(`没跑成：${transient.length} 个调度动作临时失败（${transient.map(item => item.result.error).join('；').slice(0, 300)}）`);
  else if (out.failed.length) console.log(`调度动作被拒 ${out.failed.length} 个：${out.failed.map(item => `${item.action}：${item.result.error}`).join('；').slice(0, 300)}`);
  else if (!out.processed) console.log(`没事可做：没有需要执行的调度动作${out.skipped.length ? `（跳过 ${out.skipped.length} 个）` : ''}`);
  else console.log(`已执行 ${out.processed} 个调度动作：${out.results.map(item => item.action).join('、')}`);
  return { ok: transient.length === 0, transient: transient.length, failed: out.failed.length };
}
