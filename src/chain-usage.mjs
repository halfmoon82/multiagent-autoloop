// 真·整条链累计（Token 与计费）：Hub 的 lines.totals.usage 只是当日窗口（tally 按
// dayStart 过滤），直接当"累计"会把今日误标为全程。本模块改为翻页读取 /v1/state
// 的 runs 历史（?before=<id> 向前翻，runs 表只增不删），把每条规则已完成轮次自报的
// usage 累加进 <root>/chain-usage.json 台账：
//   - 只统计已开始过的轮次（有 finishedAt，且 claimedAt 或 usage 存在）：从未开跑的
//     取消轮次不计入 rounds，与中台 §6.2 spending 口径一致；
//   - 费用缺失如实记 missingCostRounds，cost 保持 null，不用零冒充上报；
//   - 已见 run id 去重（counted），重复读取/翻页重叠都不会重复计费；
//   - 回填有持久化断点 backfillCursor：单次翻页预算用满后下一轮从断点续翻，
//     绝不因截断把更早历史永久漏掉；未翻到底时在结果里带 backfillPending，
//     界面如实标注"历史补全中"，不把部分覆盖冒充全量；
//   - 长期未完成轮次：超过 24h 移出 pending 进 unsettled（不再阻塞前沿），
//     但只要中台把它再暴露出来（active 轮次并入首页）完成后照样入账，不丢钱；
//   - 热路径：30s TTL + in-flight 去重；签名（链集合+规则表）变化时按台账本地重建，
//     不再翻中台也不返回陈旧结果；中台失败进入 60s 退避，退避期内零中台请求。
// 控制台不折算、不按模型名估算费用。
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { hubRequest } from './hub.mjs';
import { chainRuleNames } from './serial-progress.mjs';
import { withStateLockAsync, DetourError } from './detour.mjs';

export const LEDGER_FILE = 'chain-usage.json';
const LEDGER_VERSION = 2;
const LEGACY_VERSIONS = new Set([1]);
const REFRESH_TTL_MS = 30000;
const MAX_PAGES_PER_REFRESH = 100;
// 未完成轮次超过该时长不再阻塞扫描前沿（中台把 queued/claimed/unknown 并入首页，
// 它们之后完成时仍会被看到并入账；这里只是放弃"为它反复深翻历史"）。
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const UNSETTLED_MAX = 500;
const FAILURE_BACKOFF_MS = 60000;

const isNum = value => typeof value === 'number' && Number.isFinite(value);
const cleaned = value => String(value ?? '').trim();
const baseName = value => {
  const text = cleaned(value).replace(/[\\/]+$/, '');
  return text.split(/[\\/]/).pop() || text;
};
const parseTime = value => {
  const at = Date.parse(value || '');
  return Number.isNaN(at) ? null : at;
};
const maxPagesPerRefresh = () => {
  const raw = Number(process.env.CHAIN_USAGE_MAX_PAGES);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : MAX_PAGES_PER_REFRESH;
};

// counted: 已入账 run id；pending: 观察到的未完成轮次 {id, since}（阻塞前沿，至多 24h）；
// unsettled: 超时未完成轮次 id（不阻塞，出现即补计）。
const emptyEntry = () => ({ counted: [], pending: [], unsettled: [], input: 0, output: 0, cost: 0, costReported: false, rounds: 0, missingCostRounds: 0 });

export function ledgerPath(root) { return path.join(root, LEDGER_FILE); }

const idList = value => (Array.isArray(value) ? value.filter(isNum) : []);
function pendingList(value, fallbackSince) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (isNum(item)
      // 旧形态（纯 id）：没有观察时间，用台账 updatedAt 兜底；两者都缺视为"刚看到"，
      // 宁可晚一轮清退也不永久阻塞前沿。
      ? { id: item, since: fallbackSince || new Date().toISOString() }
      : (isNum(item?.id) ? { id: item.id, since: typeof item.since === 'string' ? item.since : fallbackSince || new Date().toISOString() } : null)))
    .filter(Boolean);
}

function validEntry(value) {
  return value && typeof value === 'object'
    && Array.isArray(value.counted) && value.counted.every(isNum);
}

export function readLedger(root) {
  const blank = { version: LEDGER_VERSION, seen: [], rules: {}, complete: false, backfillCursor: null, updatedAt: null };
  if (!root) return blank;
  let data;
  try { data = JSON.parse(readFileSync(ledgerPath(root), 'utf8')); }
  catch { return blank; }
  if (!data || typeof data !== 'object') return blank;
  if (data.version !== LEDGER_VERSION && !LEGACY_VERSIONS.has(data.version)) return blank;
  const updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
  const rules = {};
  const seen = new Set(idList(data.seen));
  for (const [name, entry] of Object.entries(data.rules || {})) {
    if (!validEntry(entry)) {
      // 整条判废：其 id 必须一并从 seen 剔除，否则这些轮次既不被计数、
      // 又会被前沿判定当成"已覆盖"而永久漏计。
      for (const id of idList(entry?.counted)) seen.delete(id);
      for (const item of (Array.isArray(entry?.pending) ? entry.pending : [])) seen.delete(isNum(item) ? item : Number(item?.id));
      continue;
    }
    rules[cleaned(name)] = {
      ...emptyEntry(),
      ...entry,
      counted: idList(entry.counted),
      pending: pendingList(entry.pending, updatedAt),
      unsettled: idList(entry.unsettled),
    };
  }
  return {
    ...blank,
    seen: [...seen].sort((a, b) => a - b),
    rules,
    complete: data.version === LEDGER_VERSION ? data.complete === true : false,
    backfillCursor: isNum(data.backfillCursor) ? data.backfillCursor : null,
    updatedAt,
  };
}

function persistLedger(root, ledger) {
  // tmp 名带 pid+随机后缀：进程重启重叠或未来出现第二个写者时不会互撕同一个 tmp。
  const tmp = `${ledgerPath(root)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ ...ledger, version: LEDGER_VERSION, updatedAt: new Date().toISOString() }));
    renameSync(tmp, ledgerPath(root));
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* tmp 可能根本没建成 */ }
    throw error;
  }
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
const lastFailure = new WeakMap();

function rebuildFromLedger({ config, rules, chains, signature }) {
  const ledger = readLedger(config.root);
  const result = buildResult({ rules, chains, entries: ledger.rules, backfillPending: !ledger.complete });
  lastRefresh.set(config, { at: Date.now(), complete: ledger.complete, freshEnough: true, signature, result });
  return result;
}

// 台账刷新：返回 { byRule, byChain, byProject }（Map）；中台不可用返回 null，调用方降级。
// ttlMs/backoffMs 仅为测试与特殊场景注入，默认走热路径保护常量。
export function refreshUsage({ config, rules = [], chains = [], ttlMs = Number(process.env.CHAIN_USAGE_TTL_MS ?? REFRESH_TTL_MS), backoffMs = FAILURE_BACKOFF_MS } = {}) {
  if (!config?.root) return Promise.resolve(null);
  const signature = [
    ...(chains || []).map(chain => chain?.sourceFile),
    ...(rules || []).map(rule => `${rule?.name}@${rule?.cwd}`),
  ].join(',');
  const previous = lastRefresh.get(config);
  // 退避期：零中台请求，但绝不丢弃已落盘进度——按台账本地重建本次结果。
  if (Date.now() - (lastFailure.get(config) || 0) < backoffMs) {
    return Promise.resolve(rebuildFromLedger({ config, rules, chains, signature }));
  }
  if (previous && Date.now() - previous.at < ttlMs && (previous.complete || previous.freshEnough)) {
    if (previous.signature === signature) return Promise.resolve(previous.result);
    return Promise.resolve(rebuildFromLedger({ config, rules, chains, signature }));
  }
  if (inFlight.has(config)) {
    // 共享在途扫描的结果是按发起方的签名构建的；签名不同则本地按台账重建，避免
    // project-usage 先起翻时把 serial-progress 的链累计整个吃掉。
    const shared = inFlight.get(config);
    return signature === inFlight.get(config).signature
      ? shared
      : shared.then(result => (result === null ? null : rebuildFromLedger({ config, rules, chains, signature })));
  }
  const promise = doRefresh({ config, rules, chains, signature });
  promise.signature = signature;
  inFlight.set(config, promise);
  promise.catch(() => {}).finally(() => { if (inFlight.get(config) === promise) inFlight.delete(config); });
  return promise;
}

async function doRefresh({ config, rules, chains, signature }) {
  try {
    const result = await scanLedger({ config, rules, chains, signature });
    lastFailure.delete(config);
    return result;
  } catch (error) {
    // 状态锁被占用（detour 等）不算中台故障：不置退避，另记日志，保留已有台账结果。
    if (error instanceof DetourError) {
      console.error(`[chain-usage] 台账落盘被状态锁挡住，本轮跳过：${error.message}`);
      return rebuildFromLedger({ config, rules, chains, signature });
    }
    lastFailure.set(config, Date.now());
    console.error(`[chain-usage] 台账刷新失败，${Math.round(FAILURE_BACKOFF_MS / 1000)}s 内不再扫描中台：${error.message}`);
    throw error;
  }
}

async function scanLedger({ config, rules, chains, signature }) {
  const ledger = readLedger(config.root);
  const now = Date.now();
  for (const entry of Object.values(ledger.rules)) {
    // 超时的未完成轮次不再阻塞前沿：转入 unsettled 记账，中台再暴露它时照样补计。
    const fresh = [];
    for (const item of entry.pending) {
      const at = parseTime(item.since);
      if (at === null || now - at < PENDING_TTL_MS) fresh.push(item);
      else if (!entry.unsettled.includes(item.id) && entry.unsettled.length < UNSETTLED_MAX) entry.unsettled.push(item.id);
    }
    entry.pending = fresh;
  }
  const known = new Set(rules.map(rule => cleaned(rule?.name)).filter(Boolean));
  const seen = new Set(ledger.seen);
  const entries = ledger.rules;
  const index = new Map();   // rule → {counted:Set, pending:Set, unsettled:Set}（翻页判定的 O(1) 视图）
  const indexFor = name => {
    let view = index.get(name);
    if (!view) {
      const entry = entries[name] || (entries[name] = emptyEntry());
      view = { entry, counted: new Set(entry.counted), pending: new Set(entry.pending.map(item => item.id)), unsettled: new Set(entry.unsettled) };
      index.set(name, view);
    }
    return view;
  };

  const fetchState = before => hubRequest(config, '/v1/state' + (before == null ? '' : `?before=${before}`));
  const maxPages = maxPagesPerRefresh();
  let pages = 0;

  const processPage = state => {
    const unique = new Map();
    for (const run of state?.runs || []) {
      const id = Number(run?.id);
      if (isNum(id) && !unique.has(id)) unique.set(id, run);
    }
    let pageMin = Infinity;
    let allSeen = true;
    for (const run of unique.values()) {
      const id = Number(run.id);
      pageMin = Math.min(pageMin, id);
      if (!seen.has(id)) { seen.add(id); allSeen = false; }
      const name = cleaned(run.rule);
      if (!known.has(name)) continue;
      const view = indexFor(name);
      const { entry } = view;
      if (view.counted.has(id) || !run.finishedAt) {
        if (!run.finishedAt && !view.counted.has(id) && !view.pending.has(id) && !view.unsettled.has(id)) {
          entry.pending.push({ id, since: new Date().toISOString() });
          view.pending.add(id);
        }
        continue;
      }
      // 从未开跑的取消轮次不计入 rounds（与中台 §6.2 spending 的 claimed/usage 判据一致）。
      if (!run.claimedAt && !(run.usage && typeof run.usage === 'object')) continue;
      view.counted.add(id);
      entry.counted.push(id);
      entry.pending = entry.pending.filter(item => item.id !== id);
      view.pending.delete(id);
      entry.unsettled = entry.unsettled.filter(item => item !== id);
      view.unsettled.delete(id);
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
    }
    return { allSeen, pageMin };
  };

  // 逐页落盘：中途失败也保住已扫进度与续翻断点，下一轮从断点继续。
  const flush = cursor => {
    ledger.seen = [...seen].sort((a, b) => a - b);
    ledger.complete = false;
    ledger.backfillCursor = isNum(cursor) && cursor > 0 ? cursor : null;
    persistLedger(config.root, ledger);
  };

  const nextCursor = state => (Number.isSafeInteger(state?.nextBefore) && state.nextBefore > 0 ? state.nextBefore : null);

  // 阶段一：增量前沿扫描（最新往旧）。触底即全程覆盖；遇到"整页都已见且无更早待补
  // 的未完成轮次"就在前沿停下——前提是历史已回填到底，否则停在这里会把尾部历史
  // 永久留在未扫描区（见阶段二）。
  // flush 会把落盘态的 complete 置回 false（扫描未结束前不算全程覆盖），
  // 因此先快照进入时的状态，供阶段二的"是否还需要回填"判定。
  const alreadyComplete = ledger.complete === true;
  let before = null;
  let reachedBottom = false;
  while (pages < maxPages) {
    const state = await fetchState(before);
    const { allSeen, pageMin } = processPage(state);
    pages += 1;
    const next = nextCursor(state);
    if (next == null) { reachedBottom = true; before = null; break; }
    before = next;
    flush(before);
    const pendingOlder = Object.values(entries).some(entry => entry.pending.some(item => item.id < pageMin));
    if (allSeen && !pendingOlder) break;
  }

  // 阶段二：历史回填。只要台账还没到底过（complete=false），就必须从持久化断点继续
  // 往旧翻，预算用满则把断点写回台账，下一轮接着翻——截断不会永久漏计更早历史。
  if (!reachedBottom && !alreadyComplete) {
    const stored = isNum(ledger.backfillCursor) && ledger.backfillCursor > 0 ? ledger.backfillCursor : null;
    const candidates = [stored, isNum(before) ? before : null].filter(isNum);
    let cursor = candidates.length ? Math.min(...candidates) : null;
    while (cursor != null && pages < maxPages) {
      const state = await fetchState(cursor);
      processPage(state);
      pages += 1;
      const next = nextCursor(state);
      if (next == null) { reachedBottom = true; cursor = null; break; }
      cursor = next;
      flush(cursor);
    }
    if (!reachedBottom) ledger.backfillCursor = cursor;
  }

  ledger.seen = [...seen].sort((a, b) => a - b);
  ledger.complete = reachedBottom;
  if (reachedBottom) ledger.backfillCursor = null;
  const result = buildResult({ rules, chains, entries, backfillPending: !ledger.complete });
  try {
    await withStateLockAsync(config, async () => { persistLedger(config.root, ledger); });
  } catch (error) {
    if (!(error instanceof DetourError)) throw error;
    // 收尾落盘被状态锁挡住：数据已算好且逐页落过盘，不当中台故障处理。
    console.error(`[chain-usage] 收尾落盘遇到状态锁，保留逐页进度：${error.message}`);
  }
  lastRefresh.set(config, { at: Date.now(), complete: ledger.complete, freshEnough: pages <= 2, signature, result });
  return result;
}

function buildResult({ rules, chains, entries, backfillPending = false }) {
  const decorate = totals => (backfillPending ? { ...totals, backfillPending: true } : totals);
  const byRule = new Map();
  for (const name of Object.keys(entries)) byRule.set(name, decorate(entryTotals(entries[name])));
  const byChain = new Map();
  for (const chain of chains || []) {
    const names = resolveChainRules(chain, rules, chains);
    if (!names.length) continue;
    byChain.set(chain.sourceFile, decorate(sumEntries(names.map(name => entries[name] || emptyEntry()))));
  }
  const byProject = new Map();
  const projectOf = new Map(rules.map(rule => [rule.name, baseName(rule?.cwd)]));
  const groups = new Map();
  for (const name of Object.keys(entries)) {
    const key = projectOf.get(name) || '未识别';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entries[name]);
  }
  for (const [key, list] of groups) byProject.set(key, decorate(sumEntries(list)));
  return { byRule, byChain, byProject };
}
