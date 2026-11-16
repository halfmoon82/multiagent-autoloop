# Autoloop 并行 DAG 计划第十轮独立复审报告

复审对象：`docs/2026-11-16-parallel-dag-design.md`（R10，80 行）
方式：只读。核实来源：
- 本机 Autoloop Hub v1.8.1 安装目录（下文简称 HUB/）
- 前九轮已核实的 codex-acp 2.6.0、vibe 5.2.7、git 2.50.1 证据

本轮没有阻塞，复审完整执行。

结论：第九轮唯一剩余的 P2-M 已闭合，前九轮发现没有反弹，修订也没有引入新的 P0-P2。**P0-P2 清零。** 剩下的都是 P3 建议和未核实项，不阻塞进入下一道门（提交 GitHub、设计稿门）。

---

## 一、第九轮发现闭合核对

| 编号 | 结论 | 闭合依据 |
| --- | --- | --- |
| P2-M 受控释放与 unknown 互相矛盾 | 闭合 | plan.md:67 按状态分别处理：<br>• run 是 queued，或是 claimed 且 worker 在线，一律拒绝；<br>• 只有 run 是 unknown，或是 claimed 但 worker 离线，持续超过 24 小时，并且 body 带有进程组核实依据时，才允许释放。<br>释放时服务端写审计命令文件，由控制器把这个 Hub run 标为 abandoned，之后晚到的回执一律作废。<br>这与 Hub 的语义一致：<br>• queued 可以直接取消（HUB/kernel/decide.ts:731-733）；<br>• 在线 worker 上的 claimed 可以通过 cancel_at 停掉（decide.ts:734，query.ts:183-187）；<br>• 只有 unknown 和离线 worker 上的 claimed 无法通过 Hub 回收（decide.ts:276-282、728-735），这两种正是需要人工兜底的情况。<br>abandoned 的标记由控制器写入，经命令文件交接，保持 run.json 只有一个写者（59 行）。<br>51 行增加执行前复查：run 已恢复为 claimed 或已交回结果时，放弃释放。<br>77 行补了三项测试：unknown 超过 24 小时且有依据时可以释放，恢复名额，abandoned 的回执作废；unknown 未满 24 小时、queued、在线 claimed 一律拒绝；执行前发现 run 恢复就放弃释放 |

第九轮 P3 的采纳情况：
- P3-1 已采纳：46、51、67 行把槽位动作改名为 `slot-release`，与 5、67 行永远排除的发布动作 `release` 区分开；77 行增加测试“快照永不出现 deploy/release 发布动作”。少量旧名称残留，见本轮 P3-1。
- P3-2 已采纳：67 行沿用 Host/Origin、`x-console-request`、JSON 内容类型和路由白名单校验，slot 只接受 1-5。
- P3-3 已采纳：51 行增加执行前复查。另有一个时间窗口，见 P3-2。
- P3-4 已采纳：51 行的清理清单在项目接入时经用户确认。
- P3-5 没有单独写入（gate 卡片说明 WIP 保留期），不影响结论，保留为本轮 P3-4。

## 二、前九轮发现回归核对
- 1-50 行与 R9 相比只有 46 行把动作名 `release` 改为 `slot-release`，授权事实源、关闭 PR 白名单（5-6 行）、Plan Mode 与 read-only、vibe 适配器、事件隔离、控制器互斥、槽位沙箱隔离、publish 的 parallel=1 与幂等，都保持不变。
- 47 行的临时索引 WIP 核验、refs 命名规范、机器身份（第八轮 P3）保持不变。
- 60 行的 quarantine 名额计数、旧 PR 替代、unknown 不可取消，以及 attempts=3 不重复计数，保持不变。
- 第一轮到第九轮的所有已闭合项都没有反弹。

---

## 三、剩余 P0-P2

**P0-P2 清零。**

---

## 四、P3（建议）
1. **名称残留**：60 行还写着“才允许 release 隔离槽位”，77 行还写着“取消/gate 后 release 恢复 5 槽位”“claimed/queued 未终态时 release 必须等待”。建议统一改成 `slot-release`，避免实现时又把它和被排除的发布动作 release 混为一谈。
2. **复查与执行之间的时间窗口**：51 行的复查由控制器在派发前执行，而 slot-release 是 publish 组中的一个排队动作，可能在复查后几分钟才真正运行。建议 publish 在开始执行 slot-release 时再查一次 `GET /v1/events/<id>`，放弃条件和控制器一致。
3. **“worker 离线”的判定来源**：Hub 在 worker 超过 `WORKER_FRESH`（2 分钟）没来时，把它视为不在线（HUB/kernel/decide.ts:276-282、HUB/kernel/due.ts:8），并在 `OFFLINE_AFTER` 后生成“接单程序没连上”卡片。我没有找到一个让 owner 直接读取 worker 最近在线时间的接口。建议写明控制台按什么判断“离线且持续超过 24 小时”，例如以那张离线卡片的创建时间为准，或者用 `/v1/state` 里的对应字段，并补一条测试。
4. **离线 worker 上 claimed run 的 Hub 名额**：abandoned 只是控制器层面的标记。Hub 仍把这个 run 当作 claimed，计入业务组的 groupLimit（decide.ts:318）。worker 回来之前，Hub 实际只能派 4 路，而控制器会认为名额已经恢复，于是多派出的那个 run 会停在 queued。专用 worker 只有一台时，worker 离线本来就意味着全部暂停，所以影响很小。建议释放前对这个 run 调用一次 `POST /v1/runs/:id/cancel`，留下 cancel_at，worker 回来后会立即停掉它；并在控制台说明，worker 恢复前实际并发可能低于控制器的计数。
5. **67 行的措辞有歧义**：“只有 run 为 unknown，或 claimed 但 worker 离线且持续超过 24 小时”可以读成 24 小时只约束后一种情况。51 行和 77 行都写明 unknown 也要超过 24 小时，建议 67 行改写为“（unknown 或 worker 离线的 claimed）且持续超过 24 小时”。
6. gate 卡片中写明 refs/dag-wip 的保留期（30 天）和找回方法，避免用户的半成品在不知情时被清理（沿用第九轮 P3-5）。

## 五、未核实项
- unknown run 在 worker 重启后能否重新接上（变回 claimed）：没有读完 worker 的恢复路径。51 行的执行前复查已覆盖这种情况，不影响结论。
- “worker 离线且持续超过 24 小时”在 Hub 现有接口上如何读取：没有找到直接暴露 worker 最近在线时间的 owner 接口（见 P3-3）。
- Codex workspace-write 在槽位 cwd 下写兄弟槽位会被拒绝、临时索引核验命令在真实仓库中的行为：受限于只能写两个指定文件，没有实测，计划 77 行已列为必测项，实现阶段先跑 RED。
- 用户级 MCP 禁用后工具列表是否为空、Plan Mode 与 read-only 叠加后的输出、目标项目的能力记录、专用 worker 的部署和凭据：沿用前几轮的未核实状态，由实现阶段的测试和独立试点验证。

## 结论
**P0-P2 清零。** 第一轮到第十轮的全部 P0-P2 发现都已闭合，没有反弹。剩下 6 条 P3 建议，其中 P3-1（名称残留）和 P3-3（离线判定来源）建议在提交计划文档前顺手修正。未核实项都已在计划的测试清单或试点清单中有对应的验证安排。计划可以进入下一道门：提交 GitHub 和设计稿门。
