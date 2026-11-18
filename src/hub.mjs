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

export async function hubRequest(config, path, { method = 'GET', body, timeout = 5000, auth = 'owner' } = {}) {
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
