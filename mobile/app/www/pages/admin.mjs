// 管理后台页：分区导航（平台与模型 / 运行环境）+ 加载态/重试 + 内容。
// 数据契约对齐网页版 public/admin-platform-models.mjs 与 public/app.mjs 的「首次进入才加载 + 分区显隐切换」模式。
// 平台与模型：只读字段 + 可编辑表单，保存前确认、保存即自动备份（服务端既有语义）；失败回显错误并保留表单内容。
// 运行环境：只读在线状态与待复查。所有文本用 textContent 渲染，不拼接 HTML，也不直接访问 Hub。
// 视图模型经相对路径 ../src/... 动态加载（同 core.mjs），Node 边界测试不装配 DOM。
export const ADMIN_PANES = Object.freeze(['admin-pane-platform', 'admin-pane-runtime']);

const el = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
};
const loadModel = () => import('../src/core/index.mjs');

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
    const loader = typeof hooks.admin?.loader === 'function' ? hooks.admin.loader : (id, node) => defaultLoader(ctx, id, node);
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

async function defaultLoader(ctx, pane, host) {
  const model = await loadModel();
  if (pane === 'admin-pane-runtime') return loadRuntime(ctx, model, host);
  return loadPlatform(ctx, model, host);
}

async function loadRuntime(ctx, model, host) {
  let snapshot;
  try {
    const state = await ctx.client.api('state');
    const ok = state && typeof state === 'object' && !Array.isArray(state);
    snapshot = { available: { state: ok }, errors: ok ? {} : { state: '状态数据格式不正确' }, state: ok ? state : null };
  } catch (error) {
    snapshot = { available: { state: false }, errors: { state: String(error?.message || error || '读取失败') }, state: null };
  }
  const view = model.buildAdminRuntime(snapshot);
  const env = el('section', 'card');
  env.append(el('h3', '', '运行环境'));
  if (!view.environment.length) env.append(el('p', 'hint', view.environmentReason));
  for (const item of view.environment) {
    const row = el('div', 'core-item');
    row.dataset.env = item.name;
    row.append(el('strong', '', item.name), el('span', 'core-meta', `${item.kind} · ${item.statusLabel}`));
    env.append(row);
  }
  const timers = el('section', 'card');
  timers.append(el('h3', '', '待复查'));
  if (!view.timers.length) timers.append(el('p', 'hint', view.timersReason));
  for (const timer of view.timers) {
    const row = el('div', 'core-item');
    row.append(el('strong', '', timer.rule || '未命名'), el('span', 'core-meta', [timer.about, timer.at].filter(Boolean).join(' · ')));
    timers.append(row);
  }
  host.replaceChildren(env, timers);
}

async function loadPlatform(ctx, model, host) {
  const write = model.createCoreWrite(ctx.client);
  let raw = await write.getPlatformModels();
  let page = model.buildAdminPlatformPage(raw);
  let draft = page.draft;
  let error = '';
  let notice = '';
  let confirming = false;
  let saving = false;

  const rerender = () => host.replaceChildren(...render());
  const change = mutate => { mutate(draft); error = ''; notice = ''; confirming = false; rerender(); };
  const select = (options, value, label, onChange, disabled = new Set()) => {
    const node = el('select');
    node.setAttribute('aria-label', label);
    for (const [optionValue, text] of options) {
      const option = el('option', '', text);
      option.value = optionValue;
      option.disabled = disabled.has(optionValue);
      option.selected = optionValue === value;
      node.append(option);
    }
    if (!options.some(([optionValue]) => optionValue === value)) {
      const missing = el('option', '', value ? `${value}（不可用）` : '请选择');
      missing.value = value || '';
      missing.selected = true;
      missing.disabled = true;
      node.prepend(missing);
    }
    node.addEventListener('change', () => onChange(node.value));
    return node;
  };
  const field = (label, control) => { const wrap = el('label', 'admin-field'); wrap.append(el('span', 'core-meta', label), control); return wrap; };

  function render() {
    const nodes = [];
    const sw = el('section', 'card');
    const toggle = el('button', `core-action${draft.enabled ? ' primary' : ''}`, draft.enabled ? '按档位选模型：已开启' : '按档位选模型：已关闭');
    toggle.type = 'button';
    toggle.dataset.adminToggle = '';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(draft.enabled));
    toggle.addEventListener('click', () => change(d => { d.enabled = !d.enabled; }));
    sw.append(el('h3', '', '平台与模型'), toggle, el('p', 'hint', '关闭后立即恢复：每个平台用自己的默认模型，无需重启。'));
    nodes.push(sw);

    const plat = el('section', 'card');
    plat.append(el('h3', '', '平台分档模型'));
    if (page.empty) plat.append(el('p', 'hint', page.emptyReason));
    for (const platform of page.platforms) {
      const box = el('div', 'core-card');
      box.dataset.platform = platform.id;
      const title = el('strong', '', platform.name);
      box.append(title);
      if (platform.isNew) title.append(document.createTextNode(' '), el('span', 'core-status good', '新发现'));
      box.append(el('p', 'core-meta', `默认：${platform.defaultModel}${platform.models ? ` · ${platform.modelCount} 个可选模型` : ' · 读不到模型清单，请手填'}`));
      for (const [tier, label] of model.ADMIN_TIERS) {
        const value = draft.platforms[platform.id]?.[tier] || '';
        const setValue = next => change(d => { d.platforms[platform.id] = { ...(d.platforms[platform.id] || {}), [tier]: next }; });
        let control;
        if (platform.models) control = select([['', '未配置'], ...platform.models.map(m => [m, m])], value, `${platform.name} ${label}`, setValue);
        else {
          control = el('input');
          control.value = value;
          control.placeholder = '未配置 = 平台默认';
          control.setAttribute('aria-label', `${platform.name} ${label}`);
          control.addEventListener('change', () => setValue(control.value.trim()));
        }
        box.append(field(label, control));
      }
      plat.append(box);
    }
    plat.append(el('p', 'hint', '新平台在三档配好之前，只用它自己的默认模型；配好后才会出现在下方「工作分配」的可选平台里。'));
    nodes.push(plat);

    const roles = el('section', 'card');
    roles.append(el('h3', '', '工作分配'), el('p', 'hint', '主平台被频限拦住时自动切备用平台，档位不变'));
    const configured = page.platforms.filter(p => model.tiersComplete(draft.platforms[p.id]));
    for (const row of model.ADMIN_ROLE_ROWS) {
      const box = el('div', 'core-card');
      box.dataset.role = row.key;
      box.append(el('strong', '', row.title), el('p', 'core-meta', row.hint));
      if (row.session) {
        const options = page.platforms.map(p => [p.id, p.sessionCapable ? p.name : `${p.name}（未接入）`]);
        const disabled = new Set(page.platforms.filter(p => !p.sessionCapable || !model.tiersComplete(draft.platforms[p.id])).map(p => p.id));
        box.append(field('平台', select(options, draft.sessions[row.key]?.platform, `${row.title}平台`, v => change(d => { d.sessions[row.key].platform = v; }), disabled)));
        box.append(el('p', 'hint', '不适用：会话中途不换平台'));
      } else {
        for (const side of ['primary', 'fallback']) {
          const pool = ['dev', 'coord'].includes(row.key) ? configured.filter(p => p.access !== 'read') : configured;
          box.append(field(side === 'primary' ? '主平台' : '备用平台', select(pool.map(p => [p.id, p.name]), draft.roles[row.key]?.[side], `${row.title}${side === 'primary' ? '主平台' : '备用平台'}`, v => change(d => { d.roles[row.key][side] = v; }))));
        }
      }
      if (row.auto) box.append(el('span', 'core-status', row.auto));
      else {
        const target = draft.sessions[row.key];
        box.append(field('档位', select(model.ADMIN_TIERS, target?.tier, `${row.title}档位`, v => change(d => { d.sessions[row.key].tier = v; }))));
      }
      roles.append(box);
    }
    nodes.push(roles);

    const floors = el('section', 'card');
    floors.append(el('h3', '', '不会降档的情况'));
    for (const text of page.floors) floors.append(el('p', 'hint', text));
    nodes.push(floors);

    const preview = el('section', 'card');
    preview.append(el('h3', '', '派发预览'));
    for (const line of model.adminPreviewLines(raw, draft)) preview.append(el('p', 'core-meta', line));
    nodes.push(preview);

    if (error) { const box = el('p', 'status error', error); box.setAttribute('role', 'alert'); box.dataset.adminError = ''; nodes.push(box); }
    if (notice) { const box = el('p', 'status', notice); box.dataset.adminNotice = ''; nodes.push(box); }
    nodes.push(el('p', 'hint', page.lastSaved ? `最近保存：${page.lastSaved.at || '未知'} · 备份 ${page.lastSaved.backup}` : '尚未保存过：表中为建议值'));

    const actions = el('div', 'core-actions');
    if (!confirming) {
      const save = el('button', 'core-action primary', '保存');
      save.type = 'button';
      save.dataset.adminSave = '';
      save.addEventListener('click', () => { confirming = true; error = ''; notice = ''; rerender(); });
      actions.append(save);
    } else {
      const sure = el('div', 'card');
      sure.dataset.adminConfirm = '';
      sure.append(el('strong', '', '确认保存？'), el('p', 'hint', page.confirm));
      for (const line of model.adminPreviewLines(raw, draft)) sure.append(el('p', 'core-meta', line));
      const ok = el('button', 'core-action primary', saving ? '正在保存…' : '确认保存（自动备份）');
      ok.type = 'button';
      ok.dataset.adminConfirmSave = '';
      ok.disabled = saving;
      ok.addEventListener('click', () => { void submit(); });
      const cancel = el('button', 'core-action', '取消');
      cancel.type = 'button';
      cancel.dataset.adminCancel = '';
      cancel.disabled = saving;
      cancel.addEventListener('click', () => { confirming = false; rerender(); });
      sure.append(ok, cancel);
      nodes.push(sure);
    }
    nodes.push(actions);
    return nodes;
  }

  async function submit() {
    saving = true;
    rerender();
    try {
      const result = await write.savePlatformModels(model.buildAdminSavePayload(draft));
      saving = false;
      confirming = false;
      notice = `已保存，备份 ${result?.backup || '无'}`;
      try { raw = await write.getPlatformModels(); page = model.buildAdminPlatformPage(raw); draft = page.draft; } catch { /* 已保存成功；刷新失败不丢提示 */ }
      rerender();
    } catch (failure) {
      saving = false;
      confirming = false;
      error = String(failure?.message || '保存失败，请重试'); // 失败保留 draft，表单内容不丢
      rerender();
    }
  }

  rerender();
}
