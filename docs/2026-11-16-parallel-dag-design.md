# Autoloop 并行 DAG 事件链与设计会话改造计划（R10）

## 已确认决策与唯一授权事实源
- 规划复用 vibe CLI 的 S0/S1、PRD/Spec 校验和 DAG 生成；不调用 vibe authorize/monitor/daemon/supervisor。vibe 自动生成的授权卡仅视为规划副产物，**不作为任何执行授权依据**，其 remote_git_actions=deny 与 pending_authorization 状态不阻塞本链，也不被用于证明授权。
- 唯一执行授权事实源是控制台“PRD/Spec + DAG + 执行范围”确认。确认页必须逐项展示：目标项目/仓库、节点及文件范围、最多 5 路、允许动作（独立 worktree、测试、推送目标仓库分支、创建 PR、独立审阅、P0–P2 返工、按既定 squash 策略合并、关闭被新 attempt 替代且由本 DAG 创建的 PR并附替代说明）、明确排除动作（deploy/release/生产写入/凭据/对外通信）。
- 服务端将上述授权动作、目标仓库、合并策略与 planDigest 一起写入 run.json 的 authorizationSnapshot。控制器只执行快照内动作；未确认推送/PR/合并时不得派发对应动作。publish 只能关闭 run.json 中登记且属于同一 runId/nodeId 的 PR，其他 PR 一律拒绝。设计稿门增加“确认授权范围”页面。
- 每项目最多一个设计会话和一个活跃 DAG；普通调度会话与设计会话按 (project,kind) 查重，可各存在一个。全局 maxSessions 仍生效。
- 只建新链，不改 V6/MT/执行波等旧链、旧规则和旧 serial 文件；不改上游 Hub 内核。

## 前置门
1. Claude Opus 5.5 只读审阅本计划，主 Agent 核实并修订，同会话复审至 P0–P2 清零；再在 feat/<topic> 提交 docs/2026-11-16-parallel-dag-design.md、推送 GitHub、开 PR，按仓库流程独立 Review 和 squash 合并。计划合入不等于运行切换。
2. 设计稿门：控制台总览、设计会话、DAG 详情、项目接入预检、执行授权范围确认五类页面；本地 HTML/CSS + PNG，桌面 1440×900、移动 390×844，附交互与空/加载/失败/阻塞状态。用户明确确认后才写任何实现代码；稿子变更重新确认。

### 可选设计基线与定向执行门（2026-11-17 精简审阅后）
- 只有包含 `contract.design.surfaceIds` 的 UI 节点才加载 `design-manifest.json` 与批准记录；纯后端节点和旧数组计划无需新增字段，也不读取设计设施。设计批准只绑定 `designDigest`，不绑定 PRD 全文；只有设计语义或产物变化才重新确认。
- `designDigest` 纳入现有 `planDigest`，根 run 保存一份不可变快照，节点 run/attempt 原样继承。活跃 run 不读取当前工作目录的新稿；新稿只用于新 run，用户显式修改活跃计划范围时才修订并重新确认。
- 发布时做一次设计确认，执行时做一次定向设计验证。preview/create/dispatch/review/merge 只做廉价一致性检查；merge 不重跑浏览器。controller 在槽位分配、prepare、claim 前按节点校验快照，单节点失败不影响其他 ready 节点。
- `createDagRuntime` 默认从精确 commit 建临时只读 worktree，校验已批准 `design-manifest.verifierPath` 的 sha256 后，在净化子进程执行无模型 verifier；只验证该节点声明的 surface/viewport/state/interaction，并把证据写入服务端 `dag-runs/design-evidence/`。结果走专用 fd 与一次性 nonce，stdout/stderr 仅作有上限日志，不可伪造结果。`checks` 是硬断言；PNG 与 `visualDiffs` 默认仅为审阅证据。runner/证据设施故障自动重试，不计 worker 实现失败。
- 证据绑定 `commit/designDigest/contractDigest`。同 SHA 证据丢失时自动补验并重新独立 review；只有实际设计语义改变才以 `DESIGN_CHANGE_REQUIRED` 升级。worker 不得修改基线、参考图、批准记录或验证阈值。控制器侧 Git 显式禁用 hooks 且不继承控制器环境；`npm test` 使用净化环境。`prepare` 冻结实际 base commit SHA，`commitPr` 的已提交/未提交 scope 均相对该 SHA 核对，不信任 worker 可移动的 `origin/main`。
- 共享 surface 的跨节点回归只复用现有 integration-review，且只阻塞 DAG 最终完成与对应返工节点；不新增 Hub 协议或第二套状态机。

## 原生 Codex Plan Mode + 只读沙箱
- kind=design 使用现有 ACP 底座；普通会话不变。
- 首轮顺序固定：session.new → session/set_mode {modeId:"read-only"} 并核验 → session/set_config_option {configId:"collaboration_mode",value:"plan"} 并核验 → 首个 runTurn。任一失败即创建失败，不降级。
- 续接存档会话同样在首条消息前重新设置并核验 read-only + plan。
- 服务端拒绝设计会话中以 / 开头的用户输入（至少 /plan 必须拦截），防止斜杠命令切换模式；每轮结束后读取 configOptions 核验仍为 read-only + plan，不一致将 session 置 error。
- Plan 审批/switch_mode 权限请求一律取消。Plan Mode 负责协作方式，read-only 负责机制性只读；设计会话不得直接写项目或执行 vibe 写命令。

## 服务端 vibe 规划适配器
- 固定封装 scan/plan，项目根只能来自已发现 Git 仓；清理 CODEX_THREAD_ID 等宿主环境变量，显式传 --adapter codex 与 --project-root，禁止浏览器任意命令/参数。预检读取实际安装的 vibe 版本，必须与测试夹具版本 5.2.7 一致，否则阻塞适配而非猜测契约。
- 项目预检：.vibe/state.json 缺失返回 initialization_required；只有用户点击“初始化规划环境”后才执行 vibe init --confirm。
- **服务端不执行 attest、不写能力记录。** 发布前只读校验目标项目已有 .vibe 能力记录：必须由真实 Codex 会话执行 vibe attest 留下，adapter=codex，记录不超过 72 小时、宿主大版本一致，并具备 visible/background/in_session_sdd 之一的真实派发形态。缺失/过期/宿主大版本变化返回 capability_attestation_required，并给出在真实 Codex 会话执行一次 attest 的修复路径；服务端不得编造 ACP initialize 不包含的 shell/subprocess/worktree/visible_task 等事实。
- 创建时服务端 vibe 路由；simple/light 返回评分，complex 建 draft planId 并启动 Plan Mode 会话。
- 设计会话使用专用 PRD 引导提示词，不复用 buildSchedulingPrompt 的可写/派发 worker 文案；kind=design 不挂载 Hub MCP，并读取用户配置后对每个 mcp_servers.<name> 显式设置 enabled=false；启动后必须核验工具列表无任何 MCP 工具，任何残余 MCP 权限请求一律取消。
- 设计会话以约定 JSON 块输出 product-spec；服务端从会话转录提取并计算 specDigest，浏览器只能提交 specDigest + confirm，不能直接提交可信 spec 内容。
- 确认后服务端把该转录原文写到 .vibe/plans/<planId>/product-spec.input.json，再执行 vibe plan --from-prd；vibe 产物留在目标项目 .vibe/，不进入控制台仓库。
- **publish（决策 #4）**：确认后由服务端代行落地，设计会话自身仍 read-only。服务端先校验能力记录，再在目标项目临时 worktree 中从当前基线分支建 `docs/<planId>`，提交 `docs/prd/<planId>/{product-spec,plan,nodes}.json`；若声明设计，再提交已确认设计产物与 `design-approval.json`，推送该分支并创建 PR（已有同分支 open PR 则复用，全流程幂等）。授权快照由服务端生成，只含 push-branch 与 create-pr，明确排除 merge/deploy/release/生产写入/凭据/对外通信；不直推基线分支、不 force push、不 merge。实现见 src/design-publish.mjs。
- vibe 产物中的 execution_engine=vibeguide_monitor 和授权卡均为副产物，不作为本链执行引擎或授权事实。
- planDigest 覆盖 product-spec.input.json、plan.json、nodes.json 和服务端生成的 authorizationSnapshot。创建运行时把全部节点契约快照写入 run.json；worker 从 run.json 快照和绝对证据路径获取合同。计划变化须重新确认。

## DAG 控制器、事件链与权限
- 控制器无模型；定时规则与 dag.advance 事件规则放在同一个独立 controller group，不设 parallel，Hub 保证同组一次一轮。控制器内部再加每 run 文件锁，run.json 临时文件 + rename；两个控制器同时启动只能一个推进。controller/gate 不占业务 5 路。
- 事件类型按项目隔离：dag.<projectSlug>.dev / review / publish / advance / gate。slug 只能 [a-z0-9-]，并保证最长类型不超过 Hub 64 字符，超长稳定哈希截短并保留映射。预检按 Hub 通配语义检查新旧所有规则，拒绝 *、dag.* 或前缀通配造成跨项目/跨链订阅。
- subject=<runId>:<nodeId>；遵守 Hub 字符集与 100 字节限制，超长稳定哈希截短。控制器从 Hub 结果反查节点时只使用 run.json 映射，不反向解析 subject。开发与审阅同业务 group 同 subject，保证同节点串行。业务组、controller 组名称预检不得与旧组冲突。
- 事件 id=<runId>:<nodeId>:<role>:<generation>:<attempt>，同一动作重发去重，新一代返工不丢弃。控制器通过 source API 直接发 hops=0 新事件，记录 eventId/runIds；节点只认当前 generation 对应 runId。
- 为替代绕过 MAX_HOPS 后的循环保护：maxGeneration=10，maxEvents=max(100,节点数×20)；只计 Hub 实际接受并分配 seq 的事件，重复 id 不计，超限 blocked_unknown 并 gate。
- depends_on 计算 ready；integration_after 不阻塞。写范围重叠串行；blocked 硬依赖后代暂停，无关节点继续。
- accepted=独立审阅 P0–P2 清零且 PR 已 squash 合入基线。下游 fetch 更新基线后，从合并后的基线创建独立 worktree/分支。
- 同一任务累计 3 次失败/返工必须先换打法（换模型、换 Agent、拆小任务或新 worker）并记录原因；换打法仍失败才 gate。纯工程问题不直接升级。
- vibe complex 计划 integration-review 必须存在；业务节点全 accepted 后只读整合审查，通过则 DAG 完成，不部署。

### 固定槽位与最小权限执行闭环
- 每个项目在接入时预建 5 个固定 worktree：`.worktrees/dag-slot-1..5`。每个槽位有独立 dev/review 规则，规则 cwd 就是槽位目录；5 路共用业务 group parallel=5。Codex 的可写根因此只有本槽位，不能写主 checkout 或其他槽位，隔离由沙箱而非提示词保证。
- 槽位事件类型为 `dag.<slug>.s<N>.dev` 与 `dag.<slug>.s<N>.review`，避免同类型被 5 条规则同时接收；仍满足 64 字符与通配预检。控制器把节点分配到槽位并写入 run.json，同一槽位同时只服务一个节点。
- **prepare/publish（无模型）共用 `dag.<slug>.publish` 规则，action=prepare|commit-pr|verify|merge|baseline|slot-release。该规则独占一个 group 且 parallel=1：事件 lane=subject，不同节点/动作不会并入同一 run，同时 groupLimit=1 保证共享 .git 的操作严格串行。publish subject=<runId>:<nodeId>:<action>:<generation>。所有动作幂等：已有提交不重复 commit，PR 已存在则复用，已合并且内容一致直接回报成功。prepare 不持有 GitHub 凭据，依赖安装使用 --ignore-scripts；只有 commit-pr/merge 取得既有 GitHub 凭据。
- prepare 在指定槽位 fetch 基线并切到节点分支。**脏检查只在槽位换给另一节点时执行**；同节点重试/返工允许保留改动并由 commit-pr 文件范围校验兜底。换模型/Agent 或释放槽位时，由 publish 串行使用临时索引保存完整 WIP：`GIT_INDEX_FILE=<tmp> git read-tree HEAD` → 同索引 `git add -A` → `git write-tree` → 使用固定机器身份 `git commit-tree -p HEAD -m <runId>:<nodeId>:<attempt>` → `git update-ref refs/dag-wip/<runId>/<nodeId>/<attempt>`。refs 各段只用 [a-z0-9-]，必要时稳定哈希并在 run.json 保留映射。核验 WIP tree 与临时索引一致、所有未跟踪文件已入树，且在同一临时索引下 `git diff --quiet <wip> -- .` 与 `git ls-files --others --exclude-standard` 为空后，才执行 `git restore --source=HEAD --staged --worktree :/` 和 `git clean -fd`（不加 -x），不用 reset --hard。WIP refs 在 DAG 完成后保留 30 天，再由 publish 串行清理并在预检显示占用。verify 产物只写 gitignore 的证据目录和槽位内临时目录；verify 同时记录审阅前槽位状态，merge/下一代 prepare 负责对比。
- 开发 worker 默认 Codex access=edit，只能写当前槽位、跑离线测试，不执行 git 写或联网。Claude 仅作为可选替代，使用 DAG 专用 settings，只放行声明的离线测试命令。
- commit-pr 校验本槽位文件范围后 git add 白名单、commit、push、创建 PR并回传 SHA。verify 在槽位运行声明的离线测试并回传证据。reviewer 使用独立 Agent `codex-dag-review` access=read，只读审阅同一 SHA 的 diff、PR 元数据和 verify 证据，不能改槽位也不自行运行测试；review 前后 publish 对比槽位状态，出现额外改动即 blocked_unknown。开发使用独立 Agent `codex-dag-dev` access=edit，二者只绑定 DAG 专用 worker。
- 流程：prepare → dev(edit) → commit-pr → verify → review(read) → 返工 / 清零后 merge（校验远端 PR head==已审 SHA）→ accepted。PR 在独立审阅前已创建。integration-review 由 baseline 动作准备合并后基线的 detached worktree `.worktrees/dag-baseline`，使用独立规则 cwd 与 access=read 审查该 commit，不占 5 个业务槽位。
- **slot-release**：节点 accepted、gate 后放弃或 DAG 取消时执行，但前置条件是该槽位最近一个 Hub run 已处于 done/nothing/failed/cancelled 终态（GET /v1/events/<id> 核实）。DAG 取消顺序固定：先取消所有 queued/claimed run → 等终态，超时转 quarantined → 再 slot-release。slot-release 先保存 refs/dag-wip，再还原槽位并清理项目接入时经用户确认的证据/构建/缓存目录清单（node_modules 由下一次 prepare 重装），最后释放。quarantined 槽位不得 slot-release；旧 run 超过 24 小时未终态时，由调度方在 worker 机器核实进程组，并通过受控“确认已退出”操作留痕后释放。执行前控制器再次查询事件，publish 真正执行 slot-release 前还必须再查一次 GET /v1/events/<id>：若 run 已恢复 claimed 或已交回结果，则放弃释放，避免人工确认与排队窗口竞态。对 worker 离线的 claimed run，释放前调用一次 cancel 留下 cancel_at，worker 恢复后会立即停止；控制台说明 worker 恢复前 Hub 实际并发可能低于控制器计数。
- worker/reviewer 通过 Hub 原生 agent-autoloop 回执发 `dag.<slug>.advance`；detail 携带小体积 JSON：runId/nodeId/slot/role/generation/outcome/branch/commit/tests/prUrl/evidenceRef。长证据放 PR 或槽位内证据文件，事件只存引用。控制器按 eventId 去重并迁移 run.json。
- 静态规则 prompt 明确授权读取 context events[0].detail 中的 slot、worktree、expectedAdvanceId 字段；这些值由控制器在事件 detail 给出，worker 不得从其他来源猜测。
- 测试必须离线可跑；需要联网/真实外部服务的验收拆成 external 步骤并单独授权。
- 默认新增 DAG 专用 worker，旧链原 worker 不动。capacity 至少 8（5 开发/审阅 + 1 prepare/publish + 1 controller + 1 gate）；复用原 worker 时须另证旧链峰值容量。
- 真实 rules、5 槽位、专用 worker、capacity、脚本部署、GitHub 凭据可用性和重启均在独立项目试点单独列影响并验证。

## 状态与恢复
- run.json 位于 AGENT_AUTOLOOP_HOME/dag-runs/<runId>.json；只有控制器迁移状态，控制台创建/取消通过命令文件交接。节点契约、授权快照、当前 generation、event/runId、PR/证据均在快照内。
- 按当前 generation 的 runId 判断状态；控制器定时读取 GET /v1/events/<eventId>，同时核对 run 状态及其 emitted 事件。queued/unknown 表示 Hub 在重试或租约失联观察期，控制器不重复派发；同一 run 的 attempts 达到 3 时，若仍 queued 则取消（queued 可取消）并换打法。**unknown 不可取消**：超过 15 分钟将槽位标为 quarantined，不重派到该槽位；节点可在空闲槽位以新 attempt 分支继续，quarantined 中的旧 run 在控制器自己的 5 路计数里仍占一个名额直到终态；若旧分支已有 PR，publish 关闭旧 PR并注明被新 attempt 替代，再创建新 PR并记录链接。旧 run 晚到 advance 因 attempt 不符作废。旧 run 进入终态或确认进程退出后才允许 slot-release 隔离槽位。cancelled 计一次失败（同一 run 因 attempts=3 换打法而取消时不重复计数）；run 已 done 但没有合法 advance、回执类型错误或 id 不符，也按一次失败尝试计数并重派。
- 每个 advance 的期望事件 id 由控制器写进派发提示词，回执必须逐字一致；跨 generation 复用或伪造 id 视为无效。单节点回退不影响其他节点，审阅不被其他节点全局阻塞；重复 advance 幂等，畸形/伪造 detail 或损坏状态进入 blocked_unknown。

### 阻塞解除自动恢复（2026-11-16 b7 教训入契约）
- 结构阻塞（depends_on 未满足）不是异常：readyNodes 随依赖完成天然恢复，控制器无需干预。
- run 级 blocked_unknown 是**唯一异常终态**，复活唯一通道是 `createAttempt(prevRunId, {reason})`，reason 仅接受 `blocked-resolved`（阻塞证据已消失，同打法重试）或 `change-approach`（换打法）；无原因或其他原因一律 `REVIVE_REASON_REQUIRED` 拒绝，防无依据的静默复活。
- 控制器周期复查 blocked_unknown run 的阻塞证据（进入终态的 cause、相关授权卡状态、前置节点/PR 状态）；证据消失即复活重派——**无需 gate、无需用户介入**。这是旧串行链「blocked+gateSent 贴纸无人撕、控制器每 15 分钟空转跳过」（2026-11-16 b7 事件）的根治。
- 复活计一次执行尝试（attempt+1，满 3 必须 change-approach，generation ≤10，穷尽转 gate 给用户）；授权快照逐字继承（继承无输入面可篡改；快照 digest 在加载时经 snapshotIntact 校验，不一致 fail closed），不得借复活换授权；新 run 记 revivedFrom/reviveReason，旧 run 保持终态、晚到回执作废不重复计数。
- done 的语义是「本轮回合结束」（rework 回执同样落 done），由调度方按需 createAttempt 重派，不属复活、不加原因限制（attempt 满 3 仍按 R10 需 change-approach）；abandoned 维持既有「调度方判断」口径。
- 本地 Hub 事件为首期主通道；GitHub 用于分支/PR/审阅证据，Webhook 后续可选。

## 控制台接口与展示
- POST /api/scheduling-sessions 接受 kind=design，按 (project,kind) 查重；列表/存档返回 kind、read-only+plan 状态、planId。
- POST /api/design-sessions/:id/publish 只接受 specDigest+confirm=true。
- GET /api/dag-runs；POST /api/dag-runs（project/planId/planDigest/confirmedActionIds/confirm=true；服务端按白名单生成 authorizationSnapshot 并计算摘要，永远拒绝 deploy/release/凭据/对外通信；同项目活跃 DAG 409）；GET /api/dag-runs/:id；POST /api/dag-runs/:id/cancel；POST /api/dag-runs/:id/slots/:slot/slot-release（沿用 Host/Origin、x-console-request、JSON 与路由白名单校验，slot 仅 1-5）。run 为 queued 或 claimed 且 worker 在线时一律拒绝；只有（run 为 unknown，或 claimed 但 worker 离线）且持续超过 24 小时，同时 body 含进程组核实依据时才允许。离线时长以 Hub“接单程序没连上”卡片的创建时间为准；卡片或时间证据缺失时 fail closed，不得释放。服务端写审计命令文件，控制器将该 Hub run 标为 abandoned，之后晚到回执一律作废。
- 总览新增 DAG 分组，旧四组与 serial 进度不变。预检显示实际可用并发、专用 worker 与旧链资源影响，不伪造 5 路。

## 测试（先 RED 后 GREEN）
- Plan Mode/read-only：首轮前生效；send/queue/interrupt/steer 全入口对 trim 后斜杠输入拦截；每轮通过重复 set_config_option 并读取返回 configOptions 核验；switch_mode 取消；失败不降级；续接重应用；专用提示词；无 Hub MCP 且用户级 MCP 被配置覆盖；普通会话不受影响。
- vibe：初始化预检、已有真实能力记录校验、缺失时 capability_attestation_required、服务端从不 attest、宿主环境清理、版本 mismatch 阻塞、转录 specDigest、固定路径、拒绝任意参数、v5.2.7 真实 JSON 录制假 CLI 夹具；CI 不安装 Python。
- 授权：vibe 卡片 deny 不阻塞也不构成授权；未确认远端动作时禁止 push/PR/merge；快照篡改被拒绝。
- DAG：未决决策、环/未知依赖/契约、写范围、整合审查、accepted=已合并、下游基线、5 路上限。
- 事件：双项目不串投、通配订阅冲突、大写/超长 slug、第 2 代返工可派发、超过 8 层仍完成、事件/generation 上限、subject 长度/字符、event/runId 精确匹配。
- 控制器：6 ready 先 5 后补 1；并行审阅；单节点失联；blocked 隔离；换打法后才 gate；两控制器互斥；blocked_unknown 复活需注明原因（blocked-resolved/change-approach，其他拒）、复活快照逐字继承、复活计 attempt 满 3 换打法、旧 run 晚到回执作废不重复计数、done（含 rework）维持无原因重派口径。
- 槽位与原生交付：假 worker 写主 checkout/兄弟槽位被沙箱拒绝；同节点失败后可带改动重派；换模型时 refs/dag-wip 精确保留；换节点遇脏槽位阻塞；取消/gate 后 slot-release 恢复 5 槽位且 WIP 含新文件可找回；claimed/queued 未终态时 slot-release 必须等待；1 个 quarantine + 6 ready 只派 4 个；旧 PR 仅在本链登记且快照允许时关闭，新 PR 链接写回，旧 attempt 晚到回执无效；unknown 超 24 小时且有依据可 slot-release、恢复名额、abandoned 晚到回执无效；unknown 未满 24 小时/queued/在线 claimed 均拒绝；控制器执行前发现 run 恢复则放弃释放；快照永不出现 deploy/release 发布动作；3 个 publish 事件各有独立 run，一个失败不影响其他回执且重试幂等；review(read) 不改槽位/不跑测试；远端 head 不一致拒绝 merge；queued attempts=3 取消并换打法；unknown 不可取消、只隔离槽位、旧回执作废；cancelled/无 advance/类型错误/id 复用计失败；重复回执幂等。
- 假 Hub API：(project,kind) 查重、发布确认、重复 DAG 409、取消、密钥不泄漏、旧接口不变。
- 浏览器：全部设计页面与状态、Plan Mode 标识、授权范围页、DAG 分组、旧总览、移动端、安全文本。
- npm test、npm run test:browser；CI 不调真实模型、不改真实规则。真实试点另行授权，以独立项目和假 Agent 验证 5 路，再决定真实模型 smoke。
