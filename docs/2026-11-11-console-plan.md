# Autoloop Local Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为当前 Autoloop 试点提供本机浏览器控制台，并保留未来 Android 客户端可复用的 API。

**Architecture:** 独立 Node.js 24 服务代理允许列表内的 Autoloop API；原生前端只与同源控制台 API 通信。规则文件通过草稿校验和原子替换更新。

**Tech Stack:** Node.js 24、node:test、原生 HTML/CSS/JavaScript；浏览器验证使用 Playwright 开发依赖。

**Spec:** `outputs/autoloop-console/docs/2026-11-11-console-design.md`

## Global Constraints

- 当前只监听 `127.0.0.1`，不启用 CORS，不向浏览器返回 Autoloop 密钥。
- 不修改 Autoloop 上游代码，不在控制台测试中自动运行真实模型。
- 所有行为先写失败测试，再实现；每个任务完成后运行完整测试。
- API 使用 `/api/*`，上游代理只允许明确的 Autoloop 路径。

## Review Focus

- 恶意或异常上游文本必须按文本渲染，不得变成 HTML；由总览任务测试。
- 中台离线、超时和非 JSON 响应必须显示可读错误；由服务层任务测试。
- 跨站请求和非 JSON 写请求必须被拒绝；由操作任务测试。
- 无效规则不得替换正式 `rules.json`；由规则编辑任务测试。
- 手机窄屏不得隐藏状态或主要操作；由浏览器任务检查。

### Task 1: 服务配置与只读状态 API

**Files:**
- Create: `outputs/autoloop-console/package.json`
- Create: `outputs/autoloop-console/src/config.mjs`
- Create: `outputs/autoloop-console/src/hub.mjs`
- Create: `outputs/autoloop-console/src/server.mjs`
- Test: `outputs/autoloop-console/test/config.test.mjs`
- Test: `outputs/autoloop-console/test/state.test.mjs`

**Interfaces:**
- `loadConsoleConfig(root)` 返回中台地址、规则路径、CLI 路径与本人密钥，密钥不进入响应。
- `hubRequest(path, options)` 只访问配置的中台。
- `createConsoleServer(config)` 提供 `GET /api/state` 和静态文件服务。

- [x] 写失败测试：正常读取配置；缺配置时报错；`GET /api/state` 返回中台快照；离线与无效 JSON 返回 502；密钥不出现在响应。
- [x] 运行测试并确认因实现缺失而失败。
- [x] 实现最小服务、统一 JSON 错误和安全响应头。
- [x] 运行 `npm test`，确认通过。

### Task 2: 总览与自动刷新

**Files:**
- Create: `outputs/autoloop-console/public/index.html`
- Create: `outputs/autoloop-console/public/styles.css`
- Create: `outputs/autoloop-console/public/app.mjs`
- Create: `outputs/autoloop-console/public/format.mjs`
- Test: `outputs/autoloop-console/test/format.test.mjs`

**Interfaces:**
- `formatState(snapshot)` 生成页面视图数据，不生成不可信 HTML。
- 页面提供总览、规则、轮次、卡片四个导航区域和手动刷新。

- [x] 写失败测试：状态计数、Token/费用、空状态和错误文本。
- [x] 实现响应式页面、语义化导航、加载/空/错误状态；用 `textContent` 渲染上游文字。
- [x] 每 5 秒刷新；刷新失败保留上次成功数据并显示离线提示。
- [x] 运行 `npm test`，确认通过。

### Task 3: 调度操作与卡片处理

**Files:**
- Modify: `outputs/autoloop-console/src/hub.mjs`
- Modify: `outputs/autoloop-console/src/server.mjs`
- Modify: `outputs/autoloop-console/public/app.mjs`
- Test: `outputs/autoloop-console/test/actions.test.mjs`

**Interfaces:**
- `POST /api/rules/:name/run|pause|resume`
- `POST /api/runs/:id/cancel`
- `POST /api/cards/:id/answer|resolve`

- [x] 写失败测试：各操作映射到正确上游路径；非法编号、未知动作、跨站来源、缺少自定义头和非 JSON 请求均被拒绝。
- [x] 实现允许列表代理和输入校验，不转发任意路径。
- [x] 在规则、轮次和卡片上接入按钮、确认对话框、结果提示与刷新。
- [x] 运行 `npm test`，确认通过。

### Task 4: 表单化规则编辑

**Files:**
- Create: `outputs/autoloop-console/src/rules.mjs`
- Modify: `outputs/autoloop-console/src/server.mjs`
- Modify: `outputs/autoloop-console/public/app.mjs`
- Create: `outputs/autoloop-console/public/rule-form.mjs`
- Test: `outputs/autoloop-console/test/rules.test.mjs`

**Interfaces:**
- `GET /api/rules` 返回规则与 Agent 选项。
- `PUT /api/rules/:name` 接收表单字段，更新已有规则。
- `POST /api/rules` 创建规则；`validateAndReplaceRules()` 先验草稿再原子替换。

- [x] 写失败测试：创建、编辑、重名、非法 cron/权限/目录字段；校验失败保持原文件字节不变。
- [x] 实现服务端白名单字段、草稿校验、原子替换和编辑器。
- [x] 表单覆盖名称、触发类型/cron/来源、Agent、目录、提示、权限、并发和 resume。
- [x] 运行 `npm test`，确认通过。

### Task 5: 真实中台与浏览器验收

**Files:**
- Create: `outputs/autoloop-console/scripts/start.mjs`
- Create: `outputs/autoloop-console/README.md`
- Test: `outputs/autoloop-console/test/browser.spec.mjs`

- [x] 写启动脚本，使用 `AGENT_AUTOLOOP_HOME` 定位当前试点并输出本机 URL。
- [x] 用无模型恢复测试规则验证状态读取、暂停/恢复和立即运行；用既有测试卡片验证回答流程，不额外调用真实模型。
- [x] 用 Playwright 临时浏览器 profile 验证桌面和 360px 布局、键盘操作、控制台零错误和安全响应头。
- [x] 运行完整 `npm test` 与浏览器测试，记录结果和仍未覆盖的边界。
- [x] 编写启动、停止、安全边界和未来 Android 接入说明。
