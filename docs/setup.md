# 外部用户配置引导（v1.0）

本仓库是 Agent Autoloop 上游内核（v1.8.1 代际）的**控制台与调度控制面增量**，
不含上游内核本体。你需要先有一个已配置好的 Autoloop 运行目录（`AGENT_AUTOLOOP_HOME`），
再启动本控制台对接它。

## 1. 运行目录（本地状态，不入库）

```
<AGENT_AUTOLOOP_HOME>/
├── config.json      # 中台地址与本人密钥（见 examples/config.example.json）
├── rules.json       # 调度规则（见 examples/rules.example.json 与本文第 3 节）
├── app/             # 上游内核安装位置（含 bin/agent-autoloop.ts）
├── hub.db           # 运行数据库（自动生成）
└── *.json / logs/   # 串行编排状态、日志（规则/控制器写）
```

`config.json` 的 `url` 指向本机 `agent-autoloop up` 监听地址（默认仅 127.0.0.1），
`owner` 是宿主为你生成的密钥。两者都只存在本机，不进任何仓库。

## 2. 安装与启动

```bash
npm ci
AGENT_AUTOLOOP_HOME=/绝对路径/autoloop-state AUTOLOOP_CONSOLE_PORT=50761 npm start
```

常驻运行可用 launchd / systemd 包装 `scripts/start.mjs`；退出码非 0 即崩溃，交给监管进程拉起。

## 3. 编写调度规则

规则由控制台表单保存（推荐），保存时会用上游 `agent-autoloop check` 校验草稿，
并做「写意图 × 只读通道」契约校验：提示词要求写状态文件却绑 `access: "read"` 的
Agent 会被拒绝——这类错配运行期必然死锁。

关键字段：

| 字段 | 说明 |
| --- | --- |
| `when` | `{cron: "分 时 日 月 周"}` 定时，或 `{source, types: [...]}` 事件 |
| `to` | agents 表中的执行端 id |
| `cwd` | 被调度项目的绝对路径 |
| `prompt` | 该轮的完整指令，自包含（调度方不会自动带历史） |
| `resume` | true 时沿用上回合会话（适合长链接续） |
| `parallel` | 同规则最大并发（可选） |

`access` 与沙箱映射（上游内核语义）：`read` → 全程只读；`edit` → 仅工作区可写；
`full` → 完全访问。**只给确实需要写文件的规则配可写执行端**（如 `codex-full`）。

调度行为边界（哪些事可以打扰人、哪些必须自己扛）见
[调度契约](scheduling-contract.md)，卡片陈述规则也在其中。

## 4. 安全边界

- 控制台只监听 `127.0.0.1`，没有远程认证；暴露到远程前必须另加 HTTPS、设备级凭证与私网/VPN。
- 密钥只进 Node 服务端，不进浏览器、截图、测试快照与日志。
- 目标项目的源码、数据库、凭据留在目标项目自己的仓库与工作区，本控制台只持路径与规则。

## 5. 版本与回滚

v1.0.0 是首个成型基线（tag `v1.0.0`）。回滚：

```bash
git fetch --tags
git checkout v1.0.0
# 重启控制台服务即可
```

在基线之后的修复走 main 分支；需要回到基线时就地 checkout，无需改运行目录。
