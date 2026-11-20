// 移动端核心页面写操作：只打 src/mobile-write.mjs 已登记的固定写路由。
// 纯逻辑、不碰 DOM；fetch 由调用方注入（浏览器默认 globalThis.fetch）。
// 设备凭证只放在 x-device-token 头里，不进 URL、页面、日志或错误文案。

const RULE_ACTIONS = Object.freeze(['run', 'pause', 'resume']);

export function createCoreWrite(client, { fetchImpl } = {}) {
  if (!client || typeof client.api !== 'function' || !client.tokenStore) {
    throw new TypeError('createCoreWrite 需要带 api/tokenStore 的移动端客户端');
  }
  const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));
  const call = async (path, body) => {
    const token = await client.tokenStore.get();
    if (typeof token !== 'string' || !token) throw new Error('尚未绑定设备，请重新绑定后再操作');
    const url = new URL(path, client.origin);
    if (url.origin !== client.origin) throw new Error('写操作目标不是当前控制台');
    let response;
    try {
      response = await doFetch(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-console-request': '1',
          'x-device-token': token,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('无法连接控制台，操作未提交，请重试');
    }
    let payload = {};
    try { payload = await response.json(); } catch { /* 非 JSON 响应用通用错误文案 */ }
    if (!response.ok) {
      const error = new Error(String(payload?.error || `操作失败（${response.status}），请重试`));
      error.status = response.status;
      error.route = payload?.route ?? null;
      throw error;
    }
    return payload;
  };

  return {
    answerCard(id, { choice, text } = {}) {
      const cardId = encodeURIComponent(String(id));
      const payload = choice !== undefined ? { choice: Number(choice) } : { text: String(text ?? '') };
      return call(`/api/mobile/cards/${cardId}/answer`, payload);
    },
    async ruleAction(name, action) {
      if (!RULE_ACTIONS.includes(action)) throw new Error(`不支持的动作：${String(action)}`);
      return call(`/api/mobile/rules/${encodeURIComponent(String(name))}/${action}`, {});
    },
  };
}
