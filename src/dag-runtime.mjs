// DAG 生产装配（Spec §7）：把无模型控制器接到真实的槽位 worktree、Hub 事件/run 与 gh。
// 控制台不嵌套创建 ACP worker：节点工作只经 Hub 事件（dag.<slug>.<role>）派发，由 Hub 规则/worker 执行。
// 只装配、不放权：publish/merge/close 等动作仍由授权快照在 dag-publish 层逐项门禁。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createController, HUB_TERMINAL } from './dag-controller.mjs';
import { createGhAdapter } from './dag-gh.mjs';
import { acquireControllerLock } from './dag-lock.mjs';
import { createPublisher } from './dag-publish.mjs';
import { ROOT_NODE, createRunStore, isTerminal } from './dag-run.mjs';
import { createProgressNotifier, createSentStore, wakeSentFile } from './dag-stall.mjs';
import { createSlotRuntime, seg } from './dag-slots.mjs';
import { createSharedDeps } from './dag-deps.mjs';
import * as wip from './dag-wip.mjs';
import { hubRequest } from './hub.mjs';
import { verifyDesign as defaultVerifyDesign } from './design-verify.mjs';
import { ensureMirror } from './dag-mirror.mjs';
import { loadEnabledTiers, rulesConsume } from './dag-tier.mjs';

export const MIN_POLL_MS = 5000;
const HUB_STATES = new Set(['queued', 'claimed', 'unknown', 'done', 'nothing', 'cancelled']);
const msg = error => String(error?.message || error).replace(/[\r\n]+/g, ' ');

// Hub 事件类型上限 64 字符：dag.<slug>.<role>；slug 超长时稳定哈希截短。
export function dagEventType(project, role) {
  let slug = seg(path.basename(String(project)));
  const room = 64 - `dag..${role}`.length;
  if (slug.length > room) slug = `${slug.slice(0, room - 9)}-${createHash('sha1').update(slug).digest('hex').slice(0, 8)}`;
  return `dag.${slug}.${role}`;
}

// Hub 适配：hubRunId 即 Hub 事件号；事件 id 由 runId 决定，重复派发由 Hub 按 id 去重（幂等，不重复执行）。
// getRun 从事件结果推导状态：没有 run=queued；有多个 run 取最新；Hub 不可达抛错（由控制器本轮记 lastError，不改状态）。
// 授权按中台规则分治：/v1/events 的读与写用 source 密钥（中台要求事件「来源自己的密钥」），
// /v1/runs/:id/cancel 与 /v1/state 仍走 hubRequest 的 owner 默认（cancel 用 source 会被中台以「要本人自己的密钥」拒）。
// 纯文本回执兜底：worker 有时把回执写成 "advanceId=x runId=y ..." 而非 JSON。
// 能解析出 advanceId 即视为合法回执（evaluateAdvance 再校验字段一致性）；解析不出标记 malformed，
// 由 evaluateAdvance 判 stale（不计失败），避免同一次审阅被非结构化输出误计失败。
function parsePlainReceipt(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const out = {};
  for (const part of text.trim().split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq), value = part.slice(eq + 1);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) continue;
    out[key] = value === 'true' ? true : value === 'false' ? false : /^\d+$/.test(value) ? Number(value) : value;
  }
  return typeof out.advanceId === 'string' && out.advanceId.trim() ? out : null;
}

export function createHubAdapter({ config, request = hubRequest, project } = {}) {
  const outcome = eventNo => request(config, `/v1/events/${encodeURIComponent(eventNo)}`, { auth: 'source' });
  const newest = out => [...(out?.runs || [])].sort((a, b) => b.run - a.run)[0] || null;
  return {
    async dispatch({ run, slot, worktree, branch, expectedAdvanceId, model, tier, prompt }) {
      const build = text => JSON.stringify({ runId: run.runId, nodeId: run.nodeId, role: run.role, generation: run.generation, attempt: run.attempt, slot, worktree, branch, expectedAdvanceId, model: model ?? null, tier: tier ?? null, prompt: text });
      let detail = build(prompt);
      if (detail.length > 4000) {
        // 超限不截断：完整提示落盘，事件正文只放读取指引，worker 必须先读该文件（含节点契约与回执模板）。
        const dir = path.join(config?.root || tmpdir(), 'dag-prompts');
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${seg(run.runId)}.md`);
        writeFileSync(file, `${prompt}\n`, 'utf8');
        detail = build(`提示全文过长，未放进事件。先完整阅读此文件再动手（含节点契约与回执模板，回执以其为准）：${file}`);
        if (detail.length > 4000) throw new Error('派发事件正文超过 4000 字符，拒绝截断派发');
      }
      // 档位只在后台开关开启、且 rules.json 确有规则接收该分档事件时才进入事件类型；每次派发现读，改设置无需重启。
      const tiered = tier && loadEnabledTiers(config?.root).has(tier) ? dagEventType(project || run.project, `${run.role}.${tier}`) : null;
      const type = tiered && rulesConsume(config?.rulesFile, tiered) ? tiered : dagEventType(project || run.project, run.role);
      const res = await request(config, '/v1/events', { method: 'POST', auth: 'source', body: {
        id: `dag:${run.runId}`, type, subject: `dag-${seg(run.nodeId)}`,
        summary: `DAG ${run.nodeId} ${run.role} g${run.generation}a${run.attempt}`.slice(0, 200), detail,
      } });
      if (!res || !Number.isInteger(res.event)) throw new Error('Hub 未返回事件号，派发未确认');
      return { hubRunId: res.event };
    },
    async getRun(eventNo) {
      let out;
      try { out = await outcome(eventNo); }
      catch (error) { if (error?.status === 404) return { status: 'unknown' }; throw error; }
      const hubRun = newest(out);
      if (!hubRun) return { status: 'queued' };
      const status = HUB_STATES.has(hubRun.state) ? hubRun.state : 'unknown';
      const receipts = (hubRun.events || []).filter(e => /\.advance$/.test(e?.type || '')).map(e => {
        try { return JSON.parse(e.detail); } catch { /* 非 JSON：尝试 key=value 纯文本回执 */ }
        const parsed = parsePlainReceipt(e.detail);
        return parsed ?? { malformed: true };
      });
      return { status: status === 'nothing' ? 'done' : status, receipts, hubRun: hubRun.run };
    },
    async cancel(eventNo) {
      const out = await outcome(eventNo);
      for (const hubRun of out?.runs || []) {
        if (HUB_TERMINAL.has(hubRun.state === 'nothing' ? 'done' : hubRun.state) || hubRun.state === 'unknown') continue;
        await request(config, `/v1/runs/${encodeURIComponent(hubRun.run)}/cancel`, { method: 'POST', body: {} });
      }
      return {};
    },
  };
}

export const defaultRunTests = cwd => new Promise(resolve => {
  const home = mkdtempSync(path.join(tmpdir(), 'dag-test-home-'));
  execFile('npm', ['test'], {
    cwd, timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, TMPDIR: tmpdir(), NODE_OPTIONS: '' },
  }, (error, stdout) => {
    rmSync(home, { recursive: true, force: true });
    resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, tail: String(stdout).slice(-2000) });
  });
});

// blocked 证据复查（保守）：只有“从未派发”（没有 hubRunId，阻塞源是本地）且 Hub 可达时才认为证据消失；
// 已派发后回执畸形/失联的 blocked 保持阻塞，等人或明确的 revive，不会被静默放行。
export function createBlockedEvidence({ request, config }) {
  return async ({ run }) => {
    if (run.hub?.hubRunId) return { blocked: true };
    await request(config, '/v1/state');
    return { blocked: false, detail: '从未派发，Hub 可达，自动复活' };
  };
}

// 每个运行目录一份共享依赖缓存（进程内复用，后台安装状态跨 DAG 共享）。
const sharedDepsByRoot = new Map();
export function sharedDepsFor(root, options = {}) {
  if (!root) return null;
  if (!sharedDepsByRoot.has(root)) sharedDepsByRoot.set(root, createSharedDeps({ root, log: console.error, ...options }));
  return sharedDepsByRoot.get(root);
}

export async function createDagRuntime({ rootRun, config, store, request = hubRequest, gh, runTests = defaultRunTests, verifyDesign = defaultVerifyDesign, readToken, git, now = Date.now, chooseApproach, sharedDeps = sharedDepsFor(config?.root) } = {}) {
  if (!rootRun.mirrorPath || !rootRun.baseCommit) throw new Error('DAG run 缺少控制器 mirror/base 快照，拒绝在 worker 可写仓库执行');
  const rt = createSlotRuntime({ project: rootRun.mirrorPath, gitDir: rootRun.mirrorPath, runId: rootRun.runId, ...(git ? { git } : {}), ...(sharedDeps ? { depsSource: sharedDeps.resolve } : {}) });
  await rt.ensureSlots();
  const adapter = gh || createGhAdapter({ cwd: rootRun.project });
  const publisher = createPublisher({ store, rootRunId: rootRun.runId, rt, gh: adapter, runTests, verifyDesign, baseRef: `refs/heads/${rootRun.baseBranch}`, readToken });
  const hub = createHubAdapter({ config, request, project: rootRun.project });
  const baseRef = rootRun.baseBranch ? `refs/heads/${rootRun.baseBranch}` : 'origin/main';
  return createController({ store, rootRunId: rootRun.runId, hub, rt, wip, publisher, baseRef, now, chooseApproach, blockedEvidence: createBlockedEvidence({ request, config }) });
}

// 启动接线：发现全部未终结 DAG，逐个恢复控制器并以有界频率轮询。单 DAG 单写入者（进程锁 + 本进程 in-flight 守卫）。
export function startDagControllers({ config, store, directory = path.join(config.root, 'dag-runs'), intervalMs = 15000, log = console.error, build = createDagRuntime, request = hubRequest, setIntervalFn = setInterval, clearIntervalFn = clearInterval, ...rest } = {}) {
  const runStore = store || createRunStore({ directory });
  const controllers = new Map(); // rootRunId → { ctl, lock } | { pending:true }
  let inflight = null; let stopped = false;
  const every = Math.max(MIN_POLL_MS, Number(intervalMs) || MIN_POLL_MS);
  // sent 持久化：重启后同批状态变化不重复投递。与卡住巡检共用同一去重表文件。
  const progressSent = rest.progressSent || createSentStore({ file: wakeSentFile(runStore.directory || directory) });
  const notifyProgress = createProgressNotifier({ post: event => request(config, '/v1/events', { method: 'POST', body: event, auth: 'source' }), sent: progressSent });

  async function adopt(rootRun) {
    if (controllers.has(rootRun.runId)) return;
    controllers.set(rootRun.runId, { pending: true });
    const lock = acquireControllerLock({ directory: runStore.directory || directory, runId: rootRun.runId });
    if (!lock.acquired) { controllers.delete(rootRun.runId); return; }
    try { controllers.set(rootRun.runId, { lock, ctl: await build({ rootRun, config, store: runStore, request, ...rest }) }); }
    catch (error) { lock.release(); controllers.delete(rootRun.runId); log(`[dag] 恢复控制器失败 ${rootRun.runId}：${msg(error)}`); }
  }

  // DAG 终结（done/cancelled）后回收它的槽位 worktree：每个进程每条 run 只回收一次；
  // 有未保存改动的槽位保留（不丢 WIP）并记日志，下次启动再试。
  const pruned = new Set();
  async function pruneSlots(rootRun) {
    if (pruned.has(rootRun.runId) || !rootRun.mirrorPath) return;
    pruned.add(rootRun.runId);
    try {
      const result = await (rest.removeSlots || (run => createSlotRuntime({ project: run.mirrorPath, gitDir: run.mirrorPath, runId: run.runId }).removeSlots()))(rootRun);
      if (result?.removed?.length || result?.kept?.length) log(`[dag] 回收已终结 DAG 槽位 ${rootRun.runId}：移除 ${result.removed.length} 个${result.kept.length ? `，保留有未保存改动的槽位 ${result.kept.join(',')}` : ''}`);
    } catch (error) { log(`[dag] 回收槽位失败 ${rootRun.runId}：${msg(error)}`); }
  }

  // 同一时刻只跑一轮；重叠的调用复用在途那一轮（单写入者，重复 tick 幂等）。
  const tickOnce = () => (stopped ? Promise.resolve() : (inflight ||= runOnce().finally(() => { inflight = null; })));
  async function runOnce() {
    try {
      let roots;
      try { roots = runStore.listRuns().filter(run => run.nodeId === ROOT_NODE); }
      catch (error) { log(`[dag] 读取 dag-runs 失败（fail closed，本轮不推进）：${msg(error)}`); return; }
      for (const rootRun of roots) {
        if (isTerminal(rootRun.status)) {
          const held = controllers.get(rootRun.runId); held?.lock?.release(); controllers.delete(rootRun.runId);
          await pruneSlots(rootRun);
          continue;
        }
        await adopt(rootRun);
        const held = controllers.get(rootRun.runId);
        if (!held?.ctl) continue;
        try {
          const snap = await held.ctl.tick();
          // tick 已持久化后再叫醒：中台侧按 subject 串起同一链的事项，重复事件 ID 去重。
          if (snap?.progress?.length) {
            try { await notifyProgress(rootRun, snap); }
            catch (error) { log(`[dag-progress] 唤醒投递失败 ${rootRun.runId}：${msg(error)}`); }
          }
        } catch (error) { log(`[dag] tick 失败 ${rootRun.runId}：${msg(error)}`); }
      }
    } catch (error) { log(`[dag] 轮询异常：${msg(error)}`); }
  }

  const timer = setIntervalFn(() => { tickOnce(); }, every);
  timer?.unref?.();
  tickOnce();
  return {
    tickOnce,
    stop() { stopped = true; clearIntervalFn(timer); for (const { lock } of controllers.values()) lock?.release(); controllers.clear(); },
  };
}
