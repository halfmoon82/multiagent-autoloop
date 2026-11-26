# Spec：产品化发布——Agent 引导的两阶段自助安装

- 状态：已确认——2026-11-26 随 product-spec 一并确认；待实现。
- 日期：2026-11-26
- 上游 PRD：`docs/2026-11-26-agent-guided-release-prd.md`
- DAG 计划：`docs/dag-plans/2026-11-26-agent-guided-release.json`
- 项目根：`/Volumes/Storage/auto调度`
- 本文档职责：把 PRD 转成可执行的实现边界、模块归属、验收与测试策略；不启动实现。

## 1. Objective

在不修改 Hub 上游核心、不分发上游内核、不新增 UI 页面的前提下：

1. 交付 `scripts/doctor.mjs` 环境/配置自检（`--phase local|public`），供 playbook 每步自验。
2. 交付 `scripts/secret-write.mjs` 交互式隐藏输入凭据写入，凭据不进聊天/日志/history。
3. 控制台支持可选 `publicHost` 配置：配置后放行该域名的 Host/Origin，未配置时行为完全不变（仍仅 127.0.0.1/localhost）。
4. 交付 `scripts/release.mjs` 发布包组装与敏感内容守门（排除上游内核、运行状态、密钥、本机路径）。
5. 交付 Agent 安装 playbook（阶段一/二）与一页人类入口文档。
6. 离线 e2e 冒烟覆盖可重入、失败路径与凭据不泄漏；真实域名验收单列授权。

## 2. 模块边界与归属

| 节点 | 拥有 | 不拥有 |
| --- | --- | --- |
| `doctor-cli` | `src/doctor.mjs`、`scripts/doctor.mjs`、`test/doctor*.test.mjs` | 修复动作本身、隧道配置写入 |
| `secret-write` | `src/secret-write.mjs`、`scripts/secret-write.mjs`、`test/secret-write*.test.mjs` | 凭据内容、Cloudflare 侧配置 |
| `public-host-config` | `src/config.mjs`、`src/server.mjs` 的 Host/Origin 放行、`test/server-public-host*.test.mjs` | 认证体系（由 Cloudflare Access 承担）、TLS 终止 |
| `release-packaging` | `scripts/release.mjs`、`test/release*.test.mjs`、`package.json` scripts | APK 构建与签名（既有 `mobile/app/build-apk.mjs`，独立授权）、Releases 上传 |
| `install-playbook` | `docs/install/`、`README.md` 入口段、`docs/setup.md` 指针、`examples/` 增补 | 脚本实现、真实凭据 |
| `install-e2e-smoke` | `test/install-e2e*.test.mjs`、`test/fixtures/install/` | 真实域名、真实 Cloudflare 账号 |
| `release-acceptance` | `docs/install/acceptance.md` 验收证据 | 真机安装、生产切换（独立授权） |

## 3. 接口契约

### 3.1 `scripts/doctor.mjs`

- 用法：`node scripts/doctor.mjs --phase local|public [--json]`。
- `--phase local` 检查：Node ≥ 24；`AGENT_AUTOLOOP_HOME` 存在且含 `config.json`/`rules.json`/`app/bin/agent-autoloop.ts`（缺内核时输出上游 GitHub 地址与获取指引）；控制台进程可达；rules 草稿通过校验。
- `--phase public` 追加：`config.json` 含合法 `publicHost`；cloudflared 隧道配置存在；`https://<publicHost>` 可达；**未带 Access 凭证的请求被拦截**（探测不得返回任何控制台数据）；移动端 API 路径在设备令牌下可用。
- 输出：人类可读逐项结果 + `--json` 机器可读（每项 `id/status/detail`）；退出码 0 全过 / 1 有失败；只读，不修改任何状态；可重复运行。

### 3.2 `scripts/secret-write.mjs`

- 用法：`node scripts/secret-write.mjs <key>`；TTY 下隐藏输入（无回显），管道 stdin 可供测试。
- 写入 `AGENT_AUTOLOOP_HOME` 内约定位置（`config.json` 字段或 `secrets/<key>`），文件 0600、目录 0700、临时文件 + rename 原子替换。
- 值不出现在 stdout/stderr/日志/进程参数（不作为命令行参数传递，不进 shell history）；报错不复述值。
- key 采用允许列表（如 `owner`、`cloudflare-token`），拒绝任意路径。

### 3.3 `publicHost`（src/config.mjs + src/server.mjs）

- `config.json` 新增可选 `publicHost`：单个合法域名（小写、无端口、无路径、无通配）。
- 配置后：Host == `publicHost` 的请求放行；写操作 Origin 校验追加允许 `https://<publicHost>`；其余 Host 仍 403。
- 未配置或非法值：行为与现状完全一致（仅 127.0.0.1/localhost），非法值启动告警并回退。
- 不引入第二域名、不做通配、不放宽自定义请求头与 JSON 内容类型校验。

### 3.4 `scripts/release.mjs`

- 组装发布目录/tarball：控制台源码、`docs/install/`、`examples/`、README、LICENSE；APK 作为发布附件清单项（产物来自既有 APK 构建，独立授权）。
- **排除**：上游内核（`app/`）、`node_modules`、运行状态（`config.json`/`rules.json`/数据库/日志）、密钥、本机绝对路径。
- 内置守门扫描：检出内核文件、私钥/token 模式、`/Users/` 等本机路径即构建失败；测试守门。
- 输出确定性产物 + `manifest.json`（逐文件 sha256）。

### 3.5 playbook（docs/install/playbook.md）

- 面向 Agent 的可执行说明：每步 = 动作 + 验证命令（doctor）+ 失败修复路径；全程可重入，不留半成品。
- 凭据索取仅限 AGENTS.md §4 六类，且一律经 `secret-write`，禁止让用户把凭据贴进聊天。
- 上游内核只给 GitHub 地址与获取指引；阶段二含 `publicHost`、cloudflared 隧道与 Access 配置、APK 下载与「填控制台地址 + 扫码绑定」指引。
- 记录用户交互预算：阶段一 ≤ 4 次。

## 4. Always / Ask first / Never

### Always

- RED → GREEN → Refactor；每个 worker 独立 worktree/分支，主 checkout 常驻 main。
- 未配置 `publicHost` 时控制台行为与现状逐字节一致；默认仅监听 127.0.0.1。
- 凭据只经 secret-write 落盘（0600），不进聊天/日志/截图/history/测试快照。
- 发布包守门扫描不通过即失败，不静默跳过。
- 测试用临时目录与假 Hub，不调用真实模型、真实 Cloudflare。

### Ask first（需主人单独授权）

- 真实 Cloudflare 账号操作（隧道、Access、DNS）、真实域名端到端验收。
- APK 真机构建、签名、安装与 Releases 上传发布。
- 本机服务重启、运行目录切换、真实规则变更。

### Never

- 不分发上游内核；不把内核文件拷进发布包或本仓库。
- 不在阶段一开启任何远程访问。
- 不修改 Hub 上游核心；不新增 UI 页面（本计划无 design 块）。
- 不让用户把凭据贴进聊天或由 Agent 转写凭据。

## 5. 测试策略与验收

- 单元/集成：doctor 各检查项、secret-write 不泄漏（断言值不出现在 stdout/stderr/日志且文件 0600）、publicHost 两种模式回归、release 守门（构造含内核/密钥/本机路径的假发布源断言失败）。
- e2e 冒烟（离线，进 `npm test`）：临时目录模拟干净机器 + 假上游骨架，跑 doctor 两阶段、secret-write 往返、release 组装；验证可重入（连跑两次结果一致）与失败路径（缺内核时输出 GitHub 指引与正确退出码）。
- 浏览器回归：本计划不改 UI，`npm run test:browser` 作为回归证据运行。
- 手动验收（独立授权）：真实域名阶段二端到端 + APK 真机绑定，清单落 `docs/install/acceptance.md`。
- 完成证据：列出实际运行命令、通过数量与未覆盖边界（AGENTS.md §7）。
