import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionArchive, ArchiveError, CONTINUATION_TURNS } from '../src/session-archive.mjs';

const root = () => mkdtempSync(path.join(tmpdir(), 'archive-home-'));

test('save and load round-trips session records with transcripts', async () => {
  const home = root();
  const archive = new SessionArchive(home);
  const record = {
    id: '11111111-2222-3333-4444-555555555555',
    project: '/workspace/demo',
    agent: 'Codex ACP',
    prompt: '首轮调度说明',
    continuedFrom: null,
    messages: [{ role: 'user', text: '看看状态', at: '2026-11-15T01:00:00Z' }, { role: 'agent', text: '正在看', at: '2026-11-15T01:01:00Z' }],
    createdAt: '2026-11-15T01:00:00Z',
    updatedAt: '2026-11-15T01:01:00Z',
    closedAt: null,
    endStatus: 'active',
  };
  await archive.save(record);
  const loaded = await archive.read(record.id);
  assert.equal(loaded.project, '/workspace/demo');
  assert.equal(loaded.kind, 'scheduling', 'legacy archives default to scheduling');
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.endStatus, 'active');
});

test('loading marks still-active sessions as interrupted and persists the flag', async () => {
  const home = root();
  const archive = new SessionArchive(home);
  await archive.save({ id: 'aaaaaaaa-0000-0000-0000-000000000001', project: '/p/a', messages: [], createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:00:00Z', closedAt: null, endStatus: 'active' });
  await archive.save({ id: 'aaaaaaaa-0000-0000-0000-000000000002', project: '/p/b', messages: [], createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:00:00Z', closedAt: '2026-11-15T02:00:00Z', endStatus: 'closed' });
  const { sessions: list } = await archive.loadAllDetailed({ markActive: true });
  const interrupted = list.find(item => item.id.endsWith('1'));
  const closed = list.find(item => item.id.endsWith('2'));
  assert.equal(interrupted.endStatus, 'interrupted', 'a session left active is evidence of a restart');
  assert.equal(closed.endStatus, 'closed', 'explicitly closed sessions stay closed');
  const onDisk = JSON.parse(readFileSync(path.join(home, 'console-sessions', 'aaaaaaaa-0000-0000-0000-000000000001.json'), 'utf8'));
  assert.equal(onDisk.endStatus, 'interrupted', 'the flag is written back');
});

test('archive rejects ids outside the uuid whitelist', async () => {
  const home = root();
  const archive = new SessionArchive(home);
  await assert.rejects(() => archive.read('../escape'), ArchiveError);
  await assert.rejects(() => archive.read('plain-name'), ArchiveError);
});

test('oversized transcripts drop the oldest messages and flag truncation', async () => {
  const home = root();
  const archive = new SessionArchive(home);
  const big = '字'.repeat(4000);
  const messages = Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? 'agent' : 'user', text: big, at: '2026-11-15T01:00:00Z' }));
  const record = { id: 'bbbbbbbb-0000-0000-0000-000000000001', project: '/p/big', messages, createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:00:00Z', closedAt: null, endStatus: 'active' };
  await archive.save(record);
  const loaded = await archive.read(record.id);
  assert.ok(loaded.truncated, 'truncation must be flagged');
  assert.ok(loaded.messages.length < 400, 'oldest messages are dropped');
  assert.equal(loaded.messages.at(-1).text, big, 'the newest message survives');
});

test('corrupt archive files are skipped with a note instead of crashing the list', async () => {
  const home = root();
  const archive = new SessionArchive(home);
  await archive.save({ id: 'cccccccc-0000-0000-0000-000000000001', project: '/p/ok', messages: [], createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:00:00Z', closedAt: null, endStatus: 'closed' });
  writeFileSync(path.join(home, 'console-sessions', 'dddddddd-0000-0000-0000-000000000009.json'), '{broken');
  const { sessions, errors } = await archive.loadAllDetailed();
  assert.equal(sessions.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /dddddddd/);
});

test('completed history is retained and never pruned automatically', async () => {
  const home = root();
  const archive = new SessionArchive(home, { retention: 3 });
  for (let i = 0; i < 5; i++) {
    const id = `eeeeeeee-0000-0000-0000-00000000000${i}`;
    await archive.save({ id, project: `/p/${i}`, messages: [], createdAt: `2026-11-1${i}T01:00:00Z`, updatedAt: `2026-11-1${i}T01:00:00Z`, closedAt: null, endStatus: 'closed' });
  }
  const files = readdirSync(path.join(home, 'console-sessions')).filter(name => name.endsWith('.json') && name !== 'index.json');
  assert.equal(files.length, 5, 'completed sessions remain available even beyond the old retention count');
});

test('continuation prompt carries the last turns and a resume instruction', async () => {
  const home = root();
  const archive = new SessionArchive(home);
  const messages = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'agent' : 'user', text: `消息${i}`, at: '2026-11-15T01:00:00Z' }));
  const record = { id: 'ffffffff-0000-0000-0000-000000000001', project: '/p/demo', agent: 'Codex ACP', prompt: '首轮', continuedFrom: null, messages, createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:00:00Z', closedAt: null, endStatus: 'interrupted' };
  await archive.save(record);
  const prompt = await archive.buildContinuation(record.id);
  assert.match(prompt, /会话续跑/);
  assert.match(prompt, /先简要汇报上次中断时的状态/);
  assert.ok(!prompt.includes('消息0') && !prompt.includes('消息3'), 'older turns are left out');
  assert.ok(prompt.includes('消息4') && prompt.includes('消息13'), `the last ${CONTINUATION_TURNS} turns are included`);
});
