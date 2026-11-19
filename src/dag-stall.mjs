// DAG 节点卡住发现（无模型）：读 dag-runs 根 run 的节点持续报错（控制器记的 errorSince/errorCount），
// 同一错误持续超过阈值时，给调度会话通道投一条 scheduling.message，交由调度方诊断与自愈。
// 只用中台原生 POST /v1/events；事件 ID 按「链 + 节点 + 首次报错时间」确定，中台对重复 ID 不重复执行，
// 同一次卡住最多唤醒一次；错误变了或恢复后再卡，首次时间变化才会再唤醒。
import path from 'node:path';
import { hubRequest } from './hub.mjs';
import { createRunStore, isTerminal, ROOT_NODE } from './dag-run.mjs';

export const STALL_THRESHOLD_MS = 10 * 60 * 1000;
const ERROR_LIMIT = 600;

// 错误原文可能带 URL 凭据或 GitHub token；进中台前抹掉。
export function redactError(text) {
  return String(text ?? '')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/g, '***')
    .slice(0, ERROR_LIMIT);
}

export function findDagStalls(runs, { now = Date.now(), thresholdMs = STALL_THRESHOLD_MS } = {}) {
  const stalls = [];
  for (const run of runs || []) {
    if (!run || run.nodeId !== ROOT_NODE || isTerminal(run.status) || run.publish?.cancelRequested) continue;
    for (const [nodeId, node] of Object.entries(run.publish?.nodes || {})) {
      if (!node?.lastError || !Number.isFinite(node.errorSince)) continue;
      if (now - node.errorSince < thresholdMs) continue;
      stalls.push({ runId: run.runId, planId: run.planId, project: run.project, nodeId, state: node.state ?? null,
        since: node.errorSince, count: node.errorCount ?? 1, error: redactError(node.lastError) });
    }
  }
  return stalls;
}

// 「等待人工决策」（gated）节点：控制器已停住并释放槽位，但既不唤醒调度会话也不发卡——
// 没人接手就成为孤儿状态。这里把它也交给调度会话：以 gateAt（无则 now）为起点超过阈值即报，
// 同一节点同一 gateAt 只报一次（事件 id 含 since，中台按 id 去重）。
export function findDagGated(runs, { now = Date.now(), thresholdMs = STALL_THRESHOLD_MS } = {}) {
  const gated = [];
  for (const run of runs || []) {
    if (!run || run.nodeId !== ROOT_NODE || isTerminal(run.status) || run.publish?.cancelRequested) continue;
    for (const [nodeId, node] of Object.entries(run.publish?.nodes || {})) {
      if (node?.state !== 'gated' || node.todo) continue;
      // 兼容旧 run（没有 gateAt）：这类节点一律按已达阈值处理，避免新功能漏报。
      const since = Number.isFinite(node.gateAt) ? node.gateAt : 0;
      if (now - since < thresholdMs) continue;
      gated.push({ runId: run.runId, planId: run.planId, project: run.project, nodeId, state: 'gated',
        since, count: 1, error: node.gateReason || '等待人工决策' });
    }
  }
  return gated;
}

const seg = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

export function buildStallEvent(stall, now = Date.now()) {
  const minutes = Math.max(1, Math.round((now - stall.since) / 60000));
  const text = [
    `DAG 节点卡住：链 ${stall.runId}（计划 ${stall.planId}）的节点 ${stall.nodeId}（状态 ${stall.state ?? '未知'}）`,
    `自 ${new Date(stall.since).toISOString()} 起同一错误已连续出现 ${stall.count} 次（约 ${minutes} 分钟），控制器每轮自动重试但没有进展。`,
    `错误原文：${redactError(stall.error)}`,
    '请按调度契约处理：先定位根因（读控制台 dag-runs 状态与相关源码/配置），工程问题自行修复或派 worker 修复并做最小验证；',
    '修好后控制器下一轮会自动重试，无需手工重派。只有用户掌握的凭据/授权才向用户提问。核实后本轮结束。',
  ].join('\n');
  return {
    id: `console:dag-stall:${seg(stall.runId)}:${seg(stall.nodeId)}:${stall.since}`,
    subject: `scheduling:dag-stall:${seg(stall.runId)}`,
    type: 'scheduling.message',
    summary: `DAG 节点卡住：${stall.nodeId}`.slice(0, 80),
    detail: JSON.stringify({ project: stall.project, text }),
  };
}

// sent 记本进程已被中台收下的事件 ID，避免每轮重复投递；进程重启后由中台按事件 ID 去重兜底。
export async function sweepDagStalls({ runs, post, sent = new Set(), now = Date.now(), thresholdMs = STALL_THRESHOLD_MS } = {}) {
  const result = { posted: [], errors: [] };
  for (const stall of findDagStalls(runs, { now, thresholdMs })) {
    const event = buildStallEvent(stall, now);
    if (sent.has(event.id)) continue;
    try { await post(event); sent.add(event.id); result.posted.push(event.id); }
    catch (error) { result.errors.push(`${stall.runId}/${stall.nodeId}：${error.message}`); }
  }
  for (const node of findDagGated(runs, { now, thresholdMs })) {
    const event = buildStallEvent(node, now);
    if (sent.has(event.id)) continue;
    try { await post(event); sent.add(event.id); result.posted.push(event.id); }
    catch (error) { result.errors.push(`${node.runId}/${node.nodeId}：${error.message}`); }
  }
  return result;
}

// 周期巡检器：同 chain-closeout 模式，显式 start 才轮询，句柄 unref，单轮不重叠。
export function createDagStallSweeper({ config, directory = path.join(config.root, 'dag-runs'), intervalMs = 5 * 60 * 1000,
  thresholdMs = STALL_THRESHOLD_MS, hub = hubRequest, log = console.log, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const store = createRunStore({ directory });
  const sent = new Set();
  const post = event => hub(config, '/v1/events', { method: 'POST', body: event, auth: 'source' });
  let timer = null; let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await sweepDagStalls({ runs: store.listRuns(), post, sent, thresholdMs });
      for (const id of result.posted) log(`[dag-stall] 已唤醒调度会话：${id}`);
      if (result.errors.length) log(`[dag-stall] 投递失败（下轮重试）：${result.errors.join('；')}`);
    } catch (error) { log(`[dag-stall] 巡检失败：${error.message}`); }
    finally { running = false; }
  };
  return {
    tick,
    start() { if (timer) return; timer = setTimer(tick, intervalMs); timer.unref?.(); },
    stop() { if (timer) { clearTimer(timer); timer = null; } },
  };
}
