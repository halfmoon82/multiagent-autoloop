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
]);

export function mobileSessionUrl(base) { return new URL('/api/mobile/session', base).toString(); }
export function mobileBindUrl(base) { return new URL('/api/mobile/bind', base).toString(); }
export function mobileApiUrl(base, key) {
  if (typeof key !== 'string' || !MOBILE_API_KEYS.includes(key)) {
    throw new MobileShellError('API_NOT_ALLOWED', `该 API 不在移动端允许列表中：${String(key)}`);
  }
  return new URL(`/api/mobile/api/${key}`, base).toString();
}

// 设备绑定结果：网页管理后台生成的一次性二维码载荷。严格格式，拒绝夹带其他参数或任意链接。
export function parseBindPayload(text) {
  if (typeof text !== 'string') throw new MobileShellError('INVALID_BIND', '请粘贴完整的绑定二维码内容');
  const match = /^autoloop:\/\/bind\?token=([0-9a-f]{64})$/.exec(text.trim());
  if (!match) throw new MobileShellError('INVALID_BIND', '请粘贴完整的绑定二维码内容（autoloop://bind?token=…）');
  return match[1];
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
    this.connection = 'online'; this.error = null; this.retryAttempt = 0;
    if (device) this.device = device;
  }
  connectFailure(message = '连接失败，请重试', status = null) {
    if (status === 401) { this.revokeDetected(message); return; }
    this.connection = 'error'; this.error = message;
  }
  revokeDetected(message = '设备授权已失效，请重新绑定') {
    this.clearToken();
    this.phase = 'locked'; this.connection = 'offline';
    this.error = message; this.lockError = message; this.retryAttempt = 0;
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

// 移动端客户端：所有请求都钉在固定路径上，设备凭证只放在 x-device-token 头里。
export function createMobileClient({ base, state = new ShellState(), tokenStore = createTokenStore(), fetchImpl = null } = {}) {
  const origin = normalizeBaseUrl(base);
  const doFetch = fetchImpl || ((input, init) => globalThis.fetch(input, init));
  const request = async (url, { method = 'GET', body, token } = {}) => {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers['x-device-token'] = token;
    let response;
    try { response = await doFetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new MobileShellError('NETWORK', '无法连接控制台，请检查网络或地址'); }
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
      const result = await request(mobileBindUrl(origin), { method: 'POST', body: { token, name, platform } });
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
  };
}
