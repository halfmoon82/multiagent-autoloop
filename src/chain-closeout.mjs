// 串行链收口巡检（无模型）：发现 *-serial.json 全部节点 done 且文件已过宽限期，
// 就暂停该链独占的 cron 规则（中台 pause，不动 rules.json，可 resume 恢复），
// 原位归档链文件（加 .done-<日期> 后缀，与现有 .paused-/.bak- 惯例一致），
// 并把动作记入 <root>/closeouts.jsonl。暂停失败不归档，下次巡检重试。
import { existsSync, readdirSync, readFileSync, renameSync, appendFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadChains } from './serial-progress.mjs';
import { hubRequest } from './hub.mjs';

export const CLOSEOUT_GRACE_MS = 30 * 60 * 1000;
export const CLOSEOUT_AUDIT_FILE = 'closeouts.jsonl';
const MAX_AUDIT_BYTES = 256 * 1024;

const text = (value, max = 300) => String(value ?? '').slice(0, max);

export function isChainComplete(chain) {
  return Array.isArray(chain?.nodes) && chain.nodes.length > 0 && chain.nodes.every(node => node.status === 'done');
}

// 链文件词干 → 规则名前缀，与 src/serial-progress.mjs mapChainProject、
// public/status-sections.mjs chainRuleNames 同一条边界规则。
export function chainRuleNames(sourceFile, rules = []) {
  const stem = String(sourceFile || '').replace(/-serial\.json$/i, '').toLowerCase();
  if (!stem) return [];
  return rules.filter(item => {
    const name = text(item?.name).toLowerCase();
    return name.startsWith(stem) && !/^[a-z0-9]/.test(name.slice(stem.length));
  }).map(item => item.name);
}

export function archiveTarget(root, sourceFile, now = Date.now()) {
  const stamp = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  let candidate = path.join(root, `${sourceFile}.done-${stamp}`);
  let counter = 2;
  while (existsSync(candidate)) candidate = path.join(root, `${sourceFile}.done-${stamp}-${counter++}`);
  return candidate;
}

export function readCloseouts(root, limit = 50) {
  if (!root) return [];
  let raw;
  try { raw = readFileSync(path.join(root, CLOSEOUT_AUDIT_FILE), 'utf8'); }
  catch { return []; }
  const lines = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); }
    catch { /* 跳过坏行 */ }
  }
  return lines.slice(-limit);
}

export async function sweepChainCloseouts({ root, rules = [], config, now = Date.now(), graceMs = CLOSEOUT_GRACE_MS, hub = hubRequest, log = () => {} } = {}) {
  const result = { closed: [], skipped: [], errors: [] };
  if (!root) return result;
  const { chains, errors } = await loadChains({ root, rules });
  result.errors.push(...errors);
  // 每条规则被哪些链认领：只暂停完成链独占的 cron 规则，共享规则绝不碰。
  const claimants = new Map(); // ruleName -> Set(sourceFile)
  for (const chain of chains) {
    for (const name of chainRuleNames(chain.sourceFile, rules)) {
      if (!claimants.has(name)) claimants.set(name, new Set());
      claimants.get(name).add(chain.sourceFile);
    }
  }
  for (const chain of chains) {
    try {
      if (!isChainComplete(chain)) { result.skipped.push({ file: chain.sourceFile, reason: 'incomplete' }); continue; }
      const file = path.join(root, chain.sourceFile);
      const ageMs = now - statSync(file).mtimeMs;
      if (ageMs < graceMs) { result.skipped.push({ file: chain.sourceFile, reason: 'grace' }); continue; }
      const cronRules = chainRuleNames(chain.sourceFile, rules)
        .filter(name => claimants.get(name)?.size === 1)
        .map(name => rules.find(rule => rule.name === name))
        .filter(rule => rule?.when && typeof rule.when.cron === 'string');
      const pausedRules = [];
      for (const rule of cronRules) {
        await hub(config, `/v1/rules/${encodeURIComponent(rule.name)}/pause`, {
          method: 'POST',
          body: { reason: `串行链 ${chain.sourceFile} 全部节点完成，自动停止 cron（控制台收口巡检）`, until: null },
        });
        pausedRules.push(rule.name);
      }
      const archived = archiveTarget(root, chain.sourceFile, now);
      renameSync(file, archived);
      const record = {
        at: new Date(now).toISOString(),
        chain: chain.sourceFile,
        project: chain.project,
        pausedRules,
        archived: path.basename(archived),
        resumeHint: pausedRules.map(name => `agent-autoloop resume ${name}`),
      };
      appendFileSync(path.join(root, CLOSEOUT_AUDIT_FILE), `${JSON.stringify(record, null, 0)}\n`);
      log(`收口 ${chain.sourceFile}：暂停 ${pausedRules.join('、') || '（无 cron 规则）'}，归档 ${path.basename(archived)}`);
      result.closed.push({ file: chain.sourceFile, pausedRules, archived: path.basename(archived) });
    } catch (error) {
      result.errors.push(`${chain.sourceFile}：${error.message}`);
    }
  }
  return result;
}

// 周期巡检器：照 notifier.mjs 的模式，仅在显式 start 后轮询，stop 即安静；
// 句柄 unref，绝不阻止进程退出。rules 传函数以每轮读到最新规则。
export function createChainCloseoutSweeper({ root, rules, config, intervalMs = 5 * 60 * 1000, graceMs = CLOSEOUT_GRACE_MS, hub = hubRequest, log = console.log, setTimer = setInterval, clearTimer = clearInterval, delayFirstMs = 15 * 1000, setDelay = setTimeout, clearDelay = clearTimeout } = {}) {
  let timer = null;
  let first = null;
  const tick = async () => {
    try {
      const fresh = typeof rules === 'function' ? rules() : rules;
      await sweepChainCloseouts({ root, rules: fresh || [], config, graceMs, hub, log });
    } catch (error) { log(`收口巡检失败：${error.message}`); }
  };
  return {
    start() {
      if (timer) return;
      first = setDelay(() => { first = null; tick(); }, delayFirstMs);
      first.unref?.();
      timer = setTimer(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (first) { clearDelay(first); first = null; }
      if (timer) { clearTimer(timer); timer = null; }
    },
  };
}
