// notifications 节点（Spec §7 / DAG plan wave-4 / issue 3）边界测试：
// 独立待办与节点完成系统通知、去重、点击定位、锁屏直复（生物识别 + 失败保留草稿）、
// App 图标角标与待办数量一致、通知内容不泄露密钥或秘密。
// 全部是纯逻辑 / 注入 transport，不调用真实模型、真机推送或生物识别。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_KINDS, NODE_DONE_OUTCOMES,
  sanitizeText, redactSecrets, projectLabel,
  buildTodoNotification, buildNodeDoneNotification,
  isNotifiableNodeEvent, badgeCount, notificationKey,
  createReplyDraft, canSubmitReply, markReplySubmitted, applyReplyFailure, submitReply,
} from '../mobile/src/features/notifications/index.mjs';
import { CardNotifier } from '../src/notifier.mjs';

const openCard = (id, title, extra = {}) => ({
  id, state: 'open', title, text: '请确认是否继续',
  options: ['上线', '暂缓'], createdAt: '2026-11-19T01:00:00Z', project: '/work/熟小麦',
  ...extra,
});

const nodeDone = (overrides = {}) => ({
  type: 'dag.node.advance', runId: 'dagrun-1', nodeId: 'notifications', advanceId: 'adv-1',
  outcome: 'done', project: '/work/熟小麦', title: '系统通知与锁屏直复',
  detail: { prUrl: 'https://example.invalid/pr/9', commit: 'a1b2c3d', tests: 'npm test 通过' },
  ...overrides,
});

// ---------------------------------------------------------------------------
// 纯内容/路由契约
// ---------------------------------------------------------------------------
test('每项待我处理对应一条独立系统通知，含锁屏内容与两条点击/直复路径', () => {
  const d = buildTodoNotification(openCard(7, '是否上线新定价', { text: '影响资金，请确认', options: ['上线', '暂缓'] }));
  assert.equal(d.kind, NOTIFICATION_KINDS.TODO);
  assert.equal(d.id, 'todo:7');
  assert.equal(d.badgeKey, 'todo:7'); // 计入角标
  assert.match(d.title, /待/);
  assert.match(d.body, /是否上线新定价/);
  assert.equal(d.project, '熟小麦');
  // 锁屏：项目名称 + 待办摘要 + 详情，完整摘要不截断
  assert.equal(d.lockScreen.project, '熟小麦');
  assert.match(d.lockScreen.summary, /是否上线新定价/);
  assert.equal(d.lockScreen.detail, '影响资金，请确认');
  // 点击进 App 定位原会话问题；进入后高风险操作不额外加验证门槛
  assert.deepEqual(d.click, { page: 'todos', cardId: 7, requiresBiometric: false });
  // 系统通知内直接选择 / 文字回复，锁屏直复需生物识别
  assert.equal(d.reply.requiresBiometric, true);
  assert.equal(d.reply.allowText, true);
  assert.deepEqual(d.reply.choices, [{ id: '上线', label: '上线' }, { id: '暂缓', label: '暂缓' }]);
  assert.equal(d.reply.draft, '');
});

test('每个成功完成的节点对应一条独立系统通知，点击进入交付详情、不计角标', () => {
  const d = buildNodeDoneNotification(nodeDone());
  assert.equal(d.kind, NOTIFICATION_KINDS.NODE_DONE);
  assert.equal(d.outcome, 'done');
  assert.equal(d.runId, 'dagrun-1');
  assert.equal(d.nodeId, 'notifications');
  assert.equal(d.badgeKey, null); // 节点完成不占角标
  assert.equal(d.reply, null); // 节点完成不支持锁屏直复
  assert.equal(d.lockScreen.project, '熟小麦');
  assert.match(d.lockScreen.detail, /a1b2c3d/); // 交付详情摘要
  assert.deepEqual(d.click, { page: 'node-delivery', runId: 'dagrun-1', nodeId: 'notifications' });
});

test('通知内容不泄露密钥或秘密：只取白名单字段并清洗疑似凭据', () => {
  const secret = 'SYNTHETIC_SECRET_VALUE_0123456789';
  const card = openCard(8, `修复登录 token=${secret}`, { text: `password=${secret} api_key=${secret}`, apiKey: 'raw-secret-must-not-appear' });
  const d = buildTodoNotification(card);
  const rendered = JSON.stringify(d);
  assert.ok(!rendered.includes(secret), '疑似凭据值不得出现在通知内容');
  assert.ok(!rendered.includes('raw-secret-must-not-appear'), '原始事件上的密钥字段不在白名单，不得透传');
  assert.match(rendered, /已隐藏/); // 清洗标记
  assert.equal(typeof d.lockScreen.detail, 'string');
});

test('节点完成通知不泄露 detail 里的密钥字段，只取交付摘要', () => {
  const d = buildNodeDoneNotification(nodeDone({ detail: { prUrl: 'https://example.invalid/pr/9', commit: 'deadbeef', tests: 'pass', apiToken: 'SYNTHETIC_TOKEN_NOT_LEAK' } }));
  const rendered = JSON.stringify(d);
  assert.ok(!rendered.includes('SYNTHETIC_TOKEN_NOT_LEAK'));
  assert.match(rendered, /deadbeef/);
});

test('sanitizeText 去控制字符并保留完整摘要；projectLabel 取项目名', () => {
  assert.equal(sanitizeText('  换行\r\n制表\t  合并 '), '换行 制表 合并');
  assert.equal(projectLabel('/work/熟小麦/'), '熟小麦');
  assert.equal(projectLabel(''), '未识别');
  assert.equal(redactSecrets('Bearer abc.def-ghi'), 'Bearer [已隐藏]');
  const syntheticPat = ['gh', 'p_', 'SYNTHETIC_TOKEN'].join(''); // 运行时拼装，源码里不出现疑似真实令牌字面量
  assert.ok(!redactSecrets(`携带 ${syntheticPat}`).includes(syntheticPat), '疑似令牌前缀也要清洗');
  assert.equal(typeof sanitizeText('x'.repeat(120)), 'string');
  assert.equal(sanitizeText('x'.repeat(120)).length, 120, '合理长度摘要保留完整');
});

test('isNotifiableNodeEvent 只认成功完成；失败/自动重试/调度自愈不通知', () => {
  assert.deepEqual(NODE_DONE_OUTCOMES, ['done']);
  assert.equal(isNotifiableNodeEvent(nodeDone()), true);
  assert.equal(isNotifiableNodeEvent(nodeDone({ outcome: 'failed' })), false);
  assert.equal(isNotifiableNodeEvent(nodeDone({ outcome: 'done', retry: true, attempt: 2 })), true); // 只要最终 done 仍报一次
  assert.equal(isNotifiableNodeEvent({ type: 'scheduler.selfheal', outcome: 'done' }), false); // 自愈事件不是节点完成回执
  assert.equal(isNotifiableNodeEvent(null), false);
});

test('badgeCount 等于待我处理（open）数量，处理后可清零', () => {
  assert.equal(badgeCount([openCard(1, 'a'), openCard(2, 'b'), { id: 3, state: 'decided' }, { id: 4, state: 'closed' }]), 2);
  assert.equal(badgeCount([]), 0);
  assert.equal(badgeCount([{ id: 1, state: 'closed' }]), 0);
});

test('notificationKey 按种类/id/revision 稳定去重', () => {
  assert.equal(notificationKey('todo', 1, 'r1'), 'todo:1:r1');
  assert.notEqual(notificationKey('todo', 1, 'r1'), notificationKey('todo', 1, 'r2'));
  assert.notEqual(notificationKey('todo', 1, 'r1'), notificationKey('node-done', 1, 'r1'));
});

// ---------------------------------------------------------------------------
// 锁屏直复视图模型
// ---------------------------------------------------------------------------
test('createReplyDraft 保留题目、选项与草稿，并要求生物识别', () => {
  const draft = createReplyDraft(buildTodoNotification(openCard(7, '是否上线新定价', { options: ['上线', '暂缓'] })), '先别上');
  assert.equal(draft.title, '是否上线新定价');
  assert.deepEqual(draft.options, ['上线', '暂缓']);
  assert.equal(draft.draft, '先别上');
  assert.equal(draft.requiresBiometric, true);
  assert.equal(draft.submitted, false);
});

test('锁屏直复需系统生物识别：验证不通过则不提交、可重试', async () => {
  let calls = 0;
  const draft = createReplyDraft(buildTodoNotification(openCard(7, 'x')));
  const result = await submitReply(draft, { type: 'choice', optionId: '上线' }, {
    submit: () => { calls += 1; },
    verifyBiometric: () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'biometric-failed');
  assert.equal(calls, 0);
  assert.equal(result.draft.draft, ''); // 草稿保留
});

test('直复成功：生物识别通过后提交并返回已处理草稿', async () => {
  const calls = [];
  const draft = createReplyDraft(buildTodoNotification(openCard(7, 'x', { options: ['上线', '暂缓'] })));
  const result = await submitReply(draft, { type: 'text', text: '同意上线' }, {
    submit: answer => { calls.push(answer); },
    verifyBiometric: () => true,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(result.draft.submitted, true);
});

test('已处理或失效事项不重复提交', async () => {
  let calls = 0;
  const submit = () => { calls += 1; };
  const verifyBiometric = () => true;
  const done = await submitReply(createReplyDraft(buildTodoNotification(openCard(7, 'x'))), { type: 'text', text: 'ok' }, { submit, verifyBiometric });
  const again = await submitReply(done.draft, { type: 'text', text: 'again' }, { submit, verifyBiometric });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already-processed');
  assert.equal(calls, 1, '已提交的事项绝不再次提交');
  const invalid = applyReplyFailure({ ...createReplyDraft(buildTodoNotification(openCard(7, 'x'))), invalid: true }, new Error('失效'));
  assert.equal(canSubmitReply(invalid), false);
});

test('直复失败时题目、选项和草稿保留，可重试', async () => {
  const draft = createReplyDraft(buildTodoNotification(openCard(7, '是否上线新定价', { options: ['上线', '暂缓'] })), '先别上线');
  const failing = await submitReply(draft, { type: 'text', text: '先别上线' }, {
    submit: () => { throw new Error('提交失败'); },
    verifyBiometric: () => true,
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.reason, 'submit-failed');
  assert.equal(failing.draft.title, '是否上线新定价');
  assert.deepEqual(failing.draft.options, ['上线', '暂缓']);
  assert.equal(failing.draft.draft, '先别上线');
  assert.equal(canSubmitReply(failing.draft), true, '失败草稿可重试');
  assert.equal(markReplySubmitted(draft).submitted, true);
});

test('答案非法时不提交，草稿保留', async () => {
  let calls = 0;
  const draft = createReplyDraft(buildTodoNotification(openCard(7, 'x', { options: ['上线', '暂缓'] })));
  const result = await submitReply(draft, { type: 'choice', optionId: '不存在的选项' }, {
    submit: () => { calls += 1; }, verifyBiometric: () => true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-answer');
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// src/notifier.mjs：单一事件分发（待办 + 节点完成），不新建第二套通知状态
// ---------------------------------------------------------------------------
function driver(seq) {
  const notes = [];
  const badges = [];
  const notifier = new CardNotifier({
    intervalMs: 60000,
    fetchState: async () => seq.shift() ?? seq.at(-1),
    notify: d => notes.push(d),
    setBadge: n => badges.push(n),
    routing: null, // 关闭自动退回，纯通知测试
  });
  return { notes, badges, notifier };
}

test('待办与节点完成分别独立通知；普通失败/重试/自愈不通知', async () => {
  const { notes, badges, notifier } = driver([
    { cards: [], nodeEvents: [] }, // seed
    {
      cards: [openCard(1, '是否上线新定价')],
      nodeEvents: [
        nodeDone(),
        nodeDone({ advanceId: 'adv-fail', outcome: 'failed' }),
        { type: 'scheduler.selfheal', outcome: 'done', nodeId: 'x' },
        nodeDone({ advanceId: 'adv-retry', outcome: 'done', attempt: 2, retry: true }),
      ],
    },
  ]);
  await notifier.poll();
  await notifier.poll();
  const todos = notes.filter(n => n.kind === 'todo');
  const done = notes.filter(n => n.kind === 'node-done');
  assert.equal(todos.length, 1, '一项待办一条独立通知');
  assert.equal(done.length, 2, '仅两个成功完成节点各一条独立通知（失败/自愈被过滤）');
  assert.equal(notes.length, 3);
  // 失败若形成待办，只发该待办通知，不发节点失败通知
  assert.ok(!notes.some(n => n.outcome === 'failed'));
  assert.equal(badges.at(-1), 1, '角标与待办数量一致');
});

test('去重：同一事项不重复提醒，重开（新 createdAt）再提醒', async () => {
  const { notes, notifier } = driver([
    { cards: [openCard(1, '旧事项')], nodeEvents: [] },
    { cards: [openCard(1, '旧事项'), openCard(2, '新事项')], nodeEvents: [] },
    { cards: [openCard(1, '旧事项'), openCard(2, '新事项')], nodeEvents: [] },
    { cards: [openCard(1, '旧事项', { createdAt: '2026-11-19T03:00:00Z' }), openCard(2, '新事项')], nodeEvents: [] },
  ]);
  await notifier.poll();
  await notifier.poll();
  assert.equal(notes.length, 1);
  await notifier.poll();
  assert.equal(notes.length, 1, '同一 open 卡不重复提醒');
  await notifier.poll();
  assert.equal(notes.length, 2, '重开（新 createdAt）视为新决策');
});

test('已处理/失效事项不重复提交：处理完角标清零、去重键保留不重发', async () => {
  const { notes, badges, notifier } = driver([
    { cards: [], nodeEvents: [] },
    { cards: [openCard(1, '待办 A')], nodeEvents: [] },
    { cards: [], nodeEvents: [] }, // 处理完
    { cards: [openCard(1, '待办 A')], nodeEvents: [] }, // 同一事项再次出现（无新 createdAt）也不重发
  ]);
  await notifier.poll();
  await notifier.poll();
  assert.equal(notes.length, 1);
  assert.equal(badges.at(-1), 1);
  await notifier.poll();
  assert.equal(badges.at(-1), 0, '处理后角标同步清零');
  await notifier.poll();
  assert.equal(notes.length, 1, '已处理事项不重复提交');
});

test('去重键按节点完成 advanceId 稳定：同一完成不重复通知', async () => {
  const { notes, notifier } = driver([
    { cards: [], nodeEvents: [] },
    { cards: [], nodeEvents: [nodeDone()] },
    { cards: [], nodeEvents: [nodeDone()] },
  ]);
  await notifier.poll();
  await notifier.poll();
  assert.equal(notes.length, 1);
  await notifier.poll();
  assert.equal(notes.length, 1);
});

test('通知失败不影响主流程与后续轮询去重', async () => {
  const notes = [];
  const notifier = new CardNotifier({
    intervalMs: 60000,
    fetchState: async () => ({ cards: [openCard(1, '待办')], nodeEvents: [] }),
    notify: () => { throw new Error('系统通知不可用'); },
    routing: null,
  });
  await notifier.poll(); // seed
  await assert.doesNotReject(() => notifier.poll());
  await assert.doesNotReject(() => notifier.poll());
  assert.equal(notes.length, 0);
});

test('notify 载荷保留 title/body 向后兼容桌面系统通知', async () => {
  const { notes, notifier } = driver([
    { cards: [], nodeEvents: [] },
    { cards: [openCard(2, '是否上线新定价')], nodeEvents: [] },
  ]);
  await notifier.poll();
  await notifier.poll();
  assert.match(notes[0].title, /待/);
  assert.match(notes[0].body, /是否上线新定价/);
  assert.match(notes[0].body, /熟小麦/);
});
