// 通知接线挂载点（DAG 节点 notify-wiring）：不对应 Tab，由 app.mjs 装配阶段 mount 一次。
// 解锁连上后把设备令牌/间隔交给原生服务 start，覆盖 ctx.hooks.notify，直复回写 App 状态。
// 只改本文件；内容/去重/角标契约在 ../src/features/notifications（纯逻辑），跨页互调一律走 ctx.hooks。
const loadViewModel = typeof window === 'undefined'
  ? () => import('../../../src/features/notifications/index.mjs')
  : () => import('../src/features/notifications/index.mjs');

export { loadViewModel };

const str = value => String(value ?? '');
const CHECK_MS = 1200;
const REFRESH_MIN_MS = 5000; // 页面钩子触发的刷新节流：各页加载常连发多次，只留一次真请求

/** 挂载点。ctx 含 client / state / hooks；其余参数仅供测试注入，浏览器走默认。 */
export function mount(ctx, {
  doc = globalThis.document,
  win = globalThis.window,
  feature,
  setTimer = setInterval,
  clearTimer = clearInterval,
  checkMs = CHECK_MS,
  now = Date.now,
} = {}) {
  if (!ctx || !doc || !ctx.hooks) return () => {};
  const root = doc.getElementById('notify-root');
  if (!root) return () => {};

  if (feature) return setup(ctx, doc, win, root, feature, { setTimer, clearTimer, checkMs, now });

  let disposed = false;
  let detach = () => {};
  const loaded = loadViewModel();
  if (loaded && typeof loaded.then === 'function') {
    loaded.then(mod => {
      if (!disposed && mod) detach = setup(ctx, doc, win, root, mod, { setTimer, clearTimer, checkMs, now });
    }).catch(() => {});
  } else if (loaded) {
    detach = setup(ctx, doc, win, root, loaded, { setTimer, clearTimer, checkMs, now });
  }
  return () => { disposed = true; detach(); };
}

function setup(ctx, doc, win, root, F, { setTimer, clearTimer, checkMs, now }) {
  const hooks = ctx.hooks || {};
  const {
    createNotifyBridge, createNotifyPreference,
    REPLY_CALLBACK_NAME = 'AutoloopNotifyReply',
  } = F;
  if (typeof createNotifyBridge !== 'function') return () => {};

  const preference = createNotifyPreference({ storage: win?.AutoloopSecureStorage || null });
  const controller = createNotifyBridge({
    bridge: win?.AutoloopNotify || null,
    preference,
    getDeviceToken: async () => {
      const store = ctx.client?.tokenStore;
      return store && typeof store.get === 'function' ? await store.get() : null;
    },
    getBaseUrl: () => str(win?.AutoloopConsoleBase || win?.location?.origin || ''),
    onRefresh: () => { void refreshState({ force: true }); },
  });

  let enabled = true;
  void preference.get().then(value => { enabled = value !== false; render(); }).catch(() => {});

  // 解锁且安全连上才启动常驻服务；断线、未绑定或关闭偏好都停服，401 由 refresh 单独处理。
  const syncService = async () => {
    const state = ctx.state || {};
    const unlocked = typeof state.canShowMain === 'function' ? state.canShowMain() : false;
    const online = str(state.connection).trim() === 'online';
    const revoked = state.needsBind === true;
    if (revoked) { controller.handleUnauthorized(); return false; } // 401/重绑：无条件停服并清去重
    if (enabled === false || !unlocked || !online) { controller.stop(); return false; }
    return controller.start();
  };

  // 刷新 App 内状态：复用固定只读 API，按契约生成通知并同步角标；授权失效立即停服。
  let lastRefresh = -Infinity;
  const refreshState = async ({ force = false } = {}) => {
    if (typeof ctx.client?.api !== 'function') return;
    if (!force && now() - lastRefresh < REFRESH_MIN_MS) return;
    // 未解锁或授权已失效时不再发请求，避免对已撤销的设备再打一次 401。
    const current = ctx.state || {};
    if (current.needsBind === true) return;
    if (typeof current.canShowMain === 'function' && !current.canShowMain()) return;
    lastRefresh = now();
    try {
      const state = await ctx.client.api('state');
      controller.syncCards(state?.cards, state?.nodeEvents);
    } catch (error) {
      if (error?.status === 401) controller.handleUnauthorized();
    }
  };

  // 与已有钩子串联而非覆盖：先前挂的 setBadge/refresh（含外部包装）继续生效。
  const prev = hooks.notify && typeof hooks.notify === 'object' ? hooks.notify : {};
  hooks.notify = {
    ...prev,
    setBadge: count => { try { prev.setBadge?.(count); } catch { /* 前序钩子失败不影响原生角标 */ } return controller.setBadge(count); },
    refresh: () => { try { prev.refresh?.(); } catch { /* 同上 */ } return refreshState(); },
    publishCard: card => controller.publishCard(card),
    publishNodeDone: event => controller.publishNodeDone(event),
    start: () => syncService(),
    stop: () => controller.stop(),
    handleUnauthorized: () => controller.handleUnauthorized(),
  };

  // 设置开关：偏好存安全存储（带 key 的接口），切换后立刻同步常驻服务状态。
  function render() {
    const toggle = doc.createElement('button');
    toggle.setAttribute('type', 'button');
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.textContent = enabled ? '系统通知：已开启' : '系统通知：已关闭';
    toggle.addEventListener('click', async () => {
      enabled = await preference.set(!enabled);
      await syncService();
      render();
    });
    root.replaceChildren(toggle);
  }
  render();

  controller.registerReply(win, REPLY_CALLBACK_NAME);
  const handle = setTimer(() => syncService(), checkMs);
  return () => {
    clearTimer(handle);
    controller.unregisterReply(win, REPLY_CALLBACK_NAME);
    controller.stop();
  };
}
