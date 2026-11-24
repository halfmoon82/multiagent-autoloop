// 静态信息卡片自动折叠后必须能再展开/收起：折叠的卡片插入展开控件，状态跨常规刷新保持。
// 声明 data-expand-src 的卡片在展开时按需加载内容，失败就地重试（不跳页、不清空状态）。
const SELECTOR = '.card, .core-card, .core-item, .sessions-item, .sessions-question-card, .sessions-current-card, .sessions-archived-item, .sessions-queue-item';
const COLLAPSED_HEIGHT = 160;
const STATE_KEY = 'collapsible-cards:expanded';
const memoryState = new Map();

// 常规刷新保留展开态；隐私模式下 sessionStorage 不可用时回退内存，不抛错影响页面。
function makeStore() {
  let storage = null;
  try { storage = globalThis.sessionStorage ?? null; } catch { /* 不可访问则回退 */ }
  return {
    read() {
      try {
        const raw = storage ? storage.getItem(STATE_KEY) : memoryState.get(STATE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch { return {}; }
    },
    write(state) {
      const raw = JSON.stringify(state);
      try {
        if (storage) storage.setItem(STATE_KEY, raw);
        else memoryState.set(STATE_KEY, raw);
      } catch { /* 写入失败只丢持久化，当前页面交互照常 */ }
    },
  };
}

// 卡片身份：显式 data-collapsible-id 优先；否则用最近 id 容器内的卡片序号，常规刷新 DOM 顺序稳定。
function cardKey(el, root) {
  if (el.dataset.collapsibleId) return el.dataset.collapsibleId;
  const anchor = el.closest('[id]') || root || document;
  const scope = anchor.id ? anchor.id : 'root';
  const cards = anchor.matches?.(SELECTOR) ? [anchor] : [...anchor.querySelectorAll(SELECTOR)];
  const index = cards.indexOf(el);
  return `${scope}:${index < 0 ? 0 : index}`;
}

function setExpanded(el, button, expanded, store, key) {
  el.dataset.expanded = String(expanded);
  button.textContent = expanded ? '收起' : '展开';
  button.setAttribute('aria-expanded', String(expanded));
  button.setAttribute('aria-label', expanded ? '收起卡片' : '展开卡片');
  const state = store.read();
  if (expanded) state[key] = true;
  else delete state[key];
  store.write(state);
}

function clearStatus(el) {
  for (const child of el.children) {
    if (child.classList?.contains('card-expand-status')) child.remove();
  }
}

function showRetry(el, load) {
  clearStatus(el);
  const status = document.createElement('div');
  status.className = 'card-expand-status';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'card-expand-retry';
  retry.textContent = '加载失败，重试';
  retry.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    load();
  });
  status.append(retry);
  el.append(status);
}

function loadContent(el) {
  const src = el.dataset.expandSrc;
  if (!src || el.dataset.expandLoaded === 'true' || typeof fetch !== 'function') return;
  const run = () => {
    clearStatus(el);
    const status = document.createElement('div');
    status.className = 'card-expand-status';
    status.textContent = '展开中…';
    el.append(status);
    fetch(src).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    }).then(text => {
      clearStatus(el);
      const content = document.createElement('div');
      content.dataset.expandContent = 'loaded';
      content.textContent = text; // 纯文本渲染，不拼接不可信 HTML
      el.append(content);
      el.dataset.expandLoaded = 'true';
    }).catch(() => {
      // 失败保留卡片展开态并就地给重试入口，用户不必重新点展开。
      showRetry(el, run);
    });
  };
  run();
}

function prepare(el, root, store) {
  if (el.closest('#page-dag')) return; // DAG 卡片是可操作内容，不参与静态折叠
  // 可操作内容不参与自动折叠：模型/输入/确认等必须直接可点，展开控件不能插进按钮里。
  if (el.querySelector('button,input,select,textarea')) {
    el.previousElementSibling?.classList?.contains('card-expand') && el.previousElementSibling.remove();
    el.classList.remove('collapsible-card');
    el.dataset.collapsible = 'interactive';
    el.dataset.expanded = 'true';
    return;
  }
  if (el.dataset.collapsible !== undefined) return;
  // 隐藏容器里量不到真实高度，等 visible 后由观察器重新评估，避免被永久标记 not-needed。
  if (el.offsetParent === null) return;
  if (el.scrollHeight <= COLLAPSED_HEIGHT + 8) {
    el.dataset.collapsible = 'not-needed';
    return;
  }

  const key = cardKey(el, root); // 读写用同一身份，避免 attach 指定 root 时键不一致
  const expanded = store.read()[key] === true;
  el.dataset.collapsible = '';
  el.dataset.expanded = String(expanded);
  el.classList.add('collapsible-card');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card-expand';
  button.textContent = expanded ? '收起' : '展开';
  button.setAttribute('aria-expanded', String(expanded));
  button.setAttribute('aria-label', expanded ? '收起卡片' : '展开卡片');
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const next = el.dataset.expanded !== 'true';
    setExpanded(el, button, next, store, key);
    if (next) loadContent(el);
  });
  el.before(button);
  if (expanded) loadContent(el); // 刷新后恢复展开态时补回按需内容
}

export function attachCollapsibleCards(root = document) {
  const store = makeStore();
  for (const el of root.querySelectorAll(SELECTOR)) prepare(el, root, store);
}

export function observeCollapsibleCards(root = document) {
  attachCollapsibleCards(root);
  let frame = null;
  const observer = new MutationObserver(() => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; attachCollapsibleCards(root); });
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  return observer;
}
