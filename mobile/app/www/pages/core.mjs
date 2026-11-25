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
const loadDagRingModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/dag-ring/index.mjs');

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
  const dagRingPromise = loadDagRingModel();
  if (!modelPromise || !filterPromise) return;
  let dagRingModel = null;
  dagRingPromise.then(model => { dagRingModel = model; if (fullSnapshot && coreModel) renderCurrent(); });

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

  // 项目 DAG 进度（2026-11-25 用户定交互）：活跃 DAG 直接渲染可点击的环形进度——
  // 扇区=节点、活跃节点带箭头、点节点膨出显示「干嘛的」、查看详情跳 DAG 页对应节点；
  // 已完成/已取消的收进「已归档」折叠区，展开才看。
  const dagovSelection = new Map();

  function renderProjects(collection) {
    refs.projects.replaceChildren();
    if (!collection || collection.empty) {
      refs.projects.appendChild(node('p', { className: 'hint', text: collection?.reason || '暂无数据' }));
      return;
    }
    const items = collection.items || [];
    const active = items.filter(item => !item.archived);
    const archived = items.filter(item => item.archived);
    for (const item of active) {
      const run = (fullSnapshot?.dagRuns || []).find(entry => String(entry?.mobileSummary?.runId ?? entry?.runId ?? '') === String(item.runId ?? ''));
      const card = dagRingModel && run ? dagRingModel.buildActiveDagCard(run) : null;
      if (card && item.dagEntry) refs.projects.appendChild(renderDagRingCard(item, card));
      else refs.projects.appendChild(renderProjectRow(item));
    }
    if (archived.length) {
      const body = node('div', { className: 'dagov-archived-body', attrs: { hidden: '' } });
      for (const item of archived) body.appendChild(renderProjectRow(item));
      const toggle = node('button', { type: 'button', className: 'dagov-archived-toggle', text: `已归档（${archived.length}）· 展开查看` });
      toggle.addEventListener('click', () => {
        const open = body.hidden;
        body.hidden = !open;
        toggle.textContent = open ? `已归档（${archived.length}）· 收起` : `已归档（${archived.length}）· 展开查看`;
      });
      refs.projects.appendChild(node('div', { className: 'dagov-archived' }, [toggle, body]));
    }
  }

  function renderProjectRow(item) {
    const box = node('div', { className: 'core-item', attrs: { 'data-project-run': item.runId ?? '' } }, [
      node('strong', { text: item.projectLabel || '未识别项目' }),
      node('span', { className: 'core-meta', text: `${item.statusLabel || '状态未知'} · ${item.nodeCount} 个节点` }),
    ]);
    if (item.dagEntry) {
      const open = node('button', { type: 'button', className: 'core-action', attrs: { 'data-dag-entry': item.runId ?? '' }, text: item.dagEntry.label });
      open.addEventListener('click', () => {
        const select = ctx.hooks?.selectTab || window.AutoloopNav?.selectTab;
        if (typeof select === 'function') select(item.dagEntry.page);
      });
      box.appendChild(open);
    }
    // 串行链详情入口（#315 引入、#316 重写总览时误删，fix4 加回）：点击展开节点进度清单，
    // 数据来自视图模型 chainDetail（真实串行链状态），失败可重试，不编造节点。
    if (item.chainEntry && item.chainDetail) {
      const panel = node('div', { className: 'core-chain-detail', attrs: { 'data-chain-detail': item.runId ?? '', hidden: '' } });
      const toggle = node('button', { type: 'button', className: 'core-action', attrs: { 'data-chain-entry': item.runId ?? '', 'aria-expanded': 'false' }, text: item.chainEntry.label });
      const fill = () => {
        panel.replaceChildren();
        try {
          const detail = item.chainDetail;
          if (detail.empty) { panel.appendChild(node('p', { className: 'hint', text: detail.reason })); return; }
          panel.appendChild(node('p', { className: 'core-meta', text: `整体进度 ${detail.percent}%` }));
          const list = node('ul', { className: 'core-list' });
          for (const n of detail.nodes) {
            const line = [n.title, n.isCurrent ? '当前环节' : n.status, `${n.percent}%`, n.summary].filter(Boolean).join(' · ');
            list.appendChild(node('li', { attrs: { 'data-chain-node': n.id }, text: line }));
          }
          panel.appendChild(list);
        } catch (error) {
          const retry = node('button', { type: 'button', className: 'core-retry', attrs: { 'data-chain-retry': item.runId ?? '' }, text: '重试' });
          retry.addEventListener('click', fill);
          panel.append(node('p', { className: 'hint', text: String(error?.message || '详情读取失败') }), retry);
        }
      };
      toggle.addEventListener('click', () => {
        const open = panel.hidden;
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) fill();
      });
      box.append(toggle, panel);
    }
    return box;
  }

  const DAGOV_NS = 'http://www.w3.org/2000/svg';
  const DAGOV_COLORS = { done: '#2f9e6e', active: '#e8a33d', blocked: '#d9534f', error: '#d9534f' };
  const dagovColor = kind => DAGOV_COLORS[kind] || '#9db3ab';
  function dagovArc(cx, cy, rOut, rIn, a0, a1) {
    const rad = deg => (deg - 90) * Math.PI / 180;
    const p = (r, a) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];
    const [x0, y0] = p(rOut, a0); const [x1, y1] = p(rOut, a1);
    const [x2, y2] = p(rIn, a1); const [x3, y3] = p(rIn, a0);
    const large = a1 - a0 > 180 ? 1 : 0;
    const svgPath = document.createElementNS(DAGOV_NS, 'path');
    svgPath.setAttribute('d', `M ${x0} ${y0} A ${rOut} ${rOut} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${rIn} ${rIn} 0 ${large} 0 ${x3} ${y3} Z`);
    return svgPath;
  }
  function dagovSvg(tag, attrs) {
    const el = document.createElementNS(DAGOV_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    return el;
  }

  function renderDagRingCard(item, card) {
    const selectedId = dagovSelection.get(card.runId) || '';
    const wrap = node('div', { className: 'dagov-card', attrs: { 'data-dagov-run': card.runId } }, [
      node('div', { className: 'dagov-head' }, [
        node('strong', { text: card.projectLabel || item.projectLabel || '未识别项目' }),
        node('span', { className: 'dagov-badge', text: '并行 DAG' }),
      ]),
      node('p', { className: 'dagov-meta', text: [card.planId, card.waveLabel, `${card.nodeCount} 个节点 · ${card.statusLabel}`].filter(Boolean).join(' · ') }),
    ]);
    const svg = dagovSvg('svg', { viewBox: '0 0 140 140', class: 'dagov-ring', role: 'img' });
    const cx = 70; const cy = 70; const rIn = 34;
    const n = card.nodes.length;
    const gap = n > 1 ? 3 : 0;
    const slice = (360 - gap * n) / n;
    card.nodes.forEach((sector, index) => {
      // 单节点特判：整环用 359.999°，起终点重合的 360° 路径画不出扇区（review P3-1 实测 boundingBox=0）。
      const a0 = index * (slice + gap) + gap / 2;
      const a1 = n === 1 ? a0 + 359.999 : a0 + slice;
      const selected = sector.id === selectedId;
      const inflated = selected ? 9 : 0;
      const path = dagovArc(cx, cy, 52 + inflated, rIn, a0, a1);
      path.setAttribute('fill', dagovColor(sector.statusKind));
      path.setAttribute('class', 'dagov-seg');
      path.setAttribute('data-node-id', sector.id);
      path.addEventListener('click', () => {
        dagovSelection.set(card.runId, selected ? '' : sector.id);
        renderCurrent();
      });
      svg.appendChild(path);
      if (sector.statusKind !== 'done') {
        const mid = (a0 + a1) / 2;
        const rad = (mid - 90) * Math.PI / 180;
        const tx = cx + (52 + inflated + 7) * Math.cos(rad);
        const ty = cy + (52 + inflated + 7) * Math.sin(rad);
        svg.appendChild(dagovSvg('polygon', { points: `${tx},${ty} ${tx - 5},${ty - 8} ${tx + 5},${ty - 8}`, fill: '#0f3d2e', transform: `rotate(${mid} ${tx} ${ty})` }));
      }
    });
    const center = dagovSvg('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'dagov-percent' });
    center.textContent = `${card.percent}%`;
    const sub = dagovSvg('text', { x: cx, y: cy + 14, 'text-anchor': 'middle', class: 'dagov-sub' });
    sub.textContent = `总进度 · ${card.nodeCount} 节点`;
    svg.appendChild(center); svg.appendChild(sub);
    wrap.appendChild(svg);

    const picked = card.nodes.find(sector => sector.id === selectedId);
    if (picked) {
      const nodeCard = node('div', { className: 'dagov-node-card', attrs: { 'data-node-card': picked.id } }, [
        node('strong', { text: picked.title }),
        node('span', { className: 'core-meta', text: [picked.statusLabel, picked.agent && `执行 ${picked.agent}`, picked.model].filter(Boolean).join(' · ') }),
      ]);
      if (picked.summary) nodeCard.appendChild(node('p', { className: 'dagov-node-summary', text: picked.summary }));
      const detail = node('button', { type: 'button', className: 'core-action', text: '查看详情 →' });
      detail.addEventListener('click', () => {
        const select = ctx.hooks?.selectTab || window.AutoloopNav?.selectTab;
        if (typeof select === 'function') select('dag');
        window.dispatchEvent(new CustomEvent('autoloop:dag-pick', { detail: { taskId: card.taskId, runId: card.runId, nodeId: picked.id } }));
      });
      nodeCard.appendChild(detail);
      wrap.appendChild(nodeCard);
    }
    return wrap;
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
    renderProjects(page.projects);
    if (page.serialNote) refs.projects.appendChild(node('p', { className: 'hint', attrs: { 'data-serial-note': '' }, text: page.serialNote }));
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
