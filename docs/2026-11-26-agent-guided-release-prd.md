# PRD：产品化发布——Agent 引导的两阶段自助安装

- 文档状态：已确认——2026-11-26 主人在设计会话中确认 product-spec（含全部 decisions）。
- 日期：2026-11-26
- 适用项目：`/Volumes/Storage/auto调度`
- 产品用户：拥有本地 Agent 工具（Claude Code / Codex 等）的个人用户
- 关联契约：`AGENTS.md`、`docs/setup.md`、`docs/scheduling-contract.md`
- 关联计划：`docs/dag-plans/2026-11-26-agent-guided-release.json`

## 1. 背景（问题）

控制台、网页版与 Android APK 已成熟可用，但全部绑定在作者自有域名与本地环境：安装需手工备运行目录、配密钥、写规则；网页版无远程访问能力；APK 绑定依赖本机环境。新用户无法在没有作者协助的情况下自助完成「装 → 配 → 远程 → 装 App」全流程。（user_confirmed）

## 2. 目标

发布包 = 控制台代码 + APK + **给 Agent 读的安装 playbook** + 自检脚本。用户让自己本地的 Agent 读 playbook，由 Agent 完成全部工程动作，只在凭据与授权点向用户索要，并提供本地安全写入方式。产品分两阶段（user_confirmed）：

1. **阶段一（无域名）**：网页版控制台仅本地使用，零凭据门槛。
2. **阶段二（有自有域名 + Cloudflare 凭据）**：搭建公网 HTTPS 访问，APK 扫码绑定后远程管理。

## 3. 成功标准（可观察、可验收）

1. 干净机器（已装 Node.js 24 与任一受支持 Agent 工具）上完成阶段一：用户有效交互不超过 4 次（启动指令、上游内核获取授权、宿主凭据写入、模型分档确认），其余全部由 Agent 按 playbook 完成并自验通过；完成后 `127.0.0.1` 控制台功能可用。
2. 上游内核不由本项目分发：playbook 仅提供上游 GitHub 地址并引导用户自行获取；发布包与仓库中不包含上游内核文件。
3. 阶段二：用户提供域名与 Cloudflare 凭据后，Agent 完成隧道与访问控制配置；未通过访问控制的公网请求拿不到任何数据（含 API）；APK 扫码绑定一次成功并出现在设备列表。
4. playbook 每一步都有可机器执行的验证命令；任一步失败给出修复路径并可重入续跑，不留半成品状态。
5. 凭据在任何环节不进入聊天记录、日志、截图与 shell history，由自动化测试守门。
6. 仓库回归 `npm test` 与 `npm run test:browser` 全绿。

## 4. 非目标

- 不分发上游内核，仅引用其 GitHub 地址（知识产权要求，user_confirmed）。
- 不做网页安装向导 UI；引导载体为 Agent playbook 加一页精简人类入口文档。
- 阶段一不提供任何远程访问与 APK 能力。
- 不做 iOS、不上应用商店、不做多用户/团队权限、不做付费授权体系。
- 首期不支持 Windows 安装引导（仅 macOS 与 Linux）。
- 不替用户注册或购买域名、Cloudflare 账号。
- 「绑定二维码携带服务器地址一步绑定」本期不做：App 侧解析改动命中 `mobile/app/www/` 设计稿门禁路径，且现行 App 严格校验载荷（多参数会被拒）。本期 APK 采用已上线的「控制台地址手输（HTTPS 校验）+ 扫码绑定」；二维码携带地址列为后续迭代，须先出绑定页设计稿经主人确认。

## 5. 用户场景

- **阶段一**：拥有本地 Agent 工具、没有域名的个人用户，下载发布包后让 Agent 读 playbook；Agent 完成环境检查、依赖安装、运行目录生成、上游内核获取引导、宿主平台与模型配置并自验；用户在 `127.0.0.1` 获得完整网页控制台。
- **阶段二**：拥有自有域名与 Cloudflare 凭据的用户，在阶段一完成后让 Agent 继续按 playbook 配置隧道与访问控制；公网域名下网页控制台可用且未授权访问拿不到任何数据；用户从发布页下载 APK，在 App 内填写控制台地址（HTTPS）后扫码绑定一次成功。

## 6. 决策记录（decisions[]）

| # | 问题 | 选定 | 状态 |
| --- | --- | --- | --- |
| 1 | 安装引导载体 | 给 Agent 读的安装 playbook，Agent 逐步执行并向用户索要凭据（备选：网页向导 UI） | user_confirmed |
| 2 | 凭据写入方式 | 本地交互式隐藏输入脚本，token 不进聊天/日志/history（备选：用户贴给 Agent 转写） | user_confirmed |
| 3 | 上游内核获取 | playbook 提供上游 GitHub 地址，引导用户自行获取（备选：发布包内嵌分发） | user_confirmed |
| 4 | 无域名/有域名分层 | 两阶段：阶段一本地网页版，阶段二有域名+Cloudflare 凭据再开公网与 APK（备选：单阶段必须有域名） | user_confirmed |
| 5 | 阶段二公网访问控制 | Cloudflare Access（免费 Zero Trust，邮箱验证码/Google 登录）（备选：控制台内置密码） | system_inferred，主人确认 spec 时未否决 |
| 6 | APK 分发与服务器地址 | 发布页直接下载 APK；本期 App 内手输控制台地址 + 扫码绑定，二维码携带地址列后续迭代（见非目标末条） | system_inferred，门禁拆分见 §4 |

## 7. 设计稿门禁自查

本计划全部节点写范围为 `src/`、`scripts/`、`test/`、`docs/`、`examples/`、`README.md`、`package.json`，不命中 `public/`、`mobile/app/www/` 及前端目录/扩展名规则，属纯后端/脚本/文档计划，**不需要 design 块**（已对照 `src/dag-plan.mjs` isUiNode 判定逻辑逐条自查）。

## 8. 验收命令

```bash
npm test
npm run test:browser
node scripts/doctor.mjs --phase local
node scripts/doctor.mjs --phase public
```

阶段二真实域名端到端为单独授权的手动试点验收；可离线部分全部进入 `npm test`。
