function redactSecret(value, ...secrets) {
  const list = secrets.flat().filter(Boolean);
  if (!list.length) return value;
  return list.reduce((acc, secret) => redactOne(acc, secret), value);
}

function redactOne(value, secret) {
  if (typeof value === 'string') return value.replaceAll(secret, '[已隐藏]');
  if (Array.isArray(value)) return value.map(item => redactOne(item, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactOne(item, secret)]));
  return value;
}

export class HubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// 中台状态共享缓存（2026-11-20 中台卡顿根因：中台单线程同步读库，内存紧张时每次 /v1/state 都要
// 逐页从磁盘读，整个中台随之停摆；控制台通知、台账、DAG、会话、接口各自轮询，重复加重负载）。
// 只缓存 owner 身份的整页 GET /v1/state（不含 ?before= 翻页）：
//   - 有效期内与并发请求共享同一次中台请求（single-flight），每个调用方拿独立副本；
//   - 控制台对中台的任何写请求都会让缓存代际失效，写之前发起的在途读不会在写之后被复用；
//   - 失败不缓存；HUB_STATE_CACHE_MS 或调用方 cacheMs=0 关闭。
//   - 按轮次精确计费的台账（chain-usage）传 cacheMs=0：翻页一致性优先，且它自身 30s 才刷新一次。
const DEFAULT_STATE_CACHE_MS = 1000;
const stateCache = new Map();   // `${hubUrl}\0${ownerKey}` → { generation, at, promise }
const generations = new Map();  // hubUrl → 写代际
const generationOf = hubUrl => generations.get(hubUrl) || 0;
export function resetHubStateCache() { stateCache.clear(); generations.clear(); }

function stateCacheMs(override) {
  if (Number.isFinite(override) && override >= 0) return override;
  const env = Number(process.env.HUB_STATE_CACHE_MS);
  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_STATE_CACHE_MS;
}

async function cachedState(config, options) {
  const ttl = stateCacheMs(options.cacheMs);
  if (!ttl) return rawHubRequest(config, '/v1/state', options);
  const cacheKey = `${config.hubUrl}\0${config.ownerKey}`;
  const generation = generationOf(config.hubUrl);
  const hit = stateCache.get(cacheKey);
  if (hit && hit.generation === generation && Date.now() - hit.at < ttl) return structuredClone(await hit.promise);
  const entry = { generation, at: Date.now(), promise: rawHubRequest(config, '/v1/state', options) };
  stateCache.set(cacheKey, entry);
  try { return structuredClone(await entry.promise); }
  catch (error) { if (stateCache.get(cacheKey) === entry) stateCache.delete(cacheKey); throw error; }
}

export async function hubRequest(config, path, options = {}) {
  const { method = 'GET', auth = 'owner' } = options;
  if (method === 'GET' && auth === 'owner' && path === '/v1/state') return cachedState(config, options);
  if (method !== 'GET') {
    // 写之前与写之后各推进一次代际：写进行中发起的读、写之前的在途读都不会在写之后被复用。
    generations.set(config.hubUrl, generationOf(config.hubUrl) + 1);
    try { return await rawHubRequest(config, path, options); }
    finally { generations.set(config.hubUrl, generationOf(config.hubUrl) + 1); }
  }
  return rawHubRequest(config, path, options);
}

async function rawHubRequest(config, path, { method = 'GET', body, timeout = 5000, auth = 'owner' } = {}) {
  const key = auth === 'source' ? config.sourceKey : config.ownerKey;
  if (auth === 'source' && !key) {
    throw new HubError(503, '缺少事件来源密钥：state/config.json 的 source.key 未配置或无效，调度事件未发送');
  }
  let response;
  try {
    response = await fetch(config.hubUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new HubError(502, `连不上 Autoloop 中台：${error.message}`);
  }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { throw new HubError(502, 'Autoloop 中台返回了无法读取的响应'); }
  const safeData = redactSecret(data, config.ownerKey, config.sourceKey);
  if (!response.ok) throw new HubError(response.status, safeData?.error || `中台返回 ${response.status}`);
  return safeData;
}

// §6.2 调度会话 Hub 原生接线：事件写入与事件结果读取。
// 首轮与后续消息走同一 POST /v1/events；event.id 由调用方按 sessionUUID + 单调轮次生成，
// 重复 id 由 Hub 幂等去重。凭据只经 config 在服务端使用，绝不进入浏览器。
export async function postSchedulingEvent(config, event) {
  return hubRequest(config, '/v1/events', { method: 'POST', body: event, auth: 'source' });
}

// 通过事件查询获得 run/状态；控制台不另登记一套执行状态。
export async function readSchedulingEvent(config, eventId) {
  return hubRequest(config, `/v1/events/${encodeURIComponent(eventId)}`, { auth: 'source' });
}
