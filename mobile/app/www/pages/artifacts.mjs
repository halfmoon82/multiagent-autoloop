// 产物页面接缝：后续节点只改本文件，不直接 import 其他页面模块。
const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/features/artifacts/index.mjs');

export { loadViewModel };

/** 页面挂载点。ctx 含 client / state / hooks。 */
export function mount(ctx) {
  // 占位：产物阅读由后续节点实现；下载一律走 ctx.hooks.download。
}
