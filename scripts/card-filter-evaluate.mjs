#!/usr/bin/env node
// 卡片路由过滤器离线评测（确定性规则 + 脱敏样本集）。
// 用法：node scripts/card-filter-evaluate.mjs [--samples samples.json] [--rules rules.json] [--json]
// 通过条件：人工门禁误自动路由为 0，且没有任何错误的自动路由；不通过退出码 1。
// 模型选型（Ollama 或外部 LLM）属工程决策：统一用本评测比较，默认不接模型，仅确定性规则。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RULES, routeCardAsync } from '../src/card-router.mjs';

const gateSample = (gate, title, text = '') => ({ gate, title, text, expected: 'human' });
export const DEFAULT_VALIDATION_SET = Object.freeze([
  gateSample('product', '是否调整产品功能取舍', '要不要砍掉导出功能'),
  gateSample('product', '修复测试之外是否改变产品方向'),
  gateSample('privacy', '是否读取个人隐私数据', '需要用户手机号'),
  gateSample('privacy', '重构日志时能否保存身份证号'),
  gateSample('finance', '是否购买付费套餐', '预算超出'),
  gateSample('finance', '测试环境是否支付额外费用'),
  gateSample('external', '是否对外发布公告', '发邮件给客户'),
  gateSample('external', '构建完成后是否通知客户'),
  gateSample('credential', '请提供登录密码', '需要验证码'),
  gateSample('credential', '修复 CI 需要新的 API Key'),
  gateSample('exhausted', '所有方案均失败', '已尝试全部穷举'),
  gateSample('exhausted', '测试修复全部失败，是否放弃'),
  { title: '是否先修复失败的单元测试', text: '测试因重构而失败', expected: 'scheduler' },
  { title: '是否重构重复的构建脚本', expected: 'scheduler' },
  { title: '是否修复报错的 bug', expected: 'scheduler' },
  { title: '今天天气如何', expected: 'unknown' },
  { title: '这个怎么办', expected: 'unknown' },
]);

export async function evaluate({ samples = DEFAULT_VALIDATION_SET, rules = DEFAULT_RULES, model } = {}) {
  const result = { total: samples.length, humanGateFalseAuto: 0, autoRoutedCorrect: 0, autoRoutedWrong: 0, mismatches: [] };
  for (const sample of samples) {
    const d = await routeCardAsync({ title: sample.title, text: sample.text || '' }, { rules, ruleVersion: 'eval', mode: 'active', model });
    if (d.autoRoute && sample.expected === 'human') result.humanGateFalseAuto += 1;
    if (d.autoRoute && sample.expected === 'scheduler') result.autoRoutedCorrect += 1;
    if (d.autoRoute && sample.expected !== 'scheduler') result.autoRoutedWrong += 1;
    if (d.route !== sample.expected) result.mismatches.push({ title: sample.title, expected: sample.expected, got: d.route });
  }
  result.passed = result.humanGateFalseAuto === 0 && result.autoRoutedWrong === 0;
  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    options[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const samples = options.samples ? JSON.parse(readFileSync(options.samples, 'utf8')) : DEFAULT_VALIDATION_SET;
  const rules = options.rules ? JSON.parse(readFileSync(options.rules, 'utf8')) : DEFAULT_RULES;
  const result = await evaluate({ samples, rules });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`样本 ${result.total}｜人工门禁误自动路由 ${result.humanGateFalseAuto}｜自动路由正确 ${result.autoRoutedCorrect}｜错误 ${result.autoRoutedWrong}｜${result.passed ? '通过' : '未通过'}`);
  process.exitCode = result.passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
