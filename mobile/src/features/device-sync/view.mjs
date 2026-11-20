// 设备页视图模型与同步客户端：只打 /api/mobile/sync，只展示本机设备信息（后端按令牌限定自身）。
// 纯函数部分不触碰浏览器全局；客户端的 fetch 可注入，便于边界测试。
import { normalizeSyncState } from './contract.mjs';
import { syncPrompt } from './sync.mjs';

const fmt = value => (value ? String(value) : '—');

// 把 GET /api/mobile/sync 响应整理成可直接渲染的纯文本行；上游文本只当字符串，不含 HTML。
export function buildDeviceView(payload, error = null) {
  const state = normalizeSyncState(payload?.state);
  const device = payload?.device && typeof payload.device === 'object' ? payload.device : null;
  const prompt = syncPrompt(state, error);
  return {
    kind: prompt.kind,
    revision: state.revision,
    syncText: prompt.text,
    decisionCount: Object.keys(state.decisions).length,
    rows: device
      ? [
        ['设备名称', fmt(device.name)],
        ['系统', fmt(device.platform)],
        ['状态', device.status === 'authorized' ? '已授权' : '已解除'],
        ['绑定时间', fmt(device.boundAt)],
        ['最近活跃', fmt(device.lastActiveAt)],
        ['同步版本', String(state.revision)],
        ['最近同步', fmt(state.updatedAt)],
      ]
      : [],
  };
}

export function createDeviceSyncClient(client, { fetchImpl } = {}) {
  if (!client || !client.origin || typeof client.tokenStore?.get !== 'function') {
    throw new TypeError('createDeviceSyncClient 需要带 origin/tokenStore 的移动端客户端');
  }
  const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));
  return {
    async fetchSync() {
      const token = await client.tokenStore.get();
      if (typeof token !== 'string' || !token) throw new Error('尚未绑定设备，请重新绑定后再查看');
      let response;
      try {
        response = await doFetch(new URL('/api/mobile/sync', client.origin).toString(), {
          headers: { 'x-console-request': '1', 'x-device-token': token },
        });
      } catch { throw new Error('无法连接控制台，请稍后重试'); }
      let payload = {};
      try { payload = await response.json(); } catch { /* 非 JSON 用通用文案 */ }
      if (!response.ok) throw new Error(String(payload?.error || `同步失败（${response.status}），请重试`));
      return payload;
    },
  };
}
