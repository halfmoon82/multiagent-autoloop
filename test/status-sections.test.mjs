import test from 'node:test';
import assert from 'node:assert/strict';
import { splitRunSections, runLine, projectForRun, projectForCard, matchesProject, collectProjects, ruleProject, scopedTotals, scopedSpending, timersForProject, sessionProgress } from '../public/status-sections.mjs';
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
    { name: '开发', totals: { running: 1, queued: 2, retrying: 1, unknown: 0, done: 2, nothing: 1, doneToday: 3 }, usage: { input: 900, output: 100, cost: 0.5 } },
    { name: '部署', totals: { running: 5, queued: 5, retrying: 5, unknown: 1, done: 1, nothing: 0, doneToday: 9 }, usage: { input: 7, output: 3 } },
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
    { name: '开发', totals: { running: 1, queued: 1, retrying: 0, unknown: 0, done: 4, nothing: 1, doneToday: 2 }, usage: { input: 100, output: 20, cost: 0.25 } },
    { name: '部署', totals: { running: 9, queued: 9, retrying: 9, unknown: 9, done: 9, nothing: 9, doneToday: 9 }, usage: { input: 9, output: 9, cost: 9 } },
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
    { name: '开发', totals: { done: 2, nothing: 0 }, usage: { input: 100, output: 10, cost: 0.5 } },
    { name: '联调', totals: { done: 1, nothing: 2 }, usage: { input: 7, output: 3 } },
  ] };
  const spending = scopedSpending(snapshot, rules, 'demo');
  assert.equal(spending.rounds, 5);
  assert.equal(spending.cost, 0.5);
  assert.equal(spending.missingCost, 3, 'unreported lines must keep their finished rounds unreported');
  assert.equal(formatCost(spending), '$0.50（3 轮未报）', 'mixed reporting must show the unreported count like the hub does');
});
