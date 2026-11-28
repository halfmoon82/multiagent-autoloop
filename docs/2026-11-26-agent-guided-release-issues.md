# Issues：产品化发布——Agent 引导的两阶段自助安装（DAG 版）

- 状态：已交付——2026-11-26 主人确认 product-spec；DAG 链 dagrun-mwzrsksy-411c4f80 于 2026-11-28 全部节点交付合并（PR #369/#370/#371/#372/#373/#379/#380），GitHub Epic #381 与子 Issue #382–#388 已补登并回写 PR 关闭。
- 日期：2026-11-26
- 上游 PRD：`docs/2026-11-26-agent-guided-release-prd.md`
- 上游 Spec：`docs/2026-11-26-agent-guided-release-spec.md`
- DAG 计划：`docs/dag-plans/2026-11-26-agent-guided-release.json`
- 拆分原则：每个 Issue 独立 worktree/分支、独立 PR、独立 reviewer；P0–P2 清零且验证绿后合并。
- **设计会话最终交付门禁**：必须提交本 DAG 文档与 JSON 计划；调度会话不得把 DAG 简化成线性序列。

## 0. DAG 总览

```text
wave-0（4 并行，写范围互不相交）
  doctor-cli          ─┐
  secret-write         ├─→ install-playbook ─┐
  public-host-config   │                     ├─→ release-acceptance
  release-packaging   ─┴─→ install-e2e-smoke ┘
```

## 1. Epic

- 标题：产品化发布：Agent 引导的两阶段自助安装（本地控制台 → 自有域名公网 + APK）
- 正文链接：PRD / Spec / 本文档 / `docs/dag-plans/2026-11-26-agent-guided-release.json`
- Issue 号：#381（已关闭，2026-11-28 补登）

## 2. 子 Issue 清单（一节点一 Issue）

| 节点 | 标题 | 依赖 | Issue 号 |
| --- | --- | --- | --- |
| doctor-cli | doctor-cli：doctor 自检脚本（--phase local/public，机器可读输出） | 无 | #382（已关闭） |
| secret-write | secret-write：交互式隐藏输入凭据写入（0600、不进聊天/日志/history） | 无 | #383（已关闭） |
| public-host-config | public-host-config：控制台可选 publicHost 放行公网域名 Host/Origin | 无 | #384（已关闭） |
| release-packaging | release-packaging：发布包组装与守门（排除内核/密钥/本机路径） | 无 | #385（已关闭） |
| install-playbook | install-playbook：Agent 安装 playbook 与人类入口文档 | wave-0 全部 | #386（已关闭） |
| install-e2e-smoke | install-e2e-smoke：安装 e2e 离线冒烟（可重入/失败路径/凭据不泄漏） | wave-0 全部 | #387（已关闭） |
| release-acceptance | release-acceptance：全量回归证据与阶段二手动验收清单 | playbook + e2e | #388（已关闭） |

每个子 Issue 正文含：验收标准（取自 DAG JSON contract.acceptance_example）、依赖节点、`docs/dag-plans/2026-11-26-agent-guided-release.json` 链接；节点交付后回写 PR 号并关闭。

## 3. 授权边界提醒

- 真实 Cloudflare 账号操作、真实域名端到端、APK 真机构建/签名/安装、Releases 上传、服务重启与真实规则变更：均需主人单独授权，不在任何节点默认授权内。
- 本计划无 UI 节点（写范围不命中 `public/`、`mobile/app/www/` 等门禁路径），无 design 块。
