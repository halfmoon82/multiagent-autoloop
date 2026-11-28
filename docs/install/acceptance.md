# 发布验收记录（Agent 引导的两阶段自助安装）

对应 PRD `docs/2026-11-26-agent-guided-release-prd.md` §8、Spec `docs/2026-11-26-agent-guided-release-spec.md` §5，以及 DAG 计划 `docs/dag-plans/2026-11-26-agent-guided-release.json` 的 `release-acceptance` 节点。

本文件是**验收证据记录**，不是验收通过声明。按契约「回归未全绿不得宣告验收通过」，本次结论为 **验收未通过**；判定依据是真实发布包的两项**稳定阻塞**（§2.1），不依赖会随批次波动的浏览器型用例。未授权的手动项如实标注未执行，不编造证据。

记录时间：2026-11-28（本机日期，dev g1a3 重派复核）。执行环境：DAG slot 工作区，依赖为控制器共享缓存软链，未运行 `npm ci` / `npm install`，未改动任何源码、规则、测试或配置。

> 复核说明：本次为 g1a2 审阅判定 rework 后的重派。审阅（P2）指出 g1a2 版本把 `mobile-ui-core.browser.test.mjs` 写成「单独重跑可复现失败」，与实测不符。本轮在同一提交上重新实测并逐条更正：浏览器型用例在不同批次间结果会翻转，故对每条结论标注实测批次，**不把单次超时写成可复现回归**，也不沿用旧批次数值充当本轮结果。

## 1. 自动化回归实测

按 PRD §8 四条验收命令逐条运行。浏览器型用例（含 `npm test` 中的 browser 型单测与 `npm run test:browser`）在本机不同批次间结果会翻转，下表为 **g1a3 本轮实测**，并附跨批次对照。

| 命令 | 退出码 | 通过数量 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| `npm test` | 0 | 1899 / 1899（fail 0，skipped 0） | 本轮通过 | `node --test test/*.test.mjs`，耗时约 66.5 秒；g1a2 批次曾 1898/1899（1 项浏览器型用例超时），见 1.1 |
| `npm run test:browser` | 1 | 首支 spec 断言失败，后续 4 支因 `&&` 链未执行 | 本轮失败 | `test/browser.spec.mjs:350` 持键冻结断言失败；g1a2 批次 5/5 通过，见 1.2 |
| `node scripts/doctor.mjs --phase local` | 0 | 4 / 4 项通过 | 通过 | `--json` 计数：node-version、home-layout、console-reachable、rules-draft（71 条规则） |
| `node scripts/doctor.mjs --phase public` | 1 | 4 通过 / 1 失败 / 4 跳过（共 9 项） | 失败（预期：阶段二未配置） | public-host 未配置，后续 4 项按顺序跳过，详见 1.3 |

### 1.1 `npm test` 中的浏览器型用例：时序不稳，非可复现回归

- 本轮（g1a3）实测：`npm test` 全量 1899/1899 通过，退出码 0。
- g1a2 批次记录：`test/mobile-ui-core.browser.test.mjs:31` 用例在 `:120` `page.waitForFunction` 超时（5000ms），全量记 1898/1899。
- **关键更正（针对 P2）**：g1a2 版本称该用例「单独重跑同一用例、同一行号、同一超时再次失败」。本轮在同一提交上单独重跑 `node --test test/mobile-ui-core.browser.test.mjs`，**1/1 通过（退出码 0）**；审阅方独立复跑亦为 1/1 通过。该「可复现失败」说法与实测不符，已更正。
- 性质判定：该用例依赖页面轮询时序，全量运行（并发负载）下曾超时 1 次，单独重跑通过，属**负载下时序不稳**，不是可复现的功能回归。
- 写域说明：本节点仅 `docs/install/acceptance.md`，未修改该测试或其依赖；该项作为跨批次波动如实记录，不作为本节点引入或本节点修复的结论。

### 1.2 `npm run test:browser` 实测细节

- 命令：`npm run test:browser`（`browser.spec.mjs && browser-dag.spec.mjs && browser-archive.spec.mjs && browser-design-verify.spec.mjs && browser-admin.spec.mjs`）。
- 本轮（g1a3）实测：退出码 1。首支 `browser.spec.mjs` 在 `:350` 断言「the list under a held pointer freezes instead of rebuilding the pressed target away」失败；后续 4 支 spec 因 `&&` 链未执行。
- 单独重跑对照：本轮单独运行 `node test/browser.spec.mjs`，**4/4 用例全部 PASS（退出码 0）**，覆盖总览/启停取消/待办回答/移动端规则表单/无控制台错误、移动端 shell 绑定与生物识别门禁、扫码绑定、会话消息窗口滚动。
- 跨批次对照：g1a2 批次 5/5 支 spec 全部通过；g1a1 批次同样在 `browser.spec.mjs:350` 失败。该断言与 1.1 的超时用例同属浏览器时序型，随批次负载波动。
- 计数口径：这些 spec 为自定义脚本，输出 PASS 标记而非 `node:test` 汇总数；本文只记录本轮实际观察到的 PASS 条数与失败断言，不虚构统一通过数（针对 P3 的口径意见已收紧）。

### 1.3 `doctor --phase public` 失败细节

- 失败项：`public-host` —— 运行目录 `config.json` 未配置 `publicHost`，退出码 1。
- 跳过项：`tunnel-config`、`public-reachable`、`access-blocks-anonymous`、`mobile-api`，脚本按前置依赖顺序跳过（4 项）。
- 性质：阶段二真实域名属于**需单独授权的手动试点**（PRD §8 明确），未配置公网域名与隧道前该阶段不满足验收条件，如实标注为未执行，不视为可离线修复的缺陷。

## 2. release dry-run 产物 manifest 审查

### 2.1 真实源 dry-run：失败（稳定阻塞）

- 命令：`node scripts/release.mjs --out <仓库外临时目录> --json`，退出码 1，stderr：`发布构建失败：发布源缺少必需内容：LICENSE`。
- 阻塞一：发布源缺少必需内容 `LICENSE`（`scripts/release.mjs` 的 `REQUIRED` 含 LICENSE，仓库根无此文件）。本轮复核与 g1a1/g1a2 一致。
- 阻塞二：`src/whisper-transcribe.mjs:9` 将 `DEFAULT_WHISPER_PATH` 写死为开发机绝对路径，触犯守门规则「本机路径」（正则匹配 macOS 用户主目录、Linux home 目录、Windows 用户目录等本机绝对路径形式；此处不写字面量以免本文件自身命中守门）。补齐 LICENSE 后重跑仍会被此项命中；本轮已目视确认该行属实（具体个人路径不写入本仓库）。
- 结论：`scanFiles` 一次性汇总全部命中，真实源确认上述两项阻塞；**真实发布包当前无法产出 manifest**，发布验收不通过。这两项是**稳定阻塞**（非时序波动），是本次「验收未通过」判定的依据。

### 2.2 夹具 dry-run：manifest 结构审查（不代表真实发布可用）

为独立审查 manifest 结构与守门逻辑，使用仓库内测试夹具 `test/fixtures/install/source`（自带 LICENSE）做了一次 dry-run：

- 命令：`node scripts/release.mjs --source test/fixtures/install/source --out <仓库外临时目录> --json`，退出码 0。
- 产物：8 个文件（LICENSE、README.md、docs/install/playbook.md、examples/config.example.json、package.json、public/index.html、scripts/hello.mjs、src/index.mjs），逐文件带 sha256 与 size；本轮复核一致。
- 审查结论：无上游内核 `app/` 路径、无密钥文件、无私钥/token 内容、无本机绝对路径；APK 附件状态 `pending`（未提供 APK，符合「APK 只列清单项不入包」约定）。
- 边界声明：这是夹具结果，仅证明守门逻辑与 manifest 结构正确，**不能替代真实源发布验收**；真实源仍被 2.1 两项阻塞卡住。

## 3. 阶段二手动验收清单（需独立授权，当前未执行）

依据 `docs/install/playbook.md` 阶段二步骤与 Spec §5。下表每一项都预留授权位与执行记录位；当前无任何一项获得授权，全部如实标注「未执行」，证据栏留空，不得事后补写为通过。

| # | 验收项 | 前置授权（需本人 granting） | 执行状态 | 执行人 / 时间 | 证据 / 结论（待填） | 失败修复路径（待执行时填） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 自有域名 `publicHost` 写入运行目录 config.json | 需本人提供域名并授权修改真实 config.json | 未执行 | — | — | — |
| 2 | `secret-write` 写入 cloudflare-token（隐藏输入、0600） | 需本人亲自输入 token，Agent 不得经手或转写 | 未执行 | — | — | — |
| 3 | cloudflared 隧道与 Access 配置 | 需本人账号与 Cloudflare 侧授权 | 未执行 | — | — | — |
| 4 | `doctor --phase public` 自验全绿 | 依赖 1–3 完成 | 未执行 | — | — | — |
| 5 | 发布页 APK 下载可用 | 依赖 1–3 完成；需真实发布包（当前被 2.1 阻塞） | 未执行 | — | — | — |
| 6 | App 内填写控制台 HTTPS 地址并连通 | 需真机与本人授权 | 未执行 | — | — | — |
| 7 | App 扫码绑定设备（设备令牌链路） | 需真机与本人授权 | 未执行 | — | — | — |

备注：第 5 项还叠加 2.1 的真实发布阻塞，即使获得域名授权也需先修复 LICENSE 与本机路径守门命中后才能产出可下载发布包。

## 4. 未覆盖边界（如实列出）

- 自动化回归：浏览器型用例跨批次结果翻转——本轮 `npm test` 1899/1899 通过、`npm run test:browser` 首支 spec 失败；g1a2 批次相反。单独重跑均通过，属负载下时序不稳，不写成可复现回归，也不据此宣告稳定全绿。
- 发布验收：真实源 dry-run 两项稳定阻塞未修复，真实 manifest 未产出；夹具 manifest 仅作结构审查。
- 公网/移动端：真实域名、Cloudflare Access、真机 APK 下载与扫码绑定均未在授权下执行。
- 本节点未改代码、未修回归；上述阻塞与时序不稳项需由对应节点或后续授权流程处理，本文件只负责如实记录证据。

## 5. 结论

- 本轮（g1a3）离线实测：`npm test` 1899/1899 通过；`npm run test:browser` 首支 spec 失败（单独重跑 4/4 通过，属时序不稳）；`doctor --phase local` 4/4 通过；`doctor --phase public` 4 过/1 败/4 跳过（阶段二未配置）。
- 判定「验收未通过」的依据是 §2.1 的两项**稳定阻塞**（根目录缺 LICENSE、`src/whisper-transcribe.mjs:9` 写死本机路径导致真实发布包无法产出），不是会随批次波动的浏览器型用例。
- 待 2.1 两项发布阻塞清理，并在本人授权下完成第 3 节全部手动项并回填证据后，方可重新判定。
