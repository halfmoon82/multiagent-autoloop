// DAG 节点模型档位（无模型、纯逻辑 + 只读开关）：成本优先，按节点复杂度给出 light / standard / heavy。
// 档位 → 具体执行者/模型由 Hub 规则决定（事件类型 dag.<slug>.<role>.<tier>）；本模块不认识任何模型名。
// 底线（主人 11-14 定）：审阅至少 standard；资金/数据/安全节点开发至少 standard、审阅 heavy。
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const TIERS = ['light', 'standard', 'heavy'];
export const TIER_FILE = 'dag-tiers.json';
const RISKS = new Set(['funds', 'data', 'security']);
// 按词边界匹配敏感路径，避免 author→auth 之类误判。
const SENSITIVE_PATH = /(^|[/._-])(pay(ment)?s?|billing|invoice|ledger|funds?|wallet|accounts?|auth|oauth|login|secrets?|credentials?|crypto|migrations?|schema|db)([/._-]|$)|\.sql$/i;

const rank = tier => TIERS.indexOf(tier);
const atLeast = (tier, floor) => (rank(tier) < rank(floor) ? floor : tier);

export function bumpTier(tier, steps = 0) {
  const start = Math.max(0, rank(tier));
  return TIERS[Math.min(TIERS.length - 1, start + Math.max(0, Number(steps) || 0))];
}

export function isSensitiveNode(node) {
  const risk = Array.isArray(node?.risk) ? node.risk : node?.risk ? [node.risk] : [];
  if (risk.some(item => RISKS.has(String(item)))) return true;
  const files = [...(node?.contract?.files || []), ...(node?.files || [])];
  return files.some(file => SENSITIVE_PATH.test(String(file)));
}

function inferred(node) {
  const files = new Set([...(node?.contract?.files || []), ...(node?.files || [])]).size;
  if (files <= 2) return 'light';
  if (files <= 6) return 'standard';
  return 'heavy';
}

// 节点 + 角色 → 档位。bump 为换打法累计升档次数；先升档再套底线。
export function nodeTier(node, role, { bump = 0 } = {}) {
  const base = TIERS.includes(node?.complexity) ? node.complexity : inferred(node);
  let tier = bumpTier(base, bump);
  const sensitive = isSensitiveNode(node);
  if (role === 'review') tier = atLeast(tier, sensitive ? 'heavy' : 'standard');
  else if (sensitive) tier = atLeast(tier, 'standard');
  return tier;
}

// 运行目录下的分档开关：{ "enabled": ["light", ...] }。只有对应 Hub 规则配好后才开启；
// 缺失/损坏/非法值一律视为未启用，派发回落原事件类型（fail closed 到旧行为，不派往不存在的规则）。
export function loadEnabledTiers(root) {
  if (!root) return new Set();
  try {
    const data = JSON.parse(readFileSync(path.join(String(root), TIER_FILE), 'utf8'));
    return new Set((Array.isArray(data?.enabled) ? data.enabled : []).filter(tier => TIERS.includes(tier)));
  } catch { return new Set(); }
}
