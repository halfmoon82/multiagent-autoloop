export class HubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function hubRequest(config, path, { method = 'GET', body, timeout = 5000 } = {}) {
  let response;
  try {
    response = await fetch(config.hubUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${config.ownerKey}`,
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
  if (!response.ok) throw new HubError(response.status, data?.error || `中台返回 ${response.status}`);
  return data;
}
