// 会话页：把 sessions / question-group 的只读视图模型接到 App 壳。
// 页面只改 #page-sessions 容器，跨页互调走 ctx.hooks；所有上游文本用 textContent 渲染，不拼接 HTML。
// 视图模型经相对路径 ../src/... 加载（受限静态服务 /mobile/src/）；Node 下不装配 DOM。
const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/sessions/index.mjs');
const loadQuestionModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/question-group/index.mjs');

const loadAutogrow = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/composer-autogrow/index.mjs');

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

  const filterRow = node('div', { className: 'sessions-filter-row' }, [
    node('input', {
      className: 'sessions-search',
      attrs: { type: 'search', placeholder: '搜索会话（标题、项目）', 'aria-label': '搜索会话' },
    }),
    node('button', { type: 'button', className: 'sessions-new-btn', text: '新建会话' }),
  ]);
  const filters = node('div', { className: 'sessions-filters' });
  const currentBox = node('div', { className: 'sessions-current' });
  const listBox = node('div', { className: 'sessions-items' });
  const archivedToggle = node('button', { type: 'button', className: 'sessions-archived-toggle' });
  const archivedBox = node('div', { className: 'sessions-archived-list', attrs: { hidden: '' } });
  const listView = node('section', { className: 'sessions-view', attrs: { 'data-view': 'list' } }, [
    filterRow, filters, currentBox, listBox, archivedToggle, archivedBox,
  ]);

  const detailTitle = node('strong', { className: 'sessions-detail-title' });
  const detailPrompt = node('button', { type: 'button', className: 'sessions-detail-prompt', attrs: { hidden: '' } });
  const artifactsBtn = node('button', { type: 'button', className: 'sessions-artifacts-btn', text: '本会话产物' });
  const detailBack = node('button', { type: 'button', className: 'sessions-back', text: '‹ 会话列表' });
  const questionBox = node('div', { className: 'sessions-question' });
  // 消息区：详情页 flex 列中唯一的滚动区（flex:1; min-height:0; overflow:auto），顶部与输入栏不随消息流滚走。
  const messageWindow = node('div', { className: 'sessions-message-window' });
  const backBottom = node('button', { type: 'button', className: 'sessions-back-bottom', text: '回到底部 ↓', attrs: { hidden: '' } });
  const composerInput = node('textarea', {
    className: 'sessions-composer-input',
    attrs: { rows: '2', placeholder: '输入回答或消息…', 'aria-label': '输入回答或消息', enterkeyhint: 'send' },
  });
  const micBtn = node('button', { type: 'button', className: 'sessions-mic', text: '🎤', attrs: { 'aria-label': '语音输入', hidden: '' } });
  const composerSend = node('button', { type: 'button', className: 'sessions-send', text: '发送', attrs: { disabled: '' } });
  const composerRow = node('div', { className: 'sessions-composer' }, [composerInput, micBtn, composerSend]);
  // 详情页是 flex 列：顶部（标题/提示词/待回答）与输入栏固定，只有消息窗在中间滚动；输入栏常驻底部。
  const detailTop = node('div', { className: 'sessions-detail-top' }, [
    node('div', { className: 'sessions-detail-head' }, [detailBack, detailTitle, artifactsBtn]),
    detailPrompt, questionBox,
  ]);
  const detailView = node('section', { className: 'sessions-view', attrs: { 'data-view': 'detail', hidden: '' } }, [
    detailTop, messageWindow, backBottom, composerRow,
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
  const newMic = node('button', { type: 'button', className: 'sessions-mic sessions-new-mic', text: '🎤', attrs: { 'aria-label': '语音输入', hidden: '' } });
  const newPromptRow = node('div', { className: 'sessions-new-prompt-row' }, [newPrompt, newMic]);
  const newKinds = node('div', { className: 'sessions-new-kinds' });
  const newRecommend = node('p', { className: 'hint sessions-recommend' });
  const newSubmit = node('button', { type: 'button', className: 'primary sessions-new-submit', text: '创建并发送首轮' });
  const newView = node('section', { className: 'sessions-view', attrs: { 'data-view': 'new', hidden: '' } }, [
    node('button', { type: 'button', className: 'sessions-back', text: '‹ 会话列表' }),
    newProjects, newPromptRow, newRecommend, newKinds, newSubmit,
  ]);

  const menuCopy = node('button', { type: 'button', text: '复制' });
  const menu = node('div', { className: 'sessions-menu', attrs: { hidden: '' } }, [menuCopy]);
  host.replaceChildren(banner, listView, detailView, archiveView, newView, menu);

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
    detailView.style.height = `${Math.max(240, Math.floor(vv.height - top - bottomGap))}px`;
  };
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => { fitDetail(); regrow(); });
  }
  window.addEventListener('resize', () => { fitDetail(); regrow(); });

  const showView = name => {
    state.view = name;
    if (name !== 'detail' && detailTimer) { clearInterval(detailTimer); detailTimer = null; }
    // 详情轮询只更新数据不重绘隐藏的列表；回到列表时按当前筛选补一次重绘，不显示旧状态。
    if (name === 'list' && state.listStale && state.list) { state.listStale = false; renderList(state.list); }
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

  const goList = () => {
    if (typeof ctx.hooks?.popView === 'function' && state.view !== 'list') ctx.hooks.popView();
    showView('list');
    saveContext();
  };

  // ---- 列表 ----
  function sessionItem(item) {
    const box = node('button', { type: 'button', className: 'sessions-item', attrs: { 'data-session-id': item.id } }, [
      node('strong', { text: item.title || '会话' }),
      node('span', { className: 'sessions-meta', text: [item.projectLabel, item.statusLabel, item.kindLabel, item.updatedLabel].filter(Boolean).join(' · ') }),
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
        text: option.label,
      });
      chip.addEventListener('click', () => { state.kind = option.id; saveContext(); applyFilters(); });
      return chip;
    }));

    currentBox.replaceChildren();
    if (list.current) {
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
    showView('detail');
    renderQuestion();
    renderMessages();
    // 定位到底部必须发生在消息渲染之后：先滚后渲染会被新内容把位置顶回最上面。
    if (state.follow) scrollToBottom();
    if (typeof ctx.hooks?.pushView === 'function') ctx.hooks.pushView({ type: 'sessions', view: 'detail', id: session.id });
    state.detailSessionId = session.id;
    startDetailPolling();
    saveContext();
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
        state.list = result.list;
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
      detailTitle.textContent = session.title || '会话';
    } catch { /* 轮询静默失败，等下一轮 */ } finally { refreshing = false; }
  }

  function renderQuestion() {
    questionBox.replaceChildren();
    if (!qmodel || !state.group || !state.group.questions.length) {
      questionBox.appendChild(node('p', { className: 'hint', text: '当前会话没有需要回答的事项' }));
      return;
    }
    const binding = qmodel.buildQuestionGroupBinding(state.group);
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
  const updateSend = () => { composerSend.disabled = !(autogrow ? autogrow.canSend(composerInput.value) : composerInput.value.trim().length > 0); };
  updateSend();
  composerInput.addEventListener('input', () => { state.drafts.composer = composerInput.value; updateSend(); saveContext(); });
  growLater(composerInput);
  micBtn.addEventListener('click', () => { ctx.hooks?.attachVoice?.(composerInput); });
  newMic.addEventListener('click', () => { ctx.hooks?.attachVoice?.(newPrompt); });
  growLater(newPrompt);
  // 双不可用（无录音能力且无原生识别器）：隐藏所有麦克风，键盘输入不受影响。
  window.addEventListener('autoloop:voice-unavailable', () => { micBtn.hidden = true; newMic.hidden = true; });
  composerSend.addEventListener('click', () => {
    void (async () => {
      const text = composerInput.value.trim();
      if (!text || !write || !state.session) return;
      composerSend.disabled = true; // 发送中禁用，结束后按内容重算
      try {
        // 真正发送到控制台：此前这里只是本地回显，重开即丢（会话消息从未到达服务器）。
        await write.sendMessage(state.session.id, { text });
        state.messages.push({ role: '主人', text, at: '' });
        composerInput.value = '';
        composerInput.dispatchEvent(new Event('autoloop-autogrow')); // 发送后回弹到最少行数
        state.drafts.composer = '';
        state.follow = true;
        ctx.hooks?.haptic?.tap?.();
        renderMessages();
        scrollToBottom();
        saveContext();
        // 刚发出：快照里状态可能还是空闲，先按「等回复」快拍 15s，避免第一拍被空闲间隔推迟到 5s。
        state.awaitingUntil = Date.now() + 15000;
        setTimeout(() => { if (state.view === 'detail') void refreshDetail(); }, 800);
      } catch (error) {
        showBanner(`发送失败：${error?.message || '请重试'}（内容已保留在输入框）`);
      } finally {
        updateSend();
      }
    })();
  });

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
  filterRow.querySelector('.sessions-new-btn').addEventListener('click', () => {
    showView('new');
    renderNewForm();
    if (typeof ctx.hooks?.pushView === 'function') ctx.hooks.pushView({ type: 'sessions', view: 'new' });
  });
  filterRow.querySelector('.sessions-search').addEventListener('input', event => {
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
      renderList(result.list);
      if (!quiet) showBanner('');
      ctx.hooks?.notify?.refresh?.();
    } catch (error) {
      if (!quiet) showBanner(`读取失败：${error?.message || error}（点「重试」再试）`);
    }
  }
  reload = load;

  // 类型筛选与搜索在已缓存快照上本地即时过滤，不再每次点击都走网络（手机隧道往返数秒，反馈像没点上）。
  function applyFilters() {
    if (!state.snapshot || !smodel) return;
    state.list = smodel.buildSessionList(state.snapshot, { kind: state.kind, query: state.query });
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
  window.addEventListener('online', () => { void load(); });
  window.addEventListener('pagehide', () => {
    if (detailTimer) { clearInterval(detailTimer); detailTimer = null; }
    saveContext();
  });
  window.addEventListener('autoloop:view-popped', event => {
    if (event.detail?.type === 'sessions') showView('list');
  });
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
