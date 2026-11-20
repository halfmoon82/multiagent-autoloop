// 通知接线纯逻辑：把 notifications 契约生成的 descriptor 交给原生 AutoloopNotify 桥，
// 并负责去重、角标、直复回写与授权失效停服。无 DOM、无 Node 内置模块，浏览器与 Node 都可导入。
// 内容/去重/冷却的权威口径在 contract.mjs，这里不新建第二套通知状态。
import {
  buildTodoNotification, buildNodeDoneNotification, isNotifiableNodeEvent, badgeCount,
} from './contract.mjs';

export const NOTIFY_PREFERENCE_KEY = 'autoloop.notify.enabled';
export const NOTIFY_INTERVAL_MS = 15000;
export const REPLY_CALLBACK_NAME = 'AutoloopNotifyReply';
const NOTIFY_ENABLED_DEFAULT = true;

const str = value => String(value ?? '');
function parseEnabled(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

// 通知偏好存 AutoloopSecureStorage：只认带 key 的键值接口，单值设备令牌存储一律不写，
// 避免把设备凭证槽覆盖成开关值。宿主不支持键值或写入失败时仅保留本次会话内存值。
export function createNotifyPreference({ storage = null } = {}) {
  let memory = null;
  const keyed = Boolean(storage && typeof storage.get === 'function' && typeof storage.set === 'function'
    && storage.get.length > 0);
  return {
    get keyed() { return keyed; },
    async get() {
      if (keyed) {
        try {
          const parsed = parseEnabled(await storage.get(NOTIFY_PREFERENCE_KEY));
          if (parsed !== null) return parsed;
        } catch { /* 读取失败沿用内存值 */ }
      }
      return memory === null ? NOTIFY_ENABLED_DEFAULT : memory;
    },
    async set(enabled) {
      memory = Boolean(enabled);
      if (keyed) {
        try { await storage.set(NOTIFY_PREFERENCE_KEY, memory ? '1' : '0'); }
        catch { /* 持久化失败不影响本次会话 */ }
      }
      return memory;
    },
  };
}

export function createNotifyBridge({
  bridge = null,
  preference = createNotifyPreference(),
  getDeviceToken = async () => null,
  getBaseUrl = () => '',
  intervalMs = NOTIFY_INTERVAL_MS,
  onRefresh = null,
} = {}) {
  const notified = new Set();
  const descriptors = new Map();
  let started = false;
  let enabled = null;

  const api = bridge && typeof bridge === 'object' ? bridge : null;
  const has = method => Boolean(api && typeof api[method] === 'function');
  const call = (method, ...args) => {
    if (!has(method)) return undefined;
    try { return api[method](...args); }
    catch { return undefined; } // 桥调用失败静默降级，不影响 App 主流程
  };

  return {
    get available() { return has('start') && has('notify') && has('setBadge'); },
    get started() { return started; },
    get enabled() { return enabled; },
    get notifiedKeys() { return [...notified]; },

    async loadEnabled() { enabled = await preference.get(); return enabled; },
    async setEnabled(value) {
      enabled = await preference.set(value);
      if (!enabled) this.stop();
      return enabled;
    },

    // 解锁连上后把设备令牌、间隔与控制台基址交给原生服务；未绑定/关闭偏好不启动。
    async start(options = {}) {
      if (!has('start') || enabled === false) return false;
      if (started) return true; // 定时器每轮都调 start：已启动就不重复拉起前台服务
      const token = options.deviceToken ?? await getDeviceToken();
      if (!token) return false;
      const payload = {
        deviceToken: str(token),
        intervalMs: Number.isFinite(options.intervalMs) ? options.intervalMs : intervalMs,
        baseUrl: str(options.baseUrl ?? getBaseUrl()),
      };
      call('start', JSON.stringify(payload));
      started = true;
      return true;
    },

    stop() {
      if (!started) return false;
      call('stop');
      started = false;
      return true;
    },

    // 授权失效（401）：无条件停服并清空去重，重新绑定后才下发新令牌并重新提醒。
    handleUnauthorized() {
      call('stop');
      started = false;
      notified.clear();
      descriptors.clear();
      return true;
    },

    // 同一 kind:id:revision 只通知一次；descriptor 由契约生成，凭证不进通知载荷。
    publish(descriptor) {
      if (!descriptor || !descriptor.key || !has('notify')) return false;
      if (notified.has(descriptor.key)) return false;
      notified.add(descriptor.key);
      // 直复回传的是 cardId，通知撤销用的是 descriptor.id，两者都要能定位同一 descriptor。
      if (descriptor.id) descriptors.set(str(descriptor.id), descriptor);
      if (descriptor.click?.cardId !== undefined && descriptor.click?.cardId !== null) {
        descriptors.set(str(descriptor.click.cardId), descriptor);
      }
      call('notify', JSON.stringify(descriptor));
      return true;
    },
    publishCard(card) { return this.publish(buildTodoNotification(card)); },
    publishNodeDone(event) {
      if (!isNotifiableNodeEvent(event)) return false;
      return this.publish(buildNodeDoneNotification(event));
    },

    // 拉取一次状态：开放待办各一条、成功完成节点各一条，角标按开放待办数同步。
    syncCards(cards, events = []) {
      const open = (Array.isArray(cards) ? cards : []).filter(card => str(card?.state).trim() === 'open');
      let sent = 0;
      for (const card of open) if (this.publishCard(card)) sent += 1;
      for (const event of (Array.isArray(events) ? events : [])) if (this.publishNodeDone(event)) sent += 1;
      this.setBadge(badgeCount(open));
      return sent;
    },

    // 锁屏直复：撤销对应系统通知、回调 App 刷新本地状态；去重键保留，避免刷新后重发同一事项。
    onReply(cardId, answer) {
      const id = str(cardId);
      const descriptor = descriptors.get(id);
      if (!descriptor) return false;
      call('cancel', str(descriptor.id)); // 原生按 descriptor.id 撤销通知
      descriptors.delete(id);
      if (typeof onRefresh === 'function') {
        try { onRefresh({ cardId: id, answer, descriptor }); }
        catch { /* 刷新失败不影响直复回执 */ }
      }
      return true;
    },

    setBadge(count) {
      const value = Number(count);
      return call('setBadge', Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
    },

    // onReply 在原生侧接收的是回调名，不是函数本体；用安全 JS 标识符注册全局回调。
    registerReply(win, callbackName = REPLY_CALLBACK_NAME) {
      if (!has('onReply') || !win || typeof win !== 'object') return false;
      win[callbackName] = (cardId, answer) => this.onReply(cardId, answer);
      call('onReply', callbackName);
      return true;
    },
    unregisterReply(win, callbackName = REPLY_CALLBACK_NAME) {
      if (win && typeof win === 'object') delete win[callbackName];
    },
  };
}
