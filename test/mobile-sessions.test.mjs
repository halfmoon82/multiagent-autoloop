// sessions 节点（Spec §8.2.4 / §8.2.6 / DAG 节点 sessions）边界测试：
// 会话列表、新建会话、语义分类推荐、已归档与历史、只读查看与恢复。
// 覆盖错误行为：会话数据缺失显示空态；恢复失败保留原记录。
// 纯逻辑：feature 不碰 DOM、不依赖 node: 内置模块；后端投影 helper 是纯函数，不启动会话/不读写存档。
// 上游文本全程是纯字符串，由调用方用 textContent 之类安全方式渲染。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collection } from '../mobile/src/core/contract.mjs';
import {
  SESSION_KINDS, SESSION_KIND_LABELS, sessionKindLabel, END_STATUS_LABELS, endStatusLabel,
  SESSION_KIND_FILTERS, RESTORE_INJECTED_TURNS,
  buildSessionList, buildNewSessionForm, buildArchiveDetail, buildRestoreRequest, applyRestoreResult,
  SESSION_READ_PATHS, createSessionsReader, createSessionsWrite,
  visibleRange, mergeStreamFrames, shouldFollowScroll, hasVoiceHook,
  mobileSessionSummaries as browserSessionSummaries,
  mobileArchiveSummaries as browserArchiveSummaries,
  mobileArchiveTranscript as browserArchiveTranscript,
} from '../mobile/src/features/sessions/index.mjs';
import {
  SESSION_KIND_LABELS as BACKEND_KIND_LABELS,
  mobileSessionKindOptions, mobileSessionSummaries,
} from '../src/scheduling-session.mjs';
import {
  CONTINUATION_TURNS, mobileArchiveSummaries, mobileArchiveTranscript, mobileRestoreContext,
} from '../src/session-archive.mjs';

const FEATURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'src', 'features', 'sessions');

// 真实形态：/api/scheduling-sessions 的公开会话（toPublicSession）与 /api/session-archives 的规范化存档。
const ACTIVE = [
  {
    id: '11111111-1111-4111-8111-111111111111', kind: 'scheduling', status: 'running', statusText: '运行中',
    project: '/work/A 项目', agent: 'Codex ACP', model: 'gpt-5', continuedFrom: null,
    prompt: '请调度失败任务并恢复规则', queuedCount: 2, busy: true,
    createdAt: '2026-11-19T09:00:00.000Z', updatedAt: '2026-11-19T10:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222', kind: 'design', status: 'idle', statusText: '待命',
    project: '/work/B 项目', agent: 'Codex ACP', model: null, continuedFrom: null,
    prompt: '设计一个多租户改造方案并拆解 DAG', queuedCount: 0, busy: false,
    createdAt: '2026-11-18T09:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z',
  },
];
const ARCHIVED = [
  {
    version: 1, id: '33333333-3333-4333-8333-333333333333', kind: 'scheduling',
    project: '/work/A 项目', agent: 'Codex ACP', prompt: '旧的调度会话', continuedFrom: null,
    messages: [
      { role: 'user', text: '第一条', at: '2026-11-17T09:00:00.000Z' },
      { role: 'agent', text: '第二条', at: '2026-11-17T09:01:00.000Z' },
    ],
    createdAt: '2026-11-17T09:00:00.000Z', updatedAt: '2026-11-17T09:02:00.000Z',
    closedAt: '2026-11-17T09:05:00.000Z', endStatus: 'closed', truncated: false,
  },
];

// ---------------------------------------------------------------------------
// RED 1：契约与常量与后端同源（不重复定义口径）
// ---------------------------------------------------------------------------
test('会话类型/停止原因/恢复轮数与后端同源，不编造词表', () => {
  assert.deepEqual(SESSION_KINDS, ['normal', 'scheduling', 'design']);
  for (const kind of SESSION_KINDS) assert.equal(SESSION_KIND_LABELS[kind], BACKEND_KIND_LABELS[kind]);
  assert.deepEqual(mobileSessionKindOptions(), SESSION_KINDS.map(id => ({ id, label: BACKEND_KIND_LABELS[id] })));
  assert.equal(sessionKindLabel('unknown'), SESSION_KIND_LABELS.normal);
  assert.equal(sessionKindLabel('scheduling'), '调度会话');
  assert.equal(endStatusLabel('closed'), '已停止');
  assert.equal(endStatusLabel('unknown'), '未知');
  assert.equal(RESTORE_INJECTED_TURNS, CONTINUATION_TURNS, '恢复注入轮数必须与服务端存档口径一致');
  assert.deepEqual(SESSION_KIND_FILTERS.map(item => item.id), ['all', ...SESSION_KINDS]);
  assert.equal(END_STATUS_LABELS.closed, '已停止');
});

// ---------------------------------------------------------------------------
// RED 2：后端投影 helper——真实字段、缺失不编造、类型非法回退
// ---------------------------------------------------------------------------
test('mobileSessionSummaries 投影活跃会话的真实字段，缺失数据返回空', () => {
  assert.deepEqual(mobileSessionSummaries(null), []);
  assert.deepEqual(mobileSessionSummaries([null, 3, {}]), []);
  const list = mobileSessionSummaries(ACTIVE);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, ACTIVE[0].id);
  assert.equal(list[0].kind, 'scheduling');
  assert.equal(list[0].kindLabel, '调度会话');
  assert.equal(list[0].title, '请调度失败任务并恢复规则');
  assert.equal(list[0].project, '/work/A 项目');
  assert.equal(list[0].projectLabel, 'A 项目');
  assert.equal(list[0].statusLabel, '运行中');
  assert.equal(list[0].model, 'gpt-5');
  assert.equal(list[0].queuedCount, 2);
  assert.equal(list[0].busy, true);
  assert.equal(mobileSessionSummaries([{ id: 'x-1', project: '/p', kind: 'bogus' }])[0].kind, 'scheduling', '非法类型回退调度会话');
  assert.equal(mobileSessionSummaries([{ id: 'x-2' }])[0].title, '会话', '无提示词回退通用标题，不编造内容');
});

test('mobileArchiveSummaries 投影存档摘要：条数/停止原因/截断/续跑来源都取真实字段', () => {
  assert.deepEqual(mobileArchiveSummaries(undefined), []);
  const [item] = mobileArchiveSummaries(ARCHIVED);
  assert.equal(item.id, ARCHIVED[0].id);
  assert.equal(item.shortId, ARCHIVED[0].id.slice(0, 8));
  assert.equal(item.transcriptCount, 2);
  assert.equal(item.endStatus, 'closed');
  assert.equal(item.endStatusLabel, '已停止');
  assert.equal(item.projectLabel, 'A 项目');
  assert.equal(item.closedAt, '2026-11-17T09:05:00.000Z');
  assert.equal(item.continuedFrom, null);
  assert.equal(item.truncated, false);
});

// ---------------------------------------------------------------------------
// RED 3：只读查看与恢复上下文——不写存档、不创建会话、原记录保留
// ---------------------------------------------------------------------------
test('mobileArchiveTranscript 只读转录；mobileRestoreContext 注入最近轮数且保留原记录', () => {
  const transcript = mobileArchiveTranscript(ARCHIVED[0]);
  assert.equal(transcript.readOnly, true);
  assert.equal(transcript.messages.items.length, 2);
  assert.deepEqual(transcript.messages.items[0], { role: '主人', text: '第一条', at: '2026-11-17T09:00:00.000Z' });
  assert.deepEqual(transcript.messages.items[1], { role: '会话', text: '第二条', at: '2026-11-17T09:01:00.000Z' });
  assert.equal(mobileArchiveTranscript(null).empty, true, '无效存档返回明确空态');

  const context = mobileRestoreContext(ARCHIVED[0]);
  assert.equal(context.originalId, ARCHIVED[0].id);
  assert.equal(context.continuedFrom, ARCHIVED[0].id);
  assert.equal(context.project, '/work/A 项目');
  assert.equal(context.kind, 'scheduling');
  assert.equal(context.keepsOriginal, true);
  assert.equal(context.injectedTurns, 2, '只注入实际存在的轮数，不虚报 10 轮');
  assert.equal(context.command, `POST /api/scheduling-sessions/${ARCHIVED[0].id}/continue`);
});

// ---------------------------------------------------------------------------
// RED 4：buildSessionList——类型筛选/搜索/当前会话/新建入口/已归档折叠
// ---------------------------------------------------------------------------
test('会话列表按真实类型筛选与搜索，当前会话单列、新建入口与归档折叠区齐备', () => {
  const snapshot = {
    sessions: mobileSessionSummaries(ACTIVE),
    archives: mobileArchiveSummaries(ARCHIVED),
    currentId: ACTIVE[0].id,
  };
  const list = buildSessionList(snapshot);
  assert.equal(list.ready, true);
  assert.equal(list.error, null);
  assert.equal(list.kindFilter.selected, 'all');
  assert.equal(list.sessions.items.length, 2);
  assert.equal(list.current.id, ACTIVE[0].id);
  assert.equal(list.newSession.available, true);
  assert.equal(list.archived.collapsed, true, '已归档默认折叠');
  assert.equal(list.archived.count, 1);

  const scheduling = buildSessionList(snapshot, { kind: 'scheduling' });
  assert.equal(scheduling.sessions.items.length, 1);
  assert.equal(scheduling.sessions.items[0].id, ACTIVE[0].id);
  assert.equal(scheduling.kindFilter.selected, 'scheduling');

  const searched = buildSessionList(snapshot, { query: 'B 项目' });
  assert.equal(searched.sessions.items.length, 1);
  assert.equal(searched.sessions.items[0].id, ACTIVE[1].id);

  const invalid = buildSessionList(snapshot, { kind: 'bogus' });
  assert.equal(invalid.kindFilter.selected, 'all', '非法筛选回退全部');
});

// ---------------------------------------------------------------------------
// RED 5：错误行为——会话/归档数据缺失显示空态，绝不编造会话
// ---------------------------------------------------------------------------
test('会话或归档数据缺失时列表显示明确空态，不编造会话或归档', () => {
  const missing = buildSessionList({ sessions: null, archives: null, sessionsError: '读取失败' });
  assert.equal(missing.ready, false);
  assert.match(missing.error, /读取失败/);
  assert.equal(missing.sessions.empty, true);
  assert.match(missing.sessions.reason, /会话数据缺失/);
  assert.equal(missing.archived.empty, true);
  assert.match(missing.archived.reason, /归档数据缺失/);
  assert.equal(missing.current, null);
  assert.equal(missing.newSession.available, false);

  const emptyArchives = buildSessionList({ sessions: mobileSessionSummaries(ACTIVE), archives: [] });
  assert.equal(emptyArchives.archived.empty, true);
  assert.match(emptyArchives.archived.reason, /暂无已归档会话/);
});

// ---------------------------------------------------------------------------
// RED 6：新建会话与语义分类推荐（可手动覆盖）
// ---------------------------------------------------------------------------
test('新建会话表单带语义分类推荐、允许手动覆盖、信息不足不可提交', () => {
  const projects = [{ id: '/work/A 项目', label: 'A 项目' }, { id: '/work/B 项目', label: 'B 项目' }];
  const form = buildNewSessionForm({
    projects,
    prompt: '请调度失败任务并恢复规则',
    classification: { kind: 'scheduling', reason: '意图是恢复规则' },
  });
  assert.equal(form.recommendation.kind, 'scheduling');
  assert.equal(form.recommendation.label, '调度会话');
  assert.equal(form.recommendation.reason, '意图是恢复规则');
  assert.equal(form.selectedKind, 'scheduling', '默认采用推荐类型');
  assert.equal(form.kindOptions.find(item => item.id === 'scheduling').recommended, true);
  assert.equal(form.canSubmit, true);
  assert.equal(form.action, 'create-session');

  const overridden = buildNewSessionForm({ projects, prompt: 'x', classification: { kind: 'scheduling', reason: 'r' }, selectedKind: 'normal' });
  assert.equal(overridden.selectedKind, 'normal', '用户可覆盖推荐');
  assert.equal(overridden.kindOptions.find(item => item.id === 'scheduling').recommended, true, '推荐仍可见');

  const noProject = buildNewSessionForm({ projects: [], prompt: 'x' });
  assert.equal(noProject.projectOptions.empty, true);
  assert.equal(noProject.canSubmit, false);
  const noPrompt = buildNewSessionForm({ projects, prompt: '   ' });
  assert.equal(noPrompt.canSubmit, false, '首轮提示词必填');
  const noClassify = buildNewSessionForm({ projects, prompt: 'x' });
  assert.equal(noClassify.recommendation, null, '没有分类结果不编造推荐');
  assert.equal(noClassify.selectedKind, 'normal');
});

// ---------------------------------------------------------------------------
// RED 7：只读详情 + 恢复请求 + 恢复失败保留原记录
// ---------------------------------------------------------------------------
test('归档会话可只读查看并通过 continue 恢复为新会话', () => {
  const archiveSummary = mobileArchiveSummaries(ARCHIVED)[0];
  const detail = buildArchiveDetail(mobileArchiveTranscript(ARCHIVED[0]));
  assert.equal(detail.id, archiveSummary.id);
  assert.equal(detail.readOnly, true);
  assert.equal(detail.messages.items.length, 2);
  assert.equal(detail.restore.action, 'restore-session');
  assert.equal(detail.restore.keepsOriginal, true);
  assert.equal(buildArchiveDetail(null).empty, true, '缺失详情显示空态');

  const request = buildRestoreRequest(archiveSummary);
  assert.equal(request.method, 'POST');
  assert.equal(request.path, `/api/scheduling-sessions/${ARCHIVED[0].id}/continue`);
  assert.equal(request.keepsOriginal, true);
  assert.equal(request.injectedTurns, RESTORE_INJECTED_TURNS);
  assert.match(request.note, /原记录保留/);
});

test('恢复失败保留原归档记录并带错误；成功也不删除原记录', () => {
  const archived = collection(mobileArchiveSummaries(ARCHIVED), '暂无已归档会话');
  const failed = applyRestoreResult(archived, ARCHIVED[0].id, { ok: false, error: '该项目不可恢复' });
  assert.equal(failed.items.length, 1, '恢复失败原记录仍在');
  assert.equal(failed.items[0].id, ARCHIVED[0].id);
  assert.match(failed.items[0].restoreError, /该项目不可恢复/);
  assert.equal(failed.items[0].restoredTo, null);

  const ok = applyRestoreResult(archived, ARCHIVED[0].id, { ok: true, newSessionId: 'new-session-1' });
  assert.equal(ok.items.length, 1, '恢复成功原记录仍保留');
  assert.equal(ok.items[0].restoreError, null);
  assert.equal(ok.items[0].restoredTo, 'new-session-1');

  const untouched = applyRestoreResult(archived, 'other-id', { ok: false, error: 'x' });
  assert.equal(untouched.items[0].restoreError, undefined, '未涉及的记录不被改动');
});

// ---------------------------------------------------------------------------
// RED 8：端到端 + 纯逻辑/安全渲染
// ---------------------------------------------------------------------------
test('端到端：真实公开会话 + 存档 → 列表 → 新建 → 只读 → 恢复', () => {
  const summaries = mobileSessionSummaries(ACTIVE);
  const archives = mobileArchiveSummaries(ARCHIVED);
  const list = buildSessionList({ sessions: summaries, archives, currentId: ACTIVE[0].id });
  assert.equal(list.sessions.items.length, 2);
  const form = buildNewSessionForm({
    projects: summaries.map(item => ({ id: item.project, label: item.projectLabel })),
    prompt: '设计一个新功能',
    classification: { kind: 'design', reason: '复杂改造' },
  });
  assert.equal(form.selectedKind, 'design');
  const detail = buildArchiveDetail(mobileArchiveTranscript(ARCHIVED[0]));
  const req = buildRestoreRequest(archives[0]);
  assert.equal(detail.id, ARCHIVED[0].id);
  assert.equal(req.path.includes(ARCHIVED[0].id), true);
});

test('feature 是纯逻辑：不依赖 node: 内置模块、不碰 DOM、不拼接 HTML', () => {
  const files = readdirSync(FEATURE_DIR).filter(name => name.endsWith('.mjs'));
  assert.ok(files.length > 0, 'feature 目录至少有一个 .mjs');
  for (const name of files) {
    const source = readFileSync(path.join(FEATURE_DIR, name), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(source), `${name} 不得 import node: 内置模块`);
    assert.ok(!/\bdocument\.|\bwindow\.|\blocalStorage\b/.test(source.replace(/\/\/.*$/gm, '')), `${name} 不得直接碰 DOM/浏览器存储`);
    assert.ok(!/innerHTML|insertAdjacentHTML/.test(source), `${name} 不得拼接 HTML`);
  }
});

test('上游文本全程是纯字符串：视图模型可安全渲染，不泄漏凭据', () => {
  const dump = JSON.stringify({
    list: buildSessionList({ sessions: mobileSessionSummaries(ACTIVE), archives: mobileArchiveSummaries(ARCHIVED) }),
    form: buildNewSessionForm({
      projects: [{ id: '/p', label: 'P' }],
      prompt: '请调度失败任务',
      classification: { kind: 'scheduling', reason: '恢复规则' },
    }),
    detail: buildArchiveDetail(mobileArchiveTranscript(ARCHIVED[0])),
  });
  assert.ok(!dump.includes('<script') && !dump.includes('</div>') && !dump.includes('onerror='));
  assert.ok(!dump.includes('deviceToken') && !dump.includes('ownerKey') && !dump.includes('server-secret'));
});

// ---------------------------------------------------------------------------
// RED 9：浏览器侧投影与后端同源（页面拿真实接口数据，口径不漂移）
// ---------------------------------------------------------------------------
test('浏览器侧会话/存档/转录投影与后端同源，缺失不编造', () => {
  assert.deepEqual(browserSessionSummaries(ACTIVE), mobileSessionSummaries(ACTIVE));
  assert.deepEqual(browserSessionSummaries(null), []);
  assert.deepEqual(browserSessionSummaries([null, 3, {}]), []);
  assert.deepEqual(browserArchiveSummaries(ARCHIVED), mobileArchiveSummaries(ARCHIVED));
  assert.deepEqual(browserArchiveSummaries(undefined), []);
  assert.deepEqual(browserArchiveTranscript(ARCHIVED[0]), mobileArchiveTranscript(ARCHIVED[0]));
  assert.equal(browserArchiveTranscript(null).empty, true);
});

// ---------------------------------------------------------------------------
// RED 10：只读读取器——固定路径、同源校验、组装快照与错误态
// ---------------------------------------------------------------------------
test('createSessionsReader 走固定只读路径、同源校验，并组装列表快照', async () => {
  assert.deepEqual([...SESSION_READ_PATHS], ['/api/scheduling-sessions', '/api/session-archives']);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    const path = new URL(url).pathname;
    return { ok: true, json: async () => (path === '/api/scheduling-sessions' ? ACTIVE : { sessions: ARCHIVED }) };
  };
  const reader = createSessionsReader({ origin: 'https://auto.socialmore.net', fetchImpl });
  const { snapshot, list } = await reader.load();
  assert.equal(calls.length, 2);
  for (const [url] of calls) assert.equal(new URL(url).origin, 'https://auto.socialmore.net');
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(snapshot.archives.length, 1);
  assert.equal(snapshot.currentId, ACTIVE[0].id);
  assert.equal(list.sessions.items.length, 2);
  assert.equal(list.archived.count, 1);
});

test('createSessionsReader 读取失败给出明确错误态，不编造会话', async () => {
  const fetchImpl = async url => {
    if (new URL(url).pathname === '/api/scheduling-sessions') throw new Error('网络断开');
    return { ok: true, json: async () => ({ sessions: [] }) };
  };
  const { snapshot, list } = await createSessionsReader({ origin: 'https://auto.socialmore.net', fetchImpl }).load();
  assert.equal(list.ready, false);
  assert.match(snapshot.sessionsError, /无法连接控制台/);
  assert.equal(list.sessions.empty, true);
  assert.equal(list.current, null);
});

// ---------------------------------------------------------------------------
// RED 11：写助手——只打固定写路由、设备凭证在头、失败可读
// ---------------------------------------------------------------------------
test('createSessionsWrite 只打固定写路由：继续调度与卡片作答', async () => {
  const calls = [];
  const client = { origin: 'https://auto.socialmore.net', tokenStore: { get: async () => 'device-token' } };
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const write = createSessionsWrite(client, { fetchImpl });
  await write.continueSession('arch-1');
  await write.answerCard(8, { choice: 1 });
  await write.answerCard(9, { text: '补充说明' });
  assert.equal(new URL(calls[0][0]).pathname, '/api/mobile/sessions/arch-1/continue');
  assert.deepEqual(JSON.parse(calls[0][1].body), {});
  assert.equal(new URL(calls[1][0]).pathname, '/api/mobile/cards/8/answer');
  assert.deepEqual(JSON.parse(calls[1][1].body), { choice: 1 });
  assert.deepEqual(JSON.parse(calls[2][1].body), { text: '补充说明' });
  for (const [, init] of calls) {
    assert.equal(init.headers['x-device-token'], 'device-token');
    assert.equal(init.headers['x-console-request'], '1');
    assert.equal(init.headers['content-type'], 'application/json');
  }
});

test('createSessionsWrite 未绑定拒绝、跨域拒绝、错误转成可读文案', async () => {
  const client = { origin: 'https://auto.socialmore.net', tokenStore: { get: async () => null } };
  const fetchImpl = async () => { throw new Error('不应发出请求'); };
  await assert.rejects(() => createSessionsWrite(client, { fetchImpl }).continueSession('x'), /尚未绑定设备/);
  const bound = { origin: 'https://auto.socialmore.net', tokenStore: { get: async () => 't' } };
  const failing = async () => ({ ok: false, status: 409, json: async () => ({ error: '事项已失效' }) });
  await assert.rejects(
    () => createSessionsWrite(bound, { fetchImpl: failing }).answerCard(8, { choice: 0 }),
    /事项已失效/,
  );
});

// ---------------------------------------------------------------------------
// RED 12：聊天体验纯逻辑——虚拟列表窗口、流式按帧合并、跟随判定、语音钩子
// ---------------------------------------------------------------------------
test('虚拟列表只计算可视区附近的窗口，避免长会话整表渲染', () => {
  assert.deepEqual(
    visibleRange({ scrollTop: 600, viewportHeight: 300, itemHeight: 60, total: 500, overscan: 2 }),
    { start: 8, end: 17 },
  );
  assert.deepEqual(
    visibleRange({ scrollTop: 0, viewportHeight: 0, itemHeight: 60, total: 3 }),
    { start: 0, end: 3 },
  );
  assert.deepEqual(
    visibleRange({ scrollTop: 100000, viewportHeight: 300, itemHeight: 60, total: 3, overscan: 2 }),
    { start: 3, end: 3 },
  );
});

test('流式分片合并且上翻时不被拉回底部', () => {
  assert.equal(mergeStreamFrames(['你', '好', '，', '世界']), '你好，世界');
  assert.equal(mergeStreamFrames([]), '');
  assert.equal(shouldFollowScroll({ scrollTop: 920, scrollHeight: 1000, clientHeight: 100 }), true);
  assert.equal(shouldFollowScroll({ scrollTop: 300, scrollHeight: 1000, clientHeight: 100 }), false);
  assert.equal(shouldFollowScroll({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), true);
});

test('语音钩子为空操作时无麦克风按钮，真实实现才显示', () => {
  assert.equal(hasVoiceHook({ attachVoice() {} }), false);
  assert.equal(hasVoiceHook({ attachVoice: () => {} }), false);
  assert.equal(hasVoiceHook({}), false);
  assert.equal(hasVoiceHook({ attachVoice(el) { return el; } }), true);
});

test('createSessionsWrite 新建会话与语义分类复用同源 web 接口', async () => {
  const calls = [];
  const client = { origin: 'https://auto.socialmore.net', tokenStore: { get: async () => 't' } };
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    return { ok: true, json: async () => ({ kind: 'scheduling', reason: '恢复规则' }) };
  };
  const write = createSessionsWrite(client, { fetchImpl });
  await write.classify('请调度失败任务');
  await write.createSession({ project: '/work/A 项目', prompt: '请调度失败任务', kind: 'scheduling' });
  assert.equal(new URL(calls[0][0]).pathname, '/api/session-classify');
  assert.deepEqual(JSON.parse(calls[0][1].body), { text: '请调度失败任务' });
  assert.equal(new URL(calls[1][0]).pathname, '/api/scheduling-sessions');
  assert.deepEqual(JSON.parse(calls[1][1].body), { project: '/work/A 项目', prompt: '请调度失败任务', kind: 'scheduling' });
});
