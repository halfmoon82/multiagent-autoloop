# NoMoTo Design Baseline Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏真实数据、设备授权和现有交互的前提下，让 NoMoTo 的共享外壳、六个主 Tab 与会话流程遵守已确认的设计基线。

**Architecture:** 保留当前 Capacitor/原生桥、移动端 API 和页面视图模型，只重构 Web 壳的结构、样式与必要 DOM。以 `DESIGN_REVIEW.md` 的六栏决定为导航事实源，以现有高保真原型的视觉层级、卡片、状态和交互为页面基准；不修改设计基线文件，不另立视觉风格。

**Tech Stack:** 原生 HTML/CSS/ES modules、Playwright、Node test runner、Capacitor Android。

**Spec:** `docs/design/2026-11-17-mobile-app/DESIGN_REVIEW.md`、`docs/design/2026-11-17-mobile-app/app.js`、`docs/design/2026-11-17-mobile-app/styles.css`、`docs/dag-plans/2026-11-21-nomoto-app-6tab-voice-composer.json`、`work/design-audit-2026-11-22/AUDIT.md`

## Global Constraints

- 主导航固定为总览／规则／会话／轮次／待办／管理后台，运行时不得增加第七项。
- 保留现有 API、设备授权、生物识别、会话写操作、语音、滑动、返回栈和费用/空态语义。
- 不修改 `docs/design/` 下的基线、原型、参考截图或批准记录。
- 不部署、不重启真实控制台、不操作真实规则；部署需另行授权。
- 视觉验收至少覆盖 390×844 的会话列表和会话详情，功能验收与视觉验收分别报告。

## Review Focus

- 动态会话类型、长标题和空列表不得破坏卡片与底部导航布局；由 Task 2 的浏览器 fixture 覆盖。
- 长消息、待回答组、排队消息与软键盘不得遮挡 composer；由 Task 3 的现有与新增浏览器回归覆盖。
- 管理后台表单、待办草稿与规则写操作不得因 DOM 重构失效；由 Task 4 的现有浏览器回归覆盖。
- 六栏在 390px 宽度与 160% 字体下不得产生页面级横向溢出；由 Task 1/Task 4 的响应式检查覆盖。
- 设计原型仍是五栏时不得把它误当导航事实源；以 DESIGN_REVIEW 的六栏决定为准，由 Task 1 的导航测试固定。

---

### Task 1: 共享外壳与底部六栏

**Files:**
- Create: `mobile/app/www/icons.mjs`
- Modify: `mobile/app/www/index.html`
- Modify: `mobile/app/www/app.mjs`
- Modify: `mobile/app/www/styles.css`
- Test: `test/mobile-design-baseline.test.mjs`

**Interfaces:**
- Consumes: 现有 `MOBILE_PAGES`、`selectTab`、项目筛选与页面栈。
- Produces: `renderIcons(root)` 与共享 `.bottom-nav`、`.page-heading`、`.status-chip` 视觉合同。

- [ ] 写失败测试：导航位于主内容之后，恰好六项并带图标；六列网格；无页面级横向溢出。
- [ ] 运行测试确认因共享壳未实现而失败。
- [ ] 复用原型已有图标资产语义，调整 DOM/CSS，保持所有现有路由与 aria 状态。
- [ ] 运行定向测试和浏览器壳回归，提交共享壳增量。

### Task 2: 会话列表高保真返工

**Files:**
- Modify: `mobile/app/www/pages/sessions.mjs`
- Modify: `mobile/app/www/pages/sessions.css`
- Modify: `mobile/app/www/icons.mjs`
- Test: `test/mobile-design-baseline.test.mjs`
- Test: `test/mobile-session-inputs.test.mjs`

**Interfaces:**
- Consumes: 当前 sessions reader、类型筛选、搜索、归档与项目筛选。
- Produces: 会话列表标题组、全宽新建按钮、搜索、数量筛选片、状态卡片与归档区，数据仍来自现有 view model。

- [ ] 写失败测试：标题组、控件顺序、类型计数、状态胶囊、归档数量及长标题布局。
- [ ] 运行测试确认 RED。
- [ ] 最小重构列表 DOM/CSS，不改变筛选、搜索和进入会话行为。
- [ ] 运行列表/新建/详情回归并捕获同视口设计对照，提交列表增量。

### Task 3: 会话详情、待回答组与新建会话

**Files:**
- Modify: `mobile/app/www/pages/sessions.mjs`
- Modify: `mobile/app/www/pages/sessions.css`
- Modify: `mobile/app/www/icons.mjs`
- Test: `test/mobile-design-baseline.test.mjs`
- Test: `test/mobile-session-inputs.test.mjs`
- Test: `test/browser.spec.mjs`

**Interfaces:**
- Consumes: 现有消息窗、待回答组、排队操作、产物入口、composer-autogrow 与 voice-input。
- Produces: 详情头、会话工具条、状态/提示条、问题组、排队预览与图标 composer；保留内部消息窗滚动。

- [ ] 写失败测试：详情工具条、状态提示、问题组结构、排队/产物入口和 composer 图标/位置。
- [ ] 运行测试确认 RED。
- [ ] 实现详情与新建表单视觉返工，保持发送、语音、草稿和返回栈语义。
- [ ] 跑会话完整浏览器回归，捕获详情同视口对照，提交详情增量。

### Task 4: 其余五个 Tab 与可达子页面统一视觉层级

**Files:**
- Modify: `mobile/app/www/index.html`
- Modify: `mobile/app/www/pages/core.mjs`
- Modify: `mobile/app/www/pages/core.css`
- Modify: `mobile/app/www/pages/admin.mjs`
- Modify: `mobile/app/www/pages/admin.css`
- Modify: `mobile/app/www/styles.css`
- Test: `test/mobile-design-baseline.test.mjs`
- Test: `test/mobile-content-align.test.mjs`

**Interfaces:**
- Consumes: 现有 core/admin/artifacts/dag/settings 视图模型和写操作。
- Produces: 各页标题组、统一卡片/状态/表单层级；管理后台与设置沿用六栏和齿轮决定。

- [ ] 写失败测试：六页标题、状态组件、管理后台分区、设置入口与窄屏溢出。
- [ ] 运行测试确认 RED。
- [ ] 实施共享样式和必要 DOM，不改变真实字段与写操作。
- [ ] 跑全量内容/管理后台/待办/规则/轮次回归，提交剩余页面增量。

### Task 5: 设计 QA、全量验证与 APK

**Files:**
- Create: `design-qa.md`
- Create/Modify: `work/design-baseline-qa/`（忽略的证据文件）
- Modify: 仅修复 QA 发现的 P0/P1/P2 文件

**Interfaces:**
- Consumes: 前四任务实现和原型参考图。
- Produces: 可审计的视觉 QA、全量测试证据与签名 APK；不包含部署。

- [ ] 同视口捕获设计/实现列表与详情，检查关键区域，修复 P0/P1/P2 并复拍。
- [ ] 运行 `npm test` 与 `npm run test:browser`，要求全绿。
- [ ] 运行 release APK 构建、签名校验、ZIP 与资源检查；真机项目如实标未覆盖。
- [ ] 写 `design-qa.md`（必须为 passed 才可交付）并汇报未覆盖边界。
