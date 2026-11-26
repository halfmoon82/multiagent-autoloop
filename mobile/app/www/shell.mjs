// 移动端 App 壳的纯逻辑：安全连接、设备级授权、生物识别门禁、断线重连与固定 API 中继。
// 本模块不碰 DOM、不碰浏览器存储，可在 Node 里直接做边界测试；DOM 装配在 app.mjs。
// 设计基线：docs/2026-11-18-mobile-device-admin-spec.md §5；不复制网页控制台业务状态。

export class MobileShellError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MobileShellError';
    this.code = code;
  }
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// 远程访问必须使用 HTTPS 站点根地址；仅本机回环允许 http（本地开发与回归用）。
// 不接受 userinfo、路径、查询、片段或任意 scheme，避免把控制台地址变成开放代理或钓鱼入口。
export function normalizeBaseUrl(raw, { allowLocalHttp = true } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new MobileShellError('INVALID_BASE', '请填写控制台地址');
  let parsed;
  try { parsed = new URL(raw.trim()); }
  catch { throw new MobileShellError('INVALID_BASE', '控制台地址不是有效的网址'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new MobileShellError('INSECURE_BASE', '控制台地址必须使用 HTTPS');
  if (parsed.username || parsed.password) throw new MobileShellError('INVALID_BASE', '控制台地址不能包含账号密码');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new MobileShellError('INVALID_BASE', '控制台地址只能是站点根地址');
  const local = allowLocalHttp && LOCAL_HOSTNAMES.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !local) throw new MobileShellError('INSECURE_BASE', '远程访问必须使用 HTTPS');
  return parsed.origin;
}

// 服务端 /api/mobile/api/<key> 的固定允许列表。移动端只能中继既定只读控制台 API，
// 不代理任意 URL；设备授权管理（/api/devices）只对网页管理后台开放，绝不出现在这里。
export const MOBILE_API_KEYS = Object.freeze([
  'state', 'projects', 'rules', 'dag-runs', 'archive', 'closeouts', 'detours', 'serial-progress', 'project-usage',
  'sessions', 'session-archives',
]);

export function mobileSessionUrl(base) { return new URL('/api/mobile/session', base).toString(); }
export function mobileBindUrl(base) { return new URL('/api/mobile/bind', base).toString(); }
export function mobileArtifactsUrl(base) { return new URL('/api/mobile/artifacts', base).toString(); }
export function mobileSessionArtifactsUrl(base, id) {
  const raw = String(id ?? '').trim();
  if (!raw) throw new MobileShellError('SESSION_NOT_FOUND', '会话不存在或已归档');
  return new URL('/api/mobile/sessions/' + encodeURIComponent(raw) + '/artifacts', base).toString();
}
export function mobilePreviewTicketUrl(base, id) {
  const raw = String(id ?? '').trim();
  if (!raw) throw new MobileShellError('SESSION_NOT_FOUND', '会话不存在或已归档');
  return new URL('/api/mobile/sessions/' + encodeURIComponent(raw) + '/preview-ticket', base).toString();
}

export function mobileSessionArtifactFileUrl(base, id, path) {
  const raw = String(id ?? '').trim();
  if (!raw) throw new MobileShellError('SESSION_NOT_FOUND', '会话不存在或已归档');
  const url = new URL('/api/mobile/sessions/' + encodeURIComponent(raw) + '/file', base);
  url.searchParams.set('path', String(path ?? ''));
  return url.toString();
}
export function mobileApiUrl(base, key) {
  if (typeof key !== 'string' || !MOBILE_API_KEYS.includes(key)) {
    throw new MobileShellError('API_NOT_ALLOWED', `该 API 不在移动端允许列表中：${String(key)}`);
  }
  return new URL(`/api/mobile/api/${key}`, base).toString();
}

// 设备绑定结果：网页管理后台生成的一次性二维码载荷。严格格式，拒绝夹带其他参数或任意链接。
// 既接受完整载荷，也接受从后台复制出来的裸 64hex（自动补前缀）；前后空白一并去掉。
// 载荷内容绝不写进报错或日志，避免一次性凭证外泄。
export function parseBindPayload(text) {
  if (typeof text !== 'string') throw new MobileShellError('INVALID_BIND', '请粘贴完整的绑定二维码内容');
  const value = text.trim();
  const full = /^autoloop:\/\/bind\?token=([0-9a-f]{64})$/.exec(value);
  const bare = /^([0-9a-f]{64})$/.exec(value);
  const token = full?.[1] || bare?.[1];
  // 沿用扫码解析与各处回归共用的固定安全提示；不复述载荷原文，避免一次性凭证外泄。
  if (!token) throw new MobileShellError('INVALID_BIND', '请粘贴完整的绑定二维码内容（autoloop://bind?token=…）');
  return token;
}

// 设备凭证存储：优先用 App 注入的原生安全存储（Android Keystore / Capacitor Preferences）。
// 没有原生桥时只放内存，绝不写入 localStorage / sessionStorage / DOM / 日志。
export function createTokenStore({ secureStorage = null } = {}) {
  let memory = null;
  const bridge = secureStorage && typeof secureStorage.get === 'function' ? secureStorage : null;
  return {
    get persistent() { return Boolean(bridge); },
    async get() { return bridge ? await bridge.get() : memory; },
    async set(token) { if (bridge && typeof bridge.set === 'function') await bridge.set(token); else memory = token; },
    async clear() { if (bridge && typeof bridge.remove === 'function') await bridge.remove(); else memory = null; },
  };
}

// 系统生物识别门禁：只认 App 注入的原生桥或测试注入的验证器。
// 没有任何可用生物识别时明确失败，绝不静默放行——「生物识别失败不进入主界面」。
export function createBiometricGate({ verifier = null, bridge = null } = {}) {
  return {
    async verify() {
      if (verifier) return Boolean(await verifier());
      const source = bridge || (typeof globalThis !== 'undefined' ? globalThis.AutoloopBiometric : null);
      if (source && typeof source.verify === 'function') {
        try { return Boolean(await source.verify()); }
        catch { return false; }
      }
      throw new MobileShellError('BIOMETRIC_UNAVAILABLE', '当前设备没有可用的系统生物识别，请在已安装的 App 内打开');
    },
  };
}

// 壳状态机：生物识别门禁与连接状态互相独立。主界面只在 phase === 'unlocked' 时可显示；
// 只有 401（设备授权失效）才清除凭证、回锁定并要求重新绑定。
// 403 可能是转发层误传 x-forwarded-proto 的传输问题，不是授权失效，不能逼已授权设备重绑。
export class ShellState {
  constructor({ backoffMs = [1000, 2000, 4000, 8000, 15000] } = {}) {
    this.backoffMs = backoffMs;
    this.phase = 'locked';
    this.connection = 'offline';
    this.lockError = null;
    this.error = null;
    this.device = null;
    this.token = null;
    this.needsBind = true;
    this.retryAttempt = 0;
    // 持续连不上（退避档位走完仍失败）才置位，由壳切到带「立即重试」的重连页；任何一次成功即清除。
    this.unreachable = false;
  }
  canShowMain() { return this.phase === 'unlocked'; }
  setToken(token) { this.token = token ?? null; this.needsBind = !this.token; }
  clearToken() { this.token = null; this.needsBind = true; this.device = null; }

  beginUnlock() { this.phase = 'unlocking'; this.lockError = null; }
  unlockSuccess(device = null) { this.phase = 'unlocked'; this.lockError = null; if (device) this.device = device; }
  unlockFailure(message = '生物识别未通过，请重试') { this.phase = 'locked'; this.lockError = message; }
  lock() { this.phase = 'locked'; }

  connectStart() { this.connection = 'connecting'; this.error = null; }
  connectSuccess(device = null) {
    this.connection = 'online'; this.error = null; this.retryAttempt = 0; this.unreachable = false;
    if (device) this.device = device;
  }
  connectFailure(message = '连接失败，请重试', status = null) {
    if (status === 401) { this.revokeDetected(message); return; }
    this.connection = 'error'; this.error = message;
  }
  revokeDetected(message = '设备授权已失效，请重新绑定') {
    this.clearToken();
    this.phase = 'locked'; this.connection = 'offline';
    this.error = message; this.lockError = message; this.retryAttempt = 0; this.unreachable = false;
  }
  networkLost() { this.connection = 'offline'; this.error = '网络已断开，等待网络恢复后自动重连'; }
  networkRestored() { this.error = null; this.retryAttempt = 0; return 0; }
  retry() {
    this.connection = 'connecting'; this.error = null;
    const delay = this.nextRetryDelay(); // 先按当前档位取退避，再推进计数，首次重连才用得到第一档。
    this.retryAttempt += 1;
    return delay;
  }
  nextRetryDelay() {
    const index = Math.min(Math.max(this.retryAttempt, 0), this.backoffMs.length - 1);
    return this.backoffMs[index];
  }
}

// 断线重连只对可自愈的临时错误排重试。地址非法/不安全是永久配置错误，自动重试只会空转；
// 授权失效（needsBind）、未绑定或离线态也都不排重试，由用户改地址/重绑与 online 事件接手。
export function shouldAutoRetry(error, state) {
  if (error instanceof MobileShellError && (error.code === 'INVALID_BASE' || error.code === 'INSECURE_BASE')) return false;
  if (state.needsBind) return false;
  return state.connection === 'error';
}

// 复制到剪贴板：旧鸿蒙 WebView 上 navigator.clipboard 常静默失败（2026-11-24 真机：
// 点复制毫无反应）。降级链：clipboard API → 隐藏 textarea + execCommand('copy')；全程返回是否成功。
export async function copyText(text, doc = globalThis.document) {
  const value = String(text ?? '');
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* 落下降级链 */ }
  try {
    if (!doc || typeof doc.createElement !== 'function') return false;
    const area = doc.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    (doc.body || doc.documentElement).appendChild(area);
    area.select();
    const ok = typeof doc.execCommand === 'function' && doc.execCommand('copy') === true;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

// 移动端客户端：所有请求都钉在固定路径上，设备凭证只放在 x-device-token 头里。
// onTransportError：任何请求连不上控制台（网络层失败）时回调，供断联重连控制器立即探测；
// 只上报「连不上」这一事实，不带 URL、凭证或响应内容。
export function createMobileClient({ base, state = new ShellState(), tokenStore = createTokenStore(), fetchImpl = null, onTransportError = null } = {}) {
  const origin = normalizeBaseUrl(base);
  const doFetch = fetchImpl || ((input, init) => globalThis.fetch(input, init));
  const request = async (url, { method = 'GET', body, token } = {}) => {
    // x-console-request 与服务端写路由校验同源：原生桥/DownloadManager 与 iframe 带不了自定义头，
    // 但 App 内所有 JSON 请求都走这里，统一打上控制台请求标记（否则新读路由一律 403 缺标记）。
    const headers = { accept: 'application/json', 'x-console-request': '1' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers['x-device-token'] = token;
    let response;
    try { response = await doFetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch {
      if (typeof onTransportError === 'function') { try { onTransportError(); } catch { /* 观察者异常不影响请求结果 */ } }
      throw new MobileShellError('NETWORK', '无法连接控制台，请检查网络或地址');
    }
    let payload = {};
    try { payload = await response.json(); } catch { /* 非 JSON 响应用通用错误文案 */ }
    if (!response.ok) {
      const error = new MobileShellError(`HTTP_${response.status}`, payload?.error || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  return {
    origin, state, tokenStore,
    async bind(payloadText, name = 'Android 设备', platform = 'Android') {
      const token = parseBindPayload(payloadText);
      let result;
      try {
        result = await request(mobileBindUrl(origin), { method: 'POST', body: { token, name, platform } });
      } catch (error) {
        // 服务端对过期的一次性码返回 410；设备端只给人话提示，不复述载荷内容或服务端原文。
        if (error.status === 410) throw new MobileShellError('BIND_EXPIRED', '绑定码已过期，请在电脑上重新生成');
        throw error;
      }
      if (typeof result?.deviceToken !== 'string' || !result.deviceToken) throw new MobileShellError('BIND_FAILED', '绑定失败：服务端未返回设备凭证');
      await tokenStore.set(result.deviceToken);
      state.setToken(result.deviceToken);
      return result;
    },
    async session() {
      const token = await tokenStore.get();
      if (!token) {
        const error = new MobileShellError('DEVICE_NOT_BOUND', '尚未绑定设备，请先扫码绑定');
        state.connectFailure(error.message);
        throw error;
      }
      try {
        const result = await request(mobileSessionUrl(origin), { token });
        state.connectSuccess(result.device || null);
        return result;
      } catch (error) {
        state.connectFailure(error.message, error.status ?? null);
        if (error.status === 401) await tokenStore.clear();
        throw error;
      }
    },
    async api(key) {
      const url = mobileApiUrl(origin, key); // 非法 key 在发请求前就抛错
      const token = await tokenStore.get();
      if (!token) throw new MobileShellError('DEVICE_NOT_BOUND', '尚未绑定设备，请先扫码绑定');
      return request(url, { token });
    },
    async artifacts() {
      const token = await tokenStore.get();
      if (!token) throw new MobileShellError('DEVICE_NOT_BOUND', '尚未绑定设备，请先扫码绑定');
      const result = await request(mobileArtifactsUrl(origin), { token });
      return Array.isArray(result?.files) ? result.files : [];
    },
    async sessionArtifacts(id) {
      const token = await tokenStore.get();
      if (!token) throw new MobileShellError('DEVICE_NOT_BOUND', '尚未绑定设备，请先扫码绑定');
      const result = await request(mobileSessionArtifactsUrl(origin, id), { token });
      return Array.isArray(result?.files) ? result.files : [];
    },
    async sessionArtifactFile(id, path) {
      const token = await tokenStore.get();
      if (!token) throw new MobileShellError('DEVICE_NOT_BOUND', '尚未绑定设备，请先扫码绑定');
      return request(mobileSessionArtifactFileUrl(origin, id, path), { token });
    },
    // A+ 预览：换一次性票据（服务端已校验文件存在），返回 { ticket, url }；iframe src=url。
    async sessionPreviewTicket(id, path) {
      const token = await tokenStore.get();
      if (!token) throw new MobileShellError('DEVICE_NOT_BOUND', '尚未绑定设备，请先扫码绑定');
      const url = new URL(mobilePreviewTicketUrl(origin, id));
      url.searchParams.set('path', String(path ?? ''));
      return request(url.toString(), { method: 'POST', body: {}, token });
    },
  };
}

// ---------------------------------------------------------------------------
// 多控制台（console-hub）：一个 App 连多台电脑上的中台。
// 数据源：原生安全存储（Android Keystore）按键分存——控制台清单、当前控制台、每台控制台的设备凭证
// （键 `<host>:device-token`，host 含端口）。清单只含地址与显示名，凭证绝不进 DOM / 日志 / 浏览器存储。
// 首屏控制台列表与设置页「当前控制台」区块共用同一份 registry 与同一组 select/add/remove 逻辑。

export const CONSOLES_KEY = 'consoles';
export const CURRENT_CONSOLE_KEY = 'current-console';

/** 每台控制台设备凭证的安全存储键：`<host>:device-token`（host 含端口，按控制台隔离）。 */
export function consoleTokenKey(origin) {
  return `${new URL(normalizeBaseUrl(origin)).host}:device-token`;
}

/**
 * 原生安全存储的按键访问适配器（Capacitor 插件 AutoloopSecureStorage 的 nativeGet/nativeSet/nativeRemove 带 key）。
 * fail-closed：插件拒绝或报存储不可用时一律抛 STORAGE_FAILED，由壳退回添加页，不在内存里假装成功。
 */
export function createKeyedSecureStorage(plugin) {
  if (!plugin || typeof plugin.nativeGet !== 'function') return null;
  const fail = () => new MobileShellError('STORAGE_FAILED', '安全存储读写失败，请重新添加控制台');
  const call = async (method, args) => {
    let result;
    try { result = await plugin[method](args); } catch { throw fail(); }
    if (result && result.error) throw fail();
    return result || {};
  };
  return {
    async get(key) { const r = await call('nativeGet', { key }); return typeof r.value === 'string' ? r.value : null; },
    async set(key, value) { await call('nativeSet', { key, value: String(value) }); },
    async remove(key) { await call('nativeRemove', { key }); },
    // 解锁一次管全部控制台：进程内存里的会话解锁标记（App 被杀即失效），切换控制台重建页面时免重复生物识别。
    async sessionUnlocked() {
      if (typeof plugin.nativeSessionGet !== 'function') return false;
      try { return Boolean((await plugin.nativeSessionGet())?.unlocked); } catch { return false; }
    },
    async markSessionUnlocked(unlocked) {
      if (typeof plugin.nativeSessionSet !== 'function') return;
      try { await plugin.nativeSessionSet({ unlocked: Boolean(unlocked) }); } catch { /* 标记失败只会多一次生物识别 */ }
    },
  };
}

const sameConsole = (a, b) => a === b;

/** 控制台清单：add（绑定成功才写入）/ select / remove，按 host 分 key 存凭证。 */
export function createConsoleRegistry({ storage }) {
  if (!storage || typeof storage.get !== 'function') throw new TypeError('createConsoleRegistry 需要按键访问的安全存储');
  let consoles = [];
  let current = null;
  let loaded = false;

  const persist = async () => {
    await storage.set(CONSOLES_KEY, JSON.stringify(consoles.map(({ origin, name }) => ({ origin, name }))));
    if (current) await storage.set(CURRENT_CONSOLE_KEY, current);
    else await storage.remove(CURRENT_CONSOLE_KEY);
  };

  const registry = {
    async load() {
      const raw = await storage.get(CONSOLES_KEY);
      let parsed = [];
      if (raw) {
        try { parsed = JSON.parse(raw); } catch { throw new MobileShellError('STORAGE_FAILED', '控制台清单已损坏，请重新添加控制台'); }
      }
      consoles = [];
      for (const item of Array.isArray(parsed) ? parsed : []) {
        try {
          const origin = normalizeBaseUrl(item?.origin);
          if (!consoles.some(entry => sameConsole(entry.origin, origin))) {
            consoles.push({ origin, name: typeof item?.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : new URL(origin).host });
          }
        } catch { /* 非法条目丢弃，不让一条坏数据挡住其他控制台 */ }
      }
      const stored = await storage.get(CURRENT_CONSOLE_KEY);
      current = consoles.some(entry => entry.origin === stored) ? stored : (consoles[0]?.origin ?? null);
      loaded = true;
      return registry.list();
    },
    get loaded() { return loaded; },
    list() { return consoles.map(entry => ({ ...entry, current: entry.origin === current })); },
    current() { return current; },
    currentEntry() { return consoles.find(entry => entry.origin === current) || null; },
    has(origin) { return consoles.some(entry => entry.origin === origin); },
    /** 某台控制台专属的凭证存储（键 `<host>:device-token`）；切换控制台即换一个 tokenStore。 */
    tokenStoreFor(origin) {
      const key = consoleTokenKey(origin);
      return createTokenStore({ secureStorage: {
        get: () => storage.get(key),
        set: token => storage.set(key, token),
        remove: () => storage.remove(key),
      } });
    },
    /**
     * 添加新控制台：先校验地址，再由 bind(origin, tokenStore) 完成绑定（写入该控制台凭证），
     * 绑定成功后才写入清单并设为当前。地址非法/不可达一律不写入清单，错误原样给就地提示。
     */
    async addConsole({ base, name } = {}, bind) {
      const origin = normalizeBaseUrl(base); // INVALID_BASE / INSECURE_BASE 就地报错
      const tokenStore = registry.tokenStoreFor(origin);
      const existingBefore = consoles.find(entry => entry.origin === origin);
      // 重绑已有控制台：先记下原凭证，清单写失败时恢复它，而不是把已在用的控制台变成无凭证。
      const previousToken = existingBefore ? await tokenStore.get() : null;
      try {
        await bind(origin, tokenStore);
      } catch (error) {
        if (error instanceof MobileShellError && error.code === 'NETWORK') {
          throw new MobileShellError('ADD_UNREACHABLE', '地址不可达：无法连接该控制台，未加入列表');
        }
        throw error;
      }
      const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : new URL(origin).host;
      const snapshot = { consoles: consoles.map(entry => ({ ...entry })), current };
      const existing = consoles.find(entry => entry.origin === origin);
      if (existing) existing.name = label;
      else consoles.push({ origin, name: label });
      current = origin;
      try { await persist(); }
      catch (error) {
        // 清单写不进去时整体回滚（清单、名称、当前指针），新控制台不留孤儿凭证、重绑的控制台恢复原凭证，fail-closed。
        consoles = snapshot.consoles;
        current = snapshot.current;
        if (previousToken) await tokenStore.set(previousToken).catch(() => {});
        else await tokenStore.clear().catch(() => {});
        throw error instanceof MobileShellError ? error : new MobileShellError('STORAGE_FAILED', '安全存储读写失败，请重新添加控制台');
      }
      return registry.list();
    },
    /** 点选切换：只改「当前控制台」指针；连接上下文由壳整页重建。 */
    async selectConsole(origin) {
      if (!registry.has(origin)) throw new MobileShellError('CONSOLE_UNKNOWN', '该控制台不在列表中');
      current = origin;
      await storage.set(CURRENT_CONSOLE_KEY, origin);
      return origin;
    },
    /** 移除控制台：同时删除它的设备凭证；移除的是当前控制台时改指向剩余第一台（没有则清空）。 */
    async removeConsole(origin) {
      if (!registry.has(origin)) return current;
      const snapshot = { consoles, current };
      consoles = consoles.filter(entry => entry.origin !== origin);
      if (current === origin) current = consoles[0]?.origin ?? null;
      // 先改清单、再删凭证：清单写失败时整体回滚，列表与凭证保持一致（不会出现「在列表里却没有凭证」）。
      try { await persist(); }
      catch (error) {
        consoles = snapshot.consoles;
        current = snapshot.current;
        throw error instanceof MobileShellError ? error : new MobileShellError('STORAGE_FAILED', '安全存储读写失败，请稍后重试');
      }
      // 清单已不含它：凭证删失败只会留下一份无人引用的凭证，不影响列表一致性，重新添加时会被覆盖。
      await storage.remove(consoleTokenKey(origin)).catch(() => {});
      return current;
    },
  };
  return registry;
}

/**
 * 首屏路由（纯函数）：决定锁屏区显示哪一块。
 * - 单控制台网页模式（hub=false）：沿用「绑定 → 解锁 → 主界面」。
 * - 多控制台 App 模式：未解锁时有已存控制台显示解锁卡（解锁一次管全部），否则引导添加；解锁后默认先到
 *   控制台列表，点选（或刚绑定/刚切换）且该控制台凭证在位才进主界面；凭证读写失败 fail-closed 回添加页。
 */
export function bootScreen({ hub = false, phase = 'locked', bound = false, consoles = 0, entered = false, adding = false, storageFailed = false } = {}) {
  if (storageFailed) return 'bind';
  if (!hub) {
    if (phase === 'unlocked') return 'main';
    return bound ? 'unlock' : 'bind';
  }
  if (phase !== 'unlocked') return consoles > 0 ? 'unlock' : 'bind';
  if (adding || consoles === 0) return 'bind';
  return entered && bound ? 'main' : 'picker';
}

// ---------------------------------------------------------------------------
// 断联重连控制器（reconnect）：App 存活期间按既有指数退避自动重连；切回前台（visibilitychange / resume）
// 立即探测；页面请求连不上时立即探测；在线时低频心跳发现中台不可达。退避档位走完仍失败才置 unreachable，
// 由壳显示带「立即重试」的重连页；恢复后回到原来的页面（resumePage 回调），重连全程不动页面与输入。
export function createReconnectController({
  state,
  probe,
  onChange = () => {},
  resumePage = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
  unreachableAfter = 5,
  heartbeatMs = 30000,
  isVisible = () => true,
} = {}) {
  if (!state || typeof probe !== 'function') throw new TypeError('createReconnectController 需要 state 与 probe');
  let retryTimer = null;
  let heartbeatTimer = null;
  let inFlight = null;
  let stopped = false;
  let nextDelayMs = null;

  const clearRetry = () => { if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; } nextDelayMs = null; };
  const clearHeartbeat = () => { if (heartbeatTimer !== null) { clearTimer(heartbeatTimer); heartbeatTimer = null; } };
  const active = () => !stopped && state.canShowMain() && !state.needsBind;

  const scheduleRetry = delay => {
    clearRetry();
    nextDelayMs = delay;
    retryTimer = setTimer(() => { retryTimer = null; nextDelayMs = null; void controller.attempt(); }, delay);
  };
  const scheduleHeartbeat = () => {
    clearHeartbeat();
    if (!heartbeatMs || !active()) return;
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null;
      // 页面隐藏时不发心跳；回前台由 onForeground 立即探测。
      if (isVisible()) void controller.attempt({ heartbeat: true });
    }, heartbeatMs);
  };

  const controller = {
    /** 发起一次连接探测；同一时刻只跑一个探测，重复触发复用同一个。 */
    attempt({ heartbeat = false } = {}) {
      if (stopped) return Promise.resolve(false);
      if (inFlight) return inFlight;
      clearRetry();
      clearHeartbeat();
      const wasUnreachable = state.unreachable;
      // 心跳只在已在线时静默探测，不把状态条闪成「正在连接」。
      const delay = heartbeat && state.connection === 'online' ? null : state.retry();
      if (delay !== null) onChange();
      inFlight = (async () => {
        try {
          await probe();
          if (state.connection !== 'online') state.connectSuccess();
          onChange();
          if (wasUnreachable) resumePage(); // 恢复后回到原来的页面，不停留在错误页
          scheduleHeartbeat();
          return true;
        } catch (error) {
          if (state.connection === 'connecting' || state.connection === 'online') state.connectFailure(error?.message || '连接失败，请重试', error?.status ?? null);
          if (shouldAutoRetry(error, state) && !stopped) {
            if (state.retryAttempt >= unreachableAfter) state.unreachable = true;
            scheduleRetry(delay ?? state.nextRetryDelay());
          }
          onChange();
          return false;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    /** 立即重试（重连页按钮）：不清退避计数，立刻探测一次。 */
    manualRetry() { return controller.attempt(); },
    /** 切回前台：立即探测，不等退避计时。 */
    onForeground() { if (active()) return controller.attempt(); return Promise.resolve(false); },
    /** 页面请求连不上控制台：在线态下立即探测，进入退避重连。 */
    onTransportError() {
      if (active() && state.connection === 'online' && !inFlight) return controller.attempt();
      return Promise.resolve(false);
    },
    /** 系统报网络断开：标记离线；旧鸿蒙 WebView 的 online 事件不可靠，仍按退避排一次探测兜底。 */
    onOffline() {
      if (stopped) return;
      clearHeartbeat();
      state.networkLost();
      onChange();
      if (active()) scheduleRetry(state.nextRetryDelay());
    },
    onOnline() {
      if (!active()) return Promise.resolve(false);
      state.networkRestored();
      return controller.attempt();
    },
    start() { stopped = false; },
    stop() { stopped = true; clearRetry(); clearHeartbeat(); },
    view() {
      return {
        connection: state.connection,
        unreachable: Boolean(state.unreachable),
        attempt: state.retryAttempt,
        nextDelayMs,
        retrying: retryTimer !== null || Boolean(inFlight),
      };
    },
  };
  return controller;
}

/** 重连状态文案（与设计稿一致）：重连中（第 N 次，退避 X 秒后重试）· 已保留当前页面与输入。 */
export function reconnectStatusText(view) {
  if (!view || view.connection === 'online') return '';
  const attempt = Math.max(1, Number(view.attempt) || 1);
  const seconds = view.nextDelayMs ? Math.max(1, Math.round(view.nextDelayMs / 1000)) : null;
  const wait = seconds ? `，退避 ${seconds} 秒后重试` : '';
  return `状态：重连中（第 ${attempt} 次${wait}）· 已保留当前页面与输入`;
}

/**
 * 把 App 生命周期接到重连控制器：回前台（visibilitychange 变可见 / Capacitor resume）立即探测，
 * offline/online 走控制器。返回解绑函数。旧鸿蒙 WebView 的 online 事件不可靠，回前台探测与心跳兜底。
 */
export function attachReconnectLifecycle({ win, doc, controller }) {
  const onVisibility = () => { if (doc.visibilityState !== 'hidden') void controller.onForeground(); };
  const onResume = () => { void controller.onForeground(); };
  const onOffline = () => controller.onOffline();
  const onOnline = () => { void controller.onOnline(); };
  doc.addEventListener('visibilitychange', onVisibility);
  doc.addEventListener('resume', onResume);
  win.addEventListener('offline', onOffline);
  win.addEventListener('online', onOnline);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.removeEventListener('resume', onResume);
    win.removeEventListener('offline', onOffline);
    win.removeEventListener('online', onOnline);
  };
}

// ---------------------------------------------------------------------------
// App 刷新机制（DAG 节点 app-refresh-mechanism）：下拉刷新手势与界面版本自检的纯逻辑。
// 本段不碰 DOM、不写浏览器存储，DOM 接线与整页重载在 app.mjs；可在 Node 里直接做边界测试。

export const PULL_REFRESH_THRESHOLD_PX = 56; // 下拉越过该距离，松手触发当前页重载
export const PULL_REFRESH_MAX_PX = 96; // 跟手指示的最大位移，避免把内容拖出屏幕
export const PULL_REFRESH_AXIS_LOCK_PX = 8; // 超过该位移才锁定主轴：纵向归下拉，横向留给 tab-swipe / 左滑关闭
export const PULL_REFRESH_MAX_SPEED_PX_PER_MS = 1.5; // 超过该速度的向下甩动视为惯性滚动，不触发刷新

const finite = value => typeof value === 'number' && Number.isFinite(value);

/**
 * 下拉刷新手势状态机：start → move* → end/cancel。
 *
 * 滚动守卫（issue #349）：只有「起拉时容器已到顶」才武装刷新；从列表中部起拉一律视为
 * 会话历史/长列表浏览，即使中途滚到顶再继续下拉也不接管（旧版在到顶时重设基准，把浏览
 * 历史的滚动量算成下拉，正是误触根因）。同时用相邻事件的速度识别惯性甩动：高速向下滑
 * 不算明确下拉。任一守卫生效都返回 pulling:false，宁可不触发也不误触。
 *
 * 横向一旦锁定就不再抢手势；未到顶时返回 pulling:false，调用方据此把滚动交还浏览器。
 * 这些都保证与 tab 滑动切页、会话行左滑关闭、折叠卡片点击互不冲突。
 */
export function createPullRefreshGesture({
  thresholdPx = PULL_REFRESH_THRESHOLD_PX,
  maxPullPx = PULL_REFRESH_MAX_PX,
  axisLockPx = PULL_REFRESH_AXIS_LOCK_PX,
  maxSpeedPxPerMs = PULL_REFRESH_MAX_SPEED_PX_PER_MS,
} = {}) {
  let session = null;
  const idle = () => ({ pulling: false, distance: 0, ready: false });
  const trackSpeed = (s, y, t) => {
    if (!finite(y) || !finite(t) || !finite(s.lastY) || !finite(s.lastT) || t <= s.lastT) return;
    s.maxSpeed = Math.max(s.maxSpeed, (y - s.lastY) / (t - s.lastT));
    s.lastY = y;
    s.lastT = t;
    if (s.maxSpeed > maxSpeedPxPerMs) s.inertial = true;
  };
  return {
    active: () => Boolean(session),
    start({ x, y, t, atTop = true, enabled = true } = {}) {
      if (!enabled || !finite(x) || !finite(y)) { session = null; return false; }
      // 严格判定顶部：atTop 不可信（非布尔）时不武装，宁可不触发。
      const armed = atTop === true;
      session = {
        x, y, dx: 0, dy: 0, axis: null,
        atTop: armed, armed, inertial: false, maxSpeed: 0,
        lastY: y, lastT: finite(t) ? t : null,
      };
      return true;
    },
    move({ x, y, atTop, t } = {}) {
      if (!session) return idle();
      const s = session;
      if (finite(x)) s.dx = x - s.x;
      if (finite(y)) s.dy = y - s.y;
      trackSpeed(s, y, t);
      const top = typeof atTop === 'boolean' ? atTop : s.atTop;
      if (!s.axis && Math.max(Math.abs(s.dx), Math.abs(s.dy)) >= axisLockPx) {
        s.axis = Math.abs(s.dy) > Math.abs(s.dx) ? 'y' : 'x';
      }
      s.atTop = top;
      // 滚动守卫：非顶部起拉、已离开顶部、主轴横向、向上滑、惯性甩动都不接管。
      if (!s.armed || !top || s.axis !== 'y' || s.dy <= 0 || s.inertial) return idle();
      return {
        pulling: true,
        distance: Math.min(s.dy, maxPullPx),
        ready: s.dy >= thresholdPx,
      };
    },
    end({ x, y, t } = {}) {
      if (!session) return { fired: false, distance: 0 };
      const s = session;
      session = null;
      if (finite(x)) s.dx = x - s.x;
      if (finite(y)) s.dy = y - s.y;
      trackSpeed(s, y, t);
      const fired = s.armed && s.atTop && s.axis === 'y' && s.dy >= thresholdPx && !s.inertial;
      return { fired, distance: fired ? Math.min(s.dy, maxPullPx) : 0 };
    },
    cancel() {
      const interrupted = Boolean(session);
      session = null;
      return { fired: false, interrupted };
    },
  };
}

/**
 * 从服务端改写后的移动入口 HTML 提取 ?v=<16位内容 hash>。
 * 服务端把本地 css/mjs 引用改写成带版本号的 URL（src/server.mjs versionMobileText），
 * 客户端不需要新接口：no-store 拉入口，解析任一资源的 ?v= 即为当前界面版本。
 */
export function extractMobileAssetVersion(html) {
  if (typeof html !== 'string') return null;
  const match = /[?&]v=([0-9a-f]{16})(?![0-9a-f])/i.exec(html);
  return match ? match[1].toLowerCase() : null;
}

/**
 * 轻量界面版本自检：入口 no-store 探测，?v= 带当前已知 hash（与服务端版本口径一致）；
 * 探测失败静默保持现状，不弹错、不抛错；仅当版本变化才回调整页重载。
 */
export function createVersionWatcher({
  getEntryUrl,
  fetchImpl = null,
  baseline = null,
  onChanged = () => {},
  intervalMs = 0,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
} = {}) {
  if (typeof getEntryUrl !== 'function') throw new TypeError('createVersionWatcher 需要 getEntryUrl');
  const doFetch = fetchImpl || ((input, init) => globalThis.fetch(input, init));
  let current = baseline;
  let timer = null;
  let inFlight = null;
  let stopped = false;

  const clear = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const check = () => {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve({ ok: false, reason: 'stopped' });
    const entry = getEntryUrl();
    if (!entry) return Promise.resolve({ ok: false, reason: 'no-base' });
    inFlight = (async () => {
      try {
        const url = new URL(entry);
        url.searchParams.set('v', current || '');
        const response = await doFetch(url.toString(), { cache: 'no-store', headers: { accept: 'text/html' } });
        if (!response || response.ok === false) return { ok: false, reason: 'http' };
        const version = extractMobileAssetVersion(await response.text());
        if (!version) return { ok: false, reason: 'no-version' };
        if (current === null) { current = version; return { ok: true, changed: false, version }; }
        if (version === current) return { ok: true, changed: false, version };
        const previous = current;
        current = version;
        try { onChanged({ version, previous }); }
        catch { /* 回调异常不改探测结论，调用方自己负责整页重载的兜底 */ }
        return { ok: true, changed: true, version, previous };
      } catch {
        // 探测失败静默保持现状：离线、证书错误、控制台临时不可达都不打扰用户。
        return { ok: false, reason: 'network' };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
  const schedule = () => {
    clear();
    if (!intervalMs || stopped) return;
    timer = setTimer(() => { timer = null; void check().then(schedule); }, intervalMs);
  };
  return {
    check,
    get version() { return current; },
    start() { stopped = false; schedule(); },
    stop() { stopped = true; clear(); },
    onForeground() {
      if (stopped) return Promise.resolve({ ok: false, reason: 'stopped' });
      return check().then(result => { schedule(); return result; });
    },
  };
}

/**
 * 判断当前页面是否为随安装包冻结的「原生内置壳」：页面 origin 与控制台地址不同。
 * 这种壳里 window.location.reload() 只会重新加载随包资源，拿不到控制台新界面；
 * 版本变化只能如实提示需更新安装包，不得伪称已切换，更不该重载丢掉页面状态。
 * 页面与控制台同源（网页同源部署）时返回 false，沿用整页重载换新界面的既有行为。
 */
export function isBundledShell(pageUrl, consoleBase) {
  if (typeof pageUrl !== 'string' || typeof consoleBase !== 'string' || !consoleBase) return false;
  try {
    return new URL(pageUrl).origin !== new URL(consoleBase).origin;
  } catch {
    return false;
  }
}

// 整页重载需要保留的上下文键：tab 由壳写入，会话上下文由会话页写入 nomoto-sessions-context。
export const REFRESH_TAB_KEY = 'nomoto-active-tab';
export const REFRESH_VERSION_KEY = 'nomoto-version-reloaded';

const sessionStore = () => {
  try { return globalThis.sessionStorage ?? null; }
  catch { return null; }
};

export function readSessionValue(key, storage) {
  try {
    const store = storage === undefined ? sessionStore() : storage;
    return store ? store.getItem(key) : null;
  } catch { return null; }
}

export function writeSessionValue(key, value, storage) {
  try {
    const store = storage === undefined ? sessionStore() : storage;
    if (store) store.setItem(key, String(value));
  } catch { /* 隐私模式下存储不可用：本次会话仍照常，重载可能不保留位置 */ }
}

/** 非法的存档值不把用户带到不存在的页面，回落默认 Tab。 */
export function restoreTab(allowed, saved, fallback = 'core') {
  return Array.isArray(allowed) && allowed.includes(saved) ? saved : fallback;
}
