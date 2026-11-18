import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  HubSchedulingSessionAdapter,
  HubSchedulingError,
  HUB_SCHEDULING_AGENT_LABEL,
  schedulingSubject,
  schedulingEventId,
  buildSchedulingEvent,
  mapHubStateToStatus,
  hubStateCompletionText,
  numericEventId,
  readHubRun,
  matterTurn,
} from '../src/hub-scheduling-session.mjs';
import { SchedulingSessionManager } from '../src/scheduling-session.mjs';
import { postSchedulingEvent, readSchedulingEvent } from '../src/hub.mjs';

const HUB_CONFIG = { hubUrl: 'http://127.0.0.1:9', ownerKey: 'owner-key', sourceKey: 'source-key' };
// 真实中台 POST /v1/events 只接受这些字段；假 Hub 同样拒绝未知字段，防止再次漏网（#89）。
const EVENT_WHITELIST = new Set(['id', 'type', 'subject', 'summary', 'detail', 'link']);
const ARCHIVED_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

// 调度会话首轮 prompt 会落一份资料文件（AGENTS.md/契约/快照）；测试需要一个最小项目夹具。
function fixtureProject() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sched-proj-'));
  writeFileSync(path.join(dir, 'AGENTS.md'), '# 项目规则\n必须 TDD。');
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'docs', 'scheduling-contract.md'), '# 契约');
  return dir;
}

// #92: 假 Hub 必须复刻真实响应形状，杜绝再次形状漏网：
// POST /v1/events -> {event,duplicate,routed,paused}（event 是数字 Hub 事件 id）
// GET  /v1/events/<数字 id> -> {event,routed,paused,runs:[{run,rule,state,...}]}
function fakeHubClient(overrides = {}) {
  const calls = [];
  let nextEventId = overrides.firstEventId ?? 7184;
  const buildRun = () => ({
    run: overrides.runId ?? 6586,
    rule: '调度会话执行',
    state: overrides.state ?? 'running',
    attempts: 1,
    error: null,
    finishedAt: overrides.finishedAt ?? null,
    summary: 'run 摘要',
    events: [nextEventId - 1],
  });
  return {
    calls,
    async postEvent(config, event) {
      const unknown = Object.keys(event).filter(key => !EVENT_WHITELIST.has(key));
      if (unknown.length) {
        const error = new Error(`不认识的字段：${unknown.join(', ')}`);
        error.status = 400;
        throw error;
      }
      calls.push(['postEvent', event]);
      if (overrides.postError) throw overrides.postError;
      return { event: nextEventId++, duplicate: false, routed: true, paused: false };
    },
    async readEvent(config, eventId) {
      calls.push(['readEvent', eventId]);
      // 真实中台只认数字事件 id；用旧的 console:<uuid>:turn:<n> 字符串必 404。
      if (!Number.isInteger(eventId)) {
        const error = new Error('event not found');
        error.status = 404;
        throw error;
      }
      if (overrides.readError) throw overrides.readError;
      return { event: eventId, routed: true, paused: false, runs: overrides.runs ?? [buildRun()] };
    },
    async cancelRun(config, runId) {
      calls.push(['cancelRun', runId]);
      if (overrides.cancelError) throw overrides.cancelError;
      return { ok: true };
    },
  };
}

function flagSpawn(label = 'spawn') {
  const state = { count: 0 };
  state.fn = () => { state.count += 1; throw new Error(`${label} must not happen`); };
  return state;
}

function newManager(adapter, extra = {}) {
  return new SchedulingSessionManager({
    cwd: '/x', adapterPath: '/a.js', spawnFn: flagSpawn().fn, hubScheduling: adapter,
    // 资料文件需要运行目录落盘；默认给临时 archiveRoot（传 archiveRoot:null 显式关闭）。
    archiveRoot: mkdtempSync(path.join(tmpdir(), 'hub-archive-')), ...extra,
  });
}

function archiveHome() {
  return mkdtempSync(path.join(tmpdir(), 'hub-shape-'));
}

// 直接落一份 console-sessions 存档与它的 Hub 恢复凭据旁车，模拟重启前已经创建的会话。
function writeArchivedHubSession(home, { id = ARCHIVED_ID, project = 'owner/demo', text = '重启前', hub } = {}) {
  const dir = path.join(home, 'console-sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id,
    kind: 'scheduling',
    project,
    agent: HUB_SCHEDULING_AGENT_LABEL,
    prompt: text,
    messages: [{ role: 'user', text, at: '2026-11-18T06:00:00Z' }],
    createdAt: '2026-11-18T06:00:00Z',
    updatedAt: '2026-11-18T06:00:00Z',
    closedAt: null,
    endStatus: 'interrupted',
  }));
  if (hub) writeFileSync(path.join(dir, `${id}.hub.json`), JSON.stringify(hub));
}

test('§6.2 subject and event id contract', () => {
  assert.equal(schedulingSubject('abc-123'), 'scheduling:abc-123');
  assert.equal(schedulingEventId('abc-123', 1), 'console:abc-123:turn:1');
  assert.equal(schedulingEventId('abc-123', 7), 'console:abc-123:turn:7');
  const event = buildSchedulingEvent({ sessionId: 'abc-123', turn: 1, project: 'owner/demo', text: '开始' });
  assert.equal(event.id, 'console:abc-123:turn:1');
  assert.equal(event.subject, 'scheduling:abc-123');
  assert.equal(event.type, 'scheduling.message');
  // #89: project/text 进 detail（worker 可解析的 JSON 字符串），summary 为首轮文本摘要，无 resume。
  assert.deepEqual(JSON.parse(event.detail), { project: 'owner/demo', text: '开始' });
  assert.match(event.summary, /开始/);
  assert.equal(event.resume, undefined);
  assert.equal(event.project, undefined);
  assert.equal(event.text, undefined);
});

test('#89 buildSchedulingEvent sends only the Hub event whitelist fields', () => {
  const event = buildSchedulingEvent({ sessionId: 'abc-123', turn: 3, project: 'owner/demo', text: '继续这件事' });
  assert.deepEqual(Object.keys(event).sort(), ['detail', 'id', 'subject', 'summary', 'type']);
  for (const key of Object.keys(event)) assert.ok(EVENT_WHITELIST.has(key), `${key} is not a Hub event field`);
  assert.equal(event.id, 'console:abc-123:turn:3');
  assert.equal(event.subject, 'scheduling:abc-123');
  assert.ok(event.summary.length <= 80, 'summary is a short first-turn text digest');
  assert.deepEqual(JSON.parse(event.detail), { project: 'owner/demo', text: '继续这件事' });
});

test('#89 fake Hub rejects unknown event fields like the real Hub does', async () => {
  const client = fakeHubClient();
  await assert.rejects(
    () => client.postEvent(HUB_CONFIG, { id: 'e1', subject: 'scheduling:s', type: 'scheduling.message', resume: true }),
    error => error.status === 400 && /resume/.test(error.message),
  );
  assert.equal(client.calls.length, 0, 'a rejected event must never be recorded as posted');
});

test('#92 POST/GET adapters use the real Hub shapes and source-key auth', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push([String(url), opts]);
    if (opts.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ event: 7184, duplicate: false, routed: true, paused: false }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ event: 7184, routed: true, paused: false, runs: [{ run: 6586, state: 'running' }] }) };
  };
  try {
    const event = { id: 'e1', subject: 'scheduling:s', type: 'scheduling.message', summary: 'x', detail: JSON.stringify({ project: 'owner/demo', text: 'x' }) };
    const posted = await postSchedulingEvent(HUB_CONFIG, event);
    assert.equal(posted.event, 7184);
    assert.equal(posted.id, undefined, 'the real POST response has no id field');
    assert.match(seen[0][0], /\/v1\/events$/);
    assert.equal(seen[0][1].method, 'POST');
    assert.equal(seen[0][1].headers.authorization, 'Bearer source-key');
    assert.deepEqual(Object.keys(JSON.parse(seen[0][1].body)).sort(), ['detail', 'id', 'subject', 'summary', 'type']);
    const read = await readSchedulingEvent(HUB_CONFIG, 7184);
    assert.equal(read.runs[0].run, 6586);
    assert.match(seen[1][0], /\/v1\/events\/7184$/);
    assert.equal(seen[1][1].headers.authorization, 'Bearer source-key');
  } finally {
    globalThis.fetch = original;
  }
});

test('#92 numericEventId / readHubRun tolerate the real shapes and reject the old ones', () => {
  assert.equal(numericEventId({ event: 7184, duplicate: false, routed: true, paused: false }), 7184);
  assert.equal(numericEventId({ id: 'console:s:turn:1', runId: 'run-1', state: 'running' }), null, 'the old response shape must not be mistaken for a numeric id');
  assert.equal(numericEventId(null), null);
  assert.deepEqual(readHubRun({ event: 7184, runs: [{ run: 6586, rule: 'r', state: 'done', attempts: 1, error: null, finishedAt: 'x', summary: '', events: [] }] }), { runId: 6586, state: 'done', summary: '' });
  assert.deepEqual(readHubRun({ event: 7184, runs: [{ run: 6586, rule: 'r', state: 'done', attempts: 1, error: null, finishedAt: 'x', summary: '结论', events: [] }] }), { runId: 6586, state: 'done', summary: '结论' });
  assert.equal(readHubRun({ event: 7184, runs: [] }), null);
  assert.equal(readHubRun({ id: 'e1', runId: 'run-1', state: 'running' }), null);
});

test('adapter posts every turn to the same subject with whitelist-only events and monotonically increasing ids', async () => {
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  await adapter.postTurn({ sessionId: 's-1', turn: 1, project: 'owner/demo', text: '第一轮' });
  await adapter.postTurn({ sessionId: 's-1', turn: 2, project: 'owner/demo', text: '第二轮' });
  const posted = client.calls.filter(call => call[0] === 'postEvent').map(call => call[1]);
  assert.equal(posted.length, 2);
  assert.equal(posted[0].subject, 'scheduling:s-1');
  assert.equal(posted[1].subject, 'scheduling:s-1');
  assert.equal(posted[0].id, 'console:s-1:turn:1');
  assert.equal(posted[1].id, 'console:s-1:turn:2');
  assert.deepEqual(Object.keys(posted[0]).sort(), ['detail', 'id', 'subject', 'summary', 'type']);
  assert.deepEqual(Object.keys(posted[1]).sort(), ['detail', 'id', 'subject', 'summary', 'type']);
  assert.deepEqual(JSON.parse(posted[0].detail), { project: 'owner/demo', text: '第一轮' });
  assert.deepEqual(JSON.parse(posted[1].detail), { project: 'owner/demo', text: '第二轮' });
});

test('duplicate event ids do not produce a second execution', async () => {
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  await adapter.postTurn({ sessionId: 's-1', turn: 1, project: 'owner/demo', text: '第一轮' });
  await adapter.postTurn({ sessionId: 's-1', turn: 1, project: 'owner/demo', text: '重复的同一轮' });
  const posted = client.calls.filter(call => call[0] === 'postEvent');
  assert.equal(posted.length, 1, 'the same event id must be posted to the Hub only once');
});

test('Hub run state maps to console session status', () => {
  assert.equal(mapHubStateToStatus('running'), 'running');
  assert.equal(mapHubStateToStatus('queued'), 'running');
  assert.equal(mapHubStateToStatus('in_progress'), 'running');
  assert.equal(mapHubStateToStatus('done'), 'idle');
  assert.equal(mapHubStateToStatus('completed'), 'idle');
  assert.equal(mapHubStateToStatus('failed'), 'error');
  assert.equal(mapHubStateToStatus('cancelled'), 'error');
  assert.equal(mapHubStateToStatus(undefined), 'unknown', 'missing state must be reported as 待复核, not idle');
});

test('#100 nothing/refusal 词表补全：终态绝不映射 running，词表外保持 unknown 可读', () => {
  // 完成语义：nothing（本轮无事）与 done（有结果）都落到 idle，不再停在 unknown/待复核。
  assert.equal(mapHubStateToStatus('nothing'), 'idle', 'state=nothing 必须是完成语义 idle，不能停在 unknown/待复核');
  assert.equal(mapHubStateToStatus('done'), 'idle');
  assert.equal(mapHubStateToStatus('completed'), 'idle');
  assert.equal(mapHubStateToStatus('succeeded'), 'idle');
  // 运行中（词表权威值 claimed + 兼容别名）。
  assert.equal(mapHubStateToStatus('claimed'), 'running');
  assert.equal(mapHubStateToStatus('queued'), 'running');
  // 异常终态 → error；refusal/refused 是执行被拒的 error 词表。
  assert.equal(mapHubStateToStatus('failed'), 'error');
  assert.equal(mapHubStateToStatus('refusal'), 'error');
  assert.equal(mapHubStateToStatus('refused'), 'error');
  assert.equal(mapHubStateToStatus('cancelled'), 'error');
  // error_behavior：任何终态都不得映射成 running。
  for (const terminal of ['done', 'nothing', 'completed', 'succeeded', 'failed', 'refusal', 'refused', 'cancelled']) {
    assert.notEqual(mapHubStateToStatus(terminal), 'running', `${terminal} 是终态，绝不能映射成 running`);
  }
  // 未知值保持 unknown（视图可读为待复核），不得编造成完成或运行中。
  assert.equal(mapHubStateToStatus('some-new-hub-state'), 'unknown');
  assert.equal(mapHubStateToStatus(undefined), 'unknown');
});

test('#100 nothing 与 done 同为 idle 但文案区分「本轮无事」与「有结果」', () => {
  assert.equal(mapHubStateToStatus('nothing'), mapHubStateToStatus('done'), '两者同为完成语义 idle');
  assert.equal(hubStateCompletionText('nothing'), '本轮无事');
  assert.equal(hubStateCompletionText('done'), '已完成');
  assert.equal(hubStateCompletionText('refusal'), null, '异常终态不返回完成文案');
  assert.equal(hubStateCompletionText('running'), null, '运行中不返回完成文案');
});

test('#92 start saves the numeric event id and derives status/runId from GET runs[0]', async () => {
  const client = fakeHubClient();
  const home = archiveHome();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = newManager(adapter, { archiveRoot: home });
  const started = await manager.start({ project: fixtureProject(), prompt: '首轮调度' });
  assert.equal(started.status, 'running');
  assert.equal(started.hubRunId, 6586);
  const reads = client.calls.filter(call => call[0] === 'readEvent');
  assert.deepEqual(reads.map(call => call[1]), [7184], 'readStatus must use the numeric Hub event id, not console:<uuid>:turn:1');
  const hubState = JSON.parse(readFileSync(path.join(home, 'console-sessions', `${started.id}.hub.json`), 'utf8'));
  assert.equal(hubState.lastEventId, 7184);
  assert.equal(hubState.runId, 6586);
  assert.equal(hubState.turn, 1);
});

test('#92 a done run maps to idle and a failed run maps to error at start', async () => {
  for (const [state, expected] of [['done', 'idle'], ['failed', 'error']]) {
    const client = fakeHubClient({ state });
    const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
    const started = await newManager(adapter).start({ project: 'owner/demo', prompt: 'x' });
    assert.equal(started.status, expected);
  }
});

test('#100 a nothing run lands as idle at start（回复没事可做的规则会话视图正确落地）', async () => {
  for (const [state, expectedStatus] of [['nothing', 'idle'], ['done', 'idle'], ['refusal', 'error']]) {
    const client = fakeHubClient({ state });
    const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
    const started = await newManager(adapter).start({ project: 'owner/demo', prompt: 'x' });
    assert.equal(started.status, expectedStatus, `state=${state} 的会话状态应正确落地`);
    assert.equal(started.statusText, ({ idle: '待命', error: '异常' })[expectedStatus], 'statusText 与终态一致，停在待复核即为回归');
  }
});

test('#92 a missing/failed GET keeps start usable but marks it 待复核, never running or idle', async () => {
  const client = fakeHubClient({ readError: new Error('hub down') });
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = newManager(adapter);
  const started = await manager.start({ project: fixtureProject(), prompt: '保留我' });
  assert.equal(started.status, 'unknown');
  assert.match(started.error, /hub down/);
  assert.equal(manager.list().length, 1, 'a failed status read must not make the session disappear');
});

test('scheduling start uses the Hub adapter and never spawns a private ACP process', async () => {
  const spawned = flagSpawn();
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({
    cwd: '/workspace/control-plane', adapterPath: '/fixed/codex-acp.js', spawnFn: spawned.fn, hubScheduling: adapter,
    archiveRoot: mkdtempSync(path.join(tmpdir(), 'hub-archive-')),
  });
  const started = await manager.start({ project: fixtureProject(), prompt: '首轮调度' });
  assert.equal(spawned.count, 0);
  assert.equal(started.agent, HUB_SCHEDULING_AGENT_LABEL);
  assert.match(started.hubSubject, /^scheduling:/);
  assert.equal(started.status, 'running');
  assert.equal(manager.list().length, 1);
  const posted = client.calls.filter(call => call[0] === 'postEvent');
  assert.equal(posted.length, 1);
  const firstText = JSON.parse(posted[0][1].detail).text;
  assert.match(firstText, /本轮完整资料.*；动手前先读它。$/);
  assert.ok(Buffer.byteLength(firstText, 'utf8') <= 3950);
  assert.match(firstText, /首轮调度|已截断/);
});

test('subsequent messages join the same Hub matter with a new turn', async () => {
  const spawned = flagSpawn();
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: spawned.fn, hubScheduling: adapter });
  const started = await manager.start({ project: fixtureProject(), prompt: '首轮' });
  await manager.send(started.id, '第二轮重点看卡片');
  const posted = client.calls.filter(call => call[0] === 'postEvent').map(call => call[1]);
  assert.equal(posted.length, 2);
  assert.equal(posted[0].subject, posted[1].subject);
  assert.equal(posted[1].id, schedulingEventId(posted[1].subject.slice('scheduling:'.length), 2));
  assert.match(JSON.parse(posted[1].detail).text, /第二轮/);
  assert.equal(spawned.count, 0);
});

test('#92 a follow-up send refreshes status through GET, not the POST response', async () => {
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = newManager(adapter);
  const started = await manager.start({ project: fixtureProject(), prompt: '首轮' });
  const before = client.calls.filter(call => call[0] === 'readEvent').length;
  const sent = await manager.send(started.id, '继续');
  assert.equal(sent.status, 'running');
  assert.equal(sent.hubRunId, 6586);
  assert.ok(client.calls.filter(call => call[0] === 'readEvent').length > before, 'send must reconcile via GET');
});

test('Hub unavailable preserves input and never falls back to ACP', async () => {
  const spawned = flagSpawn();
  const client = fakeHubClient({ postError: new Error('ECONNREFUSED') });
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: spawned.fn, hubScheduling: adapter });
  await assert.rejects(
    manager.start({ project: fixtureProject(), prompt: '检查当前调度' }),
    error => { assert.match(error.message, /中台|未接线|保留/); return true; },
  );
  assert.equal(spawned.count, 0);
  assert.equal(manager.list().length, 0, 'failed start must not register a phantom session');
});

test('unwired rule (Hub 404) returns a readable error, not an ACP fallback', async () => {
  const spawned = flagSpawn();
  const client = fakeHubClient({ postError: Object.assign(new Error('没有匹配的调度规则'), { status: 404 }) });
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: spawned.fn, hubScheduling: adapter });
  await assert.rejects(
    manager.start({ project: fixtureProject(), prompt: '检查' }),
    error => { assert.match(error.message, /规则|未接线|保留/); return true; },
  );
  assert.equal(spawned.count, 0);
});

test('interrupt maps to canceling the active Hub run without posting a new event', async () => {
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = newManager(adapter);
  const started = await manager.start({ project: fixtureProject(), prompt: '首轮' });
  const before = client.calls.filter(call => call[0] === 'postEvent').length;
  await manager.send(started.id, '', { interrupt: true });
  assert.equal(client.calls.filter(call => call[0] === 'postEvent').length, before);
  assert.ok(client.calls.some(call => call[0] === 'cancelRun'), 'interrupt must cancel the active Hub run');
});

test('close stops new events and does not kill any local ACP process', async () => {
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = newManager(adapter);
  const started = await manager.start({ project: fixtureProject(), prompt: '首轮' });
  const closed = await manager.close(started.id);
  assert.equal(closed.status, 'closed');
  assert.equal(manager.list().length, 0);
  const before = client.calls.filter(call => call[0] === 'postEvent').length;
  await assert.rejects(manager.send(started.id, '还会继续吗'), /不存在|关闭/);
  assert.equal(client.calls.filter(call => call[0] === 'postEvent').length, before);
  assert.ok(!client.calls.some(call => call[0] === 'cancelRun'), 'closing the console view does not kill the Hub run');
});

test('#92 restart recovery rebuilds scheduling views from console-sessions + GET runs[0]', async () => {
  const home = archiveHome();
  writeArchivedHubSession(home, {
    text: '控制台重启前的调度',
    hub: { sessionId: ARCHIVED_ID, subject: `scheduling:${ARCHIVED_ID}`, turn: 2, lastEventId: 7191, runId: null },
  });
  const client = fakeHubClient({ firstEventId: 7191, state: 'running', runId: 6592 });
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = newManager(adapter, { archiveRoot: home });
  await manager.restoreFromHub();
  const views = manager.list();
  assert.equal(views.length, 1);
  assert.equal(views[0].status, 'running');
  assert.equal(views[0].hubRunId, 6592, 'runId is derived from GET runs[0].run');
  assert.equal(views[0].project, 'owner/demo');
  assert.equal(views[0].agent, HUB_SCHEDULING_AGENT_LABEL);
  assert.equal(views[0].hubSubject, `scheduling:${ARCHIVED_ID}`);
  assert.deepEqual(client.calls.filter(call => call[0] === 'readEvent').map(call => call[1]), [7191]);
  assert.ok(!client.calls.some(call => call[0] === 'listMatters'), 'recovery must never call /v1/matters');
});

test('#92 recovery continues at the archived turn, not a duplicate id', async () => {
  const home = archiveHome();
  writeArchivedHubSession(home, {
    hub: { sessionId: ARCHIVED_ID, subject: `scheduling:${ARCHIVED_ID}`, turn: 3, lastEventId: 7184, runId: 6586 },
  });
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = newManager(adapter, { archiveRoot: home });
  await manager.restoreFromHub();
  await manager.send(ARCHIVED_ID, '恢复后继续');
  const posted = client.calls.filter(call => call[0] === 'postEvent').map(call => call[1].id);
  assert.deepEqual(posted, [`console:${ARCHIVED_ID}:turn:4`]);
});

test('#92 a failed readStatus marks 待复核 and surfaces the error instead of faking running/idle', async () => {
  const home = archiveHome();
  writeArchivedHubSession(home, {
    hub: { sessionId: ARCHIVED_ID, subject: `scheduling:${ARCHIVED_ID}`, turn: 2, lastEventId: 7191, runId: null },
  });
  const client = fakeHubClient({ readError: new Error('hub down') });
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = newManager(adapter, { archiveRoot: home });
  await assert.rejects(manager.restoreFromHub(), /hub down/);
  const views = manager.list();
  assert.equal(views.length, 1, 'the archived session must still be listed');
  assert.equal(views[0].status, 'unknown');
  assert.match(views[0].error, /hub down/);
});

test('#92 a missing Hub archive sidecar is not an error and is a legacy archive, not an active 待复核 session (#96)', async () => {
  const home = archiveHome();
  writeArchivedHubSession(home, { text: '旧会话，无 Hub 凭据' }); // 只写通用存档，不写 .hub.json
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = newManager(adapter, { archiveRoot: home });
  await manager.restoreFromHub(); // 不抛
  // #96：无合法 hub sidecar 的 ACP 时代旧存档只进历史区，不恢复成活跃/待复核视图。
  assert.equal(manager.list().length, 0);
  assert.equal((await manager.listArchived()).length, 1, 'the legacy archive stays visible in history');
  const sidecars = readdirSync(path.join(home, 'console-sessions')).filter(name => name.endsWith('.hub.json'));
  assert.equal(sidecars.length, 0, 'no hub sidecar may be fabricated for a legacy archive');
  assert.equal(client.calls.length, 0, 'no event id means no speculative GET');
});

test('normal and design sessions keep the existing ACP spawn path', async () => {
  const { PassThrough } = await import('node:stream');
  const makeProcess = () => {
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    let buffer = '';
    const proc = { stdin, stdout, stderr, pid: 1, kill() { stdout.end(); } };
    const respond = (request, result) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    stdin.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.method === 'initialize') respond(request, { protocolVersion: 1, agentInfo: { name: 'fake' } });
        else if (request.method === 'session/new') respond(request, { sessionId: 'acp-1' });
        else if (request.method === 'session/set_mode') respond(request, {});
        else if (request.method === 'session/set_config_option') respond(request, { configOptions: [{ id: request.params.configId, currentValue: request.params.value }] });
        else if (request.method === 'session/prompt') respond(request, { stopReason: 'end_turn' });
        else if (request.method === 'session/close') respond(request, {});
        else if (request.method === 'session/cancel') respond(request, {});
      }
    });
    return proc;
  };
  let spawned = 0;
  const client = fakeHubClient();
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: client });
  const manager = new SchedulingSessionManager({ cwd: '/x', adapterPath: '/a.js', spawnFn: () => { spawned += 1; return makeProcess(); }, hubScheduling: adapter });
  const started = await manager.start({ kind: 'normal', project: '/x', prompt: '普通会话' });
  assert.equal(spawned, 1, 'normal sessions must still use ACP');
  assert.equal(started.sessionId, 'acp-1');
  assert.equal(client.calls.length, 0, 'normal sessions must not touch the Hub scheduling adapter');
});

// ---- PR #74 返工回归 ----
test('F2 matterTurn still reads the max turn from legacy matter shapes', () => {
  assert.equal(matterTurn('s', {}), 1);
  assert.equal(matterTurn('s', { events: [{ id: 'console:s:turn:2' }, 'console:s:turn:5', { id: 'other' }] }), 5);
  assert.equal(matterTurn('s', { lastEventId: 'console:other:turn:9' }), 1);
});

test('F4 interrupt without a runId looks it up through GET runs, and errors without marking idle when unknown', async () => {
  const home = archiveHome();
  const found = fakeHubClient({ state: 'running', runId: 6592 });
  const manager = newManager(new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: found }), { archiveRoot: home });
  writeArchivedHubSession(home, {
    id: ARCHIVED_ID,
    hub: { sessionId: ARCHIVED_ID, subject: `scheduling:${ARCHIVED_ID}`, turn: 2, lastEventId: 7191, runId: null },
  });
  await manager.restoreFromHub();
  await manager.send(ARCHIVED_ID, '', { interrupt: true });
  assert.ok(found.calls.some(call => call[0] === 'cancelRun' && call[1] === 6592));

  const home2 = archiveHome();
  writeArchivedHubSession(home2, {
    id: ARCHIVED_ID,
    hub: { sessionId: ARCHIVED_ID, subject: `scheduling:${ARCHIVED_ID}`, turn: 2, lastEventId: 7191, runId: null },
  });
  const missing = fakeHubClient({ readError: new Error('nope') });
  const manager2 = newManager(new HubSchedulingSessionAdapter({ hubConfig: HUB_CONFIG, hubClient: missing }), { archiveRoot: home2 });
  await assert.rejects(manager2.restoreFromHub(), /nope/);
  await assert.rejects(manager2.send(ARCHIVED_ID, '', { interrupt: true }), /run|状态/);
  assert.equal(manager2.list()[0].status, 'unknown', 'a failed run lookup must not mark the session running');
  assert.ok(!missing.calls.some(call => call[0] === 'cancelRun'));
});

test('F1 real createConsoleServer assembly restores scheduling views without /v1/matters', async () => {
  const { createServer } = await import('node:http');
  const { createConsoleServer } = await import('../src/server.mjs');
  const { listen, close } = await import('./helpers.mjs');
  const seen = [];
  const hub = createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/v1/events/')) return res.end(JSON.stringify({ event: 7191, routed: true, paused: false, runs: [{ run: 6592, rule: '调度会话执行', state: 'running', attempts: 1, error: null, finishedAt: null, summary: '', events: [7191] }] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  const root = archiveHome();
  writeArchivedHubSession(root, {
    hub: { sessionId: ARCHIVED_ID, subject: `scheduling:${ARCHIVED_ID}`, turn: 2, lastEventId: 7191, runId: null },
  });
  const server = createConsoleServer({ hubUrl: `http://127.0.0.1:${hub.address().port}`, ownerKey: 'k', sourceKey: 'sk', host: '127.0.0.1', root, rulesFile: path.join(root, 'rules.json') });
  try {
    const url = await listen(server);
    await server.restoreSchedulingSessions();
    const response = await fetch(`${url}/api/scheduling-sessions`, { headers: { host: '127.0.0.1' } });
    const sessions = await response.json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].hubSubject, `scheduling:${ARCHIVED_ID}`);
    assert.equal(sessions[0].status, 'running');
    assert.ok(!seen.some(url => url.startsWith('/v1/matters')), 'no /v1/matters request may ever reach the Hub');
  } finally { await close(server); await new Promise(resolve => hub.close(resolve)); }
});

// #85：POST/GET /v1/events 必须用 source 密钥认证；其余 owner 调用不变；双密钥都要脱敏。
async function fakeAuthHub(handler) {
  const { createServer } = await import('node:http');
  const seen = [];
  const hub = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    handler?.(req, res) || res.end(JSON.stringify({ event: 7184, duplicate: false, routed: true, paused: false }));
  });
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  return { seen, hubUrl: `http://127.0.0.1:${hub.address().port}`, close: () => new Promise(resolve => hub.close(resolve)) };
}

test('#85 events POST/GET authenticate with the source key; owner calls keep the owner key', async () => {
  const { hubRequest } = await import('../src/hub.mjs');
  const hub = await fakeAuthHub();
  try {
    const config = { hubUrl: hub.hubUrl, ownerKey: 'owner-key', sourceKey: 'source-key' };
    await postSchedulingEvent(config, { id: 'e1', subject: 'scheduling:s', type: 'scheduling.message' });
    await readSchedulingEvent(config, 7184);
    await hubRequest(config, '/v1/state');
    assert.deepEqual(hub.seen.map(r => r.authorization), ['Bearer source-key', 'Bearer source-key', 'Bearer owner-key']);
  } finally { await hub.close(); }
});

test('#85 missing sourceKey fails closed with a readable error and never falls back to the owner key', async () => {
  const hub = await fakeAuthHub();
  try {
    const config = { hubUrl: hub.hubUrl, ownerKey: 'owner-key' };
    await assert.rejects(() => postSchedulingEvent(config, { id: 'e1' }), /source\.key/);
    await assert.rejects(() => readSchedulingEvent(config, 7184), /source\.key/);
    assert.equal(hub.seen.length, 0, 'no request may reach the Hub without a source key');
  } finally { await hub.close(); }
});

test('#85 adapter keeps input and spawns nothing when the source key is missing', async () => {
  const adapter = new HubSchedulingSessionAdapter({ hubConfig: { hubUrl: 'http://127.0.0.1:9', ownerKey: 'owner-key' } });
  await assert.rejects(
    () => adapter.postTurn({ sessionId: 's-1', turn: 1, project: 'owner/demo', text: '保留我' }),
    error => error instanceof HubSchedulingError && /source\.key/.test(error.message) && /输入已保留/.test(error.message) && /未派生本地进程/.test(error.message),
  );
});

test('#85 both keys are redacted from Hub responses and errors', async () => {
  const hub = await fakeAuthHub((req, res) => {
    if (req.method === 'POST') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad source-key and owner-key' })); }
    return res.end(JSON.stringify({ echo: ['owner-key', { k: 'x source-key y' }] }));
  });
  try {
    const config = { hubUrl: hub.hubUrl, ownerKey: 'owner-key', sourceKey: 'source-key' };
    await assert.rejects(() => postSchedulingEvent(config, { id: 'e1' }), error => !/source-key|owner-key/.test(error.message) && /已隐藏/.test(error.message));
    const read = await readSchedulingEvent(config, 7184);
    assert.doesNotMatch(JSON.stringify(read), /source-key|owner-key/);
  } finally { await hub.close(); }
});

test('#85 loadConsoleConfig exposes sourceKey from the source object and tolerates its absence', async () => {
  const { writeFileSync: w } = await import('node:fs');
  const { loadConsoleConfig } = await import('../src/config.mjs');
  const make = extra => {
    const root = mkdtempSync(path.join(tmpdir(), 'src-key-'));
    w(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:3350', owner: 'o', ...extra }));
    return loadConsoleConfig(root);
  };
  assert.equal(make({ source: { name: 'console', key: 'sk' } }).sourceKey, 'sk');
  assert.equal(make({}).sourceKey, null);
  assert.equal(make({ source: { name: 'console' } }).sourceKey, null);
  assert.equal(make({ source: 'sk' }).sourceKey, null, 'a bare string is not the documented shape');
});
