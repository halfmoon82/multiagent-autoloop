# NoMoTo App 交互修复 + 多控制台 + 通知 + 上限 6 + 提速 + 设计授权 + 响应体验 + steer + 产物接线（2026-11-24 设计交付 v4）

## 背景
- 用户真机实测（2026-11-24）：NoMoTo App 经几轮迭代基本可用，反馈 8 项缺陷与新增需求。界面 4 项：会话列表无法关闭会话且不想进会话内关闭；输入区加号/语音/发送布局错误、行高漂移；底部 6 tab 只能点不能滑；折叠卡片折后无法再展开。系统 4 项：断联重连从未生效必须杀进程；需一 App 连多个不同电脑上的中台、首屏应为控制台选择+添加；会话内发送首条无反馈且普通会话返回太慢；通知从未生效——要求三类：待我处理卡片、会话新回复（普通/设计/调度全类型）、开发节点完成。
- 同日追加确认：会话全局上限硬编码 3 不可配（src/scheduling-session.mjs:211）→ 默认 6 且可配；App 首屏加载提速；多控制台除首屏外还应在设置页切换；App 会话页缺网页版设计会话的「确认计划·放行落盘」「确认执行范围」双按钮（public/views.mjs:229-230）；App 会话响应体验对齐网页版（网页自适应 1s 轮询 + liveText 流式，App 写死 5s 轮询且无即时响应态）。
- 同日又定位两项真机问题（代码实证）：(a) App「打断」按钮不真正生效——服务端 send() 打断分支有意忽略 text（scheduling-session.mjs:742 注释：网页版打断传空串为纯停止），而 App 按钮语义是「打断并立即发送输入框文字」，结果点了打断本轮虽停、输入文字被丢弃；(b) App 产物页与网页版永远不同步——hooks.artifacts / hooks.artifactsForSession 全仓无任何页面赋值，产物页初始化恒为空列表，数据源从未接线（网页版用 GET /api/scheduling-sessions/:id/artifacts）。
- 事实核对：tab-swipe 代码已接线但真机失效（旧鸿蒙 WebView 手势兼容）；collapsible-cards 有展开逻辑但真机折后展不开；控制台通知事件源已有待办卡片与节点完成、缺 session-reply；原生常驻通知服务已入库但真机从未生效；所有响应含 /mobile/ 静态资源全局 cache-control: no-store；移动端绑定后 GET-only，设计授权两个 POST 需经 mobile-write 新增写路由代理。

## 已确认决策（2026-11-24，含同日多轮修订，v4 终稿）
- 关闭会话：列表左滑露出「关闭」+ 二次确认，复用控制台关闭能力，新增 POST /api/mobile/sessions/:id/close，校验口径与网页对齐。
- 设计授权：App 设计会话卡片补「确认计划·放行落盘」（!planApproved 时显示）与「确认执行范围 →」（App 内展示页拉 /api/dag-plan + /api/dag-preflight 逐条出示，勾选已读后 POST /api/mobile/dag-runs 代理，planDigest 服务端校验，未勾选不可提交）；复用网页端授权语义，不另造。
- 多控制台：解锁一次 → 首屏控制台列表（已存中台 + 添加=地址/扫码）→ 点选切换免重复解锁；设置页新增「当前控制台」区块与首屏共用同一数据源；SecureStorage 按 <host>:device-token 分 key。
- 会话响应体验：发送后立即本地进入「Agent 正在响应」态不等轮询；详情轮询自适应对齐网页（本轮进行中 busy/turnStartedAt 1 秒、空闲 5 秒；现状写死 5 秒）；liveText 按 rAF 合帧流式渲染与网页「正在输出…」等效；页面隐藏时不轮询（后台交给通知）。纯客户端，不动服务端。
- steer 真打断：服务端 send() 打断分支支持带文本——ACP 会话 cancel 当前轮后以文本开新轮；Hub 会话 cancelRun 后 postTurn 该文本；打断后移动端不清空输入、按钮给出已打断反馈。语义与 App 按钮既有文案「打断当前轮并立即发送」一致。
- 产物接线：新增 GET /api/mobile/sessions/:id/artifacts 写路由（设备鉴权，代理 listSessionArtifacts，与网页同一份数据）；全局产物页 hooks.artifacts 与会话入口 hooks.artifactsForSession 接上会话快照；下载沿用既有 /download 路由。
- 通知：仅 App 后台或不在该会话详情页时推送 + 角标；三类事件全生效（真机），点击回对应页面；复用 CardNotifier 口径；不接 FCM/华为 Push Kit。
- 发送：乐观上屏（发送中→成功/可重试不丢输入、失败重发不重复入账）；普通会话慢的剩余真·服务端延迟由 session-latency 计时埋点定位（附证据）再修复。
- 断联重连：存活期退避重连、回前台即探测、恢复回原页面、持续连不上才进重连页；不含离线浏览。
- 会话上限：config.json maxSessions 默认 6、上限 12，缺失/非法/越界回退 6+告警；调度会话计入全局计数。
- 首屏提速：内容 hash 静态资产长缓存（入口文档维持 no-store，安全头不回退）+ 非首屏页面懒加载 + 模拟器基线 vs 优化对比。
- review 走平台 PR 门禁（AGENTS.md §8：自动独立 reviewer + review-claim 占位 + P0–P2 清零 squash 合并），不占 DAG 节点。

## 范围
按 docs/dag-plans/2026-11-24-nomoto-app-fix2.json 共 13 节点：wave-0 十节点并行（console-hub / session-actions / tab-swipe-fix / collapsible-expand / notify-events / session-latency / session-limit-config / app-startup-perf / session-steer / artifacts-sync），composer-ux 紧随 session-actions 串行（二者同写 mobile/src/features/sessions/views.mjs 等文件，DAG 校验器要求同写范围的节点必须 depends_on 串行；两侧仍按「行渲染/手势 vs 输入区」划界减少返工），wave-1 integration-verify → smoke-emulator。真机验收另行授权派发，不进本 DAG。

写范围红线（碰撞预防）：app.mjs 只许 console-hub 改 boot 首屏路由、app-startup-perf 改懒加载 import 清单（含 design-authorize 页登记），其余节点禁改；src/mobile-write.mjs 本批两个节点（session-actions / artifacts-sync）只增路由表项与新处理器，不动既有行；src/scheduling-session.mjs 本批三个节点（session-steer / session-limit-config / 注释）追加式共存，不动彼此代码区；src/server.mjs 缓存头归 app-startup-perf、maxSessions 装配归 session-limit-config，session-latency 若需改动由调度串行裁定；mobile/src/features/sessions/views.mjs 由 session-actions（行渲染/手势/授权按钮）与 composer-ux（输入区）划界。

## 非目标
不改设备授权协议与 Hub 语义；服务端安全规则（同源、设备凭证、路由允许列表）不放宽；不接 FCM/华为推送；不做离线浏览；附件上传列后续；不新增网页控制台业务能力；APK 打包与真机安装不在本 DAG。

## 验收
npm test 与 npm run test:browser 全绿；每节点独立审阅 P0–P2 清零；integration-verify 组合场景全过（多控制台切换×通知三类×关闭写路由×乐观上屏×上限 6 并发×App 设计授权全流程×打断带文本 steer×产物列表与网页一致）；smoke-emulator 产出截图/计时证据（无模拟器环境明确报「未执行」不判过；响应体验计时：发送→响应态出现与流式首帧延迟）。

## 子 Issue 清单（Epic + 每节点 1 子 Issue）
1. console-hub：多控制台（首屏列表+设置页切换）+ 断联重连修复。依赖：无。
2. session-actions：左滑关闭 + 设计授权双按钮（放行落盘/确认执行范围）。依赖：无。
3. composer-ux：输入区工具行 + 乐观上屏 + 即时响应态 + 自适应轮询流式对齐网页。依赖：无。
4. tab-swipe-fix：6 tab 真机滑动切换。依赖：无。
5. collapsible-expand：折叠卡片可再展开。依赖：无。
6. notify-events：session-reply 通知事件源 + 原生通知真机修复（三类生效）。依赖：无。
7. session-latency：普通会话真·服务端延迟定位与修复。依赖：无。
8. session-limit-config：maxSessions 可配，默认 6 上限 12。依赖：无。
9. app-startup-perf：首屏提速（hash 缓存+懒加载）。依赖：无。
10. session-steer：打断分支支持带文本真 steer（ACP/Hub 两路）。依赖：无。
11. artifacts-sync：产物页 hooks 接线 + 移动端产物列表路由。依赖：无。
12. integration-verify：合并后跨模块集成验证。依赖：1–11 全部。
13. smoke-emulator：模拟器全链路 smoke。依赖：integration-verify。
