// 额度拒绝自动侦测：读运行目录最近轮次失败记录，按可配模式匹配额度拒绝，
// 同一 agent+model 连续 N 次命中即按路由政策表自动登记绕行（带来源标记与证据原文）。
// 只做侦测与裁定；登记/改派/回滚/留痕复用 src/detour.mjs 的原子事务与状态锁。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { classifyKind, loadPolicy, resolveFallback } from './detour-policy.mjs';
import { findActiveDetour, recordDetour } from './detour.mjs';
import { probeCommand } from '../scripts/detour-probe.mjs';

export class QuotaScanError extends Error {}

/** 默认额度拒绝模式；CLI --patterns 可整体替换。英文模式不区分大小写。 */
export const DEFAULT_PATTERNS = ['429', 'refusal', '配额', 'quota', '额度', 'rate.?limit', 'exhausted', 'too many requests'];

// 凭证/密钥/token/URL 凭据去敏：与 dag-stall.mjs 同口径，证据写入 detours.json 与控制台响应前先抹掉。
export function redactEvidence(text) {
  return String(text ?? '')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/g, '***')
    .replace(/\b(sk-[A-Za-z0-9]{10,})/g, '***')
    .slice(0, 600);
}

const AGENT_HINTS = [
  [/codex-full/i, 'codex-full'],
  [/codex/i, 'codex'],
  [/codebuddy|workbuddy/i, 'workbuddy'],
  [/claude/i, 'claude'],
];

function runner(text, pattern) {
  // 纯数字模式（如 429）加词边界，避免命中 4291/14290 等无关数字；其余模式原样。
  const source = /^\d+$/.test(pattern) ? `\\b${pattern}\\b` : pattern;
  try { return new RegExp(source, 'i').test(text); }
  catch { return new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text); }
}

export function matchesPattern(text, patterns) {
  const value = String(text ?? '');
  return patterns.some((pattern) => runner(value, pattern));
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

function collectFailureText(dir) {
  const chunks = [];
  for (const name of readdirSync(dir)) {
    if (!/^(stdout|stderr)-\d+\.log$/.test(name)) continue;
    try { chunks.push(readFileSync(path.join(dir, name), 'utf8')); }
    catch { /* 轮次日志读不到就跳过，不影响其余轮次 */ }
  }
  const raw = chunks.join('\n');
  const errors = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"error"')) continue;
    const parsed = readJsonLine(line);
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) errors.push(parsed.error.trim());
  }
  // evidence 只取自 error 行，不用 raw 全文兜底——否则任何有 stdout 的成功轮次都显得"有证据"。
  return { raw, errors, evidence: errors.join('；') };
}

function readJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function dirTime(dir) {
  let latest = 0;
  for (const name of readdirSync(dir)) {
    try { latest = Math.max(latest, statSync(path.join(dir, name)).mtimeMs); }
    catch { /* 单文件 stat 失败不影响时间推断 */ }
  }
  return new Date(latest || Date.now()).toISOString();
}

function extractModel(entry, commandText, failureText) {
  const direct = entry?.job?.agent?.model;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  for (const text of [commandText, failureText]) {
    const flag = /--model[= ]+([\w.-]+)/i.exec(text || '');
    if (flag) return flag[1];
    const kv = /\bmodel[=:]\s*([\w.-]+)/i.exec(text || '');
    if (kv) return kv[1];
  }
  return '';
}

function extractAgent(entry, commandText) {
  const direct = entry?.job?.agent?.id;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  for (const [pattern, agent] of AGENT_HINTS) if (pattern.test(commandText || '')) return agent;
  return '';
}

/** 只读：返回最近 window 个轮次的失败记录（含成功轮次，用于打断连续计数）。 */
export function readRunFailures({ root, runsDir, window = 200, patterns = DEFAULT_PATTERNS } = {}) {
  const dir = runsDir || path.join(root, 'worker', 'runs');
  if (!existsSync(dir)) return [];
  const runs = readdirSync(dir)
    .map((name) => { const m = /^(\d+)-(\d+)$/.exec(name); return m ? { name, run: Number(m[1]), attempt: Number(m[2]) } : null; })
    .filter(Boolean)
    .sort((a, b) => a.run - b.run || a.attempt - b.attempt)
    .slice(-Math.max(1, window));
  const out = [];
  for (const item of runs) {
    const full = path.join(dir, item.name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const entry = readJson(path.join(full, 'entry.json'));
    let commandText = '';
    try { commandText = readFileSync(path.join(full, 'command-1.sh'), 'utf8'); } catch { /* 老轮次没有命令脚本 */ }
    const { raw, errors, evidence } = collectFailureText(full);
    let exitCode = null;
    try { exitCode = Number(readFileSync(path.join(full, 'exit-1'), 'utf8').trim()); } catch { /* 缺 exit-1 时降级用 error 行判定 */ }
    const agent = extractAgent(entry, commandText);
    const model = extractModel(entry, commandText, raw);
    const ruleName = typeof entry?.job?.rule?.name === 'string' ? entry.job.rule.name : '';
    // 有退出码只认退出码：exit 0 的成功轮次即使 stdout 含模式也不算失败。
    // 缺退出码才降级用 error 行数（非 raw 全文）。模式匹配只对 error 提取行执行。
    const failed = Number.isFinite(exitCode) ? exitCode !== 0 : errors.length > 0;
    const errorText = errors.join('\n');
    out.push({
      id: item.name, run: item.run, attempt: item.attempt, agent, model,
      kind: classifyKind(ruleName), ruleName,
      failed, quota: failed && matchesPattern(errorText, patterns),
      evidence: evidence || '(无错误原文)', at: dirTime(full),
    });
  }
  return out;
}

const idStamp = (now) => now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/** 只读：从 hub.db 的 runs 视图取最近失败轮次（含成功，用于打断连续计数）。
 * Hub 侧的额度拒绝不落在 worker/runs 文件里（比如调度会话回合 / scheduling.message），
 * 只存于 Hub 的 runs 表（state/error/summary）。失败以 error/summary 命中额度模式判定；
 * done/nothing/failed/refusal 为终态，queued/claimed 会还继续排队重试，也按未终结算命中（它们也是失败）。
 * 与 worker 侧同口径：同一 agent+model 连续 N 次命中即登记绕行。 */
export function readHubRunFailures({ dbFile, window = 200, patterns = DEFAULT_PATTERNS } = {}) {
  if (!dbFile || !existsSync(dbFile)) return [];
  let rows;
  try {
    const out = execFileSync('/usr/bin/sqlite3', ['-json', dbFile, `select id,rule,agent,state,attempts,error,summary,created_at from runs order by id desc limit ${Math.max(1, window)}`], { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 }).toString();
    rows = JSON.parse(out);
    if (!Array.isArray(rows)) rows = [];
  } catch { return []; }
  // 从新到旧返回；主流程与 worker 侧同口径：同 agent+model 连续命中累计，被成功打断的清零。
  return rows.reverse().map(row => {
    const errorText = [row.error, row.summary].filter(Boolean).join('\n');
    const quota = matchesPattern(errorText, patterns);
    // done/nothing 的回合是成功的，不算失败——summary 里即使出现"429"也只是叙述；
    // queued/claimed 且命中模式的按失败算（还在排队重试）。
    const failed = !['done', 'nothing'].includes(row.state) && quota;
    return {
      id: String(row.id), run: Number(row.id), attempt: 1, agent: String(row.agent || ''), model: '',
      kind: classifyKind(row.rule), ruleName: String(row.rule || ''),
      failed: failed && quota, quota, hits: failed && quota ? Math.max(1, Number(row.attempts) || 0) : 1, evidence: redactEvidence(errorText) || '(无错误原文)', at: row.created_at || '',
    };
  });
}

/** 主流程：扫描→连续计数→按政策登记。任何单条登记失败只记 skip，不中断整轮。 */
export function scanForQuotaDetours(config, options = {}) {
  const patterns = Array.isArray(options.patterns) && options.patterns.length ? options.patterns : DEFAULT_PATTERNS;
  const threshold = Number(options.threshold ?? 3);
  if (!Number.isInteger(threshold) || threshold < 1) throw new QuotaScanError('threshold 要是至少 1 的整数');
  const policy = options.policy || loadPolicy(config);
  const cooldownMinutes = Number(options.cooldownMinutes ?? 30);
  const probeCommand = Array.isArray(options.probeCommand) && options.probeCommand.length
    ? options.probeCommand.map(String) : null;
  const now = options.now instanceof Date ? options.now : new Date();
  const hubFailures = readHubRunFailures({ dbFile: options.hubDbFile ?? path.join(config.root, 'hub.db'), window: options.window, patterns });
  // Hub 一行已用 attempts 涵盖该任务的全部尝试；同一 run 号在 worker 日志里的各次尝试不再重复计入。
  const hubRunIds = new Set(hubFailures.map(item => item.run));
  const workerFailures = readRunFailures({ root: config.root, runsDir: options.runsDir, window: options.window, patterns })
    .filter(item => !hubRunIds.has(item.run));
  const failures = [...workerFailures, ...hubFailures];

  const states = new Map();
  for (const failure of failures) {
    if (!failure.agent) continue; // 认不出 agent 的轮次不参与计数
    const key = `${failure.agent}|${failure.model}`;
    if (failure.failed && failure.quota) {
      const state = states.get(key) || { count: 0, samples: [], kind: failure.kind, at: failure.at };
      state.agent = failure.agent; state.model = failure.model;
      state.count += failure.hits || 1; // Hub 一条 run 重试 N 次只有一行，按 attempts 计 N 次
      state.samples.push(`run ${failure.id}${failure.hits > 1 ? `（重试 ${failure.hits} 次）` : ''}「${failure.evidence}」`);
      state.kind = state.kind || failure.kind;
      state.at = failure.at;
      states.set(key, state);
    } else {
      states.delete(key); // 成功或非额度失败都打断同 agent+model 的连续命中
    }
  }
  // 只有窗口末尾仍在连续命中且达到阈值的 streak 才登记：历史 streak 被后来的成功打断的不误绕。
  // 用 >=：连续命中超过阈值（更该绕行）不能漏掉。
  const candidates = [...states.values()]
    .filter(state => state.count >= threshold)
    .map(state => ({ agent: state.agent, model: state.model, kind: state.kind, at: state.at, hits: state.count, evidence: state.samples.join('；') }));

  const detours = [];
  const skipped = [];
  for (const candidate of candidates) {
    const why = (reason) => skipped.push({ agent: candidate.agent, model: candidate.model, reason });
    if (!candidate.kind) { why('判不出工作类型，未登记'); continue; }
    if (findActiveDetour(config, { blockedAgent: candidate.agent, blockedModel: candidate.model })) { why('已有在途绕行，幂等跳过'); continue; }
    const rawRules = readJson(config.rulesFile);
    const rules = Array.isArray(rawRules?.rules) ? rawRules.rules : [];
    const matching = rules.filter((rule) => rule.to === candidate.agent && classifyKind(rule.name) === candidate.kind);
    if (!matching.length) { why('没有在被拦 Agent 上的该类型规则'); continue; }
    const fallback = resolveFallback(candidate.kind, candidate.agent, { policy, cwd: matching[0].cwd });
    if (!fallback) { why('非主 Agent 或已在政策链末端，不自动改派'); continue; }
    const targets = matching.filter((rule) => resolveFallback(candidate.kind, candidate.agent, { policy, cwd: rule.cwd }) === fallback);
    const ruleNames = targets.map((rule) => rule.name);
    const id = `auto-${candidate.agent}-${candidate.model || 'unknown'}-${idStamp(now)}`.replace(/[^\w.-]/g, '_').replace(/\.\./g, '_');
    const evidence = `自动侦测：${candidate.agent}${candidate.model ? `/${candidate.model}` : '/model未识别'} 连续 ${candidate.hits} 次额度拒绝（命中模式 ${patterns.join('|')}）；证据原文：${candidate.evidence}；最近命中 ${candidate.at}`;
    candidate.plan = { id, fallbackAgent: fallback, ruleNames };
    if (options.dryRun) { why('dry-run 预演，未写入'); continue; }
    try {
      detours.push(recordDetour(config, {
        id, origin: 'auto-scan', blockedAgent: candidate.agent, blockedModel: candidate.model,
        evidence, fallbackAgent: fallback, ruleNames,
        probe: { ...(probeCommand ? { command: probeCommand } : autoProbe(rawRules?.agents?.[candidate.agent])), cooldownMinutes },
      }, now));
    } catch (error) {
      why(`登记失败：${error.message}`);
    }
  }

  return { scanned: failures.length, candidates, detours, skipped, threshold, patterns };
}

/** 未显式传 --probe 时，为被拦 Agent 自动拼一条最便宜的试活命令；拼不出返回 {} 由登记跳过。 */
function autoProbe(agent) {
  const command = probeCommand(agent);
  return command ? { command } : {};
}
