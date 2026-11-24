// tab-swipe 节点边界测试：手势判定（纯逻辑）、DOM 接线（假元素）、真实浏览器合成事件回归。
// 阈值内回弹、越阈切页、首/末页阻尼、可横向滚动容器内不拦截、点击仍可用、不支持 PointerEvent 退化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  SWIPE_THRESHOLD_PX, TAP_SLOP_PX, SWIPE_RESULTS,
  dampOffset, targetIndex, decideRelease, createSwipeGesture,
  attachTabSwipe, isHorizontallyScrollable,
} from '../mobile/src/features/tab-swipe/index.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(REPO, rel), 'utf8');

test('阈值内回弹，越阈切相邻 Tab，方向正确', () => {
  const base = { dy: 0, dt: 400, index: 2, count: 6, axis: 'x' };
  assert.deepEqual(decideRelease({ ...base, dx: -(SWIPE_THRESHOLD_PX - 8) }), { result: SWIPE_RESULTS.REVERT, to: -1 });
  assert.deepEqual(decideRelease({ ...base, dx: -(SWIPE_THRESHOLD_PX + 1) }), { result: SWIPE_RESULTS.SWITCH, to: 3 });
  assert.deepEqual(decideRelease({ ...base, dx: SWIPE_THRESHOLD_PX + 1 }), { result: SWIPE_RESULTS.SWITCH, to: 1 });
});

test('速度达标的短距离快划也切页；极短抖动不切', () => {
  assert.equal(decideRelease({ dx: -30, dy: 0, dt: 40, index: 1, count: 6, axis: 'x' }).result, SWIPE_RESULTS.SWITCH);
  assert.equal(decideRelease({ dx: -12, dy: 0, dt: 5, index: 1, count: 6, axis: 'x' }).result, SWIPE_RESULTS.REVERT);
});

test('首页右滑 / 末页左滑回弹（不切页）；偏移被阻尼', () => {
  assert.equal(decideRelease({ dx: 120, dy: 0, dt: 200, index: 0, count: 6, axis: 'x' }).result, SWIPE_RESULTS.REVERT);
  assert.equal(decideRelease({ dx: -120, dy: 0, dt: 200, index: 5, count: 6, axis: 'x' }).result, SWIPE_RESULTS.REVERT);
  assert.equal(targetIndex(0, 50, 6), -1);
  assert.equal(targetIndex(5, -50, 6), -1);
  const damped = dampOffset(200, { atStart: true, width: 360 });
  assert.ok(damped > 0 && damped < 200 * 0.5 && damped <= 90);
  assert.equal(dampOffset(200, { atStart: false, atEnd: true, width: 360 }), 200); // 朝中间拖不阻尼
  assert.equal(dampOffset(-200, { atEnd: true, width: 360 }) < 0, true);
  assert.equal(dampOffset(Number.NaN), 0);
});

test('点击与滑动互斥：位移小于阈值视为点击；竖向主轴不切页', () => {
  assert.equal(decideRelease({ dx: TAP_SLOP_PX - 1, dy: 2, dt: 80, index: 1, count: 6, axis: null }).result, SWIPE_RESULTS.TAP);
  assert.equal(decideRelease({ dx: -70, dy: 160, dt: 300, index: 1, count: 6, axis: 'y' }).result, SWIPE_RESULTS.REVERT);
});

test('count 可为函数：Tab 数运行时增加后末页判定随之更新', () => {
  let count = 2;
  const g = createSwipeGesture({ count: () => count, getIndex: () => 1 });
  g.start({ x: 300, y: 0, t: 0 }); g.move({ x: 150, y: 0, t: 50 });
  assert.equal(g.end({ x: 150, y: 0, t: 60 }).result, SWIPE_RESULTS.REVERT);
  count = 3;
  g.start({ x: 300, y: 0, t: 0 }); g.move({ x: 150, y: 0, t: 50 });
  assert.deepEqual(g.end({ x: 150, y: 0, t: 60 }), { result: SWIPE_RESULTS.SWITCH, to: 2 });
});

test('状态机：起点被标记为可滚动容器则不拦截；cancel 回弹', () => {
  let index = 1;
  const g = createSwipeGesture({ count: 6, getIndex: () => index });
  assert.equal(g.start({ x: 100, y: 100, t: 0, blocked: true }), false);
  assert.deepEqual(g.move({ x: 20, y: 100, t: 50 }), { dragging: false, offset: 0 });
  assert.equal(g.start({ x: 200, y: 100, t: 0 }), true);
  assert.equal(g.move({ x: 150, y: 102, t: 60 }).dragging, true);
  const c = g.cancel();
  assert.equal(c.result, SWIPE_RESULTS.REVERT);
  assert.equal(c.interrupted, true);
  assert.equal(g.end({ x: 0, y: 0, t: 100 }).result, SWIPE_RESULTS.REVERT); // 打断后松手不切页
  index = -1; // 当前页不在 Tab 栏（产物/DAG）：不起手势
  assert.equal(g.start({ x: 1, y: 1, t: 0 }), false);
});

// ---- DOM 接线（假元素）----
function fakeSurface() {
  const handlers = {};
  const captureHandlers = {};
  let captured = null;
  return {
    style: {}, clientWidth: 360,
    addEventListener(type, fn, opts) { (opts === true || opts?.capture ? captureHandlers : handlers)[type] = fn; },
    removeEventListener(type, fn, opts) { delete (opts === true || opts?.capture ? captureHandlers : handlers)[type]; },
    fire(type, e, capture = false) {
      const ev = { pointerId: 1, pointerType: 'touch', timeStamp: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...e };
      (capture ? captureHandlers : handlers)[type]?.(ev);
      return ev;
    },
    setPointerCapture(id) { captured = id; },
    releasePointerCapture(id) { if (captured === id) captured = null; },
    get captured() { return captured; },
    handlers, captureHandlers,
  };
}

test('接线：越阈松手经 select 切页，偏移在松手后复位', () => {
  const surface = fakeSurface();
  const order = ['a', 'b', 'c'];
  const picked = [];
  attachTabSwipe({ surface, tabOrder: () => order, getActive: () => 'b', select: n => picked.push(n), win: { PointerEvent: function PE() {}, addEventListener() {}, removeEventListener() {} } });
  surface.fire('pointerdown', { clientX: 300, clientY: 50, target: {}, timeStamp: 0 });
  surface.fire('pointermove', { clientX: 200, clientY: 52, timeStamp: 100 });
  assert.equal(surface.style.transform, 'translateX(-100px)');
  surface.fire('pointerup', { clientX: 200, clientY: 52, timeStamp: 120 });
  assert.deepEqual(picked, ['c']);
  assert.equal(surface.style.transform, '');
});

test('接线：未越阈回弹不切页；点击不切页；被 isEnabled 拒绝不起手势', () => {
  const surface = fakeSurface();
  const picked = [];
  let enabled = true;
  attachTabSwipe({ surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b', isEnabled: () => enabled, select: n => picked.push(n), win: { PointerEvent: function PE() {} } });
  surface.fire('pointerdown', { clientX: 300, clientY: 50, target: {}, timeStamp: 0 });
  surface.fire('pointermove', { clientX: 280, clientY: 50, timeStamp: 500 });
  surface.fire('pointerup', { clientX: 280, clientY: 50, timeStamp: 600 });
  surface.fire('pointerdown', { clientX: 300, clientY: 50, target: {}, timeStamp: 0 });
  surface.fire('pointerup', { clientX: 301, clientY: 50, timeStamp: 50 });
  enabled = false;
  surface.fire('pointerdown', { clientX: 300, clientY: 50, target: {}, timeStamp: 0 });
  surface.fire('pointermove', { clientX: 100, clientY: 50, timeStamp: 100 });
  surface.fire('pointerup', { clientX: 100, clientY: 50, timeStamp: 120 });
  assert.deepEqual(picked, []);
});

test('接线：pointercancel / blur 打断后回弹到当前页，不切页', () => {
  const surface = fakeSurface();
  const picked = [];
  let blur;
  attachTabSwipe({ surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b', select: n => picked.push(n), win: { PointerEvent: function PE() {}, addEventListener(t, f) { if (t === 'blur') blur = f; }, removeEventListener() {} } });
  surface.fire('pointerdown', { clientX: 300, clientY: 50, target: {}, timeStamp: 0 });
  surface.fire('pointermove', { clientX: 150, clientY: 50, timeStamp: 100 });
  blur();
  assert.equal(surface.style.transform, '');
  surface.fire('pointerup', { clientX: 150, clientY: 50, timeStamp: 120 });
  surface.fire('pointerdown', { clientX: 300, clientY: 50, target: {}, timeStamp: 0 });
  surface.fire('pointermove', { clientX: 150, clientY: 50, timeStamp: 100 });
  surface.fire('pointercancel', {});
  assert.equal(surface.style.transform, '');
  assert.deepEqual(picked, []);
});

test('接线：拖动切页后拦截 click，避免误触按下处元素；纯点击不拦截', () => {
  const surface = fakeSurface();
  const picked = [];
  attachTabSwipe({ surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b', select: n => picked.push(n), win: { PointerEvent: function PE() {} } });
  surface.fire('pointerdown', { clientX: 300, clientY: 50, target: {}, timeStamp: 0 });
  surface.fire('pointermove', { clientX: 200, clientY: 52, timeStamp: 100 });
  surface.fire('pointerup', { clientX: 200, clientY: 52, timeStamp: 120 });
  const swipedClick = surface.fire('click', { target: {} }, true);
  assert.equal(swipedClick.defaultPrevented, true);
  assert.equal(swipedClick.stopped, true);
  assert.deepEqual(picked, ['c']);
  // 纯点击：位移不足阈值，click 必须照常透传
  surface.fire('pointerdown', { clientX: 300, clientY: 50, target: {}, timeStamp: 200 });
  surface.fire('pointerup', { clientX: 302, clientY: 50, timeStamp: 260 });
  const tapClick = surface.fire('click', { target: {} }, true);
  assert.equal(tapClick.defaultPrevented, undefined);
  assert.equal(tapClick.stopped, undefined);
});

test('接线：仅横向拖动才捕获指针，pointerup / 丢失捕获后释放并复位', () => {
  const surface = fakeSurface();
  const picked = [];
  attachTabSwipe({ surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b', select: n => picked.push(n), win: { PointerEvent: function PE() {} } });
  surface.fire('pointerdown', { pointerId: 9, clientX: 300, clientY: 50, target: {}, timeStamp: 0 });
  assert.equal(surface.captured, null); // 按下不捕获：.content 内按钮的 click 必须照常命中
  surface.fire('pointermove', { pointerId: 9, clientX: 200, clientY: 52, timeStamp: 100 });
  assert.equal(surface.captured, 9); // 主轴锁定为横向后才捕获，鼠标拖出仍能收到 pointerup
  surface.fire('pointerup', { pointerId: 9, clientX: 200, clientY: 52, timeStamp: 120 });
  assert.equal(surface.captured, null);
  assert.deepEqual(picked, ['c']);
  surface.fire('pointerdown', { pointerId: 10, clientX: 300, clientY: 50, target: {}, timeStamp: 200 });
  surface.fire('pointermove', { pointerId: 10, clientX: 150, clientY: 50, timeStamp: 300 });
  assert.equal(surface.captured, 10);
  assert.equal(surface.style.transform, 'translateX(-150px)');
  surface.fire('lostpointercapture', { pointerId: 10 });
  assert.equal(surface.captured, null);
  assert.equal(surface.style.transform, '');
  surface.fire('pointerup', { pointerId: 10, clientX: 150, clientY: 50, timeStamp: 400 });
  assert.deepEqual(picked, ['c']); // 打断后不切页
});

test('接线：点击 .content 内按钮不捕获指针、不拦 click', () => {
  const surface = fakeSurface();
  const picked = [];
  attachTabSwipe({ surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b', select: n => picked.push(n), win: { PointerEvent: function PE() {} } });
  surface.fire('pointerdown', { pointerId: 3, clientX: 300, clientY: 50, target: {}, timeStamp: 0 });
  surface.fire('pointerup', { pointerId: 3, clientX: 301, clientY: 50, timeStamp: 60 });
  assert.equal(surface.captured, null);
  const click = surface.fire('click', { target: {} }, true);
  assert.equal(click.defaultPrevented, undefined);
  assert.equal(click.stopped, undefined);
  assert.deepEqual(picked, []);
});

test('不支持 PointerEvent 时退化为无手势，不抛错、不挂监听', () => {
  const surface = fakeSurface();
  const r = attachTabSwipe({ surface, tabOrder: () => ['a'], getActive: () => 'a', select() {}, win: {} });
  assert.equal(r.supported, false);
  assert.deepEqual(Object.keys(surface.handlers), []);
  assert.doesNotThrow(() => r.detach());
});

test('可横向滚动容器识别：overflow-x auto 且内容更宽才算', () => {
  const root = { parentElement: null };
  const scroller = { parentElement: root, scrollWidth: 800, clientWidth: 300, style: { overflowX: 'auto' } };
  const inner = { parentElement: scroller, scrollWidth: 100, clientWidth: 100, style: {} };
  const plain = { parentElement: root, scrollWidth: 800, clientWidth: 300, style: { overflowX: 'visible' } };
  assert.equal(isHorizontallyScrollable(inner, root), true);
  assert.equal(isHorizontallyScrollable({ parentElement: plain, scrollWidth: 10, clientWidth: 10, style: {} }, root), false);
});

test('app.mjs 接线：滑动与点击走同一 selectTab；styles 限定 touch-action', () => {
  const app = read('mobile/app/www/app.mjs');
  assert.match(app, /features\/tab-swipe\/index\.mjs/);
  assert.match(app, /select: selectTab/);
  assert.match(app, /tab\.addEventListener\('click', \(\) => selectTab\(tab\.dataset\.tab\)\)/);
  const styles = read('mobile/app/www/styles.css');
  assert.match(styles, /\.content \{[^}]*touch-action: pan-y/);
  // 审阅 P2：横向裁剪不得建立滚动容器，否则会话页 sticky 输入栏脱离视口。
  assert.match(styles, /\.content \{[^}]*overflow-x: clip/);
});

// ---- 真实浏览器：合成 pointer(touch) 事件 ----
const browserSkip = (() => {
  try {
    return existsSync(chromium.executablePath()) ? false : 'npm test 阶段未安装 Playwright Chromium，跳过浏览器回归';
  } catch { return '无法探测 Playwright Chromium，跳过浏览器回归'; }
})();

test('浏览器：双向滑动切页、aria 语义不变、横向滚动容器内不拦截、点击仍可用', { skip: browserSkip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-tab-swipe-'));
  const hub = await fakeHub((req, res) => json(res, req.url === '/v1/state' ? { runs: [], cards: [], lines: [], spending: {} } : { ok: true }));
  const deviceAuth = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const server = createConsoleServer({ hubUrl: hub.url, ownerKey: 'server-secret', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json'), deviceAuth, projectRoots: [root] });
  const url = await listen(server);
  let browser;
  t.after(async () => { if (browser) await browser.close(); await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); });
  const qr = deviceAuth.createBinding();
  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    let stored = null;
    window.AutoloopSecureStorage = { async get() { return stored; }, async set(v) { stored = v; }, async remove() { stored = null; } };
    window.AutoloopBiometric = { async verify() { return true; } };
  });
  await page.goto(`${url}/mobile/`);
  await page.waitForFunction(() => Boolean(window.AutoloopHooks));
  await page.locator('#bind-payload').fill(qr.qrPayload);
  await page.locator('#bind-submit').click();
  await page.waitForFunction(() => document.getElementById('bind-status')?.textContent?.includes('绑定成功'));
  await page.locator('#unlock').click();
  await page.locator('#app-main').waitFor({ state: 'visible' });
  // 手势接线是异步 import，等到 touch-action 之外的真实效果出现：先试探一次。
  const state = () => page.evaluate(() => ({
    selected: [...document.querySelectorAll('#tab-bar .tab')].filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.dataset.tab),
    visible: [...document.querySelectorAll('.content .page')].filter(p => !p.hidden).map(p => p.dataset.page),
    transform: document.querySelector('.content').style.transform,
  }));
  // 单个 page.evaluate 内合成一次完整手势（含起点选择器），避免撞上重建。
  const gesture = async (sel, dx, { steps = 4, dy = 0, slow = false, scroller = false } = {}) => {
    await page.evaluate(({ sel, dx, steps, dy, slow, scroller }) => {
    // scroller：在同一次 evaluate 内现建横向滚动容器再起手势（页面会定时重建，跨调用的节点会被摘除）。
    if (scroller) {
      const box = document.createElement('div');
      box.id = 'swipe-probe-scroller';
      box.style.cssText = 'overflow-x:auto;width:200px;height:60px';
      const wide = document.createElement('div'); // CSP 禁内联 style 属性，只能走 CSSOM
      wide.style.cssText = 'width:900px;height:40px';
      wide.textContent = 'wide';
      box.append(wide);
      document.querySelector(sel).append(box);
    }
    const surface = document.querySelector('.content');
    const target = (scroller ? document.getElementById('swipe-probe-scroller') : document.querySelector(sel)) || surface;
    const r = target.getBoundingClientRect();
    const x0 = r.left + r.width / 2; const y0 = r.top + Math.min(20, r.height / 2);
    const fire = (type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true }));
    fire('pointerdown', x0, y0);
    for (let i = 1; i <= steps; i++) fire('pointermove', x0 + (dx * i) / steps, y0 + (dy * i) / steps);
    const up = () => fire('pointerup', x0 + dx, y0 + dy);
    // slow：合成事件本身几乎瞬时（速度会被判为很快），慢手势在松手前停 500ms 模拟真实慢拖。
    if (slow) return new Promise(resolve => setTimeout(() => { up(); resolve(); }, 500));
    up();
  }, { sel, dx, steps, dy, slow, scroller });
    await page.waitForTimeout(260); // 等回弹/切页过渡（180ms）落定，再读状态或发下一次手势
  };

  await page.waitForTimeout(200); // 手势接线是异步 import，等其挂好
  assert.deepEqual((await state()).selected, ['core']);
  await gesture('#page-core', -140);
  assert.deepEqual(await state(), { selected: ['rules'], visible: ['rules'], transform: '' });
  await gesture('#page-rules', -140);
  assert.deepEqual((await state()).selected, ['sessions']);
  await gesture('#page-sessions', 140);
  assert.deepEqual((await state()).selected, ['rules']);
  // 未越阈回弹
  await gesture('#page-rules', -30, { slow: true });
  await gesture('#page-rules', -40, { slow: true });
  assert.deepEqual((await state()).selected, ['rules']);
  // 首页右滑回弹
  await page.locator('[data-tab="core"]').click();
  await gesture('#page-core', 160);
  assert.deepEqual((await state()).selected, ['core']);
  // 末页左滑回弹（运行时同样固定为六栏，末页以实际 Tab 栏为准）
  const lastTab = await page.evaluate(() => [...document.querySelectorAll('#tab-bar .tab')].at(-1).dataset.tab);
  await page.locator(`[data-tab="${lastTab}"]`).click();
  await gesture(`#page-${lastTab}`, -160);
  assert.deepEqual((await state()).selected, [lastTab]);
  // 起点在横向滚动容器内：不拦截
  await page.locator('[data-tab="core"]').click();
  await gesture('#page-core', -160, { scroller: true });
  assert.deepEqual((await state()).selected, ['core']);
  // 点击仍可用，aria-hidden 语义（hidden 属性）与选中同步
  await page.locator('[data-tab="todos"]').click();
  assert.deepEqual(await state(), { selected: ['todos'], visible: ['todos'], transform: '' });
  // 审阅 P2 回归：长内容下会话页输入栏仍吸底——.content 不得成为横向滚动容器。
  await page.locator('[data-tab="sessions"]').click();
  const composer = await page.evaluate(() => {
    const el = document.querySelector('.sessions-composer');
    if (!el) return { ok: false, reason: 'no composer' };
    for (let n = el; n && n !== document.body; n = n.parentElement) n.removeAttribute('hidden');
    // 模拟正常进入详情：列表隐藏，详情按 fitDetail 的同一公式占满剩余可视高度。
    // 不能只摘掉 hidden，否则列表+详情同时显示，得到生产流程中不存在的长页面假场景。
    document.querySelector('.sessions-view[data-view="list"]')?.setAttribute('hidden', '');
    const detail = document.querySelector('.sessions-view[data-view="detail"]');
    const screen = document.querySelector('main.screen');
    screen.style.height = '100vh';
    screen.scrollTop = 0;
    const top = Math.max(0, detail.getBoundingClientRect().top);
    const bottomGap = Number.parseFloat(getComputedStyle(screen).paddingBottom) || 0;
    detail.style.height = `${Math.max(240, Math.floor(window.innerHeight - top - bottomGap))}px`;
    const spacer = document.createElement('div');
    spacer.style.cssText = 'height:3000px';
    el.parentNode.insertBefore(spacer, el);
    // 停在长内容顶部：flex:none 输入栏应仍贴在详情底部（与 sticky 等价的合同实现）。
    const box = el.getBoundingClientRect();
    const screenBox = screen.getBoundingClientRect();
    return {
      ok: box.bottom <= Math.min(window.innerHeight, screenBox.bottom) + 2 && box.top < window.innerHeight,
      bottom: Math.round(box.bottom), top: Math.round(box.top),
      vh: window.innerHeight, screenBottom: Math.round(screenBox.bottom),
      overflowX: getComputedStyle(document.querySelector('.content')).overflowX,
    };
  });
  assert.equal(composer.overflowX, 'clip');
  assert.equal(composer.ok, true, `composer 应保持吸底: ${JSON.stringify(composer)}`);
  assert.deepEqual(errors, []);
});
