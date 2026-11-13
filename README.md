# Multiagent Autoloop

Agent Autoloop v1.8.1 本地化运行环境的跨平台控制台与调度控制面。提供总览、调度规则、执行轮次和人工卡片，并把具体项目任务留在各自隔离工作区。

本仓库不包含 Autoloop 上游完整内核，也不保存真实规则、模型凭据、运行数据库或目标项目代码。

## 功能

- 总览：运行、排队、重试、失联、待调度处理、Token、费用和最近五条概要。
- 规则：表单新建/编辑、模型与权限展示、立即运行、暂停和恢复。
- 轮次：结果、失败原因、会话链接和停止。
- 卡片：选项或文字回答；只有真正需要用户决策的门禁才升级给用户。
- 今日完成：按实际上报显示费用、Token 或“费用未上报”。

架构和调度边界见 [架构说明](docs/architecture.md) 与 [调度契约](docs/scheduling-contract.md)。

## 环境与安装

需要 Node.js 24 或更高版本，以及一个已经配置好的 Agent Autoloop 运行目录。

```bash
npm ci
AGENT_AUTOLOOP_HOME=/绝对路径/autoloop-state AUTOLOOP_CONSOLE_PORT=50761 npm start
```

打开 `http://127.0.0.1:50761`。不设置端口时使用随机空闲端口。按 Ctrl+C 停止。

`AGENT_AUTOLOOP_HOME` 应至少包含 `config.json`、`rules.json` 和当前安装版 `app/bin/agent-autoloop.ts`。这些文件属于本机运行状态，不从公开仓库获取。

## 安全边界

只监听 `127.0.0.1`。Autoloop 密钥仅在 Node 服务端使用，不进入浏览器。写操作要求本机 Host、同源、自定义请求头和 JSON，不启用 CORS；上游地址与操作路径采用固定配置和允许列表。

当前没有远程认证，不应通过端口转发直接暴露。远程启用前必须另加 HTTPS、设备级凭证和私网/VPN 或等价保护。

规则权限沿用所选 Agent；Autoloop 不把 access 定义在单条规则上。规则保存先以当前安装版 `agent-autoloop check` 校验草稿，失败不会替换正式文件。

## 验证

```bash
npm test
npm run test:browser
```

浏览器测试使用临时 profile 和假 Hub，不调用真实模型。CI 使用 Node.js 24 和 `npm ci` 重复这些检查。

## 开发与交付

修改前阅读 [AGENTS.md](AGENTS.md)。功能在分支上开发，行为修改先写失败测试；PR 经独立 reviewer 审阅，P0–P2 清零且验证通过后 squash 合并。

合并不自动部署、不重启本机服务、不修改真实调度规则，也不授权目标项目发布。
