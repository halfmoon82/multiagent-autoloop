#!/usr/bin/env node
// 频限绕行 CLI：登记（record）、核实到期绕行（verify）、人工回归（revert）、查看状态（status）。
// 用法：
//   node scripts/detour.mjs status
//   node scripts/detour.mjs record --id wb-hy4-20261115 --blocked-agent workbuddy --blocked-model hy4free \
//     --fallback claude --rules "Phase1开发,Phase1审阅" --evidence "WP8 连续 5 次 refusal（429 配额）" \
//     --probe '["/path/probe.sh"]' --cooldown 30
//   node scripts/detour.mjs verify [--id wb-hy4-20261115] [--timeout 120000]
//   node scripts/detour.mjs revert --id wb-hy4-20261115
import { spawn } from 'node:child_process';
import { loadConsoleConfig } from '../src/config.mjs';
import {
  DetourError, readDetours, recordDetour, dueForProbe, markProbeResult, revertDetour,
} from '../src/detour.mjs';

function args() {
  const argv = process.argv.slice(3);
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    options[key] = value;
  }
  return options;
}

export function runProbe(command, timeoutMs) {
  return new Promise((resolve) => {
    // 输出不消费，管道会被大输出堵死；探测只看退出码。
    const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); resolve(false); } }, timeoutMs);
    child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
    child.on('exit', (code, signal) => { if (!settled) { settled = true; clearTimeout(timer); resolve(code === 0 && !signal); } });
  });
}

const command = process.argv[2];
const options = args();
const config = loadConsoleConfig();

try {
  if (command === 'status') {
    const detours = readDetours(config);
    if (!detours.length) console.log('没有频限绕行记录');
    for (const detour of detours) {
      console.log(`${detour.status === 'detoured' ? '绕行中' : '已回归'}  ${detour.id}  被拦 ${detour.blockedAgent}${detour.blockedModel ? `/${detour.blockedModel}` : ''}  替代 ${detour.fallbackAgent}  规则 ${detour.rules.map((rule) => rule.name).join('、')}`);
      for (const item of detour.history) console.log(`  ${item.at}  ${item.event}  ${item.note || ''}`);
    }
  } else if (command === 'record') {
    let probeCommand = null;
    if (options.probe) {
      try { probeCommand = JSON.parse(options.probe); }
      catch { throw new DetourError('--probe 要是 JSON 数组，例如 ["双引号数组"]'); }
      if (!Array.isArray(probeCommand) || !probeCommand.length) throw new DetourError('--probe 要是非空 JSON 数组');
    }
    const record = recordDetour(config, {
      id: options.id, blockedAgent: options['blocked-agent'], blockedModel: options['blocked-model'],
      evidence: options.evidence, fallbackAgent: options.fallback,
      ruleNames: String(options.rules || '').split(/[,，]/).map((name) => name.trim()).filter(Boolean),
      probe: { command: probeCommand, cooldownMinutes: Number(options.cooldown || 30) },
    });
    console.log(`已登记绕行 ${record.id}：${record.rules.map((rule) => rule.name).join('、')} 切到 ${record.fallbackAgent}`);
  } else if (command === 'verify') {
    const due = options.id ? readDetours(config).filter((d) => d.id === options.id && d.status === 'detoured') : dueForProbe(config);
    if (!due.length) { console.log('没有到期的绕行要核实'); process.exit(0); }
    const timeoutMs = Number(options.timeout || 120000);
    let failures = 0;
    for (const detour of due) {
      try {
        if (!detour.probe?.command?.length) { console.log(`${detour.id}：没有探测命令，跳过（用 revert 人工回归）`); continue; }
        const ok = await runProbe(detour.probe.command, timeoutMs);
        const result = markProbeResult(config, detour.id, ok);
        console.log(`${detour.id}：探测${ok ? '通过，已回归' : '未通过，继续绕行'}${result.skipped.length ? `；跳过 ${result.skipped.map((item) => `${item.name}（${item.reason}：现在 ${item.currentTo ?? '不存在'}）`).join('、')}` : ''}`);
      } catch (error) {
        failures += 1; // 一条失败不阻断其余到期的绕行
        console.error(`${detour.id}：${error.message}`);
      }
    }
    process.exit(failures ? 1 : 0);
  } else if (command === 'revert') {
    const result = revertDetour(config, String(options.id || ''));
    if (result.already) console.log(`${result.record.id}：已于 ${result.record.revertedAt} 回归，无需重复操作`);
    else console.log(`已回归 ${result.record.id}：恢复 ${result.reverted.join('、') || '（无）'}${result.skipped.length ? `；跳过 ${result.skipped.map((item) => `${item.name}（${item.reason}）`).join('、')}` : ''}`);
  } else {
    console.log('用法：node scripts/detour.mjs status|record|verify|revert');
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  if (error instanceof DetourError) { console.error(error.message); process.exit(1); }
  throw error;
}
