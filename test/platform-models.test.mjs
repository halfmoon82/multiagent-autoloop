import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  discoverPlatforms, readPlatformModels, applyPlatformModels, suggestedSettings, sessionLaunch, sessionPlatforms, tierAgentId, parseTierAgent, PlatformModelsError,
} from '../src/platform-models.mjs';
import { loadEnabledTiers } from '../src/dag-tier.mjs';
import { resolveFallback, loadPolicy } from '../src/detour-policy.mjs';

const catalog = { acp: () => ['hy4flash-free', 'hy4std', 'deepseek-v4-pro'], codex: () => ['deepseek-v4.1-flash', 'kimi-for-coding', 'k3.1-pro'], claude: () => ['haiku', 'sonnet', 'opus'] };
const baseRules = () => ({
  sources: { local: { name: 'local' } },
  agents: {
    workbuddy: { name: 'WorkBuddy AI', worker: 'w', use: 'acp', command: ['/bin/wb.sh', '--acp'], access: 'full' },
    claude: { name: 'Claude Code', worker: 'w', use: 'claude', access: 'full', model: 'claude-sonnet-5-5' },
    'codex-full': { name: 'Codex 可写调度', worker: 'w', use: 'codex', access: 'full' },
    scan: { name: 'scan', worker: 'w', use: 'command', command: ['/bin/scan'] },
  },
  rules: [
    { name: 'DAG自动开发', when: { source: 'local', types: ['dag.auto.dev'] }, to: 'workbuddy', cwd: '/p/auto', prompt: 'dev', parallel: 5, resume: false },
    { name: 'DAG自动审阅', when: { source: 'local', types: ['dag.auto.review'] }, to: 'claude', cwd: '/p/auto', prompt: 'review', resume: false },
    { name: '旧链开发', when: { source: 'local', types: ['dag.node.dev'] }, to: 'workbuddy', cwd: '/p/auto', prompt: 'x', resume: false },
    { name: '调度会话执行', when: { source: 'local', types: ['scheduling.message'] }, to: 'codex-full', cwd: '/p/auto', prompt: 's', resume: true },
  ],
});
const setup = (rules = baseRules()) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-'));
  const config = { root, rulesFile: path.join(root, 'rules.json') };
  writeFileSync(config.rulesFile, JSON.stringify(rules, null, 2));
  return config;
};
const rulesOf = config => JSON.parse(readFileSync(config.rulesFile, 'utf8'));
const settings = (over = {}) => ({
  enabled: true,
  platforms: {
    workbuddy: { light: 'hy4flash-free', standard: 'hy4std', heavy: 'deepseek-v4-pro' },
    claude: { light: 'haiku', standard: 'claude-sonnet-5-5', heavy: 'opus' },
    'codex-full': { light: 'deepseek-v4.1-flash', standard: 'kimi-for-coding', heavy: 'k3.1-pro' },
  },
  roles: { dev: { primary: 'workbuddy', fallback: 'claude' }, review: { primary: 'claude', fallback: 'codex-full' }, coord: { primary: 'codex-full', fallback: 'claude' } },
  sessions: { coord: { tier: 'light' }, design: { platform: 'codex-full', tier: 'standard' }, normal: { platform: 'codex-full', tier: 'light' } },
  ...over,
});
const opts = { check: async () => {}, catalog, dagProjects: ['/p/auto'] };

test('平台自动发现：只列 AI 执行者，排除脚本与生成的分档执行者；带默认模型与可选模型', () => {
  const raw = baseRules();
  raw.agents['workbuddy-tier-light'] = { ...raw.agents.workbuddy };
  raw.agents.gemini = { name: 'Gemini CLI', worker: 'w', use: 'gemini', access: 'full' };
  const list = discoverPlatforms(raw, { catalog });
  assert.deepEqual(list.map(p => p.id).sort(), ['claude', 'codex-full', 'gemini', 'workbuddy']);
  assert.deepEqual(list.find(p => p.id === 'claude').models, ['haiku', 'sonnet', 'opus', 'claude-sonnet-5-5'], '平台默认模型总在可选清单里');
  assert.equal(list.find(p => p.id === 'claude').defaultModel, 'claude-sonnet-5-5');
  assert.equal(list.find(p => p.id === 'gemini').models, null, '读不到清单 → 手填');
  assert.equal(list.find(p => p.id === 'codex-full').sessionCapable, true);
  assert.equal(list.find(p => p.id === 'workbuddy').sessionCapable, true, 'WorkBuddy 经 ACP 接入会话（安全靠控制台权限矩阵 + 决策卡）');
  assert.equal(list.find(p => p.id === 'claude').sessionCapable, true, 'Claude Code 经 claude-agent-acp 接入会话');
  assert.equal(list.find(p => p.id === 'gemini').sessionCapable, false, '没有会话适配器的程序不可选');
});

test('平台 = 宿主程序：同一程序上的多个执行者合并为一个平台，模板优先选工作分配在用、可写的执行者', () => {
  const raw = baseRules();
  // 复现本机：Codex 程序上有只读 codex、项目专用 liuxue-heal、通用 codex-full 三个执行者，且前两个登记在前
  raw.agents = { codex: { name: 'Codex', worker: 'w', use: 'codex', access: 'read' }, 'liuxue-heal': { name: '留学辅导自愈', worker: 'w', use: 'codex', access: 'full' }, ...raw.agents };
  raw.agents.feishu = { name: '飞书通知', worker: 'w', use: 'feishu', access: 'read' };
  const list = discoverPlatforms(raw, { catalog, preferred: ['codex-full', 'claude'] });
  const codex = list.filter(p => p.use === 'codex');
  assert.equal(codex.length, 1, 'Codex 程序只算一个平台');
  assert.equal(codex[0].id, 'codex-full', '模板选工作分配在用的可写执行者');
  assert.equal(codex[0].name, 'Codex', '显示平台名，不显示执行者名');
  assert.ok(!list.some(p => p.id === 'liuxue-heal' || p.name === '留学辅导自愈'));
  assert.ok(!list.some(p => p.use === 'feishu'), '通知渠道不是 AI 宿主平台');
  // 没有偏好时：可写优先，不选只读
  assert.equal(discoverPlatforms(raw, { catalog }).find(p => p.use === 'codex').access, 'full');
  // 不同 ACP 程序是不同平台
  raw.agents.kimi = { name: 'Kimi CLI', worker: 'w', use: 'acp', command: ['/bin/kimi', '--acp'], access: 'full' };
  assert.equal(discoverPlatforms(raw, { catalog }).filter(p => p.use === 'acp').length, 2);
});

test('分档执行者 id 只用小写字母数字横线，可反解', () => {
  assert.equal(tierAgentId('codex-full', 'heavy'), 'codex-full-tier-heavy');
  assert.deepEqual(parseTierAgent('codex-full-tier-heavy'), { platform: 'codex-full', tier: 'heavy' });
  assert.equal(parseTierAgent('codex-full'), null);
});

test('保存：生成平台×档位执行者、DAG 分档规则、调度会话规则指向档位执行者，并写主备与会话设置', async () => {
  const config = setup();
  await applyPlatformModels(config, settings(), opts);
  const raw = rulesOf(config);
  assert.deepEqual(raw.agents['workbuddy-tier-standard'].command, ['/bin/wb.sh', '--acp', '--model', 'hy4std']);
  assert.equal(raw.agents['claude-tier-heavy'].model, 'opus');
  assert.equal(raw.agents['codex-full-tier-light'].model, 'deepseek-v4.1-flash');
  const byType = t => raw.rules.find(r => r.when.types?.includes(t));
  assert.equal(byType('dag.auto.dev.light').to, 'workbuddy-tier-light');
  assert.equal(byType('dag.auto.dev.heavy').to, 'workbuddy-tier-heavy');
  assert.equal(byType('dag.auto.dev.heavy').parallel, 5);
  assert.equal(byType('dag.auto.review.heavy').to, 'claude-tier-heavy');
  assert.equal(byType('dag.auto.review.light'), undefined, '审阅不会用便宜档，不生成');
  assert.equal(byType('dag.node.dev.light'), undefined, '非已知项目的旧链不生成');
  assert.equal(byType('dag.auto.dev').to, 'workbuddy', '原规则保留作兜底');
  assert.equal(byType('scheduling.message').to, 'codex-full-tier-light');
  const policy = loadPolicy(config);
  assert.deepEqual(policy.defaults.review, { primary: 'claude', fallback: 'codex-full' });
  assert.ok(readdirSync(config.root).some(f => /^rules\.json\.bak-.*platform-models$/.test(f)), '保存前自动备份');
  const saved = readPlatformModels(config, { catalog });
  assert.equal(saved.enabled, true);
  assert.ok(saved.lastSaved.backup);
});

test('重复保存幂等；改主平台后生成规则跟着改，不残留旧的', async () => {
  const config = setup();
  await applyPlatformModels(config, settings(), opts);
  await applyPlatformModels(config, settings({ roles: { ...settings().roles, dev: { primary: 'codex-full', fallback: 'claude' } } }), opts);
  const raw = rulesOf(config);
  assert.equal(raw.rules.filter(r => r.when.types?.includes('dag.auto.dev.light')).length, 1);
  assert.equal(raw.rules.find(r => r.when.types?.includes('dag.auto.dev.light')).to, 'codex-full-tier-light');
});

test('关闭：清掉生成的执行者与规则，调度会话规则回到主平台，DAG 回落原事件类型', async () => {
  const config = setup();
  await applyPlatformModels(config, settings(), opts);
  assert.deepEqual([...loadEnabledTiers(config.root)].sort(), ['heavy', 'light', 'standard']);
  await applyPlatformModels(config, settings({ enabled: false }), opts);
  const raw = rulesOf(config);
  assert.ok(!Object.keys(raw.agents).some(id => parseTierAgent(id)));
  assert.ok(!raw.rules.some(r => parseTierAgent(r.to)));
  assert.equal(raw.rules.find(r => r.when.types?.includes('scheduling.message')).to, 'codex-full');
  assert.deepEqual([...loadEnabledTiers(config.root)], []);
});

test('校验：开启时主/备必须是三档配齐的平台；会话平台须能开会话；档位与模型合法', async () => {
  const config = setup();
  const bad = [
    settings({ roles: { ...settings().roles, dev: { primary: 'scan', fallback: 'claude' } } }),
    settings({ roles: { ...settings().roles, dev: { primary: 'workbuddy', fallback: 'workbuddy' } } }),
    settings({ platforms: { ...settings().platforms, workbuddy: { light: 'hy4flash-free', standard: '', heavy: 'x' } } }),
    settings({ sessions: { ...settings().sessions, design: { platform: 'scan', tier: 'light' } } }),
    settings({ sessions: { ...settings().sessions, normal: { platform: 'nope', tier: 'light' } } }),
    settings({ sessions: { ...settings().sessions, coord: { tier: 'huge' } } }),
    settings({ platforms: { ...settings().platforms, claude: { light: 'a b', standard: 'x', heavy: 'y' } } }),
  ];
  for (const input of bad) await assert.rejects(() => applyPlatformModels(config, input, opts), PlatformModelsError);
  assert.deepEqual(rulesOf(config), baseRules(), '校验失败不写任何东西');
});

test('只读执行者不能选作开发/调度会话主备（审阅可以）', async () => {
  const rules = baseRules(); rules.agents.claude.access = 'read';
  const config = setup(rules);
  await assert.rejects(() => applyPlatformModels(config, settings(), opts), /只读/, 'dev 备用是只读 claude → 拒绝');
  const ok = settings({ roles: { dev: { primary: 'workbuddy', fallback: 'codex-full' }, review: { primary: 'claude', fallback: 'codex-full' }, coord: { primary: 'codex-full', fallback: 'workbuddy' } } });
  await applyPlatformModels(config, ok, opts);
});

test('超长项目名：分档事件类型按 64 字符截短，与派发方一致', async () => {
  const slug = 'x'.repeat(70);
  const rules = baseRules();
  const { dagEventType } = await import('../src/dag-runtime.mjs');
  const base = dagEventType(`/p/${slug}`, 'dev');
  rules.rules[0].when.types = [base];
  const config = setup(rules);
  await applyPlatformModels(config, settings(), { ...opts, dagProjects: [`/p/${slug}`] });
  const generated = rulesOf(config).rules.filter(r => /·(light|standard|heavy)$/.test(r.name) && r.name.startsWith('DAG自动开发'));
  assert.equal(generated.length, 3);
  for (const rule of generated) {
    assert.ok(rule.when.types[0].length <= 64, rule.when.types[0]);
    const tier = rule.name.split('·')[1];
    assert.equal(rule.when.types[0], dagEventType(`/p/${slug}`, `dev.${tier}`));
  }
});

test('有进行中的频限绕行涉及分档规则或调度会话规则时拒绝保存', async () => {
  const config = setup();
  writeFileSync(path.join(config.root, 'detours.json'), JSON.stringify({ detours: [{ id: 'x', status: 'detoured', blockedAt: '2026-11-19T00:00:00Z', blockedAgent: 'codex-full', evidence: 'e', fallbackAgent: 'claude', rules: [{ name: '调度会话执行', originalTo: 'codex-full' }], probe: { cooldownMinutes: 30 }, lastProbeAt: null, lastProbeOk: null, history: [] }] }));
  await assert.rejects(() => applyPlatformModels(config, settings(), opts), /频限绕行/);
});

test('中台校验失败时 rules.json 不变、其它配置也不写', async () => {
  const config = setup();
  await assert.rejects(() => applyPlatformModels(config, settings(), { ...opts, check: async () => { throw new Error('hub says no'); } }), /hub says no/);
  assert.deepEqual(rulesOf(config), baseRules());
  assert.equal(existsSync(path.join(config.root, 'platform-models.json')), false);
  assert.equal(existsSync(path.join(config.root, 'detour-policy.json')), false);
});

test('频限绕行认档位：主平台的分档执行者被拦 → 备用平台同一档', () => {
  const policy = { defaults: { dev: { primary: 'workbuddy', fallback: 'claude' }, review: { primary: 'claude', fallback: 'codex-full' }, coord: { primary: 'codex-full', fallback: 'claude' } }, projects: {} };
  assert.equal(resolveFallback('dev', 'workbuddy-tier-light', { policy }), 'claude-tier-light');
  assert.equal(resolveFallback('review', 'claude-tier-heavy', { policy }), 'codex-full-tier-heavy');
  assert.equal(resolveFallback('dev', 'claude-tier-light', { policy }), null, '已在备用平台不再往下绕');
  assert.equal(resolveFallback('dev', 'workbuddy', { policy }), 'claude');
});

test('会话启动：按会话类型给出平台、模型与启动方式；未开启时返回空（沿用默认）', async () => {
  const config = setup();
  assert.equal(sessionLaunch(config, 'design'), null);
  await applyPlatformModels(config, settings(), opts);
  assert.deepEqual(sessionLaunch(config, 'design'), { platform: 'codex-full', use: 'codex', tier: 'standard', model: 'kimi-for-coding', label: 'Codex', command: null });
  assert.deepEqual(sessionLaunch(config, 'normal'), { platform: 'codex-full', use: 'codex', tier: 'light', model: 'deepseek-v4.1-flash', label: 'Codex', command: null });
  // 新建会话时显式选平台：不依赖「已开启分档」；WorkBuddy 带上启动命令（去掉旧 --model），Claude Code 用别名模型
  assert.deepEqual(sessionLaunch(config, 'normal', 'workbuddy'), { platform: 'workbuddy', use: 'acp', tier: 'light', model: 'hy4flash-free', label: 'WorkBuddy AI', command: ['/bin/wb.sh', '--acp'] });
  assert.equal(sessionLaunch(config, 'normal', 'claude').use, 'claude');
  assert.equal(sessionLaunch(config, 'normal', 'scan'), null, '脚本类执行者不能开会话');
  assert.equal(sessionLaunch(config, 'normal', 'workbuddy-tier-light'), null, '分档执行者不是平台');
  assert.deepEqual(sessionPlatforms(config, { catalog }).map(p => p.id).sort(), ['claude', 'codex-full', 'workbuddy']);
  assert.equal(sessionLaunch(config, 'scheduling'), null, '调度会话走中台规则，不在这里启动');
});

test('读取接口：同一程序只出一行；工作分配映射到平台；保存后平台 id 稳定、三档不丢', async () => {
  const raw = baseRules();
  raw.agents = { codex: { name: 'Codex', worker: 'w', use: 'codex', access: 'read' }, 'liuxue-heal': { name: '留学辅导自愈', worker: 'w', use: 'codex', access: 'full' }, ...raw.agents };
  const config = setup(raw);
  writeFileSync(path.join(config.root, 'detour-policy.json'), JSON.stringify({ defaults: { review: { primary: 'claude', fallback: 'codex' } } }));
  const data = readPlatformModels(config, { catalog });
  assert.deepEqual(data.platforms.map(p => p.name).sort(), ['Claude Code', 'Codex', 'WorkBuddy AI']);
  assert.equal(data.roles.review.fallback, 'codex-full', '审阅备用记的是只读 codex 执行者 → 映射到 Codex 平台');
  await applyPlatformModels(config, settings(), opts);
  const after = readPlatformModels(config, { catalog });
  assert.equal(after.platforms.find(p => p.use === 'codex').id, 'codex-full');
  assert.deepEqual(after.platforms.find(p => p.use === 'codex').tiers, settings().platforms['codex-full']);
});

test('旧版保存过的设置（每个执行者一行、项目专用执行者排在前）不会让项目专用执行者当模板', async () => {
  const raw = baseRules();
  raw.agents = { codex: { name: 'Codex', worker: 'w', use: 'codex', access: 'read' }, 'liuxue-heal': { name: '留学辅导自愈', worker: 'w', use: 'codex', access: 'full' }, ...raw.agents };
  const config = setup(raw);
  const tiers = { light: 'deepseek-v4.1-flash', standard: 'kimi-for-coding', heavy: 'k3.1-pro' };
  writeFileSync(path.join(config.root, 'platform-models.json'), JSON.stringify({ enabled: false, platforms: { codex: tiers, 'liuxue-heal': tiers, workbuddy: settings().platforms.workbuddy, claude: settings().platforms.claude, 'codex-full': tiers }, sessions: settings().sessions, savedAt: '2026-11-19T05:00:00Z' }));
  const data = readPlatformModels(config, { catalog });
  assert.equal(data.platforms.find(p => p.use === 'codex').id, 'codex-full');
  await applyPlatformModels(config, settings(), opts);
  const saved = rulesOf(config);
  assert.ok(!Object.keys(saved.agents).some(id => id.startsWith('liuxue-heal-tier-')), '不得从项目专用执行者复制分档执行者');
  assert.equal(saved.rules.find(r => r.when.types?.includes('scheduling.message')).to, 'codex-full-tier-light');
});

test('建议值：按平台可选模型由便宜到贵挑三档，挑不到就用平台默认模型', () => {
  const platforms = discoverPlatforms(baseRules(), { catalog });
  const s = suggestedSettings(platforms);
  assert.deepEqual(s.platforms.workbuddy, { light: 'hy4flash-free', standard: 'hy4std', heavy: 'deepseek-v4-pro' });
  assert.deepEqual(s.platforms.claude, { light: 'haiku', standard: 'claude-sonnet-5-5', heavy: 'opus' });
  assert.equal(s.sessions.design.tier, 'light');
});

test('会话预填平台：优先选工作分配里在用的通用平台，不选排在前面的项目专用执行者', () => {
  const raw = baseRules();
  // 复现：项目专用 Codex 执行者登记在通用 codex-full 之前
  raw.agents = { 'liuxue-heal': { name: '留学辅导自愈', worker: 'w', use: 'codex', access: 'full' }, ...raw.agents };
  const platforms = discoverPlatforms(raw, { catalog });
  const roles = { dev: { primary: 'workbuddy', fallback: 'claude' }, review: { primary: 'claude', fallback: 'codex-full' }, coord: { primary: 'codex-full', fallback: 'claude' } };
  const s = suggestedSettings(platforms, roles);
  assert.equal(s.sessions.design.platform, 'codex-full');
  assert.equal(s.sessions.normal.platform, 'codex-full');
  // 工作分配里没有 Codex 时：项目专用执行者也不会被当成平台，Codex 平台的模板仍是通用、可写、被规则引用更多的执行者
  raw.agents = { codex: { name: 'Codex', worker: 'w', use: 'codex', access: 'read' }, ...raw.agents };
  const fallback = suggestedSettings(discoverPlatforms(raw, { catalog }), { dev: { primary: 'workbuddy', fallback: 'claude' }, review: { primary: 'claude', fallback: 'workbuddy' }, coord: { primary: 'workbuddy', fallback: 'claude' } });
  assert.equal(fallback.sessions.design.platform, 'codex-full');
});

test('读取接口：首次进入时会话预填跟随当前工作分配', () => {
  const raw = baseRules();
  raw.agents = { 'liuxue-heal': { name: '留学辅导自愈', worker: 'w', use: 'codex', access: 'full' }, ...raw.agents };
  const config = setup(raw);
  const data = readPlatformModels(config, { catalog });
  assert.equal(data.sessions.design.platform, 'codex-full');
  assert.equal(data.suggested.sessions.normal.platform, 'codex-full');
});
