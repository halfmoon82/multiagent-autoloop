// tab-swipe DOM 接线：把手势状态机接到主内容区的 pointer / touch 事件。
// 现代浏览器用 PointerEvent；旧鸿蒙 WebView 等缺失 PointerEvent 的环境退到 TouchEvent，
// 两条路径都喂同一个 createSwipeGesture；两者都不可用时退化为无手势（纯点击），不抛错。
// 滑动与点击切页都走调用方给的 select。
import { createSwipeGesture, SWIPE_RESULTS } from './gesture.mjs';

// 起点在可横向滚动容器（代码段、表格、横向列表）内则不拦截。
export function isHorizontallyScrollable(el, root) {
  for (let node = el; node && node !== root; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
    const overflowX = style ? style.overflowX : node.style?.overflowX;
    if (overflowX === 'auto' || overflowX === 'scroll') return true;
  }
  return false;
}

const isFn = (win, name) => typeof win?.[name] === 'function';
const TOUCH_ID = 'touch'; // touch 路径的统一触点标识，避免与真实 pointerId 混淆

export function attachTabSwipe({ surface, tabOrder, getActive, isEnabled = () => true, select, win = globalThis }) {
  if (!surface) return { detach() {}, supported: false };
  // PointerEvent 优先；缺失时旧 WebView 走 TouchEvent（有些引擎只有 ontouchstart 而无构造器）。
  const usePointer = isFn(win, 'PointerEvent');
  const useTouch = !usePointer && (isFn(win, 'TouchEvent') || 'ontouchstart' in win);
  if (!usePointer && !useTouch) return { detach() {}, supported: false };

  const order = () => tabOrder();
  const gesture = createSwipeGesture({
    count: () => order().length,
    getIndex: () => order().indexOf(getActive()),
    width: () => surface.clientWidth || 360,
  });
  let activeId = null;
  let capturedId = null;
  let dragged = false;
  let suppressClick = false;
  let suppressTimer = null;
  const now = e => (typeof e.timeStamp === 'number' ? e.timeStamp : Date.now());
  const setOffset = (px, animate) => {
    surface.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    surface.style.transform = px ? `translateX(${px}px)` : '';
  };
  const idOf = e => (usePointer ? e.pointerId : TOUCH_ID);
  // touch 事件用 touches/changedTouches 取坐标；旧 WebView 有时 timeStamp 缺失，由 now() 兜底。
  const pointOf = (e, phase) => {
    if (usePointer) return { x: e.clientX, y: e.clientY, target: e.target };
    const list = phase === 'end'
      ? (e.changedTouches?.length ? e.changedTouches : e.touches)
      : (e.touches?.length ? e.touches : e.changedTouches);
    if (!list || !list.length) return null;
    const t = list[0];
    return { x: t.clientX, y: t.clientY, target: e.target };
  };
  const preventNative = e => {
    if (typeof e.preventDefault === 'function' && e.cancelable !== false) e.preventDefault();
  };
  // 仅当主轴判定为横向拖动后才捕获指针：若在 pointerdown 就捕获，会把 .content 内按钮
  // （如 #reconnect）的 pointerup/click 重定向到 .content，导致按钮点不动。
  const capture = id => {
    if (!usePointer || capturedId === id || typeof surface.setPointerCapture !== 'function') return;
    try { surface.setPointerCapture(id); capturedId = id; } catch { /* 无效 pointerId：退化为无捕获 */ }
  };
  const releaseCapture = id => {
    if (!usePointer || id === null || capturedId !== id || typeof surface.releasePointerCapture !== 'function') return;
    capturedId = null;
    try { surface.releasePointerCapture(id); } catch { /* 捕获已随节点移除而丢失，忽略 */ }
  };
  const reset = () => {
    const id = activeId;
    activeId = null;
    dragged = false;
    gesture.cancel();
    setOffset(0, true);
    releaseCapture(id);
  };
  // 浏览器/旧 WebView 在手势后补发 click；横向滑动后必须拦下，避免按下处元素被误触。
  const armClickSuppression = () => {
    suppressClick = true;
    if (suppressTimer) clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppressClick = false; suppressTimer = null; }, 0);
  };
  const clearClickSuppression = () => {
    suppressClick = false;
    if (suppressTimer) { clearTimeout(suppressTimer); suppressTimer = null; }
  };
  const onClick = e => {
    if (!suppressClick) return;
    clearClickSuppression();
    e.preventDefault();
    e.stopPropagation();
  };

  const onDown = e => {
    if (activeId !== null || !isEnabled()) return;
    if (usePointer && e.pointerType === 'mouse' && e.button !== 0) return;
    if (!usePointer && e.touches && e.touches.length > 1) return; // 多指不起手势
    const p = pointOf(e, 'start');
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    const blocked = isHorizontallyScrollable(p.target, surface);
    if (!gesture.start({ x: p.x, y: p.y, t: now(e), blocked })) return;
    activeId = idOf(e);
  };
  const onMove = e => {
    if (idOf(e) !== activeId || activeId === null) return;
    if (!usePointer && e.touches && e.touches.length > 1) { reset(); return; } // 第二指落下：放弃本次手势
    const p = pointOf(e, 'move');
    if (!p) return;
    const r = gesture.move({ x: p.x, y: p.y, t: now(e) });
    if (r.dragging) {
      dragged = true;
      capture(activeId);
      setOffset(r.offset, false);
      // 旧 WebView：横向跟手时阻止原生平移；纵向滚动照常，不误拦。
      if (!usePointer) preventNative(e);
    }
  };
  const onUp = e => {
    if (idOf(e) !== activeId || activeId === null) return;
    const p = pointOf(e, 'end');
    const wasDragged = dragged;
    const r = gesture.end(p ? { x: p.x, y: p.y, t: now(e) } : undefined);
    const id = activeId;
    activeId = null;
    setOffset(0, true);
    if (r.result === SWIPE_RESULTS.SWITCH) select(order()[r.to]);
    // 位移超过 slop（切页或明确回弹）都不是点击，透传会误触按下处元素。
    if (r.result !== SWIPE_RESULTS.TAP) armClickSuppression();
    // 旧 WebView 的 touchend 预默认动作会合成 click；横向拖动时一并吞掉。
    if (!usePointer && wasDragged && r.result !== SWIPE_RESULTS.TAP) preventNative(e);
    dragged = false;
    releaseCapture(id); // 先清 pointerId：lostpointercapture 不应再次 reset
  };
  const onCancel = e => { if (idOf(e) === activeId && activeId !== null) reset(); };
  const onLostCapture = e => { if (usePointer && e.pointerId === activeId) reset(); };
  const onBlur = () => { if (activeId !== null) reset(); };

  if (usePointer) {
    surface.addEventListener('pointerdown', onDown);
    surface.addEventListener('pointermove', onMove);
    surface.addEventListener('pointerup', onUp);
    surface.addEventListener('pointercancel', onCancel);
    surface.addEventListener('lostpointercapture', onLostCapture);
  } else {
    // 显式 passive:false：旧 WebView 才允许在横向跟手时 preventDefault 阻止原生平移。
    surface.addEventListener('touchstart', onDown, { passive: false });
    surface.addEventListener('touchmove', onMove, { passive: false });
    surface.addEventListener('touchend', onUp, { passive: false });
    surface.addEventListener('touchcancel', onCancel, { passive: false });
  }
  surface.addEventListener('click', onClick, true);
  win.addEventListener?.('blur', onBlur);
  return {
    supported: true,
    isDragging: () => dragged,
    detach() {
      if (usePointer) {
        surface.removeEventListener('pointerdown', onDown);
        surface.removeEventListener('pointermove', onMove);
        surface.removeEventListener('pointerup', onUp);
        surface.removeEventListener('pointercancel', onCancel);
        surface.removeEventListener('lostpointercapture', onLostCapture);
      } else {
        surface.removeEventListener('touchstart', onDown);
        surface.removeEventListener('touchmove', onMove);
        surface.removeEventListener('touchend', onUp);
        surface.removeEventListener('touchcancel', onCancel);
      }
      surface.removeEventListener('click', onClick, true);
      win.removeEventListener?.('blur', onBlur);
      clearClickSuppression();
      reset();
    },
  };
}
