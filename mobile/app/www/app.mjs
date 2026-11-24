// 移动端 App 壳：只做路由与装配。业务逻辑在 mobile/src（视图模型）与 pages/（页面模块）。
// 页面模块由下方清单登记：首屏页立即加载，其余延迟到首屏渲染后；各页导出 mount(ctx)，ctx 含 client / state / hooks。
// 跨页互调一律走 ctx.hooks，不直接 import 其他页面模块。
import { ShellState, createTokenStore, createMobileClient, createBiometricGate, shouldAutoRetry } from './shell.mjs';
import { createScanSession, createUserMediaCamera } from './scan.mjs';

export const MOBILE_PAGES = Object.freeze([
  'core', 'sessions', 'artifacts', 'dag', 'project-filter', 'notify', 'voice', 'font-touch', 'devices', 'admin', 'settings',
]);
// 统一的 import / 懒加载清单（本文件是唯一维护点，其他节点只在这里登记）。
// 首屏页：解锁后立刻 mount（总览、全局筛选、通知角标、字体层、设置入口）。
// 延迟页：首屏渲染后按清单顺序逐个动态 import 并 mount；单页失败只跳过，不影响首屏与其他页。
export const EAGER_PAGES = Object.freeze(['core', 'project-filter', 'notify', 'font-touch', 'settings']);
export const DEFERRED_PAGES = Object.freeze(MOBILE_PAGES.filter(name => !EAGER_PAGES.includes(name)));
const PAGE_LOADERS = {
  core: () => import('./pages/core.mjs'),
  sessions: () => import('./pages/sessions.mjs'),
  artifacts: () => import('./pages/artifacts.mjs'),
  dag: () => import('./pages/dag.mjs'),
  'project-filter': () => import('./pages/project-filter.mjs'),
  notify: () => import('./pages/notify.mjs'),
  voice: () => import('./pages/voice.mjs'),
  'font-touch': () => import('./pages/font-touch.mjs'),
  devices: () => import('./pages/devices.mjs'),
  admin: () => import('./pages/admin.mjs'),
  settings: () => import('./pages/settings.mjs'),
};
// 按需功能模块登记（不预加载）：页面经 hooks.loadFeature(name) 在用到时才 import；失败返回 null，由调用方降级。
export const FEATURE_LOADERS = Object.freeze({
  'design-authorize': () => import('./src/features/design-authorize/index.mjs'),
});

// 默认钩子全部是空操作：未就绪时调用不抛错，后续节点只覆盖自己的钩子。
export function createDefaultHooks() {
  const projectFilterListeners = new Set();
  return {
    attachVoice() {},
    notify: { setBadge() {}, refresh() {} },
    openSessionArtifacts() {},
    projectFilter: {
      _listeners: projectFilterListeners,
      current() { return null; },
      onChange(listener) { if (typeof listener !== 'function') return () => {}; projectFilterListeners.add(listener); return () => projectFilterListeners.delete(listener); },
    },
    pushView() {},
    popView() {},
    haptic: { tap() {}, success() {} },
    download() {},
    openSettings() {},
    admin: { onShow() {} },
    loadFeature(name) { const load = FEATURE_LOADERS[name]; return load ? load().catch(() => null) : Promise.resolve(null); },
  };
}

// 页面栈：Tab 根页 → 详情 → 产物阅读。有上一级就回上一级，根页才提示二次退出。
export function createViewStack() {
  const views = [];
  return {
    get depth() { return views.length; },
    push(view) { views.push(view); return views.length; },
    pop() { return views.length ? views.pop() : null; },
    current() { return views.length ? views[views.length - 1] : null; },
    clear() { views.length = 0; },
    back() {
      if (views.length) return { action: 'pop', view: views.pop() };
      return { action: 'confirm-exit' };
    },
  };
}

// 返回键二次确认：只在短时间窗内连按两次才退出，且只有 Tab 根页才会走到这里。
export function createBackGuard({ now = () => Date.now(), windowMs = 2500 } = {}) {
  let last = 0;
  return {
    press() {
      const time = now();
      if (last && time - last <= windowMs) { last = 0; return 'exit'; }
      last = time;
      return 'confirm';
    },
    reset() { last = 0; },
  };
}

function boot() {
  const $ = id => document.getElementById(id);
  const els = {
    lockScreen: $('lock-screen'), appMain: $('app-main'),
    bindCard: $('bind-card'), unlockCard: $('unlock-card'), toast: $('toast'),
    baseUrl: $('base-url'), bindName: $('bind-name'), bindPayload: $('bind-payload'), bindSubmit: $('bind-submit'), bindStatus: $('bind-status'),
    scanBind: $('scan-bind'), scanVideo: $('scan-video'), scanStatus: $('scan-status'),
    unlock: $('unlock'), lockError: $('lock-error'),
    deviceName: $('device-name'), connectionStatus: $('connection-status'),
    connectionError: $('connection-error'), reconnect: $('reconnect'), rebind: $('rebind'),
  };

  const state = new ShellState();
  // 原生桥由 Android App（Capacitor 插件）注入；网页回归注入等价的假桥。
  // 原生桥可能在页面脚本之后才被注入（远程页面加载时序），所以每次调用时才去取，不在启动时一次性捕获。
  // 没有桥（普通浏览器）时退回内存，绝不写 localStorage。
  let memoryToken = null;
  const secureStorage = {
    async get() { const bridge = window.AutoloopSecureStorage; return bridge ? bridge.get() : memoryToken; },
    async set(token) { const bridge = window.AutoloopSecureStorage; if (bridge) await bridge.set(token); else memoryToken = token; },
    async remove() { const bridge = window.AutoloopSecureStorage; if (bridge) await bridge.remove(); else memoryToken = null; },
  };
  const tokenStore = createTokenStore({ secureStorage });
  const biometric = createBiometricGate({ bridge: window.AutoloopBiometric || null });
  let client = null;
  let clientBase = null;
  let retryTimer = null;
  let bindMessage = '';
  let scanSession = null;
  let toastTimer = null;

  // 网页同源部署时用 location.origin；独立 APK 由原生桥注入控制台 HTTPS 地址，或由用户填写。
  els.baseUrl.value = window.AutoloopConsoleBase || window.location.origin;
  const consoleBase = () => window.AutoloopConsoleBase || els.baseUrl.value || window.location.origin;
  const getClient = () => {
    const base = consoleBase();
    if (!client || clientBase !== base) {
      client = createMobileClient({ base, state, tokenStore }); // 内部强制 HTTPS / 站点根校验
      clientBase = base;
    }
    return client;
  };
  const cancelRetry = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } };
  const scheduleRetry = delay => { cancelRetry(); retryTimer = setTimeout(() => { retryTimer = null; void reconnect(); }, delay); };

  const connectionLabel = () => ({
    connecting: '正在连接…',
    online: '已安全连接',
    offline: '网络已断开，等待重连',
    error: '连接异常，准备重试',
  })[state.connection] || '未连接';

  // ---- 路由与接缝 ----
  const hooks = createDefaultHooks();
  // 原生桥缺省时保持空操作；注入后只覆盖对应钩子，不改其他节点的实现。
  if (window.AutoloopHaptics && typeof window.AutoloopHaptics.tap === 'function') hooks.haptic = window.AutoloopHaptics;
  if (window.AutoloopDownload && typeof window.AutoloopDownload.start === 'function') {
    hooks.download = (url, name) => window.AutoloopDownload.start(url, name);
  }
  const stack = createViewStack();
  const guard = createBackGuard();
  const ctx = {
    get client() { return getClient(); },
    state,
    hooks,
  };

  // 图标与折叠是全局增强：动态 import 不阻塞首屏（app-startup-perf #293 的诉求），
  // 加载完成后对整个 document 生效；懒加载页面后渲染的卡片由折叠观察器接管，
  // 各页面内部图标由页面 mount 时自渲染（renderIcons 幂等）。
  import('./icons.mjs').then(m => m.renderIcons(document)).catch(() => {});
  import('./collapsible-cards.mjs').then(m => m.observeCollapsibleCards(document)).catch(() => {});
  const tabBar = $('tab-bar');
  const tabs = tabBar ? [...tabBar.querySelectorAll('.tab')] : [];
  const pageEls = new Map([...document.querySelectorAll('.content .page')].map(el => [el.dataset.page, el]));
  let activeTab = 'core';
  // 设置页不是 Tab，经页面栈进入：栈顶是 settings 时显示设置页，弹出后回到当前 Tab 根页。
  const visiblePage = () => (stack.current()?.id === 'settings' ? 'settings' : activeTab);
  const renderViewState = () => {
    els.appMain.dataset.activeTab = activeTab;
    els.appMain.dataset.viewDepth = String(stack.depth);
    const shown = visiblePage();
    for (const [key, el] of pageEls) el.hidden = key !== shown;
  };
  // 页面可达但不在 Tab 栏的页（产物/DAG）也走 selectTab：不高亮任何 Tab，页面照常显示。
  function selectTab(name) {
    if (!pageEls.has(name) || name === 'settings') return;
    activeTab = name;
    stack.clear();
    guard.reset();
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    if (name === 'admin') { hooks.admin?.onShow?.(); if (!mounted.has('admin')) void ensurePage('admin').then(() => { if (activeTab === 'admin') hooks.admin?.onShow?.(); }); }
    else if (!mounted.has(name)) void ensurePage(name);
    renderViewState();
  }
  function openSettings() {
    if (stack.current()?.id === 'settings') return;
    guard.reset();
    stack.push({ id: 'settings' });
    renderViewState();
  }
  hooks.openSettings = openSettings;
  for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab.dataset.tab));

  hooks.pushView = view => { stack.push(view); renderViewState(); };
  hooks.popView = () => { const view = stack.pop(); renderViewState(); return view; };

  function showToast(text) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; els.toast.textContent = ''; }, 2200);
  }
  // 原生 MainActivity 把返回键转成 autoloop:back；Capacitor 标准 backbutton 同样受理。
  function onBack() {
    const step = stack.back();
    if (step.action === 'pop') {
      window.dispatchEvent(new CustomEvent('autoloop:view-popped', { detail: step.view }));
      renderViewState();
      return;
    }
    if (guard.press() === 'confirm') { showToast('再按一次退出'); return; }
    if (typeof window.AutoloopApp?.exit === 'function') window.AutoloopApp.exit();
  }
  window.addEventListener('autoloop:back', onBack);
  window.addEventListener('backbutton', onBack);

  // 软键盘高度写进 CSS 变量，供页面固定底部输入栏使用（visualViewport 不可用时保持 0）。
  const syncViewport = () => {
    const vv = window.visualViewport;
    const keyboard = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    document.documentElement.style.setProperty('--keyboard-height', `${keyboard}px`);
  };
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
    syncViewport();
  }

  // H5 / 原生共用的接缝出口；各页与回归脚本通过这里覆盖钩子与驱动导航。
  window.AutoloopHooks = hooks;
  window.AutoloopNav = {
    pushView: hooks.pushView,
    popView: hooks.popView,
    back: onBack,
    selectTab,
    current: () => stack.current(),
    depth: () => stack.depth,
  };

  // 页面挂载：按名去重；动态 import 失败只记录，页面保持空白，事后再次进入会重试。
  const mounted = new Map();
  function ensurePage(name) {
    if (!PAGE_LOADERS[name]) return Promise.resolve(false);
    if (!mounted.has(name)) {
      const task = PAGE_LOADERS[name]().then(mod => { mod.mount(ctx); return true; }).catch(() => { mounted.delete(name); return false; });
      mounted.set(name, task);
    }
    return mounted.get(name);
  }
  // 首屏页同步顺序 mount，保持原有钩子覆盖顺序；其余页在首屏渲染后的空闲时段逐个加载。
  selectTab('core');
  void (async () => {
    for (const name of EAGER_PAGES) await ensurePage(name);
    const idle = window.requestIdleCallback ? cb => window.requestIdleCallback(cb, { timeout: 500 }) : cb => setTimeout(cb, 0);
    await new Promise(resolve => requestAnimationFrame ? requestAnimationFrame(() => idle(resolve)) : idle(resolve));
    for (const name of DEFERRED_PAGES) await ensurePage(name);
    window.__autoloopPagesReady = true;
    window.dispatchEvent(new CustomEvent('autoloop:pages-ready'));
  })();

  // 主内容区左右滑动切相邻 Tab：与点击共用 selectTab；不支持 PointerEvent 时 feature 自行退化为纯点击。
  // 浏览器里 ./src 指 /mobile/src（与页面模块同一受限目录规则），失败不影响点击切页。
  const content = document.querySelector('.content');
  import('./src/features/tab-swipe/index.mjs').then(({ attachTabSwipe }) => {
    attachTabSwipe({
      surface: content,
      tabOrder: () => tabs.map(tab => tab.dataset.tab),
      getActive: () => activeTab,
      isEnabled: () => stack.depth === 0,
      select: selectTab,
    });
  }).catch(() => {});

  function render() {
    const unlocked = state.canShowMain();
    els.lockScreen.hidden = unlocked;
    els.appMain.hidden = !unlocked;
    // 锁屏两态：未绑定只显示绑定卡；已绑定未解锁只显示解锁卡。
    const bound = Boolean(state.token) && !state.needsBind;
    els.bindCard.hidden = bound;
    els.unlockCard.hidden = !bound;
    els.bindStatus.textContent = bindMessage;
    els.lockError.textContent = state.lockError || '';
    els.deviceName.textContent = state.device?.name || '未绑定设备';
    els.connectionStatus.setAttribute('aria-label', connectionLabel());
    els.connectionStatus.title = connectionLabel();
    els.connectionStatus.dataset.state = state.connection;
    els.connectionError.textContent = ['error', 'offline'].includes(state.connection) ? (state.error || '') : '';
    els.unlock.disabled = state.phase === 'unlocking';
    renderViewState();
  }

  async function reconnect() {
    cancelRetry();
    const retryDelay = state.retry();
    render();
    try {
      await getClient().session();
      render();
    } catch (error) {
      // 客户端构建（地址校验）在 session 之前失败时，也要给出可读错误而不是停在「正在连接」。
      if (state.connection === 'connecting') state.connectFailure(error?.message || '连接失败，请重试');
      render();
      // 地址非法/不安全属于永久配置错误，自动重试只会空转；授权失效与未绑定同样不排重试。
      if (!shouldAutoRetry(error, state)) return;
      scheduleRetry(retryDelay);
    }
  }

  // 手工粘贴与扫码共用同一条绑定路径：一次性载荷只在内存里流转，不写日志/存储。
  async function doBind(payloadText) {
    els.bindSubmit.disabled = true;
    bindMessage = '';
    render();
    try {
      await getClient().bind(payloadText, els.bindName.value || 'Android 设备', 'Android');
      els.bindPayload.value = ''; // 一次性二维码内容不留在输入框里
      bindMessage = '绑定成功，请通过生物识别解锁';
      state.lockError = null;
      render();
      return true;
    } catch (error) {
      bindMessage = error?.message || '绑定失败，请检查二维码是否有效或已过期';
      render();
      return false;
    } finally {
      els.bindSubmit.disabled = false;
    }
  }

  els.bindSubmit.addEventListener('click', () => { void doBind(els.bindPayload.value); });

  const stopScan = () => {
    if (!scanSession) return;
    scanSession.stop();
    scanSession = null;
    els.scanVideo.hidden = true;
    els.scanBind.disabled = false;
  };

  const startScan = async () => {
    if (scanSession?.active) return;
    els.scanStatus.textContent = '正在打开摄像头，请对准二维码…';
    els.scanVideo.hidden = false;
    els.scanBind.disabled = true;
    const camera = window.AutoloopScanCamera || createUserMediaCamera({ video: els.scanVideo });
    scanSession = createScanSession({
      openCamera: () => camera.open(),
      onPayload: payloadText => {
        els.scanStatus.textContent = '已识别二维码，正在绑定…';
        els.bindPayload.value = payloadText; // 自动填入后走同一提交路径
        void doBind(payloadText).then(ok => {
          els.bindPayload.value = ''; // 扫到的码无论成败都不留在输入框
          els.scanStatus.textContent = ok ? '' : bindMessage;
          stopScan();
        });
      },
      onError: message => {
        els.scanStatus.textContent = `${message}（可继续手工粘贴）`;
        stopScan();
      },
    });
    const started = await scanSession.start();
    if (!started) stopScan();
  };

  els.scanBind.addEventListener('click', () => { void startScan().catch(() => { stopScan(); }); });
  window.addEventListener('pagehide', stopScan);
  window.addEventListener('beforeunload', stopScan);

  els.unlock.addEventListener('click', async () => {
    state.beginUnlock();
    render();
    try {
      const ok = await biometric.verify();
      if (!ok) { state.unlockFailure('生物识别未通过，请重试'); render(); return; }
      state.unlockSuccess();
      render();
      await reconnect();
    } catch (error) {
      state.unlockFailure(error?.message || '生物识别不可用，请在已安装的 App 内打开');
      render();
    }
  });

  els.reconnect.addEventListener('click', () => { void reconnect().catch(() => {}); });
  // 「重新绑定 / 退出」一键清凭证且不可恢复：第一次点击只转为确认提示，3 秒内再点一次才执行。
  let rebindArmed = false;
  let rebindArmTimer = null;
  const rebindLabel = els.rebind.textContent;
  const disarmRebind = () => {
    rebindArmed = false;
    if (rebindArmTimer) { clearTimeout(rebindArmTimer); rebindArmTimer = null; }
    els.rebind.textContent = rebindLabel;
  };
  els.rebind.addEventListener('click', () => {
    if (!rebindArmed) {
      rebindArmed = true;
      els.rebind.textContent = '确认退出绑定？';
      rebindArmTimer = setTimeout(disarmRebind, 3000);
      return;
    }
    disarmRebind();
    void (async () => {
      cancelRetry();
      await tokenStore.clear();
      state.clearToken();
      state.lock();
      state.connection = 'offline';
      state.error = null;
      state.lockError = '已退出绑定，请重新扫码绑定';
      bindMessage = '';
      render();
    })().catch(() => {});
  });

  // 原生安全存储不可用（如 Keystore 在覆盖安装后失效）：原生桥广播此事件，必须变成绑定页上的
  // 可读指引，而不是停在一个毫无提示的绑定页（2026-11-24 真机事故：用户无从知晓需要重新绑定）。
  window.addEventListener('autoloop:secure-storage-error', event => {
    bindMessage = event?.detail?.message || '安全存储不可用，请重新扫码绑定';
    render();
  });

  window.addEventListener('offline', () => { cancelRetry(); state.networkLost(); render(); });
  window.addEventListener('online', () => {
    if (!state.canShowMain()) return;
    state.networkRestored();
    void reconnect().catch(() => {});
  });

  render();

  // 重启 App：安全存储里已有设备凭证时恢复「已绑定」状态，显示解锁卡而不是再次要求绑定。
  // 在 Capacitor 里原生桥可能稍晚注入，最多等约 10 秒；读不到凭证才保持绑定页。
  void (async () => {
    const inApp = Boolean(window.Capacitor);
    for (let i = 0; inApp && !window.AutoloopSecureStorage && i < 20; i++) await new Promise(r => setTimeout(r, 500));
    if (state.token) return; // 等待期间用户已手动绑定
    const stored = await tokenStore.get();
    if (typeof stored === 'string' && stored) { state.setToken(stored); render(); }
  })().catch(() => {});
}

if (typeof document !== 'undefined') boot();
