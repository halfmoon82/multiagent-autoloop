// tab-swipe-fix 节点回归：手势判定阈值 + 旧鸿蒙 WebView（无 PointerEvent）touch 回退。
// 与原 mobile-tab-swipe.test.mjs 的 pointer 路径互补，本文件只覆盖被修复的兼容边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SWIPE_THRESHOLD_PX, TAP_SLOP_PX, SWIPE_RESULTS,
  decideRelease, createSwipeGesture, attachTabSwipe,
} from '../mobile/src/features/tab-swipe/index.mjs';

// 统一假表面：同时记录 pointer / touch / click 监听，便于断言两条路径互不串线。
function fakeSurface() {
  const listeners = {};
  return {
    style: {}, clientWidth: 360,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    emit(type, ev = {}) {
      const out = {
        target: {},
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
        ...ev,
      };
      for (const fn of listeners[type] || []) fn(out);
      return out;
    },
    types: () => Object.entries(listeners).filter(([, fns]) => fns.length).map(([type]) => type),
  };
}

const touchWin = () => ({ TouchEvent: function TE() {} });
const touch = (x, y) => ({ clientX: x, clientY: y, identifier: 0 });

// ---- 手势判定：角度 / 距离 / 速度阈值（逻辑层既有能力的基线断言）----

test('手势判定：横向距离阈值、相邻方向、速度、点击 slop、纵向主轴', () => {
  const base = { dy: 0, dt: 400, index: 2, count: 6, axis: 'x' };
  assert.deepEqual(decideRelease({ ...base, dx: -(SWIPE_THRESHOLD_PX - 1) }), { result: SWIPE_RESULTS.REVERT, to: -1 });
  assert.deepEqual(decideRelease({ ...base, dx: -(SWIPE_THRESHOLD_PX + 1) }), { result: SWIPE_RESULTS.SWITCH, to: 3 });
  assert.deepEqual(decideRelease({ ...base, dx: SWIPE_THRESHOLD_PX + 1 }), { result: SWIPE_RESULTS.SWITCH, to: 1 });
  assert.equal(decideRelease({ dx: -30, dy: 0, dt: 40, index: 1, count: 6, axis: 'x' }).result, SWIPE_RESULTS.SWITCH);
  assert.equal(decideRelease({ dx: -12, dy: 0, dt: 5, index: 1, count: 6, axis: 'x' }).result, SWIPE_RESULTS.REVERT);
  assert.equal(decideRelease({ dx: TAP_SLOP_PX - 1, dy: 2, dt: 80, index: 1, count: 6, axis: null }).result, SWIPE_RESULTS.TAP);
  assert.equal(decideRelease({ dx: -70, dy: 160, dt: 300, index: 1, count: 6, axis: 'y' }).result, SWIPE_RESULTS.REVERT);
});

test('状态机：位移锁定主轴后横向跟手，纵向主导不跟手', () => {
  const g = createSwipeGesture({ count: 6, getIndex: () => 2 });
  g.start({ x: 300, y: 100, t: 0 });
  assert.equal(g.move({ x: 295, y: 130, t: 30 }).dragging, false); // 纵向主导
  assert.equal(g.end({ x: 220, y: 200, t: 120 }).result, SWIPE_RESULTS.REVERT);
  g.start({ x: 300, y: 100, t: 0 });
  assert.equal(g.move({ x: 200, y: 102, t: 30 }).dragging, true); // 横向主导
  assert.equal(g.end({ x: 200, y: 102, t: 50 }).result, SWIPE_RESULTS.SWITCH);
});

// ---- 旧鸿蒙 WebView：无 PointerEvent，touch 回退（本节点修复目标）----

test('旧 WebView：无 PointerEvent 时回退 TouchEvent，只挂 touch 监听', () => {
  const surface = fakeSurface();
  const r = attachTabSwipe({
    surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b',
    select() {}, win: touchWin(),
  });
  assert.equal(r.supported, true);
  const types = surface.types();
  assert.deepEqual(types.filter(t => t.startsWith('touch')).sort(), ['touchcancel', 'touchend', 'touchmove', 'touchstart']);
  assert.equal(types.includes('pointerdown'), false);
  assert.equal(types.includes('click'), true);
  r.detach();
  assert.deepEqual(surface.types(), []);
});

test('旧 WebView：横向 touch 滑动切相邻 tab，跟手偏移在松手后复位', () => {
  const surface = fakeSurface();
  const picked = [];
  attachTabSwipe({
    surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b',
    select: n => picked.push(n), win: touchWin(),
  });
  surface.emit('touchstart', { target: {}, touches: [touch(300, 50)], timeStamp: 0 });
  const mv = surface.emit('touchmove', { touches: [touch(240, 52)], timeStamp: 40 });
  assert.equal(mv.defaultPrevented, true); // 横向跟手阻止原生平移
  assert.equal(surface.style.transform, 'translateX(-60px)');
  const up = surface.emit('touchend', { changedTouches: [touch(180, 52)], timeStamp: 80 });
  assert.equal(up.defaultPrevented, true); // 吞掉 WebView 合成的 click，避免误触
  assert.deepEqual(picked, ['c']);
  assert.equal(surface.style.transform, '');
});

test('旧 WebView：纵向 touch 滚动不切 tab，也不阻止原生滚动', () => {
  const surface = fakeSurface();
  const picked = [];
  attachTabSwipe({
    surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b',
    select: n => picked.push(n), win: touchWin(),
  });
  surface.emit('touchstart', { target: {}, touches: [touch(200, 40)], timeStamp: 0 });
  const mv = surface.emit('touchmove', { touches: [touch(196, 180)], timeStamp: 60 });
  assert.equal(mv.defaultPrevented, undefined);
  assert.ok(!surface.style.transform); // 纵向主导：不跟手、不产生横向偏移
  surface.emit('touchend', { changedTouches: [touch(196, 180)], timeStamp: 100 });
  assert.equal(surface.style.transform, '');
  assert.deepEqual(picked, []);
});

test('旧 WebView：点击路径不阻断；手势判定失败（可滚动容器）降级为仅点击', () => {
  const surface = fakeSurface();
  const picked = [];
  attachTabSwipe({
    surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b',
    select: n => picked.push(n), win: touchWin(),
  });
  // 纯点击：位移在 slop 内，合成 click 必须透传
  surface.emit('touchstart', { target: {}, touches: [touch(300, 50)], timeStamp: 0 });
  surface.emit('touchend', { changedTouches: [touch(302, 51)], timeStamp: 40 });
  assert.deepEqual(picked, []);
  const tapClick = surface.emit('click', { target: {} });
  assert.equal(tapClick.defaultPrevented, undefined);
  assert.equal(tapClick.stopped, undefined);
  // 起点落在横向滚动容器：不起手势，大幅滑动也不切页，click 透传
  const scroller = { scrollWidth: 800, clientWidth: 300, parentElement: null, style: { overflowX: 'auto' } };
  surface.emit('touchstart', { target: scroller, touches: [touch(300, 50)], timeStamp: 100 });
  surface.emit('touchend', { changedTouches: [touch(180, 50)], timeStamp: 200 });
  assert.deepEqual(picked, []);
  assert.equal(surface.emit('click', { target: {} }).defaultPrevented, undefined);
});

test('旧 WebView：touchcancel 打断后回弹；多指不起手势', () => {
  const surface = fakeSurface();
  const picked = [];
  attachTabSwipe({
    surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b',
    select: n => picked.push(n), win: touchWin(),
  });
  surface.emit('touchstart', { target: {}, touches: [touch(300, 50)], timeStamp: 0 });
  surface.emit('touchmove', { touches: [touch(180, 50)], timeStamp: 40 });
  surface.emit('touchcancel', { timeStamp: 50 });
  assert.equal(surface.style.transform, '');
  surface.emit('touchend', { changedTouches: [touch(180, 50)], timeStamp: 60 });
  assert.deepEqual(picked, []);
  // 多指同时落下不切页
  surface.emit('touchstart', { target: {}, touches: [touch(300, 50), touch(200, 50)], timeStamp: 100 });
  surface.emit('touchmove', { touches: [touch(150, 50)], timeStamp: 140 });
  surface.emit('touchend', { changedTouches: [touch(150, 50)], timeStamp: 160 });
  assert.deepEqual(picked, []);
});

test('旧 WebView：事件无 timeStamp 时按 Date.now 兜底，距离阈值仍可切页', () => {
  const surface = fakeSurface();
  const picked = [];
  attachTabSwipe({
    surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b',
    select: n => picked.push(n), win: touchWin(),
  });
  surface.emit('touchstart', { target: {}, touches: [touch(300, 50)] });
  surface.emit('touchmove', { touches: [touch(240, 50)] });
  surface.emit('touchend', { changedTouches: [touch(180, 50)] });
  assert.deepEqual(picked, ['c']);
});

test('无 TouchEvent 构造器但有 ontouchstart 的旧 WebView 仍启用 touch 回退', () => {
  const surface = fakeSurface();
  const r = attachTabSwipe({
    surface, tabOrder: () => ['a', 'b'], getActive: () => 'a',
    select() {}, win: { ontouchstart: null },
  });
  assert.equal(r.supported, true);
  assert.equal(surface.types().includes('touchstart'), true);
});

// ---- 不回归：现代浏览器与彻底不支持手势的环境 ----

test('有 PointerEvent 时仍走 pointer 路径，不注册 touch 监听（避免双重处理）', () => {
  const surface = fakeSurface();
  const r = attachTabSwipe({
    surface, tabOrder: () => ['a', 'b', 'c'], getActive: () => 'b',
    select() {}, win: { PointerEvent: function PE() {}, TouchEvent: function TE() {} },
  });
  assert.equal(r.supported, true);
  const types = surface.types();
  assert.equal(types.includes('pointerdown'), true);
  assert.equal(types.includes('touchstart'), false);
});

test('既无 PointerEvent 也无 TouchEvent：退化为纯点击，不挂任何监听', () => {
  const surface = fakeSurface();
  const r = attachTabSwipe({
    surface, tabOrder: () => ['a'], getActive: () => 'a',
    select() {}, win: {},
  });
  assert.equal(r.supported, false);
  assert.deepEqual(surface.types(), []);
  assert.doesNotThrow(() => r.detach());
});
