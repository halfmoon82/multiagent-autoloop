// 管理后台页骨架：分区导航（平台与模型 / 运行环境）+ 加载态/重试。
// 数据契约对齐网页版 public/admin-platform-models.mjs 与 public/app.mjs 的「首次进入才加载 + 分区显隐切换」模式；
// 具体表单渲染（保存前确认、自动备份沿用网页版语义）由内容对齐节点经 hooks.admin.loader 接入，本骨架不渲染业务字段。
// 所有文本用 textContent 渲染，不拼接 HTML，也不直接访问 Hub。
export const ADMIN_PANES = Object.freeze(['admin-pane-platform', 'admin-pane-runtime']);

/** 页面挂载点。ctx.hooks.admin 可由后续节点补 loader(paneId, host)：返回 Promise，resolve 即视为已加载。 */
export function mount(ctx) {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('page-admin');
  if (!root) return;
  const hooks = ctx.hooks;
  const loaded = new Set();
  const loading = new Set();

  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const renderState = (pane, kind, message) => {
    const box = make('div', 'admin-state', message);
    box.dataset.state = kind;
    const nodes = [box];
    if (kind !== 'loading') {
      const retry = make('button', 'admin-retry', '重试');
      retry.type = 'button';
      retry.addEventListener('click', () => { void load(pane); });
      nodes.push(retry);
    }
    document.getElementById(pane).replaceChildren(...nodes);
  };
  async function load(pane) {
    if (loading.has(pane)) return;
    const host = document.getElementById(pane);
    if (!host) return;
    const loader = hooks.admin?.loader;
    if (typeof loader !== 'function') { renderState(pane, 'pending', '管理后台内容尚未接入，请稍后重试'); return; }
    loading.add(pane);
    renderState(pane, 'loading', '加载中…');
    try {
      await loader(pane, host);
      loaded.add(pane);
    } catch (error) {
      renderState(pane, 'error', error?.message || '加载失败');
    } finally {
      loading.delete(pane);
    }
  }

  const showPane = pane => {
    for (const id of ADMIN_PANES) document.getElementById(id).hidden = id !== pane;
    for (const link of root.querySelectorAll('[data-admin-pane]')) {
      const active = link.dataset.adminPane === pane;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    if (!loaded.has(pane)) void load(pane);
  };
  for (const link of root.querySelectorAll('[data-admin-pane]')) {
    link.addEventListener('click', event => { event.preventDefault(); showPane(link.dataset.adminPane); });
  }

  const current = () => (ADMIN_PANES.find(id => !document.getElementById(id).hidden) || ADMIN_PANES[0]);
  hooks.admin = {
    ...(hooks.admin || {}),
    loaded: pane => loaded.has(pane || current()),
    showPane,
    onShow: () => { const pane = current(); if (!loaded.has(pane)) void load(pane); },
  };
}
