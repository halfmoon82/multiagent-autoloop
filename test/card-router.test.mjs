import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUMAN_GATES, DEFAULT_RULES, extractFeatures, routeCard, routeCardAsync, applyRoute,
} from '../src/card-router.mjs';

const card = (title, text = '', extra = {}) => ({ id: 1, state: 'open', title, text, options: ['是', '否'], project: '/demo', ...extra });
const ctx = (extra = {}) => ({ rules: DEFAULT_RULES, ruleVersion: 'v1', mode: 'active', ...extra });

test('六类人工门禁各自命中即 human，且永不自动路由', () => {
  const samples = {
    product: card('是否调整产品功能取舍', '要不要砍掉导出功能'),
    privacy: card('是否读取个人隐私数据', '需要用户手机号'),
    finance: card('是否购买付费套餐', '预算超出'),
    external: card('是否对外发布公告', '发邮件给客户'),
    credential: card('请提供登录密码', '需要验证码'),
    exhausted: card('所有方案均失败', '已尝试全部穷举'),
  };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(HUMAN_GATES).sort());
  for (const [gate, c] of Object.entries(samples)) {
    const d = routeCard(c, ctx());
    assert.equal(d.route, 'human', gate);
    assert.ok(d.hardGateHits.includes(gate), gate);
    assert.equal(d.autoRoute, false);
  }
});

test('门禁优先于工程关键词与模型建议', async () => {
  const c = card('修复测试并发布公告给客户', '重构代码，同时对外发邮件');
  const d = await routeCardAsync(c, ctx({ model: async () => ({ route: 'scheduler', confidence: 1 }) }));
  assert.equal(d.route, 'human');
  assert.equal(d.autoRoute, false);
});

test('明确工程事项为 scheduler 候选；active 才自动路由，shadow 不', () => {
  const c = card('是否先修复失败的单元测试', '测试因为重构而失败');
  const active = routeCard(c, ctx());
  assert.equal(active.route, 'scheduler');
  assert.equal(active.autoRoute, true);
  assert.equal(active.ruleVersion, 'v1');
  const shadow = routeCard(c, ctx({ mode: 'shadow' }));
  assert.equal(shadow.route, 'scheduler');
  assert.equal(shadow.autoRoute, false);
  assert.equal(shadow.mode, 'shadow');
});

test('无依据、低置信、规则冲突一律 unknown', () => {
  assert.equal(routeCard(card('今天天气如何'), ctx()).route, 'unknown');
  const low = routeCard(card('修复测试'), ctx({ rules: [{ id: 'low', route: 'scheduler', tags: ['eng:test'], confidence: 0.4 }] }));
  assert.equal(low.route, 'unknown');
  assert.equal(low.autoRoute, false);
  const conflict = routeCard(card('修复测试'), ctx({ rules: [
    { id: 'a', route: 'scheduler', tags: ['eng:test'], confidence: 0.95 },
    { id: 'b', route: 'human', tags: ['eng:test'], confidence: 0.95 },
  ] }));
  assert.equal(conflict.route, 'unknown');
  assert.equal(conflict.autoRoute, false);
});

test('模型故障或与规则冲突进入 unknown，不改卡', async () => {
  const c = card('修复失败的测试');
  const original = JSON.stringify(c);
  const failed = await routeCardAsync(c, ctx({ model: async () => { throw new Error('ollama down'); } }));
  assert.equal(failed.route, 'unknown');
  assert.equal(failed.autoRoute, false);
  assert.match(failed.reasons.join(' '), /模型/);
  const conflict = await routeCardAsync(c, ctx({ model: async () => ({ route: 'human', confidence: 0.99 }) }));
  assert.equal(conflict.route, 'unknown');
  assert.equal(JSON.stringify(c), original);
});

test('特征脱敏：不含原文与秘密', () => {
  const f = extractFeatures(card('修复测试', '密钥 sk-ABCDEFGHIJKLMNOP12345 与手机号 13800138000'));
  const dump = JSON.stringify(f);
  assert.ok(!dump.includes('sk-ABCDEF'));
  assert.ok(!dump.includes('13800138000'));
  assert.ok(Array.isArray(f.tags));
});

test('applyRoute：shadow 与非 scheduler 零副作用，active scheduler 才调用退回', async () => {
  const calls = [];
  const delegate = async c => { calls.push(c.id); return { ok: true }; };
  const c = card('修复失败的测试');
  assert.deepEqual(await applyRoute(routeCard(c, ctx({ mode: 'shadow' })), c, { delegate }), { applied: false });
  assert.deepEqual(await applyRoute(routeCard(card('是否购买套餐'), ctx()), card('是否购买套餐'), { delegate }), { applied: false });
  assert.equal(calls.length, 0);
  const r = await applyRoute(routeCard(c, ctx()), c, { delegate });
  assert.equal(r.applied, true);
  assert.deepEqual(calls, [1]);
});
