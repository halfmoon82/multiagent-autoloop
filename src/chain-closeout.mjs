// 串行链收口巡检（无模型）：发现 *-serial.json 全部节点 done 且文件已过宽限期，
// 就暂停该链独占的 cron 规则（中台 pause，不动 rules.json，可 resume 恢复），
// 原位归档链文件（加 .done-<日期> 后缀，与现有 .paused-/.bak- 惯例一致），
// 并把动作记入 <root>/closeouts.jsonl。暂停失败不归档，下次巡检重试。
import { existsSync, readdirSync, readFileSync, renameSync, appendFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadChains, chainRuleNames } from './serial-progress.mjs';
import { hubRequest } from './hub.mjs';

export const CLOSEOUT_GRACE_MS = 30 * 60 * 1000;
export const CLOSEOUT_AUDIT_FILE = 'closeouts.jsonl';
const MAX_AUDIT_BYTES = 256 * 1024;
const FILE_PATTERN = /^[A-Za-z0-9_-]+-serial\.json$/;
const stemOf = name => name.replace(/-serial\.json$/i, '').toLowerCase();
const claimedByStem = (stem, ruleName) => {
  const name = String(ruleName || '').toLowerCase();
  return name.startsWith(stem) && !/^[a-z0-9]/.test(name.slice(stem.length));
};

export function isChainComplete(chain) {
  return Array.isArray(chain?.nodes) && chain.nodes.length > 0 && chain.nodes.every(node => node.status === 'done');
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

function audit(root, record) {
  const file = path.join(root, CLOSEOUT_AUDIT_FILE);
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  // 简单轮转：超限后只保留最后 50 行，避免长期运行膨胀。
  try {
    if (statSync(file).size > MAX_AUDIT_BYTES) {
      writeFileSync(file, readCloseouts(root, 50).map(line => `${JSON.stringify(line)}\n`).join(''));
    }
  } catch { /* 轮转失败不阻断巡检 */ }
}

export async function sweepChainCloseouts({ root, rules = [], config, now = Date.now(), graceMs = CLOSEOUT_GRACE_MS, hub = hubRequest, log = () => {} } = {}) {
  const result = { closed: [], skipped: [], errors: [] };
  if (!root) return result;
  const { chains, errors } = await loadChains({ root, rules });
  result.errors.push(...errors);
  // 共享规则保护基于磁盘上的链文件名（含解析失败的破损文件），而不仅是解析成功的链：
  // 破损在途链同样要能保住共享 cron 不被掐停。
  let filesOnDisk = [];
  try { filesOnDisk = readdirSync(root).filter(name => FILE_PATTERN.test(name)); }
  catch { return result; } // 运行目录缺失/不可读：安静空转，与 loadChains 的防护一致
  // 本轮即将收口的候选：完成且过宽限。它们归档后不再占有规则，因此独占判定要排除。
  const closing = new Set();
  for (const chain of chains) {
    try {
      if (!isChainComplete(chain)) continue;
      if (now - statSync(path.join(root, chain.sourceFile)).mtimeMs >= graceMs) closing.add(chain.sourceFile);
    } catch { /* 消失的链不收口 */ }
  }
  for (const chain of chains) {
    const file = path.join(root, chain.sourceFile);
    try {
      if (!isChainComplete(chain)) { result.skipped.push({ file: chain.sourceFile, reason: 'incomplete' }); continue; }
      const mtimeMs = statSync(file).mtimeMs;
      if (now - mtimeMs < graceMs) { result.skipped.push({ file: chain.sourceFile, reason: 'grace' }); continue; }
      const myStem = stemOf(chain.sourceFile);
      // 其他未收口的链文件词干若也认领某规则，该规则即共享，绝不暂停。
      const rivalStems = filesOnDisk.filter(name => name !== chain.sourceFile && !closing.has(name)).map(stemOf);
      const cronRules = chainRuleNames(chain.sourceFile, rules)
        .filter(name => !rivalStems.some(stem => claimedByStem(stem, name)))
        .map(name => rules.find(rule => rule.name === name))
        .filter(rule => rule?.when && typeof rule.when.cron === 'string');
      const pausedRules = [];
      try {
        for (const rule of cronRules) {
          await hub(config, `/v1/rules/${encodeURIComponent(rule.name)}/pause`, {
            method: 'POST',
            body: { reason: `串行链 ${chain.sourceFile} 全部节点完成，自动停止 cron（控制台收口巡检）`, until: null },
          });
          pausedRules.push(rule.name);
        }
      } catch (error) {
        // 部分暂停成功也要留痕，下轮巡检依赖中台 pause 幂等收敛剩余规则。
        audit(root, { at: new Date(now).toISOString(), chain: chain.sourceFile, project: chain.project, pausedRules, error: `暂停中断：${error.message}` });
        result.errors.push(`${chain.sourceFile}：暂停 ${error.message}`);
        continue;
      }
      // 暂停是网络往返，rename 前重查 mtime：编排器若刚写入（复活/推进），本轮放弃归档。
      if (statSync(file).mtimeMs !== mtimeMs) {
        audit(root, { at: new Date(now).toISOString(), chain: chain.sourceFile, project: chain.project, pausedRules, error: '暂停期间链文件被写入，放弃归档，请核实规则是否该恢复', resumeHint: pausedRules.map(name => `agent-autoloop resume ${name}`) });
        result.errors.push(`${chain.sourceFile}：暂停期间文件被写入，放弃归档`);
        continue;
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
      audit(root, record);
      log(`收口 ${chain.sourceFile}：暂停 ${pausedRules.join('、') || '（无 cron 规则）'}，归档 ${path.basename(archived)}`);
      result.closed.push({ file: chain.sourceFile, pausedRules, archived: path.basename(archived) });
    } catch (error) {
      result.errors.push(`${chain.sourceFile}：${error.message}`);
    }
  }
  return result;
}

// 周期巡检器：照 notifier.mjs 的模式，仅在显式 start 后轮询，stop 即安静；
// 句柄 unref，绝不阻止进程退出；单轮未结束不重叠执行。rules 传函数以每轮读到最新规则。
export function createChainCloseoutSweeper({ root, rules, config, intervalMs = 5 * 60 * 1000, graceMs = CLOSEOUT_GRACE_MS, hub = hubRequest, log = console.log, setTimer = setInterval, clearTimer = clearInterval, delayFirstMs = 15 * 1000, setDelay = setTimeout, clearDelay = clearTimeout } = {}) {
  let timer = null;
  let first = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const fresh = typeof rules === 'function' ? rules() : rules;
      const result = await sweepChainCloseouts({ root, rules: fresh || [], config, graceMs, hub, log });
      if (result.errors.length) log(`收口巡检异常：${result.errors.join('；')}`);
    } catch (error) { log(`收口巡检失败：${error.message}`); }
    finally { running = false; }
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
