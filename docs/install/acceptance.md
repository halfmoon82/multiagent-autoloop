# 发布验收记录（Agent 引导的两阶段自助安装）

对应 PRD `docs/2026-11-26-agent-guided-release-prd.md` §8、Spec `docs/2026-11-26-agent-guided-release-spec.md` §5，以及 DAG 计划 `docs/dag-plans/2026-11-26-agent-guided-release.json` 的 `release-acceptance` 节点。

本文件是**验收证据记录**，不是验收通过声明。按契约「回归未全绿不得宣告验收通过」，本次结论为 **验收未通过**；未授权的手动项如实标注未执行，不编造证据。

记录时间：2026-11-28（本机日期）。执行环境：DAG slot 工作区，依赖为控制器共享缓存软链，未运行 `npm ci` / `npm install`，未改动任何源码或规则。

## 1. 自动化回归实测

按 PRD §8 四条验收命令逐条运行，结果如下。

| 命令 | 退出码 | 通过数量 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| `npm test` | 0 | 1899 / 1899（fail 0，skipped 0） | 通过 | `node --test test/*.test.mjs`，耗时约 66.8 秒 |
| `npm run test:browser` | 1 | 未产出完整通过数 | **失败** | 链在第一支 `test/browser.spec.mjs` 中断，详见下方 |
| `node scripts/doctor.mjs --phase local` | 0 | 5 / 5 项通过 | 通过 | node-version、home-layout、console-reachable、rules-draft（71 条规则）全过 |
| `node scripts/doctor.mjs --phase public` | 1 | 4 / 9 项通过 | **失败（预期：阶段二未配置）** | public-host 未配置，后续 tunnel/public-reachable/access-blocks-anonymous/mobile-api 均未执行，详见下方 |

### 1.1 `npm run test:browser` 失败细节

- 失败点：`test/browser.spec.mjs:350`，断言 `the list under a held pointer freezes instead of rebuilding the pressed target away`（指针按下未抬起期间，列表应冻结而非重建把目标节点换掉）。
- 可复现性：单独重跑 `node test/browser.spec.mjs` 以相同断言、相同行号失败，非偶发抖动。
- 影响范围：`npm run test:browser` 用 `&&` 串联 5 支 spec，第一支失败后 `browser-dag.spec.mjs`、`browser-archive.spec.mjs`、`browser-design-verify.spec.mjs`、`browser-admin.spec.mjs` **全部未执行**，因此没有全量浏览器回归通过数。
- 本节点写域仅 `docs/install/acceptance.md`，未修改该测试或其依赖；此项作为未修复回归如实上报。

### 1.2 `doctor --phase public` 失败细节

- 失败项：`public-host` —— 运行目录 `config.json` 未配置 `publicHost`，退出码 1。
- 未执行项：`tunnel-config`、`public-reachable`、`access-blocks-anonymous`、`mobile-api`，脚本按前置依赖顺序跳过。
- 性质：阶段二真实域名属于**需单独授权的手动试点**（PRD §8 明确），未配置公网域名与隧道前该阶段不满足验收条件，如实标注为未执行，不视为可离线修复的缺陷。

## 2. release dry-run 产物 manifest 审查

### 2.1 真实源 dry-run：失败

- 命令：`node scripts/release.mjs --out <仓库外临时目录> --json`，退出码 1。
- 阻塞一：发布源缺少必需内容 `LICENSE`。仓库根没有 LICENSE；`release-packaging` 节点交付的 `scripts/release.mjs` 把 LICENSE 列为必需，但仓库未包含根 LICENSE。
- 阻塞二：在临时副本补齐 LICENSE 后重跑仍失败，退出码 1，发布守门命中 1 处——`src/whisper-transcribe.mjs` 的 `DEFAULT_WHISPER_PATH` 写死了一台开发机的绝对路径，触犯「本机路径」守门规则。
- 结论：`scanFiles` 一次性汇总全部命中，确认真实源仅有上述两项阻塞；**真实发布包当前无法产出 manifest**，发布验收不通过。

### 2.2 夹具 dry-run：manifest 结构审查（不代表真实发布可用）

为独立审查 manifest 结构与守门逻辑，使用仓库内测试夹具 `test/fixtures/install/source`（自带 LICENSE）做了一次 dry-run：

- 命令：`node scripts/release.mjs --source test/fixtures/install/source --out <仓库外临时目录> --json`，退出码 0。
- 产物：8 个文件（LICENSE、README.md、docs/install/playbook.md、examples/config.example.json、package.json、public/index.html、scripts/hello.mjs、src/index.mjs），逐文件带 sha256 与 size。
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

- 浏览器回归：5 支 spec 仅第一支执行到断言失败，其余 4 支未执行，无全量通过数。
- 发布验收：真实源 dry-run 两项阻塞未修复，真实 manifest 未产出；夹具 manifest 仅作结构审查。
- 公网/移动端：真实域名、Cloudflare Access、真机 APK 下载与扫码绑定均未在授权下执行。
- 本节点未改代码、未修回归；上述失败项需由对应节点或后续授权流程处理，本文件只负责如实记录证据。

## 5. 结论

- 自动化可离线部分：`npm test` 全绿（1899/1899），`doctor --phase local` 全绿（5/5）。
- 未通过项：`npm run test:browser`（可复现断言失败）、`doctor --phase public`（阶段二未配置，属需授权的手动项）、真实源 release dry-run（LICENSE 缺失 + 本机路径守门命中）。
- 按契约 **不宣告验收通过**。待 1.1 回归修复、2.1 两项发布阻塞清理，并在本人授权下完成第 3 节全部手动项并回填证据后，方可重新判定。
