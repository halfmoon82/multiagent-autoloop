// 产物双入口统一出口（Spec §8.2.5 / §8.3 / DAG 节点 artifacts）：纯逻辑，
// 供全局产物页、会话内产物入口装配与 Node 边界测试共用。
export * from './contract.mjs';
export * from './browser.mjs';
export * from './views.mjs';
