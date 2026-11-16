// 首句话语义分类：为新建会话推荐普通/调度/设计，允许调用方手动覆盖。
// 当前为无模型的规则启发式，与 docs/design/2026-11-16-parallel-dag 原型一致；
// 后续接入 vibe-entry S0/S1 评分后替换实现，接口与返回值词表保持不变。
const SCHEDULING_PATTERN = /调度|失败任务|规则|重试|频限|自愈|恢复规则|卡片/;
const DESIGN_PATTERN = /设计|规划|PRD|新功能|改造|多租户|并行|拆解|复杂/;

export function classifySessionRequest(text) {
  const value = String(text ?? '').trim();
  if (!value) return { kind: null, reason: '等待输入：普通问答/分析、调度协调、复杂 PRD 设计会进入不同会话协议。' };
  if (SCHEDULING_PATTERN.test(value)) {
    return { kind: 'scheduling', reason: '意图是读取状态、诊断失败或恢复规则，沿用现有调度协议。' };
  }
  if (DESIGN_PATTERN.test(value) || value.length > 45) {
    return { kind: 'design', reason: '涉及跨模块新能力或产品取舍，需要先形成 PRD、Spec 与 DAG。' };
  }
  return { kind: 'normal', reason: '单次问答、分析或普通开发，不需要调度协调或 PRD 引导。' };
}
