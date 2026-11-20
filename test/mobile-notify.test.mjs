// notify-wiring 节点边界测试（假桥）：内容/去重由 notifications 契约提供，JS 负责接线、
// 去重、角标、直复回写、401 停服与偏好开关。桥不存在时静默降级，不影响 App 主流程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as notifyFeature from '../mobile/src/features/notifications/bridge.mjs';
import {
  createNotifyBridge, createNotifyPreference,
  NOTIFY_PREFERENCE_KEY, REPLY_CALLBACK_NAME, NOTIFY_INTERVAL_MS,
} from '../mobile/src/features/notifications/bridge.mjs';
import { buildTodoNotification } from '../mobile/src/features/notifications/index.mjs';
import { mount as mountNotifyPage } from '../mobile/app/www/pages/notify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEATURE_DIR = path.join(ROOT, 'mobile', 'src', 'features', 'notifications');
const flush = () => new Promise(resolve => setImmediate(resolve));

function card(id, extra = {}) {
  return {
    id, state: 'open', title: `待办 ${id}`, text: '请决定是否上线新定价',
    project: '/work/熟小麦', createdAt: '2026-11-20T00:00:00Z',
    options: ['上线', '暂缓'], ...extra,
  };
}
function nodeDone(extra = {}) {
  return {
    type: 'dag.node.advance', outcome: 'done', runId: 'r1', nodeId: 'dev',
    advanceId: 'r1:dev:dev:1:1', summary: '节点交付完成',
    detail: { prUrl: 'https://github.com/o/r/pull/1', commit: 'abc123', tests: 'npm test 12/12' },
    ...extra,
  };
}

function fakeBridge() {
  const calls = [];
  return {
    calls,
    start(json) { calls.push(['start', json]); },
    stop() { calls.push(['stop']); },
    notify(json) { calls.push(['notify', json]); },
    cancel(id) { calls.push(['cancel', id]); },
    onReply(name) { calls.push(['onReply', name]); },
    setBadge(count) { calls.push(['setBadge', count]); },
    of(type) { return calls.filter(call => call[0] === type); },
    payloads(type) { return this.of(type).map(call => JSON.parse(call[1])); },
  };
}

function keyedStorage() {
  const data = new Map();
  const writes = [];
  return {
    writes,
    get(key) { return Promise.resolve(data.has(key) ? data.get(key) : null); },
    set(key, value) { data.set(key, value); writes.push([key, value]); return Promise.resolve(); },
  };
}

function makeNode(id, tag = 'div') {
  return {
    id, tag, children: [], attrs: {}, listeners: {}, textContent: '',
    setAttribute(key, value) { this.attrs[key] = String(value); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    replaceChildren(...kids) { this.children = kids; },
    appendChild(kid) { this.children.push(kid); return kid; },
    async click() { for (const fn of this.listeners.click || []) await fn(); },
  };
}
function fakeDoc(ids = []) {
  const nodes = new Map(ids.map(id => [id, makeNode(id)]));
  return {
    getElementById: id => nodes.get(id) || null,
    createElement: tag => makeNode('', tag),
    add(id) { const node = makeNode(id); nodes.set(id, node); return node; },
  };
}
function elText(node) {
  return [node, ...collect(node)].map(n => n.textContent || '').join(' ');
}
function collect(node, out = []) {
  for (const child of node.children || []) { out.push(child); collect(child, out); }
  return out;
}
function buttons(node) { return collect(node).filter(n => n.tag === 'button'); }

function fakeState({ phase = 'locked', connection = 'offline', needsBind = true } = {}) {
  return {
    phase, connection, needsBind,
    canShowMain() { return this.phase === 'unlocked'; },
  };
}

// ---------------------------------------------------------------------------
// 纯逻辑边界
// ---------------------------------------------------------------------------
test('feature 是纯逻辑：不依赖 node: 内置模块、不碰 DOM、不拼接 HTML', () => {
  const files = readdirSync(FEATURE_DIR).filter(name => name.endsWith('.mjs'));
  assert.ok(files.length >= 3, 'notifications 目录应有契约与接线模块');
  for (const name of files) {
    const code = readFileSync(path.join(FEATURE_DIR, name), 'utf8');
    assert.doesNotMatch(code, /from\s+['"]node:/, `${name} 不应导入 node 内置模块`);
    assert.doesNotMatch(code, /\bdocument\.|\bwindow\./, `${name} 不应直接碰 DOM/浏览器全局`);
    assert.doesNotMatch(code, /innerHTML|outerHTML/, `${name} 不应拼接 HTML`);
  }
});

test('新卡片通知一次，同一 revision 的重复卡片不再通知', () => {
  const bridge = fakeBridge();
  const notify = createNotifyBridge({ bridge });
  const first = card(1);
  assert.equal(notify.publishCard(first), true);
  assert.equal(notify.publishCard(first), false, '重复卡片不再通知');
  assert.equal(notify.publishCard(card(1, { createdAt: '2026-11-20T01:00:00Z' })), true, '同 id 但换 createdAt 属于新 revision，可再通知');
  assert.equal(bridge.of('notify').length, 2);
  const [descriptor] = bridge.payloads('notify');
  assert.equal(descriptor.key, buildTodoNotification(first).key);
  assert.match(descriptor.key, /^todo:1:2026-11-20T00:00:00Z$/);
  assert.doesNotMatch(JSON.stringify(descriptor), /deviceToken|x-device-token/i, '通知载荷不带设备凭证');
});

test('各待办分别通知，节点完成只放行成功回执', () => {
  const bridge = fakeBridge();
  const notify = createNotifyBridge({ bridge });
  notify.publishCard(card(1));
  notify.publishCard(card(2));
  notify.publishNodeDone(nodeDone());
  notify.publishNodeDone(nodeDone({ advanceId: 'r1:dev:dev:1:2', outcome: 'failed' }));
  notify.publishNodeDone({ type: 'scheduler.selfheal', outcome: 'done', nodeId: 'x' });
  const done = bridge.payloads('notify').filter(d => d.kind === 'node-done');
  assert.equal(bridge.of('notify').length, 3, '两条待办 + 一个成功完成节点');
  assert.equal(done.length, 1);
  assert.match(done[0].detail, /pull\/1/);
});

test('syncCards 只通知新增事项并按开放待办数同步角标', () => {
  const bridge = fakeBridge();
  const notify = createNotifyBridge({ bridge });
  const sent = notify.syncCards([card(1), card(2), { id: 9, state: 'decided', title: '已处理' }], [nodeDone()]);
  assert.equal(sent, 3);
  assert.equal(notify.syncCards([card(1), card(2)], []), 0, '同一批事项不重复通知');
  assert.deepEqual(bridge.of('setBadge').map(c => c[1]), [2, 2]);
});

test('直复后撤销系统通知、角标更新，且同一事项不再重复通知', () => {
  const bridge = fakeBridge();
  const refreshed = [];
  const notify = createNotifyBridge({ bridge, onRefresh: info => refreshed.push(info) });
  const descriptor = buildTodoNotification(card(1));
  notify.publishCard(card(1));
  notify.setBadge(1);
  assert.equal(notify.onReply(descriptor.click.cardId, '上线'), true);
  assert.deepEqual(bridge.of('cancel').map(c => c[1]), [descriptor.id]);
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].answer, '上线');
  notify.publishCard(card(1));
  assert.equal(bridge.of('notify').length, 1, '直复后同一事项不再推送');
  assert.equal(notify.onReply('unknown', 'x'), false, '未知事项不撤销通知');
});

test('401 授权失效：停服并清空去重，重新绑定后可再次通知', () => {
  const bridge = fakeBridge();
  const notify = createNotifyBridge({ bridge });
  notify.publishCard(card(1));
  assert.equal(bridge.of('notify').length, 1);
  notify.handleUnauthorized();
  assert.equal(bridge.of('stop').length, 1);
  assert.equal(notify.started, false);
  assert.equal(notify.publishCard(card(1)), true, '重绑后同一键可再次提醒');
  assert.equal(bridge.of('notify').length, 2);
});

test('桥不存在（浏览器）时静默降级：所有调用不抛错且不启动', async () => {
  const notify = createNotifyBridge({ bridge: null, getDeviceToken: async () => 'tok' });
  assert.equal(notify.available, false);
  assert.equal(await notify.start(), false);
  assert.doesNotThrow(() => {
    notify.publishCard(card(1));
    notify.publishNodeDone(nodeDone());
    notify.setBadge(3);
    notify.onReply('x', 'y');
    notify.handleUnauthorized();
    notify.stop();
    notify.registerReply({}, REPLY_CALLBACK_NAME);
  });
});

test('start 把设备令牌、间隔与基址交给原生服务；未绑定不启动', async () => {
  const bridge = fakeBridge();
  const notify = createNotifyBridge({
    bridge, getDeviceToken: async () => 'device-token', getBaseUrl: () => 'https://auto.example',
  });
  assert.equal(await notify.start(), true);
  const options = JSON.parse(bridge.of('start')[0][1]);
  assert.equal(options.deviceToken, 'device-token');
  assert.equal(options.intervalMs, NOTIFY_INTERVAL_MS);
  assert.equal(options.baseUrl, 'https://auto.example');
  assert.equal(notify.started, true);
  assert.equal(notify.stop(), true);
  assert.equal(notify.stop(), false, '重复 stop 不再下发');

  const unbound = fakeBridge();
  const noToken = createNotifyBridge({ bridge: unbound, getDeviceToken: async () => null });
  assert.equal(await noToken.start(), false);
  assert.equal(unbound.of('start').length, 0, '未绑定不向原生服务下发空令牌');
});

test('偏好默认开启，可关闭并持久化到带 key 的安全存储', async () => {
  const storage = keyedStorage();
  const preference = createNotifyPreference({ storage });
  assert.equal(await preference.get(), true, '缺省开启');
  assert.equal(await preference.set(false), false);
  assert.equal(await preference.get(), false);
  assert.deepEqual(storage.writes, [[NOTIFY_PREFERENCE_KEY, '0']]);
  const reopened = createNotifyPreference({ storage });
  assert.equal(await reopened.get(), false, '偏好持久化后重新读取仍为关闭');
});

test('单值安全存储不被偏好覆盖（不写设备令牌槽）', async () => {
  let writes = 0;
  const single = {
    get() { return Promise.resolve('a'.repeat(64)); },
    set() { writes += 1; return Promise.resolve(); },
  };
  const preference = createNotifyPreference({ storage: single });
  assert.equal(await preference.get(), true);
  await preference.set(false);
  assert.equal(writes, 0, '单值令牌存储不能被通知偏好覆盖');
  assert.equal(await preference.get(), false, '本次会话仍按内存偏好生效');
});

test('registerReply 注册回调名并把锁屏直复接回控制器', () => {
  const bridge = fakeBridge();
  const refreshed = [];
  const notify = createNotifyBridge({ bridge, onRefresh: () => refreshed.push(1) });
  const descriptor = buildTodoNotification(card(1));
  notify.publishCard(card(1));
  const win = {};
  assert.equal(notify.registerReply(win), true);
  assert.equal(typeof win[REPLY_CALLBACK_NAME], 'function');
  assert.deepEqual(bridge.of('onReply').map(c => c[1]), [REPLY_CALLBACK_NAME]);
  win[REPLY_CALLBACK_NAME](descriptor.click.cardId, '暂缓');
  assert.equal(bridge.of('cancel').length, 1);
  assert.equal(refreshed.length, 1);
  notify.unregisterReply(win);
  assert.equal(win[REPLY_CALLBACK_NAME], undefined);
});

// ---------------------------------------------------------------------------
// pages/notify.mjs 接线
// ---------------------------------------------------------------------------
function mountWith(ctx, win, doc, feature, timers) {
  return mountNotifyPage(ctx, {
    doc, win, feature: notifyFeature,
    setTimer(fn) { timers.push(fn); return timers.length; },
    clearTimer() {},
  });
}

test('mount 覆盖 hooks.notify：解锁连上后 start，未解锁/断线/授权失效时 stop', async () => {
  const bridge = fakeBridge();
  const storage = keyedStorage();
  const doc = fakeDoc(['notify-root']);
  const win = { AutoloopNotify: bridge, AutoloopSecureStorage: storage, location: { origin: 'https://auto.example' } };
  const state = fakeState();
  const hooks = { notify: { setBadge() {}, refresh() {} } };
  const ctx = {
    state, hooks,
    client: { tokenStore: { get: async () => 'device-token' }, api: async () => ({ cards: [], nodeEvents: [] }) },
  };
  const timers = [];
  mountWith(ctx, win, doc, {}, timers);
  assert.notEqual(hooks.notify.setBadge, undefined);
  assert.notEqual(hooks.notify.refresh, undefined);
  assert.equal(timers.length, 1, '挂载后建立一个轻量状态检查定时器');

  await timers[0]();
  assert.equal(bridge.of('start').length, 0, '未解锁不启动常驻服务');

  state.phase = 'unlocked'; state.connection = 'online'; state.needsBind = false;
  await timers[0]();
  assert.equal(bridge.of('start').length, 1, '解锁连上后下发设备令牌与间隔');

  const stopsBeforeOffline = bridge.of('stop').length;
  state.connection = 'offline';
  await timers[0]();
  assert.equal(bridge.of('stop').length, stopsBeforeOffline + 1, '断线时停止常驻服务');

  const stopsBeforeRevoke = bridge.of('stop').length;
  state.connection = 'online'; state.needsBind = true;
  await timers[0]();
  assert.ok(bridge.of('stop').length > stopsBeforeRevoke, '授权失效（重新绑定）时停止常驻服务');
});

test('mount 设置开关：点击切换偏好并同步服务状态', async () => {
  const bridge = fakeBridge();
  const storage = keyedStorage();
  const doc = fakeDoc(['notify-root']);
  const root = doc.getElementById('notify-root');
  const win = { AutoloopNotify: bridge, AutoloopSecureStorage: storage, location: { origin: 'https://auto.example' } };
  const state = fakeState({ phase: 'unlocked', connection: 'online', needsBind: false });
  const ctx = {
    state, hooks: { notify: {} },
    client: { tokenStore: { get: async () => 'device-token' }, api: async () => ({ cards: [], nodeEvents: [] }) },
  };
  const timers = [];
  mountWith(ctx, win, doc, {}, timers);
  const toggle = buttons(root)[0];
  assert.ok(toggle, '通知挂载点提供开关控件');
  assert.match(elText(root), /已开启/);
  await toggle.click();
  assert.match(elText(root), /已关闭/);
  assert.deepEqual(storage.writes, [[NOTIFY_PREFERENCE_KEY, '0']]);
  await timers[0]();
  assert.equal(bridge.of('start').length, 0, '关闭偏好后不启动服务');
  await toggle.click();
  assert.match(elText(root), /已开启/);
  await timers[0]();
  assert.equal(bridge.of('start').length, 1, '重新开启后恢复服务');
});

test('hooks.notify.refresh 拉取状态生成通知并同步角标', async () => {
  const bridge = fakeBridge();
  const doc = fakeDoc(['notify-root']);
  const win = { AutoloopNotify: bridge, location: { origin: 'https://auto.example' } };
  const state = fakeState({ phase: 'unlocked', connection: 'online', needsBind: false });
  const hooks = { notify: {} };
  const ctx = {
    state, hooks,
    client: {
      tokenStore: { get: async () => 'device-token' },
      api: async key => {
        assert.equal(key, 'state');
        return { cards: [card(1)], nodeEvents: [nodeDone()] };
      },
    },
  };
  const timers = [];
  mountWith(ctx, win, doc, {}, timers);
  await hooks.notify.refresh();
  assert.equal(bridge.of('notify').length, 2, '待办与节点完成各一条');
  assert.deepEqual(bridge.of('setBadge').map(c => c[1]), [1]);
  await hooks.notify.refresh();
  assert.equal(bridge.of('notify').length, 2, '刷新不重复通知同一事项');
});

test('hooks.notify.refresh 遇 401 时停服，不把授权失效当普通断线', async () => {
  const bridge = fakeBridge();
  const doc = fakeDoc(['notify-root']);
  const win = { AutoloopNotify: bridge, location: { origin: 'https://auto.example' } };
  const state = fakeState({ phase: 'unlocked', connection: 'online', needsBind: false });
  const hooks = { notify: {} };
  const error = new Error('授权失效'); error.status = 401;
  const ctx = {
    state, hooks,
    client: { tokenStore: { get: async () => 'tok' }, api: async () => { throw error; } },
  };
  const timers = [];
  mountWith(ctx, win, doc, {}, timers);
  await hooks.notify.refresh();
  assert.equal(bridge.of('stop').length, 1, '401 立即停服');
  assert.doesNotThrow(() => hooks.notify.setBadge(2));
  assert.doesNotThrow(() => hooks.notify.publishCard(card(1)));
});

test('mount 覆盖默认空操作钩子且桥缺失时仍可安全调用', async () => {
  const doc = fakeDoc(['notify-root']);
  const win = { location: { origin: 'https://auto.example' } };
  const state = fakeState({ phase: 'unlocked', connection: 'online', needsBind: false });
  const hooks = { notify: { setBadge() {}, refresh() {} } };
  const ctx = {
    state, hooks,
    client: { tokenStore: { get: async () => 'tok' }, api: async () => ({ cards: [], nodeEvents: [] }) },
  };
  const timers = [];
  mountWith(ctx, win, doc, {}, timers);
  assert.doesNotThrow(() => hooks.notify.setBadge(1));
  await assert.doesNotReject(() => hooks.notify.refresh());
  await timers[0]();
  assert.match(elText(doc.getElementById('notify-root')), /已开启/);
});

test('页面钩子连发的 refresh 在节流窗内只发一次请求；时间过窗后再拉取', async () => {
  const bridge = fakeBridge();
  const doc = fakeDoc(['notify-root']);
  const win = { AutoloopNotify: bridge, location: { origin: 'https://auto.example' } };
  const state = fakeState({ phase: 'unlocked', connection: 'online', needsBind: false });
  const hooks = { notify: {} };
  let calls = 0;
  const ctx = { state, hooks, client: { tokenStore: { get: async () => 't' }, api: async () => { calls += 1; return { cards: [], nodeEvents: [] }; } } };
  let clock = 1000;
  mountNotifyPage(ctx, { doc, win, feature: notifyFeature, setTimer: () => 1, clearTimer() {}, now: () => clock });
  await hooks.notify.refresh();
  await hooks.notify.refresh();
  assert.equal(calls, 1, '各页加载连发 refresh 只留一次真请求');
  clock += 6000;
  await hooks.notify.refresh();
  assert.equal(calls, 2);
});

test('授权失效或未解锁时 refresh 不发请求（避免对已撤销设备再打 401）', async () => {
  for (const flags of [{ phase: 'unlocked', connection: 'online', needsBind: true }, { phase: 'locked', connection: 'offline', needsBind: false }]) {
    const doc = fakeDoc(['notify-root']);
    const win = { AutoloopNotify: fakeBridge(), location: { origin: 'https://auto.example' } };
    const hooks = { notify: {} };
    let calls = 0;
    const ctx = { state: fakeState(flags), hooks, client: { tokenStore: { get: async () => 't' }, api: async () => { calls += 1; return {}; } } };
    mountNotifyPage(ctx, { doc, win, feature: notifyFeature, setTimer: () => 1, clearTimer() {} });
    await hooks.notify.refresh();
    assert.equal(calls, 0);
  }
});

test('mount 与已有钩子串联：先前包装的 setBadge/refresh 继续被调用', async () => {
  const doc = fakeDoc(['notify-root']);
  const win = { AutoloopNotify: fakeBridge(), location: { origin: 'https://auto.example' } };
  const seen = [];
  const hooks = { notify: { setBadge: n => seen.push(['badge', n]), refresh: () => seen.push(['refresh']) } };
  const ctx = { state: fakeState({ phase: 'unlocked', connection: 'online', needsBind: false }), hooks, client: { tokenStore: { get: async () => 't' }, api: async () => ({ cards: [] }) } };
  mountNotifyPage(ctx, { doc, win, feature: notifyFeature, setTimer: () => 1, clearTimer() {} });
  hooks.notify.setBadge(3);
  await hooks.notify.refresh();
  assert.deepEqual(seen, [['badge', 3], ['refresh']]);
});
