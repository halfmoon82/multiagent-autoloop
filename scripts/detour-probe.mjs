#!/usr/bin/env node
// 额度绕行探测命令构造器：按 Agent 定义拼一条最便宜的试活命令，探测被拦平台是否恢复。
// 用法：node scripts/detour-probe.mjs <agent-id> [--rules-file <path>] [--timeout 30000]
//  退出码 0=探测通过（被拦平台已恢复）；1=仍不可用或不认识该 Agent；2=用法错误。
//  quota-scan 自动登记绕行时把拼出的命令存进 detour.probe.command；verify 阶段直接执行。
//  本脚本只读 rules.json，不写任何文件。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConsoleConfig } from '../src/config.mjs';

const PING = '只回复ok两个字母';

/** 各平台最便宜的试活方式（只发一条短提示词，收到任何正常退出即视为恢复）。 */
const PING_ARGS = {
  // codebuddy/ACP 直出模式：--acp 去掉后单轮 -p，无会话持续负担
  // 注意：过滤是 token-exact，--acp=1 / --acp stdio 这类带值形式不会命中，
  //  当前生产定义都是裸 '--acp'，若以后有变需同步这里。
  acp: (command) => [...command.map(String).filter((item) => item !== '--acp'), '-p', PING],
  // claude CLI：一次性 -p
  claude: (command) => [...command.map(String), '-p', PING],
  // codex CLI：exec 子命令；--model 放在 PROMPT 前，符合 clap 习惯位置
  codex: (command) => [...command.map(String), 'exec', '--model'],
};

/** 把 ping 和 --model 插进命令模板；use=claude/codex/acp 分别走不同拼法。 */
export function probeCommand(agent) {
  if (!agent) return null;
  const builder = PING_ARGS[agent.use];
  if (!builder) return null;
  const base = Array.isArray(agent.command) && agent.command.length ? agent.command : agent.program ? [agent.program] : null;
  if (!base) return null;
  const model = String(agent.model || '').trim() || null;
  if (agent.use === 'codex') {
    // exec [OPTIONS] [PROMPT]：--model 必须在 PROMPT 前
    return [...base, 'exec', ...(model ? ['--model', model] : []), PING];
  }
  return [...builder(base), ...(model ? ['--model', model] : [])];
}

function args() {
  const argv = process.argv.slice(2);
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].replace(/^--/, '');
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      options[key] = value;
    } else options._.push(argv[i]);
  }
  return options;
}

export function run(command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); resolve(false); } }, timeoutMs);
    child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
    child.on('exit', (code, signal) => { if (!settled) { settled = true; clearTimeout(timer); resolve(code === 0 && !signal); } });
  });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const options = args();
  const agentId = String(options._[0] || '').trim();
  const timeoutMs = Number(options.timeout || 30000);
  if (!agentId || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    console.error('用法：node scripts/detour-probe.mjs <agent-id> [--timeout 30000]');
    process.exit(2);
  }
  const rulesFile = options['rules-file'] ? String(options['rules-file']) : loadConsoleConfig().rulesFile;
  let agent;
  try {
    const raw = JSON.parse(readFileSync(rulesFile, 'utf8'));
    agent = raw?.agents?.[agentId];
  } catch {
    console.error(`读不到 rules.json：${rulesFile}`);
    process.exit(1);
  }
  const command = probeCommand(agent);
  if (!command) {
    console.error(`没有可探测的 Agent：${agentId}（无 command/program 或 use 类型 ${agent?.use ?? '?'} 不支持）`);
    process.exit(1);
  }
  const ok = await run(command, timeoutMs);
  if (!ok) {
    console.error(`探测未通过：${agentId}`);
    process.exit(1);
  }
  console.log(`探测通过：${agentId}`);
}
