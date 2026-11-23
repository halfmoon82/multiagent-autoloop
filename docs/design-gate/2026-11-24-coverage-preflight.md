# Coverage preflight（Issue #255）

## 双向覆盖

`src/dag-plan.mjs` 导出 `assertDesignCoverage({ designBaseline, nodes })`。批准 manifest 是覆盖全集：每个 surface 及其 viewport/state/interaction 必须恰好归属一个 UI 节点。节点省略维度数组时表示承担该 surface 的全部对应维度；显式数组仍必须是批准集合的子集。

UI 节点由显式 `contract.design` 或确定的 UI 写入范围识别（`public/`、`mobile/app/www/`、前端专用源码后缀）。该规则只检查机器可读归属，不推断原型或自由文本的产品语义。纯后端节点和无数组设计设施旧计划保持原路径。

失败使用带 `code/details` 的结构化错误：`DESIGN_BASELINE_MISSING`、`DESIGN_CONTRACT_MISSING`、`DESIGN_CONTRACT_MISMATCH`、`DESIGN_COVERAGE_MISSING`、`DESIGN_COVERAGE_DUPLICATE`、`DESIGN_DIGEST_MISMATCH`。`details.missing` / `details.duplicate` 按 surface 与维度列出归属问题。

## 创建前证据预检

`createDagService().create()` 在 `store.createRun` 之前依次执行：

1. 校验 planDigest 与双向覆盖；UI 计划必须有独立、hash-covered `fallbackVerifierPath`。
2. 冻结批准基线并执行既有恢复校验；之后的 smoke 只接收冻结副本。
3. 取得精确 HEAD commit，逐 UI 节点调用 #256 `smokeApprovedDesign`，要求批准样例 `status=pass`。
4. 逐 UI 节点调用 #256 `verifyDesign` 预检备用采集。为确定地走过 fallback，仅在临时输入副本中把主 verifier 的声明 hash 设为不可能匹配的零值；冻结字节与最终 run 的基线不变。#256 继续负责隔离 worktree、fallback `capture/verify` 调用、captures 完整性与 hash 校验，#255 不实现采集逻辑。
5. 全部成功后才进入既有 mirror 与原子根 run 创建。

缺少恢复/证据能力使用 `DESIGN_SNAPSHOT_INVALID`（或底层设计错误码）、`DESIGN_COMMIT_UNAVAILABLE`、`DESIGN_FALLBACK_MISSING`、`DESIGN_EVIDENCE_PREFLIGHT` 拒绝。证据预检详情的 `stage` 为 `evidence-directory`、`approved-sample` 或 `fallback`。所有拒绝发生在根 run 写入前；预检证据和冻结包不是可派发 run。

活跃 run 保存原始冻结基线与节点合同快照，不保存被改 hash 的 fallback probe，不新增设计专用 blocked/gated。部署、发布与真实规则修改不在本能力内。
