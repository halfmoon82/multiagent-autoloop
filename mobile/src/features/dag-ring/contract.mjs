// dag-ring 视图契约（Spec §8.2 / 计划 dag-ring）：全局常量与任务标识。
// 纯常量，不碰 DOM、不依赖 Node 内置模块；上游文本由调用方用 textContent 等安全方式渲染。
// 任务环身份 = 项目 + planId：同一任务多次运行仍是一个环，run 只是执行记录。
export const RING_TASK_PREFIX = 'dag:';
export const RING_MISSING_REASON = 'DAG 数据缺失，未读取到项目 DAG 进度（不用串行链条替代）';
export const RING_NO_TASKS_REASON = '暂无可显示的项目 DAG 任务环';

// 节点契约四段按 Spec §8.2「点击节点可查看契约」固定顺序展示；缺哪段就不显示哪段，不编造。
export const CONTRACT_ROWS = Object.freeze([
  { key: 'input', label: '输入' },
  { key: 'output', label: '输出' },
  { key: 'error_behavior', label: '异常行为' },
  { key: 'acceptance_example', label: '验收示例' },
]);

export const taskIdOf = (project, planId) => `${RING_TASK_PREFIX}${String(project ?? '').trim()}:${String(planId ?? '').trim()}`;
