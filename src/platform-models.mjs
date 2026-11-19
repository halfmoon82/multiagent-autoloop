// 平台与模型（管理后台「平台与模型」分区的服务端）：平台自动发现、每平台三档模型、工作分配与会话档位。
// 唯一写入口 applyPlatformModels：在状态锁内原子改 rules.json（生成「平台×档位」执行者与分档规则）、
// detour-policy.json（开发/审阅/调度主备，频限绕行共用）与 platform-models.json（开关、三档模型、会话设置）。
// 不认识具体模型的好坏：成本排序与底线在 dag-tier.mjs；这里只把人选定的模型落到中台可执行的配置。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDetours, withStateLockAsync, DetourError } from './detour.mjs';
import { TIERS } from './dag-tier.mjs';
import { dagEventType } from './dag-runtime.mjs';

export class PlatformModelsError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

export const SETTINGS_FILE = 'platform-models.json';
const POLICY_FILE = 'detour-policy.json';
const ROLES = ['dev', 'review', 'coord'];
const SESSION_KINDS = ['design', 'normal'];
const TIER_RE = /^(.+)-tier-(light|standard|heavy)$/;
const MODEL_RE = /^[A-Za-z0-9][\w.:/@+-]{0,99}$/;
const GENERATED_RULE = /·(light|standard|heavy)$/;
// 需要写权限的工作：开发与调度会话不能落到只读执行者上（审阅可以只读）。
const WRITE_ROLES = new Set(['dev', 'coord']);
// 会话能直接开的平台：只有 codex（内置 Codex ACP 适配器，带只读/工作区写沙箱与 Plan Mode 核验）。
// WorkBuddy 的 ACP 会话模式没有只读/工作区写沙箱（实测 default/acceptEdits/plan/fullAccess…），
// 会话安全护栏无法等价核验，暂不接入；claude 暂无 ACP 适配器。
const SESSION_USES = new Set(['codex']);

export const tierAgentId = (platform, tier) => `${platform}-tier-${tier}`;
export function parseTierAgent(id) {
  const match = TIER_RE.exec(String(id ?? ''));
  return match ? { platform: match[1], tier: match[2] } : null;
}

// ---- 本机可选模型清单（只读发现；失败返回 null = 页面改手填） ----
const home = () => process.env.HOME || os.homedir();
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const helpCache = new Map();
export const defaultCatalog = {
  codex: () => {
    const data = readJson(path.join(home(), '.codex', 'models.json'));
    const list = Array.isArray(data) ? data : data?.models || (data && typeof data === 'object' ? Object.values(data) : []);
    const names = list.map(item => (typeof item === 'string' ? item : item?.slug || item?.id || item?.model)).filter(Boolean);
    return names.length ? names : null;
  },
  claude: () => ['haiku', 'sonnet', 'opus'],
  // ACP 执行者（如 WorkBuddy）：读其 --help 里「Currently supported: (a, b, …)」；结果缓存 10 分钟。
  acp: agent => {
    const command = Array.isArray(agent?.command) ? agent.command : null;
    if (!command?.length) return null;
    const key = command[0];
    const hit = helpCache.get(key);
    if (hit && Date.now() - hit.at < 600_000) return hit.models;
    let models = null;
    try {
      const out = execFileSync(command[0], ['--help'], { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }).toString();
      const match = /--model[^\n]*Currently supported:\s*\(([^)]+)\)/.exec(out);
      if (match) models = match[1].split(',').map(item => item.trim()).filter(Boolean);
    } catch { models = null; }
    helpCache.set(key, { at: Date.now(), models });
    return models;
  },
};

function defaultModelOf(agent) {
  if (agent.model) return agent.model;
  const flag = Array.isArray(agent.command) ? agent.command.indexOf('--model') : -1;
  if (flag >= 0 && agent.command[flag + 1]) return agent.command[flag + 1];
  if (agent.use === 'codex') {
    try { return readFileSync(path.join(home(), '.codex', 'config.toml'), 'utf8').match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null; } catch { return null; }
  }
  if (agent.use === 'acp') {
    const settings = readJson(path.join(home(), '.codebuddy', 'settings.json'));
    return typeof settings?.model === 'string' ? settings.model : null;
  }
  return null;
}

// 平台 = 宿主程序（Codex、Claude Code、某个 ACP 程序如 WorkBuddy…），不是执行者：
// 同一程序上的多个执行者（如 codex、codex-full、项目专用的 liuxue-heal）合并为一个平台。
// 平台 id 取该程序上选出的「模板执行者」id（分档执行者由它复制而来，频限绕行与关闭回退都沿用这个 id）：
// 可写优先，其次工作分配在用（preferred 顺序）、id 与程序同名、被规则引用更多。新程序登记后自动出现。
const NON_AI_USES = new Set(['command', 'delivery', 'desktop', 'dsh', 'feishu', 'github', 'gitlab', 'webhook']);
const HOST_NAMES = { codex: 'Codex', claude: 'Claude Code' };
const hostKey = agent => (agent.use === 'acp' && Array.isArray(agent.command) && agent.command[0] ? `acp:${agent.command[0]}` : agent.use);
const accessRank = agent => ({ full: 0, edit: 1, read: 2 }[agent.access || 'edit'] ?? 1);

export function discoverPlatforms(raw, { catalog = defaultCatalog, preferred = [] } = {}) {
  const groups = new Map();
  for (const [id, agent] of Object.entries(raw?.agents || {})) {
    if (!agent || !agent.use || NON_AI_USES.has(agent.use) || parseTierAgent(id)) continue;
    const key = hostKey(agent);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([id, agent]);
  }
  const order = id => { const index = preferred.indexOf(id); return index < 0 ? Infinity : index; };
  // 最后的平手规则：被规则引用越多越像通用执行者（项目专用执行者通常只挂少数规则）。
  const uses = id => (raw?.rules || []).filter(rule => rule.to === id).length;
  return [...groups.values()].map(members => {
    // 可写优先（分档执行者复制模板的权限，开发/调度需要写）；同权限内再按在用偏好、同名、被引用多少。
    const [id, agent] = [...members].sort((a, b) => accessRank(a[1]) - accessRank(b[1]) || order(a[0]) - order(b[0]) || (b[0] === b[1].use) - (a[0] === a[1].use) || uses(b[0]) - uses(a[0]))[0];
    let models = null;
    try { models = catalog[agent.use] ? catalog[agent.use](agent) : null; } catch { models = null; }
    const defaultModel = defaultModelOf(agent);
    // 平台默认模型总在可选清单里（如 claude 的别名清单不含具体版本号）。
    if (models?.length && defaultModel && !models.includes(defaultModel)) models = [...models, defaultModel];
    return { id, name: HOST_NAMES[agent.use] || agent.name || id, use: agent.use, access: agent.access || 'edit', defaultModel, models: models?.length ? models : null, sessionCapable: SESSION_USES.has(agent.use) };
  });
}

// ---- 设置读写 ----
const settingsPath = config => path.join(config.root, SETTINGS_FILE);
function loadSettings(config) {
  const data = readJson(settingsPath(config));
  return data && typeof data === 'object' ? data : null;
}

// 成本由低到高的偏好清单：只在平台可选模型里挑；挑不到用平台默认模型。只用于「恢复建议值」与首次预填。
const PREFERENCE = [
  ['hy4flash-free', 'deepseek-v4.1-flash', 'haiku', 'glm-5.3-flash', 'qwen3.8-flash'],
  ['hy4std', 'kimi-for-coding', 'claude-sonnet-5-5', 'sonnet', 'glm-5.3'],
  ['deepseek-v4-pro', 'k3.1-pro', 'opus', 'kimi-k3.1-pro'],
];
export function suggestedSettings(platforms, roles = {}) {
  const out = { enabled: true, platforms: {}, sessions: { coord: { tier: 'light' }, design: { platform: null, tier: 'light' }, normal: { platform: null, tier: 'light' } } };
  for (const platform of platforms) {
    const pool = new Set([...(platform.models || []), ...(platform.defaultModel ? [platform.defaultModel] : [])]);
    const pick = index => PREFERENCE[index].find(name => pool.has(name)) || platform.defaultModel || '';
    out.platforms[platform.id] = { light: pick(0), standard: pick(1), heavy: pick(2) };
  }
  // 会话平台：优先工作分配里正在用的通用平台（调度会话主平台优先），避免选中排在前面的项目专用执行者；
  // 都不能开会话时才退回第一个可写的 Codex 类平台。
  const usable = platforms.filter(p => p.sessionCapable && p.access !== 'read');
  const assigned = ['coord', 'dev', 'review'].flatMap(role => [roles[role]?.primary, roles[role]?.fallback]).filter(Boolean);
  const session = assigned.map(id => usable.find(p => p.id === id)).find(Boolean) || usable[0] || platforms.find(p => p.sessionCapable);
  if (session) { out.sessions.design.platform = session.id; out.sessions.normal.platform = session.id; }
  return out;
}

function readPolicyDoc(config) {
  const file = path.join(config.root, POLICY_FILE);
  if (!existsSync(file)) return {};
  const doc = readJson(file);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new PlatformModelsError('detour-policy.json 无法解析，先修复再保存', 500);
  return doc;
}

const FALLBACK_ROLES = { dev: { primary: 'workbuddy', fallback: 'claude' }, review: { primary: 'claude', fallback: 'codex-full' }, coord: { primary: 'codex-full', fallback: 'claude' } };
function currentRoles(config, policy) {
  const effective = policy?.defaults || {};
  const doc = readPolicyDoc(config);
  return Object.fromEntries(ROLES.map(role => [role, effective[role] || doc.defaults?.[role] || FALLBACK_ROLES[role]]));
}
// 模板执行者偏好：当前工作分配在用的执行者优先（与契约文档一致，也防旧版按执行者保存的设置把项目专用执行者顶成模板），
// 其次已保存设置里的平台 id（工作分配不涉及该程序时保持保存前后稳定）。
const preferredIds = (saved, roles) => [...ROLES.flatMap(role => [roles[role]?.primary, roles[role]?.fallback]), ...Object.keys(saved?.platforms || {})].filter(Boolean);
// 工作分配里记的是执行者 id；页面按平台展示，把同一程序上的执行者映射到该平台 id。
function rolesByPlatform(raw, platforms, roles) {
  const toPlatform = id => {
    const agent = raw.agents?.[id];
    if (!agent) return id;
    return platforms.find(p => p.id === id || hostKey(raw.agents[p.id] || {}) === hostKey(agent))?.id || id;
  };
  return Object.fromEntries(ROLES.map(role => [role, { primary: toPlatform(roles[role].primary), fallback: toPlatform(roles[role].fallback) }]));
}

export function readPlatformModels(config, { catalog = defaultCatalog, policy } = {}) {
  const raw = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  const saved = loadSettings(config);
  const policyRoles = currentRoles(config, policy);
  const platforms = discoverPlatforms(raw, { catalog, preferred: preferredIds(saved, policyRoles) });
  const roles = rolesByPlatform(raw, platforms, policyRoles);
  const suggested = suggestedSettings(platforms, roles);
  return {
    enabled: saved?.enabled === true,
    platforms: platforms.map(platform => ({ ...platform, tiers: saved?.platforms?.[platform.id] || null })),
    roles,
    sessions: saved?.sessions || suggested.sessions,
    suggested,
    lastSaved: saved?.savedAt ? { at: saved.savedAt, backup: saved.backup || null } : null,
  };
}

// ---- 校验 ----
const isTier = value => TIERS.includes(value);
function validate(input, platforms) {
  if (!input || typeof input !== 'object') throw new PlatformModelsError('请求体要是对象');
  const known = new Map(platforms.map(p => [p.id, p]));
  const tiersOf = {};
  for (const [id, tiers] of Object.entries(input.platforms || {})) {
    if (!known.has(id)) throw new PlatformModelsError(`不是已登记的平台：${id}`);
    const filled = TIERS.filter(tier => String(tiers?.[tier] ?? '').trim());
    if (!filled.length) continue; // 全空 = 未配置（新平台）
    if (filled.length !== TIERS.length) throw new PlatformModelsError(`${known.get(id).name} 三档要么都填，要么都不填`);
    tiersOf[id] = {};
    for (const tier of TIERS) {
      const model = String(tiers[tier]).trim();
      if (!MODEL_RE.test(model)) throw new PlatformModelsError(`${known.get(id).name} 的模型名不合法：${model}`);
      tiersOf[id][tier] = model;
    }
  }
  const enabled = input.enabled === true;
  const roles = {};
  for (const role of ROLES) {
    const pair = input.roles?.[role];
    const primary = String(pair?.primary ?? '').trim(); const fallback = String(pair?.fallback ?? '').trim();
    if (!known.has(primary) || !known.has(fallback)) throw new PlatformModelsError(`${role} 的主/备平台必须是已登记的平台`);
    if (primary === fallback) throw new PlatformModelsError(`${role} 的主平台和备用平台不能相同`);
    for (const id of [primary, fallback]) {
      if (WRITE_ROLES.has(role) && known.get(id).access === 'read') throw new PlatformModelsError(`${known.get(id).name} 是只读执行者，不能承担${role === 'dev' ? '开发' : '调度会话'}`);
    }
    if (enabled && (!tiersOf[primary] || !tiersOf[fallback])) throw new PlatformModelsError(`${role} 选的平台还没配齐三档模型`);
    roles[role] = { primary, fallback };
  }
  const coordTier = input.sessions?.coord?.tier;
  if (!isTier(coordTier)) throw new PlatformModelsError('调度会话档位不合法');
  const sessions = { coord: { tier: coordTier } };
  for (const kind of SESSION_KINDS) {
    const item = input.sessions?.[kind];
    const platform = known.get(String(item?.platform ?? ''));
    if (!platform || !platform.sessionCapable) throw new PlatformModelsError(`${kind === 'design' ? '设计' : '普通'}会话的平台目前只能选 Codex 类平台`);
    if (!isTier(item.tier)) throw new PlatformModelsError(`${kind === 'design' ? '设计' : '普通'}会话档位不合法`);
    if (enabled && !tiersOf[platform.id]) throw new PlatformModelsError(`${platform.name} 还没配齐三档模型`);
    sessions[kind] = { platform: platform.id, tier: item.tier };
  }
  return { enabled, platforms: tiersOf, roles, sessions };
}

// ---- rules.json 生成 ----
function tierAgent(base, tier, model) {
  const agent = { ...base, name: `${base.name || 'agent'}·${tier}` };
  if (base.use === 'acp' && Array.isArray(base.command)) {
    const command = [];
    for (let i = 0; i < base.command.length; i++) {
      if (base.command[i] === '--model') { i++; continue; }
      command.push(base.command[i]);
    }
    agent.command = [...command, '--model', model];
    delete agent.model;
  } else agent.model = model;
  return agent;
}

function buildRules(raw, settings, { dagProjects }) {
  const next = JSON.parse(JSON.stringify(raw));
  for (const id of Object.keys(next.agents)) if (parseTierAgent(id)) delete next.agents[id];
  next.rules = next.rules.filter(rule => !(GENERATED_RULE.test(rule.name) && parseTierAgent(rule.to)));
  const coordRules = next.rules.filter(rule => rule.when?.types?.includes('scheduling.message'));
  if (!settings.enabled) {
    for (const rule of coordRules) { const parsed = parseTierAgent(rule.to); if (parsed) rule.to = parsed.platform; }
    return next;
  }
  for (const [platform, tiers] of Object.entries(settings.platforms)) {
    for (const tier of TIERS) next.agents[tierAgentId(platform, tier)] = tierAgent(raw.agents[platform], tier, tiers[tier]);
  }
  // 分档事件类型与派发方同一函数计算（含 64 字符截短），保证「生成的规则」=「派发的事件」。
  const generated = [];
  for (const project of new Set(dagProjects)) {
    for (const role of ['dev', 'review']) {
      const baseType = dagEventType(project, role);
      for (const rule of next.rules) {
        const types = rule.when?.types || [];
        if (types.length !== 1 || types[0] !== baseType || GENERATED_RULE.test(rule.name)) continue;
        for (const tier of TIERS) {
          if (role === 'review' && tier === 'light') continue; // 审阅底线 ≥ standard，便宜档审阅永不派发
          generated.push({ ...JSON.parse(JSON.stringify(rule)), name: `${rule.name}·${tier}`, when: { ...rule.when, types: [dagEventType(project, `${role}.${tier}`)] }, to: tierAgentId(settings.roles[role].primary, tier) });
        }
      }
    }
  }
  next.rules.push(...generated);
  for (const rule of coordRules) rule.to = tierAgentId(settings.roles.coord.primary, settings.sessions.coord.tier);
  return next;
}

function atomicWrite(file, data) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 });
  renameSync(temp, file);
}
const stamp = now => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

export async function applyPlatformModels(config, input, { check, catalog = defaultCatalog, dagProjects = [], now = () => new Date() } = {}) {
  if (typeof check !== 'function') throw new PlatformModelsError('缺少中台配置校验', 500);
  try {
    return await withStateLockAsync(config, async () => {
      const raw = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
      // 与读取接口同一偏好算平台 id（已保存设置 → 当前工作分配），页面提交的 id 才对得上。
      const platforms = discoverPlatforms(raw, { catalog: Object.fromEntries(Object.keys(catalog).map(k => [k, () => null])), preferred: preferredIds(loadSettings(config), currentRoles(config)) });
      const settings = validate(input, platforms);
      const coordNames = new Set(raw.rules.filter(rule => rule.when?.types?.includes('scheduling.message')).map(rule => rule.name));
      const busy = readDetours(config).find(item => item.status === 'detoured' && (parseTierAgent(item.blockedAgent) || item.rules.some(rule => GENERATED_RULE.test(rule.name) || coordNames.has(rule.name))));
      if (busy) throw new PlatformModelsError(`有进行中的频限绕行（${busy.id}）涉及分档或调度会话规则，等它恢复后再保存`, 409);
      const next = buildRules(raw, settings, { dagProjects });
      const policyDoc = readPolicyDoc(config);
      const nextPolicy = { ...policyDoc, defaults: { ...(policyDoc.defaults || {}), ...settings.roles } };
      const at = now();
      const backup = `rules.json.bak-${stamp(at)}-platform-models`;
      const directory = path.dirname(config.rulesFile);
      const draft = path.join(directory, `.console-pm-${process.pid}-${Date.now()}.json`);
      try {
        writeFileSync(draft, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
        await check(config, draft);
        copyFileSync(config.rulesFile, path.join(directory, backup));
        renameSync(draft, config.rulesFile);
      } finally { try { unlinkSync(draft); } catch {} }
      try {
        atomicWrite(path.join(config.root, POLICY_FILE), JSON.stringify(nextPolicy, null, 2) + '\n');
        atomicWrite(settingsPath(config), JSON.stringify({ ...settings, savedAt: at.toISOString(), backup }, null, 2) + '\n');
      } catch (error) {
        copyFileSync(path.join(directory, backup), config.rulesFile); // 规则与设置不一致比不改更糟：回滚规则
        throw new PlatformModelsError(`设置写入失败，规则已回滚：${error.message}`, 500);
      }
      return { saved: true, backup, at: at.toISOString() };
    });
  } catch (error) {
    if (error instanceof DetourError) throw new PlatformModelsError(error.message, 409);
    throw error;
  }
}

// ---- 运行时读取：设计/普通会话启动参数 ----
export function sessionLaunch(config, kind) {
  if (!SESSION_KINDS.includes(kind)) return null;
  const saved = loadSettings(config);
  if (saved?.enabled !== true) return null;
  const item = saved.sessions?.[kind];
  const model = saved.platforms?.[item?.platform]?.[item?.tier];
  let raw;
  try { raw = JSON.parse(readFileSync(config.rulesFile, 'utf8')); } catch { return null; }
  const agent = raw.agents?.[item?.platform];
  if (!agent || !model || !SESSION_USES.has(agent.use)) return null;
  return { platform: item.platform, use: agent.use, tier: item.tier, model, label: agent.name || item.platform };
}
