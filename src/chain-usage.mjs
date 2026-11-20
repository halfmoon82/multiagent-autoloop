// 真·整条链累计（Token 与计费）：Hub 的 lines.totals.usage 只是当日窗口（tally 按
// dayStart 过滤），直接当"累计"会把今日误标为全程。本模块翻页读取 /v1/state 的 runs
// 历史（?before=<id> 向前翻，runs 只增不删），把每条规则已完成轮次自报的 usage 累加进
// <root>/chain-usage.json 台账。关键纪律：
//   - 只计已开始且已终态的轮次（有 finishedAt，且 claimedAt 或 usage 存在），与中台
//     §6.2 spending 判据一致；从未开跑就取消的轮次不计轮数，同时清出 pending/unsettled。
//   - 费用缺失记 missingCostRounds，cost 保持 null，不用零冒充上报。
//   - counted 去重：重复读取、翻页重叠、并发路由共享扫描都不会重复计费。
//   - 回填游标单调：resumeCursor 只往更深（更小 id）推进，逐页落盘。阶段一被预算截断
//     或在前沿停止时，阶段二从"最深未扫描点"续翻，绝不因为前沿页都已见就跳过尾部历史。
//   - 未翻到底的结果带 backfillPending，链与项目两处界面都如实标注"历史补全中"，
//     不把部分覆盖冒充全量；稳态（已到底 + 前沿停止）不写游标、不闪标注。
//   - 观察到的未完成轮次先阻塞前沿直至其完成；超过 24h 转入不阻塞的 unsettled（中台
//     把 queued/claimed/unknown 并入首页，其完成后照样补计）；unsettled 有上限，超出
//     只累计 unresolvedRounds 计数，不静默丢账。
//   - 扫描调度与结果缓存分离：nextScanAt 只由真实扫描推进，本地重建结果绝不续期，
//     否则双路由签名乒乓会把台账永久冻结在首扫那一刻。
//   - 中台故障在本模块内折成 null（调用方回退规则行今日窗口），不把面板打成 502；
//     故障进入退避，退避期内零中台请求，但仍按已落盘台账重建当前签名下的结果。
// 控制台不折算、不按模型名估算费用。
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { hubRequest } from './hub.mjs';
import { chainRuleNames } from './serial-progress.mjs';
import { withStateLockAsync, DetourError } from './detour.mjs';
import { readRuleOptions } from './rules.mjs';
import { NO_MODEL_ADAPTERS } from './dag-service.mjs';

export const LEDGER_FILE = 'chain-usage.json';
const LEDGER_VERSION = 2;
const LEGACY_VERSIONS = new Set([1]);
const REFRESH_TTL_MS = 30000;
const BACKFILL_STEP_MS = 5000;   // 未到底时两次深翻之间的最小间隔
const MAX_PAGES_PER_REFRESH = 100;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const UNSETTLED_MAX = 500;
// 陈旧未完成轮次的定向核实：它们完成后可能已掉出首页窗口（中台只把 active 轮次并入
// 首页），不主动去捞就永久漏计。按 ?before=<id+1> 精确捞回该轮次补计，每轮限额，
// 捞不完的留在册里下轮继续（不丢账）。
const UNSETTLED_PROBE_MAX = 20;
const FAILURE_BACKOFF_MS = 60000;
const NODE_SUBJECTS_MAX = 100;   // 每条规则最多记多少个 subject 的最近一轮（单链节点数远小于此）

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
// allowZero=true 用于 TTL/退避这类"0 表示不缓存"的语义；页数、上限类必须为正整数。
const numEnv = (name, fallback, { allowZero = false } = {}) => {
  const raw = Number(process.env[name]);
  if (process.env[name] === undefined || !Number.isFinite(raw)) return fallback;
  if (allowZero ? raw >= 0 : Number.isSafeInteger(raw) && raw > 0) return raw;
  return fallback;
};

const emptyEntry = () => ({ counted: [], pending: [], unsettled: [], unresolved: 0, input: 0, output: 0, cost: 0, costReported: false, rounds: 0, missingCostRounds: 0, missingByAgent: {} });

export function ledgerPath(root) { return path.join(root, LEDGER_FILE); }

const idList = value => (Array.isArray(value) ? value.filter(isNum) : []);
function pendingList(value, fallbackSince) {
  if (!Array.isArray(value)) return [];
  const nowIso = new Date().toISOString();
  return value
    .map(item => {
      if (isNum(item)) return { id: item, since: fallbackSince || nowIso };
      if (isNum(item?.id)) return { id: item.id, since: typeof item.since === 'string' && parseTime(item.since) !== null ? item.since : fallbackSince || nowIso };
      return null;
    })
    .filter(Boolean);
}

function validEntry(value) {
  return value && typeof value === 'object'
    && Array.isArray(value.counted) && value.counted.every(isNum);
}

function validNodes(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [rule, byNode] of Object.entries(value)) {
    if (!byNode || typeof byNode !== 'object') continue;
    for (const [nodeId, round] of Object.entries(byNode)) {
      if (!isNum(round?.id)) continue;
      (out[rule] ||= {})[nodeId] = { id: round.id, agent: cleaned(round.agent), state: cleaned(round.state), usage: round.usage && typeof round.usage === 'object' && !Array.isArray(round.usage) ? round.usage : null };
    }
  }
  return out;
}

export function readLedger(root) {
  // nodes：{ [规则]: { [节点 id]: { id, agent, state, usage } } }——串行节点自己的最近一轮（触发事件 subject = 节点 id）。
  // nodesTracked：台账从建账起就在记节点；老台账（建账时还没这个字段）需要额外补翻一遍历史，nodesCursor 是补翻断点。
  const blank = { version: LEDGER_VERSION, seen: [], rules: {}, complete: false, backfillCursor: null, updatedAt: null, nodes: {}, nodesTracked: true, nodesCursor: null };
  if (!root) return blank;
  let data;
  try { data = JSON.parse(readFileSync(ledgerPath(root), 'utf8')); }
  catch { return blank; }
  if (!data || typeof data !== 'object') return blank;
  if (data.version !== LEDGER_VERSION && !LEGACY_VERSIONS.has(data.version)) return blank;
  const updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
  const seen = new Set(idList(data.seen));
  const rules = {};
  let droppedEntry = false;
  for (const [name, entry] of Object.entries(data.rules || {})) {
    if (!validEntry(entry)) {
      // 整条判废：其 id 尽量出 seen，并强制把台账降级为"未到底"。
      // 只剔 id 不降级是不够的：坏数据里剔不动的深 id 依旧会被前沿判定当成已覆盖，
      // 结果静默漏计还宣称已到底。降级后会走历史回填，缺口自己补回来。
      droppedEntry = true;
      for (const id of idList(entry?.counted)) seen.delete(id);
      for (const item of (Array.isArray(entry?.pending) ? entry.pending : [])) seen.delete(isNum(item) ? item : Number(item?.id));
      continue;
    }
    // 旧台账只记了缺费用总数，没记是哪个执行者：无法剔除不需要模型的轮次，整本作废重翻一遍历史
    // （费用、Token 由 Hub 历史重新累加，结果不变；翻完前界面如实标「历史补全中」）。
    if ((entry.missingCostRounds || 0) > 0 && (!entry.missingByAgent || typeof entry.missingByAgent !== 'object')) return blank;
    rules[cleaned(name)] = {
      ...emptyEntry(),
      ...entry,
      counted: idList(entry.counted),
      pending: pendingList(entry.pending, updatedAt),
      unsettled: idList(entry.unsettled),
      unresolved: isNum(entry.unresolved) ? entry.unresolved : 0,
      missingByAgent: entry.missingByAgent && typeof entry.missingByAgent === 'object' ? entry.missingByAgent : {},
    };
  }
  return {
    ...blank,
    seen: [...seen].sort((a, b) => a - b),
    rules,
    complete: droppedEntry ? false : (data.version === LEDGER_VERSION ? data.complete === true : false),
    backfillCursor: isNum(data.backfillCursor) ? data.backfillCursor : null,
    updatedAt,
    nodes: validNodes(data.nodes),
    nodesTracked: data.nodesTracked === true,
    nodesCursor: isNum(data.nodesCursor) ? data.nodesCursor : null,
  };
}

function persistLedger(root, ledger) {
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
export function resolveChainRules(chain, rules, allChains) {
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

const chainNodeIds = chain => new Set([...(chain?.order || []), ...(chain?.nodes || []).map(node => node?.id)].map(cleaned).filter(Boolean));

// 缺费用轮次只算「跑模型却没读到费用」的：不需要模型的通道（command 等）本来就没有费用可报。
// 台账按执行者记 missingByAgent，展示时再按当前规则里的通道类型排除，规则改了也不用重翻历史。
const missingOf = (acc, noModelAgents) => {
  const byAgent = acc.missingByAgent || {};
  let skipped = 0;
  for (const [agent, count] of Object.entries(byAgent)) if (noModelAgents.has(agent)) skipped += count;
  return Math.max(acc.missingCostRounds - skipped, 0);
};

const totalsOf = (acc, backfillPending, noModelAgents = new Set()) => {
  const totals = {
    input: acc.input,
    output: acc.output,
    tokens: acc.input + acc.output,
    cost: acc.costReported ? acc.cost : null,
    rounds: acc.rounds,
    missingCostRounds: missingOf(acc, noModelAgents),
    unresolvedRounds: acc.unresolved,
  };
  return backfillPending ? { ...totals, backfillPending: true } : totals;
};

const sumEntries = (entries, backfillPending, noModelAgents) => {
  const acc = emptyEntry();
  for (const entry of entries) {
    acc.input += entry.input; acc.output += entry.output; acc.cost += entry.cost;
    acc.costReported = acc.costReported || entry.costReported;
    acc.rounds += entry.rounds;
    acc.missingCostRounds += missingOf(entry, noModelAgents || new Set());
    acc.unresolved += entry.unresolved || 0;
  }
  return totalsOf(acc, backfillPending);
};

const resultCache = new WeakMap();  // config → { signature, result }
const nextScanAt = new WeakMap();   // config → 下一次允许真实扫描的时刻（只由真实扫描推进）
const inFlight = new WeakMap();     // config → { promise, signature }

function buildResult({ rules, chains, entries, backfillPending, nodes = {}, noModelAgents = new Set() }) {
  const byRule = new Map();
  for (const name of Object.keys(entries)) byRule.set(name, totalsOf(entries[name], backfillPending, noModelAgents));
  const byChain = new Map();
  for (const chain of chains || []) {
    const names = resolveChainRules(chain, rules, chains);
    if (!names.length) continue;
    byChain.set(chain.sourceFile, sumEntries(names.map(name => entries[name] || emptyEntry()), backfillPending, noModelAgents));
  }
  // 每条链的节点最近一轮：链的各规则里同一节点取轮次号最大的那轮。
  const nodesByChain = new Map();
  for (const chain of chains || []) {
    const ids = chainNodeIds(chain);
    const out = {};
    for (const name of resolveChainRules(chain, rules, chains)) {
      for (const [nodeId, round] of Object.entries(nodes[name] || {})) {
        if (ids.has(nodeId) && (!out[nodeId] || out[nodeId].id < round.id)) out[nodeId] = { ...round };
      }
    }
    nodesByChain.set(chain.sourceFile, out);
  }
  const byProject = new Map();
  const projectOf = new Map(rules.map(rule => [rule.name, baseName(rule?.cwd)]));
  const groups = new Map();
  for (const name of Object.keys(entries)) {
    const key = projectOf.get(name) || '未识别';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entries[name]);
  }
  for (const [key, list] of groups) byProject.set(key, sumEntries(list, backfillPending, noModelAgents));
  return { byRule, byChain, byProject, nodesByChain };
}

// 当前规则里不跑模型的执行者（按通道类型）；规则读不到时按空集处理，宁可多标「未上报」也不吞掉缺口。
function noModelAgentsOf(config) {
  try { return new Set(readRuleOptions(config).agents.filter(agent => NO_MODEL_ADAPTERS.has(agent.adapter)).map(agent => agent.id)); }
  catch { return new Set(); }
}

// 本地按台账重建当前签名下的结果：不打中台，也不推进扫描调度。
function rebuildFromLedger({ config, rules, chains, signature }) {
  const ledger = readLedger(config.root);
  const result = buildResult({ rules, chains, entries: ledger.rules, backfillPending: !ledger.complete, nodes: ledger.nodes, noModelAgents: noModelAgentsOf(config) });
  resultCache.set(config, { signature, result });
  return result;
}

export function refreshUsage({ config, rules = [], chains = [], ttlMs = numEnv('CHAIN_USAGE_TTL_MS', REFRESH_TTL_MS, { allowZero: true }), backoffMs = numEnv('CHAIN_USAGE_BACKOFF_MS', FAILURE_BACKOFF_MS, { allowZero: true }) } = {}) {
  if (!config?.root) return Promise.resolve(null);
  const signature = [
    ...(chains || []).map(chain => chain?.sourceFile),
    ...(rules || []).map(rule => `${rule?.name}@${rule?.cwd}`),
  ].join(',');
  const shared = inFlight.get(config);
  if (shared) {
    if (shared.signature === signature) return shared.promise;
    // 共享在途扫描的结果按发起方签名构建：本次签名不同就本地重建，
    // 不能被 project-usage 的空链结果吃掉，也不能反向覆盖调度。
    return shared.promise.then(result => (result === null ? null : rebuildFromLedger({ config, rules, chains, signature })));
  }
  if (Date.now() < (nextScanAt.get(config) || 0)) {
    const cached = resultCache.get(config);
    return Promise.resolve(cached && cached.signature === signature ? cached.result : rebuildFromLedger({ config, rules, chains, signature }));
  }
  const entry = {};
  const promise = scanOnce({ config, rules, chains, signature, ttlMs }).catch(error => {
    // 中台/落盘故障在本模块内折叠：路由照常 200 并回退今日窗口，不把面板打成 502。
    console.error(`[chain-usage] 台账刷新失败，${Math.round(backoffMs / 1000)}s 内不再扫描中台：${error.message}`);
    nextScanAt.set(config, Date.now() + backoffMs);
    return rebuildFromLedger({ config, rules, chains, signature });
  }).finally(() => { if (inFlight.get(config) === entry) inFlight.delete(config); });
  entry.promise = promise;
  entry.signature = signature;
  inFlight.set(config, entry);
  return promise;
}

async function scanOnce({ config, rules, chains, signature, ttlMs }) {
  const ledger = readLedger(config.root);
  const now = Date.now();
  let pruned = false;
  const unsettledMax = numEnv('CHAIN_USAGE_UNSETTLED_MAX', UNSETTLED_MAX);
  for (const entry of Object.values(ledger.rules)) {
    // 超时未完成轮次不再阻塞前沿：转入不阻塞的 unsettled；溢出只累计计数，不静默丢账。
    const fresh = [];
    for (const item of entry.pending) {
      const at = parseTime(item.since);
      if (at === null || now - at < PENDING_TTL_MS) fresh.push(item);
      else if (entry.unsettled.includes(item.id)) { /* 已在册 */ }
      else if (entry.unsettled.length < unsettledMax) entry.unsettled.push(item.id);
      else entry.unresolved += 1;
    }
    if (fresh.length !== entry.pending.length) { pruned = true; entry.pending = fresh; }
    else entry.pending = fresh;
  }
  const known = new Set(rules.map(rule => cleaned(rule?.name)).filter(Boolean));
  // 已知规则的轮次按触发事件 subject 逐个记"最近一轮"；展示时再按链规则与节点 id 过滤（buildResult），
  // 这样不依赖扫描时链是否已加载（项目用量路由不带链）、链文件晚于轮次出现或节点后加，都不用重翻历史。
  // 每条规则只留轮次号最大的 NODE_SUBJECTS_MAX 个 subject，台账体积有上限。
  const noteNode = (name, id, run) => {
    for (const event of run.events || []) {
      const nodeId = cleaned(event?.subject);
      if (!nodeId) continue;
      const byNode = ledger.nodes[name] || (ledger.nodes[name] = {});
      const prev = byNode[nodeId];
      if (prev && prev.id > id) continue;
      const next = { id, agent: cleaned(run.agent), state: cleaned(run.state), usage: run.usage && typeof run.usage === 'object' && !Array.isArray(run.usage) ? run.usage : null };
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) continue;
      byNode[nodeId] = next;   // 同一轮次再次出现（跑完、被定向核实）时刷新状态与自报用量
      const keys = Object.keys(byNode);
      if (keys.length > NODE_SUBJECTS_MAX) {
        keys.sort((a, b) => byNode[a].id - byNode[b].id);
        for (const key of keys.slice(0, keys.length - NODE_SUBJECTS_MAX)) delete byNode[key];
      }
      dirty = true; wroteSinceChange = false;
    }
  };
  const seen = new Set(ledger.seen);
  const entries = ledger.rules;
  let dirty = false;   // 本轮是否有需要落盘的变化（入账、在册增删、断点推进）
  let wroteSinceChange = false;
  const views = new Map();
  const viewFor = name => {
    let view = views.get(name);
    if (!view) {
      const entry = entries[name] || (entries[name] = emptyEntry());
      view = {
        entry,
        counted: new Set(entry.counted),
        pending: new Set(entry.pending.map(item => item.id)),
        unsettled: new Set(entry.unsettled),
      };
      views.set(name, view);
    }
    return view;
  };
  const settle = (view, id) => {
    let cleared = false;
    if (view.pending.has(id)) { view.entry.pending = view.entry.pending.filter(item => item.id !== id); view.pending.delete(id); cleared = true; }
    if (view.unsettled.has(id)) { view.entry.unsettled = view.entry.unsettled.filter(item => item !== id); view.unsettled.delete(id); cleared = true; }
    // 清账本身就是需要落盘的状态变化：不标脏的话同一轮次每轮重复清账、
    // 24h 后被 sweep 挤进在册名额并永久占位。
    if (cleared) { dirty = true; wroteSinceChange = false; }
  };

  const noteMissing = (entry, run) => {
    entry.missingCostRounds += 1;
    const agent = cleaned(run.agent);
    if (agent) { entry.missingByAgent ||= {}; entry.missingByAgent[agent] = (entry.missingByAgent[agent] || 0) + 1; }
  };
  const fetchState = before => hubRequest(config, '/v1/state' + (before == null ? '' : `?before=${before}`), { cacheMs: 0 });
  const nextCursor = state => (Number.isSafeInteger(state?.nextBefore) && state.nextBefore > 0 ? state.nextBefore : null);
  const alreadyComplete = ledger.complete === true;
  // resumeCursor：最深（最小 id）的未扫描点，单调变深，绝不被浅处的游标覆盖。
  let resumeCursor = isNum(ledger.backfillCursor) ? ledger.backfillCursor : null;
  const remember = next => {
    if (!isNum(next)) return;
    const advanced = !isNum(resumeCursor) || next < resumeCursor;
    resumeCursor = isNum(resumeCursor) ? Math.min(resumeCursor, next) : next;
    if (advanced) { dirty = true; wroteSinceChange = false; }   // 断点推进本身也要落盘
  };
  const flush = () => {
    if (!dirty || wroteSinceChange) return;   // 稳态零写入：没有新入账就不重抄整本台账
    ledger.seen = [...seen].sort((a, b) => a - b);
    ledger.complete = false;
    ledger.backfillCursor = resumeCursor;
    persistLedger(config.root, ledger);
    wroteSinceChange = true;
  };

  const processPage = state => {
    const unique = new Map();
    for (const run of state?.runs || []) {
      const id = Number(run?.id);
      if (isNum(id) && !unique.has(id)) unique.set(id, run);
    }
    let pageMin = Infinity;
    let unseenFinished = false;
    for (const run of unique.values()) {
      const id = Number(run.id);
      pageMin = Math.min(pageMin, id);
      if (!seen.has(id)) {
        seen.add(id);
        dirty = true; wroteSinceChange = false;
        if (run.finishedAt) unseenFinished = true;
      }
      const name = cleaned(run.rule);
      if (!known.has(name)) continue;
      noteNode(name, id, run);
      const view = viewFor(name);
      if (view.counted.has(id)) continue;
      if (!run.finishedAt) {
        if (!view.pending.has(id) && !view.unsettled.has(id)) {
          view.entry.pending.push({ id, since: new Date().toISOString() });
          view.pending.add(id);
          dirty = true; wroteSinceChange = false;
        }
        continue;
      }
      if (!run.claimedAt && !(run.usage && typeof run.usage === 'object')) {
        // 从未开跑就取消：不计轮次，但要把账清干净，别让它长期占着 pending/unsettled。
        settle(view, id);
        continue;
      }
      settle(view, id);
      view.counted.add(id);
      view.entry.counted.push(id);
      view.entry.rounds += 1;
      dirty = true; wroteSinceChange = false;
      const usage = run.usage && typeof run.usage === 'object' ? run.usage : null;
      if (usage) {
        if (isNum(usage.input)) view.entry.input += usage.input;
        if (isNum(usage.output)) view.entry.output += usage.output;
        if (isNum(usage.cost)) { view.entry.cost += usage.cost; view.entry.costReported = true; }
        else noteMissing(view.entry, run);
      } else {
        noteMissing(view.entry, run);
      }
    }
    return { unseenFinished, pageMin };
  };

  // 预算至少要给历史回填与探针留一页，否则配置成 1 时阶段一吃掉唯一一页、永不到底。
  const maxPages = Math.max(numEnv('CHAIN_USAGE_MAX_PAGES', MAX_PAGES_PER_REFRESH), 2);
  if (pruned) dirty = true;
  let pages = 0;
  let reachedBottom = false;
  let frontierStopped = false;

  // 阶段一：从最新往旧的增量前沿扫描。
  let before = null;
  while (pages < maxPages) {
    const state = await fetchState(before);
    const { unseenFinished } = processPage(state);
    pages += 1;
    const next = nextCursor(state);
    if (next == null) { reachedBottom = true; break; }
    remember(next);
    before = next;
    flush();
    if (!unseenFinished) { frontierStopped = true; break; }
  }

  // 阶段 1.5：在册未完成轮次定向核实（见 UNSETTLED_PROBE_MAX 注释）。
  const probes = [];
  for (const view of views.values()) {
    for (const id of view.entry.unsettled) if (!view.counted.has(id)) probes.push(id);
    for (const item of view.entry.pending) if (!view.counted.has(item.id)) probes.push(item.id);
  }
  probes.sort((a, b) => a - b);   // 升序：先核实最深（最容易掉出首页窗口）的在册轮次
  const probeMax = numEnv('CHAIN_USAGE_PROBE_MAX', UNSETTLED_PROBE_MAX);
  for (const id of probes.slice(0, probeMax)) {
    if (pages >= maxPages) break;   // 预算用满：该 id 留在 unsettled，下轮继续，不丢账
    const state = await fetchState(id + 1);
    processPage(state);
    pages += 1;
    flush();
  }

  // 阶段二：历史回填。台账从未到底过，就必须从最深未扫描点继续往下翻；
  // 预算用满则把游标留在盘上，下一轮接着翻（这里不会跳过中间区段：
  // 游标只指向"没见过"的那一侧，浅处都已进 seen）。
  if (!reachedBottom && !alreadyComplete && isNum(resumeCursor)) {
    let cursor = resumeCursor;
    while (pages < maxPages && isNum(cursor)) {
      const state = await fetchState(cursor);
      processPage(state);
      pages += 1;
      const next = nextCursor(state);
      if (next == null) { reachedBottom = true; break; }
      remember(next);
      cursor = next;
      flush();
    }
  }

  // 阶段三：老台账补记节点轮次。建账时还没记节点的台账，费用早已到底，节点记录却是空的——
  // 额外从首页往旧补翻一遍（counted 去重，费用不会重复入账），断点 nodesCursor 逐页落盘，翻到底后转为 nodesTracked。
  if (!ledger.nodesTracked && known.size) {
    let cursor = ledger.nodesCursor;
    while (pages < maxPages) {
      const state = await fetchState(cursor);
      processPage(state);
      pages += 1;
      const next = nextCursor(state);
      dirty = true; wroteSinceChange = false;
      if (next == null) { ledger.nodesTracked = true; ledger.nodesCursor = null; break; }
      cursor = next;
      ledger.nodesCursor = next;
      flush();
    }
  }

  const stateChanged = ledger.complete !== (reachedBottom || (alreadyComplete && frontierStopped))
    || (isNum(ledger.backfillCursor) ? ledger.backfillCursor : null) !== (reachedBottom || (alreadyComplete && frontierStopped) ? null : resumeCursor);
  ledger.seen = [...seen].sort((a, b) => a - b);
  // 稳态（已到底 + 前沿正常停止）保持到底；只有真的到底或本来就是到底态才不降级。
  ledger.complete = reachedBottom || (alreadyComplete && frontierStopped);
  ledger.backfillCursor = ledger.complete ? null : resumeCursor;
  const result = buildResult({ rules, chains, entries, backfillPending: !ledger.complete, nodes: ledger.nodes, noModelAgents: noModelAgentsOf(config) });
  if (dirty || stateChanged) try {
    await withStateLockAsync(config, async () => { persistLedger(config.root, ledger); });
  } catch (error) {
    if (!(error instanceof DetourError)) throw error;
    console.error(`[chain-usage] 收尾落盘遇到状态锁，保留逐页进度：${error.message}`);
  }
  const settled = ledger.complete && (ledger.nodesTracked || !known.size);   // 节点补翻没完也按回填节奏续翻
  nextScanAt.set(config, Date.now() + (settled ? ttlMs : Math.min(ttlMs, BACKFILL_STEP_MS)));
  resultCache.set(config, { signature, result });
  return result;
}
