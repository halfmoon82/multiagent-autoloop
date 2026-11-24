# NoMoTo fix2 设计稿（设计稿门基线，2026-11-24 调度会话产出，待主人确认）

## 这份文件是什么
控制台今天启用的「设计稿门」要求：涉及界面的开发任务，开工前必须有一份冻结的设计基线（本文件 + 机器可读清单 + 截图比对脚本），开发完成後由比对器按本稿逐项验收。本稿把 PRD v4（docs/2026-11-24-nomoto-app-fix2.md，今日已确认）里 8 项真机反馈对应的界面决策落成 10 个「界面」（surface）：每个界面列清状态、交互与验收口径。**你在本会话回复「确认」即视为设计批准**，批准后我会写入批准记录并冻结，之后任何偏离本稿的实现都会被比对器拦下。

## 全局口径
- 视觉语言沿用 2026-11-17 设计评审（DESIGN_REVIEW.md）：卡片式列表、底部六栏导航、主色与字号不变；本批不新造视觉风格。
- 视口：390x844（竖屏）与 844x390（横屏），两视口均不得页面级横向溢出。
- 所有报错就地呈现（不跳页、不清空已输入/已勾选内容）；凭证读写失败一律 fail-closed 回到安全入口。
- 每个界面的每个状态在两个视口各留一张截图证据；每个交互有一条可自动判定的检查。

## 界面 1：console-picker 首屏控制台选择（归属节点 console-hub）
- 现状背景：首屏=生物识别后直连单个中台，地址打包烧死。新设计：解锁一次 → 已存控制台卡片列表 + 「添加新控制台」。
- 状态：**unbound**（首启未绑定：引导文案 + 添加入口）；**bound**（已绑定：卡片含名称/地址/连通指示，当前使用的有标记）；**add-error**（地址非法或不可达：就地红色报错，不写入列表）。
- 交互与验收：**select-console** 点选即切换、重建连接、免重复生物识别；**add-console** 地址或扫码绑定成功後卡片入列且选中；**add-error-show** 非法/不可达就地报错且列表不变。SecureStorage 按 <host>:device-token 分 key，两台控制台数据隔离。

## 界面 2：settings-console 设置页当前控制台区块（归属 console-hub）
- 设置页新增「当前控制台」区块，与首屏同一数据源、同一切换逻辑。
- 状态：**normal**（列出已存控制台，标明当前）；**empty**（未绑定：引导添加）。
- 交互：**switch-console** 与首屏行为一致；**remove-console** 移除需二次确认，移除当前使用的中台后回到首屏选择；**add-console** 同界面 1。

## 界面 3：reconnect 断联重连（归属 console-hub）
- 现状背景：断联後必须杀进程才恢复。新设计：存活期内自动重连。
- 状态：**online**（正常）；**reconnecting**（断网/中台不可达：指数退避自动重试，停留原页保留输入）；**offline-persistent**（持续连不上：进入带重试按钮的重连页）。
- 交互：**auto-retry** 退避重试自动发生；**foreground-probe** 切回前台立即探测；**manual-retry** 重连页按钮立即重试；**resume-page** 恢复后回到原使用页面（不停留错误页）。

## 界面 4：sessions-list 会话列表行操作（归属节点 session-actions）
- 现状背景：列表无关闭入口；设计会话卡片缺网页版两颗授权按钮。
- 状态：**normal**；**empty**（明确空态）；**swipe-revealed**（左滑露出「关闭」，滑动中不触发点按）；**design-pending**（设计会话卡片：标题 + 双按钮「确认计划·放行落盘」「确认执行范围 →」，前者仅未放行时显示）；**close-confirm**（二次确认框）。
- 交互：**swipe-close** 滑出关闭；**close-confirm** 确认后该行消失并即时刷新，失败保留原状并提示；**approve-plan** 点放行按钮提交成功後按钮态更新；**open-scope** 点执行范围进界面 5。

## 界面 5：design-authorize 设计授权展示页（归属 session-actions）
- App 内打开展示页：拉取执行范围、PRD、DAG 逐条出示。
- 状态：**loading**；**ready**（逐条列出执行范围/PRD/DAG，含收益与代价）；**checked**（全部勾选「已读」后可提交）；**submit-error**（提交失败就地报错，保留勾选）。
- 交互：**check-item** 逐项勾选；**submit-confirm** 未全部勾选不可提交；提交由服务端校验计划指纹，无权限 403。

## 界面 6：session-composer 会话输入与响应体验（归属节点 composer-ux）
- 现状背景：加号/语音/发送布局错误、行高漂移；发送后无反馈；5 秒死轮询无流式。对齐网页版体验。
- 状态：**idle**（输入区工具行 + 自适应行高）；**optimistic-sent**（发送中本地立即上屏，可重试不丢输入、不重发入账）；**responding**（即时「Agent 正在响应」态，不等轮询）；**streaming**（流式输出中，按帧合流渲染）；**input-expanded**（多行输入行高正确扩展，不遮挡列表）。
- 交互：**send-message** 发送即乐观上屏；**input-autogrow** 输入增长行高正确扩展；**stream-render** 流式合帧与网页「正在输出…」等效；**page-hidden-pause** 页面隐藏停轮询（后台交给通知）。

## 界面 7：collapsible-cards 折叠卡片（归属节点 collapsible-expand）
- 现状背景：折後无法再展开。新设计：折叠/展开双向可用。
- 状态：**expanded**；**collapsed**。
- 交互：**collapse-card** 折叠收起内容保留标题；**expand-card** 再点展开恢复原内容。

## 界面 8：session-limit-display 会话上限展示（归属节点 session-limit-config）
- 会话全局上限可配：默认 6、上限 12；控制台管理界面如实展示当前值与来源。
- 状态：**normal**（显示当前上限与默认值）；**missing**（未配置：显示默认 6）；**fallback-warn**（配置非法/越界：回退 6 并显示告警）。
- 交互：纯展示，无交互检查。

## 界面 9：app-startup 首屏加载（归属节点 app-startup-perf）
- 内容 hash 静态资产长缓存 + 非首屏页面懒加载；入口文档维持 no-store。
- 状态：**loading**（首屏骨架，懒加载区块占位）；**ready**（可交互）。
- 交互：无交互检查；验收走计时对比（同环境优化前 vs 後，有改善才算过）。

## 界面 10：artifacts-page 产物页（归属节点 artifacts-sync）
- 现状背景：产物页恒为空（数据源未接线）。新设计：按会话分组，与网页版同一数据。
- 状态：**populated**（按会话分组列出产物）；**empty**（明确空态，不编造）；**group-error**（单会话读取失败：该分组就地重试按钮）。
- 交互：**open-artifact** 打开/下载产物；**retry-group** 失败分组就地重试。

## 冻结与比对机制（怎么保证照稿施工）
- 机器可读清单：docs/design/2026-11-24-nomoto-fix2-baseline/design-manifest.json（10 界面、引用稿、两套比对脚本路径，内容哈希锁定）。
- 批准记录：你确认後写入 design-approval.json（批准日期 + 依据=本文件与 PRD v4），哈希与清单绑定，之後改动任何一份都需重新批准。
- 比对脚本：主脚本按上面每个交互出具自动检查（浏览器渲染 App 页面逐项判定），备用脚本在主脚本失效时保底采集证据；开工前会在当前代码上自检通过，开发完成後对每节点出截图证据与判定结果。
- 计划接线：7 个界面节点各持本稿对应界面的验收合同（contract.design），每个界面的每个维度恰好归属一个节点，无重复无遗漏。

## 可视化设计稿（HTML，已放入本会话产物）
10 个界面每个一张 HTML 设计稿（390px 宽，含各状态分区），在控制台本会话「产物」页可直接打开预览，文件在 work/fix2-design/ 下（与基线目录 docs/design/2026-11-24-nomoto-fix2-baseline/refs/ 同字节，提交时一并入库）：
console-picker / settings-console / reconnect / sessions-list / design-authorize / session-composer / collapsible-cards / session-limit-display / app-startup / artifacts-page（文件名即界面名，.html）。

## 你需要确认什么
1. 上述 10 个界面的状态与交互口径就是你要的（尤其界面 1/4/5/6 的新交互：多控制台、左滑关闭、授权双按钮、响应体验）。
2. 批准方式：在本会话回复「确认」即视为设计批准（批准记录将注明：2026-11-24 调度会话内确认，依据本文件 + PRD v4）。
3. 确认後的后续（不用你盯）：我冻结基线 → 写比对脚本 → 提交合并 → 归位控制台 → 你只需在「项目任务进度」对 fix2 计划点「确认执行范围」开工。
