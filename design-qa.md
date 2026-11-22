# NoMoTo Design Baseline QA — 2026-11-22

## Source visual truth

- `docs/design/2026-11-17-mobile-app/app.js`
- `docs/design/2026-11-17-mobile-app/styles.css`
- `docs/design/2026-11-17-mobile-app/DESIGN_REVIEW.md`（六栏导航决定）
- 当前渲染参考：`work/design-baseline-qa/01-design-sessions.png`、`03-design-conversation.png`

## Implementation evidence

- 实现提交：`07336e2`（之后仅新增测试与本 QA 文件）
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

## Functional verification

- `npm test`：1419/1419 通过。
- `npm run test:browser`：全部通过。
- 390×844 浏览器渲染：无 `pageerror`。
- Release APK：构建、zipalign、v1/v2/v3 签名、ZIP 完整性和基线资源检查通过；生物识别类字节码确认 `Activity.runOnUiThread`。
- APK：`/Users/macmini/Downloads/NoMoTo-2026-11-22-queue-steer.apk`
- SHA-256：`4eba968c412952e03a421b8a32e5981497fbfc1527f86b66ad69a6fd2258f7a8`

final result: passed
