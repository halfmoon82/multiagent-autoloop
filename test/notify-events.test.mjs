// notify-events 节点边界测试：会话新回复（session-reply）通知事件源 + 移动端桥接 + 原生保活接线。
// 纯逻辑 / 注入 transport / 读源码断言，不调用真实模型、真机推送。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  NOTIFICATION_KINDS, buildSessionReplyNotification, shouldPushSessionReply,
  createNotifyBridge, openSessionFromNotification,
} from '../mobile/src/features/notifications/index.mjs';
import { CardNotifier } from '../src/notifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(root, rel), 'utf8');

const session = (id, kind, replies, extra = {}) => ({
  id, kind, prompt: `${kind} 会话 ${id}`, project: '/work/demo', status: 'idle',
  messages: [
    { role: 'user', text: '开始', at: '2026-11-24T01:00:00Z' },
    ...Array.from({ length: replies }, (_, i) => ({ role: 'agent', text: `回复${i + 1}`, at: `2026-11-24T01:0${i + 1}:00Z` })),
  ],
  updatedAt: '2026-11-24T01:09:00Z', ...extra,
});

test('session-reply 描述符：字段含 sessionId/type/title，三类会话都能构建', () => {
  for (const kind of ['normal', 'scheduling', 'design']) {
    const d = buildSessionReplyNotification(session('s1', kind, 1));
    assert.equal(d.kind, NOTIFICATION_KINDS.SESSION_REPLY);
    assert.equal(d.sessionId, 's1');
    assert.equal(d.sessionType, kind);
    assert.match(d.title, /s1|会话/);
    assert.deepEqual(d.click, { page: 'session', sessionId: 's1', requiresBiometric: false });
    assert.equal(d.reply, null);
    assert.equal(d.badgeKey, null, '会话回复不占角标');
  }
});

test('session-reply 去重键随新回复变化，同一回复稳定', () => {
  const a = buildSessionReplyNotification(session('s1', 'normal', 1));
  const a2 = buildSessionReplyNotification(session('s1', 'normal', 1));
  const b = buildSessionReplyNotification(session('s1', 'normal', 2));
  assert.equal(a.key, a2.key);
  assert.notEqual(a.key, b.key);
});

test('字段缺失不崩溃：无 id / 无 agent 回复 / 非对象返回 null', () => {
  assert.equal(buildSessionReplyNotification(null), null);
  assert.equal(buildSessionReplyNotification({}), null);
  assert.equal(buildSessionReplyNotification({ id: 's', kind: 'normal' }), null);
  assert.equal(buildSessionReplyNotification(session('s', 'normal', 0)), null);
  const odd = buildSessionReplyNotification({ id: 's', messages: [{ role: 'agent' }, null] });
  assert.ok(odd === null || typeof odd.key === 'string');
});

test('session-reply 不泄露疑似凭据', () => {
  const d = buildSessionReplyNotification(session('s1', 'normal', 1, { prompt: 'token=sk-abcdef123456 做事' }));
  assert.ok(!JSON.stringify(d).includes('sk-abcdef123456'));
});

test('shouldPushSessionReply：仅 App 后台或不在该会话详情页时推送', () => {
  assert.equal(shouldPushSessionReply({ appVisible: false, activeSessionId: 's1', sessionId: 's1' }), true);
  assert.equal(shouldPushSessionReply({ appVisible: true, activeSessionId: 's2', sessionId: 's1' }), true);
  assert.equal(shouldPushSessionReply({ appVisible: true, activeSessionId: null, sessionId: 's1' }), true);
  assert.equal(shouldPushSessionReply({ appVisible: true, activeSessionId: 's1', sessionId: 's1' }), false);
});

// ---- CardNotifier 事件源 ----
function driver(states, sessionsSeq, extra = {}) {
  const notes = [];
  const notifier = new CardNotifier({
    intervalMs: 60000, routing: null,
    fetchState: async () => states.shift() ?? states.at(-1),
    fetchSessions: async () => { const v = sessionsSeq.shift() ?? sessionsSeq.at(-1); if (v instanceof Error) throw v; return v; },
    notify: d => notes.push(d), ...extra,
  });
  return { notes, notifier };
}

test('事件源：首次轮询只种子，新回复通知一次，重复轮询不刷屏', async () => {
  const { notes, notifier } = driver([{ cards: [] }], [
    [session('s1', 'normal', 1)],
    [session('s1', 'normal', 1)],
    [session('s1', 'normal', 2)],
    [session('s1', 'normal', 2)],
  ]);
  await notifier.poll();
  assert.equal(notes.length, 0, '重启后存量回复不刷屏');
  await notifier.poll();
  assert.equal(notes.length, 0);
  await notifier.poll();
  assert.equal(notes.filter(n => n.kind === 'session-reply').length, 1);
  await notifier.poll();
  assert.equal(notes.length, 1, '同一回复不重复通知');
  assert.equal(notes[0].sessionId, 's1');
});

test('事件源：普通/设计/调度三类会话都发，且与待办、节点完成并存', async () => {
  const { notes, notifier } = driver(
    [{ cards: [] }, { cards: [{ id: 1, state: 'open', title: 't', createdAt: 'c1' }] }],
    [[], [session('a', 'normal', 1), session('b', 'design', 1), session('c', 'scheduling', 1)]],
  );
  await notifier.poll();
  await notifier.poll();
  assert.deepEqual(notes.filter(n => n.kind === 'session-reply').map(n => n.sessionType).sort(), ['design', 'normal', 'scheduling']);
  assert.equal(notes.filter(n => n.kind === 'todo').length, 1);
});

test('事件源：会话来源失败/脏数据不影响主流程与其他通知', async () => {
  const { notes, notifier } = driver(
    [{ cards: [] }, { cards: [{ id: 2, state: 'open', title: 'x', createdAt: 'c' }] }],
    [[], new Error('boom')],
  );
  await notifier.poll();
  await notifier.poll();
  assert.equal(notes.filter(n => n.kind === 'todo').length, 1);
  const bad = driver([{ cards: [] }, { cards: [] }], [[], [null, 3, { id: 'z' }, { messages: 'x' }]]);
  await bad.notifier.poll();
  await bad.notifier.poll();
  assert.equal(bad.notes.length, 0);
});

test('事件源：notify 抛错不影响后续轮询与去重', async () => {
  let calls = 0;
  const { notifier } = driver([{ cards: [] }], [[session('s', 'normal', 1)], [session('s', 'normal', 2)], [session('s', 'normal', 2)]], {
    notify: () => { calls += 1; throw new Error('osascript gone'); },
  });
  await notifier.poll();
  await notifier.poll();
  await notifier.poll();
  assert.equal(calls, 1);
});

// ---- 移动端桥接 ----
function fakeBridge() {
  const log = [];
  return { log, start: () => {}, stop: () => {}, setBadge: n => log.push(['badge', n]), notify: json => log.push(['notify', JSON.parse(json)]), cancel: () => {} };
}

test('桥接：后台或不在该会话时推送，在该会话详情页不推送但记为已读', () => {
  const api = fakeBridge();
  const bridge = createNotifyBridge({ bridge: api });
  const s = session('s1', 'design', 1);
  assert.equal(bridge.publishSessionReply(s, { appVisible: true, activeSessionId: 's1' }), false);
  assert.equal(bridge.publishSessionReply(s, { appVisible: false, activeSessionId: 's1' }), false, '同一回复已读，离开后不补发');
  assert.equal(api.log.filter(([k]) => k === 'notify').length, 0);
  const s2 = session('s1', 'design', 2);
  assert.equal(bridge.publishSessionReply(s2, { appVisible: true, activeSessionId: 'other' }), true);
  assert.equal(bridge.publishSessionReply(s2, { appVisible: true, activeSessionId: 'other' }), false);
  assert.equal(api.log.filter(([k]) => k === 'notify').length, 1);
});

test('桥接：syncCards 带会话时一并推送，角标仍只算待办', () => {
  const api = fakeBridge();
  const bridge = createNotifyBridge({ bridge: api });
  const sent = bridge.syncCards([{ id: 1, state: 'open', title: 'x', createdAt: 'c' }], [], [session('s9', 'normal', 1)], { appVisible: false });
  assert.equal(sent, 2);
  assert.deepEqual(api.log.filter(([k]) => k === 'badge').at(-1), ['badge', 1]);
});

test('点击通知回到对应会话页：切到会话 Tab 并交付 sessionId', () => {
  const calls = [];
  const win = {
    AutoloopNav: { selectTab: name => calls.push(['tab', name]) },
    AutoloopHooks: {},
    dispatchEvent: e => calls.push(['event', e.type, e.detail]),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  };
  assert.equal(openSessionFromNotification(win, { page: 'session', sessionId: 's1' }), true);
  assert.deepEqual(calls[0], ['tab', 'sessions']);
  assert.deepEqual(calls[1], ['event', 'autoloop:open-session', { sessionId: 's1' }]);
  assert.equal(win.AutoloopPendingSession, 's1');
  assert.equal(openSessionFromNotification(win, { page: 'todos' }), false);
  assert.equal(openSessionFromNotification(null, { page: 'session', sessionId: 's1' }), false);
});

// ---- 原生保活接线：真机从未生效的根因回归 ----
const NATIVE = 'mobile/app/native/java/cool/autoloop/console/notify';

test('根因1：服务内不得动态注册无 flag 的 receiver（Android 14 起会崩溃），回复接收器在清单声明', () => {
  const service = read(`${NATIVE}/ForegroundService.java`);
  assert.ok(!/registerReceiver\s*\(/.test(service.replace(/\/\/.*$/gm, '')), 'ForegroundService 不应再 registerReceiver');
  const manifest = read('mobile/app/native/manifest-additions.xml');
  assert.match(manifest, /<receiver[^>]*cool\.autoloop\.console\.notify\.NotifyReplyReceiver/);
  assert.match(manifest, /<receiver[^>]*android:exported="false"/);
});

test('根因2：前台服务经 startForegroundService 拉起，并带 dataSync 类型启动前台', () => {
  const bridge = read(`${NATIVE}/AutoloopNotifyBridge.java`);
  const plugin = read(`${NATIVE}/AutoLoopNotifications.java`);
  for (const text of [bridge, plugin]) {
    assert.match(text, /startForegroundService/);
    assert.ok(!/getContext\(\)\.startService\(/.test(text), '不得再用 startService 拉前台服务');
  }
  const service = read(`${NATIVE}/ForegroundService.java`);
  assert.match(service, /FOREGROUND_SERVICE_TYPE_DATA_SYNC/);
});

test('根因3：去重持久化 + 首轮种子，服务重启不刷屏；通知带点击意图，并轮询会话新回复', () => {
  const channels = read(`${NATIVE}/NotifyChannels.java`);
  assert.match(channels, /putStringSet|getStringSet/, '去重键需持久化');
  assert.match(channels, /setContentIntent/, '通知必须可点击');
  assert.match(channels, /CHANNEL_SESSION/);
  const service = read(`${NATIVE}/ForegroundService.java`);
  assert.match(service, /api\/sessions/);
  assert.match(service, /session-reply:/);
  assert.match(service, /seeded/);
  assert.match(service, /AppVisibility|isForeground/, '前台且在该会话详情页时不推送');
});

test('通知渠道三类齐全，权限声明含通知与前台服务', () => {
  const manifest = read('mobile/app/native/manifest-additions.xml');
  for (const p of ['POST_NOTIFICATIONS', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_DATA_SYNC']) assert.match(manifest, new RegExp(p));
  const channels = read(`${NATIVE}/NotifyChannels.java`);
  for (const c of ['CHANNEL_TODO', 'CHANNEL_NODE_DONE', 'CHANNEL_SESSION']) assert.match(channels, new RegExp(c));
});

test('事件源默认惰性读控制台会话管理器；未装配时不通知也不报错', async () => {
  const config = {};
  const notes = [];
  const notifier = new CardNotifier({ config, routing: null, fetchState: async () => ({ cards: [] }), notify: d => notes.push(d) });
  await notifier.poll(); // seed，会话管理器尚未装配
  config.schedulingSessions = { list: async () => [session('late', 'design', 1)] };
  await notifier.poll();
  assert.equal(notes.filter(n => n.kind === 'session-reply').length, 1);
});
