# Design Gate Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已确认设计基线嵌入 PRD 发布和 UI 节点执行，同时保持非 UI 计划、旧计划和无关 ready 节点不受阻塞。

**Architecture:** 可选 `design-manifest.json` 是唯一设计输入；其内容摘要进入现有 `planDigest`，根 run 保存不可变快照并由 attempt 继承。PRD 发布复用现有 confirm，controller 只做快照校验与契约注入，publisher.verify 调用注入的定向设计验证器，merge 只检查证据身份。

**Tech Stack:** Node.js 24、ES modules、node:test、现有 DAG run/store/controller/publisher。

**Spec:** `docs/2026-11-16-parallel-dag-design.md`；精简审阅结论 `/Users/macmini/.answer-me-with-html/pages/设计稿硬门独立审阅结论-20261117-220110.html`。

## Global Constraints

- 非 UI 节点无需新增字段；无数组形式旧计划保持兼容。
- 只有设计语义或产物变化才重新确认；PRD 全文变化不使设计批准失效。
- 活跃 run 永远使用创建时的不可变基线；新稿不 retroactively 阻塞旧 run。
- 像素差默认只是审阅证据；只有 verifier 放入 `checks` 的定向断言影响 `ok`。
- runner/证据设施故障抛错交现有有界调度恢复，不计 worker 实现失败。
- 不修改 Hub 核心，不新增第二套 DAG 状态机，不在 merge 重跑浏览器。
- 每个行为先 RED 后 GREEN；测试使用临时目录，不调用真实 Hub/模型。

## Review Focus

- 路径穿越或符号链接逃逸：设计清单和产物必须限制在项目根内，由 Task 1 测试。
- 非 UI/旧计划兼容：不得读取设计文件或要求 verifier，由 Task 1/3 测试。
- 单节点快照异常：不得占槽或阻断其他 ready 节点，由 Task 2 测试。
- 证据身份错位：`commit/designDigest/contractDigest` 必须匹配，由 Task 3 测试。
- 证据丢失自动恢复：同 SHA 补验后必须重新 review，由 Task 3 测试。

---

### Task 1: 可选设计基线与原生计划绑定

**Files:**
- Create: `src/design-baseline.mjs`
- Create: `test/design-baseline.test.mjs`
- Modify: `src/dag-plan.mjs`
- Modify: `src/vibe-plan.mjs`
- Modify: `src/dag-run.mjs`
- Modify: `src/dag-service.mjs`
- Test: `test/dag-plan.test.mjs`, `test/dag-run.test.mjs`, `test/dag-api.test.mjs`

**Interfaces:**
- Produces `loadDesignManifest({ projectRoot, manifestPath }) -> { manifestPath, designDigest, manifest, readOnlyPaths }`。
- Produces `loadDesignBaseline({ projectRoot, manifestPath, approvalPath })`；额外核验 `{ schema:1, designDigest, confirmedAt }` 并返回 `approvalPath/approval`。
- Produces `assertNodeDesignSnapshot(root, node)`；纯函数，不读磁盘。
- Produces `designContractDigest({ designDigest, contract })`。
- 原生对象计划使用 `design: { manifestPath, approvalPath }`；UI 节点使用 `contract.design: { surfaceIds, viewports?, states?, interactions? }`。
- `createPlanDigest` 仅额外纳入 `{ manifestPath, designDigest }`；无设计时字节口径不变。

- [ ] **Step 1: 写清单、产物 hash、批准记录、路径安全和 UI surface 子集的失败测试。**
- [ ] **Step 2: 运行 `node --test test/design-baseline.test.mjs test/dag-plan.test.mjs`，确认因模块/行为缺失失败。**
- [ ] **Step 3: 实现最小 loader 与原生计划校验；无 UI 节点时不加载设计设施。**
- [ ] **Step 4: 将设计摘要纳入 planDigest，将不可变 baseline 写入根 run、node run 和 attempt，并由 service.create 传入。**
- [ ] **Step 5: 运行上述测试及 `test/dag-run.test.mjs test/dag-api.test.mjs`，确认通过。**
- [ ] **Step 6: 提交 `feat(dag): bind optional approved design baselines`。**

### Task 2: PRD 发布确认与 worker 定向约束

**Files:**
- Modify: `src/design-publish.mjs`
- Modify: `src/dag-controller.mjs`
- Modify: `src/dag-publish.mjs`
- Test: `test/design-publish.test.mjs`, `test/dag-controller.test.mjs`, `test/dag-publish.test.mjs`

**Interfaces:**
- `publishProductSpec` 接受可选 `designDigest` 与 `now`；仅当 productSpec 声明 `design.manifestPath` 时要求摘要匹配。
- 确认记录写到 `docs/prd/<planId>/design-approval.json`；重复发布复用同摘要记录，保持幂等。
- controller 在 slot/createNodeRun/prepare/claim 前调用 `assertNodeDesignSnapshot`；每个 ready 节点独立捕获错误。
- UI prompt 包含根 `designDigest` 和本节点设计合同；review prompt 包含证据身份摘要。
- commitPr 拒绝修改 baseline 的 manifest/approval/artifacts，即使这些路径被误加入 files scope。

- [ ] **Step 1: 写 PRD 设计摘要缺失/不符在写盘和 Git 前失败、批准文件发布、非 UI 不变的测试。**
- [ ] **Step 2: 写无效 UI 节点不占槽且其他 ready 正常派发、prompt 定向注入、新稿不影响旧 run 的测试。**
- [ ] **Step 3: 写设计基线文件只读的 commitPr 测试。**
- [ ] **Step 4: 运行对应测试并确认预期 RED。**
- [ ] **Step 5: 最小实现并运行对应测试至 GREEN。**
- [ ] **Step 6: 提交 `feat(dag): enforce approved design contracts at publish and dispatch`。**

### Task 3: 定向设计证据、自动补验与 merge 身份门

**Files:**
- Modify: `src/dag-publish.mjs`
- Modify: `src/dag-controller.mjs`
- Test: `test/dag-publish.test.mjs`, `test/dag-controller.test.mjs`, `test/dag-fakes.mjs`

**Interfaces:**
- `createPublisher` 接受可选 `verifyDesign({ nodeId, worktree, commit, designBaseline, contract })`。
- UI 验证返回 `{ ok, evidence }`；evidence 含 `commit/designDigest/contractDigest/checks/visualDiffs?`。
- `checks` 至少一项且全部 `ok:true`；`visualDiffs` 不改变硬门结果。
- controller 将 evidence 存入节点运行状态；review 前发现同 SHA 证据缺失时自动 verify，并重新创建 review attempt。
- merge 仅对 UI 节点核验 `evidence.commit == reviewedCommit == prHead` 与 `evidence.designDigest == root.designBaseline.designDigest`，不重跑验证。

- [ ] **Step 1: 写非 UI 不调用 verifier、UI 缺 verifier/证据失败、视觉差不硬阻塞、身份 mismatch 拒绝 merge 的测试。**
- [ ] **Step 2: 写证据丢失自动补验并重新 review、runner 抛错不计 worker attempt 的测试。**
- [ ] **Step 3: 运行对应测试并确认预期 RED。**
- [ ] **Step 4: 最小实现并运行对应测试至 GREEN。**
- [ ] **Step 5: 提交 `feat(dag): bind directional design evidence to reviewed commits`。**

### Task 4: 合同文档与全量验证

**Files:**
- Modify: `docs/2026-11-16-parallel-dag-design.md`
- Modify: `AGENTS.md`（仅模块边界表增加 design-baseline 职责）
- Modify: `docs/superpowers/plans/2026-11-17-design-gate-hardening.md`

- [ ] **Step 1: 记录可选适用范围、一次确认、旧 run 继承、定向验证和自动解除语义。**
- [ ] **Step 2: 运行 `npm test && npm run test:browser`。**
- [ ] **Step 3: 运行 `git diff --check`、敏感信息扫描并审阅完整 diff。**
- [ ] **Step 4: 提交 `docs(dag): record scoped design gate contract`。**
