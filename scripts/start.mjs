import { loadConsoleConfig } from '../src/config.mjs';
import { createConsoleServer } from '../src/server.mjs';
import { createConsoleNotifier } from '../src/notifier.mjs';
import { createChainCloseoutSweeper } from '../src/chain-closeout.mjs';
import { readRuleOptions } from '../src/rules.mjs';
import { startDagControllers } from '../src/dag-runtime.mjs';
import { createDagStallSweeper } from '../src/dag-stall.mjs';
const config = loadConsoleConfig();
const server = createConsoleServer(config);
// 新出现的「待我处理」卡片发 macOS 系统通知；AUTOLOOP_NOTIFY=0 可关闭。
// 仅在 listen 成功后启动：启动失败（如端口占用）时 error 路径要停掉轮询，避免定时器保活导致进程僵死。
const notifier = process.env.AUTOLOOP_NOTIFY === '0' ? null : createConsoleNotifier({ config, server });
// 串行链收口巡检：完成链自动停 cron 并归档；AUTOLOOP_CLOSEOUT=0 可关闭。
const closeout = process.env.AUTOLOOP_CLOSEOUT === '0' ? null : createChainCloseoutSweeper({ root: config.root, rules: () => readRuleOptions(config).rules || [], config });
// DAG 控制器（无模型）：启动即从 dag-runs/*.json 恢复在途节点并对账 Hub；AUTOLOOP_DAG=0 可关闭。
let dagControllers = null;
// DAG 卡住巡检（无模型）：节点同一错误持续 10 分钟即唤醒调度会话；AUTOLOOP_DAG_STALL=0 可关闭。
const dagStall = process.env.AUTOLOOP_DAG === '0' || process.env.AUTOLOOP_DAG_STALL === '0' ? null : createDagStallSweeper({ config });
const stopNotifier = () => { notifier?.stop(); closeout?.stop(); dagControllers?.stop(); dagStall?.stop(); };
server.on('close', stopNotifier);
server.on('error', error => { console.error(`控制台启动失败：${error.message}`); stopNotifier(); process.exitCode = 1; });
server.listen(config.port, config.host, () => {
  notifier?.start();
  closeout?.start();
  server.restoreSchedulingSessions();
  if (process.env.AUTOLOOP_DAG !== '0') dagControllers = startDagControllers({ config });
  dagStall?.start();
  console.log(`Autoloop 控制台：http://${config.host}:${server.address().port}`);
  console.log(`连接中台：${config.hubUrl}`);
  console.log('仅本机可访问；按 Ctrl+C 停止。');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
