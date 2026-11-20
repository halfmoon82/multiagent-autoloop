// 卡片路由过滤器的生产装配（Spec §9.4/§9.6）：把 router（判定）、store（版本/审计）与 delegate（幂等退回事务）接到 notifier 轮询与控制台 API。
// 不改判定语义：只有 mode=active 且 route=scheduler 且 autoRoute=true 才调用退回；其余（shadow/unknown/human/无版本）零副作用。
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { routeCardAsync, extractFeatures, DEFAULT_RULES } from './card-router.mjs';
import { createCardFilterStore, CardFilterError } from './card-filter-store.mjs';
import { delegateOpenCard, DEFAULT_COOLDOWN_MS } from './card-delegate.mjs';
import { hubRequest } from './hub.mjs';
import { evaluate as defaultEvaluate } from '../scripts/card-filter-evaluate.mjs';

const RECENT_DECISIONS = 20;

// 幂等键：只比较规则语义，不受对象键顺序影响；与 store.createVersion 存的规则顺序一致。
function rulesSignature(rules = []) {
  return JSON.stringify((Array.isArray(rules) ? rules : []).map(rule => [
    rule?.id, rule?.route, Array.isArray(rule?.tags) ? [...rule.tags] : [], rule?.confidence,
  ]));
}

function evaluationSummary(result = {}) {
  return {
    total: Number(result.total) || 0,
    humanGateFalseAuto: Number(result.humanGateFalseAuto) || 0,
    autoRoutedWrong: Number(result.autoRoutedWrong) || 0,
    passed: result.passed === true,
  };
}

function loadSnapshot(file) {
  if (!file) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } // 缺失或损坏一律从空开始 = 全 shadow
}

function saveSnapshot(file, snapshot) {
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
  renameSync(tmp, file);
}

export function createCardRouting({
  persistFile = null, store, postEvent, resolveCard, delegateStore, model, evaluate = defaultEvaluate,
  now = () => Date.now(), retryAfterMs = DEFAULT_COOLDOWN_MS, onError = () => {},
} = {}) {
  store = store || createCardFilterStore(loadSnapshot(persistFile));
  // 决策去重：同一卡在同一版本/模式/路由下只记一条，避免每轮轮询刷审计。重启后由已存决策重建。
  const recorded = new Set(store.decisions().map(item => `${item.cardId}|${item.ruleVersion}|${item.mode}|${item.route}`));
  const rebuildRecorded = () => {
    recorded.clear();
    for (const item of store.decisions()) recorded.add(`${item.cardId}|${item.ruleVersion}|${item.mode}|${item.route}`);
  };
  // 单一写者（issue #97）：快照文件是跨进程唯一真相（CLI --publish 与本进程都会写）。
  // 每次读/写前按 mtime+size 重读，把外部进程刚落盘的版本/决策并入内存，
  // 避免本进程 persist 用旧内存快照覆盖丢版本，也修复「CLI 写 v1 后 activate 报版本不存在」。
  const snapshotStamp = () => {
    if (!persistFile) return '';
    try { const stat = statSync(persistFile); return `${stat.mtimeMs}|${stat.size}`; } catch { return ''; }
  };
  let lastStamp = snapshotStamp();
  const refresh = () => {
    if (!persistFile) return;
    const stamp = snapshotStamp();
    if (stamp === lastStamp) return;
    lastStamp = stamp;
    store.reload(loadSnapshot(persistFile));
    rebuildRecorded();
  };
  const persist = () => {
    if (!persistFile) return;
    try {
      saveSnapshot(persistFile, store.snapshot());
      lastStamp = snapshotStamp();
    } catch (error) { onError(error); }
  };
  const failedAt = new Map(); // 退回失败的退避，避免重试风暴
  let running = null;

  async function routeOne(card) {
    refresh();
    const current = store.current();
    const rules = current.version ? current.rules : DEFAULT_RULES;
    const decision = await routeCardAsync(card, { rules, ruleVersion: current.version, mode: current.mode, model });
    const key = `${card.id}|${decision.ruleVersion}|${decision.mode}|${decision.route}`;
    // 决策落盘前再重读一次，覆盖 routeCardAsync 等待期间外部进程写入的快照（issue #97）。
    refresh();
    if (!recorded.has(key)) {
      recorded.add(key);
      store.recordDecision({ cardId: card.id, route: decision.route, hardGateHits: decision.hardGateHits, ruleVersion: decision.ruleVersion, mode: decision.mode, confidence: decision.confidence, features: extractFeatures(card) });
      persist();
    }
    if (!(decision.mode === 'active' && decision.route === 'scheduler' && decision.autoRoute === true)) return { cardId: card.id, applied: false, route: decision.route };
    const last = failedAt.get(card.id);
    if (last !== undefined && now() - last < retryAfterMs) return { cardId: card.id, applied: false, route: decision.route, backoff: true };
    try {
      await delegateOpenCard({ card, postEvent, resolveCard, ...(delegateStore ? { store: delegateStore } : {}) });
      failedAt.delete(card.id);
      return { cardId: card.id, applied: true, route: decision.route };
    } catch (error) {
      failedAt.set(card.id, now());
      onError(error);
      return { cardId: card.id, applied: false, route: decision.route, error: error.message }; // 卡片保持开放
    }
  }

  const routing = {
    store,
    // 对一批 open 卡路由；返回已自动退回的卡 id。单卡失败不影响其他卡；并发调用合并，防止重叠轮询重复派发。
    async routeOpenCards(cards = []) {
      if (running) return running;
      running = (async () => {
        const delegated = [];
        for (const card of cards) {
          if (!card || card.state !== 'open' || card.id === undefined || card.id === null) continue;
          try { const result = await routeOne(card); if (result.applied) delegated.push(card.id); }
          catch (error) { onError(error); }
        }
        return delegated;
      })().finally(() => { running = null; });
      return running;
    },
    status() {
      refresh();
      const current = store.current();
      return {
        mode: current.mode,
        version: current.version,
        versions: store.versions().map(({ version, status, summary, validation, createdAt, activatedAt }) => ({ version, status, summary, validation, createdAt, activatedAt })),
        decisionCount: store.decisions().length,
        recentDecisions: store.decisions().slice(-RECENT_DECISIONS),
      };
    },
    // 生产发布入口（issue #93）：评测默认规则集 → 通过才注册版本并原子落盘，不默认 activate。
    // 幂等：同规则同评测已有通过版本时不重复注册；规则变化才新建版本并链 parentVersion。
    async publish({ samples, rules, model: overrideModel } = {}) {
      refresh();
      const evalArgs = {};
      if (samples !== undefined) evalArgs.samples = samples;
      if (rules !== undefined) evalArgs.rules = rules;
      if (overrideModel !== undefined) evalArgs.model = overrideModel;
      const result = await evaluate(evalArgs);
      const evaluation = evaluationSummary(result);
      if (!evaluation.passed) {
        return { published: false, created: false, version: null, mode: store.current().mode, evaluation };
      }
      // evaluate 期间外部进程可能写盘；注册前再重读，保证幂等判断基于最新快照、且不丢外部已落盘版本。
      refresh();
      const ruleSet = rules !== undefined ? rules : DEFAULT_RULES;
      const versions = store.versions();
      const latest = versions.length ? versions[versions.length - 1] : null;
      if (latest && latest.validation?.passed && rulesSignature(latest.rules) === rulesSignature(ruleSet)) {
        return { published: true, created: false, version: latest.version, mode: store.current().mode, evaluation };
      }
      const v = store.createVersion({
        rules: ruleSet,
        summary: `评测通过：${evaluation.total} 样本，人工门禁误自动路由 ${evaluation.humanGateFalseAuto}`,
        parentVersion: latest ? latest.version : null,
      });
      store.recordValidation(v.version, result);
      if (persistFile) {
        try { saveSnapshot(persistFile, store.snapshot()); lastStamp = snapshotStamp(); }
        catch (error) { throw new CardFilterError(`快照写入失败：${error.message}`, 'SNAPSHOT_WRITE_FAILED'); }
      }
      return { published: true, created: true, version: v.version, mode: store.current().mode, evaluation };
    },
    // 服务端强制：必须 validation.passed 且 humanGateFalseAuto=0（store.activate 内校验），不由提示词绕过。
    activate(version) {
      refresh();
      store.activate(version);
      persist();
      return routing.status();
    },
    rollback() {
      refresh();
      store.rollback();
      persist();
      return routing.status();
    },
  };
  return routing;
}

// 进程内按数据目录共享同一装配（notifier 与 server 各自拿到同一个 store）。
const registry = new Map();
export function getCardRouting(config, overrides = {}) {
  if (!config?.root) return null;
  const key = path.resolve(config.root);
  if (!registry.has(key)) {
    registry.set(key, createCardRouting({
      persistFile: path.join(key, 'card-router', 'store.json'),
      postEvent: event => hubRequest(config, '/v1/events', { method: 'POST', body: event, auth: 'source' }),
      resolveCard: (cardId, reason) => hubRequest(config, `/v1/cards/${cardId}/resolve`, { method: 'POST', body: { reason } }),
      delegateStore: config.cardDelegateStore,
      onError: error => console.error(`[card-router] ${error.message}`),
      ...overrides,
    }));
  }
  return registry.get(key);
}

export { CardFilterError };
