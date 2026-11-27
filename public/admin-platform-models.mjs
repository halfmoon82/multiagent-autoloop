// 管理后台 · 平台与模型：平台自动发现、每平台三档模型、工作分配、派发预览与保存。
// 只经 /api/admin/platform-models 读写；所有上游文本走 textContent（el()），不拼 HTML。
import { el } from './views.mjs';

const TIERS = [['light', '便宜档'], ['standard', '中档'], ['heavy', '高档']];
const TIER_LABEL = Object.fromEntries(TIERS);
const ROLE_ROWS = [
  { key: 'dev', title: '开发', hint: 'DAG 节点开发', auto: '按节点自动' },
  { key: 'review', title: '审阅', hint: 'DAG 节点独立审阅', auto: '按节点自动 · 最低中档' },
  { key: 'coord', title: '调度会话', hint: '诊断、协调、派发' },
  { key: 'design', title: '设计会话', hint: 'PRD / Spec / DAG 规划', session: true },
  { key: 'normal', title: '普通会话', hint: '问答、分析、普通开发', session: true },
];

const clone = value => JSON.parse(JSON.stringify(value));
const complete = tiers => Boolean(tiers && TIERS.every(([tier]) => String(tiers[tier] || '').trim()));

export function initialDraft(data) {
  const saved = Boolean(data.lastSaved);
  const platforms = {};
  for (const platform of data.platforms) {
    platforms[platform.id] = platform.tiers ? { ...platform.tiers } : saved ? { light: '', standard: '', heavy: '' } : { ...(data.suggested.platforms[platform.id] || { light: '', standard: '', heavy: '' }) };
  }
  const sessions = clone(data.sessions);
  for (const kind of ['design', 'normal']) if (!sessions[kind]?.platform) sessions[kind] = { ...data.suggested.sessions[kind] };
  // 开关始终显示真实状态（首次进入为关闭）；表中预填建议值，人打开开关并保存才生效。
  return { enabled: data.enabled === true, platforms, roles: clone(data.roles), sessions };
}

function select(options, value, { label, disabledValues = new Set(), onChange }) {
  const node = el('select'); node.setAttribute('aria-label', label);
  for (const [optionValue, text] of options) {
    const option = el('option', '', text); option.value = optionValue;
    if (disabledValues.has(optionValue)) option.disabled = true;
    if (optionValue === value) option.selected = true;
    node.append(option);
  }
  if (!options.some(([optionValue]) => optionValue === value)) { const missing = el('option', '', value ? `${value}（不可用）` : '请选择'); missing.value = value || ''; missing.selected = true; missing.disabled = true; node.prepend(missing); }
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function heading(title, subtitle) {
  const head = el('div', 'panel-heading'); head.append(el('h2', '', title));
  if (subtitle) head.append(el('span', 'subtle', subtitle));
  return head;
}

export function previewLines(data, draft) {
  const name = id => data.platforms.find(p => p.id === id)?.name || id || '未选择';
  const model = (id, tier) => draft.platforms[id]?.[tier] || '平台默认';
  const pick = (id, tier) => `${name(id)} · ${model(id, tier)}`;
  if (!draft.enabled) return ['分档已关闭：所有工作沿用各平台默认模型。'];
  const { dev, review, coord } = draft.roles;
  return [
    `小节点开发 → ${pick(dev.primary, 'light')}　|　${name(dev.primary)} 被频限时 → ${pick(dev.fallback, 'light')}`,
    `普通审阅 → ${pick(review.primary, 'standard')}　|　资金/数据/安全节点审阅 → ${pick(review.primary, 'heavy')}`,
    `调度会话 → ${pick(coord.primary, draft.sessions.coord.tier)}　|　新建设计会话 → ${pick(draft.sessions.design.platform, draft.sessions.design.tier)}　|　新建普通会话 → ${pick(draft.sessions.normal.platform, draft.sessions.normal.tier)}`,
  ];
}

export function initAdmin({ api, toast }) {
  const root = document.getElementById('admin-platform-models');
  let data = null; let draft = null; let error = ''; let saving = false;

  const rerender = () => { if (data) root.replaceChildren(...render()); };
  const change = mutate => { mutate(draft); error = ''; rerender(); };

  function switchPanel() {
    const panel = el('section', 'panel');
    const row = el('div', 'tier-switch');
    const text = el('div');
    const title = el('strong', '', '按档位选模型'); text.append(title, document.createTextNode(' '), el('span', `pill ${draft.enabled ? 'on' : 'off'}`, draft.enabled ? '已开启' : '已关闭'));
    text.append(el('p', 'subtle', '关闭后立即恢复：每个平台用自己的默认模型，无需重启。'));
    const toggle = el('button', `toggle${draft.enabled ? ' on' : ''}`); toggle.type = 'button';
    toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(draft.enabled)); toggle.setAttribute('aria-label', '按档位选模型');
    toggle.addEventListener('click', () => change(d => { d.enabled = !d.enabled; }));
    row.append(text, toggle); panel.append(row); return panel;
  }

  function platformPanel() {
    const panel = el('section', 'panel');
    panel.append(heading('平台分档模型', '平台列表来自运行环境中已登记的 AI 执行者，新平台自动出现'));
    const table = el('table', 'admin-grid'); const head = el('tr');
    for (const text of ['平台', ...TIERS.map(([, label]) => label)]) head.append(el('th', '', text));
    table.append(el('thead')); table.tHead.append(head);
    const body = el('tbody');
    for (const platform of data.platforms) {
      const tr = el('tr'); tr.dataset.platform = platform.id;
      const nameCell = el('td'); const name = el('div', 'admin-name', platform.name);
      const isNew = Boolean(data.lastSaved) && !platform.tiers;
      if (isNew) name.append(document.createTextNode(' '), el('span', 'pill on', '新发现'));
      name.append(el('small', '', `默认：${platform.defaultModel || '未配置'}${platform.models ? ` · ${platform.models.length} 个可选模型` : ' · 读不到模型清单，请手填'}`));
      nameCell.append(name); tr.append(nameCell);
      for (const [tier, label] of TIERS) {
        const td = el('td'); const value = draft.platforms[platform.id]?.[tier] || '';
        const setValue = next => change(d => { d.platforms[platform.id] = { ...(d.platforms[platform.id] || {}), [tier]: next }; });
        if (platform.models) td.append(select([['', '未配置'], ...platform.models.map(m => [m, m])], value, { label: `${platform.name} ${label}`, onChange: setValue }));
        else {
          const input = el('input'); input.value = value; input.placeholder = '未配置 = 平台默认'; input.setAttribute('aria-label', `${platform.name} ${label}`);
          input.addEventListener('change', () => setValue(input.value.trim())); td.append(input);
        }
        if (value === 'hy4flash-free') td.append(document.createTextNode(' '), el('span', 'pill free', '免费'));
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body); panel.append(table);
    panel.append(el('p', 'subtle admin-foot', '新平台在三档配好之前，只用它自己的默认模型；配好后才会出现在下方「工作分配」的可选平台里。'));
    return panel;
  }

  function rolesPanel() {
    const panel = el('section', 'panel');
    panel.append(heading('工作分配', '主平台被频限拦住时自动切备用平台，档位不变'));
    const configured = data.platforms.filter(p => complete(draft.platforms[p.id]));
    const options = configured.map(p => [p.id, p.name]);
    const table = el('table', 'admin-grid'); const head = el('tr');
    for (const text of ['工作类型', '主平台', '备用平台', '档位']) head.append(el('th', '', text));
    table.append(el('thead')); table.tHead.append(head);
    const body = el('tbody');
    for (const row of ROLE_ROWS) {
      const tr = el('tr'); tr.dataset.role = row.key;
      const nameCell = el('td'); const name = el('div', 'admin-name', row.title); name.append(el('small', '', row.hint)); nameCell.append(name); tr.append(nameCell);
      if (row.session) {
        const sessionOptions = data.platforms.map(p => [p.id, p.sessionCapable ? p.name : `${p.name}（未接入）`]);
        const disabled = new Set(data.platforms.filter(p => !p.sessionCapable || !complete(draft.platforms[p.id])).map(p => p.id));
        const cell = el('td'); cell.append(select(sessionOptions, draft.sessions[row.key].platform, { label: `${row.title}平台`, disabledValues: disabled, onChange: v => change(d => { d.sessions[row.key].platform = v; }) }));
        tr.append(cell, el('td', 'dim', '不适用：会话中途不换平台'));
      } else {
        for (const side of ['primary', 'fallback']) {
          // 开发与调度会话需要写权限：只读执行者不出现在可选项里（审阅可以只读）。
          const roleOptions = ['dev', 'coord'].includes(row.key) ? configured.filter(p => p.access !== 'read').map(p => [p.id, p.name]) : options;
          const cell = el('td'); cell.append(select(roleOptions, draft.roles[row.key][side], { label: `${row.title}${side === 'primary' ? '主平台' : '备用平台'}`, onChange: v => change(d => { d.roles[row.key][side] = v; }) }));
          tr.append(cell);
        }
      }
      const tierCell = el('td');
      if (row.auto) tierCell.append(el('span', 'pill auto', row.auto));
      else {
        const target = row.key === 'coord' ? draft.sessions.coord : draft.sessions[row.key];
        tierCell.append(select(TIERS, target.tier, { label: `${row.title}档位`, onChange: v => change(d => { (row.key === 'coord' ? d.sessions.coord : d.sessions[row.key]).tier = v; }) }));
      }
      tr.append(tierCell); body.append(tr);
    }
    table.append(body); panel.append(table);
    panel.append(el('p', 'subtle admin-foot', '会话类改动只影响之后新建的会话，已打开的会话保持原平台和模型。新建会话时也可以临时改选平台。Codex 带只读/工作区写沙箱；Claude Code、WorkBuddy 没有沙箱，靠控制台权限矩阵把越权操作转成会话内决策卡，由您决定。'));
    return panel;
  }

  function floorsPanel() {
    const panel = el('section', 'panel');
    const head = heading('不会降档的情况'); head.append(el('span', 'lock', '主人 11-14 定')); panel.append(head);
    const list = el('ul', 'admin-floors');
    for (const text of ['审阅至少中档；资金、数据、安全类节点开发至少中档、审阅高档；整合审阅固定高档。', '同一节点失败 3 次自动升一档；计划里可为单个节点指定档位（底线仍生效）。']) list.append(el('li', '', text));
    panel.append(list); return panel;
  }

  function previewPanel() {
    const panel = el('section', 'panel'); panel.append(heading('派发预览', '保存前核对'));
    const box = el('div', 'admin-preview'); box.id = 'admin-preview';
    for (const line of previewLines(data, draft)) box.append(el('div', '', line));
    panel.append(box); return panel;
  }

  function actions() {
    const wrap = el('div', 'admin-actions');
    wrap.append(el('span', 'subtle', data.lastSaved ? `最近保存：${new Date(data.lastSaved.at).toLocaleString('zh-CN', { hour12: false })} · 备份 ${data.lastSaved.backup || '无'}` : '尚未保存过：表中为建议值'));
    const restore = el('button', 'button secondary', '恢复建议值'); restore.type = 'button';
    restore.addEventListener('click', () => change(d => { for (const p of data.platforms) d.platforms[p.id] = { ...(data.suggested.platforms[p.id] || { light: '', standard: '', heavy: '' }) }; d.sessions = clone(data.suggested.sessions); }));
    const save = el('button', 'button primary', saving ? '正在保存…' : '保存'); save.type = 'button'; save.id = 'admin-save'; save.disabled = saving;
    save.addEventListener('click', submit);
    wrap.append(restore, save); return wrap;
  }

  function render() {
    const nodes = [switchPanel(), platformPanel(), rolesPanel(), floorsPanel(), previewPanel(), el('div', 'note', '保存会改动真实调度配置：先自动备份，再更新执行者与分档规则；原有规则保留作兜底。正在运行的节点和已打开的会话不受影响。')];
    if (error) { const box = el('div', 'dialog-error', error); box.setAttribute('role', 'alert'); box.id = 'admin-error'; nodes.push(box); }
    nodes.push(actions());
    return nodes;
  }

  async function submit() {
    saving = true; error = ''; rerender();
    const platforms = Object.fromEntries(Object.entries(draft.platforms).filter(([, tiers]) => TIERS.some(([tier]) => String(tiers?.[tier] || '').trim())));
    try {
      const result = await api('/api/admin/platform-models', { method: 'PUT', body: JSON.stringify({ ...draft, platforms }) });
      saving = false; toast(`已保存，备份 ${result.backup}`); await load();
    } catch (failure) { saving = false; error = failure.message; rerender(); }
  }

  async function load() {
    try { data = await api('/api/admin/platform-models'); draft = initialDraft(data); error = ''; rerender(); }
    catch (failure) { root.replaceChildren(el('div', 'dialog-error', `读取失败：${failure.message}`)); }
  }

  return { load, loaded: () => Boolean(data) };
}
