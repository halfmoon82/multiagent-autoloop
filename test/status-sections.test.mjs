import test from 'node:test';
import assert from 'node:assert/strict';
import { splitRunSections, runLine, projectForRun, projectForCard, matchesProject, collectProjects, ruleProject, scopedTotals, scopedSpending, timersForProject, sessionProgress, projectActivity, latestChainsByProject, chainUsage } from '../public/status-sections.mjs';
import { formatCost } from '../public/format.mjs';
const snapshot = { models: { claude: '默认模型' }, runs: [
  { id: 1, rule: '开发', state: 'claimed', summary: '正在改' },
  { id: 2, rule: '部署', state: 'queued', attempts: 3, error: '连接失败' },
  { id: 3, rule: '旧任务', state: 'done', finishedAt: '2026-11-13T01:00:00Z', summary: '完成' },
  { id: 4, rule: '失联任务', state: 'unknown', summary: '' },
  { id: 5, rule: '昨日任务', state: 'done', finishedAt: '2026-11-12T15:00:00Z', summary: '昨天' },
]};
test('splits running, retrying, today and attention sections', () => {
  const result = splitRunSections(snapshot, snapshot.models, new Date('2026-11-13T08:00:00'));
  assert.deepEqual(result.running.map(x => x.id), [1]);
  assert.deepEqual(result.retrying.map(x => x.id), [2]);
  assert.equal(result.retrying[0].status, '等待重试');
  assert.deepEqual(result.doneToday.map(x => x.id), [3]);
  assert.deepEqual(result.needsAttention.map(x => x.id), [4]);
});

test('run lines include model and billing status', () => {
  const paid = runLine({ id: 9, rule: '审阅', agent: 'claude', state: 'done', summary: '完成', usage: { input: 92, output: 10, cost: 1.5 } }, { claude: '默认模型' });
  assert.equal(paid.model, '默认模型'); assert.equal(paid.billing, '$1.50');
  const unpaid = runLine({ id: 10, rule: '开发', agent: 'workbuddy', state: 'done', usage: { input: 100, output: 10 } }, { workbuddy: 'hy4free' });
  assert.equal(unpaid.model, 'hy4free'); assert.equal(unpaid.billing, '110 Token · 费用未上报');
});

test('in-flight rounds show the triggering event summary and stable subject when the run has no text', () => {
  // 主人强制需求（#75）：run 无 text 时条目只剩规则名，必须回退到触发事件的 summary/subject。
  const withEvent = runLine({ id: 5567, rule: '环形视图统一', state: 'claimed', summary: '', error: '',
    events: [{ source: 'local', type: 'run.manual', subject: 'ring-unify-75', summary: 'owner 手动运行' }] });
  assert.equal(withEvent.taskSummary, 'owner 手动运行');
  assert.equal(withEvent.taskNumber, 'ring-unify-75');

  const mixedEvents = runLine({ id: 5563, rule: '费用聚合开发', state: 'claimed', summary: '', error: '',
    events: [
      { source: 'schedule', type: 'schedule.tick', subject: '', summary: '' },
      { source: 'chain', type: 'dag.node.dev', subject: 'node-cost-agg', summary: '费用聚合节点开发' },
    ] });
  assert.equal(mixedEvents.taskSummary, '费用聚合节点开发', 'pick the meaningful triggering event, not an empty schedule tick');
  assert.equal(mixedEvents.taskNumber, 'node-cost-agg');

  const noSummary = runLine({ id: 5565, rule: '调度异常扫描', state: 'queued', attempts: 2, summary: '', error: '',
    events: [{ source: 'schedule', type: 'schedule.tick', subject: '', summary: '' }] });
  assert.equal(noSummary.taskSummary, '调度异常扫描', 'no run text and no event summary must show the rule name truthfully');
  assert.equal(noSummary.taskNumber, '5565', 'without a stable subject the visible round id is used as the number');

  const realText = runLine({ id: 4, rule: '开发', state: 'claimed', summary: '正在改',
    events: [{ subject: 'x', summary: '事件摘要' }] });
  assert.equal(realText.taskSummary, '正在改', 'run text wins over event summary');
  assert.equal(realText.taskNumber, 'x');

  const sectioned = splitRunSections({ runs: [{ id: 5567, rule: '环形视图统一', state: 'claimed', summary: '',
    events: [{ subject: 'ring-unify-75', summary: 'owner 手动运行' }] }] }, {}, new Date());
  assert.equal(sectioned.running[0].taskSummary, 'owner 手动运行');
  assert.equal(sectioned.running[0].taskNumber, 'ring-unify-75');
});

test('task lines identify their project from run data or the matching rule workdir', () => {
  const rules = [{ name: '开发', cwd: '/workspace/demo' }, { name: '部署', cwd: '/workspace/deploy' }];
  assert.equal(projectForRun({ project: '显式项目' }, rules), '显式项目');
  assert.equal(projectForRun({ cwd: '/workspace/run-cwd' }, rules), '/workspace/run-cwd');
  assert.equal(projectForRun({ rule: '开发' }, rules), '/workspace/demo');
  assert.equal(projectForRun({ rule: '不存在' }, rules), '未识别');
  assert.equal(runLine({ id: 11, rule: '开发', state: 'claimed' }, {}, rules).project, '/workspace/demo');
  assert.equal(splitRunSections({ runs: [{ id: 12, rule: '部署', state: 'claimed' }] }, {}, new Date(), rules).running[0].project, '/workspace/deploy');
});

test('decision cards never infer project from a title collision with a rule name', () => {
  const rules = [{ name: '开发', cwd: '/workspace/demo' }];
  assert.equal(projectForCard({ title: '开发', text: '卡片标题与规则同名' }, rules), '未识别');
  assert.equal(projectForCard({ title: '开发', project: '显式卡片项目' }, rules), '显式卡片项目');
  assert.equal(projectForCard({ title: '开发', cwd: '/workspace/card' }, rules), '/workspace/card');
});

test('decision cards fall back to their creating rule workdir so cards can be grouped by project', () => {
  const rules = [{ name: 'V6开发', cwd: '/home/alice/projects/guide-app' }, { name: 'V6审阅', cwd: '/home/alice/projects/guide-app' }];
  assert.equal(projectForCard({ title: '责任闭环怎么拆', rule: 'V6开发' }, rules), '/home/alice/projects/guide-app', 'cards created by a rule belong to that rule project');
  assert.equal(projectForCard({ title: '另一个项目', rule: 'V6审阅' }, rules), '/home/alice/projects/guide-app');
  assert.equal(projectForCard({ title: '未知规则', rule: '不存在的规则' }, rules), '未识别');
  assert.equal(projectForCard({ title: '标题撞名但不是同规则', rule: 'V6开发', project: '/explicit/elsewhere' }, rules), '/explicit/elsewhere', 'explicit card project still wins');
  assert.equal(matchesProject(projectForCard({ rule: 'V6开发' }, rules), 'guide-app'), true, 'the rule-derived project must match the project filter by basename');
});

test('project filter matches by project basename across identifier styles', () => {
  assert.equal(matchesProject('/workspace/demo', ''), true);
  assert.equal(matchesProject('/workspace/demo', '/workspace/demo'), true);
  assert.equal(matchesProject('/workspace/demo', 'owner/demo'), true);
  assert.equal(matchesProject('/workspace/demo', '/workspace/demo2'), false);
  assert.equal(matchesProject('/alpha/demo', '/beta/demo'), true);
  assert.equal(matchesProject('未识别', '未识别'), true);
  assert.equal(matchesProject('', ''), true);
});

test('collectProjects gathers unique project identities across rules, runs, cards and sessions', () => {
  const rules = [{ name: '开发', cwd: '/workspace/demo' }];
  const projects = collectProjects({
    rules,
    runs: [{ rule: '开发' }, { project: '/elsewhere/beta' }, { project: '/elsewhere/beta' }],
    cards: [{}, { project: '显式卡片项目' }],
    sessions: [{ project: 'owner/demo' }, {}],
  });
  assert.deepEqual(projects, ['/workspace/demo', '/elsewhere/beta', '未识别', '显式卡片项目', 'owner/demo']);
});

test('ruleProject resolves a rule line to its workdir project', () => {
  const rules = [{ name: '开发', cwd: '/workspace/demo' }];
  assert.equal(ruleProject(rules, '开发'), '/workspace/demo');
  assert.equal(ruleProject(rules, '不存在'), '未识别');
});

test('scopedTotals and scopedSpending aggregate hub rule lines for one project only', () => {
  const rules = [{ name: '开发', cwd: '/workspace/demo' }, { name: '部署', cwd: '/elsewhere/beta' }];
  const snapshot = { lines: [
    { name: '开发', totals: { running: 1, queued: 2, retrying: 1, unknown: 0, done: 2, nothing: 1, doneToday: 3, usage: { input: 900, output: 100, cost: 0.5 } } },
    { name: '部署', totals: { running: 5, queued: 5, retrying: 5, unknown: 1, done: 1, nothing: 0, doneToday: 9, usage: { input: 7, output: 3 } } },
  ] };
  assert.deepEqual(scopedTotals(snapshot, rules, 'owner/demo'), { running: 1, queued: 2, retrying: 1, unknown: 0, doneToday: 3 });
  assert.deepEqual(scopedSpending(snapshot, rules, 'owner/demo'), { tokens: 1000, rounds: 3, cost: 0.5, missingCost: 0 });
  const unpaid = scopedSpending(snapshot, rules, 'beta');
  assert.equal(unpaid.cost, undefined, 'no line reported cost must stay unreported');
  assert.equal(unpaid.missingCost, unpaid.rounds);
  assert.equal(scopedSpending(snapshot, rules, '') , null, 'no filter falls back to hub totals');
});

test('timersForProject keeps only timers of rules inside the filtered project', () => {
  const rules = [{ name: '开发', cwd: '/workspace/demo' }, { name: '部署', cwd: '/elsewhere/beta' }];
  const timers = [{ rule: '开发', at: '2026-11-14T01:00:00Z' }, { rule: '部署', at: '2026-11-14T02:00:00Z' }, { rule: '未知规则', at: '2026-11-14T03:00:00Z' }];
  assert.deepEqual(timersForProject(timers, rules, '').length, 3);
  assert.deepEqual(timersForProject(timers, rules, 'demo').map(timer => timer.rule), ['开发']);
  assert.deepEqual(timersForProject(timers, rules, 'beta').map(timer => timer.rule), ['部署']);
});

test('sessionProgress aggregates the tasks owned by one scheduling session project', () => {
  const rules = [{ name: '开发', cwd: '/workspace/demo' }, { name: '部署', cwd: '/elsewhere/beta' }];
  const lines = [
    { name: '开发', totals: { running: 1, queued: 1, retrying: 0, unknown: 0, done: 4, nothing: 1, doneToday: 2, usage: { input: 100, output: 20, cost: 0.25 } } },
    { name: '部署', totals: { running: 9, queued: 9, retrying: 9, unknown: 9, done: 9, nothing: 9, doneToday: 9, usage: { input: 9, output: 9, cost: 9 } } },
  ];
  const progress = sessionProgress({ project: 'owner/demo' }, rules, lines);
  assert.equal(progress.finished, 5);
  assert.equal(progress.totalRounds, 7);
  assert.equal(progress.doneToday, 2);
  assert.equal(progress.waiting, 1);
  assert.equal(progress.running, 1);
  assert.ok(Math.abs(progress.ratio - 5 / 7) < 1e-9);
  assert.equal(progress.cost, 0.25);
  const idle = sessionProgress({ project: '/nowhere/empty' }, rules, lines);
  assert.equal(idle.totalRounds, 0);
  assert.equal(idle.ratio, null, 'a session without rules has no progress bar');
});

test('scopedSpending keeps per-line unreported rounds mixed with reported cost', () => {
  const rules = [{ name: '开发', cwd: '/workspace/demo' }, { name: '联调', cwd: '/workspace/demo' }];
  const snapshot = { lines: [
    { name: '开发', totals: { done: 2, nothing: 0, usage: { input: 100, output: 10, cost: 0.5 } } },
    { name: '联调', totals: { done: 1, nothing: 2, usage: { input: 7, output: 3 } } },
  ] };
  const spending = scopedSpending(snapshot, rules, 'demo');
  assert.equal(spending.rounds, 5);
  assert.equal(spending.cost, 0.5);
  assert.equal(spending.missingCost, 3, 'unreported lines must keep their finished rounds unreported');
  assert.equal(formatCost(spending), '$0.50（3 轮未报）', 'mixed reporting must show the unreported count like the hub does');
});

test('latestChainsByProject keeps only the most recently updated chain per project', () => {
  const chains = [
    { sourceFile: 'phase1-serial.json', project: '/repos/health', percent: 100, updatedAt: '2026-11-15T09:58:00.000Z' },
    { sourceFile: 'mt-serial.json', project: '/repos/health', percent: 0, updatedAt: '2026-11-15T12:00:00.000Z' },
    { sourceFile: 'v6-serial.json', project: '/repos/guide-app', percent: 40, updatedAt: '2026-11-15T11:00:00.000Z' },
  ];
  const result = latestChainsByProject(chains);
  assert.deepEqual(result.map(chain => chain.sourceFile), ['mt-serial.json', 'v6-serial.json']);
});

test('latestChainsByProject matches projects by basename and treats missing updatedAt as oldest', () => {
  const chains = [
    { sourceFile: 'a-serial.json', project: '/repos/health', updatedAt: '2026-11-15T09:00:00.000Z' },
    { sourceFile: 'b-serial.json', project: '/Volumes/backup/health', updatedAt: null },
    { sourceFile: 'c-serial.json', project: '/repos/other', updatedAt: null },
  ];
  const result = latestChainsByProject(chains);
  assert.deepEqual(result.map(chain => chain.sourceFile), ['a-serial.json', 'c-serial.json']);
});

test('latestChainsByProject keeps a single chain per project untouched and tolerates empty input', () => {
  const single = [{ sourceFile: 'only-serial.json', project: '/repos/one', updatedAt: null }];
  assert.deepEqual(latestChainsByProject(single), single);
  assert.deepEqual(latestChainsByProject([]), []);
});

test('run lines name the executing agent and never pad unknown models with a default label', () => {
  const named = runLine({ id: 13, rule: '开发', agent: 'codex', state: 'claimed', summary: '正在改' }, { codex: 'kimi-for-coding' }, [], { codex: 'Codex' });
  assert.equal(named.agent, 'Codex');
  const raw = runLine({ id: 14, rule: '巡检', agent: 'demo-scan', state: 'claimed', summary: '扫描中' }, {}, []);
  assert.equal(raw.agent, 'demo-scan');
  assert.equal(raw.model, '未配置');
  const missing = runLine({ id: 15, rule: '旧数据', state: 'claimed', summary: '无 agent 字段' }, {}, []);
  assert.equal(missing.agent, '');
  const sections = splitRunSections({ runs: [{ id: 16, rule: '开发', agent: 'codex', state: 'claimed' }] }, { codex: 'kimi-for-coding' }, new Date(), [], { codex: 'Codex' });
  assert.equal(sections.running[0].agent, 'Codex');
});

// ---- 链级累计用量（2026-11-16）：Hub 真实形态是 totals.usage ----

test('aggregateLines reads usage from totals.usage, the real hub state shape', () => {
  const rules = [{ name: '开发', cwd: '/workspace/demo' }];
  const lines = [
    { name: '开发', totals: { running: 0, queued: 0, retrying: 0, unknown: 0, done: 2, nothing: 0, doneToday: 1, usage: { input: 300, output: 50, cost: 0.7 } } },
  ];
  const activity = projectActivity('/workspace/demo', rules, lines);
  assert.equal(activity.tokens, 350);
  assert.ok(Math.abs(activity.cost - 0.7) < 1e-9);
});

test('chainUsage sums only the rules of one serial chain by file-stem prefix', () => {
  const rules = [
    { name: 'V6串行推进', cwd: '/workspace/v6' }, { name: 'V6开发', cwd: '/workspace/v6' },
    { name: 'V6审阅', cwd: '/workspace/v6' }, { name: 'V6x实验', cwd: '/elsewhere' },
    { name: 'MT开发', cwd: '/workspace/v6' },
  ];
  const lines = [
    { name: 'V6串行推进', totals: { done: 1, nothing: 0, usage: { input: 100, output: 20, cost: 0.1 } } },
    { name: 'V6开发', totals: { done: 2, nothing: 0, usage: { input: 200, output: 40, cost: 0.2 } } },
    { name: 'V6审阅', totals: { done: 3, nothing: 0, usage: { input: 300, output: 60, cost: 0.3 } } },
    { name: 'V6x实验', totals: { done: 9, nothing: 0, usage: { input: 900, output: 90, cost: 9 } } },
    { name: 'MT开发', totals: { done: 9, nothing: 0, usage: { input: 900, output: 90, cost: 9 } } },
  ];
  const usage = chainUsage({ sourceFile: 'v6-serial.json' }, rules, lines);
  assert.equal(usage.tokens, 720);
  assert.ok(Math.abs(usage.cost - 0.6) < 1e-9);
  assert.equal(usage.rounds, 6);
});

test('chainUsage marks cost unreported when no matched line ever reported one', () => {
  const rules = [{ name: 'V6开发', cwd: '/workspace/v6' }];
  const lines = [{ name: 'V6开发', totals: { done: 2, nothing: 1, usage: { input: 100, output: 10 } } }];
  const usage = chainUsage({ sourceFile: 'v6-serial.json' }, rules, lines);
  assert.equal(usage.tokens, 110);
  assert.equal(usage.cost, undefined);
  assert.equal(usage.missingCostRounds, 3);
});

test('chainUsage of an unknown chain file reports zero without throwing', () => {
  const usage = chainUsage({ sourceFile: 'nope-serial.json' }, [{ name: 'V6开发' }], [{ name: 'V6开发', totals: { usage: { input: 1 } } }]);
  assert.equal(usage.tokens, 0);
  assert.equal(usage.cost, undefined);
});

test('chainUsage falls back to unclaimed project rules when the stem matches nothing', () => {
  const health = '/workspace/health';
  const rules = [
    { name: 'Phase1开发', cwd: health }, { name: 'Phase1审阅', cwd: health },
    { name: 'MT开发', cwd: health }, { name: 'MT审阅', cwd: health },
    { name: '执行波开发', cwd: health }, { name: 'Intervals凭据门禁', cwd: health },
    { name: 'V6开发', cwd: '/workspace/v6' },
  ];
  const lines = [
    { name: 'Phase1开发', totals: { done: 1, nothing: 0, usage: { input: 100, output: 10, cost: 1 } } },
    { name: 'MT开发', totals: { done: 1, nothing: 0, usage: { input: 200, output: 20, cost: 2 } } },
    { name: '执行波开发', totals: { done: 1, nothing: 0, usage: { input: 400, output: 40, cost: 4 } } },
    { name: 'Intervals凭据门禁', totals: { done: 1, nothing: 0, usage: { input: 800, output: 80, cost: 8 } } },
    { name: 'V6开发', totals: { done: 1, nothing: 0, usage: { input: 900, output: 90, cost: 9 } } },
  ];
  const chains = [
    { sourceFile: 'phase1-serial.json', project: health },
    { sourceFile: 'mtexec-serial.json', project: health },
  ];
  const phase1 = chainUsage(chains[0], rules, lines, chains);
  assert.equal(phase1.tokens, 110); // 词干命中，只算 Phase1*
  const mtexec = chainUsage(chains[1], rules, lines, chains);
  assert.equal(mtexec.tokens, 220 + 440 + 880); // 回退：项目剩余（MT* + 执行波* + Intervals*），不含 Phase1* 与别的项目
  assert.ok(Math.abs(mtexec.cost - 14) < 1e-9);
});

test('chainUsage fallback without sibling chains takes all project rules', () => {
  const rules = [{ name: '执行波开发', cwd: '/workspace/health' }];
  const lines = [{ name: '执行波开发', totals: { done: 1, nothing: 0, usage: { input: 50, output: 5, cost: 0.5 } } }];
  const usage = chainUsage({ sourceFile: 'mtexec-serial.json', project: '/workspace/health' }, rules, lines, []);
  assert.equal(usage.tokens, 55);
});
