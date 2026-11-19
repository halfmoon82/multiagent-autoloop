import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { archiveSerial, archiveDag, buildArchive, readArchive, planTitles } from '../src/archive.mjs';

const chainOf = (statuses, extra = {}) => ({
  project: '/p/demo', title: '演示任务', plan: Object.keys(statuses), lastEventAt: '2026-11-18T02:00:00Z', ...extra,
  nodes: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status }])),
});

test('串行 100% + .done → 归档为 completed，日期取文件名', () => {
  const entry = { stem: 'demo', archivedAt: '2026-11-18', data: chainOf({ a: 'done', b: 'done', c: 'done' }) };
  const item = archiveSerial(entry);
  assert.equal(item.reason, 'completed');
  assert.equal(item.percent, 100);
  assert.equal(item.archivedAt, '2026-11-18');
  assert.deepEqual(item.nodes, { done: 3, total: 3 });
  assert.equal(item.project, '/p/demo');
  assert.equal(item.taskId, 'serial:/p/demo:demo');
});

test('串行已归档但没跑完 → abandoned', () => {
  const entry = { stem: 'legacy', archivedAt: '2026-11-01', data: chainOf({ a: 'done', b: 'dev_dispatched', c: 'pending' }) };
  const item = archiveSerial(entry);
  assert.equal(item.reason, 'abandoned');
  assert.ok(item.percent < 100);
});

test('串行进行中（活动文件）→ 不归档', () => {
  const entry = { stem: 'mtexec', archivedAt: null, data: chainOf({ a: 'done', b: 'in_progress', c: 'pending' }) };
  assert.equal(archiveSerial(entry), null);
});

test('串行活动文件达到 100% 也视为完成归档', () => {
  const entry = { stem: 'fresh', archivedAt: null, data: chainOf({ a: 'done', b: 'done' }) };
  const item = archiveSerial(entry, { now: new Date('2026-11-19T00:00:00Z') });
  assert.equal(item.reason, 'completed');
  assert.equal(item.archivedAt, '2026-11-18');
});

test('DAG 计划级 run 全部取消 → cancelled', () => {
  const runs = [{ runId: 'r1', planId: 'plan-a', nodeId: '__root__', project: '/p/demo', status: 'cancelled', createdAt: '2026-11-17T01:00:00Z', updatedAt: '2026-11-18T03:00:00Z', nodes: [{}, {}], publish: { nodes: { a: { state: 'cancelled' }, b: { state: 'cancelled' } } } }];
  const [item] = archiveDag(runs, { titles: { 'plan-a': '计划 A' } });
  assert.equal(item.reason, 'cancelled');
  assert.equal(item.title, '计划 A');
  assert.equal(item.archivedAt, '2026-11-18');
});

test('DAG 最新是 queued、旧 run 已取消 → 仍算进行中，不归档', () => {
  const runs = [
    { runId: 'old', planId: 'plan-b', nodeId: 'n1', status: 'cancelled', createdAt: '2026-11-19T01:00:00Z', nodes: [{}], publish: {} },
    { runId: 'root', planId: 'plan-b', nodeId: '__root__', status: 'queued', createdAt: '2026-11-19T02:00:00Z', nodes: [{}, {}], publish: { nodes: { a: { state: 'dev' }, b: { state: 'pending' } } } },
  ];
  assert.deepEqual(archiveDag(runs), []);
});

test('DAG 计划级 run done 且节点齐（生产形状 accepted）→ completed', () => {
  // 生产里节点终态是 accepted（dag-controller n.state='accepted'），done 只用于兼容历史记录。
  const runs = [{ runId: 'r', planId: 'plan-c', nodeId: '__root__', status: 'done', createdAt: '2026-11-19T02:00:00Z', updatedAt: '2026-11-19T05:00:00Z', nodes: [{}, {}], publish: { nodes: { a: { state: 'accepted' }, b: { state: 'accepted' } } } }];
  const [item] = archiveDag(runs);
  assert.equal(item.reason, 'completed');
  assert.equal(item.percent, 100);
});

test('DAG 历史形状 done 仍兼容', () => {
  const runs = [{ runId: 'r', planId: 'plan-d', nodeId: '__root__', status: 'done', createdAt: '2026-11-19T02:00:00Z', nodes: [{}], publish: { nodes: { a: { state: 'done' } } } }];
  assert.equal(archiveDag(runs)[0]?.reason, 'completed');
});

test('DAG root done 但仍有节点未 accepted → 不当作完成', () => {
  const runs = [{ runId: 'r', planId: 'plan-e', nodeId: '__root__', status: 'done', createdAt: '2026-11-19T02:00:00Z', nodes: [{}, {}], publish: { nodes: { a: { state: 'accepted' }, b: { state: 'dev' } } } }];
  assert.deepEqual(archiveDag(runs), []);
});

test('DAG unknown 不是终态，不当取消归档', () => {
  const runs = [{ runId: 'r', planId: 'plan-f', nodeId: '__root__', status: 'unknown', createdAt: '2026-11-19T02:00:00Z', nodes: [{}], publish: { nodes: { a: { state: 'pending' } } } }];
  assert.deepEqual(archiveDag(runs), []);
});

test('备份/暂停副本与锁文件不产生重复条目', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'archive-'));
  try {
    const doneChain = JSON.stringify(chainOf({ a: 'done', b: 'done' }));
    writeFileSync(path.join(root, 'dag-serial.json.done-20261118'), doneChain);
    writeFileSync(path.join(root, 'dag-serial.json.done-20261118.bak-preapprove'), doneChain);
    writeFileSync(path.join(root, 'mt-serial.json.paused-20261115'), JSON.stringify(chainOf({ a: 'done', b: 'pending' })));
    mkdirSync(path.join(root, 'dag-runs'));
    writeFileSync(path.join(root, 'dag-runs', 'dagrun-abc.json'), JSON.stringify({ runId: 'dagrun-abc', planId: 'p', nodeId: '__root__', status: 'cancelled', project: '/p/x', createdAt: '2026-11-18T00:00:00Z', nodes: [{}], publish: {} }));
    writeFileSync(path.join(root, 'dag-runs', 'dagrun-abc.controller.lock'), '1');
    const { archived } = readArchive({ root });
    assert.equal(archived.length, 2, JSON.stringify(archived));
    assert.ok(archived.some(item => item.taskId === 'serial:/p/demo:dag'));
    assert.ok(archived.some(item => item.taskId === 'dag:/p/x:p'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('归档按日期倒序，并跨项目保留 project', () => {
  const serial = [
    { stem: 'a', archivedAt: '2026-11-17', data: chainOf({ x: 'done' }, { project: '/p/one' }) },
    { stem: 'b', archivedAt: '2026-11-18', data: chainOf({ x: 'done' }, { project: '/p/two' }) },
  ];
  const items = buildArchive({ serial });
  assert.deepEqual(items.map(item => item.archivedAt), ['2026-11-18', '2026-11-17']);
  assert.deepEqual(new Set(items.map(item => item.project)), new Set(['/p/one', '/p/two']));
});

test('同一任务只保留一条归档', () => {
  const serial = [
    { stem: 'dup', archivedAt: '2026-11-17', data: chainOf({ x: 'done' }) },
    { stem: 'dup', archivedAt: '2026-11-18', data: chainOf({ x: 'done' }) },
  ];
  assert.equal(buildArchive({ serial }).length, 1);
});

test('planTitles 读取计划标题，读不到回退 planId', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'plans-'));
  try {
    mkdirSync(path.join(root, 'docs', 'dag-plans'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'dag-plans', 'p1.json'), JSON.stringify({ plan_id: 'p1', title: '标题一', nodes: [] }));
    const titles = planTitles([root, '/nonexistent']);
    assert.equal(titles.p1, '标题一');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('跨项目同名 planId 不互相吞并', () => {
  const base = { nodeId: '__root__', status: 'done', createdAt: '2026-11-19T02:00:00Z', nodes: [{}], publish: { nodes: { a: { state: 'accepted' } } } };
  const items = archiveDag([
    { ...base, runId: 'r1', planId: 'same-plan', project: '/p/one' },
    { ...base, runId: 'r2', planId: 'same-plan', project: '/p/two' },
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(new Set(items.map(item => item.project)), new Set(['/p/one', '/p/two']));
});

test('跑完后计划删过节点（done > total）仍算完成', () => {
  const runs = [{ runId: 'r', planId: 'plan-g', nodeId: '__root__', status: 'done', project: '/p/demo', createdAt: '2026-11-19T02:00:00Z', nodes: [{}, {}], publish: { nodes: { a: { state: 'accepted' }, b: { state: 'accepted' }, gone: { state: 'accepted' } } } }];
  assert.equal(archiveDag(runs)[0]?.reason, 'completed');
});
