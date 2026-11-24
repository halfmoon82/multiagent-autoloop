// 移动端 App 壳：只做路由与装配。业务逻辑在 mobile/src（视图模型）与 pages/（页面模块）。
// 页面模块按固定列表静态 import；各页导出 mount(ctx)，ctx 含 client / state / hooks。
// 跨页互调一律走 ctx.hooks，不直接 import 其他页面模块。
import {
  ShellState, createTokenStore, createMobileClient, createBiometricGate,
  createKeyedSecureStorage, createConsoleRegistry, createReconnectController, attachReconnectLifecycle,
  bootScreen, reconnectStatusText,
} from './shell.mjs';
import { createScanSession, createUserMediaCamera } from './scan.mjs';
import * as corePage from './pages/core.mjs';
import * as sessionsPage from './pages/sessions.mjs';
import * as artifactsPage from './pages/artifacts.mjs';
import * as dagPage from './pages/dag.mjs';
import * as projectFilterPage from './pages/project-filter.mjs';
import * as notifyPage from './pages/notify.mjs';
import * as voicePage from './pages/voice.mjs';
import * as fontTouchPage from './pages/font-touch.mjs';
import * as devicesPage from './pages/devices.mjs';
import * as adminPage from './pages/admin.mjs';
import * as settingsPage from './pages/settings.mjs';

export const MOBILE_PAGES = Object.freeze([
  'core', 'sessions', 'artifacts', 'dag', 'project-filter', 'notify', 'voice', 'font-touch', 'devices', 'admin', 'settings',
]);
const PAGE_MODULES = {
  core: corePage, sessions: sessionsPage, artifacts: artifactsPage, dag: dagPage,
  'project-filter': projectFilterPage, notify: notifyPage, voice: voicePage,
  'font-touch': fontTouchPage, devices: devicesPage, admin: adminPage, settings: settingsPage,
};

// 默认钩子全部是空操作：未就绪时调用不抛错，后续节点只覆盖自己的钩子。
export function createDefaultHooks() {
  return {
    attachVoice() {},
    notify: { setBadge() {}, refresh() {} },
    openSessionArtifacts() {},
    projectFilter: { current() { return null; }, onChange() {} },
    pushView() {},
    popView() {},
    haptic: { tap() {}, success() {} },
    download() {},
    openSettings() {},
    admin: { onShow() {} },
    // 多控制台数据源（首屏列表与设置页共用）；网页单控制台模式下不可管理。
    consoles: {
      available: false,
      list() { return []; },
      current() { return null; },
      async switchConsole() {},
      async removeConsole() {},
      async addConsole() {},
      subscribe() { return () => {}; },
    },
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
  const legacyTokenStore = createTokenStore({ secureStorage });
  let tokenStore = legacyTokenStore;
  const biometric = createBiometricGate({ bridge: window.AutoloopBiometric || null });
  let client = null;
  let clientBase = null;
  let clientTokens = null;
  let bindMessage = '';
  let scanSession = null;
  let toastTimer = null;

  // ---- 多控制台（console-hub）----
  // App（原生安全存储支持按键分存）时启用多控制台：首屏控制台列表 + 设置页「当前控制台」，凭证按 <host>:device-token 分 key。
  // 网页同源部署（无按键存储）保持单控制台：地址即页面同源，行为与以前一致。
  const hub = { enabled: false, registry: null, storage: null, booted: null, entered: false, adding: false, storageFailed: false, enterAfterUnlock: false };
  const consoleListeners = new Set();
  const notifyConsoles = () => { for (const fn of consoleListeners) { try { fn(); } catch { /* 单个订阅者异常不影响其他 */ } } };
  // 切换控制台 = 整页重建 shell 连接上下文：页面模块缓存的客户端/数据全部随页面重建，杜绝跨控制台串数据；
  // 会话解锁标记在原生进程内存里，重建后免重复生物识别。
  const enterRequested = window.location.hash === '#enter';
  if (enterRequested) history.replaceState(null, '', window.location.pathname + window.location.search);
  // 页面级上下文（打开中的会话、输入草稿等 nomoto-* 键）属于原控制台，换控制台时清掉，避免跨控制台串数据。
  const clearPageContext = () => {
    try {
      for (const key of Object.keys(window.sessionStorage)) if (key.startsWith('nomoto-')) window.sessionStorage.removeItem(key);
    } catch { /* 存储不可用时页面重建同样不带旧上下文 */ }
  };
  const rebuildShell = enter => {
    clearPageContext();
    // 页面模块会在 pagehide 时再存一次上下文；本监听晚于它们注册，最后再清一次。
    window.addEventListener('pagehide', clearPageContext, { once: true });
    window.location.hash = enter ? 'enter' : '';
    window.location.reload();
  };

  // 网页同源部署时用 location.origin；多控制台 App 由用户添加（不预置任何烧死的地址）。
  els.baseUrl.value = window.AutoloopConsoleBase || window.location.origin;
  const consoleBase = () => (hub.enabled
    ? hub.registry.current()
    : (window.AutoloopConsoleBase || els.baseUrl.value || window.location.origin));
  // 页面请求连不上控制台时立即探测；控制器在下方创建，这里按名字延迟引用。
  const onTransportError = () => { void reconnector?.onTransportError(); };
  const getClient = () => {
    const base = consoleBase();
    if (!client || clientBase !== base || clientTokens !== tokenStore) {
      client = createMobileClient({ base, state, tokenStore, onTransportError }); // 内部强制 HTTPS / 站点根校验
      clientBase = base;
      clientTokens = tokenStore;
    }
    return client;
  };

  const connectionLabel = () => ({
    connecting: '正在连接…',
    online: '已安全连接',
    offline: '网络已断开，等待重连',
    error: '连接异常，准备重试',
  })[state.connection] || '未连接';

  // ---- 路由与接缝 ----
  const hooks = createDefaultHooks();
  hooks.consoles = {
    get available() { return hub.enabled; },
    list() {
      if (hub.enabled) return hub.registry.list();
      try {
        const origin = new URL(consoleBase()).origin;
        return state.token ? [{ origin, name: new URL(origin).host, current: true }] : [];
      } catch { return []; }
    },
    current() { return hub.enabled ? hub.registry.current() : null; },
    switchConsole: origin => selectConsole(origin),
    removeConsole: origin => removeConsole(origin),
    addConsole: () => startAddConsole(),
    subscribe(fn) { consoleListeners.add(fn); return () => consoleListeners.delete(fn); },
  };
  // 原生桥缺省时保持空操作；注入后只覆盖对应钩子，不改其他节点的实现。
  if (window.AutoloopHaptics && typeof window.AutoloopHaptics.tap === 'function') hooks.haptic = window.AutoloopHaptics;
  if (window.AutoloopDownload && typeof window.AutoloopDownload.start === 'function') {
    hooks.download = (url, name) => window.AutoloopDownload.start(url, name);
  }
  const stack = createViewStack();
  const guard = createBackGuard();
  const ctx = {
    // 多控制台下还没有当前控制台（首启添加前）时给 null，页面按「未连接」跳过请求，而不是在定时器里抛错。
    get client() { return hub.enabled && !hub.registry.current() ? null : getClient(); },
    state,
    hooks,
  };

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
    if (name === 'admin') hooks.admin?.onShow?.();
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

  for (const name of MOBILE_PAGES) PAGE_MODULES[name].mount(ctx);
  selectTab('core');

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

  // ---- 首屏控制台列表（console-picker）与重连页（reconnect）：运行时创建，文本一律 textContent ----
  const make = (tag, props = {}, text) => {
    const el = document.createElement(tag);
    Object.assign(el, props);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const picker = make('div', { id: 'console-picker', className: 'card', hidden: true });
  const pickerList = make('div', { id: 'console-picker-list' });
  const pickerAdd = make('button', { id: 'console-add', type: 'button' }, '＋ 添加新控制台（填地址 / 扫码）');
  const pickerError = make('p', { id: 'console-picker-error', className: 'status error' });
  pickerError.setAttribute('role', 'alert');
  picker.append(make('h2', {}, '选择控制台'), make('p', { className: 'hint' }, '解锁一次，管理全部已绑定的控制台'), pickerList, pickerAdd, pickerError);
  els.unlockCard.after(picker);
  const addCancel = make('button', { id: 'console-add-cancel', type: 'button', hidden: true }, '返回控制台列表');
  els.bindCard.append(addCancel);

  const reconnectBanner = make('p', { id: 'reconnect-banner', className: 'reconnect-banner', hidden: true });
  reconnectBanner.setAttribute('role', 'status');
  const reconnectPanel = make('div', { id: 'reconnect-panel', className: 'reconnect-panel card', hidden: true });
  const reconnectNow = make('button', { id: 'reconnect-now', type: 'button', className: 'primary' }, '立即重试');
  reconnectPanel.append(
    make('p', { className: 'reconnect-error' }, '长时间连不上：已切换到中台不可达。原页面状态已保留。'),
    reconnectNow,
    make('p', { className: 'hint' }, '恢复后自动回到原来的页面，不停留在错误页。'),
  );
  const contentEl = document.querySelector('.content');
  if (contentEl) { contentEl.before(reconnectBanner); contentEl.before(reconnectPanel); }

  function renderPicker() {
    pickerError.textContent = '';
    settingsPage.renderConsoleList(pickerList, {
      consoles: hub.enabled ? hub.registry.list() : [],
      onSelect: origin => { void selectConsole(origin).catch(error => { pickerError.textContent = error?.message || '切换失败，请重试'; }); },
    });
  }

  function render() {
    const screen = bootScreen({
      hub: hub.enabled, phase: state.phase,
      bound: Boolean(state.token) && !state.needsBind,
      consoles: hub.enabled ? hub.registry.list().length : 0,
      entered: hub.entered, adding: hub.adding, storageFailed: hub.storageFailed,
    });
    const showMain = screen === 'main' && state.canShowMain();
    els.lockScreen.hidden = showMain;
    els.appMain.hidden = !showMain;
    // 锁屏几态：添加（绑定）卡 / 解锁卡 / 控制台列表，同一时刻只显示一块。
    els.bindCard.hidden = screen !== 'bind';
    els.unlockCard.hidden = screen !== 'unlock';
    picker.hidden = screen !== 'picker';
    if (screen === 'picker') renderPicker();
    addCancel.hidden = !(hub.enabled && hub.adding && state.canShowMain() && hub.registry.list().length > 0);
    // 重连：在线以外显示状态条；退避走完仍连不上才进重连页（只隐藏页面本体，不销毁，恢复即回原页）。
    const view = reconnector.view();
    // 首次连接中不算重连；失败过（error/offline）或第二次起的探测才显示「重连中」。
    const reconnecting = showMain && !state.needsBind && view.connection !== 'online'
      && (view.connection !== 'connecting' || view.attempt > 1);
    reconnectBanner.hidden = !reconnecting;
    reconnectBanner.textContent = reconnecting ? reconnectStatusText(view) : '';
    reconnectPanel.hidden = !(reconnecting && view.unreachable);
    if (contentEl) contentEl.hidden = !reconnectPanel.hidden;
    els.bindStatus.textContent = bindMessage;
    els.lockError.textContent = state.lockError || '';
    els.deviceName.textContent = state.device?.name || '未绑定设备';
    els.connectionStatus.textContent = connectionLabel();
    els.connectionStatus.dataset.state = state.connection;
    els.connectionError.textContent = ['error', 'offline'].includes(state.connection) ? (state.error || '') : '';
    els.unlock.disabled = state.phase === 'unlocking';
    renderViewState();
  }

  // 连接探测与断联重连统一交给控制器：退避自动重连、回前台立即探测、页面请求失败立即探测、在线心跳；
  // 地址非法/授权失效/未绑定不排重试（shouldAutoRetry）。401 由 session() 清凭证回锁定。
  const reconnect = () => { reconnector.start(); return reconnector.attempt(); };
  const cancelRetry = () => reconnector.stop();

  // 手工粘贴与扫码共用同一条绑定路径：一次性载荷只在内存里流转，不写日志/存储。
  // 多控制台：添加 = 在该地址上绑定；绑定成功才写入清单（地址非法/不可达不写入，就地报错）。
  async function bindHubConsole(payloadText) {
    const wasUnlocked = state.canShowMain();
    await hub.registry.addConsole({ base: els.baseUrl.value }, (origin, consoleTokens) =>
      createMobileClient({ base: origin, state, tokenStore: consoleTokens })
        .bind(payloadText, els.bindName.value || 'Android 设备', 'Android'));
    notifyConsoles();
    if (wasUnlocked) {
      // 已解锁时添加：新控制台即当前，整页重建连接上下文并直接进入，免重复生物识别。
      rebuildShell(true);
      return '绑定成功，正在切换到新控制台…';
    }
    tokenStore = hub.registry.tokenStoreFor(hub.registry.current());
    if (!hub.booted) hub.booted = hub.registry.current(); // 首启：本页还没连过任何控制台，无需重建
    hub.adding = false;
    hub.enterAfterUnlock = true;
    return '绑定成功，请通过生物识别解锁';
  }

  async function doBind(payloadText) {
    els.bindSubmit.disabled = true;
    bindMessage = '';
    render();
    try {
      if (hub.enabled) bindMessage = await bindHubConsole(payloadText);
      else {
        await getClient().bind(payloadText, els.bindName.value || 'Android 设备', 'Android');
        bindMessage = '绑定成功，请通过生物识别解锁';
      }
      els.bindPayload.value = ''; // 一次性二维码内容不留在输入框里
      hub.storageFailed = false;
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
      if (hub.enabled) {
        void hub.storage.markSessionUnlocked(true);
        if (hub.enterAfterUnlock) { hub.enterAfterUnlock = false; await enterConsole(hub.registry.current()); return; }
        render(); // 解锁后首屏 = 控制台列表
        return;
      }
      render();
      await reconnect();
    } catch (error) {
      state.unlockFailure(error?.message || '生物识别不可用，请在已安装的 App 内打开');
      render();
    }
  });

  els.reconnect.addEventListener('click', () => { void reconnect().catch(() => {}); });
  reconnectNow.addEventListener('click', () => { void reconnector.manualRetry().catch(() => {}); });
  els.rebind.addEventListener('click', () => {
    void (async () => {
      cancelRetry();
      await tokenStore.clear();
      state.clearToken();
      state.lock();
      state.connection = 'offline';
      state.error = null;
      state.lockError = '已退出绑定，请重新扫码绑定';
      bindMessage = '';
      if (hub.enabled) {
        hub.entered = false;
        void hub.storage.markSessionUnlocked(false);
        if (hub.registry.current()) els.baseUrl.value = hub.registry.current();
        hub.adding = true;
      }
      render();
    })().catch(() => {});
  });

  // ---- 多控制台动作（首屏列表与设置页共用）----
  // 进入某台控制台：凭证不在位（被解除授权或读失败）回添加页并预填地址；不是本页当前构建的控制台则整页重建。
  async function enterConsole(origin) {
    if (!origin) { hub.adding = true; render(); return; }
    let token = null;
    try { token = await hub.registry.tokenStoreFor(origin).get(); }
    catch { hub.storageFailed = true; }
    if (!token) {
      els.baseUrl.value = origin;
      hub.adding = true;
      bindMessage = hub.storageFailed ? '安全存储读写失败，请重新添加控制台' : '该控制台需要重新扫码绑定';
      render();
      return;
    }
    if (origin !== hub.booted) {
      await hub.registry.selectConsole(origin);
      rebuildShell(true);
      return;
    }
    tokenStore = hub.registry.tokenStoreFor(origin);
    state.setToken(token);
    hub.entered = true;
    hub.adding = false;
    reconnector.start();
    render();
    await reconnect();
  }
  async function selectConsole(origin) {
    if (!hub.enabled) return;
    if (hub.entered && origin === hub.registry.current()) return; // 已在使用中
    await enterConsole(origin);
  }
  async function removeConsole(origin) {
    if (!hub.enabled) return;
    const wasCurrent = origin === hub.registry.current();
    await hub.registry.removeConsole(origin);
    notifyConsoles();
    // 移除正在使用的控制台：重建页面回到控制台列表（没有剩余时引导添加）；移除其他控制台只刷新列表。
    if (wasCurrent && hub.entered) { rebuildShell(false); return; }
    render();
  }
  function startAddConsole() {
    if (!hub.enabled) return;
    els.baseUrl.value = '';
    bindMessage = '';
    hub.adding = true;
    render();
  }
  pickerAdd.addEventListener('click', startAddConsole);
  addCancel.addEventListener('click', () => { hub.adding = false; bindMessage = ''; render(); });

  const reconnector = createReconnectController({
    state,
    probe: () => getClient().session(),
    onChange: () => {
      // 授权失效（401）：该控制台凭证已清，撤销会话解锁标记，回锁定后需重新验证与绑定。
      if (hub.enabled && state.needsBind && hub.entered) {
        hub.entered = false;
        void hub.storage.markSessionUnlocked(false);
      }
      render();
    },
    // 恢复原页：重连页只隐藏页面本体，不清栈不切 Tab；恢复后按原栈与 Tab 重画，回到原来的页面。
    resumePage: () => renderViewState(),
    isVisible: () => document.visibilityState !== 'hidden',
  });
  attachReconnectLifecycle({ win: window, doc: document, controller: reconnector });

  render();

  // 重启 App：安全存储里已有设备凭证时恢复「已绑定」状态，显示解锁卡而不是再次要求绑定。
  // 在 Capacitor 里原生桥可能稍晚注入，最多等约 3 秒；读不到凭证才保持绑定页。
  // 多控制台：App 内有按键安全存储（原生插件，或回归注入的等价假桥 AutoloopConsoleStorage）时启用。
  const keyedPlugin = () => window.AutoloopConsoleStorage || window.Capacitor?.Plugins?.AutoloopSecureStorage || null;
  void (async () => {
    const inApp = Boolean(window.Capacitor);
    for (let i = 0; inApp && !window.AutoloopSecureStorage && !keyedPlugin() && i < 15; i++) await new Promise(r => setTimeout(r, 200));
    const keyed = createKeyedSecureStorage(keyedPlugin());
    if (keyed && !state.token) {
      hub.enabled = true;
      hub.storage = keyed;
      hub.registry = createConsoleRegistry({ storage: keyed });
      els.baseUrl.value = ''; // 不预置烧死的地址：首启引导用户填写或扫码
      try {
        await hub.registry.load();
        hub.booted = hub.registry.current();
        if (hub.booted) {
          tokenStore = hub.registry.tokenStoreFor(hub.booted);
          const stored = await tokenStore.get();
          if (typeof stored === 'string' && stored) state.setToken(stored);
        }
      } catch {
        hub.storageFailed = true; // 凭证读写失败 fail-closed 回添加页
        bindMessage = '安全存储读写失败，请重新添加控制台';
      }
      notifyConsoles();
      // 切换控制台的整页重建：原生进程内会话已解锁时免重复生物识别，直接进入目标控制台。
      if (!hub.storageFailed && hub.registry.list().length && await keyed.sessionUnlocked()) {
        state.unlockSuccess();
        if (enterRequested) { await enterConsole(hub.registry.current()); return; }
      }
      render();
      return;
    }
    if (state.token) return; // 等待期间用户已手动绑定
    const stored = await tokenStore.get();
    if (typeof stored === 'string' && stored) { state.setToken(stored); render(); }
  })().catch(() => {});
}

if (typeof document !== 'undefined') boot();
