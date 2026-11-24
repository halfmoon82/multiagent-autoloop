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
  refs.projects = makeSection(overviewEl, 'projects', '项目 DAG 进度');
  refs.activity = makeSection(overviewEl, 'activity', '最近动态');
  refs.rules = makeSection(rulesEl, 'rules', '调度规则');
  refs.runs = makeSection(runsEl, 'runs', '执行轮次');
  refs.todos = makeSection(todosEl, 'todos', '待我处理');
  refs.authorize = makeSection(todosEl, 'authorize', '执行授权');

  let write = null;

  async function answer(item, payload, submit, errorNode) {
    submit.disabled = true;
    errorNode.hidden = true;
    try {
      await write.answerCard(item.id, payload);
      drafts.delete(item.id);
      await reload();
    } catch (error) {
      errorNode.textContent = String(error?.message || '提交失败，请重试');
      errorNode.hidden = false;
      submit.disabled = false; // 失败保留草稿与选项，允许原样重试
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
    renderCollection(refs.projects, page.projects, item => {
      const box = node('div', { className: 'core-item', attrs: { 'data-project-run': item.runId ?? '' } }, [
        node('strong', { text: item.projectLabel || '未识别项目' }),
        node('span', { className: 'core-meta', text: `${item.statusLabel || '状态未知'} · ${item.nodeCount} 个节点` }),
      ]);
      if (item.dagEntry) {
        const open = node('button', { type: 'button', className: 'core-action', attrs: { 'data-dag-entry': item.runId ?? '' }, text: item.dagEntry.label });
        // 经壳的既有导航接缝进入 DAG 页（不直接依赖其他页面模块）。
        open.addEventListener('click', () => {
          const select = ctx.hooks?.selectTab || window.AutoloopNav?.selectTab;
          if (typeof select === 'function') select(item.dagEntry.page);
        });
        box.appendChild(open);
      }
      return box;
    });
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
        text: [item.stateLabel, item.projectLabel, item.rule, item.createdAt].filter(Boolean).join(' · '),
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
    };
  }

  function renderCurrent() {
    if (!fullSnapshot || !coreModel) return;
    const pages = coreModel.buildPages(filteredSnapshot());
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
      fullSnapshot = snapshot;
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
