// session-actions 节点：左滑关闭手势、设计会话双按钮显隐、授权确认页逻辑与数据通道的纯逻辑回归。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRowSwipe, applyCloseResult, designSessionActions, ROW_SWIPE_REVEAL_PX,
  createSessionsWrite, createSessionsReader,
} from '../mobile/src/features/sessions/index.mjs';
import { buildAuthorizeView, buildCreateBody, createAuthorizeClient } from '../mobile/src/features/design-authorize/index.mjs';

const PLAN = {
  project: '/work/p', planId: 'plan-1', planDigest: 'a'.repeat(64), title: '计划一', remoteUrl: 'https://example.com/r.git',
  maxParallel: 3, allowedActions: ['worktree', 'run-tests'], deniedActions: ['deploy'],
  nodes: [{ id: 'n1', title: '节点一', files: ['src/a.mjs'], dependsOn: [], wave: 1 }, { id: 'integration-review', title: '整合审查', files: [], dependsOn: ['n1'], wave: 2, integrationReview: true }],
};

test('左滑越过半幅停在展开态，未过半回弹，纵向滚动不触发', () => {
  const swipe = createRowSwipe();
  assert.ok(swipe.start({ x: 300, y: 100 }));
  assert.deepEqual(swipe.move({ x: 300 - ROW_SWIPE_REVEAL_PX, y: 102 }).dragging, true);
  const opened = swipe.end();
  assert.equal(opened.result, 'open');
  assert.equal(opened.offset, -ROW_SWIPE_REVEAL_PX);

  swipe.close();
  swipe.start({ x: 300, y: 100 });
  swipe.move({ x: 300 - 20, y: 101 });
  assert.equal(swipe.end().result, 'revert', '位移不足半幅回弹');

  swipe.start({ x: 300, y: 100 });
  assert.equal(swipe.move({ x: 296, y: 160 }).dragging, false, '纵向主导不拖动');
  assert.equal(swipe.end().result, 'revert');
});

test('滑动不算点击；纯点击才是 tap；展开后右拖可收起；偏移被夹在 [-露出宽度, 0]', () => {
  const swipe = createRowSwipe();
  swipe.start({ x: 200, y: 50 });
  assert.equal(swipe.end().result, 'tap');

  swipe.start({ x: 200, y: 50 });
  assert.equal(swipe.move({ x: 50, y: 50 }).offset, -ROW_SWIPE_REVEAL_PX, '左拉不超过露出宽度');
  swipe.end();
  assert.equal(swipe.open, true);

  swipe.start({ x: 100, y: 50 });
  assert.equal(swipe.move({ x: 400, y: 50 }).offset, 0, '右拉不越过 0');
  assert.equal(swipe.end().result, 'close');
  assert.equal(swipe.open, false);

  swipe.start({ x: 100, y: 50 });
  swipe.move({ x: 60, y: 50 });
  swipe.cancel();
  assert.equal(swipe.offset, 0, '取消回到手势前状态');
  assert.equal(swipe.start({ x: Number.NaN, y: 1 }), false, '非法坐标不起手');
});

test('关闭结果收口：成功才移除该行；失败保留原状并带原因', () => {
  const col = { items: [{ id: 'a' }, { id: 'b' }], empty: false, reason: null };
  assert.deepEqual(applyCloseResult(col, 'a', { ok: true }).items.map(item => item.id), ['b']);
  assert.equal(applyCloseResult({ items: [{ id: 'a' }], empty: false }, 'a', { ok: true }).empty, true);
  const failed = applyCloseResult(col, 'a', { ok: false, error: '会话已关闭' });
  assert.deepEqual(failed.items.map(item => item.id), ['a', 'b']);
  assert.equal(failed.items[0].closeError, '会话已关闭');
  assert.equal(failed.items[1].closeError, undefined);
});

test('设计会话按钮显隐：仅设计会话；已放行不再出示「放行落盘」；「确认执行范围」恒有', () => {
  assert.deepEqual(designSessionActions({ kind: 'normal' }), []);
  assert.deepEqual(designSessionActions(null), []);
  assert.deepEqual(designSessionActions({ kind: 'design', planApproved: false }).map(item => item.id), ['approve-plan', 'design-authorize']);
  assert.deepEqual(designSessionActions({ kind: 'design', planApproved: true }).map(item => item.id), ['design-authorize']);
  assert.equal(designSessionActions({ kind: 'design' })[0].label, '确认计划 · 放行落盘');
});

test('授权视图：逐条出示；未勾选/缺 planDigest/提交中/已创建一律不可提交', () => {
  const view = buildAuthorizeView(PLAN, { checks: [{ id: 'plan-source', label: '计划来源', ok: true, message: 'ok' }] }, { acknowledged: true });
  assert.equal(view.ready, true);
  assert.equal(view.canSubmit, true);
  assert.deepEqual(view.summary, { businessNodes: 1, reviewNodes: 1, maxParallel: 3 });
  assert.equal(view.nodes[0].files[0], 'src/a.mjs');
  assert.deepEqual(view.allowed.map(item => item.label), ['独立 worktree', '离线测试']);
  assert.deepEqual(view.denied.map(item => item.label), ['部署']);
  assert.equal(view.checks[0].ok, true);

  assert.equal(buildAuthorizeView(PLAN, null, { acknowledged: false }).canSubmit, false, '未勾选不可提交');
  assert.equal(buildAuthorizeView({ ...PLAN, planDigest: '' }, null, { acknowledged: true }).canSubmit, false);
  assert.equal(buildAuthorizeView(null, null, { acknowledged: true }).canSubmit, false);
  assert.equal(buildAuthorizeView(PLAN, null, { acknowledged: true, submitting: true }).canSubmit, false);
  assert.equal(buildAuthorizeView(PLAN, null, { acknowledged: true, created: { runId: 'r' } }).canSubmit, false);
  assert.equal(buildAuthorizeView({ ...PLAN, remoteUrl: null }).remoteLabel, '未发现远端（不能推送）');
});

test('提交体：planDigest/动作清单原样取自计划；未勾选不产出请求体', () => {
  assert.equal(buildCreateBody(PLAN, { acknowledged: false }), null);
  assert.equal(buildCreateBody({ ...PLAN, allowedActions: [] }, { acknowledged: true }), null);
  assert.deepEqual(buildCreateBody(PLAN, { acknowledged: true }), {
    project: '/work/p', planId: 'plan-1', planDigest: 'a'.repeat(64), remoteUrl: 'https://example.com/r.git',
    confirm: true, confirmedActionIds: ['worktree', 'run-tests'], selectedOptionalActions: [],
  });
});

const fakeClient = { origin: 'https://console.example', tokenStore: { async get() { return 'tok'; } } };

test('授权通道：只打固定移动端路由、令牌在头；计划失败即抛，预检失败不阻止出示计划；未勾选不发请求', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body });
    const u = new URL(url);
    if (u.pathname === '/api/mobile/dag-plan') return { ok: true, status: 200, json: async () => PLAN };
    if (u.pathname === '/api/mobile/dag-preflight') return { ok: false, status: 500, json: async () => ({ error: '预检失败' }) };
    if (u.pathname === '/api/mobile/dag-runs') return { ok: true, status: 201, json: async () => ({ runId: 'dagrun-1' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const client = createAuthorizeClient(fakeClient, { fetchImpl });
  const loaded = await client.loadPlan('/work/p', 'plan-1');
  assert.equal(loaded.plan.planDigest, PLAN.planDigest);
  assert.equal(loaded.preflight, null);
  assert.match(loaded.preflightError, /预检失败/);
  assert.ok(seen.every(item => item.headers['x-device-token'] === 'tok'));
  assert.ok(seen.every(item => new URL(item.url).pathname.startsWith('/api/mobile/')));

  await assert.rejects(() => client.createRun(null), /勾选/);
  assert.equal(seen.filter(item => item.method === 'POST').length, 0, '未勾选不发请求');
  const created = await client.createRun(buildCreateBody(PLAN, { acknowledged: true }));
  assert.equal(created.runId, 'dagrun-1');
  const post = seen.find(item => item.method === 'POST');
  assert.equal(post.headers['x-console-request'], '1');
  assert.equal(JSON.parse(post.body).confirm, true);

  const failing = createAuthorizeClient(fakeClient, { fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'PLAN_DIGEST_MISMATCH：计划已变化需重新确认' }) }) });
  await assert.rejects(() => failing.createRun(buildCreateBody(PLAN, { acknowledged: true })), /计划已变化/);
  await assert.rejects(() => client.loadPlan('/work/p', '  '), /计划编号/);
});

test('会话写通道：closeSession / approvePlan 走固定路由；planApproved 并回会话摘要', async () => {
  const calls = [];
  const write = createSessionsWrite(fakeClient, { fetchImpl: async (url, init) => { calls.push([new URL(url).pathname, init.method]); return { ok: true, status: 200, json: async () => ({}) }; } });
  await write.closeSession('sess a');
  await write.approvePlan('sess-b');
  assert.deepEqual(calls, [['/api/mobile/sessions/sess%20a/close', 'POST'], ['/api/mobile/sessions/sess-b/approve-plan', 'POST']]);
  assert.throws(() => write.closeSession('  '), /不存在/);

  const reader = createSessionsReader({
    origin: fakeClient.origin, getToken: () => 'tok',
    fetchImpl: async url => ({
      ok: true, status: 200,
      json: async () => (url.endsWith('/sessions')
        ? [{ id: 'sess-1', kind: 'design', planApproved: true, prompt: 'p', updatedAt: '2026-11-24T00:00:00Z' }, { id: 'sess-2', kind: 'design', prompt: 'q', updatedAt: '2026-11-23T00:00:00Z' }]
        : { sessions: [] }),
    }),
  });
  const { snapshot } = await reader.load();
  assert.deepEqual(snapshot.sessions.map(item => [item.id, item.planApproved]), [['sess-1', true], ['sess-2', false]]);
});
