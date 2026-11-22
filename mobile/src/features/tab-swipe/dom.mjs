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
  let capturedId = null;
  let dragged = false;
  let suppressClick = false;
  let suppressTimer = null;
  const now = e => (typeof e.timeStamp === 'number' ? e.timeStamp : Date.now());
  const setOffset = (px, animate) => {
    surface.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    surface.style.transform = px ? `translateX(${px}px)` : '';
  };
  // 仅当主轴判定为横向拖动后才捕获指针：若在 pointerdown 就捕获，会把 .content 内按钮
  // （如 #reconnect）的 pointerup/click 重定向到 .content，导致按钮点不动。
  const capture = id => {
    if (capturedId === id || typeof surface.setPointerCapture !== 'function') return;
    try { surface.setPointerCapture(id); capturedId = id; } catch { /* 无效 pointerId：退化为无捕获 */ }
  };
  const releaseCapture = id => {
    if (id === null || capturedId !== id || typeof surface.releasePointerCapture !== 'function') return;
    capturedId = null;
    try { surface.releasePointerCapture(id); } catch { /* 捕获已随节点移除而丢失，忽略 */ }
  };
  const reset = () => {
    const id = pointerId;
    pointerId = null;
    dragged = false;
    gesture.cancel();
    setOffset(0, true);
    releaseCapture(id);
  };
  // 浏览器在 pointerup 之后补发 click；滑动后必须拦下，避免按下处元素被误触。
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
    if (pointerId !== null || !isEnabled() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const blocked = isHorizontallyScrollable(e.target, surface);
    if (!gesture.start({ x: e.clientX, y: e.clientY, t: now(e), blocked })) return;
    pointerId = e.pointerId;
  };
  const onMove = e => {
    if (e.pointerId !== pointerId) return;
    const r = gesture.move({ x: e.clientX, y: e.clientY, t: now(e) });
    if (r.dragging) { dragged = true; capture(e.pointerId); setOffset(r.offset, false); }
  };
  const onUp = e => {
    if (e.pointerId !== pointerId) return;
    const r = gesture.end({ x: e.clientX, y: e.clientY, t: now(e) });
    const id = pointerId;
    pointerId = null;
    setOffset(0, true);
    if (r.result === SWIPE_RESULTS.SWITCH) select(order()[r.to]);
    // 位移超过 slop（切页或明确回弹）都不是点击，透传会误触按下处元素。
    if (r.result !== SWIPE_RESULTS.TAP) armClickSuppression();
    dragged = false;
    releaseCapture(id); // 先清 pointerId：lostpointercapture 不应再次 reset
  };
  const onCancel = e => { if (e.pointerId === pointerId) reset(); };
  const onLostCapture = e => { if (e.pointerId === pointerId) reset(); };
  const onBlur = () => { if (pointerId !== null) reset(); };

  surface.addEventListener('pointerdown', onDown);
  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerup', onUp);
  surface.addEventListener('pointercancel', onCancel);
  surface.addEventListener('lostpointercapture', onLostCapture);
  surface.addEventListener('click', onClick, true);
  win.addEventListener?.('blur', onBlur);
  return {
    supported: true,
    isDragging: () => dragged,
    detach() {
      surface.removeEventListener('pointerdown', onDown);
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', onUp);
      surface.removeEventListener('pointercancel', onCancel);
      surface.removeEventListener('lostpointercapture', onLostCapture);
      surface.removeEventListener('click', onClick, true);
      win.removeEventListener?.('blur', onBlur);
      clearClickSuppression();
      reset();
    },
  };
}
