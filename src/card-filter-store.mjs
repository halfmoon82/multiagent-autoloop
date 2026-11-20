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
    addExample({ project = null, features, label, source, strength = 'strong', status = 'active', decisionId = null } = {}) {
      if (!LABELS.has(label)) throw new CardFilterError(`未知标签：${label}`, 'BAD_LABEL');
      if (!source) throw new CardFilterError('样本缺少来源', 'BAD_SOURCE');
      const example = { sampleId: randomUUID(), project, features: sanitizeFeatures(features), label, source, strength, status, ...(decisionId ? { decisionId } : {}), createdAt: now() };
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

    // 从磁盘快照就地重载（保持 store 对象 identity 不变，避免外部持有的引用失效）。
    // 供单一写者在每次写前按文件 mtime 重读：把外部进程（CLI --publish）落盘的版本/决策并入本进程。
    // 只替换集合内容，不改判定语义；调用方负责只在磁盘确实更新时调用。
    reload(snapshot = {}) {
      examples.length = 0;
      examples.push(...(snapshot.examples || []));
      decisionList.length = 0;
      decisionList.push(...(snapshot.decisions || []));
      versionList.length = 0;
      versionList.push(...(snapshot.versions || []).map(version => ({ ...version })));
      activeStack.length = 0;
      activeStack.push(...(snapshot.activeStack || []));
      return store;
    },

    // 人工退回/直接回答/重新升级/无纠正/冲突 → 样本；误路由经 reescalated 形成强 human 纠偏样本。
    recordFeedback(decisionId, kind) {
      const rule = FEEDBACK[kind];
      if (!rule) throw new CardFilterError(`未知反馈：${kind}`, 'BAD_FEEDBACK');
      const found = decisionList.find(item => item.decisionId === decisionId);
      if (!found) throw new CardFilterError('决策记录不存在', 'DECISION_MISSING');
      // 幂等：同一决策同一种反馈只记一次（decisionId 只是内部 id，不含卡片内容）。
      if (examples.some(item => item.decisionId === decisionId && item.source === kind)) return null;
      return store.addExample({ features: found.features, source: kind, decisionId, ...rule });
    },

    snapshot: () => structuredClone({ examples, decisions: decisionList, versions: versionList, activeStack }),
  };
  return store;
}
