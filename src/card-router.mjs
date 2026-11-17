// 卡片路由过滤器（Spec §9）：只决定路由，不执行卡片动作。
// 优先级：人工门禁硬规则 > 工程候选规则 > unknown（冲突/低置信/模型故障）。模型与学习规则不能改写前两条。
export const ROUTES = Object.freeze(['scheduler', 'human', 'unknown']);
export const MIN_CONFIDENCE = 0.8;

export const HUMAN_GATES = Object.freeze({
  product: ['产品功能', '功能取舍', '产品方向', '产品定位'],
  privacy: ['隐私', '个人数据', '个人信息', '手机号', '身份证'],
  finance: ['购买', '付费', '预算', '套餐', '支付', '报销', '费用'],
  external: ['对外', '发布公告', '发邮件', '客户', '公开发布'],
  credential: ['密码', '验证码', '密钥', '登录', '凭据', 'token', 'api key'],
  exhausted: ['穷举', '均失败', '全部失败', '所有方案', '已无可行'],
});

const ENGINEERING_TAGS = Object.freeze({
  'eng:test': ['测试', 'test'],
  'eng:refactor': ['重构', 'refactor'],
  'eng:build': ['构建', '编译', 'build', 'lint'],
  'eng:bug': ['修复', 'bug', '报错', '堆栈'],
});

export const DEFAULT_RULES = Object.freeze([
  { id: 'eng-test', route: 'scheduler', tags: ['eng:test'], confidence: 0.9 },
  { id: 'eng-refactor', route: 'scheduler', tags: ['eng:refactor'], confidence: 0.9 },
  { id: 'eng-build', route: 'scheduler', tags: ['eng:build'], confidence: 0.9 },
  { id: 'eng-bug', route: 'scheduler', tags: ['eng:bug'], confidence: 0.85 },
]);

const hit = (haystack, words) => words.some(word => haystack.includes(word.toLowerCase()));

// 脱敏特征：只保留标签与门禁命中，不带原文、秘密或个人数据。
export function extractFeatures(card = {}) {
  const haystack = `${card.title || ''}\n${card.text || ''}\n${(Array.isArray(card.options) ? card.options : []).map(o => (typeof o === 'string' ? o : o?.label || '')).join('\n')}`.toLowerCase();
  const hardGateHits = Object.entries(HUMAN_GATES).filter(([, words]) => hit(haystack, words)).map(([gate]) => gate);
  const tags = Object.entries(ENGINEERING_TAGS).filter(([, words]) => hit(haystack, words)).map(([tag]) => tag);
  return { tags, hardGateHits };
}

function decision(route, extra) {
  return { route, autoRoute: false, hardGateHits: [], confidence: null, reasons: [], ...extra };
}

function finalize(base, { ruleVersion, mode }) {
  const autoRoute = base.route === 'scheduler' && mode === 'active' && base.autoRoute;
  return { ...base, autoRoute, ruleVersion: ruleVersion ?? null, mode: mode === 'active' ? 'active' : 'shadow' };
}

function ruleDecision(features, rules) {
  const hits = features.hardGateHits;
  if (hits.length) return decision('human', { hardGateHits: hits, confidence: 1, reasons: [`命中人工门禁：${hits.join('、')}`] });
  const matched = (Array.isArray(rules) ? rules : []).filter(rule => rule?.tags?.length && rule.tags.every(tag => features.tags.includes(tag)));
  if (!matched.length) return decision('unknown', { reasons: ['没有匹配的规则'] });
  const routes = new Set(matched.map(rule => rule.route));
  if (routes.size > 1) return decision('unknown', { reasons: ['规则冲突'] });
  const confidence = Math.max(...matched.map(rule => Number(rule.confidence) || 0));
  const route = [...routes][0];
  if (route === 'human') return decision('human', { confidence, reasons: ['规则判定需要人'] });
  if (route !== 'scheduler' || confidence < MIN_CONFIDENCE) return decision('unknown', { confidence, reasons: ['置信度不足'] });
  return decision('scheduler', { autoRoute: true, confidence, reasons: [`规则 ${matched.map(rule => rule.id).join(',')}`] });
}

export function routeCard(card, { rules = DEFAULT_RULES, ruleVersion = null, mode = 'shadow' } = {}) {
  return finalize(ruleDecision(extractFeatures(card), rules), { ruleVersion, mode });
}

// 模型只能否决（降为 unknown），不能把规则之外的卡升为 scheduler，也不能改写人工门禁；模型只收到脱敏特征。
export async function routeCardAsync(card, { model, ...context } = {}) {
  const features = extractFeatures(card);
  const base = ruleDecision(features, context.rules ?? DEFAULT_RULES);
  if (typeof model === 'function' && base.route === 'scheduler') {
    try {
      const advice = await model({ tags: [...features.tags] });
      if (advice?.route !== 'scheduler' || !(Number(advice.confidence) >= MIN_CONFIDENCE)) {
        return finalize(decision('unknown', { confidence: base.confidence, reasons: ['模型建议与规则冲突或置信不足'] }), context);
      }
    } catch {
      return finalize(decision('unknown', { reasons: ['模型故障，退化为 unknown'] }), context);
    }
  }
  return finalize(base, context);
}

// 只有 active 模式下的 scheduler 自动路由才会调用退回事务（幂等，由 card-delegate 承担）；其余零副作用。
export async function applyRoute(routeDecision, card, { delegate } = {}) {
  if (!routeDecision?.autoRoute || routeDecision.mode !== 'active' || routeDecision.route !== 'scheduler') return { applied: false };
  if (typeof delegate !== 'function') return { applied: false };
  const result = await delegate(card, routeDecision);
  return { applied: true, result };
}
