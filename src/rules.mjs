import { execFileSync } from 'node:child_process';
import { DetourError, withStateLockAsync } from './detour.mjs';
import { defaultModelOf } from './platform-models.mjs';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class RuleError extends Error {}
const text = (value, label, { optional = false } = {}) => {
  const result = String(value ?? '').trim();
  if (!optional && !result) throw new RuleError(`请填写${label}`);
  if (result.length > 20000) throw new RuleError(`${label}过长`);
  return result;
};

// 契约错配防护（2026-11-16 机制事故）：提示词要求写状态/文件却绑只读通道，运行期必死锁并反复打扰店主。
// 启发式边界：只匹配「写动词 + 状态对象」的明确信号；否定豁免仅认紧邻动词（≤2 字）的
// 「不要/不得/禁止/勿/别」，跨逗号或带肯定桥接词的否定不算（如「别犹豫，把授权写入台账」仍判写意图）。
const WRITE_INTENT_RULES = [
  { re: /(写入|写进|写回|更新|追加|登记)[^。；，\n]{0,12}state\.nodes/g, label: '写入 state.nodes' },
  { re: /(写入|写进|写回|更新|追加|登记|修改)[^。；，\n]{0,12}[a-z0-9-]*-?serial\.json/g, label: '写串行台账（serial.json）' },
  { re: /(写入|写进|写回)[^。；，\n]{0,16}(state|台账|json|配置|文件)/g, label: '写入状态/文件' },
  { re: /(修改|改动)[^。；，\n]{0,12}(rules\.json|补丁)/g, label: '修改规则配置/补丁' },
  { re: /落地补丁|直接修复/g, label: '落地修复' },
];
const NEGATED = /(不要|不得|禁止|勿|(?<![识级类差])别)$/;  // 「级别/类别」等名词尾字的「别」不算禁止词
export function writeIntentSignals(prompt) {
  const signals = [];
  for (const { re, label } of WRITE_INTENT_RULES) {
    for (const match of prompt.matchAll(re)) {
      const before = prompt.slice(Math.max(0, match.index - 2), match.index);
      if (NEGATED.test(before)) continue;
      if (!signals.includes(label)) signals.push(label);
      break;
    }
  }
  return signals;
}

function ruleFrom(input) {
  const name = text(input.name, '规则名称'); if (name.length > 80) throw new RuleError('规则名称不能超过 80 字');
  const cwd = text(input.cwd, '工作目录');
  if (!/^(?:[A-Za-z]:[\\/]|~[\\/]|\/)/.test(cwd)) throw new RuleError('工作目录必须是绝对路径或以 ~/ 开头');
  const to = text(input.to, '执行 Agent'); const prompt = text(input.prompt, '处理说明');
  let when;
  if (input.trigger === 'cron') when = { cron: text(input.cron, 'cron 时间') };
  else if (input.trigger === 'event') {
    const source = text(input.source, '事件来源');
    const types = String(input.types || '').split(/[\n,]+/).map(value => value.trim()).filter(Boolean);
    if (!types.length) throw new RuleError('请填写至少一个事件类型'); when = { source, types };
  } else throw new RuleError('触发方式只能是定时或事件');
  const parallelText = String(input.parallel ?? '').trim();
  if (parallelText && (!/^[1-9][0-9]*$/.test(parallelText) || Number(parallelText) > 100)) throw new RuleError('并发数要是 1–100 的整数');
  return { name, when, to, cwd, prompt, ...(parallelText ? { parallel: Number(parallelText) } : {}), resume: input.resume === true };
}
export function defaultCheck(config, draft) {
  try { execFileSync(config.cliPath, ['check', draft], { env: { ...process.env, AGENT_AUTOLOOP_HOME: config.root }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }); }
  catch (error) { throw new RuleError(error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.message); }
}
// 移动端只读摘要（Spec §8.2）：把正式规则投影成触屏列表所需的最小字段。
// 服务端不读 Hub 状态、不编造运行/暂停；状态由移动端从 /v1/state 的 lines 叠加，缺失显示明确空态。
// 动作沿用网页控制台既有能力：运行 / 暂停 / 恢复 / 编辑，不新增能力。
export function mobileRuleSummaries(options = {}) {
  const rules = Array.isArray(options?.rules) ? options.rules : [];
  const agents = new Map((Array.isArray(options?.agents) ? options.agents : []).map(agent => [String(agent?.id ?? ''), agent]));
  return rules.map(rule => {
    const name = String(rule?.name ?? '').trim();
    if (!name) return null;
    const agentId = String(rule?.to ?? '').trim();
    const when = rule?.when || {};
    const trigger = when.cron ? `定时 · ${when.cron}`
      : when.source ? `${when.source} · ${(Array.isArray(when.types) ? when.types : []).join(', ')}`
        : '手动触发';
    return {
      name,
      project: String(rule?.cwd ?? '').trim(),
      agent: agentId,
      agentLabel: String(agents.get(agentId)?.name ?? '').trim() || null,
      trigger,
      actions: ['run', 'pause', 'resume', 'edit'],
    };
  }).filter(Boolean);
}

export function readRuleOptions(config) {
  const raw = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  const options = {
    rules: raw.rules.map(rule => ({ name: rule.name, when: rule.when, to: rule.to, cwd: rule.cwd, prompt: rule.prompt || '', parallel: rule.parallel, resume: !!rule.resume })),
    agents: Object.entries(raw.agents || {}).map(([id, agent]) => ({ id, name: agent.name || id, access: agent.access || 'edit', adapter: agent.use || '', model: defaultModelOf(agent) || '' })),
    sources: Object.entries(raw.sources || {}).map(([id, source]) => ({ id, name: source.name || id })),
  };
  return { ...options, mobileRules: mobileRuleSummaries(options) };
}
export async function saveRule(config, input, existingName, check = defaultCheck) {
  // 与频限绕行等状态操作互斥（detour.mjs 的 withStateLock），整文件读-改-写不被交错。
  try {
    return await withStateLockAsync(config, async () => {
      const raw = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
      const rule = ruleFrom(input);
      if (!raw.agents?.[rule.to]) throw new RuleError('所选 Agent 不在配置中');
      const agentAccess = raw.agents[rule.to].access || 'edit';
      const signals = agentAccess === 'read' ? writeIntentSignals(rule.prompt) : [];
      if (signals.length) throw new RuleError(`处理说明要求${[...new Set(signals)].join('、')}，但所选 Agent 是只读通道，运行期必然写不进去。请改选可写 Agent（如 codex-full 或 workbuddy），或把提示词改成只读。`);
      const index = raw.rules.findIndex(item => item.name === (existingName ?? rule.name));
      if (existingName === null && index >= 0) throw new RuleError('已经有同名规则');
      if (existingName !== null && index < 0) throw new RuleError('要编辑的规则已经不存在');
      if (existingName !== null && rule.name !== existingName) throw new RuleError('当前版本不支持修改规则名称');
      if (existingName === null) raw.rules.push(rule);
      else { const preserved = { ...raw.rules[index] }; delete preserved.parallel; raw.rules[index] = { ...preserved, ...rule }; }
      const directory = path.dirname(config.rulesFile);
      const draft = path.join(directory, `.console-${process.pid}-${Date.now()}.json`);
      try {
        writeFileSync(draft, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
        await check(config, draft);
        renameSync(draft, config.rulesFile);
      } finally { try { unlinkSync(draft); } catch {} }
      return rule;
      });
  } catch (error) {
    if (error instanceof DetourError) throw new RuleError(error.message);
    throw error;
  }
}
