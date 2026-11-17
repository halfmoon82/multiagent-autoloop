import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardFilterStore, CardFilterError } from '../src/card-filter-store.mjs';

const passing = { total: 10, humanGateFalseAuto: 0, passed: true };

test('样本只存脱敏特征，拒绝原文与秘密字段', () => {
  const s = createCardFilterStore();
  const ex = s.addExample({ project: '/p', features: { tags: ['eng:test'], text: '原文', secret: 'sk-xxx' }, label: 'scheduler', source: 'manual-return' });
  assert.deepEqual(ex.features, { tags: ['eng:test'] });
  assert.ok(ex.sampleId && ex.createdAt);
  assert.throws(() => s.addExample({ features: { tags: [] }, label: 'bogus', source: 'x' }), CardFilterError);
});

test('版本生命周期：新版本默认 shadow，激活需验证通过且人工门禁误路由为 0', () => {
  const s = createCardFilterStore();
  const v1 = s.createVersion({ rules: [], summary: '初版' });
  assert.equal(v1.status, 'shadow');
  assert.throws(() => s.activate(v1.version), /验证/);
  s.recordValidation(v1.version, { total: 10, humanGateFalseAuto: 1, passed: false });
  assert.throws(() => s.activate(v1.version), /验证/);
  s.recordValidation(v1.version, passing);
  assert.equal(s.activate(v1.version).status, 'active');
  assert.equal(s.current().mode, 'active');
});

test('回滚到上一版本或全 shadow，不动决策记录', () => {
  const s = createCardFilterStore();
  const v1 = s.createVersion({ rules: [] }); s.recordValidation(v1.version, passing); s.activate(v1.version);
  const v2 = s.createVersion({ rules: [], parentVersion: v1.version }); s.recordValidation(v2.version, passing); s.activate(v2.version);
  s.recordDecision({ cardId: 5, route: 'scheduler', hardGateHits: [], ruleVersion: v2.version, mode: 'active' });
  const before = s.decisions().length;
  assert.equal(s.rollback().version, v1.version);
  assert.equal(s.current().version, v1.version);
  assert.equal(s.getVersion(v2.version).status, 'rolled_back');
  s.rollback();
  assert.equal(s.current().mode, 'shadow');
  assert.equal(s.decisions().length, before);
});

test('反馈信号：退回=强 scheduler，重新升级=强 human 纠偏，直接回答=弱 human，冲突仅待评估', () => {
  const s = createCardFilterStore();
  const d = s.recordDecision({ cardId: 9, route: 'scheduler', hardGateHits: [], ruleVersion: 'v1', mode: 'active', features: { tags: ['eng:test'] } });
  const ret = s.recordFeedback(d.decisionId, 'manual-return');
  assert.deepEqual([ret.label, ret.strength], ['scheduler', 'strong']);
  const re = s.recordFeedback(d.decisionId, 'reescalated');
  assert.deepEqual([re.label, re.strength, re.source], ['human', 'strong', 'reescalated']);
  const ans = s.recordFeedback(d.decisionId, 'direct-answer');
  assert.deepEqual([ans.label, ans.strength], ['human', 'weak']);
  const none = s.recordFeedback(d.decisionId, 'no-correction');
  assert.deepEqual([none.label, none.strength], ['scheduler', 'weak']);
  const conflict = s.recordFeedback(d.decisionId, 'conflict');
  assert.equal(conflict.status, 'pending');
  assert.equal(s.trainable().length, 4, '待评估样本不进入可训练集');
  assert.equal(s.trainable().some(e => e.status === 'pending'), false);
});

test('快照往返保持数据', () => {
  const s = createCardFilterStore();
  s.createVersion({ rules: [] });
  const copy = createCardFilterStore(s.snapshot());
  assert.equal(copy.versions().length, 1);
});
