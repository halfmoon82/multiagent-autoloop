// 额度绕行路由政策表：按工作类型（dev/review）定主/备 Agent，可按项目 cwd 覆盖。
// 纯配置与裁定，不读写业务文件、不碰密钥。运行目录可选放 detour-policy.json 做项目覆盖。
// 主人定死的默认值：开发 主 workbuddy 备 claude；审阅 主 claude 备 codex-full。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export class PolicyError extends Error {}

export const DEFAULT_POLICY = Object.freeze({
  dev: Object.freeze({ primary: 'workbuddy', fallback: 'claude' }),
  review: Object.freeze({ primary: 'claude', fallback: 'codex-full' }),
  // coord（调度会话/协调/诊断）：主人定的主 codex-full 备 claude——与 dev/review 方向相反，
  // 调度会话日常主力就是 codex-full，claude 是频限绕行时的备用执行者。
  coord: Object.freeze({ primary: 'codex-full', fallback: 'claude' }),
});

const KINDS = ['dev', 'review', 'coord'];

// 审阅先判：像「开发审阅返工」这类混合名优先按审阅（高风险走更可靠的备选）。
// coord 再于 dev 前判：协调类规则名含「调度/协调/诊断」，与开发关键词区分。
const KIND_KEYWORDS = [
  ['review', [/审阅/, /审核/, /评审/, /\breview\b/i]],
  ['coord', [/调度会话/, /协调/, /诊断/, /自愈/, /巡检/, /\bcoordinator?\b/i]],
  ['dev', [/开发/, /编码/, /写代码/, /\bdev(elop|eloper)?\b/i, /\bcoder?\b/i]],
];

/** 从规则名/提示词判定工作类型；显式 kind 优先；判不出返回 null（调用方跳过，不臆测）。 */
export function classifyKind(text, explicit) {
  if (KINDS.includes(explicit)) return explicit;
  const value = String(text ?? '');
  for (const [kind, patterns] of KIND_KEYWORDS) {
    if (patterns.some((pattern) => pattern.test(value))) return kind;
  }
  return null;
}

function validatePair(pair, label) {
  if (!pair || typeof pair !== 'object' || Array.isArray(pair)) throw new PolicyError(`${label} 要是对象`);
  for (const key of ['primary', 'fallback']) {
    if (typeof pair[key] !== 'string' || !pair[key].trim()) throw new PolicyError(`${label}.${key} 要是非空字符串`);
  }
  if (pair.primary.trim() === pair.fallback.trim()) throw new PolicyError(`${label} 的主/备 Agent 不能相同`);
  return { primary: pair.primary.trim(), fallback: pair.fallback.trim() };
}

function validateSection(section, label) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) throw new PolicyError(`${label} 要是对象`);
  const out = {};
  for (const kind of KINDS) {
    if (section[kind] !== undefined) out[kind] = validatePair(section[kind], `${label}.${kind}`);
  }
  if (!Object.keys(out).length) throw new PolicyError(`${label} 至少要覆盖 dev、review 或 coord`);
  return out;
}

/** 读取政策：默认表 + 运行目录可选 detour-policy.json 的 defaults/projects 覆盖。 */
export function loadPolicy(config) {
  const defaults = {};
  for (const kind of KINDS) defaults[kind] = { ...DEFAULT_POLICY[kind] };
  const projects = {};
  const file = path.join(config.root, 'detour-policy.json');
  if (existsSync(file)) {
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { throw new PolicyError(`detour-policy.json 解析失败：${error.message}`); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new PolicyError('detour-policy.json 顶层要是对象');
    if (doc.defaults !== undefined) Object.assign(defaults, validateSection(doc.defaults, 'defaults'));
    if (doc.projects !== undefined) {
      if (typeof doc.projects !== 'object' || Array.isArray(doc.projects)) throw new PolicyError('projects 要是对象');
      for (const [cwd, section] of Object.entries(doc.projects)) {
        if (!cwd || typeof cwd !== 'string') throw new PolicyError('projects 的键要是非空 cwd 字符串');
        projects[cwd] = validateSection(section, `projects[${cwd}]`);
      }
    }
  }
  return { defaults, projects };
}

function cwdMatches(cwd, base) {
  if (!cwd) return false;
  return cwd === base || cwd.startsWith(`${base}/`) || base === '*';
}

/** 取某 cwd 生效的政策：最长前缀匹配的项目覆盖优先于全局默认，逐 kind 合并。 */
export function effectivePolicy(policy, cwd) {
  const result = { dev: { ...policy.defaults.dev }, review: { ...policy.defaults.review }, coord: { ...policy.defaults.coord } };
  // 短前缀先写入，长前缀后写覆盖——保证最长匹配胜出。
  const matches = Object.entries(policy.projects || {})
    .filter(([base]) => cwdMatches(cwd, base))
    .sort((a, b) => a[0].length - b[0].length);
  for (const [, section] of matches) {
    for (const kind of KINDS) if (section[kind]) result[kind] = { ...section[kind] };
  }
  return result;
}

/** 给定工作类型与被拦 Agent，算出政策表指定的备选；仅主 Agent 才改派，其余（含备选/第三 Agent）返回 null。 */
export function resolveFallback(kind, blockedAgent, { policy, cwd } = {}) {
  if (!KINDS.includes(kind)) throw new PolicyError(`未知工作类型：${kind}`);
  const agent = String(blockedAgent ?? '').trim();
  if (!agent) throw new PolicyError('缺少被拦 Agent');
  const rule = effectivePolicy(policy, cwd)[kind];
  // 管理后台生成的分档执行者（<平台>-tier-<档>）：按平台判主备，绕到备用平台的同一档。
  const tiered = /^(.+)-tier-(light|standard|heavy)$/.exec(agent);
  if (tiered) return tiered[1] === rule.primary ? `${rule.fallback}-tier-${tiered[2]}` : null;
  // 只有被拦 Agent 是该类型主 Agent 时才自动改派到备选；第三 Agent（如 codex 上的开发规则）
  // 和已处于备选的都不自动往下绕，留给调度会话按 §4 第 9/10 条处理。
  if (agent !== rule.primary) return null;
  return rule.fallback;
}
