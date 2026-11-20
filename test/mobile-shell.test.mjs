// mobile-shell 节点（Spec §5 / Issue 1）边界测试：
// 独立移动端壳的安全连接、设备级授权、生物识别门禁、断线重连与固定 API 中继。
// 不调用真实模型、不操作真实规则；移动端资源、API 与打包配置都由本文件定义行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { listen, close, fakeHub, json } from './helpers.mjs';
import {
  MobileShellError, normalizeBaseUrl, MOBILE_API_KEYS, mobileSessionUrl, mobileBindUrl, mobileApiUrl,
  parseBindPayload, ShellState, createTokenStore, createBiometricGate, createMobileClient, shouldAutoRetry,
} from '../mobile/app/www/shell.mjs';

const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'app');

// ---------------------------------------------------------------------------
// RED 1：安全连接——远程地址必须 HTTPS，本机回环可 http；不得夹带路径/账号/任意 scheme
// ---------------------------------------------------------------------------
test('normalizeBaseUrl：远程只接受 HTTPS 站点根地址，回环允许本机 http', () => {
  assert.equal(normalizeBaseUrl('https://console.example.com'), 'https://console.example.com');
  assert.equal(normalizeBaseUrl('https://console.example.com:8443/'), 'https://console.example.com:8443');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:50761'), 'http://127.0.0.1:50761');
  assert.equal(normalizeBaseUrl('http://localhost:50761'), 'http://localhost:50761');
  assert.equal(normalizeBaseUrl('http://[::1]:50761'), 'http://[::1]:50761');

  for (const bad of ['http://console.example.com', 'http://192.168.1.7:50761', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://host']) {
    assert.throws(() => normalizeBaseUrl(bad), error => error instanceof MobileShellError && /HTTPS|网址/.test(error.message), bad);
  }
  for (const bad of ['https://user:pass@console.example.com', 'https://console.example.com/mobile/', 'https://console.example.com?x=1', 'https://console.example.com#frag', '', '   ']) {
    assert.throws(() => normalizeBaseUrl(bad), error => error instanceof MobileShellError, bad);
  }
  assert.throws(() => normalizeBaseUrl('http://127.0.0.1:50761', { allowLocalHttp: false }), error => error instanceof MobileShellError);
});

test('移动端 API 地址只由固定允许列表拼出，不接受任意 key 或路径', () => {
  const base = 'https://console.example.com';
  assert.equal(mobileSessionUrl(base), 'https://console.example.com/api/mobile/session');
  assert.equal(mobileBindUrl(base), 'https://console.example.com/api/mobile/bind');
  assert.equal(mobileApiUrl(base, 'state'), 'https://console.example.com/api/mobile/api/state');
  assert.ok(MOBILE_API_KEYS.includes('state'));
  assert.ok(MOBILE_API_KEYS.includes('projects'));
  assert.ok(!MOBILE_API_KEYS.includes('devices'), '设备授权管理 API 不得暴露给移动端');
  for (const bad of ['devices', '../state', 'state%2f..', 'state?x=1', 'state/../../admin', '', null, 42]) {
    assert.throws(() => mobileApiUrl(base, bad), error => error instanceof MobileShellError && error.code === 'API_NOT_ALLOWED', String(bad));
  }
});

test('parseBindPayload 只接受一次性二维码的严格格式', () => {
  const token = 'a'.repeat(64);
  assert.equal(parseBindPayload(`autoloop://bind?token=${token}`), token);
  assert.equal(parseBindPayload(`  autoloop://bind?token=${token}\n`), token);
  for (const bad of ['autoloop://bind?token=abc', `https://evil/?token=${token}`, `autoloop://bind?token=${token}&base=http://evil`, `autoloop://bind?token=${'z'.repeat(64)}`, 'random', '', null]) {
    assert.throws(() => parseBindPayload(bad), error => error instanceof MobileShellError && error.code === 'INVALID_BIND', String(bad));
  }
});

// ---------------------------------------------------------------------------
// RED 2：生物识别门禁——失败绝不进入主界面；授权失效必须回锁定/重绑
// ---------------------------------------------------------------------------
test('生物识别门禁：初始锁定，失败不进入主界面，成功后才显示主界面', () => {
  const state = new ShellState();
  assert.equal(state.phase, 'locked');
  assert.equal(state.canShowMain(), false);

  state.beginUnlock();
  assert.equal(state.phase, 'unlocking');
  assert.equal(state.canShowMain(), false);

  state.unlockFailure('指纹不匹配');
  assert.equal(state.phase, 'locked');
  assert.equal(state.lockError, '指纹不匹配');
  assert.equal(state.canShowMain(), false, '生物识别失败不得进入主界面');
  state.beginUnlock();
  state.unlockFailure();
  assert.equal(state.phase, 'locked');
  assert.equal(state.canShowMain(), false, '连续失败仍锁在主界面之外');

  state.beginUnlock();
  state.unlockSuccess({ id: 'dev_1' });
  assert.equal(state.phase, 'unlocked');
  assert.equal(state.canShowMain(), true);
  assert.equal(state.lockError, null);
  state.lock();
  assert.equal(state.canShowMain(), false, '重新锁定后主界面隐藏');
});

test('连接状态机：连接/断线/重连退避/恢复，授权 401 立即回锁定重绑', () => {
  const state = new ShellState({ backoffMs: [10, 20, 40] });
  state.setToken('dev-token');
  assert.equal(state.needsBind, false);

  state.connectStart();
  assert.equal(state.connection, 'connecting');
  state.connectSuccess({ id: 'dev_1' });
  assert.equal(state.connection, 'online');
  assert.equal(state.retryAttempt, 0);

  state.connectFailure('上游暂时不可用');
  assert.equal(state.connection, 'error');
  assert.equal(state.error, '上游暂时不可用');
  assert.equal(state.retryAttempt, 0, '失败本身不推进档位，由下一次 retry() 推进');
  assert.equal(state.nextRetryDelay(), 10);
  assert.equal(state.retry(), 10, '首次重连用第一档退避');
  assert.equal(state.connection, 'connecting');
  assert.equal(state.retryAttempt, 1);
  assert.equal(state.nextRetryDelay(), 20);
  assert.equal(state.retry(), 20);
  assert.equal(state.retryAttempt, 2);
  assert.equal(state.nextRetryDelay(), 40, '退避封顶');

  state.networkLost();
  assert.equal(state.connection, 'offline');
  assert.match(state.error, /网络/);
  assert.equal(state.networkRestored(), 0, '网络恢复后立即可重连');

  state.connectFailure('设备未授权或授权已失效', 401);
  assert.equal(state.token, null, '401 立即清除设备凭据');
  assert.equal(state.needsBind, true);
  assert.equal(state.phase, 'locked');
  assert.equal(state.canShowMain(), false, '授权失效后不得停留在主界面');
  assert.match(state.error, /授权/);
});

// ---------------------------------------------------------------------------
// RED 3：凭据安全——设备凭证不写入浏览器存储；生物识别不可旁路
// ---------------------------------------------------------------------------
test('createTokenStore 默认只在内存保存设备凭证，不碰 localStorage/sessionStorage', async () => {
  const forbidden = name => new Proxy({}, { get() { throw new Error(`不得访问 ${name}`); }, set() { throw new Error(`不得写入 ${name}`); } });
  const saved = {
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: forbidden('localStorage') });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: forbidden('sessionStorage') });
  try {
    const store = createTokenStore();
    assert.equal(await store.get(), null);
    await store.set('device-token');
    assert.equal(await store.get(), 'device-token');
    assert.equal(store.persistent, false, '无原生安全存储时凭据不落盘');
    await store.clear();
    assert.equal(await store.get(), null);
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('createTokenStore 优先使用原生安全存储桥（Android Keystore 由 App 注入）', async () => {
  const calls = [];
  let value = null;
  const bridge = {
    async get() { calls.push('get'); return value; },
    async set(v) { calls.push('set'); value = v; },
    async remove() { calls.push('remove'); value = null; },
  };
  const store = createTokenStore({ secureStorage: bridge });
  assert.equal(store.persistent, true);
  await store.set('t');
  assert.equal(await store.get(), 't');
  await store.clear();
  assert.equal(await store.get(), null);
  assert.deepEqual(calls, ['set', 'get', 'remove', 'get']);
});

test('createBiometricGate：无原生桥时拒绝放行，桥抛错按失败处理，不旁路', async () => {
  assert.equal(await createBiometricGate({ verifier: async () => true }).verify(), true);
  assert.equal(await createBiometricGate({ verifier: async () => false }).verify(), false);
  assert.equal(await createBiometricGate({ bridge: { verify: async () => true } }).verify(), true);
  assert.equal(await createBiometricGate({ bridge: { verify: async () => { throw new Error('取消'); } } }).verify(), false);
  await assert.rejects(
    () => createBiometricGate({ bridge: null }).verify(),
    error => error instanceof MobileShellError && error.code === 'BIOMETRIC_UNAVAILABLE',
    '没有系统生物识别时必须明确失败，不能偷偷进入主界面',
  );
});

// ---------------------------------------------------------------------------
// RED 4：移动端客户端把 bind/session/api 钉在固定路径与设备级授权头上
// ---------------------------------------------------------------------------
function fakeFetch(handler) {
  const calls = [];
  const impl = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}
const okResponse = value => ({ ok: true, status: 200, json: async () => value });
const errResponse = (status, value) => ({ ok: false, status, json: async () => value });

test('createMobileClient.bind 走 /api/mobile/bind，凭证只进安全存储、不进 URL', async () => {
  const token = 'b'.repeat(64);
  const ff = fakeFetch((url, init) => {
    assert.equal(url, 'https://console.example.com/api/mobile/bind');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { token, name: 'Pixel', platform: 'Android' });
    return okResponse({ device: { id: 'dev_1' }, deviceToken: 'device-secret' });
  });
  const state = new ShellState();
  const tokenStore = createTokenStore();
  const client = createMobileClient({ base: 'https://console.example.com', state, tokenStore, fetchImpl: ff.impl });
  const result = await client.bind(`autoloop://bind?token=${token}`, 'Pixel', 'Android');
  assert.equal(result.deviceToken, 'device-secret');
  assert.equal(state.token, 'device-secret');
  assert.equal(await tokenStore.get(), 'device-secret');
  assert.ok(!ff.calls[0].url.includes(token), '一次性二维码令牌不得出现在 URL 里');
  assert.ok(!JSON.stringify(ff.calls[0].init.headers).includes(token));
});

test('createMobileClient.session 带设备级授权头；401 清除凭据并回锁定', async () => {
  const state = new ShellState();
  const tokenStore = createTokenStore();
  await tokenStore.set('device-secret');
  state.setToken('device-secret');
  let attempt = 0;
  const ff = fakeFetch((url, init) => {
    attempt += 1;
    assert.equal(url, 'https://console.example.com/api/mobile/session');
    assert.equal(init.headers['x-device-token'], 'device-secret');
    if (attempt === 1) return okResponse({ device: { id: 'dev_1', name: 'Pixel' }, apis: ['state'], secure: true });
    return errResponse(401, { error: '设备未授权或授权已失效，请重新绑定' });
  });
  const client = createMobileClient({ base: 'https://console.example.com', state, tokenStore, fetchImpl: ff.impl });
  const first = await client.session();
  assert.equal(first.secure, true);
  assert.equal(state.connection, 'online');
  await assert.rejects(() => client.session(), error => error instanceof MobileShellError);
  assert.equal(state.token, null);
  assert.equal(await tokenStore.get(), null, '401 同时清除持久化的设备凭据');
  assert.equal(state.phase, 'locked');
  assert.equal(state.canShowMain(), false);
});

test('createMobileClient.api 只允许固定 key，未知 key 在发请求前就被拒绝', async () => {
  const ff = fakeFetch(() => okResponse({ ok: true }));
  const tokenStore = createTokenStore();
  await tokenStore.set('t');
  const client = createMobileClient({ base: 'https://console.example.com', tokenStore, fetchImpl: ff.impl });
  await assert.rejects(() => client.api('../admin'), error => error instanceof MobileShellError && error.code === 'API_NOT_ALLOWED');
  assert.equal(ff.calls.length, 0, '非法 key 不得产生任何网络请求');
  await client.api('state');
  assert.equal(ff.calls[0].url, 'https://console.example.com/api/mobile/api/state');
  assert.equal(ff.calls[0].init.headers['x-device-token'], 't');
});

// ---------------------------------------------------------------------------
// RED 5：服务端——静态壳白名单、设备级授权、固定 API 中继、HTTPS 门禁
// ---------------------------------------------------------------------------
async function setup(t, { withHub = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-shell-'));
  const store = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  let hub = null;
  let hubUrl = 'http://127.0.0.1:1';
  if (withHub) {
    hub = await fakeHub((req, res) => json(res, { ok: true, hubPath: req.url }));
    hubUrl = hub.url;
  }
  const server = createConsoleServer({ hubUrl, ownerKey: 'server-secret', host: '127.0.0.1', root, deviceAuth: store });
  const url = await listen(server);
  t.after(async () => {
    await close(server);
    if (hub) await close(hub.server);
    rmSync(root, { recursive: true, force: true });
  });
  return { url, store, root, hub };
}
const bindViaApi = (url, token, name = 'Pixel', platform = 'Android') => fetch(`${url}/api/mobile/bind`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, name, platform }),
});
async function issueDevice(url, store, name = 'Pixel') {
  const qr = store.createBinding();
  const response = await bindViaApi(url, qr.token, name);
  assert.equal(response.status, 201);
  return { qr, ...(await response.json()) };
}

test('移动端静态壳由固定白名单提供，带安全响应头，不提供目录遍历和构建文件', async t => {
  const { url } = await setup(t);
  const allowed = ['/mobile/', '/mobile/index.html', '/mobile/app.mjs', '/mobile/shell.mjs', '/mobile/scan.mjs', '/mobile/vendor/qr-decoder.mjs', '/mobile/styles.css', '/mobile/manifest.webmanifest', '/mobile/icon.svg'];
  for (const p of allowed) {
    const response = await fetch(`${url}${p}`);
    assert.equal(response.status, 200, p);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  }
  for (const p of ['/mobile/../src/server.mjs', '/mobile/package.json', '/mobile/capacitor.config.json', '/mobile/build-apk.mjs', '/mobile/%2e%2e/src/server.mjs', '/mobile/vendor/%2e%2e/%2e%2e/src/server.mjs', '/mobile/vendor/LICENSE', '/mobile/vendor/evil.mjs']) {
    assert.equal((await fetch(`${url}${p}`)).status, 404, `${p} 不得被静态服务提供`);
  }
  const html = await (await fetch(`${url}/mobile/`)).text();
  assert.match(html, /id="lock-screen"/);
  assert.match(html, /id="app-main"[^>]*hidden/);
  assert.match(html, /id="scan-bind"/);
  assert.match(html, /id="scan-video"/);
  assert.ok(!html.includes('server-secret'));
});

test('GET /api/mobile/session：无/错/已解除的设备凭据一律 401，合法凭据只返回自身公开信息', async t => {
  const { url, store } = await setup(t);
  assert.equal((await fetch(`${url}/api/mobile/session`)).status, 401);
  assert.equal((await fetch(`${url}/api/mobile/session`, { headers: { 'x-device-token': 'unknown' } })).status, 401);

  const { device, deviceToken } = await issueDevice(url, store, 'Pixel 8');
  const response = await fetch(`${url}/api/mobile/session`, { headers: { 'x-device-token': deviceToken } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.secure, true);
  assert.equal(body.device.id, device.id);
  assert.equal(body.device.name, 'Pixel 8');
  assert.ok(Array.isArray(body.apis) && body.apis.includes('state'));
  assert.ok(!body.devices, '移动端不得拿到全部设备列表');
  const dump = JSON.stringify(body);
  assert.ok(!dump.includes(deviceToken) && !dump.includes('tokenHash') && !dump.includes('server-secret'), '响应不得含设备凭证或密钥');

  store.revokeDevice(device.id, { type: 'admin' });
  assert.equal((await fetch(`${url}/api/mobile/session`, { headers: { 'x-device-token': deviceToken } })).status, 401, '解除授权后同一凭据立即失效');
});

test('GET /api/mobile/api/<key>：固定中继既有控制台 API，不代理任意 URL/查询/写操作', async t => {
  const { url, store, hub } = await setup(t, { withHub: true });
  const { deviceToken } = await issueDevice(url, store);
  const auth = { 'x-device-token': deviceToken };

  assert.equal((await fetch(`${url}/api/mobile/api/state`)).status, 401, '中继同样要求设备级授权');
  const relayed = await fetch(`${url}/api/mobile/api/state`, { headers: auth });
  assert.equal(relayed.status, 200);
  assert.equal((await relayed.json()).hubPath, '/v1/state', '中继复用既有控制台 API');
  assert.ok(hub.requests.some(request => request.url === '/v1/state'));

  // 带任意目标参数也只会落到固定 /api/state，不形成开放代理。
  const withQuery = await fetch(`${url}/api/mobile/api/state?target=http://169.254.169.254/latest/meta-data`, { headers: auth });
  assert.equal(withQuery.status, 200);
  assert.equal((await withQuery.json()).hubPath, '/v1/state');

  for (const p of ['/api/mobile/api/devices', '/api/mobile/api/unknown', '/api/mobile/api/state/revoke', '/api/mobile/api/../state', '/api/mobile/api/%2e%2e/state']) {
    assert.equal((await fetch(`${url}${p}`, { headers: auth })).status, 404, `${p} 不在允许列表中`);
  }
  assert.equal((await fetch(`${url}/api/mobile/api/state`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' })).status, 404, '中继只转发只读 GET');
});

test('远程访问必须 HTTPS：转发层声明为 http 即拒绝；声明 https 放行', async t => {
  const { url, store } = await setup(t);
  const { deviceToken } = await issueDevice(url, store);
  const auth = { 'x-device-token': deviceToken };
  const insecure = await fetch(`${url}/api/mobile/session`, { headers: { ...auth, 'x-forwarded-proto': 'http' } });
  assert.equal(insecure.status, 403);
  assert.match((await insecure.json()).error, /HTTPS/);
  const secure = await fetch(`${url}/api/mobile/session`, { headers: { ...auth, 'x-forwarded-proto': 'https, http' } });
  assert.equal(secure.status, 200);
});

test('POST /api/mobile/bind：一次性二维码换设备凭证，跨站绑定被拒，随后可直连 session', async t => {
  const { url, store } = await setup(t);
  const qr = store.createBinding();
  const bindResponse = await bindViaApi(url, qr.token, 'Mobile Shell Phone');
  assert.equal(bindResponse.status, 201);
  const bound = await bindResponse.json();
  assert.equal(bound.device.status, 'authorized');
  assert.match(bound.deviceToken, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(bound).includes(qr.token), '一次性令牌不得回显');
  assert.ok(!JSON.stringify(bound).includes('server-secret'));

  assert.equal((await fetch(`${url}/api/mobile/session`, { headers: { 'x-device-token': bound.deviceToken } })).status, 200);
  assert.equal((await bindViaApi(url, qr.token)).status, 409, '重复使用的二维码作废');
  assert.equal((await bindViaApi(url, 'unknown')).status, 400, '无效二维码给出可读 400');
  const crossSite = await fetch(`${url}/api/mobile/bind`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ token: 'x', name: 'x', platform: 'Android' }) });
  assert.equal(crossSite.status, 403, '拒绝跨站绑定请求');
  const notJson = await fetch(`${url}/api/mobile/bind`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'token=x' });
  assert.equal(notJson.status, 415, '沿用 JSON 内容类型校验');
});

test('设备授权管理后台 API 不对移动端开放，且移动端响应永远不含 owner key', async t => {
  const { url, store } = await setup(t, { withHub: true });
  const { deviceToken } = await issueDevice(url, store);
  const auth = { 'x-device-token': deviceToken };
  assert.ok(!JSON.stringify(await (await fetch(`${url}/api/mobile/session`, { headers: auth })).json()).includes('server-secret'));
  assert.ok(!JSON.stringify(await (await fetch(`${url}/api/mobile/api/state`, { headers: auth })).json()).includes('server-secret'));
  assert.equal((await fetch(`${url}/api/mobile/api/devices`, { headers: auth })).status, 404);
});

// ---------------------------------------------------------------------------
// RED 6：Android APK 打包工程——配置自洽，未授权不得自动打包（不阻塞其他节点）
// ---------------------------------------------------------------------------
test('Android 打包工程配置自洽：webDir 指向壳资源，minSdk 覆盖旧版鸿蒙，打包需单独授权', () => {
  const config = JSON.parse(readFileSync(path.join(MOBILE_DIR, 'capacitor.config.json'), 'utf8'));
  assert.match(config.appId, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  assert.ok(config.appName);
  assert.equal(config.webDir, 'www', 'webDir 指向 mobile/app/www 壳资源');
  assert.ok(Number(config.autoloop?.android?.minSdkVersion) <= 23, 'minSdk 需覆盖当前旧版鸿蒙可安装的 Android 版本');

  const pkg = JSON.parse(readFileSync(path.join(MOBILE_DIR, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts?.['android:sync']);
  assert.ok(pkg.scripts?.['android:apk']);

  const guard = spawnSync(process.execPath, [path.join(MOBILE_DIR, 'build-apk.mjs')], { env: { ...process.env, AUTOLOOP_APK_BUILD_AUTHORIZED: '' }, encoding: 'utf8' });
  assert.notEqual(guard.status, 0, '未单独授权时不得打包');
  assert.match(guard.stderr + guard.stdout, /授权|authoriz/i);
});

// ---------------------------------------------------------------------------
// RED 7：独立审阅（review g1a1）提出的 4 条 P3 已知后续——attempt 2 逐条修并留回归测试。
// 只改本节点写域内的壳与打包工程；不改 src/device-auth.mjs（越界）。
// ---------------------------------------------------------------------------
test('P3-1 ShellState.connectFailure 只把 401 当授权失效，403 保留凭据与主界面', () => {
  const state = new ShellState();
  state.setToken('device-secret');
  state.unlockSuccess({ id: 'dev_1' });

  state.connectFailure('远程访问必须使用 HTTPS', 403);
  assert.equal(state.connection, 'error');
  assert.match(state.error, /HTTPS/);
  assert.equal(state.token, 'device-secret', '偶发 403 不得清除设备凭据');
  assert.equal(state.needsBind, false, '偶发 403 不得强制重新绑定');
  assert.equal(state.phase, 'unlocked', '偶发 403 不得把已授权设备踢回锁定页');
  assert.equal(state.canShowMain(), true);

  state.connectFailure('设备未授权或授权已失效，请重新绑定', 401);
  assert.equal(state.token, null, '401 仍然立即清除凭据');
  assert.equal(state.needsBind, true);
  assert.equal(state.canShowMain(), false, '401 仍然回锁定页');
});

test('P3-1 session 遇到 403 不清除持久化设备凭据', async () => {
  const state = new ShellState();
  const tokenStore = createTokenStore();
  await tokenStore.set('device-secret');
  state.setToken('device-secret');
  state.unlockSuccess({ id: 'dev_1' });
  const ff = fakeFetch(() => errResponse(403, { error: '远程访问必须使用 HTTPS' }));
  const client = createMobileClient({ base: 'https://console.example.com', state, tokenStore, fetchImpl: ff.impl });

  await assert.rejects(() => client.session(), error => error instanceof MobileShellError && error.status === 403);
  assert.equal(await tokenStore.get(), 'device-secret', '403 不得清除持久化的设备凭据');
  assert.equal(state.token, 'device-secret');
  assert.equal(state.needsBind, false);
  assert.equal(state.phase, 'unlocked');
});

test('P3-1 转发层误传 x-forwarded-proto:http 触发服务端 403 时，已授权设备不被迫重绑', async t => {
  const { url, store } = await setup(t);
  const { deviceToken } = await issueDevice(url, store);
  const state = new ShellState();
  const tokenStore = createTokenStore();
  await tokenStore.set(deviceToken);
  state.setToken(deviceToken);
  state.unlockSuccess({ id: 'dev_1' });
  // 模拟代理误把转发协议声明成 http：服务端返回 403，但这不是设备授权失效。
  const ff = fakeFetch((u, init) => fetch(u, { ...init, headers: { ...init.headers, 'x-forwarded-proto': 'http' } }));
  const client = createMobileClient({ base: url, state, tokenStore, fetchImpl: ff.impl });

  await assert.rejects(() => client.session(), error => error instanceof MobileShellError && error.status === 403);
  assert.equal(await tokenStore.get(), deviceToken, '服务端 403 不得清除设备凭据');
  assert.equal(state.needsBind, false);
  assert.equal(state.phase, 'unlocked');
  assert.equal(state.connection, 'error');
});

test('P3-2 shouldAutoRetry：地址配置错误/未绑定/非 error 态不自动重连，临时错误才重连', () => {
  const capture = fn => { try { fn(); return null; } catch (error) { return error; } };
  const invalid = capture(() => normalizeBaseUrl(''));
  const insecure = capture(() => normalizeBaseUrl('http://console.example.com'));
  assert.equal(invalid?.code, 'INVALID_BASE');
  assert.equal(insecure?.code, 'INSECURE_BASE');

  const bound = new ShellState();
  bound.setToken('device-secret');
  bound.connectFailure('上游暂时不可用');
  assert.equal(shouldAutoRetry(invalid, bound), false, '地址为空是永久配置错误，不空转重试');
  assert.equal(shouldAutoRetry(insecure, bound), false, '远程明文 http 不空转重试');
  assert.equal(shouldAutoRetry(new MobileShellError('NETWORK', '无法连接控制台'), bound), true, '临时网络错误可自动重连');
  assert.equal(shouldAutoRetry(new MobileShellError('HTTP_403', '远程访问必须使用 HTTPS'), bound), true, '偶发 403 可自动重连且不清凭据');

  const unbound = new ShellState();
  unbound.connectFailure('尚未绑定设备，请先扫码绑定');
  assert.equal(shouldAutoRetry(new MobileShellError('DEVICE_NOT_BOUND', 'x'), unbound), false, '未绑定不自动重连');

  const revoked = new ShellState();
  revoked.setToken('device-secret');
  revoked.connectFailure('设备未授权或授权已失效', 401);
  assert.equal(shouldAutoRetry(new MobileShellError('HTTP_401', 'x'), revoked), false, '授权失效回锁定重绑，不自动重连');

  const offline = new ShellState();
  offline.setToken('device-secret');
  offline.networkLost();
  assert.equal(shouldAutoRetry(new MobileShellError('NETWORK', 'x'), offline), false, '离线态由 online 事件触发重连，不排重试');
});

test('P3-3 ShellState.retry 首次重连使用 backoffMs[0]，不跳档', () => {
  const state = new ShellState({ backoffMs: [10, 20, 40] });
  assert.equal(state.retry(), 10, '首次重连必须用第一档退避，不能先自增再取导致跳过第一档');
  assert.equal(state.connection, 'connecting');
  assert.equal(state.retryAttempt, 1);
  assert.equal(state.retry(), 20);
  assert.equal(state.retryAttempt, 2);
  assert.equal(state.retry(), 40, '退避封顶');
  assert.equal(state.retry(), 40, '封顶后保持最后一档');
});

test('P3-4 build-apk 全新环境先 cap add android 再 cap sync，不因缺少平台失败', () => {
  // 真机打包需单独授权 + Android SDK，单测无法真跑；用临时 npx 假壳记录脚本实际发出的命令。
  const dir = mkdtempSync(path.join(tmpdir(), 'apk-build-'));
  const log = path.join(dir, 'commands.log');
  writeFileSync(path.join(dir, 'npx'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  try {
    const result = spawnSync(process.execPath, [path.join(MOBILE_DIR, 'build-apk.mjs')], {
      env: {
        ...process.env,
        AUTOLOOP_APK_BUILD_AUTHORIZED: '1',
        ANDROID_HOME: dir,
        ANDROID_SDK_ROOT: dir,
        PATH: `${dir}${path.delimiter}${process.env.PATH || ''}`,
      },
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined, `打包脚本应能启动：${result.error?.message || ''}`);
    const commands = existsSync(log) ? readFileSync(log, 'utf8') : '';
    const addAt = commands.indexOf('cap add android');
    const syncAt = commands.indexOf('cap sync android');
    assert.ok(addAt >= 0, '全新 checkout 没有 android/ 平台时，必须先用 cap add android 生成平台');
    assert.ok(syncAt > addAt, 'cap add android 必须在 cap sync android 之前');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
