// 总览 / 规则 / 轮次 / 待办 页面接缝：后续节点只改本文件，不直接 import 其他页面模块。
// 页面用相对路径 ../src/... 引用视图模型（由受限静态服务 /mobile/src/ 规则提供）；
// Node 边界测试不装配 DOM，视图模型只在浏览器里按需加载。
const loadViewModel = typeof window === 'undefined'
  ? () => Promise.resolve(null)
  : () => import('../src/core/index.mjs');

export { loadViewModel };

/** 页面挂载点。ctx 含 client / state / hooks；跨页互调一律走 ctx.hooks。 */
export function mount(ctx) {
  // 占位：四个核心页面由后续节点实现，本节点只预留接缝。
}
