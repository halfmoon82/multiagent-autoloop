// 保留原因（issue #355）：移动端会话页已移除「确认执行范围」入口与视图挂载，本模块仅由集成/边界测试与启动清单引用，
// 授权数据通道随网页版确认页兜底保留；移动端不再 import 它。
// 设计授权功能统一出口：纯逻辑 + 数据通道，供移动端会话页与 Node 边界测试共用。
export * from './model.mjs';
export * from './browser.mjs';
export * from './views.mjs';
