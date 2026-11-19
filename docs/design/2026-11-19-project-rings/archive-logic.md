# 归档逻辑与底部归档区（设计确认稿）

- 日期：2026-11-19
- 状态：**待产品经理确认**
- 边界：本文只定义**归档判定**与**底部归档区**。环的视觉/布局由另一会话负责，本工作不修改环形绘制与环组件样式。
- 归档区原型：[archive-section.html](./archive-section.html)
- 截图：折叠 [archive-collapsed.png](./archive-collapsed.png) · 全部项目展开 [archive-open-all.png](./archive-open-all.png) · 按项目筛选 [archive-open-filtered.png](./archive-open-filtered.png) · 移动 [archive-mobile.png](./archive-mobile.png)

## 1. 术语

| 词 | 定义 |
| --- | --- |
| 任务环 | 一条**任务定义**。串行任务 = `*-serial.json` 的文件词干；DAG 任务 = `docs/dag-plans/<planId>.json` 的 `plan_id` |
| 运行 | 一次执行记录。串行 = 状态文件内容；DAG = `dag-runs/*.json` 的一条 run |
| 归档 | 任务环不再出现在主视图，只在底部「已归档的任务环」区可查 |

同一个任务跑多次仍是一个环；run 不单独成环。

## 2. 任务识别（只读）

| 来源 | 纳入 | 排除 |
| --- | --- | --- |
| 串行活动任务 | `<home>/<stem>-serial.json` | — |
| 串行已归档任务 | `<home>/<stem>-serial.json.done-YYYYMMDD` | `*.bak-*`、`*.paused-*`、`.bak-preapprove` 等备份/暂停副本 |
| DAG 任务定义 | `docs/dag-plans/*.json` 的 `plan_id` | — |
| DAG 运行 | `dag-runs/*.json`（按 `planId` 归到任务） | `*.controller.lock` |

任务标题优先级：计划文件 `title` → run 快照标题 → `planId` / 文件词干。

## 3. 环状态判定

### 3.1 串行任务

| 条件 | 状态 | 主视图 |
| --- | --- | --- |
| 所有节点 `status = done`（等价 percent = 100） | `completed` | 归档 |
| 文件为 `.done-日期` 且未 100%（中途放弃） | `abandoned` | 归档 |
| 其他（未完成、文件仍为活动名） | `active` | 显示 |

### 3.2 DAG 任务

以**最新一次运行**为准：

| 条件 | 状态 | 主视图 |
| --- | --- | --- |
| 最新 run ∈ {`queued`, `claimed`} | `active` | 显示 |
| 最新 run `done` 且该 run 全部节点 done | `completed` | 归档 |
| 最新 run ∈ {`cancelled`, `abandoned`, `blocked_unknown`} 且无进行中 run | `cancelled` | 归档 |
| 计划文件存在但从未运行 | `not_started` | 显示（0%） |
| 最新 run `done` 但节点未齐（数据不一致） | `active` | 显示，并在详情标「状态不一致」 |

说明：先前完成过、之后又新开 run 的，按最新 run 判——重跑即重新开始。

## 4. 归档字段

`{ taskId, kind: serial|dag, project, title, percent, nodes: {done,total}, reason: completed|cancelled|abandoned, archivedAt, link }`

- `archivedAt`：串行取文件名里的 `YYYYMMDD`；DAG 取最新终态 run 的 `finishedAt || updatedAt`。
- 排序：项目内按 `archivedAt` 倒序。
- 归档区标题计数：`已归档的任务环 N`，副标题 `全部完成 x · 已取消 y`（`abandoned` 并入已取消）。

## 5. 与项目级筛选的一致性

- 顶部 `#project-filter` 是唯一筛选源，主视图与归档区共用同一选中值。
- 选中某项目：归档区只列该项目条目，且不再显示项目分组小标题。
- `全部项目`：归档区按项目分组，项目标题用短名。
- 选中项目若没有归档：归档区显示「该项目还没有已归档的任务环」，不隐藏区块（避免用户以为筛选失效）。
- 筛选不得改变归档判定，只改变可见范围。

## 6. 边界条件

1. 备份副本不重复计入（`.bak-*`、`.paused-*`）。
2. 同一任务只有一个归档条目；任务重新激活（新 run / 取消归档）后从归档区移除。
3. 计划文件被删除但仍有 run：仍按 `planId` 成环，标题回退到 `planId`。
4. 节点数为 0 的任务：不归档、不显示（视为无效定义），并在日志记一条。
5. 归档区数据只读，不写任何状态文件。

## 7. 测试清单（实现时先写红）

1. 串行 100% + `.done` → `completed` 归档。
2. 串行 70% + `.done` → `abandoned` 归档。
3. 串行 77.9% 活动文件 → `active` 不归档。
4. DAG 全部 run 取消 → `cancelled` 归档。
5. DAG 有一次 `queued` + 早期 run 取消 → `active`。
6. DAG 最新 run done 且节点齐 → `completed`。
7. `.bak-*` / `.paused-*` 不计入。
8. 项目筛选：`auto调度` 只返回 2 条；`health-service-core` 只返回 1 条；空项目返回空数组 + 空态文案。
9. 全部归档的项目：主视图不出现，归档区仍可见。
10. 归档计数与副标题数字一致。

## 8. 现状回归（用真实数据核对）

| 任务 | 期望 |
| --- | --- |
| dag-serial（auto调度，7/7） | 归档 · 全部完成 · 2026-11-18 |
| console-hub-native-and-card-routing（0/6，全部取消） | 归档 · 已取消 · 2026-11-18 |
| phase1-serial（health-service-core，8/8） | 归档 · 全部完成 · 2026-11-17 |
| v6-serial（vibeguide，11/11） | 归档 · 全部完成 · 2026-11-17 |
| mtexec-serial（health-service-core，77.9%） | 进行中，不归档 |
| 2026-11-18-mobile-device-admin（有进行中 run） | 进行中，不归档 |

## 9. 验收

- `npm test`、`npm run test:browser` 全绿；
- 归档区在桌面 1440 / 移动 390 无横向溢出；
- 筛选切换后归档条目与计数同步变化；
- 主视图不出现任何 100%/已取消的环。
