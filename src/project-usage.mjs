// 项目级今日/累计用量聚合（Issue #59）：只信各 Agent 自报的费用与 Token，
// 控制台不折算、不按模型名估算。今日取自当天完成轮次自报 usage；
// 累计优先用 chain-usage.mjs 台账（runs 全量翻页累加，真·自首次运行）——
// Hub 规则行 usage 只是当日窗口，不能当累计；台账缺失时回退规则行并如实标注。
// 缺失即如实标注未上报，不返回零费用冒充上报。
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

const isUsageMap = value => value && typeof value.get === 'function';
const addTotals = (acc, totals) => {
  acc.input += totals.input || 0;
  acc.output += totals.output || 0;
  if (isNum(totals.cost)) acc.cost = (acc.cost ?? 0) + totals.cost;
  if ((totals.input || 0) + (totals.output || 0) > 0) acc.tokenReported = true;
  return acc;
};

// 输入 Hub state 与规则表，输出按项目分组的 { today, cumulative } 用量。
// cumulativeByRule：chain-usage.mjs 台账的按规则累计（Map），优先于规则行今日窗口。
export function aggregateProjectUsage({ state = {}, rules = [], now = new Date(), cumulativeByRule = null } = {}) {
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

  // 累计：有台账时直接按规则累计（全量翻页结果，不依赖 lines 是否存在）；
  // 台账缺失时回退 Hub 规则行 usage（今日窗口，如实低于真累计）。
  if (isUsageMap(cumulativeByRule)) {
    for (const [name, totals] of cumulativeByRule) {
      const rule = ruleByName.get(cleaned(name));
      if (!rule) continue;
      addTotals(ensure(rule.key, rule.cwd).cumulative, totals);
    }
  } else {
    for (const line of state?.lines || []) {
      const rule = ruleByName.get(cleaned(line?.name));
      if (!rule) continue;
      const usage = line?.totals?.usage || line?.usage;
      if (usage) addUsage(ensure(rule.key, rule.cwd).cumulative, usage);
    }
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
