// 移动端 App 壳：只做路由与装配。业务逻辑在 mobile/src（视图模型）与 pages/（页面模块）。
// 页面模块按固定列表静态 import；各页导出 mount(ctx)，ctx 含 client / state / hooks。
// 跨页互调一律走 ctx.hooks，不直接 import 其他页面模块。
import { ShellState, createTokenStore, createMobileClient, createBiometricGate, shouldAutoRetry } from './shell.mjs';
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

export const MOBILE_PAGES = Object.freeze([
  'core', 'sessions', 'artifacts', 'dag', 'project-filter', 'notify', 'voice', 'font-touch', 'devices',
]);
const PAGE_MODULES = {
  core: corePage, sessions: sessionsPage, artifacts: artifactsPage, dag: dagPage,
  'project-filter': projectFilterPage, notify: notifyPage, voice: voicePage,
  'font-touch': fontTouchPage, devices: devicesPage,
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

  const tabBar = $('tab-bar');
  const tabs = tabBar ? [...tabBar.querySelectorAll('.tab')] : [];
  const pageEls = new Map([...document.querySelectorAll('.content .page')].map(el => [el.dataset.page, el]));
  let activeTab = 'core';
  const renderViewState = () => {
    els.appMain.dataset.activeTab = activeTab;
    els.appMain.dataset.viewDepth = String(stack.depth);
  };
  function selectTab(name) {
    if (!pageEls.has(name)) return;
    activeTab = name;
    stack.clear();
    guard.reset();
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const [key, el] of pageEls) el.hidden = key !== name;
    renderViewState();
  }
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
    els.connectionStatus.textContent = connectionLabel();
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
      render();
    })().catch(() => {});
  });

  window.addEventListener('offline', () => { cancelRetry(); state.networkLost(); render(); });
  window.addEventListener('online', () => {
    if (!state.canShowMain()) return;
    state.networkRestored();
    void reconnect().catch(() => {});
  });

  render();

  // 重启 App：安全存储里已有设备凭证时恢复「已绑定」状态，显示解锁卡而不是再次要求绑定。
  // 在 Capacitor 里原生桥可能稍晚注入，最多等约 3 秒；读不到凭证才保持绑定页。
  void (async () => {
    const inApp = Boolean(window.Capacitor);
    for (let i = 0; inApp && !window.AutoloopSecureStorage && i < 15; i++) await new Promise(r => setTimeout(r, 200));
    if (state.token) return; // 等待期间用户已手动绑定
    const stored = await tokenStore.get();
    if (typeof stored === 'string' && stored) { state.setToken(stored); render(); }
  })().catch(() => {});
}

if (typeof document !== 'undefined') boot();
