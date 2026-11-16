# 派发任务（dispatch-tasks）

`POST /api/dispatch-tasks` 为每个任务创建 worktree `<project>/.worktrees/<subject>` 与分支 `feat/<subject>`，再启动 worker 会话并登记任务。

## 跨模块依赖：model / profile（PR #49）

`src/dispatch.mjs` 调用 `sessions.start({ kind, profile: 'worker', model, project, prompt })`。当前 `scheduling-session.mjs` 的 `start` 只识别 `{ kind, prompt, project, continuedFrom }`，会忽略 `profile` 与 `model`。
因此在 PR #49 落地并扩展 `start` 签名之前，任务登记里的 `model` 只是记录值，worker 实际使用默认模型。`test/dispatch*.test.mjs` 中对 `profile` 的断言只验证传给 mock 的参数，不代表真实会话已生效。

## 失败处理

- 同项目同 subject 已有非 `failed` 任务时返回 409；`failed` 任务不占位，可重发同 subject。
- 会话启动失败时，会执行 `git worktree remove --force` 与 `git branch -D` 回滚 worktree 和分支。清理失败不会覆盖原始错误。
