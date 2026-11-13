# Multiagent Autoloop 项目初始化实施计划

> 执行方式：当前 Codex 会话原生执行；PR 创建后派发独立只读 reviewer。
> 设计基线：`docs/2026-11-13-project-initialization-design.md`。
> 项目根目录：`/Volumes/Storage/auto调度`。

## 文件地图

- 从原会话迁移：`src/`、`public/`、`scripts/`、`test/`、`package.json`、`package-lock.json`、原控制台设计/计划。
- 新建：`AGENTS.md`、`.gitignore`、`.github/workflows/ci.yml`、`docs/architecture.md`、`docs/scheduling-contract.md`。
- 更新：`README.md`、`package.json`、`package-lock.json`、`src/models.mjs`、`test/config.test.mjs` 或新增聚焦测试。
- 明确不迁移：`node_modules/`、截图、试点 `state/`、`work/`、数据库、密钥、真实规则和具体项目脚本。

## Task 1：建立 Git 安全基线并迁移源码

1. 在目标目录执行 `git init -b main`，创建仅含通用 `.gitignore` 的 `chore: initialize repository` 基线提交。
2. 创建 `feat/initial-public-migration` 分支；后续所有迁移和修改只在该分支进行。
3. 复制设计指定的源码、测试和文档，不复制任何排除项。
4. 执行 `npm install`，确认锁文件可用；不启动或停止原 `50761` 服务。

验证：

```bash
git status --short
find . -path './.git' -prune -o -path './node_modules' -prune -o -type f -print
npm test
```

预期：迁移后的既有 23 项测试通过；文件清单不含密钥、数据库、真实配置、截图或个人项目文件。

## Task 2：移除公开源码中的本机个人路径（TDD）

1. 在 `test/models.test.mjs` 新增回归：当 `HOME` 未设置时，`modelLabels()` 不得读取或返回 `<本机用户目录>`，且已有模型配置时仍正常解析。
2. 先运行 `node --test test/models.test.mjs`，确认当前 `<本机用户目录>` 回退导致预期失败（RED）。
3. 最小修改 `src/models.mjs`：以 `os.homedir()` 和空安全回退替代个人绝对路径，不改变模型标签规则。
4. 再运行聚焦测试和完整 `npm test`，确认 GREEN。

预期：公开源码及 Git 暂存 diff 不含 `<本机用户目录>` 或其他真实用户路径；全部单元/集成测试通过。

## Task 3：写入架构与调度契约

1. 更新 `README.md` 与包名称为 `multiagent-autoloop`，保留启动、安全和测试说明。
2. 新建 `AGENTS.md`，固化设计中的项目边界、上游 v1.8.1 本地化边界、调度职责、事件分支、工作区隔离、安全、TDD、Git/PR 和验证规则。
3. 新建 `docs/architecture.md`：控制面/执行面、模块拥有关系、输入输出、错误边界、配置与密钥流向。
4. 新建 `docs/scheduling-contract.md`：调度会话定义、最近五条摘要、模型/费用展示、无模型异常扫描、Codex 自愈、用户门禁、事件 subject 规范和部署/开发并行约束。
5. 把已批准设计和本计划保留在 `docs/`，作为初始化审计记录。

验证：逐项对照设计中的九条 `AGENTS.md` 规则及原会话调度要求，确认每条都有文档位置；文档不包含真实凭据、令牌、私有项目提示词或个人业务数据。

## Task 4：加入可重复 CI 并完成本地验证

1. 新建 `.github/workflows/ci.yml`：Node.js 24，`npm ci`，运行 `npm test`；浏览器任务安装 Chromium 后运行 `npm run test:browser`，不访问真实中台或模型。
2. 运行 `npm test` 与 `npm run test:browser`。
3. 运行架构探针、敏感信息扫描和 `git diff --check`；检查暂存文件清单及完整 staged diff。
4. 提交 `feat: establish multiagent autoloop control plane`，提交说明记录测试证据。

预期：全部测试通过，浏览器无错误，扫描无密钥/个人路径，提交只包含设计范围。

## Task 5：公开仓库、PR、独立审阅与合并

1. 用已登录的 `halfmoon82` 账号创建公开仓库 `multiagent-autoloop`，添加远端。
2. 推送基线 `main`（仅仓库初始化提交）和功能分支；不为初始化以外的变更直推 `main`。
3. 创建初始化 PR 并附加到当前 Codex 会话。
4. 派发独立只读 reviewer 审查 PR diff，按 P0/P1/P2/P3 分级；重点检查秘密泄露、调度边界、测试有效性和迁移回归。
5. 对 P0–P2 逐条核实、修复、重跑测试、推同一分支并复审；最多三轮。
6. 某轮无 P0–P2 且验证绿后 squash 合并；不部署、不切换正在运行的服务、不修改真实调度规则。

最终证据：公开仓库 URL、PR URL、reviewer 结论、测试数量、合并提交和本地/远端分支状态。

## Review Focus

- 任何密钥、SQLite、真实规则或个人路径都不得进入 Git 历史，包括首个功能提交。
- `HOME` 回退修复必须先看到测试按预期失败，再看到通过。
- CI 不得隐式连接真实 Autoloop 中台或消耗模型额度。
- `AGENTS.md` 必须明确“控制面在本仓库，任务执行在各自隔离项目工作区”。
- 部署事件与开发调度是并行分支，任何一方不得成为另一方的前置条件。
