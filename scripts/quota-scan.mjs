#!/usr/bin/env node
// 额度拒绝自动侦测 CLI：扫运行目录最近轮次，命中连续额度拒绝即按政策表登记绕行。
// 用法：
//   node scripts/quota-scan.mjs [--window 200] [--threshold 3] [--patterns 429,refusal,配额,quota]
//     [--runs-dir /path/to/runs] [--cooldown 30] [--probe '["/path/probe.sh"]'] [--dry-run] [--json]
//  cron 规则模板见 docs/scheduling-contract.md §12；不传 --probe 时登记不带探测命令，
//  核实 CLI 会跳过并要求人工 revert——生产部署应在 detour-policy.json 或命令行配好探测命令。
import { loadConsoleConfig } from '../src/config.mjs';
import { QuotaScanError, scanForQuotaDetours } from '../src/quota-scan.mjs';

function args() {
  const argv = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    options[key] = value;
  }
  return options;
}

function parseList(value) {
  if (!value || value === true) return undefined;
  if (String(value).startsWith('[')) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new QuotaScanError('--patterns/--probe 的 JSON 要是数组');
    return parsed.map(String);
  }
  return String(value).split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

function parseProbe(value) {
  if (!String(value).trim().startsWith('[')) throw new QuotaScanError('--probe 要是 JSON 数组，例如 ["探测命令"]');
  return parseList(value);
}

try {
  const options = args();
  const config = loadConsoleConfig();
  const patterns = parseList(options.patterns);
  const probeCommand = options.probe ? parseProbe(options.probe) : undefined;
  const result = scanForQuotaDetours(config, {
    ...(patterns ? { patterns } : {}),
    ...(probeCommand ? { probeCommand } : {}),
    ...(options['runs-dir'] ? { runsDir: options['runs-dir'] } : {}),
    ...(options.window ? { window: Number(options.window) } : {}),
    ...(options.threshold ? { threshold: Number(options.threshold) } : {}),
    ...(options.cooldown ? { cooldownMinutes: Number(options.cooldown) } : {}),
    dryRun: options['dry-run'] === true,
  });
  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`扫描 ${result.scanned} 轮，连续命中候选 ${result.candidates.length}，登记绕行 ${result.detours.length}`);
    for (const detour of result.detours) console.log(`  已登记 ${detour.id}：${detour.blockedAgent}${detour.blockedModel ? `/${detour.blockedModel}` : ''} → ${detour.fallbackAgent}（${detour.rules.map((rule) => rule.name).join('、')}）`);
    for (const skip of result.skipped) console.log(`  跳过 ${skip.agent}${skip.model ? `/${skip.model}` : ''}：${skip.reason}`);
    if (options['dry-run'] === true) console.log('  （dry-run：未写入任何文件）');
  }
  process.exit(0);
} catch (error) {
  if (error instanceof QuotaScanError) { console.error(error.message); process.exit(1); }
  if (error instanceof SyntaxError) { console.error(`--patterns/--probe JSON 解析失败：${error.message}`); process.exit(1); }
  console.error(error.message || String(error));
  process.exit(1);
}
