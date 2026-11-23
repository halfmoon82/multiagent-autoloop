# Issue #257 conformance-contract 实现计划

- Base：`0ccee9dd140a39c68a91cf28409747f605ee3c87`
- Worktree：`.worktrees/issue-257-conformance-contract`
- 范围：仅 `src/dag-controller.mjs`、`src/dag-publish.mjs`、对应两个测试文件与 `docs/design-gate/`。

## 合同自检

- 用户/场景：调度方与独立 reviewer 需要分别查询代码审阅和设计符合性，不能从内部 `accepted`、merged/done 推断设计通过。
- 输入：当前节点 commit、独立 review run 回执、publisher 返回的设计证据及其 `commit/designDigest/contractDigest`。
- 输出：节点快照上的 `codeReviewAccepted`、`designConformance` 及其来源、状态、SHA 和证据身份；knownDeviations 的合同项与返工记录。
- 成功标准：同 SHA 的有效代码审阅与设计结论才可 merge；偏差走 review→rework；缺证据/过期证据 fail closed 并自动补验重审；非 UI 不要求设计结论。
- 失败行为：结论缺失或过期不合并，不新增设计专用 blocked/gated；merge 只核验结构化结论与证据，不做浏览器语义判断。
- 非目标：不改视觉页面、NoMoTo、真实规则；不实现 #260；不部署、commit、push、PR 或 merge。
- 验收命令：`node --test test/dag-controller.test.mjs test/dag-publish.test.mjs`、`npm test`、`git diff --check`。

## Red → Green → Refactor

1. RED：新增两项结论独立读取、误判 accepted、同 SHA 有效结论、review SHA 过期、设计证据缺失/过期、knownDeviations 合同项与返工记录测试；运行定向测试并保留失败输出。
2. GREEN：publisher 显式返回并校验结论与证据身份；controller 记录独立 review 来源、失效状态、设计结论与返工记录；merge 接收并核验两项同 SHA 结论。
3. Refactor：收敛重复的结论失效/证据应用逻辑，保持旧 run 缺少字段时 fail closed，不从 accepted/done 反推通过。
4. 验证：定向测试、全量 `npm test`、diff/敏感信息/路径范围检查。UI 与 public 未改，因此本节点不运行浏览器视觉回归；该集成证明归 #260。

## 查询语义

- `codeReviewAccepted` 只来自当前 commit 的独立 review run accepted；rework、pending、缺记录或 commit 变化时为 false。
- UI 的 `designConformance` 只来自当前 commit 且身份匹配的 publisher 完整证据结论；checks/knownDeviations 未清零、缺证据或证据过期时为 false。非 UI 为 null（not-required）。
- `codeReviewEvidence` 与 `designEvidenceIdentity` 分别记录来源和 SHA/证据身份；`*Status` / `designEvidenceState` 区分 missing、pending、accepted/rework、pass/deviation/unconfirmed 与 stale。

## 执行记录

- RED（2026-11-24）：`node --test --test-name-pattern=conformance ...` 为 0 passed / 7 failed，失败即缺少两项字段、映射与 merge 校验；日志 `/tmp/issue-257-red-targeted.log`。
- 补充 RED：绿 checks + 缺显式设计结论用例 0 passed / 1 failed；日志 `/tmp/issue-257-red-unconfirmed.log`。
- GREEN：新增 conformance 定向 8/8；两个完整定向文件 79/79。
- 全量：隔离 HOME `npm test` 为 1504 tests / 1497 passed / 0 failed / 7 skipped。
