// final-acceptance 节点（Spec §12 / DAG plan wave-10 / issue 13）综合验收测试。
// 目的：在 CI/PR 可自动执行的范围内，逐条核对 PRD §8 成功标准与 Spec §12 验收项，
// 由各前置节点的真实实现模块承接；不复制业务状态、不调用真实模型、不操作真实规则。
//
// 异常行为（节点契约 error_behavior）：未覆盖项明确披露，不自动触发部署或生产变更。
// 因此本文件只对「代码可判定」的验收项下结论；APK 打包/签名/安装、真机 smoke、
// 生物识别真机验证、真实推送供应商配置需单独授权，列在 REQUIRES_OWNER_AUTHORIZATION 并显式披露，
// 且断言 APK 打包门禁在未获授权时拒绝执行——绝不把「模拟通过」说成真机通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeBaseUrl, mobileApiUrl, MOBILE_API_KEYS, createBiometricGate } from '../mobile/app/www/shell.mjs';
import {
  NOTIFICATION_KINDS, DIRECT_REPLY_REQUIRES_BIOMETRIC, OPEN_APP_REQUIRES_BIOMETRIC,
  notificationKey, isNotifiableNodeEvent, badgeCount, buildTodoNotification, buildNodeDoneNotification,
} from '../mobile/src/features/notifications/index.mjs';
import {
  PROJECT_FILTER_TABS, buildProjectFilter, switchProject, buildFilterTabs,
  applyGlobalFilter, sessionProjectContext,
} from '../mobile/src/features/project-filter/index.mjs';
import {
  CONTRACT_ROWS, RING_MISSING_REASON, buildDagRingView, selectRing, buildNodeDetailView,
} from '../mobile/src/features/dag-ring/index.mjs';
import { RESTORE_INJECTED_TURNS, buildArchiveDetail, buildRestoreRequest } from '../mobile/src/features/sessions/index.mjs';
import {
  VOICE_STATES, VOICE_SEND_ON_PAUSE, isKeyboardFallbackState, createVoiceInput, startVoice,
} from '../mobile/src/features/voice-input/index.mjs';
import {
  QUESTION_SELECT_AUTO_SUBMIT, QUESTION_RESUBMIT_ANSWERED, createQuestionGroup,
  submitAnswer, setDraft, setScrollTop, snapshotGroup, restoreGroup,
} from '../mobile/src/features/question-group/index.mjs';
import {
  ARTIFACT_ENTRY_POINTS, ARTIFACT_MOBILE_READ_ONLY, createArtifactBrowser,
  openFromSession, selectArtifact, setReaderScrollTop, backFromArtifacts, restoreBrowser, snapshotBrowser,
} from '../mobile/src/features/artifacts/index.mjs';
import {
  FONT_SCALE_STEPS, FONT_SCALE_MAX, TOUCH_TARGET_MIN_DP, TOUCH_TARGET_MAX_DP,
  normalizeFontScale, scaledFontDp, layoutForFontScale, touchTarget, reduceOptionState, isInteractive,
} from '../mobile/src/features/font-touch/index.mjs';
import { createSyncState, applySubmission, reconcile } from '../mobile/src/features/device-sync/index.mjs';
import { createDeviceStore, DeviceAuthError } from '../src/device-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AT = '2026-11-19T12:00:00+08:00';

function seqRandom() {
  let seq = 0;
  return () => Buffer.from(`${String(++seq).padStart(64, '0')}`, 'hex');
}

// ---------------------------------------------------------------------------
// 验收覆盖矩阵：PRD §8 的 10 条成功标准，每条都必须有真实实现与边界回归承接。
// 只登记「代码可判定」的部分；APK/真机类在下面的 REQUIRES_OWNER_AUTHORIZATION 单独披露。
// ---------------------------------------------------------------------------
const PRD_ACCEPTANCE = Object.freeze([
  { id: 1, title: '任意移动网络或外部 Wi-Fi 直接用核心能力', impl: 'mobile/app/www/shell.mjs', regression: 'test/mobile-shell.test.mjs' },
  { id: 2, title: '待办与节点完成通知稳定触达且与 App 状态一致', impl: 'mobile/src/features/notifications/index.mjs', regression: 'test/notifications.test.mjs' },
  { id: 3, title: '手机完成待办回答不丢上下文/草稿/滚动位置', impl: 'mobile/src/features/question-group/groups.mjs', regression: 'test/mobile-question-group.test.mjs' },
  { id: 4, title: '全局一级项目筛选，所有主要 Tab 同步生效', impl: 'mobile/src/features/project-filter/index.mjs', regression: 'test/mobile-project-filter.test.mjs' },
  { id: 5, title: '项目 DAG 环形图，信息与基线一一对应', impl: 'mobile/src/features/dag-ring/ring.mjs', regression: 'test/mobile-dag-ring.test.mjs' },
  { id: 6, title: '会话内同时看到待回答组、产物与归档历史', impl: 'mobile/src/features/sessions/views.mjs', regression: 'test/mobile-sessions.test.mjs' },
  { id: 7, title: '产物可从会话直接打开并返回原会话', impl: 'mobile/src/features/artifacts/browser.mjs', regression: 'test/mobile-artifacts.test.mjs' },
  { id: 8, title: '系统字体 160% 无截断/遮挡/横向溢出', impl: 'mobile/src/features/font-touch/font.mjs', regression: 'test/mobile-font-touch.test.mjs' },
  { id: 9, title: '网页后台可绑定/查看/解除，移动端不能越权', impl: 'src/device-auth.mjs', regression: 'test/device-auth.test.mjs' },
  { id: 10, title: '多设备同时绑定，任意一台提交后其他设备同步', impl: 'mobile/src/features/device-sync/sync.mjs', regression: 'test/device-sync.test.mjs' },
]);

// 需本人/真机授权，CI 与 PR 合并不自动触发的项——明确披露，不谎称已通过。
const REQUIRES_OWNER_AUTHORIZATION = Object.freeze([
  { item: 'Android APK 打包、签名，并在旧版鸿蒙设备安装启动', reason: '需单独授权与人工值守；门禁 AUTH_ENV 未开启时拒绝执行', authorizedInCi: false },
  { item: '真机 smoke：设备绑定、通知、锁屏直复、语音、字体放大', reason: '需真实设备与本人掌握的凭据/生物特征', authorizedInCi: false },
  { item: '系统生物识别真机验证（打开 App 与锁屏直复）', reason: '需真机与本人生物特征，模拟验证不算真机通过', authorizedInCi: false },
  { item: '真实推送供应商配置与通知触达', reason: '需本人掌握的第三方账号与密钥', authorizedInCi: false },
]);

test('PRD §8 十条成功标准逐条有实现模块与回归测试承接，无遗漏', () => {
  assert.equal(PRD_ACCEPTANCE.length, 10);
  const ids = PRD_ACCEPTANCE.map(row => row.id);
  assert.deepEqual(ids, Array.from({ length: 10 }, (_, i) => i + 1), '成功标准 1–10 必须连续齐全');
  for (const row of PRD_ACCEPTANCE) {
    assert.ok(row.title, `标准 ${row.id} 必须有说明`);
    assert.ok(existsSync(path.join(ROOT, row.impl)), `标准 ${row.id} 的实现文件须存在：${row.impl}`);
    assert.ok(existsSync(path.join(ROOT, row.regression)), `标准 ${row.id} 的回归测试须存在：${row.regression}`);
  }
});

// ---------------------------------------------------------------------------
// 标准 1：任意网络/安全连接 + 移动端不越权中继设备授权
// ---------------------------------------------------------------------------
test('SC1 任意网络直接用：远程强制 HTTPS，仅回环可 http，移动端不中继设备授权 API', () => {
  assert.equal(normalizeBaseUrl('https://console.example.com/'), 'https://console.example.com');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:50761/'), 'http://127.0.0.1:50761');
  assert.throws(() => normalizeBaseUrl('http://console.example.com/'), error => error.code === 'INSECURE_BASE');
  assert.throws(() => normalizeBaseUrl('https://user:pass@console.example.com/'), error => error.code === 'INVALID_BASE');
  assert.throws(() => normalizeBaseUrl('https://console.example.com/path'), error => error.code === 'INVALID_BASE');
  assert.ok(MOBILE_API_KEYS.includes('state') && MOBILE_API_KEYS.includes('dag-runs'));
  assert.ok(!MOBILE_API_KEYS.some(key => key.includes('devices')), '设备授权管理只对网页后台开放');
  assert.throws(() => mobileApiUrl('https://console.example.com/', 'devices'), error => error.code === 'API_NOT_ALLOWED');
});

test('SC1 生物识别门禁：无可用验证器时明确失败，不静默放行', async () => {
  const denied = createBiometricGate({ verifier: async () => false });
  assert.equal(await denied.verify(), false);
  const granted = createBiometricGate({ verifier: async () => true });
  assert.equal(await granted.verify(), true);
  await assert.rejects(() => createBiometricGate().verify(), error => error.code === 'BIOMETRIC_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// 标准 2：待办/节点完成独立通知、去重、角标、去敏、状态同步
// ---------------------------------------------------------------------------
test('SC2 通知：待办与节点完成各自独立、可去重；普通失败不通知；锁屏内容不泄露凭据', () => {
  const card = { id: 'c1', project: '/work/移动控制台', title: '网络访问边界', text: 'token=sk-abc123 请确认', options: ['任意网络'], createdAt: AT };
  const todo = buildTodoNotification(card);
  assert.equal(todo.kind, NOTIFICATION_KINDS.TODO);
  assert.match(todo.body, /项目 移动控制台/);
  assert.equal(notificationKey(NOTIFICATION_KINDS.TODO, 'c1', AT), todo.key);
  assert.equal(buildTodoNotification(card).key, todo.key, '同一待办 key 稳定，可去重');
  const todoDump = JSON.stringify(todo);
  assert.ok(!todoDump.includes('sk-abc123'), '疑似凭据被清洗');
  assert.equal(todo.reply.requiresBiometric, DIRECT_REPLY_REQUIRES_BIOMETRIC, '锁屏直复需生物识别');
  assert.equal(todo.click.requiresBiometric, OPEN_APP_REQUIRES_BIOMETRIC, '进 App 后不额外加门槛');

  assert.equal(isNotifiableNodeEvent({ type: 'dag.node.advance', outcome: 'done' }), true);
  assert.equal(isNotifiableNodeEvent({ type: 'dag.node.advance', outcome: 'failed' }), false, '普通失败不通知');
  assert.equal(isNotifiableNodeEvent({ type: 'tick', outcome: 'done' }), false, '调度自愈不通知');
  const done = buildNodeDoneNotification({
    runId: 'r1', nodeId: 'final-acceptance', advanceId: 'a1', project: '/work/mobile',
    title: '节点完成', summary: '开发完成', detail: {
      prUrl: 'https://github.com/o/r/pull/1', commit: 'abc123', tests: 'npm test 全绿', leakField: 'SECRET_LEAK',
    },
  });
  assert.equal(done.kind, NOTIFICATION_KINDS.NODE_DONE);
  assert.equal(done.badgeKey, null, '节点完成不占角标');
  assert.match(done.detail, /https:\/\/github.com\/o\/r\/pull\/1/);
  assert.ok(!JSON.stringify(done).includes('SECRET_LEAK'), 'detail 任意字段不透传进锁屏');
  assert.equal(badgeCount([{ state: 'open' }, { state: 'decided' }, { state: 'open' }]), 2);
  assert.equal(badgeCount([{ state: 'open' }, { state: 'closed' }]), 1, '处理后角标同步减少');
});

// ---------------------------------------------------------------------------
// 标准 3：待办回答不丢上下文/草稿/滚动位置，失败保留草稿
// ---------------------------------------------------------------------------
test('SC3 待办回答：快照/旋转后上下文、草稿与滚动位置逐字保留；提交失败不清空', () => {
  const g0 = createQuestionGroup({
    id: 'g1', sessionId: 's1', sourceText: '请确认两点', contextText: '原话背景',
    questions: [
      { id: 'q1', kind: 'choice', prompt: '网络范围？', options: ['任意网络', '仅私网'] },
      { id: 'q2', kind: 'text', prompt: '补充说明' },
    ],
    scrollTop: 120,
  });
  let g = setDraft(g0, 'q2', '我的草稿');
  g = setScrollTop(g, 321);
  g = submitAnswer(g, 'q1', '任意网络');
  const restored = restoreGroup(snapshotGroup(g));
  assert.equal(restored.sourceText, '请确认两点');
  assert.equal(restored.contextText, '原话背景');
  assert.equal(restored.questions[0].answer, '任意网络');
  assert.equal(restored.questions[1].draft, '我的草稿');
  assert.equal(restored.scrollTop, 321, '滚动位置不丢');
  const failed = submitAnswer(g, 'q2', undefined, { ok: false, error: '网络失败' });
  assert.equal(failed.questions[1].state, 'failed');
  assert.equal(failed.questions[1].draft, '我的草稿', '提交失败保留草稿');
  assert.equal(failed.questions[0].state, 'answered', '已答题不回退');
  assert.equal(QUESTION_SELECT_AUTO_SUBMIT, false, '选中选项不自动发送');
  assert.equal(QUESTION_RESUBMIT_ANSWERED, false, '已答事项不重复提交');
});

// ---------------------------------------------------------------------------
// 标准 4：全局一级项目筛选，所有主要 Tab 同步；会话内上下文不被覆盖
// ---------------------------------------------------------------------------
test('SC4 全局筛选：切换一次所有 Tab 同步，会话内项目上下文保持自身值', () => {
  const options = [
    { id: '全部', label: '全部' },
    { id: 'mobile', label: '移动控制台' },
    { id: 'server', label: '控制台服务端' },
  ];
  const filter = switchProject(buildProjectFilter(options), 'mobile');
  assert.equal(filter.selectedId, 'mobile');
  assert.equal(buildFilterTabs(filter).length, PROJECT_FILTER_TABS.length);
  for (const tab of buildFilterTabs(filter)) assert.equal(tab.project, 'mobile', `${tab.id} 必须同步当前项目`);
  const tabs = applyGlobalFilter({
    overview: { items: [{ project: 'mobile' }, { project: 'server' }] },
    todos: { items: [{ project: 'mobile' }] },
  }, filter, item => item.project);
  assert.equal(tabs.overview.items.length, 1);
  assert.equal(tabs.todos.items.length, 1);
  const ctx = sessionProjectContext({ id: 's1', project: '/work/server' }, filter);
  assert.equal(ctx.project, '/work/server', '会话自身项目不被全局筛选覆盖');
  assert.equal(ctx.overridden, false);
});

// ---------------------------------------------------------------------------
// 标准 5：DAG 环形图（不用串行链条），节点契约四段完整，缺失给明确空态
// ---------------------------------------------------------------------------
test('SC5 DAG 环形图：按项目取真实 ring 投影，节点契约四段可查，缺失不编造', () => {
  const startedAt = '2026-11-19T10:00:00+08:00';
  const snapshot = {
    available: { 'dag-runs': true }, errors: {},
    dagRuns: [{
      runId: 'r1', project: '/work/mobile', planId: 'plan', status: 'running', createdAt: startedAt,
      mobileSummary: {
        runId: 'r1', project: '/work/mobile', planId: 'plan', status: 'running', createdAt: startedAt,
        ring: {
          ring: { segments: [1, 2, 3] }, waves: [{ id: 'w1' }],
          nodes: [{ id: 'n1', title: '验收节点', contract: {
            input: '前置产物', output: '验收报告', error_behavior: '明确披露', acceptance_example: '标准全满足',
          } }],
          summary: { progress: 50 },
        },
      },
    }],
  };
  const view = buildDagRingView(snapshot);
  assert.equal(view.rings.items.length, 1);
  assert.equal(view.rings.items[0].taskId, 'dag:/work/mobile:plan');
  const selected = selectRing(view, view.rings.items[0].taskId);
  assert.equal(selected.selectedId, 'dag:/work/mobile:plan');
  assert.equal(selected.selected.nodes.length, 1);
  const detail = buildNodeDetailView(selected.selected.nodes[0]);
  assert.deepEqual(detail.contract.map(row => row.key), CONTRACT_ROWS.map(row => row.key), '契约四段完整且顺序固定');
  assert.equal(detail.contract.length, 4);
  const missing = buildDagRingView({ available: { 'dag-runs': false }, errors: {}, dagRuns: [] });
  assert.equal(missing.rings.empty, true);
  assert.equal(missing.rings.reason, RING_MISSING_REASON, 'DAG 缺失明确披露，不用串行链条替代');
  const withError = buildDagRingView({ available: { 'dag-runs': false }, errors: { 'dag-runs': 'DAG 通道不可用' }, dagRuns: [] });
  assert.equal(withError.rings.reason, 'DAG 通道不可用', '有具体错误时如实展示原因');
});

// ---------------------------------------------------------------------------
// 标准 6：会话内可同时看到归档历史（只读、原记录保留、恢复注入 10 轮）
// ---------------------------------------------------------------------------
test('SC6 归档会话：只读详情、恢复走既有 continue 且保留原记录并注入 10 轮', () => {
  const transcript = {
    id: 'arch-1', project: '/work/mobile', transcriptCount: 12,
    messages: { items: [{ role: 'user', text: '原始转录' }] },
  };
  const detail = buildArchiveDetail(transcript);
  assert.equal(detail.readOnly, true);
  assert.equal(detail.restore.available, true);
  assert.equal(detail.restore.keepsOriginal, true);
  assert.equal(RESTORE_INJECTED_TURNS, 10);
  const request = buildRestoreRequest({ id: 'arch-1' });
  assert.equal(request.keepsOriginal, true);
  assert.equal(request.injectedTurns, 10);
  assert.match(request.path, /\/continue$/);
  const emptyDetail = buildArchiveDetail(null);
  assert.equal(emptyDetail.restore.available, false, '无存档不编造恢复入口');
});

// ---------------------------------------------------------------------------
// 标准 7：产物双入口，会话内打开并原样返回（草稿/滚动逐字一致），移动端只读
// ---------------------------------------------------------------------------
test('SC7 产物：会话入口带回返回态，返回原会话逐字一致，移动端只读', () => {
  const group = createQuestionGroup({
    id: 'g2', sessionId: 's1', sourceText: '上下文', questions: [{ id: 'q', kind: 'choice', prompt: '选项' }],
  });
  const returnState = snapshotGroup(group);
  const base = createArtifactBrowser({
    id: 'b1', artifacts: [{ id: 'a1', path: 'docs/readme.md', sessionId: 's1' }],
  });
  const entered = openFromSession(base, { sessionId: 's1', returnState });
  assert.equal(entered.entry, 'session');
  assert.deepEqual(entered.returnState, returnState);
  let browser = selectArtifact(entered, 'a1');
  assert.equal(browser.opened, true, '从会话内直接打开产物');
  browser = setReaderScrollTop(browser, 240);
  assert.equal(createArtifactBrowser({ artifacts: [{ id: 'x', path: 'p.md' }] }).artifacts[0].readOnly, true);
  assert.equal(ARTIFACT_MOBILE_READ_ONLY, true);
  assert.ok(ARTIFACT_ENTRY_POINTS.includes('global') && ARTIFACT_ENTRY_POINTS.includes('session'));
  const back = backFromArtifacts(browser);
  assert.equal(back.state.opened, false);
  assert.equal(back.return.entry, 'session');
  assert.deepEqual(back.return.restore, returnState, '返回会话后草稿/滚动/进度逐字一致');
  const restored = restoreBrowser(snapshotBrowser(browser));
  assert.equal(restored.readerScrollTop, 240, '旋转/折叠后阅读位置保留');
  assert.equal(backFromArtifacts(openFromSession(base, { sessionId: 's1' })).return, null, '全局入口没有会话可返回');
});

// ---------------------------------------------------------------------------
// 标准 8：系统字体放大到 160% 无溢出；触控热区 44–48 dp；选项状态齐全
// ---------------------------------------------------------------------------
test('SC8 字体与触控：160% 放大换行增高纵向滚动，无横向溢出/截断/遮挡', () => {
  assert.deepEqual([...FONT_SCALE_STEPS], [100, 130, 160]);
  assert.equal(FONT_SCALE_MAX, 160);
  assert.equal(normalizeFontScale(160), 160);
  assert.equal(normalizeFontScale('bad'), 100, '非法输入回退默认档');
  assert.equal(scaledFontDp(160), 25.6, '原生字体度量（16dp × 160%）');
  const layout = layoutForFontScale(160, { contentWidth: 2000, viewportWidth: 360, lineBreak: true });
  assert.equal(layout.wrap, true);
  assert.equal(layout.growContainer, true);
  assert.equal(layout.verticalScroll, true);
  assert.equal(layout.horizontalScroll, false);
  assert.equal(layout.truncated, false);
  assert.equal(layout.occluded, false);
  assert.equal(layout.horizontalOverflow, false, '放大后即便内容宽也不横向溢出');
  assert.equal(layout.nativeFontMetrics, true);
  assert.equal(layout.webZoom, false, '不以网页缩放代替原生字号');
  const small = touchTarget(22);
  assert.equal(small.hitDp, TOUCH_TARGET_MIN_DP);
  assert.equal(small.meetsMin, true);
  assert.equal(small.withinMax, true);
  assert.equal(touchTarget(100).hitDp, TOUCH_TARGET_MAX_DP, '超大视觉尺寸收敛到上限');
  assert.equal(reduceOptionState('disabled', 'press'), 'disabled', '禁用态吸收按压');
  assert.equal(reduceOptionState('idle', 'press'), 'pressed');
  assert.equal(reduceOptionState('pressed', 'select'), 'selected');
  assert.equal(isInteractive('disabled'), false);
});

// ---------------------------------------------------------------------------
// 标准 9 + 10：设备授权网页后台独占；多设备同步；解除立即生效且不影响其他设备
// ---------------------------------------------------------------------------
test('SC9/SC10 设备授权与多设备同步：绑定/查看/解除全链路，解除立即对其他设备无影响', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-final-acceptance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createDeviceStore({
    file: path.join(root, 'device-auth.json'), now: () => new Date(AT), random: seqRandom(),
  });
  const qrA = store.createBinding();
  const qrB = store.createBinding();
  const a = store.bindDevice({ token: qrA.token, name: '设备A', platform: 'Android' });
  const b = store.bindDevice({ token: qrB.token, name: '设备B', platform: 'iOS' });
  assert.equal(store.listDevices().length, 2, '多设备同时绑定');

  const submitted = store.submitDecision(a.deviceToken, { cardId: 'c1', decision: 'approve' });
  assert.equal(submitted.revision, 1);
  assert.equal(store.getSyncState(b.deviceToken).decisions['c1'].value, 'approve', '任意一台提交后其他设备同步');

  const revoked = store.revokeDevice(a.device.id, { type: 'admin' });
  assert.equal(revoked.status, 'revoked');
  assert.throws(() => store.submitDecision(a.deviceToken, { cardId: 'c2', decision: 'note' }), error => error instanceof DeviceAuthError && error.code === 'FORBIDDEN', '被解除设备立即不能提交');
  assert.throws(() => store.getSyncState(a.deviceToken), error => error instanceof DeviceAuthError && error.code === 'FORBIDDEN', '被解除设备立即不能读取');
  const after = store.getSyncState(b.deviceToken);
  assert.equal(after.revision, 1, '解除 A 不改变共享状态');
  assert.equal(store.submitDecision(b.deviceToken, { cardId: 'c2', decision: 'note' }).revision, 2, 'B 仍可继续提交');
  const audit = store.listAudit();
  assert.ok(audit.some(item => item.action === 'sync.submit'));
  const dump = JSON.stringify(audit) + JSON.stringify(after);
  assert.ok(!dump.includes(a.deviceToken) && !dump.includes(b.deviceToken), '审计与状态不含设备令牌');
});

test('SC10 同步状态机：reconcile 永不回退，远端可疑字段不透明透传', () => {
  const base = applySubmission(createSyncState(), { cardId: 'c1', decision: 'approve', deviceId: 'dev_A' }, AT);
  const ahead = applySubmission(base, { cardId: 'c2', decision: 'note', deviceId: 'dev_B' }, AT);
  assert.equal(reconcile(base, ahead).revision, 2, '采纳更新远端');
  assert.equal(reconcile(ahead, base).revision, 2, '远端更旧时保留本地最新一致状态');
  const tainted = { revision: 5, decisions: { x: { value: 'approve', byDevice: 'dev_A', at: AT, token: 'LEAK' } } };
  assert.ok(!JSON.stringify(reconcile(base, tainted)).includes('LEAK'), '可疑字段不去敏不采纳');
});

// ---------------------------------------------------------------------------
// 标准 11/12：语音状态机与角标口径（Spec §12 补充项）
// ---------------------------------------------------------------------------
test('补充项 语音输入：无权限/无网络回退键盘，停顿不发送', () => {
  assert.equal(VOICE_SEND_ON_PAUSE, false);
  assert.ok(VOICE_STATES.includes('idle') && VOICE_STATES.includes('listening'));
  assert.ok(isKeyboardFallbackState('failed') && isKeyboardFallbackState('no-permission') && isKeyboardFallbackState('offline'));
  const input = createVoiceInput({ id: 'v1', draft: '已有草稿' });
  assert.equal(startVoice(input, { permission: 'denied' }).state, 'no-permission');
  assert.equal(startVoice(input, { online: false }).state, 'offline');
  assert.equal(startVoice(input).state, 'listening');
  assert.equal(input.sent, 0, '本节点不提供发送动作');
  assert.equal(startVoice(input, { permission: 'denied' }).draft, '已有草稿', '失败保留草稿');
});

// ---------------------------------------------------------------------------
// 节点契约 error_behavior：未覆盖项明确披露 + 不自动触发部署/生产变更
// ---------------------------------------------------------------------------
test('未覆盖项明确披露：APK 安装启动与真机 smoke 需单独授权，不计入自动通过', () => {
  assert.ok(REQUIRES_OWNER_AUTHORIZATION.length >= 4);
  for (const entry of REQUIRES_OWNER_AUTHORIZATION) {
    assert.ok(entry.item && entry.reason, '每条披露必须含事项与原因');
    assert.equal(entry.authorizedInCi, false, 'CI/PR 不得自动执行真机/打包类验收');
  }
  const config = JSON.parse(readFileSync(path.join(ROOT, 'mobile', 'app', 'capacitor.config.json'), 'utf8'));
  assert.equal(config.autoloop.harmonyOsNext, false, '首版不做 HarmonyOS NEXT 原生包');
  assert.ok(config.autoloop.android.minSdkVersion <= 23, '声明兼容旧版鸿蒙的 minSdk');
  assert.equal(config.server.androidScheme, 'https');
});

test('APK 打包门禁：未获单独授权时拒绝执行且退出码非 0，不自动触发打包/部署', () => {
  const script = path.join(ROOT, 'mobile', 'app', 'build-apk.mjs');
  const source = readFileSync(script, 'utf8');
  assert.match(source, /AUTOLOOP_APK_BUILD_AUTHORIZED\s*===\s*'1'/, '打包必须由显式授权开关控制');
  const env = { ...process.env };
  delete env.AUTOLOOP_APK_BUILD_AUTHORIZED;
  const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 2, '未授权时以非零码退出');
  assert.match(result.stderr, /未获单独授权/, '给出可读阻塞原因');
});
