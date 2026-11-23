// 非 DAG 卡片统一限高：只有实际超高的卡片才显示展开控件，短卡保持原样。
const SELECTOR = '.card, .sessions-item, .sessions-question-card, .sessions-current-card, .sessions-archived-item, .sessions-queue-item';
const COLLAPSED_HEIGHT = 160;

function prepare(el) {
  if (el.closest('#page-dag') || el.dataset.collapsible !== undefined) return;
  if (el.scrollHeight <= COLLAPSED_HEIGHT + 8) { el.dataset.collapsible = 'not-needed'; return; }
  el.dataset.collapsible = '';
  el.dataset.expanded = 'false';
  el.classList.add('collapsible-card');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card-expand';
  button.textContent = '展开';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', '展开卡片');
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const expanded = el.dataset.expanded !== 'true';
    el.dataset.expanded = String(expanded);
    button.textContent = expanded ? '收起' : '展开';
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', expanded ? '收起卡片' : '展开卡片');
  });
  el.before(button);
}

export function attachCollapsibleCards(root = document) {
  for (const el of root.querySelectorAll(SELECTOR)) prepare(el);
}

export function observeCollapsibleCards(root = document) {
  attachCollapsibleCards(root);
  let frame = null;
  const observer = new MutationObserver(() => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; attachCollapsibleCards(root); });
  });
  observer.observe(root, { childList: true, subtree: true });
  return observer;
}
