// 全局一级项目筛选：挂在 scaffold 预留的头部挂载点 #project-filter-root。
// 视图模型经相对路径 ../src/features/project-filter/browser.mjs 动态加载（受限静态服务 /mobile/src/）；
// Node 边界测试不装配 DOM，所以不在模块顶层静态导入 ../src/...。
// 切换后覆盖 ctx.hooks.projectFilter，并经 ctx.state + autoloop:project-filter 事件广播，
// 所有订阅页面据此重渲染并用同一选中值过滤；筛选不改写会话自身上下文。
const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/project-filter/browser.mjs');

export { loadViewModel };

const node = (tag, { className, text, attrs = {} } = {}, children = []) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  for (const child of children) if (child) element.appendChild(child);
  return element;
};

/** 页面挂载点。ctx 含 client / state / hooks；跨页互调一律走 ctx.hooks。 */
export function mount(ctx) {
  if (typeof document === 'undefined') return;
  const modelPromise = loadViewModel();
  if (!modelPromise) return;
  const root = document.getElementById('project-filter-root');
  if (!root) return;

  const label = node('label', { className: 'pf-label', text: '项目', attrs: { for: 'project-filter' } });
  const select = node('select', { className: 'pf-select', attrs: { id: 'project-filter', 'aria-label': '全局项目筛选' } });
  const clear = node('button', {
    className: 'pf-clear', text: '全部', attrs: { id: 'clear-project-filter', type: 'button', hidden: '' },
  });
  const status = node('span', { className: 'pf-status', attrs: { 'aria-live': 'polite' } });
  const bar = node('div', { className: 'project-filter-bar' }, [label, select, clear]);
  root.replaceChildren(bar, status);

  // 同步覆盖默认空钩子：mount 顺序在 DAG/核心页之后，先订阅的页面也要能收到后续广播。
  let controller = null;
  const pending = new Set();
  ctx.hooks.projectFilter = {
    current: () => (controller ? controller.filter : null),
    onChange(listener) {
      if (typeof listener !== 'function') return () => {};
      if (controller) return controller.subscribe(listener);
      pending.add(listener);
      return () => pending.delete(listener);
    },
  };

  const render = (model, snapshot) => {
    const { filter, error, loading } = snapshot;
    select.replaceChildren(...filter.options.map(option => {
      const optionEl = node('option', { text: option.label, attrs: { value: option.id } });
      if (option.selected) optionEl.setAttribute('selected', '');
      return optionEl;
    }));
    select.value = filter.selectedId;
    clear.hidden = filter.isAll;
    status.textContent = loading
      ? '加载项目…'
      : (error || (filter.empty ? (filter.emptyReason || model.ALL_PROJECTS_LABEL) : ''));
  };

  modelPromise.then(model => {
    controller = model.createProjectFilterController({ load: () => ctx.client.api('projects') });
    // 把建模前先订阅的页面接到真实控制器上，保证任何 mount 顺序都不丢广播。
    for (const listener of pending) controller.subscribe(listener);
    pending.clear();

    controller.subscribe(filter => {
      // 经共享状态与窗口事件两条通道广播；页面按同一选中值重渲染过滤。
      if (ctx.state) ctx.state.projectFilter = filter;
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('autoloop:project-filter', { detail: filter }));
      }
      render(model, controller.snapshot());
    });

    select.addEventListener('change', () => { controller.select(select.value); });
    clear.addEventListener('click', () => { controller.select(model.ALL_PROJECTS_ID); });

    render(model, controller.snapshot());

    // 锁屏期间不拉数据（客户端尚未绑定设备）；主界面一显示就加载，重连后再刷新。
    const load = async () => {
      status.textContent = '加载项目…';
      await controller.reload();
    };
    const main = document.getElementById('app-main');
    if (main && !main.hidden) {
      void load();
    } else if (main && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => {
        if (!main.hidden) { observer.disconnect(); void load(); }
      });
      observer.observe(main, { attributes: true, attributeFilter: ['hidden'] });
    }
    window.addEventListener('online', () => { void load(); });
  }).catch(error => {
    status.textContent = `项目筛选不可用：${error?.message || error || '加载失败'}`;
  });
}
