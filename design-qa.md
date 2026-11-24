# NoMoTo Design Baseline QA — 2026-11-22

## Source visual truth

- `docs/design/2026-11-17-mobile-app/app.js`
- `docs/design/2026-11-17-mobile-app/styles.css`
- `docs/design/2026-11-17-mobile-app/DESIGN_REVIEW.md`（六栏导航决定）
- 当前渲染参考：`work/design-baseline-qa/01-design-sessions.png`、`03-design-conversation.png`

## Implementation evidence

- 实现提交：`2851757`（之后仅新增测试与本 QA 文件）
- 会话列表：`work/design-baseline-qa/02-current-sessions.png`
- 会话详情（三个待回答问题、两条排队消息）：`work/design-baseline-qa/04-current-conversation.png`
- 其余六页：`work/design-baseline-qa/11-other-tabs-contact-sheet.png`
- 队列管理：`work/design-baseline-qa/14-current-queue-panel.png`
- 管理后台移动壳：`work/design-baseline-qa/15-current-admin-mobile.png`
- 同图对照：`work/design-baseline-qa/12-list-comparison.png`、`13-detail-comparison.png`

## Viewport / normalization

- 视口：390×844 CSS px，deviceScaleFactor=1。
- 原型设备外框截图：390×845 px（含 1px 边界）；实现页面：390×844 px。
- 比较时仅做高度边界归一，不缩放、不裁切实现内容。
- 状态：会话列表含普通/调度/设计会话；详情含三个待回答问题和两条排队消息；其余页使用同一假 Hub/假设备授权，不触碰真实数据。

## Full-view and focused-region comparison

- 列表：标题组、全宽新建、搜索、数量筛选、状态卡片和底部导航均已形成对应结构。原生项目选择器、品牌头部和真实数据文案与原型示例不同。
- 详情：返回式详情头、上下文、排队信息、待回答定位、问题选项与 composer 均存在；消息与问题组共用滚动区，composer 独立常驻底部。
- 重点复查：三问题场景下问题选项与 composer 同时可见，未再出现整组挤出首屏的问题。

## Comparison history

1. **P1 — 会话列表和详情使用另一套信息架构。** 已补共享底部六栏、列表标题/卡片和详情工具/composer；复拍见 `12-list-comparison.png`、`13-detail-comparison.png`。
2. **P1 — 三个待回答问题将消息与 composer 挤出首屏。** 改为消息与问题组共用滚动区、composer 独立固定；复拍确认问题选项与 composer 同时可见。
3. **P2 — 其余页面缺少统一标题与项目筛选层级。** 已统一六个页面标题、卡片、状态、管理分区和项目筛选；复拍见 `11-other-tabs-contact-sheet.png`。
4. **P1 — 输入缺少打断/steer、队列不可管理、历史区过小。** 已补默认排队与打断两种发送方式，队列编辑/排序/删除/清空/立即引导均通过真实浏览器操作；历史区默认扩大，提示词与队列按需展开，回到底部改为浮层。
5. **P2 — 总览仍承载移动壳设置。** 已迁到管理后台独立“移动壳”分区，总览只保留任务信息；复拍见 `15-current-admin-mobile.png`。

## Findings

无剩余 P0/P1/P2 阻断项。队列编辑/排序/清空/立即引导和打断发送均有真实服务调用证据，不再只做外观对齐。

**Follow-up Polish（P3）**

- 原型品牌头部、状态栏和示例数据与实际 NoMoTo/真实数据不同，不做无意义逐像素复制。
- 原生项目选择器、连接状态卡和部分间距密度保留实现差异；真实 Android/HarmonyOS 的最终视觉、字体、生物识别和语音仍需真机验收。
- 原型自身仍是五栏，导航以 DESIGN_REVIEW 已确认的六栏决定为准。

## 2026-11-23 补充验收

- 平台与模型：公网直接 `/api/admin/*` 的 404 已改为带设备鉴权的 `/api/mobile/admin/platform-models`，GET/PUT 与保存确认回归通过，未裸暴露管理接口。
- 顶栏：项目筛选与连接状态合并为一行，保留原生选择器和全部/清除行为。
- 卡片：非 DAG 长卡片默认限高 160px，可展开/收起；短卡与 DAG 不增加控件，button 卡片无嵌套按钮。
- 附件：文本与图片均可选择、预览、移除和发送；文件落盘、文本内容与图片路径进入 Agent prompt，纯打断不保存附件。
- 新截图：`02-current-sessions.png`、`04-current-conversation.png`、`15-current-admin-mobile.png`。

## 2026-11-23 规则与部署复核

- 规则 run/pause/resume 不再向 Hub 注入白名单外的 `sourceDeviceId`，避免 Hub 返回“请求无效”；设备来源仅保留本地审计。
- 顶栏连接状态改为绿点/红点，项目筛选与设置位于同一行。
- 正式服务已切换到 `75e49c4`，本机与远程 HTML 一致；远程六栏、连接点、项目顶栏、管理网关和未授权 401 均已复核，浏览器无脚本错误。
- 管理接口未裸暴露：App 使用 `/api/mobile/admin/platform-models`，设备未授权时按预期返回 401。

## 折叠误伤与普通会话修正

- 可操作表单不再被折叠；模型选择、输入、队列与待办直接可用。
- 执行授权等静态 `.core-card/.core-item` 才按固定高度折叠并可展开。
- 项目选择去掉双重边框、空状态占位和横向溢出；连接点保持绿/红状态。
- 普通会话不再显示伪造的“没有需要回答”提示；真实消息显示与发送回归通过。
- 正式服务已切换至 `2851757`；远程资源与本机一致，390px 无横向溢出，浏览器无脚本错误。

## Functional verification

- `npm test`：1431/1431 通过。
- `npm run test:browser`：全部通过。
- 390×844 浏览器渲染：无 `pageerror`。
- Release APK：构建、zipalign、v1/v2/v3 签名、ZIP 完整性和基线资源检查通过；生物识别类字节码确认 `Activity.runOnUiThread`。
- APK：`/Users/macmini/Downloads/NoMoTo-2026-11-23-collapsible-fix.apk`
- SHA-256：`b447e712bdadd93ef37ad7ce08c9b5130d1374ffc0a425df0951f8908e7a21d4`

final result: passed
