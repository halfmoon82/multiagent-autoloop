// 设计授权的数据通道：只打 src/mobile-write.mjs 已登记的固定路由（计划只读两条 + 授权创建一条），
// 设备凭证只放请求头。fetch 与客户端由调用方注入，便于边界测试。
export function createAuthorizeClient(client, { fetchImpl } = {}) {
  if (!client || !client.origin || typeof client.tokenStore?.get !== 'function') {
    throw new TypeError('createAuthorizeClient 需要带 origin/tokenStore 的移动端客户端');
  }
  const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));
  const request = async (method, path, body) => {
    const token = await client.tokenStore.get();
    if (typeof token !== 'string' || !token) throw new Error('尚未绑定设备，请重新绑定后再操作');
    const url = new URL(path, client.origin);
    if (url.origin !== client.origin) throw new Error('目标不是当前控制台');
    let response;
    try {
      response = await doFetch(url.toString(), {
        method,
        headers: {
          accept: 'application/json', 'x-console-request': '1', 'x-device-token': token,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error('无法连接控制台，请检查网络后重试'); }
    let payload = {};
    try { payload = await response.json(); } catch { /* 非 JSON 响应用通用文案 */ }
    if (!response.ok) throw new Error(String(payload?.error || `操作失败（${response.status}），请重试`));
    return payload;
  };
  const query = (project, planId) => `project=${encodeURIComponent(String(project ?? ''))}&planId=${encodeURIComponent(String(planId ?? ''))}`;
  return {
    // 计划与预检独立成败：预检失败不阻止出示计划，但不当成通过。
    async loadPlan(project, planId) {
      const id = String(planId ?? '').trim();
      if (!String(project ?? '').trim() || !id) throw new Error('请填写计划编号');
      const [plan, pre] = await Promise.allSettled([
        request('GET', `/api/mobile/dag-plan?${query(project, id)}`),
        request('GET', `/api/mobile/dag-preflight?${query(project, id)}`),
      ]);
      if (plan.status !== 'fulfilled') throw plan.reason;
      return { plan: plan.value, preflight: pre.status === 'fulfilled' ? pre.value : null, preflightError: pre.status === 'fulfilled' ? '' : String(pre.reason?.message || '预检读取失败') };
    },
    async createRun(body) {
      if (!body) throw new Error('请先阅读并勾选确认后再提交');
      return request('POST', '/api/mobile/dag-runs', body);
    },
  };
}
