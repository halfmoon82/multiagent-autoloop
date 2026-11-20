// 设备页面接缝：展示本机绑定信息与同步状态（只读，仅本机设备；解除他人设备不在移动端开放）。
// 所有文本用 textContent 渲染；同步失败保留上次已显示内容并给出可读提示。
const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/device-sync/index.mjs');

export { loadViewModel };

/** 页面挂载点。ctx 含 client / state / hooks。 */
export function mount(ctx) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('page-devices');
  if (!host) return;
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const banner = make('div', 'devices-banner');
  const list = make('div', 'devices-info');
  const refresh = make('button', 'devices-refresh', '刷新同步状态');
  refresh.type = 'button';
  host.replaceChildren(make('h2', 'devices-title', '本机设备与同步'), banner, list, refresh);

  let model = null;
  let syncClient = null;
  let last = null;
  const render = error => {
    const view = model.buildDeviceView(last, error);
    banner.textContent = view.syncText;
    banner.dataset.kind = view.kind;
    list.replaceChildren(...view.rows.map(([label, value]) => {
      const row = make('div', 'devices-row');
      row.append(make('span', 'devices-label', label), make('span', 'devices-value', value));
      return row;
    }));
  };
  async function load() {
    try {
      model = model || await loadViewModel();
      if (!model) return;
      syncClient = syncClient || model.createDeviceSyncClient(ctx.client);
      last = await syncClient.fetchSync();
      render(null);
    } catch (error) {
      if (model) render(error); // 保留上次一致状态并提示
      else banner.textContent = String(error?.message || '同步暂不可用');
    }
  }
  refresh.addEventListener('click', () => { void load(); });
  void load();
}
