import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class RuleError extends Error {}
const text = (value, label, { optional = false } = {}) => {
  const result = String(value ?? '').trim();
  if (!optional && !result) throw new RuleError(`请填写${label}`);
  if (result.length > 20000) throw new RuleError(`${label}过长`);
  return result;
};
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
function defaultCheck(config, draft) {
  try { execFileSync(config.cliPath, ['check', draft], { env: { ...process.env, AGENT_AUTOLOOP_HOME: config.root }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }); }
  catch (error) { throw new RuleError(error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.message); }
}
export function readRuleOptions(config) {
  const raw = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  return {
    rules: raw.rules.map(rule => ({ name: rule.name, when: rule.when, to: rule.to, cwd: rule.cwd, prompt: rule.prompt || '', parallel: rule.parallel, resume: !!rule.resume })),
    agents: Object.entries(raw.agents || {}).map(([id, agent]) => ({ id, name: agent.name || id, access: agent.access || 'edit' })),
    sources: Object.entries(raw.sources || {}).map(([id, source]) => ({ id, name: source.name || id })),
  };
}
export async function saveRule(config, input, existingName, check = defaultCheck) {
  const raw = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  const rule = ruleFrom(input);
  if (!raw.agents?.[rule.to]) throw new RuleError('所选 Agent 不在配置中');
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
}
