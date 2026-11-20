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
export function mount(ctx, { doc = globalThis.document, win = globalThis.window, feature } = {}) {
  if (!ctx || !doc) return () => {};
  const root = doc.getElementById('page-artifacts');
  if (!root) return () => {};

  if (feature) return setup(ctx, doc, win, root, feature);

  let disposed = false;
  let detach = () => {};
  const loaded = loadViewModel();
  if (loaded && typeof loaded.then === 'function') {
    loaded.then(mod => {
      if (!disposed && mod) detach = setup(ctx, doc, win, root, mod);
    }).catch(() => {});
  } else if (loaded) {
    detach = setup(ctx, doc, win, root, loaded);
  }
  return () => { disposed = true; detach(); };
}

function setup(ctx, doc, win, root, F) {
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
        render();
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
    apply(wireOpenSessionArtifacts(browser, {
      artifacts: Array.isArray(artifacts) ? artifacts : [],
      sessionId, returnState: supplied.returnState, layout: detectLayout(win),
    }));
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
  return () => {
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('autoloop:view-popped', onViewPopped);
      win.removeEventListener('resize', onResize);
    }
  };
}
