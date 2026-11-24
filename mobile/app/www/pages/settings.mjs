// 「设备与偏好」设置页：头部齿轮进入，页内分区（当前控制台 / 设备绑定 / 通知偏好 / 系统字体）。
// 分区内容仍由既有 devices.mjs / notify.mjs / font-touch.mjs 各自 mount 到分区内的原挂点
// （#page-devices / #notify-root / #font-touch-root），本模块只负责入口接线，不编辑那三个文件。
// 「当前控制台」区块（console-hub）与首屏控制台列表共用同一数据源与切换逻辑：数据与动作都来自
// ctx.hooks.consoles（app.mjs 装配的同一份 registry），渲染用本模块导出的 renderConsoleList。
export const SETTINGS_SECTIONS = Object.freeze([
  { title: '当前控制台', host: 'settings-console' },
  { title: '设备绑定', host: 'page-devices' },
  { title: '通知偏好', host: 'notify-root' },
  { title: '系统字体', host: 'font-touch-root' },
]);

const make = (doc, tag, className, text) => {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text; // 上游文本一律 textContent，不拼 HTML
  return el;
};

/**
 * 控制台卡片列表（首屏与设置页共用）。consoles: [{ origin, name, current }]。
 * onSelect(origin) 点选切换；onRemove(origin) 传入时每张卡带「移除」——第一次点变「确认移除？」，
 * 再点才真正移除（二次确认），点别处或 4 秒后复原。
 */
export function renderConsoleList(container, {
  consoles = [], onSelect = null, onRemove = null, currentHint = '使用中', otherHint = '点选即切换，免再次解锁',
} = {}) {
  if (!container) return;
  const doc = container.ownerDocument;
  container.replaceChildren();
  container.classList.add('console-list');
  for (const item of consoles) {
    const card = make(doc, 'div', `console-card${item.current ? ' is-current' : ''}`);
    card.dataset.consoleOrigin = item.origin;
    const pick = make(doc, 'button', 'console-pick');
    pick.type = 'button';
    pick.dataset.action = 'select-console';
    if (item.current) pick.setAttribute('aria-current', 'true');
    const title = make(doc, 'span', 'console-name');
    title.append(make(doc, 'span', 'console-dot'), make(doc, 'span', '', item.name || item.origin));
    const meta = make(doc, 'span', 'console-meta', `${item.origin} · ${item.current ? currentHint : otherHint}`);
    pick.append(title, meta);
    if (typeof onSelect === 'function') pick.addEventListener('click', () => onSelect(item.origin));
    card.append(pick);
    if (typeof onRemove === 'function') {
      const remove = make(doc, 'button', 'console-remove', '移除');
      remove.type = 'button';
      remove.dataset.action = 'remove-console';
      remove.setAttribute('aria-label', `移除控制台 ${item.name || item.origin}`);
      let resetTimer = null;
      const reset = () => { remove.dataset.confirm = ''; remove.textContent = '移除'; if (resetTimer) clearTimeout(resetTimer); resetTimer = null; };
      remove.addEventListener('click', event => {
        event.stopPropagation();
        if (remove.dataset.confirm !== '1') {
          remove.dataset.confirm = '1';
          remove.textContent = '确认移除？';
          resetTimer = setTimeout(reset, 4000);
          return;
        }
        reset();
        onRemove(item.origin);
      });
      card.append(remove);
    }
    container.append(card);
  }
}

/** 设置页「当前控制台」区块：插在设置页最上方，订阅同一数据源，切换/添加/移除走同一组动作。 */
function mountConsoleSection(ctx) {
  const page = document.getElementById('page-settings');
  if (!page || document.getElementById('settings-console')) return;
  const section = make(document, 'section', 'settings-section console-section');
  section.id = 'settings-console';
  section.setAttribute('aria-label', '当前控制台');
  const heading = make(document, 'h3', '', '当前控制台');
  const hint = make(document, 'p', 'hint', '与首屏选择共用同一数据源');
  const list = make(document, 'div');
  list.id = 'settings-console-list';
  const empty = make(document, 'p', 'hint console-empty', '还没有已添加的控制台');
  const add = make(document, 'button', 'console-add', '＋ 添加控制台');
  add.type = 'button';
  add.dataset.action = 'add-console';
  const status = make(document, 'p', 'status error');
  status.setAttribute('role', 'alert');
  section.append(heading, hint, list, empty, add, status);
  const title = page.querySelector('.settings-title');
  if (title) title.after(section); else page.prepend(section);

  const consoles = () => ctx.hooks.consoles;
  const run = async action => {
    status.textContent = '';
    try { await action(); }
    catch (error) { status.textContent = error?.message || '操作失败，请重试'; }
  };
  const switchConsole = origin => run(() => consoles().switchConsole(origin));
  const removeConsole = origin => run(() => consoles().removeConsole(origin));
  add.addEventListener('click', () => run(() => consoles().addConsole()));

  const render = () => {
    const hub = consoles();
    const items = hub.list();
    const manageable = Boolean(hub.available);
    renderConsoleList(list, {
      consoles: items,
      onSelect: manageable ? switchConsole : null,
      onRemove: manageable ? removeConsole : null,
      currentHint: '使用中',
      otherHint: '点击切换',
    });
    empty.hidden = items.length > 0;
    add.hidden = !manageable;
    section.dataset.state = items.length ? 'normal' : 'empty';
  };
  render();
  consoles().subscribe?.(render);
}

/** 挂载点。齿轮按钮经 ctx.hooks.openSettings 进入页面栈；返回键逐级返回由 app.mjs 的页面栈负责。 */
export function mount(ctx) {
  if (typeof document === 'undefined') return;
  const gear = document.getElementById('open-settings');
  if (gear) gear.addEventListener('click', () => ctx.hooks.openSettings());
  if (ctx.hooks?.consoles) mountConsoleSection(ctx);
}
