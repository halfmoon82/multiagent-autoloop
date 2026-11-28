// 「设备与偏好」设置页：头部齿轮进入，页内分区（当前控制台 / 设备绑定 / 通知偏好 / 系统字体）。
// 分区内容仍由既有 devices.mjs / notify.mjs / font-touch.mjs 各自 mount 到分区内的原挂点
// （#page-devices / #notify-root / #font-touch-root），本模块只负责入口接线，不编辑那三个文件。
// 「当前控制台」区块（console-hub）与首屏控制台列表共用同一数据源与切换逻辑：数据与动作都来自
// ctx.hooks.consoles（app.mjs 装配的同一份 registry），渲染用本模块导出的 renderConsoleList。
// 自定义名称（console-custom-name / #365）：添加时填名、就地改名、名称优先地址作副标题，只存本机安全存储。
import {
  stageConsoleName, parseConsoleName, renameConsoleFor, CONSOLE_NAME_UNSET_HINT,
} from '../shell.mjs';

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
 * 就地改名：点击「改名」把选择按钮换成输入框 + 保存/取消；输入过程实时校验（空/超长按地址回落），
 * 提示就近显示，保存后由调用方写穿本机清单。不碰凭证、不进 URL。
 */
function beginRename(doc, card, pick, item, onRename, onNote) {
  const cardDoc = doc || card.ownerDocument;
  const existing = card.querySelector?.('.console-rename-editor');
  const close = () => { existing?.remove?.(); pick.hidden = false; };
  if (existing) { close(); return; }
  pick.hidden = true;
  const editor = make(cardDoc, 'div', 'console-rename-editor');
  const label = make(cardDoc, 'label', 'hint', '自定义名称（可选，缺省按地址显示）');
  const input = make(cardDoc, 'input', 'console-rename-input');
  input.type = 'text';
  input.value = item.name && item.name !== item.origin ? item.name : '';
  input.placeholder = '自定义名称（可选）';
  input.setAttribute('aria-label', '控制台自定义名称');
  const note = make(cardDoc, 'span', 'console-rename-note hint');
  note.setAttribute('role', 'status');
  const save = make(cardDoc, 'button', 'console-rename-save', '保存');
  save.type = 'button';
  save.dataset.action = 'save-console-name';
  const cancel = make(cardDoc, 'button', 'console-rename-cancel', '取消');
  cancel.type = 'button';
  cancel.dataset.action = 'cancel-console-name';
  const updateNote = () => {
    const parsed = parseConsoleName(input.value, item.origin);
    note.textContent = parsed.note;
    note.classList?.toggle('error', parsed.overlong);
  };
  input.addEventListener?.('input', updateNote);
  updateNote();
  save.addEventListener('click', event => {
    event.stopPropagation();
    const parsed = parseConsoleName(input.value, item.origin);
    onNote?.(parsed.note, parsed.overlong);
    try { onRename(item.origin, input.value); } catch { /* 失败由调用方就近报告 */ }
    close();
  });
  cancel.addEventListener('click', event => { event.stopPropagation(); onNote?.('', false); close(); });
  editor.append(label, input, note, save, cancel);
  card.append(editor);
}

/**
 * 控制台卡片列表（首屏与设置页共用）。consoles: [{ origin, name, current }]。
 * onSelect(origin) 点选切换；onRemove(origin) 传入时每张卡带「移除」——第一次点变「确认移除？」，
 * 再点才真正移除（二次确认），点别处或 4 秒后复原。
 * onRename(origin, name) 传入时每张卡带「改名」；onNote(text, isError) 回传校验提示。
 */
export function renderConsoleList(container, {
  consoles = [], onSelect = null, onRemove = null, onRename = null, onNote = null,
  currentHint = '使用中', otherHint = '点选即切换，免再次解锁',
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
    const customName = typeof item.name === 'string' && item.name.trim() && item.name !== item.origin;
    const title = make(doc, 'span', 'console-name');
    title.append(make(doc, 'span', 'console-dot'), make(doc, 'span', '', customName ? item.name : item.origin));
    // 名称优先、地址作副标题；未自定义时如实标注按地址显示（fix12 设计稿）。
    const sub = customName ? item.origin : CONSOLE_NAME_UNSET_HINT;
    const meta = make(doc, 'span', 'console-meta', `${sub} · ${item.current ? currentHint : otherHint}`);
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
    if (typeof onRename === 'function') {
      const rename = make(doc, 'button', 'console-rename', '改名');
      rename.type = 'button';
      rename.dataset.action = 'rename-console';
      rename.setAttribute('aria-label', `给控制台 ${customName ? item.name : item.origin} 改名`);
      rename.addEventListener('click', event => {
        event.stopPropagation();
        beginRename(doc, card, pick, item, onRename, onNote);
      });
      card.append(rename);
    }
    container.append(card);
  }
}

/**
 * 把「自定义名称」输入注入绑定卡：添加控制台的地址输入之前。app.mjs 的绑定流程不接收名称参数，
 * 这里在填名时 stage 到 shell.mjs，提交时再 stage 一次（捕获阶段，先于绑定动作），由
 * registry.addConsole 消费；成功后清空输入，不残留到下一次添加。名称只走本机安全存储。
 */
function injectConsoleNameField() {
  const card = document.getElementById('bind-card');
  if (!card || document.getElementById('console-custom-name')) return null;
  const label = make(document, 'label', 'hint', '控制台自定义名称（可选，缺省显示地址）');
  label.htmlFor = 'console-custom-name';
  const input = make(document, 'input', 'console-custom-name-input');
  input.id = 'console-custom-name';
  input.type = 'text';
  // 不静默截断：允许输入超长，由 parseConsoleName 给就地提示并按地址回落。
  input.placeholder = '自定义名称（可选，缺省显示地址）';
  input.autocomplete = 'off';
  const note = make(document, 'span', 'console-name-note hint');
  note.setAttribute('role', 'status');
  const baseLabel = card.querySelector('label[for="base-url"]');
  if (baseLabel) {
    card.insertBefore(label, baseLabel);
    card.insertBefore(input, baseLabel);
    card.insertBefore(note, baseLabel);
  } else {
    card.append(label, input, note);
  }
  return { input, note };
}

/** 设置页「当前控制台」区块：插在设置页最上方，订阅同一数据源，切换/添加/移除/改名走同一组动作。 */
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
  const showNote = (text, isError) => {
    status.textContent = text || '';
    status.classList?.toggle('error', Boolean(isError));
  };
  const run = async action => {
    status.textContent = '';
    try { await action(); }
    catch (error) { status.textContent = error?.message || '操作失败，请重试'; }
  };
  const switchConsole = origin => run(() => consoles().switchConsole(origin));
  const removeConsole = origin => run(() => consoles().removeConsole(origin));
  const renameConsole = (origin, name) => run(() => renameConsoleFor(origin, name).then(render));
  add.addEventListener('click', () => run(() => consoles().addConsole()));

  // 名称字段只注入一次；填名/改名都经 shell.mjs 的同一套校验口径。
  const injected = injectConsoleNameField();
  const nameInput = injected?.input || document.getElementById('console-custom-name');
  const nameNote = injected?.note || document.querySelector('.console-name-note');
  const stageName = () => {
    if (!nameInput) return;
    stageConsoleName(nameInput.value);
    if (nameNote) nameNote.textContent = parseConsoleName(nameInput.value, document.getElementById('base-url')?.value || '').note;
  };
  nameInput?.addEventListener?.('input', stageName);
  nameInput?.addEventListener?.('change', stageName);
  // 捕获阶段先于 app.mjs 的提交监听：确保 addConsole 读到的是当前输入框里的名称。
  document.addEventListener('click', event => {
    if (event.target?.closest?.('#bind-submit')) stageName();
  }, true);

  let lastCount = null;
  const render = () => {
    const hub = consoles();
    const items = hub.list();
    // 添加成功后清掉名称输入与暂存，避免上一次的名称残留到下一次添加。
    if (lastCount !== null && items.length > lastCount) {
      if (nameInput) nameInput.value = '';
      stageConsoleName('');
      if (nameNote) nameNote.textContent = '';
    }
    lastCount = items.length;
    const manageable = Boolean(hub.available);
    renderConsoleList(list, {
      consoles: items,
      onSelect: manageable ? switchConsole : null,
      onRemove: manageable ? removeConsole : null,
      onRename: manageable ? renameConsole : null,
      onNote: showNote,
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
