// 会话功能共享契约（Spec §8.2.4 / §8.2.6 / DAG 节点 sessions）。
// 纯函数、不触碰浏览器全局、不依赖 Node 内置模块：Node 边界测试与移动端打包器都可导入。
// 口径与后端 src/scheduling-session.mjs、src/session-archive.mjs 一致；测试守门，不在此重复判定业务。
// 上游文本全程是纯字符串，由调用方用 textContent 之类安全方式渲染。

export const SESSION_KINDS = Object.freeze(['normal', 'scheduling', 'design']);
export const SESSION_KIND_LABELS = Object.freeze({
  normal: '普通会话', scheduling: '调度会话', design: '设计会话',
});
export const sessionKindLabel = kind => SESSION_KIND_LABELS[kind] || SESSION_KIND_LABELS.normal;

// 已归档会话停止原因（与 src/session-archive.mjs 的 ARCHIVE_END_STATUS_LABELS 一致）。
export const END_STATUS_LABELS = Object.freeze({
  active: '进行中', closed: '已停止', error: '异常中断', interrupted: '异常中断',
});
export const endStatusLabel = value => END_STATUS_LABELS[value] || '未知';

// 会话列表类型筛选：全部 + 三种真实类型，不引入未确认筛选项。
export const SESSION_KIND_FILTERS = Object.freeze(
  [{ id: 'all', label: '全部' }, ...SESSION_KINDS.map(id => ({ id, label: SESSION_KIND_LABELS[id] }))]
    .map(filter => Object.freeze(filter)),
);

// 「继续调度」恢复时注入的最近转录轮数；必须与服务端 CONTINUATION_TURNS 一致（测试守门）。
export const RESTORE_INJECTED_TURNS = 10;
