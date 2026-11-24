// 产物页挂载点（DAG 节点 ui-artifacts）：全局产物页 + 覆盖会话入口钩子。
// 只改本文件；业务逻辑在 ../src/features/artifacts（纯逻辑），跨页互调一律走 ctx.hooks。
// 手机：全屏列表 → 全屏阅读 → 逐级返回；折叠/宽屏：左列表右阅读，只刷新右侧。
// 下载经 ctx.hooks.download(url, name) 走原生桥，不用普通链接跳转；返回会话保留返回态。

// 视图模型按环境解析：浏览器里 /mobile/pages/ 用 ../src/ 命中 /mobile/src/；Node 测试从文件路径回退。
const loadViewModel = typeof window === 'undefined'
  ? () => import('../../../src/features/artifacts/index.mjs')
  : () => import('../src/features/artifacts/index.mjs');

export { loadViewModel };

const str = value => String(value ?? '');
const FOLD_MIN_WIDTH = 900;

function detectLayout(win) {
  return win && typeof win.innerWidth === 'number' && win.innerWidth >= FOLD_MIN_WIDTH ? 'fold' : 'phone';
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text !== undefined) node.textContent = str(text);
  return node;
}

function button(doc, className, text, onClick) {
  const node = el(doc, 'button', className, text);
  node.addEventListener('click', onClick);
  return node;
}

/** 挂载点。ctx 含 client / state / hooks。其余参数仅供测试注入，浏览器走默认。 */
export function mount(ctx, { doc = globalThis.document, win = globalThis.window, feature, fetchImpl } = {}) {
  if (!ctx || !doc) return () => {};
  const root = doc.getElementById('page-artifacts');
  if (!root) return () => {};

  if (feature) return setup(ctx, doc, win, root, feature, { fetchImpl });

  let disposed = false;
  let detach = () => {};
  const loaded = loadViewModel();
  if (loaded && typeof loaded.then === 'function') {
    loaded.then(mod => {
      if (!disposed && mod) detach = setup(ctx, doc, win, root, mod, { fetchImpl });
    }).catch(() => {});
  } else if (loaded) {
    detach = setup(ctx, doc, win, root, loaded, { fetchImpl });
  }
  return () => { disposed = true; detach(); };
}

function setup(ctx, doc, win, root, F, { fetchImpl } = {}) {
  const hooks = ctx.hooks || {};
  const {
    createArtifactBrowser, clearError, setError, artifactPagePlan,
    openSessionArtifacts: wireOpenSessionArtifacts,
    openArtifactReader, backArtifactReader, downloadArtifact, ARTIFACT_READ_VIEW,
  } = F;
  const baseUrl = () => str(win?.AutoloopConsoleBase || win?.location?.origin || '');
  let browser = createArtifactBrowser({ id: 'artifacts', entry: 'global', layout: detectLayout(win) });

  // 全局页首次装载：由可选钩子提供产物集合，缺省为空列表，不编造内容。
  const initial = typeof hooks.artifacts === 'function' ? hooks.artifacts() : [];
  browser = createArtifactBrowser({ ...browser, artifacts: Array.isArray(initial) ? initial : [] });

  // ---- artifacts-sync：会话快照 → 全局聚合 / 会话入口 ----
  // 外部已注入 hooks.artifacts 时保持原行为；否则本页接线，并异步装载同一份只读快照。
  let snapshot = null;
  let sessions = [];
  let responses = Object.create(null);
  let groupErrors = [];
  let disposed = false;
  const hasExternal = typeof hooks.artifacts === 'function';
  if (!hasExternal) {
    hooks.artifacts = () => F.snapshotArtifacts(snapshot);
    if (typeof hooks.artifactsForSession !== 'function') {
      hooks.artifactsForSession = id => F.snapshotSessionArtifacts(snapshot, id);
    }
  }

  // 只打新增的 GET /api/mobile/sessions/:id/artifacts；设备令牌只走请求头，不进 URL。
  async function loadOne(sessionId) {
    const client = ctx.client;
    const url = new URL(`/api/mobile/sessions/${encodeURIComponent(str(sessionId))}/artifacts`, client.origin);
    const token = await client.tokenStore.get();
    if (typeof token !== 'string' || !token) throw new Error('尚未绑定设备，请重新绑定后再操作');
    const doFetch = fetchImpl || ((target, init) => globalThis.fetch(target, init));
    let response;
    try {
      response = await doFetch(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json', 'x-console-request': '1', 'x-device-token': token },
      });
    } catch { throw new Error('无法连接控制台，请重试'); }
    let payload = {};
    try { payload = await response.json(); } catch { /* 非 JSON 响应用通用错误 */ }
    if (!response.ok) throw new Error(str(payload?.error || `读取失败（${response.status}），请重试`));
    return { files: Array.isArray(payload?.files) ? payload.files : [] };
  }

  function applySnapshot() {
    if (disposed) return;
    snapshot = F.buildSessionArtifactsSnapshot(sessions, responses);
    groupErrors = snapshot.errors;
    const message = snapshot.allFailed
      ? '未能读取任何会话的产物，请重试'
      : groupErrors.length ? '部分会话产物读取失败，可就地重试' : null;
    browser = createArtifactBrowser({ ...browser, artifacts: F.snapshotArtifacts(snapshot), error: message });
    render();
  }

  // 会话列表来自固定只读中继 /api/mobile/api/sessions；单会话失败只影响该分组，重取只打失败会话。
  async function reload(sessionId, attempt = 0) {
    if (disposed || hasExternal) return;
    let client;
    try { client = ctx.client; } catch { return; } // 控制台地址切换/未绑定中，本次跳过，不抛未捕获错误
    if (!client || typeof client.api !== 'function' || !client.tokenStore || !client.origin) return;
    let list;
    try {
      const loaded = await client.api('sessions');
      list = Array.isArray(loaded) ? loaded : (Array.isArray(loaded?.sessions) ? loaded.sessions : []);
    } catch {
      // 延迟页可能在绑定完成之前 mount：设备令牌尚未就位时短暂重试，避免一次竞态把页面钉在错误态。
      if (attempt < 3) {
        setTimeout(() => void reload(sessionId, attempt + 1).catch(() => {}), 300 * (attempt + 1));
        return;
      }
      sessions = [];
      responses = Object.create(null);
      snapshot = F.buildSessionArtifactsSnapshot([], {});
      groupErrors = [];
      browser = createArtifactBrowser({ ...browser, artifacts: [], error: '未能读取会话列表，请重试' });
      render();
      return;
    }
    sessions = list.filter(item => item && item.id != null).map(item => ({ id: str(item.id), task: str(item.task) }));
    if (sessionId && !sessions.some(item => item.id === str(sessionId))) sessions.push({ id: str(sessionId), task: '' });
    const ids = sessionId ? [str(sessionId)] : sessions.map(item => item.id);
    await Promise.all(ids.map(async id => {
      try { responses[id] = await loadOne(id); }
      catch (error) { responses[id] = { error: str(error?.message || error || '读取失败') }; }
    }));
    applySnapshot();
  }

  function render() {
    const plan = artifactPagePlan(browser);
    const nodes = [];

    const head = el(doc, 'div', 'artifacts-head');
    head.appendChild(el(doc, 'strong', 'artifacts-entry', plan.entryLabel));
    head.appendChild(el(doc, 'span', 'artifacts-count', `${plan.count} 项`));
    if (plan.layout === 'fold') head.appendChild(el(doc, 'span', 'artifacts-layout', plan.layoutLabel));
    nodes.push(head);

    if (plan.error) {
      const errorBox = el(doc, 'div', 'artifacts-error');
      errorBox.appendChild(el(doc, 'span', 'artifacts-error-text', plan.error));
      errorBox.appendChild(button(doc, 'artifacts-retry', '重试', () => {
        browser = clearError(browser);
        void reload(browser.entry === 'session' && browser.sessionId ? browser.sessionId : null).catch(() => {});
      }));
      nodes.push(errorBox);
    }

    const list = el(doc, 'div', 'artifacts-list');
    list.hidden = !plan.listVisible;
    for (const row of plan.artifacts) {
      const item = button(doc, 'artifacts-row', `${row.name} · ${row.taskLabel} · ${row.sizeText}`, () => {
        apply(openArtifactReader(browser, row.id));
      });
      if (row.selected) item.setAttribute('data-selected', '1');
      list.appendChild(item);
    }
    // 单会话产物读取失败只在该分组就地报错与重试，其余分组照常显示。
    for (const failure of groupErrors) {
      if (browser.entry === 'session' && failure.sessionId !== browser.sessionId) continue;
      const row = el(doc, 'div', 'artifacts-group-error');
      row.appendChild(el(doc, 'span', 'artifacts-group-error-text', `${failure.sessionId}：${failure.error}`));
      row.appendChild(button(doc, 'artifacts-group-retry', '重试', () => void reload(failure.sessionId).catch(() => {})));
      list.appendChild(row);
    }
    if (plan.count === 0 && !plan.error && groupErrors.length === 0) {
      list.appendChild(el(doc, 'div', 'artifacts-empty', '暂无产物'));
    }
    nodes.push(list);

    const reader = el(doc, 'div', 'artifacts-reader');
    reader.hidden = !plan.readerVisible;
    if (plan.selected) {
      reader.appendChild(el(doc, 'h3', 'artifacts-reader-title', plan.selected.name));
      reader.appendChild(el(doc, 'p', 'artifacts-reader-meta',
        `${plan.selected.path} · ${plan.selected.kindLabel} · 只读`));
      reader.appendChild(button(doc, 'artifacts-download', `下载 ${plan.selected.name}`, () => {
        apply(downloadArtifact(browser, plan.selected.id, baseUrl()));
      }));
    }
    nodes.push(reader);

    const backBar = el(doc, 'div', 'artifacts-back');
    if (plan.canReturn) {
      backBar.appendChild(button(doc, 'artifacts-back-session', '返回会话', () => {
        apply(backArtifactReader(browser));
      }));
    } else if (plan.readerVisible) {
      backBar.appendChild(button(doc, 'artifacts-back-list', '返回列表', () => {
        apply(backArtifactReader(browser));
      }));
    }
    if (backBar.children.length) nodes.push(backBar);

    root.replaceChildren(...nodes);
  }

  function apply(effectSet) {
    if (!effectSet) return;
    browser = effectSet.browser;
    render();
    for (const effect of effectSet.effects || []) {
      if (effect.type === 'selectTab') {
        if (typeof hooks.selectTab === 'function') hooks.selectTab(effect.page);
        else if (typeof win?.AutoloopNav?.selectTab === 'function') win.AutoloopNav.selectTab(effect.page);
      } else if (effect.type === 'pushView' && typeof hooks.pushView === 'function') {
        hooks.pushView(effect.view);
      } else if (effect.type === 'popView' && typeof hooks.popView === 'function') {
        hooks.popView();
      } else if (effect.type === 'restoreSession' && typeof hooks.restoreSession === 'function') {
        hooks.restoreSession(effect.payload);
      } else if (effect.type === 'download' && typeof hooks.download === 'function') {
        let result;
        try { result = hooks.download(effect.url, effect.name); }
        catch { result = Promise.reject(new Error('download failed')); }
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {
            browser = setError(browser, '下载失败，可重试');
            render();
          });
        }
      }
    }
  }

  // 覆盖会话页入口：会话流调 ctx.hooks.openSessionArtifacts(sessionId, opts) 打开同一产物浏览器。
  hooks.openSessionArtifacts = (sessionId, opts = {}) => {
    const supplied = opts && typeof opts === 'object' ? opts : {};
    const artifacts = supplied.artifacts
      || (typeof hooks.artifactsForSession === 'function' ? hooks.artifactsForSession(sessionId) : []);
    const effect = wireOpenSessionArtifacts(browser, {
      artifacts: Array.isArray(artifacts) ? artifacts : [],
      sessionId, returnState: supplied.returnState, layout: detectLayout(win),
    });
    const entryError = hasExternal ? null : F.snapshotSessionError(snapshot, sessionId);
    if (entryError) effect.browser = setError(effect.browser, `${str(sessionId)} 产物读取失败，请重试`);
    apply(effect);
  };

  // 返回键弹出阅读视图时只收起阅读侧；应用已 popView，这里不再重复弹栈。
  const onViewPopped = event => {
    if (event?.detail?.id !== ARTIFACT_READ_VIEW || !browser.opened) return;
    browser = backArtifactReader(browser).browser;
    render();
  };
  const onResize = () => {
    const layout = detectLayout(win);
    if (browser.layout !== layout) {
      browser = createArtifactBrowser({ ...browser, layout });
      render();
    }
  };
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('autoloop:view-popped', onViewPopped);
    win.addEventListener('resize', onResize);
  }

  render();
  void reload().catch(() => {});
  return () => {
    disposed = true;
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('autoloop:view-popped', onViewPopped);
      win.removeEventListener('resize', onResize);
    }
  };
}
