// 移动端壳的 DOM 装配：把 shell.mjs 的状态机接到页面上。
// 只更新已有节点的 textContent / hidden / dataset，不整块重建 DOM（避免触控与刷新竞态）。
import { ShellState, createTokenStore, createMobileClient, createBiometricGate } from './shell.mjs';

function boot() {
  const $ = id => document.getElementById(id);
  const els = {
    lockScreen: $('lock-screen'), appMain: $('app-main'),
    baseUrl: $('base-url'), bindName: $('bind-name'), bindPayload: $('bind-payload'), bindSubmit: $('bind-submit'), bindStatus: $('bind-status'),
    unlock: $('unlock'), lockError: $('lock-error'),
    deviceName: $('device-name'), connectionStatus: $('connection-status'),
    connectionError: $('connection-error'), reconnect: $('reconnect'), rebind: $('rebind'),
  };

  const state = new ShellState();
  // 原生桥由 Android App（Capacitor 插件）注入；网页回归注入等价的假桥。
  const secureStorage = window.AutoloopSecureStorage || null;
  const tokenStore = createTokenStore({ secureStorage });
  const biometric = createBiometricGate({ bridge: window.AutoloopBiometric || null });
  let client = null;
  let clientBase = null;
  let retryTimer = null;
  let bindMessage = '';

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

  function render() {
    const unlocked = state.canShowMain();
    els.lockScreen.hidden = unlocked;
    els.appMain.hidden = !unlocked;
    els.bindStatus.textContent = bindMessage;
    els.lockError.textContent = state.lockError || '';
    els.deviceName.textContent = state.device?.name || '未绑定设备';
    els.connectionStatus.textContent = connectionLabel();
    els.connectionStatus.dataset.state = state.connection;
    els.connectionError.textContent = ['error', 'offline'].includes(state.connection) ? (state.error || '') : '';
    els.unlock.disabled = state.phase === 'unlocking';
  }

  async function reconnect() {
    cancelRetry();
    state.retry();
    render();
    try {
      await getClient().session();
      render();
    } catch (error) {
      // 客户端构建（地址校验）在 session 之前失败时，也要给出可读错误而不是停在「正在连接」。
      if (state.connection === 'connecting') state.connectFailure(error?.message || '连接失败，请重试');
      render();
      // 授权失效/未绑定时不自动重试；网络恢复与手动按钮才是重连入口。
      if (state.needsBind || state.connection !== 'error') return;
      scheduleRetry(state.nextRetryDelay());
    }
  }

  els.bindSubmit.addEventListener('click', async () => {
    els.bindSubmit.disabled = true;
    bindMessage = '';
    render();
    try {
      await getClient().bind(els.bindPayload.value, els.bindName.value || 'Android 设备', 'Android');
      els.bindPayload.value = ''; // 一次性二维码内容不留在输入框里
      bindMessage = '绑定成功，请通过生物识别解锁';
      state.lockError = null;
      render();
    } catch (error) {
      bindMessage = error?.message || '绑定失败，请检查二维码是否有效或已过期';
      render();
    } finally {
      els.bindSubmit.disabled = false;
    }
  });

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
}

if (typeof document !== 'undefined') boot();
