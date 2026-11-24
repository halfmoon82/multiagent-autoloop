// 会话页：把 sessions / question-group 的只读视图模型接到 App 壳。
// 页面只改 #page-sessions 容器，跨页互调走 ctx.hooks；所有上游文本用 textContent 渲染，不拼接 HTML。
// 视图模型经相对路径 ../src/... 加载（受限静态服务 /mobile/src/）；Node 下不装配 DOM。
import { renderIcons } from '../icons.mjs';

const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/sessions/index.mjs');
const loadQuestionModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/question-group/index.mjs');

const loadAutogrow = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/composer-autogrow/index.mjs');

// 通知接线：点击通知打开具体会话（takePendingSession / open-session），进出详情登记正在看的会话（setActiveSession）。
const loadNotifyModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/notifications/index.mjs');
const OPEN_SESSION_EVENT_NAME = 'autoloop:open-session';

export { loadViewModel };

const CONTEXT_KEY = 'nomoto-sessions-context';

const node = (tag, { className, text, attrs = {} } = {}, children = []) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  for (const child of children) if (child) element.appendChild(child);
  return element;
};

/** 页面挂载点。ctx 含 client / state / hooks。 */
export function mount(ctx) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('page-sessions');
  if (!host) return;

  const modelPromise = Promise.all([loadViewModel(), loadQuestionModel()]);
  const notifyPromise = loadNotifyModel().catch(() => null);
  // 正在看的会话：只有会话页可见且停在详情时才算，其余一律清空（切 Tab、返回列表、进设置页）。
  const syncActiveSession = () => {
    const id = !host.hidden && state.view === 'detail' ? state.detailSessionId : null;
    void notifyPromise.then(nmodel => { nmodel?.setActiveSession?.(window, id); });
  };
  // 自动长高模块与视图模型并行加载；到位前输入框保持 CSS 最小高度，到位后统一接管。
  let autogrow = null;
  const growers = [];
  // 主区高度：详情页以消息+输入栏所在视图为准，其余取可视视口。
  const mainHeight = () => (typeof window.visualViewport?.height === 'number' ? window.visualViewport.height : window.innerHeight);
  const grow = el => {
    if (!autogrow || !el) return;
    growers.push(autogrow.attachAutogrow(el, { getMainHeight: mainHeight }));
  };
  const regrow = () => { for (const item of growers) item.refresh(); };
  const growLater = el => { void loadAutogrow().then(module => { autogrow = module; grow(el); }); };
  let smodel = null;
  let qmodel = null;
  let reader = null;
  let write = null;
  let reload = () => {};
  let pendingOpener = null;

  const state = {
    kind: 'all', query: '', archivedExpanded: false, error: '',
    view: 'list', session: null, group: null, messages: [],
    follow: true, listScroll: 0, promptExpanded: false,
    drafts: { composer: '', question: '' },
    projects: [], cards: [], newPrompt: '', selectedKind: null, classification: null,
    list: null, rawArchives: [], menuText: '',
  };

  // 切页/旋转后恢复草稿、滚动与进度；仅存纯数据，不写凭据。
  try {
    const saved = JSON.parse(typeof sessionStorage !== 'undefined' ? (sessionStorage.getItem(CONTEXT_KEY) || 'null') : 'null');
    if (saved && typeof saved === 'object') {
      state.kind = saved.kind || 'all';
      state.query = saved.query || '';
      state.archivedExpanded = saved.archivedExpanded === true;
      state.listScroll = Number(saved.listScroll) || 0;
      state.drafts = { composer: String(saved.drafts?.composer || ''), question: String(saved.drafts?.question || '') };
      state.savedGroup = saved.group || null;
      state.savedSessionId = saved.sessionId || null;
    }
  } catch { /* 存储损坏时按初态处理，不阻断页面 */ }

  const saveContext = () => {
    try {
      if (typeof sessionStorage === 'undefined') return;
      const payload = {
        kind: state.kind, query: state.query, archivedExpanded: state.archivedExpanded,
        listScroll: state.listScroll,
        drafts: state.drafts, sessionId: state.session?.id || null,
        group: qmodel && state.group ? qmodel.snapshotGroup(state.group) : null,
      };
      sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(payload));
    } catch { /* 隐私模式下不可用也不影响使用 */ }
  };

  // ---- 固定骨架：后续只更新内部节点，不整块重建 ----
  const banner = node('div', { className: 'sessions-banner', attrs: { hidden: '' } }, [
    node('span', { className: 'sessions-banner-text' }),
  ]);
  const bannerRetry = node('button', { type: 'button', className: 'sessions-retry', text: '重试' });
  bannerRetry.addEventListener('click', () => { void reload(); });
  banner.appendChild(bannerRetry);

  const heading = node('div', { className: 'page-heading sessions-heading' }, [
    node('p', { className: 'eyebrow', text: 'SESSIONS' }),
    node('h1', { className: 'page-title', text: '会话管理' }),
    node('p', { className: 'page-subtitle', text: '对话、调度与 PRD 设计，各就其位。' }),
  ]);
  const newButton = node('button', { type: 'button', className: 'sessions-new-btn primary-btn full-btn', text: '＋ 新建会话' });
  const searchInput = node('input', {
    className: 'sessions-search',
    attrs: { type: 'search', placeholder: '搜索会话', 'aria-label': '搜索会话' },
  });
  const searchRow = node('div', { className: 'sessions-search-box search-box' }, [
    node('span', { className: 'search-icon', attrs: { 'data-icon': 'search', 'aria-hidden': 'true' } }),
    searchInput,
  ]);
  const filters = node('div', { className: 'sessions-filters filter-rail' });
  const currentBox = node('div', { className: 'sessions-current' });
  const listBox = node('div', { className: 'sessions-items' });
  const archivedToggle = node('button', { type: 'button', className: 'sessions-archived-toggle' });
  const archivedBox = node('div', { className: 'sessions-archived-list', attrs: { hidden: '' } });
  const listView = node('section', { className: 'sessions-view', attrs: { 'data-view': 'list' } }, [
    heading, newButton, searchRow, filters, currentBox, listBox, archivedToggle, archivedBox,
  ]);

  const detailTitle = node('strong', { className: 'sessions-detail-title' });
  const detailMeta = node('span', { className: 'sessions-detail-meta' });
  const detailPrompt = node('button', { type: 'button', className: 'sessions-detail-prompt', attrs: { hidden: '' } });
  const artifactsBtn = node('button', { type: 'button', className: 'sessions-artifacts-btn' }, [
    node('span', { attrs: { 'data-icon': 'file', 'aria-hidden': 'true' } }),
    node('span', { text: '产物' }),
  ]);
  const detailBack = node('button', { type: 'button', className: 'sessions-back icon-btn', attrs: { 'aria-label': '返回会话列表' } }, [
    node('span', { attrs: { 'data-icon': 'back', 'aria-hidden': 'true' } }),
  ]);
  const detailHero = node('div', { className: 'sessions-detail-hero' }, [
    detailBack,
    node('div', { className: 'sessions-detail-title-block' }, [detailTitle, detailMeta]),
    artifactsBtn,
  ]);
  const detailContext = node('div', { className: 'sessions-context-bar' });
  const infoToggle = node('button', { type: 'button', className: 'sessions-info-toggle', text: '会话详情', attrs: { 'aria-expanded': 'false' } });
  const queueToggle = node('button', { type: 'button', className: 'sessions-queue-toggle', attrs: { 'aria-expanded': 'false' } });
  const sessionTools = node('div', { className: 'sessions-tools' }, [infoToggle, queueToggle]);
  const infoPanel = node('div', { className: 'sessions-info-panel', attrs: { hidden: '' } }, [detailPrompt]);
  const queuePanel = node('div', { className: 'sessions-queue-panel', attrs: { hidden: '' } });
  const pendingStrip = node('button', { type: 'button', className: 'sessions-pending-strip', attrs: { hidden: '' } });
  pendingStrip.addEventListener('click', () => { questionBox.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  const questionBox = node('div', { className: 'sessions-question' });
  // 消息区：详情页 flex 列中唯一的滚动区（flex:1; min-height:0; overflow:auto），顶部与输入栏不随消息流滚走。
  const messageWindow = node('div', { className: 'sessions-message-window' });
  const backBottom = node('button', { type: 'button', className: 'sessions-back-bottom', text: '回到底部 ↓', attrs: { hidden: '' } });
  const composerInput = node('textarea', {
    className: 'sessions-composer-input',
    attrs: { rows: '2', placeholder: '继续补充，或使用语音…', 'aria-label': '输入回答或消息', enterkeyhint: 'send' },
  });
  const micBtn = node('button', { type: 'button', className: 'sessions-mic mic-btn', attrs: { 'aria-label': '语音输入', hidden: '' } }, [
    node('span', { attrs: { 'data-icon': 'mic', 'aria-hidden': 'true' } }),
  ]);
  const composerSend = node('button', { type: 'button', className: 'sessions-send send-btn', attrs: { disabled: '', 'aria-label': '发送' } }, [
    node('span', { attrs: { 'data-icon': 'send', 'aria-hidden': 'true' } }),
  ]);
  const steerBtn = node('button', { type: 'button', className: 'sessions-steer-btn', text: '打断', attrs: { hidden: '', title: '打断当前轮并立即发送（steer）', 'aria-label': '打断当前轮并立即发送' } });
  const sendMode = node('span', { className: 'sessions-send-mode', attrs: { hidden: '' } });
  const attachmentInput = node('input', { className: 'sessions-attachment-input', attrs: { type: 'file', hidden: '', multiple: '', accept: 'image/*,text/*,.md,.json,.mjs,.js,.ts,.css,.html,.csv,.yaml,.yml,.xml,.log,.pdf' } });
  const attachBtn = node('button', { type: 'button', className: 'sessions-attach-btn', attrs: { 'aria-label': '添加附件', title: '添加文件或图片附件' } }, [
    node('span', { attrs: { 'data-icon': 'plus', 'aria-hidden': 'true' } }),
  ]);
  const attachmentList = node('div', { className: 'sessions-attachments' });
  // + 附件按钮与发送键同组放在输入框之后：窄屏下输入框优先占宽，+ 不再被挤到独占一行。
  const composerRow = node('div', { className: 'sessions-composer' }, [
    sendMode, composerInput, micBtn, steerBtn, attachBtn, composerSend,
  ]);
  const queuePreview = node('div', { className: 'sessions-queue-preview', attrs: { hidden: '' } });
  const detailTop = node('div', { className: 'sessions-detail-top' }, [
    detailHero, detailContext, sessionTools, infoPanel, queuePanel, pendingStrip,
  ]);
  const detailView = node('section', { className: 'sessions-view', attrs: { 'data-view': 'detail', hidden: '' } }, [
    detailTop, messageWindow, backBottom, queuePreview, attachmentInput, attachmentList, composerRow,
  ]);

  const archiveBody = node('div', { className: 'sessions-archive-body' });
  const archiveRestore = node('button', { type: 'button', className: 'sessions-restore primary', text: '继续调度 · 新建会话' });
  const archiveBack = node('button', { type: 'button', className: 'sessions-back', text: '‹ 会话列表' });
  const archiveView = node('section', { className: 'sessions-view', attrs: { 'data-view': 'archive', hidden: '' } }, [
    archiveBack, archiveBody, archiveRestore,
  ]);

  const newProjects = node('select', { className: 'sessions-project-select', attrs: { 'aria-label': '项目工作区' } });
  const newPrompt = node('textarea', {
    className: 'sessions-new-prompt',
    attrs: { rows: '2', placeholder: '例如：设计移动端控制台并拆解产品需求…', 'aria-label': '首轮提示词' },
  });
  const newMic = node('button', { type: 'button', className: 'sessions-mic sessions-new-mic mic-btn', attrs: { 'aria-label': '语音输入', hidden: '' } }, [node('span', { attrs: { 'data-icon': 'mic', 'aria-hidden': 'true' } })]);
  const newPromptRow = node('div', { className: 'sessions-new-prompt-row' }, [newPrompt, newMic]);
  const newKinds = node('div', { className: 'sessions-new-kinds' });
  const newRecommend = node('p', { className: 'hint sessions-recommend' });
  const newSubmit = node('button', { type: 'button', className: 'primary sessions-new-submit', text: '创建并发送首轮' });
  const newView = node('section', { className: 'sessions-view', attrs: { 'data-view': 'new', hidden: '' } }, [
    node('button', { type: 'button', className: 'sessions-back', text: '‹ 会话列表' }),
    node('div', { className: 'page-heading sessions-new-heading' }, [
      node('p', { className: 'eyebrow', text: 'NEW SESSION' }),
      node('h1', { className: 'page-title', text: '您想做什么？' }),
      node('p', { className: 'page-subtitle', text: '输入第一句话，系统会推荐会话类型，您也可以手动更改。' }),
    ]),
    newProjects, newPromptRow, newRecommend, newKinds, newSubmit,
  ]);

  const menuCopy = node('button', { type: 'button', text: '复制' });
  const menu = node('div', { className: 'sessions-menu', attrs: { hidden: '' } }, [menuCopy]);
  host.replaceChildren(banner, listView, detailView, archiveView, newView, menu);
  renderIcons(host);

  const views = { list: listView, detail: detailView, archive: archiveView, new: newView };
  let detailTimer = null;
  // 详情跟随/滚底基于消息窗自身滚动。
  const pageMetrics = () => ({
    scrollTop: messageWindow.scrollTop,
    scrollHeight: messageWindow.scrollHeight,
    clientHeight: messageWindow.clientHeight,
  });
  const scrollToBottom = behavior => messageWindow.scrollTo({ top: messageWindow.scrollHeight, behavior: behavior || 'auto' });

  // 悬浮底部：详情视图高度 = 可视视口（已扣软键盘）减去其顶部偏移，输入栏因此始终贴在键盘上方；
  // visualViewport 不可用时退回 CSS 的 100dvh 兜底。
  const fitDetail = () => {
    if (state.view !== 'detail') { detailView.style.height = ''; return; }
    const vv = window.visualViewport;
    if (!vv) { detailView.style.height = ''; return; }
    const top = Math.max(0, detailView.getBoundingClientRect().top);
    const bottomGap = Number.parseFloat(getComputedStyle(document.getElementById('app-main') || document.body).paddingBottom) || 0;
    const navHeight = document.getElementById('tab-bar')?.getBoundingClientRect().height || 0;
    detailView.style.height = `${Math.max(240, Math.floor(vv.height - top - bottomGap - navHeight))}px`;
  };
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => { fitDetail(); regrow(); });
  }
  window.addEventListener('resize', () => { fitDetail(); regrow(); });

  const showView = name => {
    state.view = name;
    if (name !== 'detail' && detailTimer) { clearInterval(detailTimer); detailTimer = null; }
    // 详情轮询只更新快照不重绘隐藏的列表；回到列表时按当前类型/搜索/项目筛选重建一次，不显示旧状态。
    if (name === 'list' && state.listStale) { state.listStale = false; applyFilters(); }
    if (name !== 'detail') syncActiveSession();
    for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
    host.classList.toggle('sessions-detail-open', name === 'detail'); // 详情页自己按视口定高，去掉页面底部留白
    if (name === 'detail') { window.scrollTo(0, 0); fitDetail(); }
    if (name === 'detail' && state.follow) scrollToBottom();
    regrow();
  };

  const showBanner = text => {
    banner.querySelector('.sessions-banner-text').textContent = String(text || '');
    banner.hidden = !text;
  };

  infoToggle.addEventListener('click', () => {
    infoPanel.hidden = !infoPanel.hidden;
    infoToggle.setAttribute('aria-expanded', String(!infoPanel.hidden));
    if (!infoPanel.hidden) renderPrompt(state.session);
  });
  queueToggle.addEventListener('click', () => {
    queuePanel.hidden = !queuePanel.hidden;
    queueToggle.setAttribute('aria-expanded', String(!queuePanel.hidden));
  });

  const goList = () => {
    if (typeof ctx.hooks?.popView === 'function' && state.view !== 'list') ctx.hooks.popView();
    showView('list');
    saveContext();
  };

  // ---- 列表 ----
  function sessionItem(item) {
    const status = item.status === 'running' ? 'active' : (item.status === 'idle' ? 'done' : 'neutral');
    const box = node('button', { type: 'button', className: 'sessions-item session-item', attrs: { 'data-session-id': item.id } }, [
      node('div', { className: 'item-top' }, [
        node('strong', { className: 'item-title', text: item.title || '会话' }),
        node('span', { className: 'status-chip', attrs: { 'data-status': status }, text: item.statusLabel || '状态未知' }),
      ]),
      node('span', { className: 'item-subtitle', text: [item.projectLabel, item.kindLabel].filter(Boolean).join(' · ') }),
      node('span', { className: 'item-description', text: [item.updatedLabel, item.queuedCount ? `${item.queuedCount} 条排队消息` : ''].filter(Boolean).join(' · ') }),
    ]);
    box.addEventListener('click', () => { void openSession(item); });
    return box;
  }

  function renderList(list) {
    if (!list) return;
    filters.replaceChildren(...list.kindFilter.options.map(option => {
      const chip = node('button', {
        type: 'button',
        className: `sessions-chip${option.id === list.kindFilter.selected ? ' active' : ''}`,
        attrs: { 'data-kind': option.id, 'aria-pressed': String(option.id === list.kindFilter.selected) },
        text: `${option.label.replace('会话', '')} ${(Array.isArray(state.snapshot?.sessions) ? state.snapshot.sessions : []).filter(item => option.id === 'all' || item.kind === option.id).length}`,
      });
      chip.addEventListener('click', () => { state.kind = option.id; saveContext(); applyFilters(); });
      return chip;
    }));

    currentBox.replaceChildren();
    if (list.current && !list.sessions.items.some(item => item.id === list.current.id)) {
      const open = node('button', { type: 'button', className: 'sessions-current-open', text: '进入会话 ›' });
      open.addEventListener('click', () => { void openSession(list.current); });
      currentBox.append(
        node('div', { className: 'sessions-current-card' }, [
          node('span', { className: 'sessions-eyebrow', text: '当前会话' }),
          node('strong', { text: list.current.title || '会话' }),
          node('span', { className: 'sessions-meta', text: [list.current.projectLabel, list.current.statusLabel, list.current.kindLabel, list.current.updatedLabel].filter(Boolean).join(' · ') }),
        ]),
        open,
      );
    }

    listBox.replaceChildren();
    if (list.sessions.empty) listBox.appendChild(node('p', { className: 'hint', text: list.sessions.reason || '暂无会话' }));
    else for (const item of list.sessions.items) listBox.appendChild(sessionItem(item));

    const archived = list.archived;
    archivedToggle.textContent = `已归档与历史 · ${archived.count || 0}${state.archivedExpanded ? ' ⌃' : ' ⌄'}`;
    archivedToggle.setAttribute('aria-expanded', String(state.archivedExpanded));
    archivedBox.hidden = !state.archivedExpanded;
    archivedBox.replaceChildren();
    if (state.archivedExpanded) {
      if (archived.empty) archivedBox.appendChild(node('p', { className: 'hint', text: archived.reason || '暂无已归档会话' }));
      else for (const record of archived.items) archivedBox.appendChild(archivedItem(record));
    }
    listView.scrollTop = state.listScroll;
  }

  function archivedItem(record) {
    const box = node('div', { className: 'sessions-archived-item', attrs: { 'data-archive-id': record.id } }, [
      node('strong', { text: record.title || record.shortId || String(record.id).slice(0, 8) }),
      node('span', { className: 'sessions-meta', text: [record.projectLabel, record.kindLabel, record.endStatusLabel, `${record.transcriptCount} 条转录`].filter(Boolean).join(' · ') }),
    ]);
    const view = node('button', { type: 'button', text: '查看' });
    view.addEventListener('click', () => {
      const raw = state.rawArchives.find(item => item?.id === record.id);
      void openArchive(raw || record);
    });
    const restore = node('button', { type: 'button', text: '继续调度' });
    restore.addEventListener('click', () => { void restoreArchive(record, restore); });
    const actions = node('div', { className: 'sessions-archived-actions' }, [view, restore]);
    if (record.restoreError) actions.appendChild(node('span', { className: 'status error', text: record.restoreError }));
    if (record.restoredTo) actions.appendChild(node('span', { className: 'sessions-meta', text: `已创建 ${record.restoredTo}` }));
    box.appendChild(actions);
    return box;
  }

  // ---- 会话详情与待回答组 ----
  async function openSession(session) {
    state.session = session;
    state.messages = smodel ? smodel.buildDetailMessages(session) : mapMessages(session);
    renderPrompt(session);
    state.follow = true;
    const cards = Array.isArray(state.cards) ? state.cards.filter(card => !card?.project || card.project === session.project) : [];
    state.group = qmodel ? qmodel.cardsToQuestionGroup(cards, { id: 'session-cards', sessionId: session.id }) : null;
    if (qmodel && state.savedGroup && state.savedSessionId === session.id) {
      state.group = qmodel.restoreGroup(state.savedGroup);
    }
    detailTitle.textContent = session.title || '会话';
    renderDetailMeta(session);
    showView('detail');
    renderQuestion();
    renderMessages();
    // 定位到底部必须发生在消息渲染之后：先滚后渲染会被新内容把位置顶回最上面。
    if (state.follow) scrollToBottom();
    if (typeof ctx.hooks?.pushView === 'function') ctx.hooks.pushView({ type: 'sessions', view: 'detail', id: session.id });
    state.detailSessionId = session.id;
    syncActiveSession();
    startDetailPolling();
    saveContext();
  }

  function renderDetailMeta(session) {
    detailMeta.textContent = [session?.kindLabel, session?.agent, session?.statusLabel].filter(Boolean).join(' · ');
    detailContext.textContent = `项目 ${session?.projectLabel || '未识别'} · 会话上下文`;
    const queue = Array.isArray(session?.queue) ? session.queue : [];
    queueToggle.textContent = `排队消息 ${queue.length}`;
    queueToggle.setAttribute('aria-expanded', String(!queuePanel.hidden));
    steerBtn.hidden = session?.busy !== true;
    sendMode.hidden = session?.busy !== true;
    sendMode.textContent = '当前正在执行：默认排队，点「打断」立即 steer';
    composerSend.setAttribute('aria-label', session?.busy === true ? '排队发送' : '发送');
    queuePreview.hidden = queue.length === 0;
    queuePreview.replaceChildren(...queue.map(item => {
      const chip = node('button', { type: 'button', className: 'queue-chip', text: `${item.id} · ${item.text}`, attrs: { title: '打开队列管理' } });
      chip.addEventListener('click', () => { queuePanel.hidden = false; queueToggle.setAttribute('aria-expanded', 'true'); });
      return chip;
    }));
    renderQueuePanel(session);
  }

  function renderQueuePanel(session) {
    const items = Array.isArray(session?.queue) ? session.queue : [];
    queuePanel.replaceChildren();
    const clear = node('button', { type: 'button', className: 'sessions-queue-clear', text: '清空队列', attrs: { disabled: items.length ? '' : 'disabled' } });
    clear.disabled = items.length === 0;
    clear.addEventListener('click', () => { void runQueueAction('clearQueued', null); });
    queuePanel.appendChild(node('div', { className: 'sessions-queue-head' }, [
      node('strong', { text: `排队消息 · ${items.length}` }), clear,
    ]));
    if (!items.length) {
      queuePanel.appendChild(node('p', { className: 'hint', text: '没有排队消息。忙碌时发送会默认加入队列。' }));
      return;
    }
    items.forEach((item, index) => {
      const input = node('textarea', { className: 'sessions-queue-input', attrs: { rows: '2', 'aria-label': `编辑排队消息 ${index + 1}` } });
      input.value = item.text;
      input.addEventListener('change', () => { void runQueueAction('updateQueued', item, { text: input.value }); });
      const up = node('button', { type: 'button', text: '上移', attrs: { 'aria-label': `上移第 ${index + 1} 条` } });
      up.disabled = index === 0;
      up.addEventListener('click', () => { void runQueueAction('moveQueued', item, { direction: 'up' }); });
      const down = node('button', { type: 'button', text: '下移', attrs: { 'aria-label': `下移第 ${index + 1} 条` } });
      down.disabled = index === items.length - 1;
      down.addEventListener('click', () => { void runQueueAction('moveQueued', item, { direction: 'down' }); });
      const steer = node('button', { type: 'button', className: 'sessions-queue-steer', text: '立即引导' });
      steer.addEventListener('click', () => { void runQueueAction('steerQueued', item); });
      const remove = node('button', { type: 'button', text: '删除' });
      remove.addEventListener('click', () => { void runQueueAction('removeQueued', item); });
      queuePanel.appendChild(node('div', { className: 'sessions-queue-item', attrs: { 'data-queue-id': item.id } }, [
        input,
        node('div', { className: 'sessions-queue-actions' }, [up, down, steer, remove]),
      ]));
    });
  }

  let pendingAttachments = [];
  function renderAttachments() {
    attachmentList.replaceChildren(...pendingAttachments.map((item, index) => {
      const chip = node('span', { className: 'sessions-attachment-chip' });
      if (item.type.startsWith('image/')) chip.appendChild(node('img', { className: 'sessions-attachment-image', attrs: { alt: `预览 ${item.name}`, src: `data:${item.type};base64,${item.dataBase64}` } }));
      chip.appendChild(node('span', { text: `${item.name} · ${Math.ceil(item.size / 1024)}KB` }));
      const remove = node('button', { type: 'button', text: '移除', attrs: { 'aria-label': `移除附件 ${item.name}` } });
      remove.addEventListener('click', () => { pendingAttachments.splice(index, 1); renderAttachments(); });
      chip.appendChild(remove);
      return chip;
    }));
  }
  function readAttachment(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`无法读取附件 ${file.name}`));
      reader.onload = () => resolve({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, dataBase64: String(reader.result).split(',')[1] || '' });
      reader.readAsDataURL(file);
    });
  }
  attachmentInput.addEventListener('change', async () => {
    try {
      showBanner('');
      const files = [...(attachmentInput.files || [])];
      if (pendingAttachments.length + files.length > 4) throw new Error('最多添加 4 个附件');
      for (const file of files) {
        if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} 超过 5MB`);
        pendingAttachments.push(await readAttachment(file));
      }
      attachmentInput.value = '';
      renderAttachments();
    } catch (error) {
      attachmentInput.value = '';
      showBanner(`添加附件失败：${error?.message || '请重试'}`);
    }
  });
  attachBtn.addEventListener('click', () => { attachmentInput.click(); });

  async function refreshSessionState() {
    await load({ quiet: true });
    const current = (state.snapshot?.sessions || []).find(item => item.id === state.detailSessionId);
    if (!current) return;
    state.session = current;
    renderDetailMeta(current);
  }

  async function runQueueAction(action, item, payload = {}) {
    if (!write || !state.detailSessionId) return;
    try {
      showBanner('');
      const id = state.detailSessionId;
      if (action === 'clearQueued') await write.clearQueued(id);
      else await write[action](id, item.id, payload);
      await refreshSessionState();
    } catch (error) {
      showBanner(`队列操作失败：${error?.message || '请重试'}`);
    }
  }

  // 提示词默认折叠成一行（不再钉在顶部挤压转录区），点按展开/收起全文。
  function renderPrompt(session) {
    const promptText = String(session?.prompt || '').trim();
    if (!promptText) { detailPrompt.hidden = true; return; }
    detailPrompt.hidden = false;
    detailPrompt.classList.toggle('expanded', state.promptExpanded === true);
    detailPrompt.textContent = state.promptExpanded
      ? `首轮提示词（点按收起）：\n${promptText}`
      : `首轮提示词：${promptText.slice(0, 60)}${promptText.length > 60 ? '…' : ''}（点按展开全文）`;
  }

  function mapMessages(session) {
    return Array.isArray(session?.messages)
      ? session.messages.map(message => ({
        role: message?.role === 'user' ? '主人' : '会话',
        text: String(message?.text ?? ''),
        at: String(message?.at ?? ''),
      }))
      : [];
  }

  // 详情打开期间轻轮询：会话有新输出时即时刷新，离开详情页即停。
  function startDetailPolling() {
    if (detailTimer) clearInterval(detailTimer);
    // 自适应：会话在跑（等回复）时 1.5s 一拍，空闲时 5s 一拍；每拍只读一个轻接口。
    let lastTickAt = 0;
    detailTimer = setInterval(() => {
      if (state.view !== 'detail' || !state.detailSessionId || refreshing) return;
      const current = (state.snapshot?.sessions || []).find(item => item.id === state.detailSessionId);
      const waiting = state.awaitingUntil > Date.now() || (smodel ? smodel.isAwaitingReply(current) : false);
      const nowMs = Date.now();
      if (!waiting && nowMs - lastTickAt < 5000) return;
      lastTickAt = nowMs;
      void refreshDetail();
    }, 1500);
  }

  // 在途闸：上一拍没回来就不发下一拍，避免慢隧道下请求叠加、旧结果覆盖新结果。
  let refreshing = false;
  async function refreshDetail() {
    if (refreshing) return;
    refreshing = true;
    try {
      // 轻量刷新：只重读活跃会话（回复就在这里）。整页 load 要串行打 projects/state/sessions/archives
      // 四次隧道往返并重绘列表；列表在详情页被隐藏，回到列表时再按当前筛选重绘（见 showView）。
      if (reader && state.lastResult) {
        const result = await reader.refreshActive(state.lastResult, { kind: state.kind, query: state.query });
        state.lastResult = result;
        state.snapshot = result.snapshot;
        state.rawArchives = result.rawArchives;
        // 不直接采用 result.list：它没有全局项目筛选。返回列表时由 applyFilters 重建（见 showView）。
        state.listStale = true;
      } else await load({ quiet: true });
      const session = (state.snapshot?.sessions || []).find(item => item.id === state.detailSessionId);
      if (!session) return;
      if (smodel?.isAwaitingReply(session)) state.awaitingUntil = 0; // 服务端已确认在跑，交给状态判断
      const messages = smodel ? smodel.buildDetailMessages(session, state.messages) : mapMessages(session);
      if (JSON.stringify(messages) !== JSON.stringify(state.messages)) {
        // 跟随状态以更新瞬间的实测位置为准，不信任可能滞后的 state.follow：
        // 追新只滚底（用户在底部附近），用户上翻阅读时原样保持滚动位置。
        const followNow = !smodel || smodel.shouldFollowScroll(pageMetrics());
        state.follow = followNow;
        const keepScroll = followNow ? null : messageWindow.scrollTop;
        state.messages = messages;
        renderMessages();
        if (followNow) scrollToBottom();
        else messageWindow.scrollTop = keepScroll;
      }
      state.session = session;
      detailTitle.textContent = session.title || '会话';
      renderDetailMeta(session);
    } catch { /* 轮询静默失败，等下一轮 */ } finally { refreshing = false; }
  }

  function renderQuestion() {
    questionBox.replaceChildren();
    pendingStrip.hidden = true;
    if (!qmodel || !state.group || !state.group.questions.length) {
      // 普通会话不使用 Hub 问题卡片；没有真实问题时保持干净，不显示误导性的空问题提示。
      questionBox.hidden = true;
      return;
    }
    questionBox.hidden = false;
    const binding = qmodel.buildQuestionGroupBinding(state.group);
    const remaining = Math.max(0, binding.total - binding.answeredCount);
    pendingStrip.hidden = remaining === 0;
    if (remaining > 0) pendingStrip.textContent = `还有 ${remaining} 个问题待回答 · 立即定位`;
    const track = node('div', { className: 'sessions-progress-track', attrs: { role: 'progressbar', 'aria-valuenow': binding.percent } });
    for (let i = 0; i < binding.total; i += 1) {
      track.appendChild(node('span', { className: i < binding.answeredCount ? 'done' : '' }));
    }
    questionBox.appendChild(node('div', { className: 'sessions-progress' }, [
      node('strong', { text: `需要您的回答 · ${binding.answeredCount}/${binding.total}` }),
      track,
    ]));

    if (binding.active) {
      const active = binding.active;
      const card = node('div', { className: 'sessions-question-card' }, [
        node('span', { className: 'sessions-question-count', text: `问题 ${binding.answeredCount + 1} / ${binding.total} · ${active.kindLabel}` }),
        node('h3', { text: active.prompt }),
      ]);
      if (active.state === 'failed') card.appendChild(node('p', { className: 'status error', text: active.error || '提交失败，请重试' }));
      if (active.answerInput === 'choice') {
        const options = node('div', { className: 'sessions-options' });
        for (const option of active.options) {
          const button = node('button', {
            type: 'button', className: 'sessions-option', attrs: { 'aria-pressed': String(option === active.selected) }, text: option,
          });
          button.addEventListener('click', () => {
            state.group = qmodel.selectOption(state.group, active.id, option);
            ctx.hooks?.haptic?.tap?.();
            renderQuestion();
            saveContext();
          });
          options.appendChild(button);
        }
        card.appendChild(options);
      } else {
        const input = node('textarea', {
          className: 'sessions-question-input',
          attrs: { rows: '2', placeholder: active.answerInput === 'voice' ? '输入或口述回答，文字可编辑' : '输入回答…', 'aria-label': '问题回答' },
        });
        input.value = active.draft;
        input.addEventListener('input', () => {
          state.group = qmodel.setDraft(state.group, active.id, input.value);
          state.drafts.question = input.value;
          saveContext();
        });
        card.appendChild(input);
        grow(input);
        if (active.answerInput === 'voice') card.appendChild(node('p', { className: 'hint', text: '语音仅转写为文字，确认后才会提交' }));
      }
      const submit = node('button', {
        type: 'button', className: 'primary sessions-question-submit', text: '提交并继续',
        attrs: active.canSubmit ? {} : { disabled: '' },
      });
      submit.addEventListener('click', () => { void submitQuestion(active); });
      card.appendChild(submit);
      questionBox.appendChild(card);
    } else {
      questionBox.appendChild(node('p', { className: 'hint', text: '全部问题均已回答，内容已保留在会话中' }));
    }

    const answered = node('div', { className: 'sessions-answered' });
    for (const item of binding.answeredList) {
      const row = node('div', { className: 'sessions-answered-row' }, [
        node('strong', { text: item.prompt }),
        node('span', { className: 'sessions-answer', text: item.collapsed ? '已回答（点开回看）' : item.answer }),
      ]);
      const toggle = node('button', { type: 'button', text: item.collapsed ? '展开' : '折叠' });
      toggle.addEventListener('click', () => {
        state.group = qmodel.toggleAnswered(state.group, item.id);
        renderQuestion();
        saveContext();
      });
      row.appendChild(toggle);
      answered.appendChild(row);
    }
    if (answered.childElementCount) questionBox.appendChild(answered);
  }

  async function submitQuestion(active) {
    if (!qmodel || !write || active.state === 'answered') return;
    const question = state.group.questions.find(item => item.id === active.id);
    const payload = qmodel.answerPayload(question, active.kind === 'choice' ? active.selected : undefined);
    if (active.kind !== 'choice' && !String(payload.text || '').trim()) return;
    const button = questionBox.querySelector('.sessions-question-submit');
    if (button) button.disabled = true;
    try {
      await write.answerCard(active.id, payload);
      state.group = qmodel.submitAnswer(state.group, active.id, active.kind === 'choice' ? active.selected : payload.text, { ok: true });
      ctx.hooks?.haptic?.success?.();
    } catch (error) {
      state.group = qmodel.submitAnswer(state.group, active.id, null, { ok: false, error: error?.message || '提交失败，请重试' });
    }
    renderQuestion();
    saveContext();
  }

  // ---- 消息：虚拟列表 + 流式跟随 + 长按菜单 ----
  function messageNode(message) {
    const box = node('div', { className: `sessions-message${message.role === '主人' ? ' user' : ''}` }, [
      node('span', { className: 'sessions-role', text: message.role || '会话' }),
      node('p', { className: 'sessions-bubble', text: message.text || '' }),
    ]);
    if (message.at) box.appendChild(node('span', { className: 'sessions-time', text: message.at }));
    if (message.image) box.appendChild(Object.assign(node('img', { className: 'sessions-image', attrs: { alt: '消息图片', loading: 'lazy' } }), { src: message.image }));
    let timer = null;
    const show = event => showMenu(message.text || '', event.clientX || 40, event.clientY || 80);
    box.addEventListener('pointerdown', event => {
      timer = setTimeout(() => show(event), 500);
    });
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    box.addEventListener('pointerup', clear);
    box.addEventListener('pointercancel', clear);
    box.addEventListener('pointerleave', clear);
    box.addEventListener('contextmenu', event => { event.preventDefault(); show(event); });
    return box;
  }

  function renderMessages() {
    const total = state.messages.length;
    messageWindow.replaceChildren();
    if (!total) messageWindow.appendChild(node('p', { className: 'hint', text: '暂无在线转录；可查看归档会话或等待新消息' }));
    else for (const message of state.messages) messageWindow.appendChild(messageNode(message));
    messageWindow.appendChild(questionBox);
    backBottom.hidden = state.follow;
  }

  // 整页滚动跟随：滚离底部时显示「回到底部」，停止跟随；回到底部恢复跟随。
  messageWindow.addEventListener('scroll', () => {
    if (state.view !== 'detail') return;
    if (smodel) state.follow = smodel.shouldFollowScroll(pageMetrics());
    backBottom.hidden = state.follow;
  }, { passive: true });
  backBottom.addEventListener('click', () => {
    state.follow = true;
    backBottom.hidden = true;
    scrollToBottom('smooth');
  });

  let streamFrames = [];
  let streamScheduled = false;
  function appendStream(text) {
    if (!text) return;
    const follow = !smodel || smodel.shouldFollowScroll(pageMetrics());
    streamFrames.push(String(text));
    if (streamScheduled) return;
    streamScheduled = true;
    requestAnimationFrame(() => {
      streamScheduled = false;
      const merged = smodel ? smodel.mergeStreamFrames(streamFrames.splice(0)) : streamFrames.splice(0).join('');
      if (!merged) return;
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === '会话' && last.streaming) last.text += merged;
      else state.messages.push({ role: '会话', text: merged, at: '', streaming: true });
      state.follow = follow;
      renderMessages();
      if (follow) scrollToBottom();
    });
  }

  function showMenu(text, x, y) {
    state.menuText = String(text || '');
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
    menu.hidden = false;
  }
  menuCopy.addEventListener('click', () => {
    if (state.menuText && navigator.clipboard?.writeText) void navigator.clipboard.writeText(state.menuText).catch(() => {});
    menu.hidden = true;
  });
  document.addEventListener('click', event => {
    if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
  });

  composerInput.value = state.drafts.composer;
  const updateSend = () => { const disabled = !(autogrow ? autogrow.canSend(composerInput.value) : composerInput.value.trim().length > 0); composerSend.disabled = disabled; steerBtn.disabled = disabled; };
  updateSend();
  composerInput.addEventListener('input', () => { state.drafts.composer = composerInput.value; updateSend(); saveContext(); });
  composerInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendComposer(false);
    }
  });
  growLater(composerInput);
  micBtn.addEventListener('click', () => { ctx.hooks?.attachVoice?.(composerInput); });
  newMic.addEventListener('click', () => { ctx.hooks?.attachVoice?.(newPrompt); });
  growLater(newPrompt);
  // 双不可用（无录音能力且无原生识别器）：隐藏所有麦克风，键盘输入不受影响。
  window.addEventListener('autoloop:voice-unavailable', () => { micBtn.hidden = true; newMic.hidden = true; });
  async function sendComposer(interrupt) {
    const text = composerInput.value.trim();
    if (!text || !write || !state.session) return;
    composerSend.disabled = true;
    steerBtn.disabled = true;
    try {
      await write.sendMessage(state.session.id, { text, interrupt, attachments: pendingAttachments });
      state.messages.push({ role: '主人', text, at: '' });
      composerInput.value = '';
      composerInput.dispatchEvent(new Event('autoloop-autogrow'));
      state.drafts.composer = '';
      state.follow = true;
      ctx.hooks?.haptic?.tap?.();
      renderMessages();
      scrollToBottom();
      saveContext();
      pendingAttachments = [];
      renderAttachments();
      // 发完不整页 load（串行 4 次隧道往返）：按「等回复」快拍 15s，首拍 800ms 只读活跃会话，
      // 本轮 liveText 与忙碌/排队状态都由 refreshDetail 带回。
      state.awaitingUntil = Date.now() + 15000;
      setTimeout(() => { if (state.view === 'detail') void refreshDetail(); }, 800);
    } catch (error) {
      showBanner(`发送失败：${error?.message || '请重试'}（内容已保留在输入框）`);
    } finally {
      updateSend();
    }
  }
  composerSend.addEventListener('click', () => { void sendComposer(false); });
  steerBtn.addEventListener('click', () => { void sendComposer(true); });

  detailPrompt.addEventListener('click', () => {
    state.promptExpanded = state.promptExpanded !== true;
    renderPrompt(state.session);
    saveContext();
  });
  detailBack.addEventListener('click', goList);
  artifactsBtn.addEventListener('click', () => { ctx.hooks?.openSessionArtifacts?.(state.session?.id); });

  // ---- 归档只读与恢复 ----
  async function openArchive(record) {
    if (!reader) return;
    state.archiveRecord = record;
    const detail = reader.archiveDetail(record);
    archiveBody.replaceChildren();
    if (detail.empty) archiveBody.appendChild(node('p', { className: 'hint', text: detail.reason || '会话存档不存在或数据缺失' }));
    else {
      archiveBody.appendChild(node('h2', { text: detail.projectLabel || '已归档会话' }));
      archiveBody.appendChild(node('p', { className: 'sessions-meta', text: `${detail.endStatusLabel || '未知'} · ${detail.transcriptCount} 条转录 · 只读` }));
      const box = node('div', { className: 'sessions-archive-transcript' });
      for (const message of detail.messages.items || []) {
        box.appendChild(node('p', { className: 'sessions-archive-line', text: `${message.role}：${message.text}` }));
      }
      archiveBody.appendChild(box);
    }
    archiveRestore.hidden = Boolean(detail.empty);
    showView('archive');
    if (typeof ctx.hooks?.pushView === 'function') ctx.hooks.pushView({ type: 'sessions', view: 'archive', id: record.id });
  }
  archiveBack.addEventListener('click', goList);
  archiveRestore.addEventListener('click', () => { void restoreArchive(state.archiveRecord, archiveRestore); });

  async function restoreArchive(record, button) {
    if (!write || !smodel || !record?.id) return;
    button.disabled = true;
    try {
      await write.continueSession(record.id);
      if (state.list?.archived?.items) {
        const next = smodel.applyRestoreResult(state.list.archived, record.id, { ok: true, newSessionId: '已创建新会话' });
        state.list.archived = next;
        renderList(state.list);
      }
      ctx.hooks?.haptic?.success?.();
      goList();
      await reload();
    } catch (error) {
      if (state.list?.archived?.items) {
        state.list.archived = smodel.applyRestoreResult(state.list.archived, record.id, { ok: false, error: error?.message || '恢复失败，原记录已保留' });
        renderList(state.list);
      }
      showBanner(`恢复失败：${error?.message || '请重试'}（原归档已保留）`);
    } finally {
      button.disabled = false;
    }
  }

  // ---- 新建会话 ----
  newProjects.addEventListener('change', () => { state.activeProject = newProjects.value; });
  newPrompt.addEventListener('input', () => {
    state.newPrompt = newPrompt.value;
    void classifyDebounced();
    renderNewForm();
  });
  let classifyTimer = null;
  async function classifyDebounced() {
    if (!write || state.newPrompt.trim().length < 3) return;
    if (classifyTimer) clearTimeout(classifyTimer);
    classifyTimer = setTimeout(async () => {
      try {
        const result = await write.classify(state.newPrompt);
        state.classification = result && result.kind ? { kind: result.kind, reason: result.reason } : null;
        state.selectedKind = state.classification?.kind || state.selectedKind;
        renderNewForm();
      } catch { /* 分类失败时允许手动选择，不阻断输入 */ }
    }, 400);
  }

  function renderNewForm() {
    if (!smodel) return;
    const form = smodel.buildNewSessionForm({
      projects: state.projects, prompt: state.newPrompt,
      classification: state.classification, selectedKind: state.selectedKind,
    });
    newProjects.replaceChildren(...(form.projectOptions.items.length
      ? form.projectOptions.items.map(item => {
        const option = node('option', { text: item.label, attrs: { value: item.id } });
        return option;
      })
      : [node('option', { text: form.projectOptions.reason || '暂无可选项目', attrs: { value: '' } })]));
    if (state.activeProject) newProjects.value = state.activeProject;
    if (newPrompt.value !== form.prompt) newPrompt.value = form.prompt;
    newRecommend.textContent = form.recommendation?.reason || form.hint;
    newKinds.replaceChildren(...form.kindOptions.map(option => {
      const chip = node('button', {
        type: 'button',
        className: `sessions-chip${option.selected ? ' active' : ''}`,
        text: option.label + (option.recommended ? ' · 推荐' : ''),
      });
      chip.addEventListener('click', () => {
        state.selectedKind = option.id;
        renderNewForm();
      });
      return chip;
    }));
    newSubmit.disabled = !form.canSubmit;
    regrow(); // 草稿被程序改写（如提交后清空）时同步回弹/长高
  }

  newSubmit.addEventListener('click', () => {
    void (async () => {
      if (!write) return;
      newSubmit.disabled = true;
      try {
        await write.createSession({
          project: newProjects.value || state.activeProject,
          prompt: state.newPrompt,
          kind: state.selectedKind || undefined,
        });
        ctx.hooks?.haptic?.success?.();
        state.newPrompt = '';
        state.classification = null;
        showView('list');
        await reload();
      } catch (error) {
        showBanner(`创建失败：${error?.message || '请重试'}`);
      } finally {
        newSubmit.disabled = false;
      }
    })();
  });
  newView.querySelector('.sessions-back').addEventListener('click', goList);
  newButton.addEventListener('click', () => {
    showView('new');
    renderNewForm();
    if (typeof ctx.hooks?.pushView === 'function') ctx.hooks.pushView({ type: 'sessions', view: 'new' });
  });
  searchInput.addEventListener('input', event => {
    state.query = event.target.value;
    saveContext();
    applyFilters();
  });
  archivedToggle.addEventListener('click', () => {
    state.archivedExpanded = !state.archivedExpanded;
    if (state.list) renderList(state.list);
    saveContext();
  });

  // ---- 加载与生命周期 ----
  async function load({ quiet } = {}) {
    try {
      const [sessionModel, questionModel] = await modelPromise;
      if (!sessionModel || !questionModel) return;
      smodel = sessionModel;
      qmodel = questionModel;
      reader = smodel.createSessionsReader({
        origin: ctx.client.origin,
        getToken: () => ctx.client.tokenStore.get(),
        // 锁屏/解除授权后停止在途读取：壳状态翻转为不可展示主界面时，后续读取全部跳过。
        isActive: () => (typeof ctx.state?.canShowMain === 'function' ? ctx.state.canShowMain() : true),
      });
      write = smodel.createSessionsWrite(ctx.client);
      micBtn.hidden = !smodel.hasVoiceHook(ctx.hooks);
      micBtn.title = micBtn.hidden ? '当前未启用语音输入' : '语音输入';
      newMic.hidden = micBtn.hidden;
      newMic.title = micBtn.title;

      const projects = await ctx.client.api('projects').catch(() => null);
      state.projects = Array.isArray(projects?.projects)
        ? projects.projects.map(item => ({ id: item.path, label: item.name || item.path })).filter(item => item.id)
        : [];
      const hubState = await ctx.client.api('state').catch(() => null);
      state.cards = Array.isArray(hubState?.cards) ? hubState.cards : [];

      const result = await reader.load({ kind: state.kind, query: state.query });
      state.lastResult = result;
      state.snapshot = result.snapshot;
      state.list = result.list;
      state.rawArchives = result.rawArchives;
      applyFilters();
      if (!quiet) showBanner('');
      if (!quiet && typeof pendingOpener === 'function') void pendingOpener();
      ctx.hooks?.notify?.refresh?.();
    } catch (error) {
      if (!quiet) showBanner(`读取失败：${error?.message || error}（点「重试」再试）`);
    }
  }
  reload = load;

  // 类型筛选与搜索在已缓存快照上本地即时过滤，不再每次点击都走网络（手机隧道往返数秒，反馈像没点上）。
  function applyFilters() {
    if (!state.snapshot || !smodel) return;
    const filter = ctx.hooks?.projectFilter?.current?.();
    let snapshot = state.snapshot;
    if (filter && !filter.isAll) {
      const matches = item => {
        const raw = String(item?.project || '').trim();
        return raw === filter.selectedId || raw === filter.selectedLabel || item?.projectLabel === filter.selectedId || item?.projectLabel === filter.selectedLabel;
      };
      snapshot = {
        ...snapshot,
        sessions: Array.isArray(snapshot.sessions) ? snapshot.sessions.filter(matches) : snapshot.sessions,
        archives: Array.isArray(snapshot.archives) ? snapshot.archives.filter(matches) : snapshot.archives,
      };
    }
    state.list = smodel.buildSessionList(snapshot, { kind: state.kind, query: state.query });
    renderList(state.list);
  }

  const main = document.getElementById('app-main');
  if (main && !main.hidden) void load();
  else if (main && typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => {
      if (!main.hidden) { observer.disconnect(); void load(); }
    });
    observer.observe(main, { attributes: true, attributeFilter: ['hidden'] });
  }
  ctx.hooks?.projectFilter?.onChange?.(() => { applyFilters(); });
  window.addEventListener('online', () => { void load(); });
  window.addEventListener('pagehide', () => {
    if (detailTimer) { clearInterval(detailTimer); detailTimer = null; }
    saveContext();
  });
  window.addEventListener('autoloop:view-popped', event => {
    if (event.detail?.type === 'sessions') showView('list');
  });
  // 点击通知打开对应会话：事件可能早于首轮加载到达，所以加载完成后再取一次待开会话。
  async function openPendingSession() {
    const nmodel = await notifyPromise;
    const id = nmodel?.takePendingSession?.(window);
    if (!id) return;
    const find = () => (state.snapshot?.sessions || []).find(item => item.id === id);
    if (!find()) await load({ quiet: true });
    const target = find();
    if (target) await openSession(target);
    else if (state.view !== 'list') showView('list'); // 会话已不在：停在列表
  }
  pendingOpener = openPendingSession;
  window.addEventListener(OPEN_SESSION_EVENT_NAME, () => { void openPendingSession(); });
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(syncActiveSession).observe(host, { attributes: true, attributeFilter: ['hidden'] });
  }
  window.addEventListener('autoloop:sessions-stream', event => { appendStream(event.detail?.text); });
  window.addEventListener('autoloop:sessions-voice', event => {
    if (!qmodel || !state.group || !event.detail?.text || !bindingActiveId()) return;
    state.group = qmodel.appendVoiceDraft(state.group, bindingActiveId(), event.detail.text);
    renderQuestion();
    saveContext();
  });
  function bindingActiveId() {
    if (!qmodel || !state.group) return null;
    return state.group.activeId;
  }
}
