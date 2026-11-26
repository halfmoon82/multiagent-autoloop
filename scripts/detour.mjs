#!/usr/bin/env node
// 频限绕行 CLI：登记（record）、核实到期绕行（verify / verify-all 批量）、人工回归（revert）、查看状态（status）。
// verify-all 是 cron 用批量入口：退出码 0=全部核实完成/无到期，1=探测未通过或处理出错，2=用法/配置错误。
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
  DetourError, quarantineCorruptDetours, readDetours, recordDetour, dueForProbe, markProbeResult, revertDetour,
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

// 拒答/限额信号：有的 CLI（实测 codebuddy/ACP）被拒时把「429 额度已用尽」打到输出但退出码仍是 0，
// 只看退出码会把永久拒答误判为已恢复（2026-11-24/25 事故：绕行被自动回归后真实派发再次 refusal）。
export const PROBE_REFUSAL_RE = /额度已用尽|余额不足|refusal|rate\s?limit|too many requests|quota[_\s-]?(exhausted|balance)|bizCode=14018|httpStatus=429/i;
const PROBE_OUTPUT_CAP = 65536;

/** 收集输出到封顶缓冲（data 事件本身就在排水，不会堵管道），超帽后丢弃内容只计数。 */
function cappedCollector() {
  const state = { text: '', over: false };
  state.push = (chunk) => {
    if (state.over) return;
    state.text += chunk.toString('utf8');
    if (state.text.length > PROBE_OUTPUT_CAP) { state.over = true; state.text = state.text.slice(0, PROBE_OUTPUT_CAP); }
  };
  return state;
}

export function runProbe(command, timeoutMs) {
  return new Promise((resolve) => {
    // 退出码 + 输出双闸：退出码非 0 或输出含拒答信号都视为未恢复。
    const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    const collectOut = cappedCollector(); const collectErr = cappedCollector();
    child.stdout.on('data', collectOut.push);
    child.stderr.on('data', collectErr.push);
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(false); }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('exit', (code, signal) => {
      const refused = PROBE_REFUSAL_RE.test(collectOut.text) || PROBE_REFUSAL_RE.test(collectErr.text);
      finish(code === 0 && !signal && !refused);
    });
  });
}

/** 核实到期绕行的共用实现。strict=true（verify-all，cron 用）退出码 0/1/2；
 *  strict=false（旧 verify）保持兼容：只有处理出错才退出 1，探测未通过仍退出 0。 */
async function runVerify(config, { id, timeoutMs, strict = false } = {}) {
  let due;
  const notes = [];
  try {
    due = id ? readDetours(config).filter((d) => d.id === id && d.status === 'detoured') : dueForProbe(config);
  } catch (error) {
    if (!(error instanceof DetourError) || !/损坏|缺少 detours 数组/.test(error.message)) throw error;
    quarantineCorruptDetours(config); // 损坏文件留档隔离后按空集合重试一轮
    due = id ? [] : dueForProbe(config);
    notes.push('detours.json 已损坏，已改名留档，本次按无绕行处理');
  }
  if (!due.length) {
    notes.push('没有到期的绕行要核实');
    return { due: 0, ok: 0, failed: 0, skipped: 0, results: [], notes, exitCode: 0 };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new DetourError('--timeout 要是至少 1000 毫秒的整数');
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let errors = 0;
  const results = [];
  for (const detour of due) {
    try {
      if (!detour.probe?.command?.length) {
        notes.push(`${detour.id}：没有探测命令，跳过（用 revert 人工回归）`);
        skipped += 1;
        results.push({ id: detour.id, outcome: 'skipped' });
        continue;
      }
      const probeOk = await runProbe(detour.probe.command, timeoutMs);
      const result = markProbeResult(config, detour.id, probeOk);
      notes.push(`${detour.id}：探测${probeOk ? '通过，已回归' : '未通过，继续绕行'}${result.skipped.length ? `；跳过 ${result.skipped.map((item) => `${item.name}（${item.reason}：现在 ${item.currentTo ?? '不存在'}）`).join('、')}` : ''}`);
      if (probeOk) ok += 1;
      else failed += 1;
      results.push({ id: detour.id, outcome: probeOk ? 'ok' : 'failed', skipped: result.skipped });
    } catch (error) {
      if (/没有进行中的绕行/.test(error.message)) { // 并发 verify 已处理
        skipped += 1;
        results.push({ id: detour.id, outcome: 'skipped' });
        continue;
      }
      errors += 1; // 一条失败不阻断其余到期的绕行
      notes.push(`${detour.id}：${error.message}`);
      results.push({ id: detour.id, outcome: 'error', error: error.message });
    }
  }
  const exitCode = strict ? (failed + errors ? 1 : 0) : (errors ? 1 : 0);
  return { due: due.length, ok, failed, errors, skipped, results, notes, exitCode };
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
  } else if (command === 'verify' || command === 'verify-all') {
    const strict = command === 'verify-all';
    let summary;
    try {
      summary = await runVerify(config, {
        id: strict ? undefined : options.id,
        timeoutMs: Number(options.timeout || 120000),
        strict,
      });
    } catch (error) {
      if (error instanceof DetourError) { console.error(error.message); process.exit(strict ? 2 : 1); }
      throw error;
    }
    if (strict && options.json === true) console.log(JSON.stringify(summary, null, 2));
    else for (const note of summary.notes) console.log(note);
    process.exit(summary.exitCode);
  } else if (command === 'revert') {
    const result = revertDetour(config, String(options.id || ''));
    if (result.already) console.log(`${result.record.id}：已于 ${result.record.revertedAt} 回归，无需重复操作`);
    else console.log(`已回归 ${result.record.id}：恢复 ${result.reverted.join('、') || '（无）'}${result.skipped.length ? `；跳过 ${result.skipped.map((item) => `${item.name}（${item.reason}）`).join('、')}` : ''}`);
  } else {
    console.log('用法：node scripts/detour.mjs status|record|verify|verify-all|revert');
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  if (error instanceof DetourError) { console.error(error.message); process.exit(1); }
  throw error;
}
