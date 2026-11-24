// app-startup-perf：静态资源 hash 长缓存 + 非首屏页面懒加载。
// 入口文档保持 no-store；hash 资源仅在 URL 版本与当前内容一致时才 immutable；路径校验不放松。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createConsoleServer, mobileAssetVersion, versionMobileText } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { MOBILE_PAGES, EAGER_PAGES, DEFERRED_PAGES } from '../mobile/app/www/app.mjs';
import { listen, close, fakeHub, json } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');

async function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-startup-'));
  const store = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [], lines: [], spending: {} } : { ok: true }));
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json'), deviceAuth: store, projectRoots: [root] });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); });
  return { url, store };
}

test('版本号是内容 hash：16 位十六进制且稳定', () => {
  const v = mobileAssetVersion();
  assert.match(v, /^[0-9a-f]{16}$/);
  assert.equal(mobileAssetVersion(), v);
});

test('入口文档 no-store，且本地 css/mjs 引用被改写为带版本', async t => {
  const { url } = await setup(t);
  const v = mobileAssetVersion();
  for (const p of ['/mobile/', '/mobile/index.html']) {
    const res = await fetch(`${url}${p}`);
    assert.equal(res.headers.get('cache-control'), 'no-store', p);
    const html = await res.text();
    assert.ok(html.includes(`src="./app.mjs?v=${v}"`), '入口脚本带版本');
    assert.ok(html.includes(`href="./styles.css?v=${v}"`));
    assert.ok(html.includes(`href="./pages/core.css?v=${v}"`));
    assert.ok(html.includes('href="./manifest.webmanifest"'), '清单不改写');
  }
});

test('hash 资产：版本匹配 → 长缓存 immutable；缺失/过期版本 → no-store；安全头不回退', async t => {
  const { url } = await setup(t);
  const v = mobileAssetVersion();
  for (const p of ['/mobile/app.mjs', '/mobile/shell.mjs', '/mobile/styles.css', '/mobile/pages/core.mjs', '/mobile/pages/core.css', '/mobile/src/core/index.mjs']) {
    const hit = await fetch(`${url}${p}?v=${v}`);
    assert.equal(hit.status, 200, p);
    assert.match(hit.headers.get('cache-control'), /max-age=31536000.*immutable/, p);
    assert.match(hit.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(hit.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(hit.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(`${url}${p}`)).headers.get('cache-control'), 'no-store', `${p} 无版本`);
    assert.equal((await fetch(`${url}${p}?v=deadbeefdeadbeef`)).headers.get('cache-control'), 'no-store', `${p} 过期版本`);
  }
  assert.equal((await fetch(`${url}/mobile/?v=${v}`)).headers.get('cache-control'), 'no-store', '入口文档永不长缓存');
});

test('JS 内部相对 import 被改写为带同一版本，改动内容会换版本', async t => {
  const { url } = await setup(t);
  const v = mobileAssetVersion();
  const app = await (await fetch(`${url}/mobile/app.mjs?v=${v}`)).text();
  assert.ok(app.includes(`'./pages/core.mjs?v=${v}'`));
  assert.ok(app.includes(`from './shell.mjs?v=${v}'`));
  assert.equal(versionMobileText("import x from './a.mjs'; import('../b/c.mjs');", 'text/javascript', 'abc'), "import x from './a.mjs?v=abc'; import('../b/c.mjs?v=abc');");
  assert.equal(versionMobileText('x', 'text/css', 'abc'), 'x');
  assert.notEqual(mobileAssetVersion({ roots: [path.join(ROOT, 'mobile/app/www')], now: Date.now() + 5000 }), v, '根目录集合不同则版本不同');
});

test('缓存不放松路径校验：.. / 编码 / 非 kebab / 非白名单仍 404', async t => {
  const { url } = await setup(t);
  const v = mobileAssetVersion();
  for (const p of ['/mobile/pages/..%2Fshell.mjs', '/mobile/pages/%252e%252e%252fshell.mjs', '/mobile/src/%2e%2e/%2e%2e/src/server.mjs', '/mobile/pages/Core.mjs', '/mobile/build-apk.mjs', '/mobile/package.json', '/mobile/vendor/LICENSE']) {
    assert.equal((await fetch(`${url}${p}?v=${v}`)).status, 404, p);
  }
});

test('页面清单：首屏页与延迟页划分完整，app.mjs 不再静态 import 页面模块', () => {
  assert.deepEqual([...EAGER_PAGES, ...DEFERRED_PAGES].sort(), [...MOBILE_PAGES].sort());
  for (const name of ['core', 'project-filter', 'notify', 'font-touch', 'settings']) assert.ok(EAGER_PAGES.includes(name), name);
  for (const name of ['sessions', 'artifacts', 'dag', 'voice', 'devices', 'admin']) assert.ok(DEFERRED_PAGES.includes(name), name);
  const code = read('mobile/app/www/app.mjs');
  assert.doesNotMatch(code, /^import \* as \w+Page from/m);
  for (const name of MOBILE_PAGES) assert.match(code, new RegExp(`import\\('\\./pages/${name}\\.mjs'\\)`));
  assert.match(code, /design-authorize/, '授权页登记在清单中');
});

test('build-apk 把 www 内容指纹写入离线页 meta', () => {
  const code = read('mobile/app/build-apk.mjs');
  assert.match(code, /autoloop-www-fingerprint/);
  assert.match(code, /createHash\('sha256'\)/);
});

const browserSkip = (() => {
  try { return existsSync(chromium.executablePath()) ? false : 'npm test 阶段未安装 Playwright Chromium，跳过浏览器回归'; }
  catch { return '无法探测 Playwright Chromium，跳过浏览器回归'; }
})();

async function openApp(t, { block } = {}) {
  const { url, store } = await setup(t);
  const qr = store.createBinding();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const requested = [];
  page.on('request', r => requested.push(new URL(r.url()).pathname));
  if (block) await page.route(block, route => route.abort());
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(v) { stored = v; }, async remove() { stored = null; } };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  return { page, qr, errors, requested };
}
async function unlock(page, qr) {
  await page.locator('#bind-payload').fill(qr.qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
}

test('浏览器：6 个 Tab + 授权页可达；全部页面模块延迟加载后挂好', { skip: browserSkip }, async t => {
  const { page, qr, errors } = await openApp(t);
  await unlock(page, qr);
  await page.waitForFunction(() => window.__autoloopPagesReady === true);
  for (const tab of ['core', 'rules', 'sessions', 'rounds', 'todos', 'admin']) {
    await page.evaluate(name => window.AutoloopNav.selectTab(name), tab);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.content .page')].filter(p => !p.hidden).map(p => p.dataset.page)), [tab]);
  }
  for (const route of ['artifacts', 'dag']) {
    await page.evaluate(name => window.AutoloopNav.selectTab(name), route);
    assert.equal(await page.evaluate(name => document.getElementById(`page-${name}`).hidden, route), false);
  }
  await page.evaluate(() => window.AutoloopHooks.openSettings());
  assert.equal(await page.evaluate(() => document.getElementById('page-settings').hidden), false);
  const feature = await page.evaluate(() => window.AutoloopHooks.loadFeature('design-authorize').then(m => (m ? Object.keys(m).length : null)));
  assert.ok(feature === null || feature >= 0, 'loadFeature 要么返回模块要么返回 null，不抛错');
  assert.deepEqual(errors, []);
});

test('浏览器：延迟页加载失败不影响首屏与其他页', { skip: browserSkip }, async t => {
  const { page, qr } = await openApp(t, { block: /\/mobile\/pages\/dag\.mjs/ });
  await unlock(page, qr);
  await page.waitForFunction(() => window.__autoloopPagesReady === true);
  assert.equal(await page.evaluate(() => document.getElementById('app-main').hidden), false);
  assert.ok((await page.evaluate(() => document.getElementById('page-core').children.length)) > 0, '首屏已渲染');
  await page.evaluate(() => window.AutoloopNav.selectTab('sessions'));
  assert.equal(await page.evaluate(() => document.getElementById('page-sessions').hidden), false);
});

test('浏览器：二次打开命中 HTTP 缓存，不重拉 hash 资产', { skip: browserSkip }, async t => {
  const { url } = await setup(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  const served = [];
  page.on('response', r => { if (/\/mobile\/.*\.(mjs|css)/.test(r.url())) served.push({ url: r.url(), cache: r.headers()['cache-control'], fromCache: r.fromServiceWorker() }); });
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  const first = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => /\/mobile\/.*\.(mjs|css)/.test(e.name)).map(e => e.transferSize));
  assert.ok(first.some(size => size > 0), '首次需要网络');
  await page.reload();
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  const second = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => /\/mobile\/.*\.(mjs|css)\?v=/.test(e.name)).map(e => e.transferSize));
  assert.ok(second.length > 0 && second.every(size => size === 0), '带 hash 的资产二次加载走缓存（transferSize=0）');
});
