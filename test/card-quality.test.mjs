import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCardQuality, assertCardQuality, CardQualityError } from '../src/card-quality.mjs';

const goodCard = () => ({
  title: '责任闭环是继续补齐剩余四项，还是拆到后续节点？',
  background: '项目已完成主要开发，剩下四项收尾工作由谁承担会影响本周能否对外发布。',
  reason: '如果不决定，审阅无人接手，发布要延期一周。',
  options: [
    { label: '继续补齐', benefit: '本周可以发布', cost: '今晚需要加班' },
    { label: '拆到后续', benefit: '今晚可以休息', cost: '发布延期一周，客户要等' },
  ],
  recommendation: { label: '继续补齐', reason: '客户已在等这一版，延期会损害信任。' },
});

test('合格卡片通过质量门，路由到人工门禁', () => {
  const result = validateCardQuality(goodCard());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.route, 'human');
});

test('缺背景、缺收益、缺代价的退化卡被拦截（契约验收样例）', () => {
  const card = { title: '是否继续？', options: ['继续', '暂停'] };
  const result = validateCardQuality(card);
  assert.equal(result.ok, false);
  const codes = result.errors.map(error => error.code);
  assert.ok(codes.includes('BACKGROUND_MISSING'), codes.join(','));
  assert.ok(codes.includes('OPTION_BENEFIT_MISSING'), codes.join(','));
  assert.ok(codes.includes('OPTION_COST_MISSING'), codes.join(','));
});

test('产品语言写法的收益与代价标记可以通过校验', () => {
  const card = {
    ...goodCard(),
    options: ['继续补齐（收益：本周发布；代价：今晚加班）', '拆到后续（收益：今晚休息；代价：发布延期一周）'],
  };
  assert.equal(validateCardQuality(card).ok, true);
});

test('技术黑话和内部路径被识别为不合格卡，纯工程卡路由调度', () => {
  const card = {
    title: '是否重跑流水线',
    background: 'state.nodes 写失败，rules.json 需要 commit 并 push 到 worktree，堆栈报 TypeError。',
    reason: '不决定就没法 merge。',
    options: [
      { label: '改脚本', benefit: '可继续', cost: '要改代码' },
      { label: '换分支', benefit: '可继续', cost: '要重建环境' },
    ],
  };
  const result = validateCardQuality(card);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'TECH_JARGON'), JSON.stringify(result.errors));
  assert.equal(result.route, 'scheduler');
});

test('标题不是决策问题时被拦截', () => {
  const card = { ...goodCard(), title: '修复登录 bug' };
  const result = validateCardQuality(card);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'TITLE_NOT_QUESTION'));
});

test('缺待决原因和不决定后果被拦截', () => {
  const card = { ...goodCard(), reason: '', background: '最近收到一些反馈。' };
  const result = validateCardQuality(card);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'REASON_MISSING'));
});

test('裸选项、空选项与推荐项缺理由分别产生可测试错误', () => {
  const bare = validateCardQuality({ ...goodCard(), options: ['继续', '暂停'], recommendation: undefined });
  assert.ok(bare.errors.some(error => error.code === 'OPTION_BENEFIT_MISSING'));
  assert.ok(bare.errors.some(error => error.code === 'OPTION_COST_MISSING'));
  const empty = validateCardQuality({ ...goodCard(), options: [] });
  assert.ok(empty.errors.some(error => error.code === 'OPTIONS_EMPTY'));
  const noReason = validateCardQuality({ ...goodCard(), recommendation: { label: '继续补齐' } });
  assert.ok(noReason.errors.some(error => error.code === 'RECOMMENDATION_REASON_MISSING'));
});

test('质量门只读不改写卡片，也不自动作答', () => {
  const card = goodCard();
  const snapshot = JSON.parse(JSON.stringify(card));
  const result = validateCardQuality(card);
  assert.equal(result.ok, true);
  assert.deepEqual(card, snapshot);
  assert.equal(card.choice, undefined);
  assert.equal(card.answer, undefined);
});

import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('初始化模板独立携带四项发卡纪律，规则示例不用「同上」省略', () => {
  const docs = [
    read('../docs/scheduling-contract.md'),
    read('../docs/2026-11-13-project-initialization-design.md'),
  ];
  const rules = JSON.parse(read('../examples/rules.example.json'));
  const prompts = rules.rules.map(rule => rule.prompt).filter(prompt => prompt.includes('【发卡纪律'));
  assert.ok(prompts.length >= 2, '规则模板必须至少两处独立携带发卡纪律');
  for (const text of [...docs, ...prompts]) {
    const normalized = text.replace(/\s+/g, '');
    for (const piece of ['产品功能', '个人隐私', '财务', '对外影响', '凭据', '换打法', '工程问题', 'open卡', '重发', '契约错配', '改派']) {
      assert.ok(normalized.includes(piece), `初始化模板缺少发卡纪律要点：${piece}`);
    }
  }
  for (const prompt of prompts) assert.ok(!prompt.includes('同上'), '规则模板不得用「同上」省略发卡纪律');
});

test('初始化模板独立携带审阅分级口径（三条件拦截、四类例外、P3 不拦）', () => {
  for (const rel of ['../docs/scheduling-contract.md', '../docs/2026-11-13-project-initialization-design.md']) {
    const normalized = read(rel).replace(/\s+/g, '');
    assert.ok(!normalized.includes('按P0–P3审阅'), `${rel} 仍是旧口径「按 P0–P3 审阅」`);
    for (const piece of ['会真实发生', '本PR', '后果够级', '合作方', '外部不可信输入', '多租户', '真实资金', '个人隐私', '外部一方', 'P3不拦合并', '已知后续']) {
      assert.ok(normalized.includes(piece), `${rel} 缺少审阅分级要点：${piece}`);
    }
  }
});

test('assertCardQuality 对不合格卡抛出带错误清单的异常', () => {
  assert.doesNotThrow(() => assertCardQuality(goodCard()));
  assert.throws(() => assertCardQuality({ title: '是否继续？' }), error => {
    assert.ok(error instanceof CardQualityError);
    assert.ok(error.errors.length > 0);
    return true;
  });
});
