// 设计授权功能统一出口：纯逻辑 + 数据通道，供移动端会话页与 Node 边界测试共用。
export * from './model.mjs';
export * from './browser.mjs';
export * from './views.mjs';
