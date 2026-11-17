// 项目级今日/累计用量聚合（Issue #59）：只信各 Agent 自报的费用与 Token，
// 控制台不折算、不按模型名估算。累计取自 Hub 规则行自报 usage（自首次运行），
// 今日取自当天完成轮次自报 usage；缺失即如实标注未上报，不返回零费用冒充上报。
import { basename } from 'node:path';

const isNum = value => typeof value === 'number' && Number.isFinite(value);
const cleaned = value => String(value ?? '').trim();
const projectKey = value => {
  const text = cleaned(value);
  if (!text || text === '未识别') return '未识别';
  return basename(text.replace(/[\\/]+$/, '')) || text;
};
const sameLocalDay = (iso, now) => {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
};

const emptyAcc = () => ({ cost: null, input: 0, output: 0, tokenReported: false });
function addUsage(acc, usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return;
  if (isNum(usage.cost)) acc.cost = (acc.cost ?? 0) + usage.cost;
  if (isNum(usage.input) || isNum(usage.output)) {
    acc.tokenReported = true;
    acc.input += isNum(usage.input) ? usage.input : 0;
    acc.output += isNum(usage.output) ? usage.output : 0;
  }
}
const finish = acc => ({
  cost: acc.cost,
  input: acc.input,
  output: acc.output,
  tokens: acc.input + acc.output,
  reported: acc.cost !== null || acc.tokenReported,
});

// 输入 Hub state 与规则表，输出按项目分组的 { today, cumulative } 用量。
export function aggregateProjectUsage({ state = {}, rules = [], now = new Date() } = {}) {
  const buckets = new Map();
  const ensure = (key, representative) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, project: representative || key, today: emptyAcc(), cumulative: emptyAcc() };
      buckets.set(key, bucket);
    } else if (!bucket.project && representative) {
      bucket.project = representative;
    }
    return bucket;
  };
  const ruleByName = new Map();
  for (const rule of rules || []) {
    const cwd = cleaned(rule?.cwd);
    if (!cwd) continue;
    const name = cleaned(rule?.name);
    if (name) ruleByName.set(name, { key: projectKey(cwd), cwd });
    ensure(projectKey(cwd), cwd);
  }

  // 累计：Hub 规则行的 usage。真实形态归在 totals.usage，兼容顶层 usage。
  for (const line of state?.lines || []) {
    const rule = ruleByName.get(cleaned(line?.name));
    if (!rule) continue;
    const usage = line?.totals?.usage || line?.usage;
    if (usage) addUsage(ensure(rule.key, rule.cwd).cumulative, usage);
  }

  // 今日：当天完成轮次的 usage；运行中的轮次没有终态不计。
  for (const run of state?.runs || []) {
    if (!['done', 'nothing'].includes(run?.state)) continue;
    if (!sameLocalDay(run.finishedAt || run.createdAt, now)) continue;
    const direct = cleaned(run?.project || run?.cwd);
    const rule = ruleByName.get(cleaned(run?.rule));
    const key = direct ? projectKey(direct) : rule?.key;
    if (!key) continue;
    addUsage(ensure(key, direct || rule?.cwd).today, run?.usage);
  }

  const projects = [...buckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key, 'zh-CN'))
    .map(bucket => ({
      project: bucket.project,
      key: bucket.key,
      today: finish(bucket.today),
      cumulative: finish(bucket.cumulative),
    }));
  return { projects };
}
