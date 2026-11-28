# 防回退机制（修复台账）Spec — 2026-11-28

对应 PRD：docs/2026-11-28-fix-ledger-prd.md。计划：docs/dag-plans/2026-11-28-fix-ledger.json。

## 1. 台账格式（目标项目 `docs/fix-ledger.jsonl`）

每行一个 JSON 条目，append-only，原子写（临时文件 + rename 或追加写带锁）：

```json
{
  "id": "fix9-remove-design-authorize-button",
  "date": "2026-11-26",
  "type": "fix | decision",
  "title": "一句话",
  "summary": "修了什么/决定了什么，含被否决方案（如有）",
  "source": { "pr": 358, "commit": "1173897", "issue": 355 },
  "regressionTest": "test/xxx.test.mjs",
  "decisionRef": "docs/xxx.md#节 或 会话日期",
  "files": ["mobile/app/www/pages/sessions.mjs"],
  "status": "active | superseded",
  "supersedes": null
}
```

约束：

- `type=fix` 必须有 `regressionTest`（仓库内相对路径，存在性可校验）；`type=decision` 必须有 `decisionRef`。两者必居其一，缺失即非法条目。
- `files` 为该条目守护的写范围（相对路径，可含目录前缀），供派发注入与审阅核查匹配。
- `status=superseded` 的条目不再拦截，但保留可查（不静默改写历史）。
- 条目 id 稳定 ASCII kebab-case。

## 2. 模块边界

| 模块 | 拥有 | 不拥有 |
| --- | --- | --- |
| `src/fix-ledger.mjs`（新） | 台账读写、格式校验、按文件路径/关键词查询相关条目、fix1–12 回填种子 | 台账内容业务判断、Hub 事件 |
| `src/scheduling-context.mjs` | 资料包新增「修复台账/已定决策」一节（有上限、最近在前、注明总数） | 台账写入 |
| 派发 prompt 组装（dag 派发链路） | 按节点 contract.files 匹配台账条目注入 worker prompt | 台账格式定义 |
| `src/ledger-review.mjs`（新） | PR diff 触碰台账 files 的核查、豁免标记（`ledger-waiver:`）校验、结论输出 | 审阅结论判定、合并动作 |
| 会话闭环契约（AGENTS.md / scheduling-contract / 会话 prompt 模板） | 主人拍板事项当轮沉淀的纪律与检查口径 | 乔哈里对齐门语义 |

## 3. 审阅门禁（软拦 + 显式豁免）

- reviewer 合并前运行核查：PR diff 触碰的文件的与台账 active 条目 `files` 有交集 → 必须在 PR 描述含 `ledger-waiver: <entry-id> <理由>`，缺豁免按 P2 处理（逐条核实修复后方可合并）。
- 有豁免的触碰不拦，但 reviewer 必须在审阅意见中确认豁免理由成立。
- `docs/review-severity.md` 增补该口径。

## 4. 会话沉淀闭环

- 调度/设计会话中主人拍板的事项（决策、否决、范围确认），当轮追加台账条目（type=decision）或更新既有条目，沉淀完成才算该轮闭环。
- 跨项目可复用的协作模式教训另入统一知识库（走 knowledge-admission 流程）。
- worker 子会话不跑对齐门、不写台账；其修复交付由审阅/调度方在合并时登记 fix 条目。

## 5. 验收命令

```bash
npm test                 # 含 fix-ledger / 注入 / 审阅核查单测
node scripts/ledger-review.mjs --help   # 或等价入口（以实现为准）
```

## 6. 兼容与边界

- 台账文件缺失时各环节降级为「无台账」并如实标注，不报错阻塞既有流程。
- 台账不进入浏览器渲染链路；控制台如需展示另起节点，不在本计划。
- 真实密钥、个人路径不得写入台账条目。
