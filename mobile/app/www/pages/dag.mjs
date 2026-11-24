// 项目 DAG 页面：把 mobile/src/features/dag-ring 的只读视图模型渲染到 App 壳的 #page-dag。
// 环形分段表示节点、中心显示总进度、下方列出波次与节点；点环切换选中、点节点看契约与证据。
// 视图模型经相对路径 ../src/... 动态加载（受限静态服务）；Node 边界测试不装配 DOM。
// 所有上游文本用 textContent 等安全方式渲染，不拼接 HTML；项目筛选通过全局广播同步重渲染。
const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/dag-ring/index.mjs');
const loadFilterModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/project-filter/index.mjs');

export { loadViewModel };

const node = (tag, { className, text, attrs = {} } = {}, children = []) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  for (const child of children) if (child) element.appendChild(child);
  return element;
};

/** 页面挂载点。ctx 含 client / state / hooks；跨页互调一律走 ctx.hooks。 */
export function mount(ctx) {
  if (typeof document === 'undefined') return;
  const modelPromise = loadViewModel();
  const filterPromise = loadFilterModel();
  if (!modelPromise || !filterPromise) return;
  const page = document.getElementById('page-dag');
  if (!page) return;

  const banner = node('div', { className: 'dag-banner', attrs: { hidden: '' } });
  const bannerText = node('span', { className: 'dag-banner-text' });
  const retry = node('button', { className: 'dag-retry', type: 'button', text: '重试' });
  banner.append(bannerText, retry);
  const ringsEl = node('div', { className: 'dag-rings' });
  const detailEl = node('div', { className: 'dag-detail' });
  page.replaceChildren(banner, ringsEl, detailEl);

  let reload = () => {};
  retry.addEventListener('click', () => { void reload(); });

  Promise.all([modelPromise, filterPromise]).then(([model, filterModel]) => {
    let fullView = model.buildDagRingView({ available: {}, errors: {}, dagRuns: [] });
    let activeView = fullView;
    let activeFilter = null;
    let selectedId = null;
    let selectedNodeId = null;

    // 用当前全局项目筛选同一选中值过滤环；筛选只影响列表范围，不改 run 自身上下文。
    const applyFilter = () => {
      const items = activeFilter && !activeFilter.isAll
        ? filterModel.filterByProject(fullView.rings.items, activeFilter, ring => ring.project)
        : fullView.rings.items;
      const emptyReason = items.length
        ? null
        : (activeFilter && !activeFilter.isAll
          ? `项目「${activeFilter.selectedLabel}」下暂无 DAG 任务环`
          : fullView.rings.reason);
      activeView = {
        ...fullView,
        rings: { ...fullView.rings, items, empty: items.length === 0, reason: emptyReason },
      };
      if (selectedId && !items.some(item => item.taskId === selectedId)) {
        selectedId = null;
        selectedNodeId = null;
      }
    };

    const renderRings = () => {
      ringsEl.replaceChildren();
      if (activeView.rings.empty) {
        ringsEl.appendChild(node('p', { className: 'hint', text: activeView.rings.reason || '暂无可显示的项目 DAG 任务环' }));
        return;
      }
      for (const ring of activeView.rings.items) {
        const center = node('span', { className: 'dag-ring-center' }, [
          node('strong', { text: `${ring.ring.percent ?? 0}%` }),
          node('small', { text: `${ring.summary.doneCount ?? 0}/${ring.summary.nodeCount ?? 0} 节点` }),
        ]);
        const grad = node('span', { className: 'dag-ring-grad', attrs: { 'aria-hidden': 'true' } });
        if (ring.ring.gradient) grad.style.backgroundImage = String(ring.ring.gradient);
        const waves = node('div', { className: 'dag-ring-waves' }, ring.waves.map(wave => node('div', {
          className: 'dag-wave',
          text: `波次 ${wave.wave} · ${wave.nodes.map(n => n.title || n.id).join('、')}`,
        })));
        const card = node('button', {
          className: 'dag-ring-card',
          attrs: {
            type: 'button',
            'data-ring-task-id': ring.taskId,
            'data-project': ring.project,
            'aria-pressed': String(ring.taskId === selectedId),
          },
        }, [
          node('span', { className: 'dag-ring-visual' }, [grad, center]),
          node('span', { className: 'dag-ring-info' }, [
            node('strong', { className: 'dag-ring-title', text: `${ring.projectLabel} · ${ring.planId}` }),
            node('span', { className: 'dag-ring-status', text: ring.statusLabel || '状态未知' }),
            node('span', { className: 'dag-ring-meta', text: `${ring.summary.slotsUsed ?? 0} 槽位 · ${ring.summary.usageText || '费用未上报'}` }),
            waves,
          ]),
        ]);
        card.addEventListener('click', () => {
          selectedId = selectedId === ring.taskId ? null : ring.taskId;
          selectedNodeId = null;
          render();
        });
        ringsEl.appendChild(card);
      }
    };

    const renderDetail = () => {
      detailEl.replaceChildren();
      if (!selectedId) return;
      const active = model.selectRing(activeView, selectedId);
      const chosen = active.selected;
      if (!chosen) return;
      const nodeList = node('div', { className: 'dag-node-list' }, chosen.nodes.map(item => {
        const button = node('button', {
          className: 'dag-node',
          attrs: { type: 'button', 'data-node-id': item.id, 'aria-pressed': String(item.id === selectedNodeId) },
        }, [node('strong', { text: item.title || item.id }), node('span', { text: ` · ${item.statusLabel || '状态未知'}` })]);
        button.addEventListener('click', () => { selectedNodeId = item.id; renderDetail(); });
        return button;
      }));
      // 运行详情头卡：与网页版"项目任务进度"详卡对齐（2026-11-24 用户定）——项目/并行 DAG 徽标、
      // plan·节点·创建时间、本次运行费用 Token（服务端 run 级汇总）、查看 PR 列表；缺失如实标注。
      const prLinks = (chosen.prs || []).map(pr => {
        const link = node('a', { className: 'dag-pr-link', text: `查看 PR（${pr.nodeId}）`, attrs: { href: pr.prUrl, target: '_blank', rel: 'noopener noreferrer' } });
        return link;
      });
      detailEl.appendChild(node('section', { className: 'card dag-detail-card' }, [
        node('h3', { text: chosen.projectLabel }),
        node('p', { className: 'dag-detail-badge', text: '并行 DAG' }),
        node('p', { className: 'hint', text: `${chosen.planId || '未命名计划'} · ${chosen.summary?.nodeCount ?? chosen.nodes.length} 个节点 · ${chosen.createdAt ? `创建于 ${chosen.createdAt}` : '创建时间未上报'}` }),
        node('p', { className: 'dag-detail-usage', text: `本次运行 · ${chosen.usageText || '费用未上报'}` }),
        node('p', { className: 'hint', text: `状态 ${chosen.statusLabel || '未知'} · 运行 ${chosen.runId || '未知'}` }),
        ...(prLinks.length ? prLinks : []),
        nodeList,
      ]));

      const picked = chosen.nodes.find(item => item.id === selectedNodeId);
      if (!picked) return;
      const detail = model.buildNodeDetailView(picked);
      const contractRows = detail.contract.map(row => node('div', {
        className: 'dag-contract-row', attrs: { 'data-contract-key': row.key },
      }, [node('strong', { text: row.label }), node('span', { text: row.value })]));
      const evidenceRows = detail.evidence.map(row => node('div', { className: 'dag-evidence-row' }, [
        node('strong', { text: `${row.label}：` }), node('span', { text: row.value }),
      ]));
      detailEl.appendChild(node('section', { className: 'card dag-node-detail' }, [
        node('h3', { text: detail.title || detail.id }),
        node('p', { className: 'dag-node-meta', text: [
          detail.statusLabel, detail.wave != null ? `波次 ${detail.wave}` : null,
          detail.slot != null ? `槽位 ${detail.slot}` : null, detail.branch,
          detail.agent, detail.model, detail.usageText, detail.summary,
        ].filter(Boolean).join(' · ') }),
        ...(contractRows.length ? [node('h4', { text: '节点契约' }), ...contractRows] : []),
        ...(evidenceRows.length ? [node('h4', { text: '证据' }), ...evidenceRows] : []),
      ]));
    };

    const render = () => { renderRings(); renderDetail(); };

    reload = async () => {
      banner.hidden = true;
      try {
        const response = await ctx.client.api('dag-runs');
        const runs = Array.isArray(response?.runs) ? response.runs : [];
        fullView = model.buildDagRingView({
          available: { 'dag-runs': Array.isArray(response?.runs) }, errors: {}, dagRuns: runs,
        });
        applyFilter();
        render();
      } catch (error) {
        bannerText.textContent = `DAG 数据读取失败：${error?.message || error || '未读取到项目 DAG 进度'}`;
        banner.hidden = false;
      }
    };

    // 全局项目筛选变化时重渲染：主通道走 ctx.hooks.projectFilter，窗口事件作兜底；
    // 两条通道都带同一选中值，去重避免重复渲染。不直接依赖其他页面模块。
    let lastFilterId = null;
    const onFilter = filter => {
      if (!filter) return;
      if (lastFilterId === filter.selectedId) return;
      lastFilterId = filter.selectedId;
      activeFilter = filter;
      applyFilter();
      render();
    };
    ctx.hooks?.projectFilter?.onChange?.(onFilter);
    window.addEventListener('autoloop:project-filter', event => onFilter(event.detail));
    const current = ctx.hooks?.projectFilter?.current?.();
    if (current && !current.isAll) onFilter(current);

    const main = document.getElementById('app-main');
    if (main && !main.hidden) {
      void reload();
    } else if (main && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => {
        if (!main.hidden) { observer.disconnect(); void reload(); }
      });
      observer.observe(main, { attributes: true, attributeFilter: ['hidden'] });
    }
    window.addEventListener('online', () => { void reload(); });
  }).catch(error => {
    bannerText.textContent = `DAG 页面不可用：${error?.message || error || '加载失败'}`;
    banner.hidden = false;
  });
}
