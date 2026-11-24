// integration-verify 节点：十一个 wave-0 节点合并后的跨模块组合场景联调（只加测试，不改实现）。
// 每个用例是一个「组合」，断言消息带上组合名与步骤，失败时能直接读出「哪个组合、哪一步」。
// 全部走真实 createConsoleServer + 真实 SchedulingSessionManager（假 ACP）+ 假 Hub，
// 不调用真实模型、不碰真实规则、不开浏览器（浏览器回归由 npm run test:browser 单独覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { SchedulingSessionManager } from '../src/scheduling-session.mjs';
import { DagServiceError } from '../src/dag-service.mjs';
import { CardNotifier } from '../src/notifier.mjs';
import { createConsoleRegistry } from '../mobile/app/www/shell.mjs';
import { optimisticMessage, settleMessage } from '../mobile/src/features/composer-autogrow/index.mjs';
import { buildSessionReplyNotification, NOTIFICATION_KINDS } from '../mobile/src/features/notifications/index.mjs';
import { createAuthorizeClient, buildAuthorizeView, buildCreateBody } from '../mobile/src/features/design-authorize/index.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const WORKTREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST = 'a'.repeat(64);

// ---------- 公共夹具 ----------
const jsonLine = value => `${JSON.stringify(value)}\n`;

async function waitFor(label, predicate, timeout = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error(`等待超时：${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// 受控 ACP：prompt 不自动结束（由测试 endTurn），cancel 会拒绝当前 prompt（真实适配器行为）。
function makeAcp(tag = 'acp') {
  const requests = [];
  const prompts = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = '';
  const proc = { stdin, stdout, stderr, pid: 90, kill() { stdout.end(); } };
  const respond = (request, result) => stdout.write(jsonLine({ jsonrpc: '2.0', id: request.id, result }));
  stdin.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      requests.push(request);
      if (request.method === 'initialize') respond(request, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { prompt: true } }, agentInfo: { name: tag, version: '0' } });
      else if (request.method === 'session/new') respond(request, { sessionId: `${tag}-session` });
      else if (request.method === 'session/set_mode' || request.method === 'session/close') respond(request, {});
      else if (request.method === 'session/set_config_option') respond(request, { configOptions: [{ id: request.params.configId, currentValue: request.params.value }] });
      else if (request.method === 'session/prompt') prompts.push(request);
      else if (request.method === 'session/cancel') {
        respond(request, {});
        const pending = prompts[prompts.length - 1];
        if (pending) stdout.write(jsonLine({ jsonrpc: '2.0', id: pending.id, error: { code: -32800, message: 'request cancelled' } }));
      }
    }
  });
  const endTurn = (request, text = '本轮回复') => {
    stdout.write(jsonLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: `${tag}-session`, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }));
    respond(request, { stopReason: 'end_turn' });
  };
  return { process: proc, requests, prompts, endTurn };
}

function bindDevice(root, name = '测试手机') {
  const store = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const bound = store.bindDevice({ token: store.createBinding().token, name, platform: 'Android' });
  return { store, token: bound.deviceToken, deviceId: bound.device.id };
}

async function startConsole(t, { sessions, dagService, hubHandler } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'integration-verify-'));
  const rulesFile = path.join(root, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ rules: [], agents: {}, sources: {} }));
  const hub = await fakeHub(hubHandler || ((req, res) => json(res, { cards: [] })));
  const device = bindDevice(root);
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'owner-key', sourceKey: 'source-key', host: '127.0.0.1', root, rulesFile,
    projectRoots: [WORKTREE], deviceAuth: device.store, ...(dagService ? { dagService } : {}),
  }, sessions);
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); rmSync(root, { recursive: true, force: true }); });
  return { url, hub, ...device };
}

function mobile(base, pathname, { method = 'GET', token, body } = {}) {
  return fetch(base + pathname, {
    method,
    headers: {
      'x-console-request': '1', 'x-forwarded-proto': 'https', origin: new URL(base).origin,
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(token ? { 'x-device-token': token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(6000),
  });
}

const web = (base, pathname, { method = 'GET', body } = {}) => fetch(base + pathname, {
  method,
  headers: {
    'x-console-request': '1', origin: new URL(base).origin,
    ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  signal: AbortSignal.timeout(6000),
});

function memoryStorage() {
  const data = new Map();
  return { data, async get(key) { return data.has(key) ? data.get(key) : null; }, async set(key, value) { data.set(key, String(value)); }, async remove(key) { data.delete(key); } };
}

// ---------- 组合 1：多控制台切换 × 凭证隔离 × 只读产物路由 ----------
test('组合1 多控制台切换：每台控制台凭证互相隔离，切换后用当前台凭证读取，移除不影响另一台', async t => {
  const sessionsA = { async list() { return []; }, async listArchived() { return []; } };
  const sessionsB = { async list() { return []; }, async listArchived() { return []; } };
  const a = await startConsole(t, { sessions: sessionsA });
  const b = await startConsole(t, { sessions: sessionsB });

  // 步骤1：把两台控制台加入清单（凭证按各自 host 分 key 存放）。
  const storage = memoryStorage();
  const registry = createConsoleRegistry({ storage });
  await registry.load();
  const origins = [`http://127.0.0.1:${new URL(a.url).port}`, `http://127.0.0.1:${new URL(b.url).port}`];
  const tokens = [a.token, b.token];
  for (const [index, origin] of origins.entries()) {
    await registry.addConsole({ base: origin, name: `控制台${index}` }, async (_, tokenStore) => { await tokenStore.set(tokens[index]); });
  }
  assert.equal(registry.list().length, 2, '组合1/步骤1：两台控制台都应进入清单');

  // 步骤2：A 的凭证打 B 必须 401（设备库互相独立）；各自凭证打各自成功。
  assert.equal((await mobile(b.url, '/api/mobile/artifacts', { token: a.token })).status, 401, '组合1/步骤2：A 凭证不得通行 B');
  assert.equal((await mobile(a.url, '/api/mobile/artifacts', { token: b.token })).status, 401, '组合1/步骤2：B 凭证不得通行 A');
  assert.equal((await mobile(a.url, '/api/mobile/artifacts', { token: a.token })).status, 200);
  assert.equal((await mobile(b.url, '/api/mobile/artifacts', { token: b.token })).status, 200);

  // 步骤3：切换当前控制台后，tokenStoreFor(当前) 取出的就是该台的凭证。
  await registry.selectConsole(origins[0]);
  assert.equal(await registry.tokenStoreFor(registry.current()).get(), a.token, '组合1/步骤3：切到 A 取 A 凭证');
  await registry.selectConsole(origins[1]);
  assert.equal(await registry.tokenStoreFor(registry.current()).get(), b.token, '组合1/步骤3：切到 B 取 B 凭证');

  // 步骤4：移除当前（B）→ 指针回到 A，A 凭证仍在，B 凭证被删。
  await registry.removeConsole(origins[1]);
  assert.equal(registry.current(), origins[0], '组合1/步骤4：移除当前台后指向剩余台');
  assert.equal(await registry.tokenStoreFor(origins[0]).get(), a.token, '组合1/步骤4：A 凭证不受影响');
  assert.equal(await registry.tokenStoreFor(origins[1]).get(), null, '组合1/步骤4：B 凭证随移除删除');
});

// ---------- 组合 2：上限 6 并发 × 关闭写路由 × 通知三类 ----------
test('组合2 上限 6 并发：开满 6 个后第 7 个被拒；经移动端关闭写路由释放一个名额后可再开', async t => {
  const manager = new SchedulingSessionManager({
    hubScheduling: false, cwd: mkdtempSync(path.join(tmpdir(), 'iv-limit-')), archiveRoot: mkdtempSync(path.join(tmpdir(), 'iv-archive-')), adapterPath: '/fixed/codex-acp.js',
    spawnFn: () => makeAcp('limit').process, settleMs: 10,
  });
  t.after(async () => { for (const s of manager.list()) await manager.close(s.id).catch(() => {}); });
  const ctx = await startConsole(t, { sessions: manager });
  assert.equal(manager.maxSessions, 6, '组合2/步骤0：默认上限 6');

  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push((await manager.start({ project: `owner/p${i}`, prompt: `任务${i}` })).id);
  await assert.rejects(manager.start({ project: 'owner/p7', prompt: '超额' }), /最多同时开启 6 个会话/, '组合2/步骤1：第 7 个必须被拒');
  const limit = await (await web(ctx.url, '/api/session-limit')).json();
  assert.equal(limit.maxSessions, 6, '组合2/步骤1：只读端点如实暴露上限');

  const closed = await mobile(ctx.url, `/api/mobile/sessions/${ids[0]}/close`, { method: 'POST', token: ctx.token, body: {} });
  assert.equal(closed.status, 200, `组合2/步骤2：移动端关闭写路由应成功，实际 ${closed.status} ${JSON.stringify(manager.list().map(s => [s.id, s.status]))} 目标 ${ids[0]}`);
  assert.equal((await closed.json()).sourceDeviceId, ctx.deviceId, '组合2/步骤2：回传来源设备');
  const again = await mobile(ctx.url, `/api/mobile/sessions/${ids[0]}/close`, { method: 'POST', token: ctx.token, body: {} });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).alreadyClosed, true, '组合2/步骤2：重复关闭幂等');

  const seventh = await manager.start({ project: 'owner/p7', prompt: '腾出名额后再开' });
  assert.ok(seventh.id, '组合2/步骤3：关闭一个后第 7 个应能开');
});

test('组合2b 通知三类：待办/节点完成/会话回复并存；三类会话各一次，关闭会话后不再重复通知', async () => {
  const notes = [];
  const sessionAt = (id, kind, replies) => ({
    id, kind, prompt: `${kind} ${id}`, project: '/work/demo', status: 'idle',
    messages: [{ role: 'user', text: '开始', at: '2026-11-24T01:00:00Z' }, ...Array.from({ length: replies }, (_, i) => ({ role: 'agent', text: `回复${i + 1}`, at: `2026-11-24T01:0${i + 1}:00Z` }))],
  });
  const stateSeq = [
    { cards: [] },
    { cards: [{ id: 1, state: 'open', title: '待办卡', createdAt: 'c1' }] },
    { cards: [{ id: 1, state: 'open', title: '待办卡', createdAt: 'c1' }] },
  ];
  const sessionSeq = [
    [],
    [sessionAt('n', 'normal', 1), sessionAt('d', 'design', 1), sessionAt('s', 'scheduling', 1)],
    [sessionAt('n', 'normal', 1), sessionAt('d', 'design', 1)], // s 已被关闭移出
  ];
  const notifier = new CardNotifier({
    intervalMs: 60000, routing: null,
    fetchState: async () => stateSeq.shift() ?? stateSeq.at(-1),
    fetchSessions: async () => sessionSeq.shift() ?? sessionSeq.at(-1),
    notify: d => notes.push(d),
    now: () => Date.parse('2026-11-24T00:00:00Z'),
  });
  await notifier.poll(); await notifier.poll(); await notifier.poll();
  const replies = notes.filter(n => n.kind === NOTIFICATION_KINDS.SESSION_REPLY);
  assert.deepEqual(replies.map(n => n.sessionType).sort(), ['design', 'normal', 'scheduling'], '组合2b：三类会话各通知一次，且第三轮不重复');
  assert.equal(notes.filter(n => n.kind === NOTIFICATION_KINDS.TODO).length, 1, '组合2b：待办通知并存且不刷屏');
  const built = buildSessionReplyNotification(sessionAt('x', 'design', 1));
  assert.equal(built.click.sessionId, 'x', '组合2b：点击意图带回对应会话');
});

// ---------- 组合 3：乐观上屏 × 打断带文本 steer ----------
test('组合3 乐观上屏 × 打断带文本：先本地上屏，经移动端 messages 路由 interrupt=true，文本不丢并开新轮', async t => {
  const acp = makeAcp('steer');
  const manager = new SchedulingSessionManager({
    hubScheduling: false, cwd: mkdtempSync(path.join(tmpdir(), 'iv-steer-')), adapterPath: '/a.js', spawnFn: () => acp.process, settleMs: 20,
  });
  const ctx = await startConsole(t, { sessions: manager });
  const started = await manager.start({ project: 'owner/demo', prompt: '首轮任务' });
  await waitFor('首轮 prompt 发出', () => acp.prompts.length === 1);
  t.after(async () => { await manager.close(started.id).catch(() => {}); });

  // 步骤1：乐观上屏——发送前本地已有一条 sending 气泡。
  const draft = '打断后改做这个';
  let local = [optimisticMessage(draft, 'local-1')];
  assert.equal(local[0].sendState, 'sending', '组合3/步骤1：发送前先乐观上屏');

  // 步骤2：真实路由打断带文本。
  const response = await mobile(ctx.url, `/api/mobile/sessions/${started.id}/messages`, { method: 'POST', token: ctx.token, body: { text: draft, interrupt: true } });
  assert.equal(response.status, 200, `组合3/步骤2：打断路由应成功，实际 ${response.status}`);
  local = settleMessage(local, 'local-1', 'sent');
  assert.equal(local[0].sendState, 'sent', '组合3/步骤2：成功后乐观气泡转 sent，不重复入账');
  assert.equal(local.length, 1);

  // 步骤3：旧轮被 cancel，新轮 prompt 带原文，转录里能看到这条用户消息。
  assert.ok(acp.requests.some(r => r.method === 'session/cancel'), '组合3/步骤3：必须调用 session/cancel');
  await waitFor('打断后新轮 prompt', () => acp.prompts.length === 2);
  assert.match(acp.prompts[1].params.prompt[0].text, /打断后改做这个/, '组合3/步骤3：新轮必须带打断文本');
  const transcript = manager.list().find(s => s.id === started.id).messages.filter(m => m.role === 'user').map(m => m.text);
  assert.ok(transcript.some(text => /打断后改做这个/.test(text)), '组合3/步骤3：文本进入转录');

  // 步骤4：空文本被服务端拒绝（乐观气泡应转 failed，不会静默吞掉）。
  const empty = await mobile(ctx.url, `/api/mobile/sessions/${started.id}/messages`, { method: 'POST', token: ctx.token, body: { text: '   ', interrupt: true } });
  assert.equal(empty.status, 400, '组合3/步骤4：空文本拒绝');
  local = settleMessage([optimisticMessage('   ', 'local-2')], 'local-2', 'failed');
  assert.equal(local[0].sendState, 'failed');

  acp.endTurn(acp.prompts[1]);
  await waitFor('会话回到空闲', () => manager.list().find(s => s.id === started.id).status === 'idle');
});

// ---------- 组合 4：App 设计授权全流程 ----------
test('组合4 设计授权全流程：放行落盘 → 出示执行范围 → 勾选确认 → 进事件链；未勾选/摘要不符均不创建', async t => {
  const order = [];
  const sessions = {
    async list() { return [{ id: 'sess-design', kind: 'design', project: WORKTREE, status: 'running' }]; },
    async listArchived() { return []; },
    async approvePlan(id) { order.push(`approve:${id}`); return { id, planApproved: true }; },
  };
  const plan = {
    project: WORKTREE, planId: 'iv-plan', title: '联调计划', planDigest: DIGEST, remoteUrl: 'https://example.com/r.git', maxParallel: 3,
    nodes: [
      { id: 'n1', title: '业务节点', wave: 0, files: ['src/a.mjs'], dependsOn: [] },
      { id: 'n2', title: '集成审阅', wave: 1, files: ['test/x.mjs'], dependsOn: ['n1'], integrationReview: true },
    ],
    allowedActions: ['worktree', 'run-tests', 'create-pr'], deniedActions: ['deploy', 'release'], optionalActions: [],
  };
  const dagService = {
    calls: [],
    async preview(project, planId) { order.push('preview'); return { ...plan, project, planId }; },
    preflight(project, planId) { order.push('preflight'); return { project, planId, checks: [{ id: 'plan-source', label: '计划来源', ok: true }] }; },
    async create(body, project) {
      order.push('create');
      this.calls.push({ body, project });
      if (body.planDigest !== DIGEST) { throw new DagServiceError('PLAN_DIGEST_MISMATCH：planDigest 与服务端计划不一致，计划已变化需重新确认', 400); }
      return { runId: 'dagrun-iv', status: 'running' };
    },
  };
  const ctx = await startConsole(t, { sessions, dagService });

  // 步骤1：放行落盘。
  const approved = await mobile(ctx.url, '/api/mobile/sessions/sess-design/approve-plan', { method: 'POST', token: ctx.token, body: {} });
  assert.equal(approved.status, 200, '组合4/步骤1：放行落盘应成功');
  assert.deepEqual(order, ['approve:sess-design']);

  // 步骤2：出示执行范围（计划 + 预检），逐条可见。
  const tokenStore = { get: async () => ctx.token };
  const client = createAuthorizeClient({ origin: ctx.url, tokenStore });
  const { plan: shown, preflight } = await client.loadPlan(WORKTREE, 'iv-plan');
  const view = buildAuthorizeView(shown, preflight);
  assert.equal(view.ready, true, '组合4/步骤2：计划已出示');
  assert.deepEqual(view.nodes.map(n => n.id), ['n1', 'n2']);
  assert.deepEqual(view.denied.map(d => d.id), ['deploy', 'release'], '组合4/步骤2：禁止项必须出示');
  assert.deepEqual(view.summary, { businessNodes: 1, reviewNodes: 1, maxParallel: 3 });
  assert.equal(view.canSubmit, false, '组合4/步骤2：未勾选不可提交');

  // 步骤3：未勾选 → 不产出请求体，createRun 拒绝，create 零触达。
  assert.equal(buildCreateBody(shown, { acknowledged: false }), null);
  await assert.rejects(client.createRun(null), /勾选/, '组合4/步骤3：未勾选不得提交');
  assert.equal(dagService.calls.length, 0, '组合4/步骤3：未勾选 create 零触达');

  // 步骤4：摘要不符（计划被改过）→ 服务端拒绝，不创建。
  await assert.rejects(client.createRun({ ...buildCreateBody(shown, { acknowledged: true }), planDigest: 'b'.repeat(64) }), /planDigest|计划已变化/, '组合4/步骤4：摘要不符必须拒绝');

  // 步骤5：勾选确认 → 进事件链（create 收到出示过的动作清单）。
  const body = buildCreateBody(shown, { acknowledged: true });
  assert.equal(buildAuthorizeView(shown, preflight, { acknowledged: true }).canSubmit, true);
  const created = await client.createRun(body);
  assert.equal(created.runId, 'dagrun-iv', '组合4/步骤5：创建成功回传 runId');
  const last = dagService.calls.at(-1);
  assert.deepEqual(last.body.confirmedActionIds, ['worktree', 'run-tests', 'create-pr'], '组合4/步骤5：确认的动作 = 出示的动作');
  assert.equal(last.body.confirm, true);
  assert.ok(order.indexOf('preview') < order.lastIndexOf('create'), '组合4：先出示后创建');
});

// ---------- 组合 5：产物列表与网页一致 ----------
test('组合5 产物列表：移动端会话产物 = 网页同会话产物；全局聚合包含同一批文件；旧文档不混入', async t => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'iv-artifacts-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  writeFileSync(path.join(workspace, '旧文档.md'), '会话前就存在');
  const old = new Date(Date.now() - 3600 * 1000);
  utimesSync(path.join(workspace, '旧文档.md'), old, old);

  const acp = makeAcp('art');
  const manager = new SchedulingSessionManager({ hubScheduling: false, cwd: workspace, adapterPath: '/a.js', spawnFn: () => acp.process, settleMs: 10 });
  const started = await manager.start({ project: 'owner/demo', prompt: '产出看板' });
  t.after(async () => { await manager.close(started.id).catch(() => {}); });
  // 会话开始之后才产生的产物（mtime 显式拨到未来几秒，避免同毫秒 flaky）。
  const future = new Date(Date.now() + 5000);
  for (const name of ['docs/看板.html', '说明.md']) {
    writeFileSync(path.join(workspace, name), `# ${name}`);
    utimesSync(path.join(workspace, name), future, future);
  }
  const ctx = await startConsole(t, { sessions: manager });

  const webFiles = (await (await web(ctx.url, `/api/scheduling-sessions/${started.id}/artifacts`)).json()).files;
  const mobileFiles = (await (await mobile(ctx.url, `/api/mobile/sessions/${started.id}/artifacts`, { token: ctx.token })).json()).files;
  assert.ok(webFiles.length >= 2, `组合5/步骤1：网页应列出本会话新产物，实际 ${JSON.stringify(webFiles)}`);
  assert.deepEqual(mobileFiles, webFiles, '组合5/步骤1：移动端与网页逐字一致');
  assert.ok(!webFiles.some(f => /旧文档/.test(f.path)), '组合5/步骤1：会话前的旧文档不得混入');

  const global = (await (await mobile(ctx.url, '/api/mobile/artifacts', { token: ctx.token })).json()).files;
  const globalPaths = global.filter(f => f.sessionId === started.id).map(f => f.path).sort();
  assert.deepEqual(globalPaths, webFiles.map(f => f.path).sort(), '组合5/步骤2：全局聚合与单会话列表是同一批文件');
  assert.ok(global.every(f => f.sessionId === started.id && typeof f.task === 'string'), '组合5/步骤2：聚合项带会话与任务标记');

  assert.equal((await mobile(ctx.url, `/api/mobile/sessions/${started.id}/artifacts`)).status, 401, '组合5/步骤3：产物只读路由同样要设备凭证');
});
