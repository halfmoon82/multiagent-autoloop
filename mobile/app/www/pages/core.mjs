// 总览 / 规则 / 轮次 / 待办 / 执行授权页面：把 mobile/src/core 的只读视图模型渲染到 App 壳。
// 页面只改自己的容器，跨页互调走 ctx.hooks；所有上游文本用 textContent 渲染，不拼接 HTML。
// 视图模型经相对路径 ../src/... 加载（受限静态服务 /mobile/src/）；Node 边界测试不装配 DOM，
// 所以不在模块顶层静态导入 ../src/...（Node 下会解析到 www/src 而不是 mobile/src）。
const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/core/index.mjs');
const loadFilterModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/project-filter/index.mjs');
// 决策卡三内置操作的写客户端复用 sessions 的 createSessionsWrite（已登记 markHandled /
// resolveCard / delegateCard 三个固定写路由），不另造一套写实现；按需加载，Node 下不装配 DOM。
const loadCardWrite = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/sessions/index.mjs');

export { loadViewModel };

// 执行授权并入「待办」页；主导航固定由 index.html 的六个 Tab 拥有，运行时不再追加第七个。

const node = (tag, { className, text, attrs = {} } = {}, children = []) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  for (const child of children) if (child) element.appendChild(child);
  return element;
};

// ---------- 项目任务进度环（fix6 project-ring-web-parity，2026-11-26 主人定）----------
// 与网页版 public/progress-view.mjs progressRing 同参数同画法：节点 = 连续扇区铺满整圈（光滑相接、无分隔线），
// 节点名沿扇区中线切线方向写在色带内（按弧长截断，不越出扇区），内圈每节点一段进度弧，进行中节点叠三角指针，
// 中心总进度% 与节点数；点扇区向外膨出并切换下方节点详情。窄屏只缩放环尺寸、详情放在环下方。
const RING_NS = 'http://www.w3.org/2000/svg';
const RING_SIZE = 280;
const RING_RADIUS = 90;
const RING_STROKE = 36;
const RING_BULGE = 12;
const RING_INNER_STROKE = 7;
const RING_INNER_GAP = 4;
const RING_ACTIVE_KINDS = new Set(['active', 'review', 'rework']);

function svgNode(tag, attrs = {}) {
  const element = document.createElementNS(RING_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function colorIsLight(color) {
  const hsl = /^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/.exec(String(color || ''));
  if (hsl) return Number(hsl[3]) > 60;
  const hex = /^#([0-9a-f]{6})$/i.exec(String(color || ''));
  if (!hex) return true;
  const value = parseInt(hex[1], 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(channel => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.42;
}

// 节点内进度 0..1：节点自报 percent 才算实测；否则回落状态完成度档（推导值，措辞区分，不冒充实测）。
export function nodeInnerProgress(sector) {
  if (sector?.status?.kind === 'done') return { value: 1, reported: Number.isFinite(sector?.percent) };
  const percent = Number(sector?.percent);
  if (Number.isFinite(percent) && percent > 0) return { value: Math.min(1, percent / 100), reported: true };
  return { value: Math.min(1, Math.max(0, Number(sector?.completion) || 0)), reported: false };
}
const innerProgressText = inner => (inner.reported ? `节点内进度 ${Math.round(inner.value * 100)}%` : `完成度档 ${Math.round(inner.value * 100)}%`);

// 节点环（扇区 = 节点）。view：{ key, title, percent, nodes[] }；onPick(nodeId) = 点扇区。
export function buildProgressRing(view, { selectedId = '', onPick = null } = {}) {
  const nodes = view.nodes || [];
  const count = nodes.length;
  const center = RING_SIZE / 2;
  const radius = RING_RADIUS;
  const wrap = node('div', { className: 'pring', attrs: { 'data-ring-segments': String(count), role: 'group', 'aria-label': `${view.title || ''} 节点环，共 ${count} 个节点，点击扇区切换详情` } });
  const svg = svgNode('svg', { viewBox: `0 0 ${RING_SIZE} ${RING_SIZE}`, class: 'pring-svg' });
  const segs = svgNode('g', { class: 'ring-segs' });
  const innerTrack = svgNode('g', { class: 'ring-inner-track' });
  const innerArcs = svgNode('g', { class: 'ring-inner-arcs' });
  const pointers = svgNode('g', { class: 'ring-pointers' });
  const labels = svgNode('g', { class: 'ring-labels' });
  const circumference = 2 * Math.PI * radius;
  const share = count ? circumference / count : 0;
  const step = count ? 360 / count : 0;
  const arcAt = radius + 6;
  const labelFont = count > 8 ? 8 : 9;
  const charWidth = labelFont + 0.3;
  const arcChars = Math.floor(((2 * Math.PI * arcAt) / Math.max(count, 1) - 1.5) / charWidth);
  const outerEdge = radius + RING_STROKE / 2 - labelFont / 2 - 1;
  const radialChars = Math.floor((2 * Math.sqrt(Math.max(0, outerEdge ** 2 - arcAt ** 2))) / charWidth);
  const fitChars = Math.max(2, Math.min(arcChars, radialChars));
  const maxChars = count > 8 ? Math.min(4, fitChars) : fitChars;
  // 节点标签：按扇区可容纳字数截断（不加省略号），完整标题在悬停提示与下方详情。
  const shorten = value => [...String(value || '')].slice(0, maxChars).join('');
  const innerRadius = radius - RING_STROKE / 2 - RING_INNER_GAP - RING_INNER_STROKE / 2;
  const innerShare = count ? (2 * Math.PI * innerRadius) / count : 0;
  const arc = (r, offset, length, width, cls) => svgNode('circle', {
    cx: center, cy: center, r, fill: 'none', 'stroke-width': width,
    'stroke-dasharray': `${Math.max(0, length)} ${Math.max(0, 2 * Math.PI * r - length)}`,
    'stroke-dashoffset': -offset, transform: `rotate(-90 ${center} ${center})`, class: cls,
  });
  nodes.forEach((sector, index) => {
    const selected = sector.id === selectedId;
    // 选中扇区整块变厚：内沿不动，外沿向外长 RING_BULGE；半径变大后弧长按 r/radius 等比放大，起止角对齐。
    const grow = selected ? RING_BULGE : 0;
    const segRadius = radius + grow / 2;
    const k = segRadius / radius;
    const inner = nodeInnerProgress(sector);
    const seg = arc(segRadius, index * share * k, share * k, RING_STROKE + grow, `ring-seg ${sector.status.kind}${selected ? ' selected' : ''}`);
    seg.setAttribute('stroke', sector.color);
    seg.setAttribute('data-ring-node', sector.id);
    seg.setAttribute('role', 'button');
    seg.setAttribute('tabindex', '0');
    seg.setAttribute('aria-pressed', String(selected));
    seg.setAttribute('aria-label', `${sector.title}，${sector.status.label}，${innerProgressText(inner)}${selected ? '，当前选中' : ''}`);
    const tip = svgNode('title');
    tip.textContent = `${sector.title} · ${sector.status.label} · ${innerProgressText(inner)}`;
    seg.appendChild(tip);
    if (onPick) {
      const pick = event => {
        if (event?.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        event?.preventDefault?.(); event?.stopPropagation?.();
        onPick(sector.id);
      };
      seg.addEventListener('click', pick);
      seg.addEventListener('keydown', pick);
    }
    segs.appendChild(seg);
    innerTrack.appendChild(arc(innerRadius, index * innerShare, innerShare, RING_INNER_STROKE, 'ring-inner-seg'));
    innerArcs.appendChild(arc(innerRadius, index * innerShare, innerShare * inner.value, RING_INNER_STROKE, `ring-inner-fill ${sector.status.kind}`));
    const mid = -90 + (index + 0.5) * step;
    const rad = (mid * Math.PI) / 180;
    if (RING_ACTIVE_KINDS.has(sector.status.kind)) {
      const at = innerRadius - RING_INNER_STROKE / 2;
      const p = (r, a) => `${center + r * Math.cos(a)} ${center + r * Math.sin(a)}`;
      const pointer = svgNode('path', { d: `M ${p(at, rad)} L ${p(at - 5.5, rad - 4.5 / at)} L ${p(at - 5.5, rad + 4.5 / at)} Z`, class: 'ring-pointer' });
      const pointerTip = svgNode('title');
      pointerTip.textContent = `进行中：${sector.title}（${sector.status.label}）`;
      pointer.appendChild(pointerTip);
      pointers.appendChild(pointer);
    }
    const labelAt = selected ? arcAt + RING_BULGE / 2 : arcAt;
    const x = center + labelAt * Math.cos(rad);
    const y = center + labelAt * Math.sin(rad);
    let rotation = mid + 90;
    if (rotation > 90 && rotation < 270) rotation -= 180;
    const light = colorIsLight(sector.color);
    const label = svgNode('text', {
      class: `ring-label${selected ? ' selected' : ''}`, x, y, transform: `rotate(${rotation} ${x} ${y})`,
      'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': labelFont,
      fill: light ? '#3f4d47' : '#ffffff', stroke: light ? '#ffffff' : '#1f2a26', 'stroke-opacity': light ? '0.6' : '0.35',
      'stroke-width': '1.6', 'paint-order': 'stroke', 'data-ring-label': sector.id,
    });
    label.textContent = shorten(sector.title);
    labels.appendChild(label);
  });
  const percent = svgNode('text', { x: center, y: center - 2, 'text-anchor': 'middle', class: 'pring-percent' });
  percent.textContent = `${view.percent}%`;
  const sub = svgNode('text', { x: center, y: center + 18, 'text-anchor': 'middle', class: 'pring-sub' });
  sub.textContent = `总进度 · ${count} 个节点`;
  svg.append(segs, innerTrack, innerArcs, pointers, labels, percent, sub);
  wrap.appendChild(svg);
  return wrap;
}

// 节点详情（与网页 overviewNodePanel 同字段）：标题+状态、波次/槽位/分支、节点内进度、任务摘要、
// 执行 Agent、模型、费用 Token、查看 PR、查看运行详情。渲染失败就地重试，不拖垮整张卡。
export function buildRingNodePanel(sector, view, { onRunDetail = null } = {}) {
  const panel = node('div', { className: 'pring-node', attrs: { 'data-ring-detail': sector?.id || '' } });
  const fill = () => {
    panel.replaceChildren();
    try {
      if (!sector) { panel.appendChild(node('p', { className: 'hint', text: '暂无节点。' })); return; }
      const kind = sector.status.kind === 'done' ? 'good' : sector.status.kind === 'blocked' ? 'warn' : '';
      panel.appendChild(node('div', { className: 'pring-node-head' }, [
        node('strong', { text: sector.title }),
        node('span', { className: `pring-badge ${kind}`.trim(), text: sector.status.label }),
      ]));
      panel.appendChild(node('p', { className: 'pring-node-note', text: `${view.segmentNote} · 点扇区切换节点` }));
      const facts = node('div', { className: 'pring-facts' });
      const fact = (label, value, key) => facts.appendChild(node('div', { className: 'pring-fact', attrs: { 'data-fact': key } }, [
        node('span', { className: 'pring-fact-label', text: label }),
        node('span', { className: 'pring-fact-value', text: value }),
      ]));
      fact('状态', `${sector.status.label}${sector.part ? ` · ${sector.part}` : ''}`, 'status');
      if (Number.isFinite(sector.wave)) fact('波次', `第 ${sector.wave} 波`, 'wave');
      if (sector.slot != null) fact('槽位', `dag-slot-${sector.slot}`, 'slot');
      if (sector.branch) fact('分支', sector.branch, 'branch');
      fact('节点内进度', Number.isFinite(sector.percent) ? `${sector.percent}%` : `${innerProgressText(nodeInnerProgress(sector))}（未上报实测，按状态推导）`, 'inner');
      fact('任务摘要', sector.summary, 'summary');
      fact('执行 Agent', sector.agent, 'agent');
      fact('模型', sector.model, 'model');
      fact('费用 Token', sector.usageText, 'usage');
      panel.appendChild(facts);
      const links = node('div', { className: 'pring-links' });
      if (/^https:\/\//.test(String(sector.prUrl || ''))) {
        links.appendChild(node('a', { className: 'pring-link', text: '查看 PR', attrs: { href: sector.prUrl, rel: 'noreferrer', target: '_blank' } }));
      }
      if (onRunDetail) {
        const open = node('button', { className: 'core-action pring-run', text: '查看运行详情 →', attrs: { type: 'button', 'data-ring-run': view.runId || '', 'data-ring-run-node': sector.id } });
        open.addEventListener('click', () => onRunDetail(sector));
        links.appendChild(open);
      }
      if (links.children.length) panel.appendChild(links);
    } catch (error) {
      panel.replaceChildren();
      const retry = node('button', { className: 'core-retry', text: '重试', attrs: { type: 'button', 'data-ring-detail-retry': '' } });
      retry.addEventListener('click', fill);
      panel.append(node('p', { className: 'hint', text: `节点详情加载失败：${error?.message || error}` }), retry);
    }
  };
  fill();
  return panel;
}

// 串行链「查看运行详情」：就地展开按执行顺序分组的全部节点（网页为独立运行详情页，窄屏改为就地展开）。
function buildSerialRunDetail(view) {
  const panel = node('div', { className: 'pring-run-detail', attrs: { 'data-ring-run-detail': view.runId || '', hidden: '' } });
  const groups = [['已完成', n => n.status.kind === 'done'], ['当前', n => n.status.kind !== 'done' && n.id === view.currentId], ['待开始', n => n.status.kind !== 'done' && n.id !== view.currentId]];
  for (const [label, match] of groups) {
    const list = view.nodes.filter(match);
    if (!list.length) continue;
    const group = node('div', { className: 'pring-run-group' }, [node('strong', { text: `${label} · ${list.length} 个节点` })]);
    const ul = node('ul', { className: 'core-list' });
    for (const n of list) ul.appendChild(node('li', { attrs: { 'data-ring-run-row': n.id }, text: [n.title, n.status.label, `${n.percent}%`, n.agent, n.model, n.usageText].join(' · ') }));
    group.appendChild(ul);
    panel.appendChild(group);
  }
  return panel;
}

const chipsLine = (chips, className) => {
  const line = node('div', { className: `pring-chips ${className}`.trim() });
  for (const chip of chips || []) line.appendChild(node('span', { className: 'pring-chip', text: chip.text, attrs: { 'data-chip': chip.id } }));
  return line;
};

// 一张项目进度卡：头（项目名 + 串行链/并行 DAG + 总进度%）→ 副标题 → 环 → 节点详情 → 费用汇总条。
// selectedId 为空时回到默认节点（当前/进行中），与网页一致。
export function buildProjectRingCard(card, { selectedId = '', defaultId = '', onPick = () => {}, onDagDetail = () => {} } = {}) {
  const chosen = card.nodes.find(n => n.id === selectedId) || card.nodes.find(n => n.id === defaultId) || card.nodes[card.nodes.length - 1] || null;
  const wrap = node('article', { className: 'pring-card', attrs: { 'data-ring-card': card.key, 'data-ring-kind': card.kind, 'data-ring-run-id': card.runId || '' } });
  wrap.appendChild(node('div', { className: 'pring-head' }, [
    node('strong', { className: 'pring-title', text: card.title }),
    node('span', { className: `pring-badge ${card.kind === 'dag' ? 'good' : ''}`.trim(), text: card.badge }),
    node('span', { className: 'pring-pct', text: `${card.percent}%` }),
  ]));
  wrap.appendChild(node('p', { className: 'pring-sub', text: card.subtitle }));
  if (card.kind === 'dag') wrap.appendChild(node('p', { className: 'pring-usage', attrs: { 'data-ring-usage': '' }, text: card.usageText }));
  if (card.emptyReason) wrap.appendChild(node('p', { className: 'hint', text: card.emptyReason }));
  wrap.appendChild(buildProgressRing(card, { selectedId: chosen?.id || '', onPick }));
  let runDetail = null;
  const onRunDetail = card.kind === 'dag'
    ? sector => onDagDetail({ taskId: card.taskId, runId: card.runId, nodeId: sector.id })
    : () => {
      runDetail.hidden = !runDetail.hidden;
      if (runDetail.hidden) runDetail.setAttribute('hidden', ''); else runDetail.removeAttribute?.('hidden');
    };
  wrap.appendChild(buildRingNodePanel(chosen, card, { onRunDetail }));
  if (card.kind === 'serial') { runDetail = buildSerialRunDetail(card); wrap.appendChild(runDetail); }
  wrap.appendChild(chipsLine(card.chips, 'pring-counts'));
  if (card.projectChips?.length) wrap.appendChild(chipsLine(card.projectChips, 'pring-project-usage'));
  if (card.capacityNote) wrap.appendChild(node('p', { className: 'pring-note', text: card.capacityNote }));
  return wrap;
}

// 「已归档的任务环」：折叠区（标题 · 数量 · 全部完成 X · 已取消 Y），展开后按项目分组，每个任务同款环。
export function buildArchivedRingSection(archived, { isOpen = false, onToggle = () => {}, selection = new Map(), onPick = () => {}, onRetry = null } = {}) {
  const section = node('section', { className: 'pring-archived', attrs: { 'data-archived-rings': '' } });
  if (archived.error) {
    section.appendChild(node('p', { className: 'hint', attrs: { 'data-archive-error': '' }, text: archived.error }));
    if (onRetry) {
      const retry = node('button', { className: 'core-action', text: '重试', attrs: { type: 'button', 'data-archive-retry': '' } });
      retry.addEventListener('click', onRetry);
      section.appendChild(retry);
    }
  }
  const toggle = node('button', { className: 'pring-archived-toggle', attrs: { type: 'button', 'aria-expanded': String(isOpen), 'data-archived-toggle': '' } }, [
    node('span', { className: 'pring-archived-title', text: archived.title }),
    node('span', { className: 'pring-badge', attrs: { 'data-archived-count': '' }, text: String(archived.count) }),
    node('span', { className: 'pring-archived-sub', attrs: { 'data-archived-summary': '' }, text: archived.summary }),
  ]);
  if (archived.scope) toggle.appendChild(node('span', { className: 'pring-archived-scope', text: archived.scope }));
  const body = node('div', { className: 'pring-archived-body', attrs: isOpen ? {} : { hidden: '' } });
  if (!isOpen) body.hidden = true;
  toggle.addEventListener('click', () => onToggle(!isOpen));
  if (isOpen) {
    if (archived.empty) body.appendChild(node('p', { className: 'hint', text: archived.empty }));
    for (const group of archived.groups) {
      const box = node('div', { className: 'pring-archived-group' });
      if (group.name) box.appendChild(node('div', { className: 'pring-archived-group-name', text: group.name }));
      for (const item of group.items) {
        const picked = selection.get(item.key) || '';
        const row = node('article', { className: 'pring-archived-row', attrs: { 'data-archived-ring': item.key } }, [
          node('div', { className: 'pring-head' }, [
            node('strong', { className: 'pring-title', text: item.title }),
            node('span', { className: `pring-badge ${item.reason.kind}`.trim(), text: item.reason.label }),
            node('span', { className: 'pring-pct', text: `${item.percent}%` }),
          ]),
          node('p', { className: 'pring-sub', text: item.source }),
          node('p', { className: 'pring-sub', attrs: { 'data-archive-usage': '' }, text: item.usageText }),
          node('p', { className: 'pring-sub', attrs: { 'data-archive-times': '' }, text: item.times }),
        ]);
        if (item.note) row.appendChild(node('p', { className: 'hint', text: item.note }));
        row.appendChild(buildProgressRing(item, { selectedId: picked, onPick: id => onPick(item.key, id) }));
        const sector = item.nodes.find(n => n.id === picked);
        if (sector) row.appendChild(buildRingNodePanel(sector, item));
        box.appendChild(row);
      }
      body.appendChild(box);
    }
  }
  section.append(toggle, body);
  return section;
}

function makeSection(container, key, title) {
  const card = node('section', { className: 'card core-section', attrs: { 'data-core-section': key } }, [
    node('h3', { text: title }),
  ]);
  const body = node('div', { className: 'core-section-body' });
  card.appendChild(body);
  container.appendChild(card);
  return body;
}

function makeBanner(container, onRetry) {
  const banner = node('div', { className: 'core-banner', attrs: { hidden: '' } });
  const message = node('span', { className: 'core-banner-text' });
  const retry = node('button', { type: 'button', className: 'core-retry', text: '重试' });
  retry.addEventListener('click', () => { void onRetry(); });
  banner.append(message, retry);
  container.appendChild(banner);
  return {
    show(text) { message.textContent = String(text || '读取失败'); banner.hidden = false; },
    clear() { banner.hidden = true; message.textContent = ''; },
  };
}

function renderCollection(container, collection, itemNode) {
  container.replaceChildren();
  if (!collection || collection.empty) {
    container.appendChild(node('p', { className: 'hint', text: collection?.reason || '暂无数据' }));
    return;
  }
  for (const item of collection.items) container.appendChild(itemNode(item));
}

const LABELS = { run: '运行', pause: '暂停', resume: '恢复' };
// 视图模型的 quickActions id → createSessionsWrite 的写方法；语义与网页版一致。
const CARD_QUICK_METHOD = Object.freeze({
  'mark-handled': 'markHandled',
  resolve: 'resolveCard',
  'delegate-return': 'delegateCard',
});

/** 页面挂载点。ctx 含 client / state / hooks；跨页互调一律走 ctx.hooks。 */
export function mount(ctx) {
  if (typeof document === 'undefined') return;
  const modelPromise = loadViewModel();
  const filterPromise = loadFilterModel();
  if (!modelPromise || !filterPromise) return;

  const drafts = new Map();
  const refs = {};
  const banners = [];

  const overviewEl = document.getElementById('page-core');
  const rulesEl = document.getElementById('page-rules');
  const runsEl = document.getElementById('page-rounds');
  const todosEl = document.getElementById('page-todos');
  if (!overviewEl || !rulesEl || !runsEl || !todosEl) return;

  let reload = () => {};
  banners.push(makeBanner(overviewEl, () => reload()));
  banners.push(makeBanner(rulesEl, () => reload()));
  banners.push(makeBanner(runsEl, () => reload()));
  banners.push(makeBanner(todosEl, () => reload()));

  refs.usage = makeSection(overviewEl, 'usage', '今日用量');
  refs.metrics = makeSection(overviewEl, 'metrics', '任务概览');
  refs.projects = makeSection(overviewEl, 'projects', '项目任务进度');
  refs.activity = makeSection(overviewEl, 'activity', '最近动态');
  refs.rules = makeSection(rulesEl, 'rules', '调度规则');
  refs.runs = makeSection(runsEl, 'runs', '执行轮次');
  refs.todos = makeSection(todosEl, 'todos', '待我处理');
  refs.authorize = makeSection(todosEl, 'authorize', '执行授权');

  let write = null;
  // 三操作的写客户端按需加载；只解析一次，失败留给按钮点击时就地报错，不阻塞回答链路。
  let cardWritePromise = null;
  const getCardWrite = () => {
    if (!cardWritePromise) {
      cardWritePromise = loadCardWrite()
        .then(model => (model && typeof model.createSessionsWrite === 'function' ? model.createSessionsWrite(ctx.client) : null))
        .catch(() => null);
    }
    return cardWritePromise;
  };
  // 退回调度成功的提示放在待办页容器上：renderCurrent 只重建各 section body，不碰这里，
  // 所以卡片离开待办后提示仍在，满足「已退回调度，等待代理结论」的可见性。
  const quickNotice = node('div', { className: 'hint', attrs: { 'data-card-quick-notice': '', hidden: '' } });
  todosEl.appendChild(quickNotice);
  // 本机刚回答成功的卡：Hub 状态重读前也不再显示（失败不进此集合，卡与选项原样保留）。
  const answeredIds = new Set();

  async function answer(item, payload, submit, errorNode) {
    submit.disabled = true;
    errorNode.hidden = true;
    try {
      await write.answerCard(item.id, payload);
      drafts.delete(item.id);
      // 回答成功即隐藏该卡并同步角标，不等重读往返；重读到 Hub 已结案后自然不再出现。
      answeredIds.add(String(item.id));
      renderCurrent();
      await reload();
    } catch (error) {
      errorNode.textContent = String(error?.message || '提交失败，请重试');
      errorNode.hidden = false;
      submit.disabled = false; // 失败保留草稿与选项，允许原样重试
    }
  }

  // 决策卡三内置操作：已处理/结案复用 resolve 端点、退回调度走 card-delegate 事务。
  // 成功沿用 fix4 闭环隐藏卡并刷新；失败就地报错、按钮复原，卡与选项原样保留可重试。
  async function quickAction(item, action, button, errorNode) {
    button.disabled = true;
    errorNode.hidden = true;
    quickNotice.hidden = true;
    try {
      const client = await getCardWrite();
      if (!client || typeof client[action.method] !== 'function') throw new Error('操作通道不可用，请刷新后重试');
      await client[action.method](item.id);
      drafts.delete(item.id);
      answeredIds.add(String(item.id));
      if (action.id === 'delegate-return') {
        quickNotice.textContent = `${item.title ? `${item.title}：` : ''}已退回调度，等待代理结论`;
        quickNotice.hidden = false;
      }
      renderCurrent();
      await reload();
    } catch (error) {
      errorNode.textContent = String(error?.message || '操作失败，请重试');
      errorNode.hidden = false;
      button.disabled = false;
    }
  }

  async function ruleAction(rule, action, button, errorNode) {
    button.disabled = true;
    errorNode.hidden = true;
    try {
      await write.ruleAction(rule.id, action);
      await reload();
    } catch (error) {
      errorNode.textContent = String(error?.message || '操作失败，请重试');
      errorNode.hidden = false;
      button.disabled = false;
    }
  }

  // 项目任务进度（fix6，2026-11-26 主人定）：与网页版同内容同形式——串行链与活跃并行 DAG 都是节点环，
  // 点扇区切换下方节点详情，底部费用汇总条；已归档任务收进「已归档的任务环」，展开后同款环。
  const ringSelection = new Map();
  const archivedSelection = new Map();
  let archivedOpen = false;

  function openDagDetail(detail) {
    const select = ctx.hooks?.selectTab || window.AutoloopNav?.selectTab;
    if (typeof select === 'function') select('dag');
    window.dispatchEvent(new CustomEvent('autoloop:dag-pick', { detail }));
  }

  function renderProjects(progress) {
    refs.projects.replaceChildren();
    if (!progress) {
      refs.projects.appendChild(node('p', { className: 'hint', text: '正在读取项目任务进度…' }));
      return;
    }
    if (progress.empty) refs.projects.appendChild(node('p', { className: 'hint', attrs: { 'data-ring-empty': '' }, text: progress.reason }));
    for (const card of progress.cards) {
      refs.projects.appendChild(buildProjectRingCard(card, {
        selectedId: ringSelection.get(card.key) || '',
        defaultId: card.defaultId || '',
        onPick: id => { ringSelection.set(card.key, id); renderCurrent(); },
        onDagDetail: openDagDetail,
      }));
    }
    if (!progress.archived.hidden) {
      refs.projects.appendChild(buildArchivedRingSection(progress.archived, {
        isOpen: archivedOpen,
        onToggle: open => { archivedOpen = open; renderCurrent(); },
        selection: archivedSelection,
        onPick: (key, id) => { archivedSelection.set(key, archivedSelection.get(key) === id ? '' : id); renderCurrent(); },
        onRetry: () => { void reload(); },
      }));
    }
  }

  function renderOverview(page) {
    refs.usage.replaceChildren(node('p', { className: 'core-usage', text: page.usage || '用量未上报' }));
    if (!page.ready && page.error) refs.usage.appendChild(node('p', { className: 'hint', text: page.error }));
    // 四组各自带网页版同款空态文案；待调度处理不等于待用户处理，不升级给用户。
    renderCollection(refs.metrics, page.metrics, group => {
      const box = node('div', { className: 'core-metric', attrs: { 'data-metric': group.id } }, [
        node('strong', { text: `${group.count} · ${group.label}` }),
      ]);
      if (group.titles?.length) {
        const list = node('ul', { className: 'core-list' });
        for (const title of group.titles) list.appendChild(node('li', { text: title }));
        box.appendChild(list);
      } else {
        box.appendChild(node('p', { className: 'hint', text: group.emptyReason || '暂无数据' }));
      }
      if (group.id === 'attention') box.appendChild(node('p', { className: 'hint', text: '调度方按契约自行处理，不升级给您' }));
      return box;
    });
    // 项目任务进度：串行链 + 活跃并行 DAG 同面板成环（fix6，与网页版同内容同口径）；视图模型未就绪时如实提示。
    renderProjects(page.projectProgress);
    renderCollection(refs.activity, page.activity, item => node('div', { className: 'core-item' }, [
      node('strong', { text: item.title }),
      node('span', { className: 'core-meta', text: [item.statusLabel, item.at].filter(Boolean).join(' · ') }),
    ]));
  }

  function renderRules(page) {
    renderCollection(refs.rules, page.items, rule => {
      const box = node('div', { className: 'core-card', attrs: { 'data-rule-name': rule.name } }, [
        node('strong', { text: rule.name }),
        node('p', { className: 'core-meta', text: [rule.projectLabel, rule.agentLabel || rule.agent, rule.trigger].filter(Boolean).join(' · ') }),
        node('p', { className: `core-status ${rule.statusKind || ''}`, text: rule.statusLabel }),
      ]);
      if (rule.statusDetail) box.appendChild(node('p', { className: 'hint', text: rule.statusDetail }));
      const errorNode = node('p', { className: 'status error', attrs: { hidden: '' } });
      const actions = node('div', { className: 'core-actions' });
      for (const action of ['run', 'pause', 'resume']) {
        if (!(rule.actions || []).includes(action)) continue;
        const button = node('button', {
          type: 'button', className: 'core-action', attrs: { 'data-rule-action': action }, text: LABELS[action],
        });
        // 规则状态未知或整页数据缺失时禁用，不把「未就绪」伪装成可执行。
        const ready = page.ready && rule.statusKnown !== false;
        button.disabled = !ready;
        if (!ready) button.title = rule.statusDetail || '规则状态未知，暂不可操作';
        button.addEventListener('click', () => { void ruleAction(rule, action, button, errorNode); });
        actions.appendChild(button);
      }
      box.append(actions, errorNode);
      return box;
    });
  }

  function renderRuns(page) {
    renderCollection(refs.runs, page.items, run => {
      const box = node('div', { className: 'core-card', attrs: { 'data-run-id': run.id ?? '' } }, [
        node('strong', { text: run.taskSummary }),
        node('p', { className: 'core-meta', text: `${run.statusLabel || '状态未知'} · ${run.taskNumber || ''}` }),
        node('p', { className: 'core-meta', text: [run.projectLabel, run.agent, `模型 ${run.model || '未配置'}`].filter(Boolean).join(' · ') }),
        node('p', { className: 'core-meta', text: `${run.billing || '费用未上报'} · ${run.attempts} 次尝试` }),
      ]);
      if (run.sessionLink) box.appendChild(node('p', { className: 'hint', text: `会话 ${run.sessionLink}` }));
      return box;
    });
  }

  function renderTodos(page) {
    renderCollection(refs.todos, page.items, item => {
      const box = node('div', { className: 'core-card', attrs: { 'data-card-id': item.id ?? '' } }, [
        node('strong', { text: item.title }),
      ]);
      if (item.text) box.appendChild(node('p', { className: 'core-card-text', text: item.text }));
      box.appendChild(node('p', {
        className: 'core-meta',
        text: [item.stateLabel, item.sourceLabel, item.projectLabel, item.rule, item.createdAt].filter(Boolean).join(' · '),
      }));
      if (item.readOnly) {
        box.appendChild(node('p', { className: 'core-answer', text: `已回答：${item.choice ?? ''}` }));
        return box;
      }
      const errorNode = node('p', { className: 'status error', attrs: { 'data-card-error': '', hidden: '' } });
      const choices = node('div', { className: 'core-choices' });
      let selected = null;
      (item.options || []).forEach((option, index) => {
        const choice = node('button', {
          type: 'button', className: 'core-choice',
          attrs: { 'data-card-option': String(index), 'aria-pressed': 'false' }, text: option,
        });
        choice.addEventListener('click', () => {
          selected = index;
          for (const sibling of choices.children) sibling.setAttribute('aria-pressed', String(sibling === choice));
          errorNode.hidden = true;
        });
        choices.appendChild(choice);
      });
      if (choices.childElementCount) box.appendChild(choices);
      const textarea = node('textarea', {
        className: 'core-answer-text',
        attrs: { 'data-card-text': '', rows: '2', placeholder: '或直接输入文字回答' },
      });
      textarea.value = drafts.get(item.id) || '';
      textarea.addEventListener('input', () => { drafts.set(item.id, textarea.value); errorNode.hidden = true; });
      const submit = node('button', {
        type: 'button', className: 'core-action primary',
        attrs: { 'data-card-submit': '' }, text: '提交回答',
      });
      submit.addEventListener('click', () => {
        const text = drafts.get(item.id) || '';
        if (selected === null && !text.trim()) {
          errorNode.textContent = '请选择一项或输入文字回答';
          errorNode.hidden = false;
          return;
        }
        void answer(item, selected === null ? { text } : { choice: selected }, submit, errorNode);
      });
      box.append(textarea, submit, errorNode);
      // 三内置操作：每张决策卡都渲染，顺序取视图模型 quickActions（已处理/结案/退回调度）。
      const quick = node('div', { className: 'core-actions' });
      for (const action of item.quickActions || []) {
        const method = CARD_QUICK_METHOD[action.id];
        if (!method) continue;
        const button = node('button', {
          type: 'button', className: 'core-action',
          attrs: { 'data-card-quick': action.id }, text: action.label,
        });
        button.addEventListener('click', () => { void quickAction(item, { ...action, method }, button, errorNode); });
        quick.appendChild(button);
      }
      if (quick.childElementCount) box.appendChild(quick);
      return box;
    });
  }

  function renderAuthorize(page) {
    renderCollection(refs.authorize, page.items, item => {
      const box = node('div', { className: 'core-card', attrs: { 'data-run-id': item.runId ?? '' } }, [
        node('strong', { text: `${item.projectLabel || '未识别项目'} · ${item.statusLabel || '状态未知'}` }),
        node('p', { className: 'core-meta', text: `项目 ${item.planId || '未识别'} · ${item.nodeCount} 个节点` }),
        node('p', { className: 'core-meta', text: `远端 ${item.remoteUrl || '未发现远端（不能推送）'}` }),
      ]);
      if (item.planDigest) box.appendChild(node('p', { className: 'core-meta', text: `计划摘要 ${item.planDigest}` }));
      if (!item.scope.empty) {
        const scope = node('ul', { className: 'core-list' });
        for (const entry of item.scope.items) {
          scope.appendChild(node('li', { text: `${entry.label}：${(entry.values || []).join('、') || '无'}` }));
        }
        box.appendChild(scope);
      } else {
        box.appendChild(node('p', { className: 'hint', text: item.scope.reason }));
      }
      for (const file of item.files || []) box.appendChild(node('p', { className: 'core-meta', text: `文件 ${file}` }));
      box.appendChild(node('p', { className: 'hint', text: item.boundary }));
      return box;
    });
  }

  let fullSnapshot = null;
  let activeFilter = ctx.hooks?.projectFilter?.current?.() || null;
  let coreModel = null;
  let filterModel = null;

  function filteredSnapshot() {
    if (!fullSnapshot || !activeFilter || activeFilter.isAll || !filterModel) return fullSnapshot;
    const filter = activeFilter;
    const byProject = filterModel.filterByProject;
    const rules = fullSnapshot.rules ? {
      ...fullSnapshot.rules,
      rules: byProject(fullSnapshot.rules.rules || [], filter, item => item?.cwd),
      mobileRules: byProject(fullSnapshot.rules.mobileRules || [], filter),
    } : null;
    const projectByRule = new Map();
    for (const rule of fullSnapshot.rules?.mobileRules || []) projectByRule.set(rule.name, rule.project);
    for (const rule of fullSnapshot.rules?.rules || []) projectByRule.set(rule.name, rule.cwd);
    const state = fullSnapshot.state ? {
      ...fullSnapshot.state,
      runs: byProject(fullSnapshot.state.runs || [], filter, item => item?.project || item?.cwd),
      cards: byProject(fullSnapshot.state.cards || [], filter, item => item?.project || item?.cwd),
      lines: byProject(fullSnapshot.state.lines || [], filter, item => projectByRule.get(item?.name) || ''),
    } : null;
    return {
      ...fullSnapshot,
      rules, state,
      projects: byProject(fullSnapshot.projects || [], filter, item => item?.path || item?.id),
      dagRuns: byProject(fullSnapshot.dagRuns || [], filter),
      serial: fullSnapshot.serial ? { ...fullSnapshot.serial, chains: byProject(fullSnapshot.serial.chains || [], filter) } : fullSnapshot.serial,
      archive: Array.isArray(fullSnapshot.archive) ? byProject(fullSnapshot.archive, filter) : fullSnapshot.archive,
    };
  }

  function renderCurrent() {
    if (!fullSnapshot || !coreModel) return;
    // 已确认离开 open 的卡移出隐藏集合，集合不无限增长。
    const openIds = new Set((fullSnapshot.state?.cards || []).filter(card => card?.state === 'open').map(card => String(card.id)));
    for (const id of answeredIds) if (!openIds.has(id)) answeredIds.delete(id);
    const projectScope = activeFilter && !activeFilter.isAll ? String(activeFilter.selectedLabel || activeFilter.selectedId || '') : '';
    const pages = coreModel.buildPages(filteredSnapshot(), { hiddenIds: answeredIds, projectScope });
    renderOverview(pages.overview);
    renderRules(pages.rules);
    renderRuns(pages.runs);
    renderTodos(pages.todos);
    renderAuthorize(pages.authorize);
    const open = (pages.todos?.items?.items || []).filter(item => item.state === 'open').length;
    ctx.hooks?.notify?.setBadge?.(open);
  }
  ctx.hooks?.projectFilter?.onChange?.(filter => { activeFilter = filter; renderCurrent(); });
  filterPromise.then(model => { filterModel = model; renderCurrent(); });

  async function load() {
    try {
      const model = await modelPromise;
      if (!model) return;
      coreModel = model;
      if (!write) write = model.createCoreWrite(ctx.client);
      const core = model.createMobileCore({ api: key => ctx.client.api(key) });
      const { snapshot } = await core.load();
      // 归档详情单独读取（snapshot 装配不含 archive）；失败只标记缺失，不影响其他页面。
      let archive = null;
      let archiveError = null;
      try {
        const data = await ctx.client.api('archive');
        if (data && Array.isArray(data.archived)) archive = data.archived;
        else archiveError = '归档数据缺失，未读取到已归档任务';
      } catch (error) { archiveError = String(error?.message || error || '读取失败'); }
      // 项目今日/累计用量（与网页 /api/project-usage 同源）：读取失败只在费用条如实标注。
      let projectUsage = null;
      try {
        const data = await ctx.client.api('project-usage');
        if (data && Array.isArray(data.projects)) projectUsage = data;
      } catch { projectUsage = null; }
      fullSnapshot = {
        ...snapshot,
        available: { ...snapshot.available, archive: archive !== null, 'project-usage': projectUsage !== null },
        errors: archiveError ? { ...snapshot.errors, archive: archiveError } : snapshot.errors,
        archive, projectUsage,
      };
      renderCurrent();
      for (const banner of banners) banner.clear();
    } catch (error) {
      const message = `读取失败：${error?.message || error}（点「重试」再试）`;
      for (const banner of banners) banner.show(message);
    }
  }
  reload = load;

  // 锁屏期间不拉数据；主界面一显示就加载，之后断网重连也会重新拉取。
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
}
