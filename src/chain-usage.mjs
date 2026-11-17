// 真·整条链累计（Token 与计费）：Hub 的 lines.totals.usage 只是当日窗口（tally 按
// dayStart 过滤），直接当"累计"会把今日误标为全程。本模块改为翻页读取 /v1/state
// 的 runs 历史（?before=<id> 向前翻，runs 表只增不删），把每条规则已完成轮次自报的
// usage 累加进 <root>/chain-usage.json 台账：
//   - 只统计有 finishedAt 的轮次；看到过但未完成的轮次进 pending，完成后补入账；
//   - 费用缺失如实记 missingCostRounds，cost 保持 null，不用零冒充上报（协议 §6.2 口径）;
//   - 台账按已见 run id 去重（seen 前沿），重复读取/翻页重叠都不会重复计费；
//   - 控制台轮询热路径带 30s TTL 与 in-flight 去重；首轮未翻到底（新台账）不受 TTL 限制，立即续翻。
// 控制台不折算、不按模型名估算费用。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { hubRequest } from './hub.mjs';
import { chainRuleNames } from './serial-progress.mjs';
import { withStateLockAsync } from './detour.mjs';

export const LEDGER_FILE = 'chain-usage.json';
const LEDGER_VERSION = 1;
const REFRESH_TTL_MS = 30000;
const MAX_PAGES_PER_REFRESH = 100;

const isNum = value => typeof value === 'number' && Number.isFinite(value);
const cleaned = value => String(value ?? '').trim();
const baseName = value => {
  const text = cleaned(value).replace(/[\\/]+$/, '');
  return text.split(/[\\/]/).pop() || text;
};

const emptyEntry = () => ({ counted: [], pending: [], input: 0, output: 0, cost: 0, costReported: false, rounds: 0, missingCostRounds: 0 });

export function ledgerPath(root) { return path.join(root, LEDGER_FILE); }

function validEntry(value) {
  return value && typeof value === 'object'
    && Array.isArray(value.counted) && Array.isArray(value.pending)
    && value.counted.every(isNum) && value.pending.every(isNum);
}

export function readLedger(root) {
  const blank = { version: LEDGER_VERSION, seen: [], rules: {}, complete: false, updatedAt: null };
  if (!root) return blank;
  let data;
  try { data = JSON.parse(readFileSync(ledgerPath(root), 'utf8')); }
  catch { return blank; }
  if (!data || typeof data !== 'object' || data.version !== LEDGER_VERSION) return blank;
  const rules = {};
  for (const [name, entry] of Object.entries(data.rules || {})) {
    if (validEntry(entry)) rules[cleaned(name)] = { ...emptyEntry(), ...entry };
  }
  return {
    ...blank,
    seen: Array.isArray(data.seen) ? data.seen.filter(isNum) : [],
    rules,
    complete: data.complete === true,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
  };
}

function persistLedger(root, ledger) {
  const tmp = ledgerPath(root) + '.tmp';
  writeFileSync(tmp, JSON.stringify({ ...ledger, updatedAt: new Date().toISOString() }));
  renameSync(tmp, ledgerPath(root));
}

// 链词干零命中时回退到项目归属规则（未被其他链词干认领），与 public/status-sections.mjs 同口径。
function resolveChainRules(chain, rules, allChains) {
  const names = chainRuleNames(chain?.sourceFile, rules);
  if (names.length) return names;
  const claimed = new Set();
  for (const other of allChains || []) {
    if (other === chain) continue;
    for (const name of chainRuleNames(other?.sourceFile, rules)) claimed.add(name);
  }
  const project = baseName(chain?.project);
  if (!project || project === '未识别') return [];
  return rules
    .filter(rule => baseName(rule?.cwd) === project && !claimed.has(rule.name))
    .map(rule => rule.name);
}

const entryTotals = entry => ({
  input: entry.input,
  output: entry.output,
  tokens: entry.input + entry.output,
  cost: entry.costReported ? entry.cost : null,
  rounds: entry.rounds,
  missingCostRounds: entry.missingCostRounds,
});

const sumEntries = entries => {
  const acc = emptyEntry();
  for (const entry of entries) {
    acc.input += entry.input; acc.output += entry.output; acc.cost += entry.cost;
    acc.costReported = acc.costReported || entry.costReported;
    acc.rounds += entry.rounds; acc.missingCostRounds += entry.missingCostRounds;
  }
  return entryTotals(acc);
};

const inFlight = new WeakMap();
const lastRefresh = new WeakMap();

// 翻页累加台账并返回 { byRule, byChain, byProject }（Map）；中台不可用返回 null，调用方降级。
export function refreshUsage({ config, rules = [], chains = [], ttlMs = Number(process.env.CHAIN_USAGE_TTL_MS ?? REFRESH_TTL_MS) } = {}) {
  if (!config?.root) return Promise.resolve(null);
  const signature = (chains || []).map(chain => chain?.sourceFile).join(',');
  const previous = lastRefresh.get(config);
  if (previous && Date.now() - previous.at < ttlMs && (previous.complete || previous.freshEnough)) {
    if (previous.signature === signature) return Promise.resolve(previous.result);
    // 链集合变了（如链文件刚写入）：不重新翻中台，直接按台账重建本次结果。
    const ledger = readLedger(config.root);
    const result = buildResult({ rules, chains, entries: ledger.rules });
    lastRefresh.set(config, { ...previous, signature, result });
    return Promise.resolve(result);
  }
  if (inFlight.has(config)) return inFlight.get(config);
  const promise = doRefresh({ config, rules, chains, signature })
    .catch((e) => { if (process.env.CHAIN_USAGE_DEBUG) throw e; return null; })
    .finally(() => inFlight.delete(config));
  inFlight.set(config, promise);
  return promise;
}

async function doRefresh({ config, rules, chains, signature }) {
  const ledger = readLedger(config.root);
  const known = new Set(rules.map(rule => cleaned(rule?.name)).filter(Boolean));
  const seen = new Set(ledger.seen);
  const entries = ledger.rules;
  const entryFor = name => {
    const key = cleaned(name);
    if (!entries[key]) entries[key] = emptyEntry();
    return entries[key];
  };

  const fetchState = before => hubRequest(config, '/v1/state' + (before == null ? '' : `?before=${before}`));
  let before = null;
  let hasMore = true;
  let pages = 0;
  let reachedBottom = ledger.complete;
  while (hasMore && pages < MAX_PAGES_PER_REFRESH) {
    const state = await fetchState(before);
    pages += 1;
    const unique = new Map();
    for (const run of state?.runs || []) {
      const id = Number(run?.id);
      if (isNum(id) && !unique.has(id)) unique.set(id, run);
    }
    const page = [...unique.values()].sort((a, b) => Number(b.id) - Number(a.id));
    let pageMin = Infinity;
    let allSeen = true;
    for (const run of page) {
      const id = Number(run.id);
      pageMin = Math.min(pageMin, id);
      if (!seen.has(id)) { seen.add(id); allSeen = false; }
      if (!known.has(run.rule)) continue;
      const entry = entryFor(run.rule);
      if (entry.counted.includes(id)) continue;
      if (run.finishedAt) {
        entry.pending = entry.pending.filter(item => item !== id);
        entry.counted.push(id);
        entry.rounds += 1;
        const usage = run.usage && typeof run.usage === 'object' ? run.usage : null;
        if (usage) {
          if (isNum(usage.input)) entry.input += usage.input;
          if (isNum(usage.output)) entry.output += usage.output;
          if (isNum(usage.cost)) { entry.cost += usage.cost; entry.costReported = true; }
          else entry.missingCostRounds += 1;
        } else {
          entry.missingCostRounds += 1;
        }
      } else if (!entry.pending.includes(id)) {
        entry.pending.push(id);
      }
    }
    before = state?.nextBefore ?? null;
    hasMore = Boolean(state?.hasMore) && before != null;
    if (!hasMore) reachedBottom = true;
    const pendingOlder = Object.values(entries).some(entry => entry.pending.some(id => id < pageMin));
    if (allSeen && !pendingOlder) break;
  }

  ledger.seen = [...seen].sort((a, b) => a - b);
  ledger.complete = reachedBottom;
  const result = buildResult({ rules, chains, entries });
  await withStateLockAsync(config, async () => { persistLedger(config.root, ledger); });
  lastRefresh.set(config, { at: Date.now(), complete: ledger.complete, freshEnough: pages <= 2, signature, result });
  return result;
}

function buildResult({ rules, chains, entries }) {
  const byRule = new Map();
  for (const name of Object.keys(entries)) byRule.set(name, entryTotals(entries[name]));
  const byChain = new Map();
  for (const chain of chains || []) {
    const names = resolveChainRules(chain, rules, chains);
    if (!names.length) continue;
    byChain.set(chain.sourceFile, sumEntries(names.map(name => entries[name] || emptyEntry())));
  }
  const byProject = new Map();
  const projectOf = new Map(rules.map(rule => [rule.name, baseName(rule?.cwd)]));
  for (const [name, totals] of byRule) {
    const key = projectOf.get(name) || '未识别';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(entries[name]);
  }
  for (const [key, list] of byProject) byProject.set(key, sumEntries(list));
  return { byRule, byChain, byProject };
}
