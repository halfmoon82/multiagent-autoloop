# 防回退机制（修复台账）节点清单 — 2026-11-28

计划：docs/dag-plans/2026-11-28-fix-ledger.json（plan_id: `2026-11-28-fix-ledger`）
波次：wave-0 → wave-1（两节点并行）→ wave-2

## N1 fix-ledger-core（wave-0，standard）

新模块 `src/fix-ledger.mjs` + 单测 + 回填种子 `docs/fix-ledger.jsonl`。

- 实现台账格式（见 spec §1）：append、校验（fix 必有 regressionTest、decision 必有 decisionRef）、按文件路径/关键词查询 active 条目、原子写。
- 回填本仓库 fix1–fix12 种子条目：从 git 历史（`042e210`/`1173897`/`55c6ba1`/`80e8198`/`4f3e19e`/`37e84f5` 等）与既有 docs 提取，每条挂回归测试路径或决策出处；找不到回归测试的历史修复如实标注并在条目注明缺口。
- 验收：`npm test` 通过；`docs/fix-ledger.jsonl` 每行通过模块自校验；种子条目覆盖 fix9→fix11 重复修复与 fix12 恢复类案例。

## N2 ledger-context-injection（wave-1，standard，depends_on: N1）

调度资料包与派发 prompt 双注入。

- `src/scheduling-context.mjs` 新增「修复台账/已定决策」一节：读项目台账 active 条目，有字节上限、最近在前、超出注明总数（沿用既有 section 口径），台账缺失时降级为可读占位。
- 派发 worker 的 prompt 组装处按节点 `contract.files` 匹配台账 `files`，把相关条目（id+title+summary+回归测试路径）注入派发 prompt。
- 验收：单测覆盖注入命中/未命中/台账缺失降级/超上限截断注明。

## N3 ledger-review-gate（wave-1，standard，depends_on: N1）

审阅核查模块 + 口径文档。

- 新 `src/ledger-review.mjs`：输入 PR diff 文件清单与台账，输出触碰条目清单与豁免校验结果（`ledger-waiver: <entry-id> <理由>`）；CLI 入口挂 `scripts/`（通用、无私有路径）。
- `docs/review-severity.md` 增补：触碰 active 台账条目且无豁免按 P2；豁免需 reviewer 确认理由成立。
- 验收：单测覆盖触碰无豁免/触碰有豁免/未触碰/superseded 条目不拦截。

## N4 session-precipitation-closeout（wave-2，light，depends_on: N2）

会话沉淀闭环契约。

- AGENTS.md §4/§10 与 `docs/scheduling-contract.md` 增补：主人拍板事项当轮沉淀入台账（type=decision）才算该轮闭环；跨项目教训走知识库 admission。
- 调度会话 prompt 模板（`src/scheduling-session.mjs`）补一句沉淀纪律（与 N2 串行避免写范围冲突）。
- 验收：文档与 prompt 模板一致；`npm test` 通过。
