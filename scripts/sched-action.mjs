#!/usr/bin/env node
// sched.command 命令 agent 入口：Hub command 规则把它当作一轮执行；
// 读 AGENT_AUTOLOOP_CONTEXT（worker.ts 注入）里的 sched.command 事件，落地后打印一句话结论。
import { main } from '../src/sched-action.mjs';

main().then(result => {
  if (!result?.ok) process.exitCode = 1;
}).catch(error => {
  console.error(`sched-action 没跑成：${error?.message || error}`);
  process.exitCode = 1;
});
