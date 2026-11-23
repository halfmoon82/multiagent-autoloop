# Conformance contract（Issue #257）

## 两项独立结论

节点状态通过既有 `controller.snapshot().nodes[nodeId]` / `loadNodeStates(root)` 查询，不新增视觉页面或另一套状态接口。

| 字段 | 来源与通过条件 | 缺失/过期语义 |
| --- | --- | --- |
| `codeReviewAccepted` | 当前节点 `commit` 对应的独立 review run 回执为 `accepted`；证据在 `codeReviewEvidence`，含 `source=independent-review`、`runId`、`commit`、generation/attempt 和结论 | 未审/重审中为 false + `codeReviewStatus=missing/pending`；rework 为 false + `rework`；回执 head 或当前 commit 变化后为 false + `stale` |
| `designConformance` | UI 节点仅接受 publisher 对同 SHA 完整证据给出的显式通过；证据在 `designEvidence`，身份在 `designEvidenceIdentity`，含 `source=publisher.verify`、`commit/designDigest/contractDigest/status` | 缺证据为 false + `designEvidenceState=missing`；SHA/摘要/合同身份不符为 false + `stale`；偏差为 false + `deviation`；checks 全绿但没有显式结论仍为 false + `unconfirmed`；通过为 true + `pass` |
| `designConformance`（非 UI） | 不加载设计设施 | 固定为 null，`designStatus/designEvidenceState=not-required` |

旧节点只有内部 `state=accepted`、PR merged 或根 run done 时，两项字段保持缺失语义，绝不反推设计通过。`codeReviewAccepted=true` 与 `designConformance=false` 是合法且可查询的组合：例如 reviewer 误判 accepted 而 knownDeviations 未清零时，代码审阅事实被保留，设计结论仍不通过。

## 验证与 merge 边界

- `publisher.verify()` 对 UI 返回 `designStatus`、`designConformance`、`designEvidence` 和 `designEvidenceIdentity`；缺证据、部分 captures、hash/身份不符继续按 incomplete 设施恢复处理。
- controller 应用验证结果时再次核对当前 SHA、设计摘要、合同摘要及偏差事实；同 SHA 证据补建后仍重新独立 review。
- `publisher.merge()` 不重跑浏览器、不推断视觉语义，只核验：远端 head 等于当前 commit、同 SHA 独立代码审阅证据、UI 的显式 `designConformance=true`，以及既有完整证据身份与通过状态。
- 缺/跨 SHA 代码审阅返回 `CODE_REVIEW_REQUIRED`；绿证据但缺显式设计结论返回 `DESIGN_CONFORMANCE_REQUIRED`；证据不全返回 `DESIGN_EVIDENCE_INCOMPLETE`；偏差返回 `DESIGN_DEVIATION`。controller 分别进入重审、补验或正常返工，不新增设计专用 blocked/gated。

## knownDeviations → 合同项 → 返工记录

`mapKnownDeviations` 将每项偏差绑定到批准合同的 `surfaceId`，可进一步绑定 viewport/state/interaction 或唯一失败 check。显式映射超出合同、多个 surface 下无法确定归属或记录形态无效时按证据不完整 fail closed，不能自我豁免。

设计偏差进入正常 review→rework 时，节点 `reworkRecords` 追加：

- `reason=design-deviation`、当前 commit、review run、时间；
- 当时的 `codeReviewAccepted` 与 `designConformance=false`；
- 失败 checks 与带 `contractItem` 的 knownDeviations。

后续开发派发提示携带最近一条返工记录，worker 可直接看到偏差 ID 与批准合同项，不需要中途询问工程选项。
