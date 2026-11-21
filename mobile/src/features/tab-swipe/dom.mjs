// tab-swipe DOM 接线：把手势状态机接到主内容区的 pointer 事件。
// 不支持 PointerEvent 时直接退化为无手势（纯点击），不抛错。滑动与点击切页都走调用方给的 select。
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

export function attachTabSwipe({ surface, tabOrder, getActive, isEnabled = () => true, select, win = globalThis }) {
  if (!surface || typeof win.PointerEvent !== 'function') return { detach() {}, supported: false };
  const order = () => tabOrder();
  const gesture = createSwipeGesture({
    count: () => order().length,
    getIndex: () => order().indexOf(getActive()),
    width: () => surface.clientWidth || 360,
  });
  let pointerId = null;
  let dragged = false;
  const now = e => (typeof e.timeStamp === 'number' ? e.timeStamp : Date.now());
  const setOffset = (px, animate) => {
    surface.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    surface.style.transform = px ? `translateX(${px}px)` : '';
  };
  const reset = () => { pointerId = null; dragged = false; gesture.cancel(); setOffset(0, true); };

  const onDown = e => {
    if (pointerId !== null || !isEnabled() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const blocked = isHorizontallyScrollable(e.target, surface);
    if (gesture.start({ x: e.clientX, y: e.clientY, t: now(e), blocked })) pointerId = e.pointerId;
  };
  const onMove = e => {
    if (e.pointerId !== pointerId) return;
    const r = gesture.move({ x: e.clientX, y: e.clientY, t: now(e) });
    if (r.dragging) { dragged = true; setOffset(r.offset, false); }
  };
  const onUp = e => {
    if (e.pointerId !== pointerId) return;
    const r = gesture.end({ x: e.clientX, y: e.clientY, t: now(e) });
    pointerId = null;
    setOffset(0, true);
    if (r.result === SWIPE_RESULTS.SWITCH) select(order()[r.to]);
    dragged = false;
  };
  const onCancel = e => { if (e.pointerId === pointerId) reset(); };
  const onBlur = () => { if (pointerId !== null) reset(); };

  surface.addEventListener('pointerdown', onDown);
  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerup', onUp);
  surface.addEventListener('pointercancel', onCancel);
  win.addEventListener?.('blur', onBlur);
  return {
    supported: true,
    isDragging: () => dragged,
    detach() {
      surface.removeEventListener('pointerdown', onDown);
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', onUp);
      surface.removeEventListener('pointercancel', onCancel);
      win.removeEventListener?.('blur', onBlur);
      reset();
    },
  };
}
