// 开放卡片「退回调度处理」的幂等事务。
// 顺序：先落 Hub 调度事件，Hub 接受后才结案原卡；事件失败则原卡保持开放。
// 幂等键用确定性的事件 ID（Hub 对重复事件 ID 不重复执行），进程内记录承担冷却与循环检测。
import { validateCardQuality } from './card-quality.mjs';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DELEGATE_REASON = '已退回调度处理';
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_DELEGATIONS = 3;

export class CardDelegateError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'CardDelegateError';
    this.status = status;
    this.code = code;
  }
}

export function delegateEventId(cardId, revision = 1) {
  return `console:card:${cardId}:delegate:r${revision}`;
}

export function delegateSubject(originId) {
  return `scheduling:card-delegate:${originId}`;
}

export function createCardDelegateStore({ file = null } = {}) {
  const records = new Map();
  const load = () => {
    if (!file || !existsSync(file)) return;
    try {
      for (const item of JSON.parse(readFileSync(file, 'utf8'))?.records || []) {
        if (item && typeof item.key === 'string') records.set(item.key, item);
      }
    } catch { /* 台账损坏时按空表处理，不阻断退回通道 */ }
  };
  const flush = () => {
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ records: [...records.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };
  load();
  return {
    get(key) { return records.get(key) || null; },
    set(key, value) { const record = { ...value, key }; records.set(key, record); flush(); return record; },
    listByOrigin(originId) { return [...records.values()].filter(record => record.originId === originId); },
    listPending() { return [...records.values()].filter(record => record.status === 'delegated' || record.status === 'event_accepted'); },
  };
}

const FINISHED_RUN_STATES = new Set(['done', 'nothing', 'cancelled']);

/**
 * 待代理决策收口：退回事件所在事项（subject = scheduling:card-delegate:<originId>）的调度轮次结束后，
 * 把记录标为 settled，从「待代理决策」列表移出。依据 /v1/state 的 runs[].events[].subject（runs 没有 lane 字段）。
 * 只改状态不删记录：冷却与循环检测仍按 listByOrigin 读到全部历史。
 */
export function settleDelegations(store, state, now = () => new Date()) {
  const runs = Array.isArray(state?.runs) ? state.runs : [];
  const settled = [];
  for (const record of store.listPending()) {
    const subject = delegateSubject(record.originId);
    const finished = runs.find(run => FINISHED_RUN_STATES.has(run?.state)
      && Array.isArray(run.events) && run.events.some(event => event?.subject === subject)
      && Date.parse(run.finishedAt || run.createdAt || 0) >= Date.parse(record.at || 0));
    if (!finished) continue;
    settled.push(store.set(record.key, { ...record, status: 'settled', settledAt: now().toISOString(), settledByRun: finished.id ?? null }));
  }
  return settled;
}
const defaultStore = createCardDelegateStore();

export async function delegateOpenCard({
  card, postEvent, resolveCard, store = defaultStore,
  now = () => new Date(), cooldownMs = DEFAULT_COOLDOWN_MS,
  maxDelegations = DEFAULT_MAX_DELEGATIONS,
} = {}) {
  if (!card || card.id === undefined || card.id === null) throw new CardDelegateError(400, '卡片编号缺失', 'CARD_ID_MISSING');
  if (card.state !== 'open') throw new CardDelegateError(409, '卡片不是开放状态，不能退回', 'CARD_NOT_OPEN');
  if (typeof postEvent !== 'function' || typeof resolveCard !== 'function') throw new CardDelegateError(500, '退回事务缺少事件或结案通道', 'MISSING_DEPS');

  const originId = String(card.originId ?? card.id);
  const revision = Number.isSafeInteger(card.revision) && card.revision > 0 ? card.revision : 1;
  const eventId = delegateEventId(card.id, revision);
  const existing = store.get(eventId);

  if (existing?.status === 'delegated') return { ...existing, ...(existing.result && typeof existing.result === 'object' ? existing.result : {}), ok: true, idempotent: true };
  if (existing?.status === 'event_accepted') {
    try { await resolveCard(card.id, DELEGATE_REASON); }
    catch (error) { throw new CardDelegateError(502, `调度事件已创建，但原卡结案失败：${error.message}；重试不会重复派发`, 'RESOLVE_FAILED'); }
    const record = store.set(eventId, { ...existing, status: 'delegated', closed: true });
    return { ...record, ...(existing.result && typeof existing.result === 'object' ? existing.result : {}), ok: true, idempotent: true };
  }

  if (!existing) {
    const successful = store.listByOrigin(originId).filter(record => record.status === 'delegated' || record.status === 'event_accepted');
    const nowMs = now().getTime();
    if (successful.some(record => nowMs - Date.parse(record.at) < cooldownMs)) throw new CardDelegateError(409, '卡片最近已退回，冷却期内不重复派发', 'DELEGATE_COOLDOWN');
    if (successful.length >= maxDelegations) throw new CardDelegateError(409, '同一卡片往返过多，触发循环检测', 'DELEGATE_LOOP');
  }

  const at = new Date(now().getTime()).toISOString();
  const base = { cardId: card.id, originId, revision, at, eventId };
  const event = {
    id: eventId,
    subject: delegateSubject(originId),
    type: 'scheduling.message',
    summary: `卡片退回调度：${card.title || card.id}`,
    detail: {
      kind: 'card.delegate',
      cardId: card.id,
      originId,
      revision,
      project: card.project || null,
      title: card.title || '',
      text: card.text || '',
      options: Array.isArray(card.options) ? card.options : [],
      reason: DELEGATE_REASON,
      quality: validateCardQuality(card),
      requestedAt: at,
    },
  };
  event.detail = JSON.stringify(event.detail); // 中台要求 detail 为字符串（#89 同口径）

  store.set(eventId, { ...base, status: 'pending', event });
  let result;
  try { result = await postEvent(event); }
  catch (error) {
    store.set(eventId, { ...base, status: 'failed', error: error.message });
    throw error;
  }
  store.set(eventId, { ...base, status: 'event_accepted', result });
  try { await resolveCard(card.id, DELEGATE_REASON); }
  catch (error) { throw new CardDelegateError(502, `调度事件已创建，但原卡结案失败：${error.message}；重试不会重复派发`, 'RESOLVE_FAILED'); }
  const record = store.set(eventId, { ...base, status: 'delegated', result, closed: true });
  return { ...record, ...(result && typeof result === 'object' ? result : {}), ok: true, idempotent: false };
}

// 调度重新升级：生成 revision+1 的新卡，链接原卡并携带证据与产品语言内容，避免原样重发同一卡。
export function buildEscalationCard({ source, background, reason, options, recommendation, evidence = [] } = {}) {
  if (!source || source.id === undefined || source.id === null) throw new CardDelegateError(400, '缺少原卡片', 'SOURCE_MISSING');
  const revision = (Number(source.revision) || 1) + 1;
  return {
    originId: source.originId ?? source.id,
    sourceCardId: source.id,
    revision,
    state: 'open',
    title: source.title,
    project: source.project,
    text: background,
    background,
    reason,
    options: Array.isArray(options) ? options : [],
    ...(recommendation ? { recommendation } : {}),
    evidence: Array.isArray(evidence) ? [...evidence] : [],
    createdAt: new Date().toISOString(),
  };
}
