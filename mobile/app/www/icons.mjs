// 与已确认设计原型一致的轻量线条图标；仅静态受信路径，不渲染上游文本。
const paths = {
  back: '<path d="m15 18-6-6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/>',
  rules: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="14" cy="18" r="2"/>',
  chat: '<path d="M21 12a8 8 0 0 1-8 8H5l-3 2 1-5a9 9 0 1 1 18-5Z"/><path d="M8 11h8M8 15h5"/>',
  runs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cards: '<path d="M7 3h10v4h3v14H4V7h3Z"/><path d="M9 12h6M9 16h4M9 3v4h6V3"/>',
  admin: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
  send: '<path d="m4 4 17 8-17 8 3-8Z"/><path d="M7 12h14"/>',
  file: '<path d="M6 2h8l4 4v16H6Z"/><path d="M14 2v5h5M9 12h6M9 16h6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
};

export function icon(name, className = '') {
  return `<svg class="inline-icon ${className}" aria-hidden="true" viewBox="0 0 24 24">${paths[name] || paths.chevron}</svg>`;
}

export function renderIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
}
