// mobile-scaffold 节点边界测试：共享接缝一次性预留，后续节点只改自己的文件。
// 覆盖受限静态服务、写路由 501 占位、默认钩子、页面栈返回键、离线兜底页与页面模块化结构。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveMobileAsset } from '../src/server.mjs';
import { handleMobileWrite, MOBILE_WRITE_ROUTES } from '../src/mobile-write.mjs';
import { MOBILE_PAGES, createDefaultHooks, createViewStack, createBackGuard } from '../mobile/app/www/app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');

function fakeRes() {
  const out = { status: null, headers: null, body: null };
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers; return this; },
    end(body) { out.body = typeof body === 'string' ? body : JSON.stringify(body); return this; },
  };
}
function fakeReq({ method = 'POST', headers = {} } = {}) {
  return {
    method,
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      'x-console-request': '1',
      'x-device-token': 'device-token',
      ...headers,
    },
  };
}

// ---------- 受限静态服务 ----------
test('受限静态服务可取 /mobile/pages 与 /mobile/src 的 mjs/css', () => {
  const page = resolveMobileAsset('/mobile/pages/core.mjs');
  assert.ok(page, '/mobile/pages/core.mjs 应可取');
  assert.match(page.type, /javascript/);
  const css = resolveMobileAsset('/mobile/pages/core.css');
  assert.ok(css, '/mobile/pages/core.css 应可取');
  assert.match(css.type, /css/);
  const view = resolveMobileAsset('/mobile/src/core/pages.mjs');
  assert.ok(view, '/mobile/src/core/pages.mjs 应可取');
  assert.match(view.type, /javascript/);
});

test('受限静态服务拒绝越界路径、非 .mjs 与符号链接逃逸', () => {
  assert.equal(resolveMobileAsset('/mobile/src/../package.json'), null);
  assert.equal(resolveMobileAsset('/mobile/src/%2e%2e/package.json'), null);
  assert.equal(resolveMobileAsset('/mobile/src/x.json'), null);
  assert.equal(resolveMobileAsset('/mobile/pages/../../server.mjs'), null);
  assert.equal(resolveMobileAsset('/mobile/pages/..%2f..%2fserver.mjs'), null);
  assert.equal(resolveMobileAsset('/mobile/src/core/pages.css'), null);
  assert.equal(resolveMobileAsset('/mobile/pages/Bad.mjs'), null);
});

test('受限静态服务对符号链接一律 404', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mobile-asset-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'mobile-outside-'));
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(outside, 'secret.mjs'), 'export const secret = 1;');
    symlinkSync(path.join(outside, 'secret.mjs'), path.join(dir, 'src', 'leak.mjs'));
    assert.equal(resolveMobileAsset('/mobile/src/leak.mjs', { src: path.join(dir, 'src') }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------- 写路由钩子 ----------
test('写路由表覆盖 scaffold 预留的全部占位路由', () => {
  const keys = MOBILE_WRITE_ROUTES.map(route => route.key);
  for (const key of ['card-answer', 'card-authorize', 'session-continue', 'session-download', 'sync', 'rule-action']) {
    assert.ok(keys.includes(key), `缺少占位路由 ${key}`);
  }
});

test('写路由在鉴权与同源校验通过后返回 501 占位', () => {
  const res = fakeRes();
  const handled = handleMobileWrite(fakeReq(), res, new URL('/api/mobile/cards/x/answer', 'http://localhost'), { device: { name: 't' } });
  assert.equal(handled, true);
  assert.equal(res.out.status, 501);
  const body = JSON.parse(res.out.body);
  assert.match(body.error, /尚未实现|待实现/);
});

test('写路由拒绝缺设备令牌、缺控制台标记、跨站与非 JSON', () => {
  const cases = [
    [{ 'x-device-token': '' }, 401],
    [{ 'x-console-request': '' }, 403],
    [{ origin: 'https://evil.example' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ];
  for (const [headers, status] of cases) {
    const res = fakeRes();
    const handled = handleMobileWrite(fakeReq({ headers }), res, new URL('/api/mobile/cards/x/answer', 'http://localhost'), { device: {} });
    assert.equal(handled, true, `应处理 ${JSON.stringify(headers)}`);
    assert.equal(res.out.status, status, `期望 ${status}：${JSON.stringify(headers)}`);
  }
});

test('GET 写路由也走设备校验且 501 占位；无关路径不接管', () => {
  const res = fakeRes();
  assert.equal(handleMobileWrite(fakeReq({ method: 'GET' }), res, new URL('/api/mobile/sync', 'http://localhost'), { device: {} }), true);
  assert.equal(res.out.status, 501);
  assert.equal(handleMobileWrite(fakeReq(), fakeRes(), new URL('/api/mobile/session', 'http://localhost'), { device: {} }), false);
  assert.equal(handleMobileWrite(fakeReq(), fakeRes(), new URL('/api/unrelated', 'http://localhost'), { device: {} }), false);
});

// ---------- 默认钩子 ----------
test('所有默认钩子可调用且不抛错，项目筛选返回空值', () => {
  const hooks = createDefaultHooks();
  assert.doesNotThrow(() => hooks.attachVoice(null));
  assert.doesNotThrow(() => hooks.notify.setBadge(3));
  assert.doesNotThrow(() => hooks.notify.refresh());
  assert.doesNotThrow(() => hooks.openSessionArtifacts('s1'));
  assert.equal(hooks.projectFilter.current(), null);
  assert.doesNotThrow(() => hooks.projectFilter.onChange(() => {}));
  assert.doesNotThrow(() => hooks.pushView({ id: 'x' }));
  assert.doesNotThrow(() => hooks.popView());
  assert.doesNotThrow(() => hooks.haptic.tap());
  assert.doesNotThrow(() => hooks.haptic.success());
  assert.doesNotThrow(() => hooks.download('https://example.org/a.apk', 'a.apk'));
});

// ---------- 页面栈与返回键 ----------
test('页面栈逐级回退，Tab 根页才提示二次退出', () => {
  const stack = createViewStack();
  assert.equal(stack.depth, 0);
  stack.push({ id: 'session-detail' });
  stack.push({ id: 'artifact-read' });
  assert.equal(stack.current().id, 'artifact-read');
  assert.equal(stack.back().view.id, 'artifact-read');
  assert.equal(stack.current().id, 'session-detail');
  assert.equal(stack.back().view.id, 'session-detail');
  assert.equal(stack.back().action, 'confirm-exit');
});

test('返回键二次确认只在短时间窗内生效', () => {
  let now = 1000;
  const guard = createBackGuard({ now: () => now, windowMs: 2500 });
  assert.equal(guard.press(), 'confirm');
  now = 2000;
  assert.equal(guard.press(), 'exit');
  now = 3000;
  assert.equal(guard.press(), 'confirm');
});

// ---------- 页面模块化结构 ----------
test('app.mjs 按固定列表 import 9 个页面模块', () => {
  const expected = ['core', 'sessions', 'artifacts', 'dag', 'project-filter', 'notify', 'voice', 'font-touch', 'devices'];
  assert.deepEqual(MOBILE_PAGES, expected);
  const code = read('mobile/app/www/app.mjs');
  for (const name of expected) assert.match(code, new RegExp(`pages/${name}\\.mjs`));
});

test('pages 目录每个模块导出 mount 并有同名 css', () => {
  for (const name of MOBILE_PAGES) {
    const mod = read(`mobile/app/www/pages/${name}.mjs`);
    assert.match(mod, /export function mount\s*\(/);
    assert.ok(existsSync(path.join(ROOT, 'mobile', 'app', 'www', 'pages', `${name}.css`)), `${name}.css 应存在`);
  }
});

test('页面通过相对路径 ../src/... 引用视图模型', () => {
  const core = read('mobile/app/www/pages/core.mjs');
  assert.match(core, /['"]\.\.\/src\//);
});

test('index.html 有 8 个 Tab 容器与锁屏两态挂载点', () => {
  const html = read('mobile/app/www/index.html');
  for (const tab of ['总览', '规则', '轮次', '待办', '会话', '产物', 'DAG', '设备']) assert.ok(html.includes(tab), `缺少 Tab ${tab}`);
  for (const id of ['page-core', 'page-rules', 'page-rounds', 'page-todos', 'page-sessions', 'page-artifacts', 'page-dag', 'page-devices']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="bind-card"/);
  assert.match(html, /id="unlock-card"/);
  for (const id of ['project-filter-root', 'notify-root', 'voice-root', 'font-touch-root']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="toast"/);
});

test('capacitor 配置把 errorPath 指向内置 offline.html', () => {
  const cfg = JSON.parse(read('mobile/app/capacitor.config.json'));
  assert.equal(cfg.server.errorPath, 'offline.html');
});

// ---------- 离线兜底页 ----------
test('offline.html 独立兜底，重试指向远程地址且不含凭证', () => {
  const html = read('mobile/app/www/offline.html');
  assert.match(html, /网络不可用/);
  assert.match(html, /id="retry"/);
  assert.match(html, /name="autoloop-console-mobile-url"/);
  assert.doesNotMatch(html, /location\.reload/);
  assert.match(html, /navigator\.onLine/);
  assert.match(html, /window\.location\.href/);
  assert.doesNotMatch(html, /deviceToken|tokenHash|x-device-token|server-secret/i);
});
