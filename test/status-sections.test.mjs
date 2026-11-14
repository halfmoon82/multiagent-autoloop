import test from 'node:test';
import assert from 'node:assert/strict';
import { splitRunSections, runLine, projectForRun, projectForCard, matchesProject, collectProjects } from '../public/status-sections.mjs';
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

test('project filter matches exact project identity and passes through empty filter', () => {
  assert.equal(matchesProject('/workspace/demo', ''), true);
  assert.equal(matchesProject('/workspace/demo', '/workspace/demo'), true);
  assert.equal(matchesProject('/workspace/demo', '/workspace/demo2'), false);
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
