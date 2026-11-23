# Evidence resilience API（Issue #256）

## 创建前批准样例 smoke

`src/design-verify.mjs` 导出 `smokeApprovedDesign(options)`。参数与 `verifyDesign` 相同：`project`、精确 `commit`、冻结 `designBaseline`、节点 `contract`、`evidenceDir`，以及可选 `timeoutMs`。

- verifier 优先导出 `smoke(payload)`，未导出时回退到 `verify(payload)`。
- `payload.mode === 'approved-sample'`；`payload.approvedSamples` 来自 manifest 的 `surface.referencePaths`，每项含 surface、route、viewports/states/interactions、冻结文件绝对路径与 sha256。
- 所有样例字节在执行前重新核对 artifacts hash；实现证据与 smoke 证据使用不同 `mode` 和 `collector=approved-sample`，不能互相冒充。

## 备用采集

manifest 可增加 `fallbackVerifierPath`。该路径必须同时列入 `artifacts`（含 sha256）与冻结 `readOnlyPaths`，因此会随 #252 的冻结包恢复。

- 主 verifier 抛错、实际超时、依赖/浏览器缺失、返回形态无效或 captures 不完整时，在同一个精确 commit worktree 中执行备用模块。
- 备用模块优先导出 `capture(payload)`，也可导出 `verify(payload)`；输出合同与主 verifier 相同。
- 备用 captures 写入 `evidenceDir/fallback/`，不与主路径的半截文件混合。成功结果标记 `collector=fallback` 与 `recovery.primaryError`。
- 主备均失败时抛 `DesignVerifyError`，`status=infrastructure-error`；两者都只是部分证据时为 `status=incomplete`。不会转成 worker deviation。

## 完整证据与缓存

真实 manifest 的每个合同 surface × viewport × state 都必须有独立 capture；每个 interaction 必须有对应 check。capture 必须位于本次节点证据目录内，文件存在且 sha256 与记录一致。缺文件、重复维度、路径逃逸、hash 变化和覆盖不全均为 `incomplete`。

publisher 将每次采集隔离到 `<node-evidence>/<commit>-<contractDigest>/`，完整结果原子写入 `<node-evidence>/cache/<commit>-<contractDigest>.json`。缓存包含显式 `pass/deviation` 状态。读取时重新校验身份、覆盖矩阵和文件 hash：同 SHA 完整缓存可复用；不同 SHA、不同合同、部分证据或被修改的 captures 必须重建。merge 始终重新做完整性与身份校验。

`verify` 返回 `designStatus=pass/deviation`，设施异常抛带 `status=infrastructure-error/incomplete` 的 `PublishError`，不返回 worker `ok=false`。未新增设计专用 blocked/gated，也不要求重新批准。

为兼容既有嵌入式旧适配器，只有同时满足“无结果 status、无 captures/artifacts 字段、checks 无 surfaceId、合同仅含 surfaceIds”的旧返回可完成 verify，但不写完整缓存；真实 verifier 总返回新状态并执行完整校验，merge 对旧适配器证据仍 fail closed。
