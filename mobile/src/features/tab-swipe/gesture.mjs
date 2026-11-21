// tab-swipe 纯逻辑（DAG 节点 tab-swipe）：手势判定，不碰 DOM、不依赖 node: 内置模块。
// 输入是坐标与时间戳，输出是「跟手偏移」与「松手结果」；DOM 接线在 dom.mjs。

export const SWIPE_THRESHOLD_PX = 56; // 水平位移越过该值即切相邻 Tab
export const SWIPE_VELOCITY_PX_MS = 0.5; // 或松手速度达标（且有最小位移）
export const SWIPE_MIN_DISTANCE_PX = 16; // 速度判定的最小位移，防抖动误触
export const TAP_SLOP_PX = 10; // 位移小于它视为点击
export const AXIS_LOCK_PX = 8; // 位移超过它才判定主轴
export const EDGE_DAMPING = 0.35; // 首/末页继续外拉时的阻尼系数

export const SWIPE_RESULTS = Object.freeze({ TAP: 'tap', SWITCH: 'switch', REVERT: 'revert' });

const finite = value => typeof value === 'number' && Number.isFinite(value);

// 首页右拉 / 末页左拉：偏移按阻尼系数衰减，并设置上限，避免内容被拉出屏幕。
export function dampOffset(dx, { atStart = false, atEnd = false, width = 360 } = {}) {
  if (!finite(dx)) return 0;
  const outward = (dx > 0 && atStart) || (dx < 0 && atEnd);
  if (!outward) return dx;
  const limit = Math.max(0, width) * 0.25;
  const damped = Math.abs(dx) * EDGE_DAMPING;
  return Math.sign(dx) * Math.min(damped, limit);
}

// 相邻 Tab 下标：左滑（dx<0）看右侧下一页，右滑看左侧上一页；越界返回 -1。
export function targetIndex(index, dx, count) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count) return -1;
  const next = dx < 0 ? index + 1 : index - 1;
  return next >= 0 && next < count ? next : -1;
}

// 松手裁决：点击 / 切页 / 回弹。
export function decideRelease({ dx, dy, dt, index, count, axis }) {
  const ax = Math.abs(dx);
  if (!finite(dx) || !finite(dy)) return { result: SWIPE_RESULTS.REVERT, to: -1 };
  if (ax < TAP_SLOP_PX && Math.abs(dy) < TAP_SLOP_PX) return { result: SWIPE_RESULTS.TAP, to: -1 };
  if (axis !== 'x') return { result: SWIPE_RESULTS.REVERT, to: -1 };
  const speed = finite(dt) && dt > 0 ? ax / dt : 0;
  const passed = ax >= SWIPE_THRESHOLD_PX || (ax >= SWIPE_MIN_DISTANCE_PX && speed >= SWIPE_VELOCITY_PX_MS);
  if (!passed) return { result: SWIPE_RESULTS.REVERT, to: -1 };
  const to = targetIndex(index, dx, count);
  return to < 0 ? { result: SWIPE_RESULTS.REVERT, to: -1 } : { result: SWIPE_RESULTS.SWITCH, to };
}

// 手势状态机：start → move* → end/cancel。
export function createSwipeGesture({ count, getIndex, width = () => 360 } = {}) {
  let session = null;
  // Tab 数可能在运行时变化（页面模块会追加入口），count 允许传函数按需取。
  const total = () => (typeof count === 'function' ? count() : count);
  const index = () => (typeof getIndex === 'function' ? getIndex() : -1);
  return {
    active: () => Boolean(session),
    // blocked=true：起点落在可横向滚动容器内，本次手势不拦截。
    start({ x, y, t, blocked = false }) {
      if (!finite(x) || !finite(y) || blocked || index() < 0) { session = null; return false; }
      session = { x, y, t: finite(t) ? t : 0, axis: null, dx: 0, dy: 0, dt: 0 };
      return true;
    },
    move({ x, y, t }) {
      if (!session) return { dragging: false, offset: 0 };
      session.dx = x - session.x;
      session.dy = y - session.y;
      session.dt = (finite(t) ? t : 0) - session.t;
      if (!session.axis && Math.max(Math.abs(session.dx), Math.abs(session.dy)) >= AXIS_LOCK_PX) {
        session.axis = Math.abs(session.dx) > Math.abs(session.dy) ? 'x' : 'y';
      }
      if (session.axis !== 'x') return { dragging: false, offset: 0 };
      const i = index();
      const offset = dampOffset(session.dx, { atStart: i === 0, atEnd: i === total() - 1, width: width() });
      return { dragging: true, offset };
    },
    end({ x, y, t } = {}) {
      if (!session) return { result: SWIPE_RESULTS.REVERT, to: -1 };
      const s = session;
      session = null;
      if (finite(x)) s.dx = x - s.x;
      if (finite(y)) s.dy = y - s.y;
      if (finite(t)) s.dt = t - s.t;
      return decideRelease({ dx: s.dx, dy: s.dy, dt: s.dt, index: index(), count: total(), axis: s.axis });
    },
    // 被打断（blur / pointercancel）：丢弃手势，回弹到当前页。
    cancel() {
      const had = Boolean(session);
      session = null;
      return { result: SWIPE_RESULTS.REVERT, to: -1, interrupted: had };
    },
  };
}
