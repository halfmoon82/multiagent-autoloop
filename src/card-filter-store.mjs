// 路由过滤器的版本与审计记录：CardRoutingExample / CardRouteDecision / CardFilterVersion。
// 只存脱敏特征（标签）与路由元数据；不存卡片原文、秘密，不复制 Hub run 状态，不是第二套任务台账。
import { randomUUID } from 'node:crypto';

export class CardFilterError extends Error {
  constructor(message, code) { super(message); this.name = 'CardFilterError'; this.code = code; }
}

const LABELS = new Set(['scheduler', 'human', 'unknown']);
const FEEDBACK = {
  'manual-return': { label: 'scheduler', strength: 'strong', status: 'active' },
  reescalated: { label: 'human', strength: 'strong', status: 'active' },
  'direct-answer': { label: 'human', strength: 'weak', status: 'active' },
  'no-correction': { label: 'scheduler', strength: 'weak', status: 'active' },
  conflict: { label: 'unknown', strength: 'weak', status: 'pending' },
};

function sanitizeFeatures(features) {
  const tags = Array.isArray(features?.tags) ? features.tags.filter(tag => /^[a-z]+:[a-z-]+$/.test(String(tag))).map(String) : [];
  return { tags };
}

export function createCardFilterStore(snapshot = {}) {
  const examples = [...(snapshot.examples || [])];
  const decisionList = [...(snapshot.decisions || [])];
  const versionList = (snapshot.versions || []).map(version => ({ ...version }));
  const activeStack = [...(snapshot.activeStack || [])];
  const now = () => new Date().toISOString();
  const findVersion = version => versionList.find(item => item.version === version) || null;
  const mustVersion = version => findVersion(version) || (() => { throw new CardFilterError(`版本不存在：${version}`, 'VERSION_MISSING'); })();

  const store = {
    addExample({ project = null, features, label, source, strength = 'strong', status = 'active' } = {}) {
      if (!LABELS.has(label)) throw new CardFilterError(`未知标签：${label}`, 'BAD_LABEL');
      if (!source) throw new CardFilterError('样本缺少来源', 'BAD_SOURCE');
      const example = { sampleId: randomUUID(), project, features: sanitizeFeatures(features), label, source, strength, status, createdAt: now() };
      examples.push(example);
      return example;
    },
    examples: () => examples.map(item => ({ ...item })),
    trainable: () => examples.filter(item => item.status === 'active').map(item => ({ ...item })),

    createVersion({ rules = [], summary = '', parentVersion = null } = {}) {
      const version = `v${versionList.length + 1}`;
      const record = { version, parentVersion, summary, rules: rules.map(rule => ({ ...rule })), validation: null, status: 'shadow', createdAt: now(), activatedAt: null };
      versionList.push(record);
      return { ...record };
    },
    recordValidation(version, result) {
      mustVersion(version).validation = { total: Number(result?.total) || 0, humanGateFalseAuto: Number(result?.humanGateFalseAuto) || 0, passed: result?.passed === true };
      return { ...mustVersion(version) };
    },
    activate(version) {
      const record = mustVersion(version);
      const v = record.validation;
      if (!v || !v.passed || v.total <= 0 || v.humanGateFalseAuto !== 0) throw new CardFilterError('激活前必须通过验证集，且人工门禁误自动路由为 0', 'VALIDATION_REQUIRED');
      const previous = activeStack[activeStack.length - 1];
      if (previous && previous !== version) mustVersion(previous).status = 'superseded';
      if (previous !== version) activeStack.push(version);
      record.status = 'active';
      record.activatedAt = now();
      return { ...record };
    },
    // 回滚上一生效版本；没有上一版本则全 shadow。只改过滤器状态，不触碰决策记录、Hub run 或原卡。
    rollback() {
      const top = activeStack.pop();
      if (top) mustVersion(top).status = 'rolled_back';
      const previous = activeStack[activeStack.length - 1];
      if (previous) mustVersion(previous).status = 'active';
      return store.current();
    },
    current() {
      const version = activeStack[activeStack.length - 1];
      if (!version) return { version: null, mode: 'shadow', rules: [] };
      const record = mustVersion(version);
      return { version, mode: 'active', rules: record.rules.map(rule => ({ ...rule })) };
    },
    getVersion: version => { const record = findVersion(version); return record ? { ...record } : null; },
    versions: () => versionList.map(item => ({ ...item })),

    recordDecision({ cardId, route, hardGateHits = [], ruleVersion = null, mode = 'shadow', confidence = null, features = null } = {}) {
      const record = {
        decisionId: randomUUID(), cardId, route, hardGateHits: [...hardGateHits], ruleVersion, mode, confidence,
        features: features ? sanitizeFeatures(features) : null, createdAt: now(),
      };
      decisionList.push(record);
      return { ...record };
    },
    decisions: () => decisionList.map(item => ({ ...item })),

    // 人工退回/直接回答/重新升级/无纠正/冲突 → 样本；误路由经 reescalated 形成强 human 纠偏样本。
    recordFeedback(decisionId, kind) {
      const rule = FEEDBACK[kind];
      if (!rule) throw new CardFilterError(`未知反馈：${kind}`, 'BAD_FEEDBACK');
      const found = decisionList.find(item => item.decisionId === decisionId);
      if (!found) throw new CardFilterError('决策记录不存在', 'DECISION_MISSING');
      return store.addExample({ features: found.features, source: kind, ...rule });
    },

    snapshot: () => structuredClone({ examples, decisions: decisionList, versions: versionList, activeStack }),
  };
  return store;
}
