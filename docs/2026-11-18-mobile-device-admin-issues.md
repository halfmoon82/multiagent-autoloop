# Issues：移动端 App 与网页设备授权管理后台（DAG 版）

- 状态：Approved for dispatch / 待实现
- 日期：2026-11-18
- 上游 Spec：`docs/2026-11-18-mobile-device-admin-spec.md`
- 上游 PRD：`docs/2026-11-18-mobile-device-admin-prd.md`
- DAG 计划：`docs/dag-plans/2026-11-18-mobile-device-admin.json`
- 设计稿基线：`docs/design/2026-11-17-mobile-app/`
- 拆分原则：每个 Issue 独立 worktree/分支、独立 PR、独立 reviewer；P0–P2 清零且验证绿后合并。
- **设计会话最终交付门禁**：必须提交本 DAG 文档与 JSON 计划；调度会话不得把 DAG 简化成线性序列。

## 0. DAG 总览

```text
device-binding
  └─ mobile-shell
       └─ mobile-core
            ├─ notifications
            │    └─ device-sync
            └─ project-filter
                 ├─ dag-ring
                 └─ sessions
                      └─ voice-input
                           └─ question-group
                                └─ artifacts
                                     └─ font-touch
                                          └─ final-acceptance
```

### 并行波次

| Wave | 可并行节点 |
|---|---|
| 1 | `device-binding` |
| 2 | `mobile-shell` |
| 3 | `mobile-core` |
| 4 | `notifications`、`project-filter` |
| 5 | `device-sync`、`dag-ring`、`sessions` |
| 6 | `voice-input` |
| 7 | `question-group` |
| 8 | `artifacts` |
| 9 | `font-touch` |
| 10 | `final-acceptance` |

### 依赖表

| 节点 | 依赖 | 说明 |
|---|---|---|
| `device-binding` | 无 | 网页管理后台与授权基础，可立即开工 |
| `mobile-shell` | `device-binding` | 需要绑定二维码与授权状态 |
| `mobile-core` | `mobile-shell` | 需要移动端壳与安全连接 |
| `notifications` | `mobile-core` | 需要核心页面承载通知定位 |
| `project-filter` | `mobile-core` | 需要核心页面承载全局筛选 |
| `device-sync` | `notifications` | 需要通知与提交路径 |
| `dag-ring` | `project-filter` | 需要项目筛选后的 DAG 数据 |
| `sessions` | `project-filter` | 需要项目筛选后的会话数据 |
| `voice-input` | `sessions` | 需要会话输入框 |
| `question-group` | `sessions`、`voice-input` | 需要会话与语音输入 |
| `artifacts` | `question-group` | 需要会话上下文与产物定位 |
| `font-touch` | `artifacts` | 需要全部核心页面完成后统一打磨 |
| `final-acceptance` | `dag-ring`、`font-touch`、`device-sync` | 汇总验收与真机 smoke |

## Issue 2：设备绑定与网页管理后台

- DAG 节点：`device-binding`
- 依赖：无

### Scope

- 网页控制台新增设备授权管理页面。
- 生成一次性二维码。
- 显示设备名称、系统、最近活跃时间、当前状态。
- 支持多设备同时绑定。
- 仅网页管理后台可解除任意设备授权。
- 记录绑定、解除、重命名等审计事件。

### Acceptance

- 绑定、查看、解除授权与审计全链路可用。
- 解除后设备立即失去访问与通知资格。
- 移动端不能解除其他设备。
- 管理页面不暴露密钥或设备凭证。

## Issue 1：移动端 App 壳、Android APK 与安全连接

- DAG 节点：`mobile-shell`
- 依赖：`device-binding`

### Scope

- 新建独立移动端前端工程，建议放在 `mobile/`。
- 接入现有后端 API。
- 实现安全连接、断线重连与错误提示。
- 实现打开 App 的系统生物识别。
- 交付可安装 Android APK，兼容当前旧版鸿蒙设备。

### Acceptance

- App 可在任意移动网络或外部 Wi-Fi 下连接现有后端。
- 断线后可重连，错误提示可读。
- 打开 App 需系统生物识别，验证失败有明确路径。
- Android APK 可安装并启动。
- 不把密钥或设备凭证写入前端。

## Issue 4：移动端核心页面

- DAG 节点：`mobile-core`
- 依赖：`mobile-shell`

### Scope

- 实现总览、调度规则、执行轮次、待我处理与执行授权页面。
- 总览显示运行、重试、完成、待办、项目 DAG 进度与最近动态。
- 待我处理支持选项、文字与语音回答。
- 执行授权支持范围确认与安全边界。

### Acceptance

- 各核心页面可用且与后端状态一致。
- 待办可提交，执行授权可确认。
- 数据缺失时有明确空态。

## Issue 3：系统通知与锁屏直复

- DAG 节点：`notifications`
- 依赖：`mobile-core`

### Scope

- 待我处理事项与节点成功完成各生成独立系统通知。
- 支持通知点击进入 App 定位对应事项。
- 支持锁屏直接选择或文字回复。
- 锁屏直复需系统生物识别。
- 处理已失效或已处理事项时不重复提交。
- 通知与 App 内状态同步。
- App 图标角标数量与待我处理数量一致。

### Acceptance

- 每项待办和每个节点完成通知独立触发。
- 锁屏直复可用且需生物识别。
- 已处理或失效事项不重复提交。
- 通知与 App 内状态一致。
- 图标角标数量正确。

## Issue 5：全局项目筛选与主导航

- DAG 节点：`project-filter`
- 依赖：`mobile-core`

### Scope

- 项目作为全局一级筛选。
- 总览、规则、会话、轮次、待办、DAG 与产物均显示当前项目。
- 支持切换“全部／具体项目”。
- 切换后所有 Tab 同步过滤。
- 项目筛选不改变会话内上下文。

### Acceptance

- 全局项目筛选在所有主要 Tab 可见。
- 切换后各页面内容正确过滤。
- 会话内上下文不受筛选影响。
- 切换项目后返回会话，原会话所属项目保持正确。

## Issue 6：项目 DAG 环形图与节点详情

- DAG 节点：`dag-ring`
- 依赖：`project-filter`

### Scope

- 使用环形进度图展示项目 DAG。
- 环形分段表示节点，颜色对应波次，深浅表示状态。
- 中心显示总进度。
- 配套波次节点、槽位、分支、执行 Agent、模型、费用／Token、证据、合并提交与下游启动状态。
- 点击节点查看契约、输入、输出、异常行为与验收示例。

### Acceptance

- 环形图与现有基线一一对应。
- 节点详情信息完整。
- 不用串行链条表示项目进度。
- 数据来自现有 DAG 服务，不在移动端复制或推断状态。

## Issue 7：会话列表、新建会话与已归档会话

- DAG 节点：`sessions`
- 依赖：`project-filter`

### Scope

- 类型筛选、搜索、当前会话。
- 新建会话入口，支持语义分类推荐与手动切换会话类型。
- 已归档与历史默认折叠。
- 展开后显示数量、项目、转录条数与停止原因。
- “查看”进入只读转录。
- “继续调度”创建新会话并注入最近 10 轮转录。

### Acceptance

- 新建会话可用，首轮输入可进入对应会话。
- 已归档会话可见、可只读查看、可恢复。
- 原记录保留。
- 恢复后新会话可继续对话。

## Issue 10：语音输入

- DAG 节点：`voice-input`
- 依赖：`sessions`

### Scope

- 覆盖所有会话输入框。
- 点击麦克风开始说话，实时转为可编辑文字。
- 可手动修改、追加语音或撤销。
- 不因停顿自动发送。
- 未授权、识别失败或无网络时可直接使用键盘。

### Acceptance

- 语音输入状态机完整。
- 不自动发送。
- 失败或无权限时可回退键盘。

## Issue 8：会话内待回答组

- DAG 节点：`question-group`
- 依赖：`sessions`、`voice-input`

### Scope

- Agent 连续提出多个问题时，以“待回答组”嵌入会话。
- 保留原话与背景。
- 显示总数、已答数和进度轨。
- 每次聚焦一道题，已答题折叠保留，可展开回看。
- 支持选项、文字与语音输入。
- 提交后进入下一未答题。
- 未答数量在会话顶部持续可见。
- 浏览产物、切换会话、旋转或折叠后，未答进度、草稿与滚动位置不丢失。

### Acceptance

- 多问题待回答组可用。
- 已答与未答状态清晰。
- 上下文、草稿与滚动位置不丢失。

## Issue 9：产物双入口与会话内产物

- DAG 节点：`artifacts`
- 依赖：`question-group`

### Scope

- 全局产物管理页。
- 会话流内“本会话产物”入口。
- 显示所属会话、当前任务与路径。
- 手机全屏列表与阅读；折叠屏左侧列表、右侧阅读。
- 返回会话时恢复草稿、滚动位置与待回答进度。

### Acceptance

- 产物可从全局和会话内两个入口打开。
- 返回会话后状态不丢。
- 产物只读，不在移动端改写目标项目。

## Issue 11：系统字体与触控热区

- DAG 节点：`font-touch`
- 依赖：`artifacts`

### Scope

- 字体大小跟随手机系统设置。
- 使用原生字体度量。
- 放大后采用换行、容器增高和纵向滚动。
- 不截断、不遮挡、不强制横向滚动。
- 图标视觉轻巧，交互热区扩展至约 44–48 dp。
- 整卡选项有按压、选中和禁用状态。
- 适配安全区、系统返回、键盘升降、横竖屏与折叠／展开连续性。

### Acceptance

- 系统字体 160% 时无截断、遮挡或横向溢出。
- 触控热区与状态可测试。
- 折叠屏状态连续性有回归。

## Issue 12：多设备状态同步与审计完善

- DAG 节点：`device-sync`
- 依赖：`notifications`

### Scope

- 多设备同时绑定。
- 任意一台提交后其他设备同步状态。
- 设备丢失时可在网页管理后台解除授权，不影响其他设备。
- 完善绑定、解除与通知审计记录。

### Acceptance

- 多设备同步状态一致。
- 解除授权立即生效。
- 审计记录完整且不泄露敏感数据。

## Issue 13：综合验收与真机 smoke

- DAG 节点：`final-acceptance`
- 依赖：`dag-ring`、`font-touch`、`device-sync`

### Scope

- 汇总移动端核心能力、设备授权、通知、语音、字体与折叠屏。
- 执行真机 smoke：设备绑定、通知、锁屏直复、语音、字体放大。
- 执行 Android APK 安装与启动验证。
- 核对设计稿与 PRD 验收标准。

### Acceptance

- PRD 的成功标准全部满足。
- Android APK 在当前旧版鸿蒙设备安装并启动成功。
- 真机 smoke 通过，且未覆盖项明确披露。
- 不自动触发部署或生产变更。

## 统一验证基线

- 每个 Issue 至少运行 `npm test`。
- 涉及 UI/交互时运行 `npm run test:browser`。
- Android 打包与真机 smoke 需单独授权，不由 CI 自动触发。
- 所有 Issue 使用独立 worktree/分支，交付前独立 review，P0–P2 清零后 squash 合并。

## 设计会话最终交付门禁

1. 必须提交 `docs/2026-11-18-mobile-device-admin-issues.md` 与 `docs/dag-plans/2026-11-18-mobile-device-admin.json`。
2. DAG 依赖不得被调度会话简化为线性序列。
3. 任何依赖调整必须回写 JSON 与 Markdown，并重新确认。
4. `final-acceptance` 只能依赖图中声明的节点，不得隐式依赖未列节点。
5. 派发提示必须明确“按 DAG 并行推进”，不得使用“按 Issue 顺序推进”。
