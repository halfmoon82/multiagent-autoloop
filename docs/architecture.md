# 架构说明

## 系统定位

Multiagent Autoloop 是本机跨平台自动化的控制面。浏览器控制台通过 Node.js 服务读取 Autoloop Hub 状态、管理规则和代理受限操作；目标项目仍是独立执行面。

```text
浏览器 / 未来客户端
        │ 本机 HTTP，受限写操作
        ▼
Multiagent Autoloop 控制台（本仓库）
        │ 服务端持有 owner key，固定 Hub + 路径允许列表
        ▼
Agent Autoloop v1.8.1 本地化运行环境（仓库外）
        │ 规则、事件和隔离工作区
        ▼
Codex / WorkBuddy / Claude Code 等执行平台
        │
        ▼
各自目标项目的独立工作区、Git 和交付
```

## 控制面与执行面

控制面拥有：状态汇总、规则和卡片操作、模型/费用展示、调度契约、通用适配器。

执行面拥有：目标项目需求、业务代码、业务测试、部署配置、生产数据、提交和发布。控制面可以创建调度会话和事务，但不能把执行面文件并入自己的仓库。

## 模块契约

### 配置 `src/config.mjs`

- 输入：`AGENT_AUTOLOOP_HOME`、`AUTOLOOP_CONSOLE_PORT`。
- 输出：Hub 地址、规则文件、CLI 路径、仅服务端使用的 owner key、本机监听地址。
- 错误：缺配置、无效 JSON、缺地址/密钥、非 HTTP(S) 地址应在启动时可读失败。
- 禁止：把密钥写入 API 响应或浏览器模块。

### Hub 适配 `src/hub.mjs`

- 输入：已验证配置和由服务端路由生成的路径。
- 输出：解析后的 Hub JSON。
- 错误：网络、超时、非 JSON 和上游错误转为可读 `HubError`。
- 禁止：接受浏览器提供的任意完整 URL，形成开放代理。

### 规则 `src/rules.mjs`

- 输入：白名单表单字段和现有 `rules.json`。
- 输出：保留未编辑字段的新规则文件。
- 事务：先写草稿，调用当前安装版 `agent-autoloop check`，成功后原子替换；失败保持原文件字节不变。
- 权限：access 属于 Agent，不属于单条 Rule。

### 调度会话 `src/scheduling-session.mjs`

- 输入：服务端固定启动 `@agentclientprotocol/codex-acp`，工作目录为被调度项目的本地仓库（项目须是已发现的本机 Git 仓；无法识别时回退本仓库根目录），浏览器不能指定工作目录。
- 输出：本地 ACP 会话 ID、状态、Codex 适配器信息和关闭结果。
- 安全：浏览器不能指定启动命令、工作目录或环境变量。
- 专用 CODEX_HOME（`src/session-codex-home.mjs`）：派生会话不继承用户全局 `~/.codex/config.toml` 的 `approval_policy`（事故：全局 `never` 旁路权限门）。控制台在 `<AGENT_AUTOLOOP_HOME>/codex-home/` 每次开会话前重写配置：强制 `approval_policy="on-request"`、`sandbox_mode="workspace-write"`，只白名单继承 model/model_provider/model_providers 等模型供应商项，不继承 notify 钩子、MCP、项目信任；`auth.json` 软链沿用登录态。启动时显式传 `CODEX_HOME`，准备失败拒绝启动（fail closed）。用户全局策略仍归其自有 CLI worker。
- 按 kind 权限矩阵（`src/session-permission.mjs`，`#decidePermission` 调用）：只选 `allow_once`，无法识别的请求一律取消。
  - normal：编辑工具路径与 execute 的 cwd 由权限层限定在项目工作区；任意 shell 命令属用户委托开发（与用户自有 CLI 同信任级），权限层只拦截分支/推送类禁令，不对 shell 做路径 jail；另放行网络；禁止推 main/master 等非 feat|fix|hotfix|… 前缀分支、force/delete/mirror 推送、裸 `git push`、工作目录越界；`gh pr create`、feature 分支 push、用户授权后的 `gh pr merge` 可走通。首轮另附分支纪律提示块（用户消息保持逐字）。模式 `workspace-write`。
  - design：全量取消（read-only + Plan Mode，保持不变）。
  - scheduling：仅 `AGENT_AUTOLOOP_HOME/scripts` 内文件编辑 + `autoloop-hub` 的读工具与 resume/pause/run_rule（及预留 dispatch_task）；shell、网络、项目写入、合并一律取消。模式 `read-only`，创建前设置并核验，失败即拒绝创建。
- 审计：每次裁定追加到 `<AGENT_AUTOLOOP_HOME>/permission-audit.jsonl`（时间、kind、项目、工具类型、命令、路径、结论、原因），拒绝同时写 stderr。
- 生命周期：控制台进程持有连接；关闭会话会发送 `session/close` 并终止适配器进程。

### HTTP 服务 `src/server.mjs`

- 拥有：静态资源、`/api/*` 路由、参数校验、本机 Host/Origin 校验和统一错误响应。
- 写操作：同源、自定义 `x-console-request`、JSON body、数字 ID 和固定动作允许列表；调度会话使用单独的只读列表、开启和关闭路由。
- 状态：无独立业务数据库；状态事实源仍是外部 Autoloop Hub。

### 模型标签 `src/models.mjs`

- 从 `HOME` 下的 Codex、WorkBuddy 和 Claude 配置只读发现显示标签。
- `HOME` 缺失时返回通用默认文案，不回退到某个真实用户目录。
- 只展示发现结果；费用只能使用 Hub 上报，不能按模型名猜测。

### 前端 `public/`

- 原生 HTML/CSS/JavaScript，无运行时框架依赖。
- 总览、规则、轮次和卡片通过本机 API 工作。
- 所有上游文本按文本渲染；五秒刷新失败保留最后成功状态并显示错误。

## 数据与秘密流向

`config.json → loadConsoleConfig → hubRequest Authorization` 是唯一正常的 owner key 流向。API 响应、静态资源、测试快照和 Git 都不是合法终点。

真实 `rules.json`、Hub SQLite/WAL、模型平台配置和调度扫描状态均留在 `AGENT_AUTOLOOP_HOME` 或平台自有目录，不进入公开仓库。

## 错误与验证边界

- Hub 离线/超时/非 JSON：API 返回可读 502，界面保留最后成功数据。
- 无效规则：返回 400，正式规则不变。
- 跨站或伪造 Host：在到达 Hub 前拒绝。
- 目标项目失败：由调度契约规定诊断和自愈，控制台不承担业务修复。

验证层级：纯逻辑单元测试 → 假 Hub API 集成测试 → 临时 profile Playwright 回归 → 用户明确授权的真实环境 smoke。CI 只运行前三类，不消耗模型额度。

## 当前非目标

公网、多用户、多 Hub、Android 安装包、消息推送、自动部署、生产数据修改和 Autoloop 上游内核重构均不在当前仓库基线内。
