// 系统通知与锁屏直复（Spec §7）统一出口：纯逻辑，供 src/notifier.mjs 事件分发与移动端打包器共用。
export * from './contract.mjs';
export * from './reply.mjs';
export * from './bridge.mjs';
