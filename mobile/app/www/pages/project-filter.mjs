// 全局项目筛选挂载点：不对应 Tab，由 app.mjs 在装配阶段 mount 一次。
const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/project-filter/index.mjs');

export { loadViewModel };

/** 挂载点。ctx 含 client / state / hooks。 */
export function mount(ctx) {
  // 占位：覆盖 ctx.hooks.projectFilter.current / onChange 由后续节点实现。
}
