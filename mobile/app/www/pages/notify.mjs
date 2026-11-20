// 通知挂载点：不对应 Tab，由 app.mjs 在装配阶段 mount 一次。
const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/notifications/index.mjs');

export { loadViewModel };

/** 挂载点。ctx 含 client / state / hooks。 */
export function mount(ctx) {
  // 占位：后续节点覆盖 ctx.hooks.notify.setBadge / refresh。
}
