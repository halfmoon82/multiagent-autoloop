// 产物页挂载点（DAG 节点 ui-artifacts）：全局产物页 + 覆盖会话入口钩子。
// 只改本文件；业务逻辑在 ../src/features/artifacts（纯逻辑），跨页互调一律走 ctx.hooks。
// 手机：全屏列表 → 全屏阅读 → 逐级返回；折叠/宽屏：左列表右阅读，只刷新右侧。
// 下载经 ctx.hooks.download(url, name) 走原生桥，不用普通链接跳转；返回会话保留返回态。

// 视图模型按环境解析：浏览器里 /mobile/pages/ 用 ../src/ 命中 /mobile/src/；Node 测试从文件路径回退。
const loadViewModel = typeof window === 'undefined'
  ? () => import('../../../src/features/artifacts/index.mjs')
  : () => import('../src/features/artifacts/index.mjs');

// 三态字面量标记（设计 verifier 与样式钩子依赖）：开始 download-start / 成功 download-success / 失败 download-failed。
const FEEDBACK_MARK = { downloading: 'download-start', success: 'download-success', failure: 'download-failed' };

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

// 同时兼容真实 DOM（children 是 HTMLCollection、tagName 大写）与测试假 DOM（tag 小写）。
function findChild(node, tag) {
  const kids = node && node.children;
  if (!kids) return null;
  for (const child of Array.from(kids)) {
    if (child.tag === tag || child.tagName === tag.toUpperCase()) return child;
  }
  return null;
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
    openArtifactReader, backArtifactReader, downloadArtifact, downloadFeedback, ARTIFACT_READ_VIEW,
  } = F;
  const baseUrl = () => str(win?.AutoloopConsoleBase || win?.location?.origin || '');
  let browser = createArtifactBrowser({ id: 'artifacts', entry: 'global', layout: detectLayout(win) });

  // 全局页首次装载（懒加载：等本页第一次可见再取数）——由可选钩子提供产物集合（同步数组或 Promise），
  // 缺省为空列表，不编造内容；异步失败就地给重试入口，不静默空屏。
  // 可见性驱动的原因：App 启动即挂载全部页面模块，绑定/解锁前取数必然 401/403，
  // 资源错误会污染壳级「无脚本错误」断言与真机控制台（2026-11-24 回归实测）。
  const normalize = value => (Array.isArray(value) ? value : []);
  let initialStarted = false;
  function startInitialLoad() {
    if (initialStarted) return;
    initialStarted = true;
    const initial = typeof hooks.artifacts === 'function' ? hooks.artifacts() : [];
    browser = createArtifactBrowser({ ...browser, artifacts: normalize(initial) });
    if (initial && typeof initial.then === 'function') {
      initial
        .then(list => { browser = createArtifactBrowser({ ...browser, artifacts: normalize(list) }); render(); })
        .catch(() => { browser = setError(browser, '产物列表加载失败，可重试'); render(); });
    }
  }
  if (!root.hidden) startInitialLoad();
  else {
    const visibilityObserver = new MutationObserver(() => { if (!root.hidden) { visibilityObserver.disconnect(); startInitialLoad(); } });
    visibilityObserver.observe(root, { attributes: true, attributeFilter: ['hidden'] });
  }

  // A+ 预览：iframe 请求带不了 x-device-token 头，先换一次性票据再 frame.src=预览地址；
  // 沙箱 allow-scripts（不同源）：设计稿里的跳转与脚本可运行，产物脚本碰不到控制台。
  // 图片产物（artifact-image-preview）不走 iframe：设备鉴权的只读文件路由取字节，就地 data URL 渲染，不下载。
  let previewBox = null;
  let previewLoading = false;
  async function togglePreview(selected) {
    if (!previewBox) return;
    if (!previewBox.hidden) { previewBox.hidden = true; return; }
    const frame = findChild(previewBox, 'iframe');
    if (!frame) return;
    if (frame.dataset.loadedFor === selected.id) { previewBox.hidden = false; return; }
    if (previewLoading) return;
    previewLoading = true;
    try {
      const client = typeof ctx.client === 'object' && ctx.client ? ctx.client : null;
      if (!client || typeof client.sessionPreviewTicket !== 'function') throw new Error('no client');
      const issued = await client.sessionPreviewTicket(selected.sessionId, selected.path);
      const origin = baseUrl() || String(win?.location?.origin || '');
      frame.src = origin + String(issued?.url || '');
      frame.dataset.loadedFor = selected.id;
      previewBox.hidden = false;
    } catch {
      previewBox.hidden = true;
      browser = setError(browser, '预览加载失败，可重试');
      render();
    } finally {
      previewLoading = false;
    }
  }

  // 图片在线查看：行内按钮 → 复用只读文件路由（带设备凭据）→ data URL 就地显示。
  // 加载失败就地给「重试」，不清选中、不跳页、不触发原生下载。
  let previewFailure = null; // { id, selected }
  async function openImagePreview(selected) {
    if (!previewBox) return;
    if (!previewBox.hidden && previewFailure === null) { previewBox.hidden = true; return; }
    if (previewLoading) return;
    previewLoading = true;
    try {
      const client = typeof ctx.client === 'object' && ctx.client ? ctx.client : null;
      if (!client || typeof client.sessionArtifactFile !== 'function') throw new Error('no client');
      const data = await client.sessionArtifactFile(selected.sessionId, selected.path);
      const content = str(data?.content).trim();
      if (!content) throw new Error('empty image');
      const mime = str(data?.mimeType) || str(selected.imageMime) || 'image/png';
      // 重试成功后重渲染，撤掉就地失败提示；再往新建的 img 上放 data URL（不落盘、不下载）。
      previewFailure = null;
      render();
      const image = findChild(previewBox, 'img');
      if (!image) throw new Error('no image slot');
      image.setAttribute('src', `data:${mime};base64,${content}`);
      previewBox.hidden = false;
    } catch {
      previewBox.hidden = true;
      previewFailure = { id: str(selected.id), selected };
      render();
    } finally {
      previewLoading = false;
    }
  }

  // 下载反馈：点击即「已开始」，完成/失败就地提示；失败不清选中、不跳页，重试回到原状态。
  let feedback = null;
  let pending = null; // { id, name }
  function showFeedback(next) { feedback = next; render(); }

  function render() {
    const plan = artifactPagePlan(browser);
    const nodes = [];
    previewBox = null;
    if (previewFailure && (!plan.selected || str(plan.selected.id) !== previewFailure.id)) previewFailure = null;

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

    if (previewFailure) {
      const box = el(doc, 'div', 'artifacts-preview-error');
      box.setAttribute('role', 'status');
      box.appendChild(el(doc, 'span', 'artifacts-preview-error-text', '预览加载失败，可重试'));
      box.appendChild(button(doc, 'artifacts-preview-retry', '重试', () => {
        const target = previewFailure;
        previewFailure = null;
        void openImagePreview(target.selected);
      }));
      nodes.push(box);
    }

    if (feedback) {
      const box = el(doc, 'div', `artifacts-download-feedback artifacts-download-${feedback.phase} ${FEEDBACK_MARK[feedback.phase] || ''}`.trim());
      box.setAttribute('role', 'status');
      box.setAttribute('data-phase', feedback.phase);
      box.appendChild(el(doc, 'span', 'artifacts-download-text', feedback.text));
      if (feedback.retry && feedback.effect) {
        box.appendChild(button(doc, 'artifacts-download-retry', '重试', () => runDownload(feedback.effect)));
      }
      if (feedback.rebind) {
        box.appendChild(button(doc, 'artifacts-download-rebind', '去重新绑定', () => {
          if (typeof hooks.openSettings === 'function') hooks.openSettings();
        }));
      }
      nodes.push(box);
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
      if (/\.html?$/i.test(plan.selected.name)) {
        reader.appendChild(button(doc, 'artifacts-preview-toggle', '预览', () => {
          void togglePreview(plan.selected);
        }));
        previewBox = el(doc, 'div', 'artifacts-preview');
        previewBox.hidden = true;
        const frame = el(doc, 'iframe', 'artifacts-preview-frame');
        // A+ 沙箱：脚本可运行、预览内跳转可用；不放开同源，产物脚本读不到控制台 cookie/存储/父页面。
        frame.setAttribute('sandbox', 'allow-scripts');
        previewBox.appendChild(frame);
        reader.appendChild(previewBox);
      } else if (plan.selected.previewKind === 'image') {
        if (plan.selected.imageOverCap) {
          // 超封顶不静默失败：明确提示 + 保留下载按钮作为落盘备选。
          reader.appendChild(el(doc, 'div', 'artifacts-image-cap',
            '图片超过 5MB，无法在线预览，请下载查看'));
        } else {
          reader.appendChild(button(doc, 'artifacts-preview-toggle artifacts-image-preview', '在线查看', () => {
            void openImagePreview(plan.selected);
          }));
          previewBox = el(doc, 'div', 'artifacts-preview');
          previewBox.hidden = true;
          previewBox.appendChild(el(doc, 'img', 'artifacts-preview-image'));
          reader.appendChild(previewBox);
        }
      }
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
      } else if (effect.type === 'download') {
        runDownload(effect);
      }
    }
  }

  function runDownload(effect) {
    pending = null;
    if (typeof hooks.download !== 'function') {
      showFeedback({ ...downloadFeedback('failure', { name: effect.name, reason: 'NO_BRIDGE' }), effect });
      return;
    }
    showFeedback(downloadFeedback('downloading', { name: effect.name }));
    let result;
    try { result = hooks.download(effect.url, effect.name); }
    catch (error) { result = Promise.reject(error); }
    const fail = reason => showFeedback({ ...downloadFeedback('failure', { name: effect.name, reason }), effect });
    Promise.resolve(result).then(r => {
      const started = r === true || (r && typeof r === 'object' && r.started === true);
      if (!started) { fail(r && typeof r === 'object' ? r.reason : ''); return; }
      if (r && typeof r === 'object' && r.id !== undefined && r.id !== null) pending = { id: r.id, effect };
      else showFeedback({ ...downloadFeedback('success', { name: effect.name }) });
    }).catch(error => fail(String(error?.message || '')));
  }

  const onDownloadComplete = event => {
    if (!pending || String(event?.detail?.id) !== String(pending.id)) return;
    const { effect } = pending;
    pending = null;
    showFeedback(event.detail.ok
      ? downloadFeedback('success', { name: effect.name })
      : { ...downloadFeedback('failure', { name: effect.name }), effect });
  };

  // 覆盖会话页入口：会话流调 ctx.hooks.openSessionArtifacts(sessionId, opts) 打开同一产物浏览器。
  hooks.openSessionArtifacts = (sessionId, opts = {}) => {
    const supplied = opts && typeof opts === 'object' ? opts : {};
    const value = supplied.artifacts !== undefined
      ? supplied.artifacts
      : (typeof hooks.artifactsForSession === 'function' ? hooks.artifactsForSession(sessionId) : []);
    const open = artifacts => apply(wireOpenSessionArtifacts(browser, {
      artifacts: Array.isArray(artifacts) ? artifacts : [],
      sessionId, returnState: supplied.returnState, layout: detectLayout(win),
    }));
    if (value && typeof value.then === 'function') {
      value.then(open).catch(() => { browser = setError(browser, '产物列表加载失败，可重试'); render(); });
      return;
    }
    open(value);
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
    win.addEventListener('autoloop:download-complete', onDownloadComplete);
  }

  render();
  return () => {
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('autoloop:view-popped', onViewPopped);
      win.removeEventListener('resize', onResize);
      win.removeEventListener('autoloop:download-complete', onDownloadComplete);
    }
  };
}
