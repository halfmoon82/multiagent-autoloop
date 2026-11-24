// console-hub 节点：多控制台存储/切换/移除（纯逻辑 + 原生契约 + 双控制台浏览器回归）。
// 不调用真实模型、不碰真实规则；浏览器回归用两台临时控制台 + 假 Hub，按键安全存储用页面内假桥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
  MobileShellError, createConsoleRegistry, createKeyedSecureStorage, consoleTokenKey, bootScreen,
  CONSOLES_KEY, CURRENT_CONSOLE_KEY,
} from '../mobile/app/www/shell.mjs';
import { createDefaultHooks } from '../mobile/app/www/app.mjs';
import { SETTINGS_SECTIONS } from '../mobile/app/www/pages/settings.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async set(key, value) { data.set(key, String(value)); },
    async remove(key) { data.delete(key); },
  };
}
const bindWith = token => async (origin, tokenStore) => { await tokenStore.set(token); };

test('凭证按 <host>:device-token 分 key（host 含端口），地址先经 HTTPS/站点根校验', () => {
  assert.equal(consoleTokenKey('https://a.example.com'), 'a.example.com:device-token');
  assert.equal(consoleTokenKey('https://a.example.com:8443/'), 'a.example.com:8443:device-token');
  assert.equal(consoleTokenKey('http://127.0.0.1:50761'), '127.0.0.1:50761:device-token');
  assert.throws(() => consoleTokenKey('http://evil.example.com'), error => error.code === 'INSECURE_BASE');
});

test('添加：绑定成功才写入清单并设为当前；两台控制台凭证互相隔离', async () => {
  const storage = memoryStorage();
  const registry = createConsoleRegistry({ storage });
  await registry.load();
  await registry.addConsole({ base: 'https://study.example.com', name: '书房主机' }, bindWith('tok-a'));
  await registry.addConsole({ base: 'https://office.example.com:8443' }, bindWith('tok-b'));
  assert.deepEqual(registry.list().map(c => [c.origin, c.name, c.current]), [
    ['https://study.example.com', '书房主机', false],
    ['https://office.example.com:8443', 'office.example.com:8443', true],
  ]);
  assert.equal(storage.data.get('study.example.com:device-token'), 'tok-a');
  assert.equal(storage.data.get('office.example.com:8443:device-token'), 'tok-b');
  assert.equal(await registry.tokenStoreFor('https://study.example.com').get(), 'tok-a');
  assert.equal(await registry.tokenStoreFor('https://office.example.com:8443').get(), 'tok-b');
  const persisted = JSON.parse(storage.data.get(CONSOLES_KEY));
  assert.ok(!JSON.stringify(persisted).includes('tok-'), '清单只存地址与名称，不含凭证');
  assert.equal(storage.data.get(CURRENT_CONSOLE_KEY), 'https://office.example.com:8443');

  // 重启（重新 load）后清单与当前控制台原样恢复。
  const again = createConsoleRegistry({ storage });
  await again.load();
  assert.equal(again.current(), 'https://office.example.com:8443');
  assert.equal(again.list().length, 2);
});

test('添加失败不写入列表：地址非法就地报错、不可达报「地址不可达」、绑定码过期原样透传', async () => {
  const storage = memoryStorage();
  const registry = createConsoleRegistry({ storage });
  await registry.load();
  await assert.rejects(registry.addConsole({ base: 'http://lan.example.com' }, bindWith('x')), e => e.code === 'INSECURE_BASE');
  await assert.rejects(registry.addConsole({ base: 'https://a.example.com/path' }, bindWith('x')), e => e.code === 'INVALID_BASE');
  await assert.rejects(
    registry.addConsole({ base: 'https://down.example.com' }, async () => { throw new MobileShellError('NETWORK', '无法连接'); }),
    e => e.code === 'ADD_UNREACHABLE' && /地址不可达/.test(e.message) && /未加入列表/.test(e.message));
  await assert.rejects(
    registry.addConsole({ base: 'https://old.example.com' }, async () => { throw new MobileShellError('BIND_EXPIRED', '绑定码已过期'); }),
    e => e.code === 'BIND_EXPIRED');
  assert.deepEqual(registry.list(), []);
  assert.equal(storage.data.size, 0, '失败时安全存储里什么都不写');
});

test('切换只改当前指针；未知控制台拒绝', async () => {
  const storage = memoryStorage();
  const registry = createConsoleRegistry({ storage });
  await registry.load();
  await registry.addConsole({ base: 'https://a.example.com' }, bindWith('ta'));
  await registry.addConsole({ base: 'https://b.example.com' }, bindWith('tb'));
  await registry.selectConsole('https://a.example.com');
  assert.equal(registry.current(), 'https://a.example.com');
  assert.equal(storage.data.get(CURRENT_CONSOLE_KEY), 'https://a.example.com');
  await assert.rejects(registry.selectConsole('https://c.example.com'), e => e.code === 'CONSOLE_UNKNOWN');
});

test('移除：同时删该控制台凭证；移除当前控制台改指向剩余第一台，全部移除后清空', async () => {
  const storage = memoryStorage();
  const registry = createConsoleRegistry({ storage });
  await registry.load();
  await registry.addConsole({ base: 'https://a.example.com' }, bindWith('ta'));
  await registry.addConsole({ base: 'https://b.example.com' }, bindWith('tb'));
  assert.equal(await registry.removeConsole('https://b.example.com'), 'https://a.example.com');
  assert.equal(storage.data.has('b.example.com:device-token'), false);
  assert.equal(storage.data.get('a.example.com:device-token'), 'ta', '其他控制台凭证不受影响');
  assert.equal(await registry.removeConsole('https://a.example.com'), null);
  assert.deepEqual(registry.list(), []);
  assert.equal(storage.data.has(CURRENT_CONSOLE_KEY), false);
  assert.equal(storage.data.has('a.example.com:device-token'), false);
});

test('凭证读写失败 fail-closed：清单损坏/写失败抛 STORAGE_FAILED，写失败时回滚该控制台凭证', async () => {
  await assert.rejects(createConsoleRegistry({ storage: memoryStorage({ [CONSOLES_KEY]: '{坏' }) }).load(), e => e.code === 'STORAGE_FAILED');
  const storage = memoryStorage();
  const original = storage.set;
  storage.set = async (key, value) => { if (key === CONSOLES_KEY) throw new Error('disk'); return original(key, value); };
  const registry = createConsoleRegistry({ storage });
  await registry.load();
  await assert.rejects(registry.addConsole({ base: 'https://a.example.com' }, bindWith('ta')), e => e.code === 'STORAGE_FAILED');
  assert.equal(storage.data.has('a.example.com:device-token'), false, '不留孤儿凭证');
  assert.deepEqual(registry.list(), []);
});

test('原生按键存储适配器：带 key 调 nativeGet/Set/Remove；插件报错或拒绝一律 STORAGE_FAILED；会话解锁标记', async () => {
  const calls = [];
  let unlocked = false;
  const plugin = {
    async nativeGet(args) { calls.push(['get', args]); return { value: 'v' }; },
    async nativeSet(args) { calls.push(['set', args]); return { ok: true }; },
    async nativeRemove(args) { calls.push(['remove', args]); return { ok: true }; },
    async nativeSessionGet() { return { unlocked }; },
    async nativeSessionSet({ unlocked: next }) { unlocked = next; return { unlocked }; },
  };
  const storage = createKeyedSecureStorage(plugin);
  assert.equal(await storage.get('a.example.com:device-token'), 'v');
  await storage.set('consoles', '[]');
  await storage.remove('current-console');
  assert.deepEqual(calls, [
    ['get', { key: 'a.example.com:device-token' }],
    ['set', { key: 'consoles', value: '[]' }],
    ['remove', { key: 'current-console' }],
  ]);
  assert.equal(await storage.sessionUnlocked(), false);
  await storage.markSessionUnlocked(true);
  assert.equal(await storage.sessionUnlocked(), true);

  const broken = createKeyedSecureStorage({ async nativeGet() { return { value: 'mem', error: 'AUTOLOOP_STORAGE_UNAVAILABLE' }; } });
  await assert.rejects(broken.get('consoles'), e => e.code === 'STORAGE_FAILED');
  const rejecting = createKeyedSecureStorage({ async nativeGet() { throw new Error('x'); } });
  await assert.rejects(rejecting.get('consoles'), e => e.code === 'STORAGE_FAILED');
  assert.equal(createKeyedSecureStorage(null), null, '没有原生插件时不启用多控制台');
});

test('首屏路由：未绑定引导添加；解锁一次后先到控制台列表；点选才进主界面；存储失败回添加页', () => {
  const hub = { hub: true };
  assert.equal(bootScreen({ ...hub, consoles: 0 }), 'bind', '首启未绑定引导添加');
  assert.equal(bootScreen({ ...hub, consoles: 2 }), 'unlock');
  assert.equal(bootScreen({ ...hub, phase: 'unlocked', consoles: 2, bound: true }), 'picker');
  assert.equal(bootScreen({ ...hub, phase: 'unlocked', consoles: 2, bound: true, entered: true }), 'main');
  assert.equal(bootScreen({ ...hub, phase: 'unlocked', consoles: 2, bound: true, entered: true, adding: true }), 'bind');
  assert.equal(bootScreen({ ...hub, phase: 'unlocked', consoles: 2, bound: true, entered: true, storageFailed: true }), 'bind');
  // 网页单控制台模式保持旧行为。
  assert.equal(bootScreen({ bound: false }), 'bind');
  assert.equal(bootScreen({ bound: true }), 'unlock');
  assert.equal(bootScreen({ phase: 'unlocked', bound: true }), 'main');
});

test('原生安全存储：按 key 分存、key 白名单、会话解锁只在进程内存、下载取当前控制台凭证', () => {
  const src = read('mobile/app/native/java/cool/autoloop/console/auth/AutoLoopSecureStorage.java');
  assert.match(src, /call\.getString\("key"\)/);
  assert.match(src, /:device-token\$/);
  assert.match(src, /KEY_CONSOLES = "consoles"/);
  assert.match(src, /KEY_CURRENT_CONSOLE = "current-console"/);
  assert.match(src, /AUTOLOOP_STORAGE_INVALID_KEY/);
  assert.match(src, /void nativeSessionGet\s*\(/);
  assert.match(src, /void nativeSessionSet\s*\(/);
  assert.match(src, /private static volatile boolean sessionUnlocked/);
  assert.match(src, /currentTokenKey\(prefs\)/, '下载插件读当前控制台的凭证');
  assert.doesNotMatch(src, /localStorage|sessionStorage|Log\./);
});

test('设置页「当前控制台」区块与首屏共用 hooks.consoles 数据源；默认钩子可调用', async () => {
  assert.equal(SETTINGS_SECTIONS[0].title, '当前控制台');
  const settings = read('mobile/app/www/pages/settings.mjs');
  assert.match(settings, /ctx\.hooks\.consoles/);
  assert.match(settings, /export function renderConsoleList/);
  const app = read('mobile/app/www/app.mjs');
  assert.match(app, /settingsPage\.renderConsoleList\(pickerList/, '首屏列表复用设置页同一渲染与动作');
  const hooks = createDefaultHooks();
  assert.equal(hooks.consoles.available, false);
  assert.deepEqual(hooks.consoles.list(), []);
  await hooks.consoles.switchConsole('https://a.example.com');
  assert.equal(typeof hooks.consoles.subscribe(() => {}), 'function');
});

// ---------- 浏览器回归：两台控制台绑定、切换数据隔离、移除、添加失败就地报错 ----------
const browserSkip = (() => {
  try {
    return existsSync(chromium.executablePath()) ? false : 'npm test 阶段未安装 Playwright Chromium，跳过浏览器回归';
  } catch { return '无法探测 Playwright Chromium，跳过浏览器回归'; }
})();

// 一个刚关闭的本机端口：连接被拒，模拟「地址不可达」。
async function closedLocalOrigin() {
  const { createServer } = await import('node:http');
  const server = createServer();
  const url = await listen(server);
  await close(server);
  return url;
}

async function makeConsole(label) {
  const root = mkdtempSync(path.join(tmpdir(), `console-hub-${label}-`));
  const hub = await fakeHub((req, res) => {
    if (req.url === '/v1/state') return json(res, { runs: [], cards: [], lines: [], spending: {} });
    return json(res, { ok: true });
  });
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: `secret-${label}`, host: '127.0.0.1', root, rulesFile, deviceAuth, projectRoots: [root] });
  const url = await listen(server);
  return {
    url, deviceAuth,
    async dispose() { await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); },
  };
}

test('浏览器：两台控制台绑定、切换免重复解锁且数据隔离、设置页移除、不可达地址不入列表', { skip: browserSkip }, async t => {
  const a = await makeConsole('a');
  const b = await makeConsole('b');
  let browser;
  t.after(async () => { if (browser) await browser.close(); await a.dispose(); await b.dispose(); });

  browser = await chromium.launch({ headless: true });
  // 真机内置壳从本地 https://localhost 加载、没有控制台下发的 CSP，请求经原生 HTTP；回归用 bypassCSP 模拟本地壳。
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, bypassCSP: true });
  // 模拟 CapacitorHttp：真机上 API 请求走原生 HTTP，不带浏览器的 Origin/Sec-Fetch-* 头、不受跨站限制。
  // 回归里把发往 B 的跨源请求在测试进程内原样代理，去掉浏览器跨站头并补 CORS 响应头。
  await context.route(`${b.url}/**`, async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST' } });
    }
    const headers = { ...request.headers() };
    for (const name of Object.keys(headers)) if (name === 'origin' || name.startsWith('sec-fetch')) delete headers[name];
    const response = await route.fetch({ headers });
    return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
  });
  // 按键安全存储假桥：sessionStorage 模拟原生 Keystore 跨「页面重建」保留；会话解锁标记同样跨重建保留（真机为进程内存）。
  await context.addInitScript(() => {
    const k = key => `__hub_${key}`;
    window.AutoloopConsoleStorage = {
      async nativeGet({ key }) { return { value: sessionStorage.getItem(k(key)) }; },
      async nativeSet({ key, value }) { sessionStorage.setItem(k(key), value); return { ok: true }; },
      async nativeRemove({ key }) { sessionStorage.removeItem(k(key)); return { ok: true }; },
      async nativeSessionGet() { return { unlocked: sessionStorage.getItem('__hub_session') === '1' }; },
      async nativeSessionSet({ unlocked }) { sessionStorage.setItem('__hub_session', unlocked ? '1' : '0'); return { unlocked }; },
    };
    window.__verifyCount = 0;
    window.AutoloopBiometric = { async verify() { window.__verifyCount += 1; return true; } };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${a.url}/mobile/`);

  // 首启未绑定：引导添加，不预置任何地址。
  await page.waitForFunction(() => !document.getElementById('bind-card').hidden && document.getElementById('base-url').value === '');
  const qrA = a.deviceAuth.createBinding();
  await page.locator('#base-url').fill(a.url);
  await page.locator('#bind-name').fill('Hub 测试机');
  await page.locator('#bind-payload').fill(qrA.qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('connection-status')?.textContent?.includes('已安全连接'));

  // 设置页「当前控制台」：添加第二台（B）。先试不可达地址：就地报错、不写入列表。
  await page.locator('#open-settings').click();
  await page.waitForFunction(() => document.querySelectorAll('#settings-console [data-console-origin]').length === 1);
  await page.locator('#settings-console [data-action="add-console"]').click();
  await page.locator('#bind-card').waitFor({ state: 'visible' });
  await page.locator('#base-url').fill(await closedLocalOrigin());
  await page.locator('#bind-payload').fill(b.deviceAuth.createBinding().qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => /地址不可达/.test(document.getElementById('bind-status')?.textContent || ''));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('__hub_consoles')).then(v => JSON.parse(v).length), 1, '不可达地址不入列表');

  // 在 A 上留下页面上下文（打开中的会话与草稿），切到 B 后不得带过去。
  await page.evaluate(() => {
    const input = document.querySelector('.sessions-composer-input');
    input.value = 'A 的草稿';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.match(await page.evaluate(() => sessionStorage.getItem('nomoto-sessions-context') || ''), /A 的草稿/, '前置：草稿已进页面上下文');
  const qrB = b.deviceAuth.createBinding();
  await page.locator('#base-url').fill(b.url);
  await page.locator('#bind-payload').fill(qrB.qrPayload);
  await page.locator('#bind-submit').click();
  // 已解锁时添加：整页重建并直接进入 B，免重复生物识别。
  await page.waitForFunction(() => document.getElementById('connection-status')?.textContent?.includes('已安全连接') && !document.getElementById('app-main').hidden);
  assert.equal(await page.evaluate(() => window.__verifyCount), 0, '切换/添加后的页面重建不再要求生物识别');
  assert.equal(await page.evaluate(() => document.querySelector('.sessions-composer-input')?.value), '', '切换控制台不带原控制台的输入草稿');
  assert.doesNotMatch(await page.evaluate(() => sessionStorage.getItem('nomoto-sessions-context') || ''), /A 的草稿/, '切换控制台清掉原控制台的页面上下文');

  // 数据隔离：两台控制台凭证分 key，且各自只在对应控制台有效。
  const stored = await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).filter(k => k.endsWith(':device-token')).map(k => [k, sessionStorage.getItem(k)])));
  const hostA = new URL(a.url).host; const hostB = new URL(b.url).host;
  const tokenA = stored[`__hub_${hostA}:device-token`]; const tokenB = stored[`__hub_${hostB}:device-token`];
  assert.ok(tokenA && tokenB && tokenA !== tokenB, '两台控制台各一份凭证');
  const sessionOn = async (base, token) => (await fetch(`${base}/api/mobile/session`, { headers: { 'x-device-token': token } })).status;
  assert.equal(await sessionOn(a.url, tokenA), 200);
  assert.equal(await sessionOn(b.url, tokenB), 200);
  assert.equal(await sessionOn(b.url, tokenA), 401, 'A 的凭证在 B 上无效（隔离）');

  // 设置页：B 为使用中；点 A 切回（重建，免解锁）；当前请求只发往 A。
  await page.locator('#open-settings').click();
  await page.waitForFunction(o => document.querySelector(`#settings-console [data-console-origin="${o}"]`)?.classList.contains('is-current'), b.url);
  const requests = [];
  page.on('request', req => { if (req.url().includes('/api/mobile/')) requests.push(new URL(req.url()).origin); });
  await page.locator(`#settings-console [data-console-origin="${a.url}"] [data-action="select-console"]`).click();
  await page.waitForFunction(() => document.getElementById('connection-status')?.textContent?.includes('已安全连接') && !document.getElementById('app-main').hidden);
  assert.equal(await page.evaluate(() => window.__verifyCount), 0);
  assert.ok(requests.length && requests.every(origin => origin === a.url), `切回 A 后只请求 A：${requests.join(',')}`);

  // 移除 B（二次确认）：第一次点只变「确认移除？」，第二次才移除，B 的凭证一并删除。
  await page.locator('#open-settings').click();
  const removeB = `#settings-console [data-console-origin="${b.url}"] [data-action="remove-console"]`;
  await page.locator(removeB).click();
  assert.equal(await page.locator(removeB).innerText(), '确认移除？');
  assert.equal(await page.locator('#settings-console [data-console-origin]').count(), 2);
  await page.locator(removeB).click();
  await page.waitForFunction(() => document.querySelectorAll('#settings-console [data-console-origin]').length === 1);
  assert.equal(await page.evaluate(k => sessionStorage.getItem(k), `__hub_${hostB}:device-token`), null);

  // 重启 App（进程被杀 = 会话解锁标记失效）：先解锁，解锁后首屏是控制台列表，点选才进入。
  await page.evaluate(() => sessionStorage.setItem('__hub_session', '0'));
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('unlock-card').hidden);
  await page.locator('#unlock').click();
  await page.waitForFunction(() => !document.getElementById('console-picker').hidden);
  assert.equal(await page.locator('#app-main').isVisible(), false, '解锁后首屏是控制台列表');
  assert.match(await page.locator('#console-picker').innerText(), /选择控制台/);
  await page.locator(`#console-picker [data-console-origin="${a.url}"] [data-action="select-console"]`).click();
  await page.waitForFunction(() => document.getElementById('connection-status')?.textContent?.includes('已安全连接') && !document.getElementById('app-main').hidden);

  const text = await page.locator('body').innerText();
  assert.ok(!text.includes(tokenA) && !text.includes(qrB.token), '页面不得出现设备凭证或一次性码');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '无横向溢出');
  assert.deepEqual(errors, []);
});
