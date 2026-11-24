# Issue #260 集成验证计划与覆盖矩阵

- Base：`42a438090ef084e831f09f628a3d5e9f4ee323f0`
- Worktree：`.worktrees/issue-260-integration-verify`
- 范围：只新增集成/浏览器验证与本文档；不改业务实现、`public/`、NoMoTo、真实规则。

## 合同自检

- 用户/场景：监工需要确认 #252、#255、#256、#257 与 #252 已落地能力组合后仍能创建前 fail closed、创建后自愈。
- 输入：临时 Git 项目、批准清单/样例、主备 verifier、UI 节点合同、假 Hub 与真实控制器状态机。
- 输出：可重复故障矩阵、真实浏览器证据、两项独立结论与全量回归结果。
- 成功标准：批准样例与备用路径可用；UI 覆盖无缺项/重复；故障在目标层真实发生；创建失败不留 run；运行中设计异常不新增设计专用 blocked/gated；纯后端路径不加载设计设施。
- 失败行为：设施双失败、基线/合同/证据不合法在创建前结构化拒绝；运行中设施失败恢复/重建，实现偏差走正常返工；普通 worker 多次失败只沿用既有通用换打法/gate。
- 非目标：不重复实现前序节点，不改视觉页面，不真机/生产验收，不部署，不最终 commit/push/PR/merge。
- 验收命令：`node --test test/design-gate-integration.test.mjs`、`npm test`、`npm run test:browser`、`git diff --check`。

## 目标性失败协议

1. 先在临时 fixture 注入故障，并断言目标层确实抛出指定错误或返回偏差；不以“测试文件尚不存在”冒充 RED。
2. 再断言安全结果：创建前错误码符合合同且 `store.listRuns()` 为空；备用路径只恢复采集，不抹掉主偏差；运行中不进入设计专用门禁。
3. 正向对照使用同一 fixture 的未故障版本，证明拒绝来自注入故障而非夹具不可用。
4. 基线证据：既有五个相关定向文件共 184/184 通过；真实生产 UI 两个节点通过。

## 覆盖矩阵

| 类别 | 故障/能力 | 目标性失败与预期安全结果 |
| --- | --- | --- |
| 批准样例 | 精确 SHA + hash-covered reference | smoke 通过并冻结全部批准字节 |
| 备用采集 | 主 verifier 浏览器/依赖/截图/超时失败 | 主路径目标失败后 fallback 完整证据 |
| UI 双向覆盖 | 漏 surface/维度、重复 owner | 分别 `DESIGN_COVERAGE_MISSING/DUPLICATE`，零 run |
| 基线 | 缺 manifest、批准产物损坏 | 创建前拒绝，零 run |
| 证据 | checks 无效、不同 SHA、部分 captures | `DESIGN_EVIDENCE_INCOMPLETE`，不得验收 |
| verifier | 不可用、超时、主备双失败 | 单侧失败走备用；双失败创建前拒绝 |
| 浏览器/依赖 | browser missing、dependency missing、截图失败 | 备用采集成功；无备用能力则创建前拒绝 |
| worker | 连续多次 rework | 先换打法，最终仅既有通用 gate，无设计专用门禁 |
| 合同字段 | UI 写范围漏 `contract.design`、缺 surfaceIds | 创建前拒绝，零 run |
| 部分证据+偏差 | 主偏差与部分 captures 并存 | fallback 补采集但保留主偏差，正常返工 |
| 独立结论 | code review 与 design conformance 分源、跨 SHA | 不从 accepted/merged 反推；两项同 SHA 才 merge |
| #252 恢复 | 运行中 verifier 异常、证据丢失、实现偏差 | 同 attempt 恢复/补验重审/正常返工，无设计专用 blocked/gated |
| 纯后端 | 后端 JS/TS 与 API 路由 | 不加载基线、不调用 verifier，原创建与审阅路径不变 |
| 真实 UI | 两个生产 UI 节点、桌面/移动、交互 checks | 真实 Chrome + 假 Hub 证据完整且双向矩阵一致 |

## 未验证边界

- 不做 NoMoTo 真机、生产控制台、真实规则、部署或发布验收。
- 故障均为本地临时 fixture/假 Hub 注入，不模拟所有浏览器版本、操作系统或真实第三方服务故障。

## 执行证据（2026-11-24）

- 既有定向基线：`node --test test/design-baseline.test.mjs test/design-verify.test.mjs test/dag-plan.test.mjs test/dag-controller.test.mjs test/dag-publish.test.mjs` → 184 passed / 0 failed。
- 新集成套件：`node --test test/design-gate-integration.test.mjs` → 17 passed / 0 failed；日志 `/tmp/issue-260-integration-targeted.log`。
- 真实设计浏览器：`node test/browser-design-verify.spec.mjs` → execution-grants 7 checks/2 captures、card-delegation 3 checks/2 captures，双向覆盖通过。
- CI 等价隔离 HOME：`HOME=$(mktemp -d) npm test` → 1521 tests，1514 passed / 0 failed / 7 skipped；跳过项是套件既有的 Playwright Chromium 未安装条件，日志 `/tmp/issue-260-npm-test-isolated.log`。
- 完整浏览器：`npm run test:browser` → browser、browser-dag（含 node:test 1/1）、browser-archive、browser-design-verify、browser-admin 全部通过；日志 `/tmp/issue-260-browser-full.log`。
- 默认本机 HOME 的 `npm test` 另跑一轮为 1519 passed / 2 failed；失败为未改动的 `mobile-tab-swipe` 吸底断言和 `mobile-ui-core` 待办更新超时，定向重跑仍复现。按合同未改 `public/` 或前序实现；CI 等价全量与真实 Chrome 浏览器套件分别通过。该基线/环境差异交给监工登记，不伪装成默认 HOME 全绿。
