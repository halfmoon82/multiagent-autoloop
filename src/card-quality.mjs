// 人工卡片产品语言质量门：只读校验，不改写业务内容、不自动作答、不删除卡片。
// 不合格卡返回可测试的错误清单并退回调度方重写；纯工程卡标记 route=scheduler。

export class CardQualityError extends Error {
  constructor(errors) {
    super('卡片未通过产品语言质量门');
    this.name = 'CardQualityError';
    this.errors = errors;
  }
}

const JARGON_PATTERNS = [
  { label: '内部文件名或路径', match: /(^|[\s（(])([./][\w./-]+\.(mjs|js|json|md|log|ts|sh|yaml|yml))|(\b[\w-]+\.(mjs|js|json|ts|log)\b)/i },
  { label: '代码标识符', match: /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\b/ },
  { label: '函数调用', match: /\b[A-Za-z_$][\w$]*\(\)/ },
  {
    label: '技术术语',
    match: /\b(worktree|commit|merge|rebase|push|git|npm|node|schema|digest|cron|rollback|trace|TypeError|Traceback|CLI|API|HTTP|JSON|ACP|SDK|sha256|TODO|FIXME)\b/i,
  },
  { label: '技术表述', match: /(函数名|堆栈|内部文件名|接口名|目录路径|打补丁|重新编译|回滚分支)/ },
];

const PRODUCT_IMPACT = /(用户|客户|收入|成本|费用|预算|功能|上线|发布|体验|隐私|资金|品牌|责任|影响|后果)/;

function jargonIn(text) {
  const found = [];
  for (const pattern of JARGON_PATTERNS) if (pattern.match.test(text)) found.push(pattern.label);
  return [...new Set(found)];
}

function error(code, field, message) { return { code, field, message }; }

export function validateCardQuality(card = {}) {
  const errors = [];
  const title = String(card.title ?? '').trim();
  const background = String(card.background ?? card.text ?? '').trim();
  const reason = String(card.reason ?? card.decisionReason ?? '').trim();
  const jargon = jargonIn(`${background} ${title}`);

  if (!title) errors.push(error('TITLE_MISSING', 'title', '标题缺失：必须是一句完整的决策问题'));
  else if (!/[?？]$/.test(title) && !/(是否|还是|要不要|该不该|能否)/.test(title)) errors.push(error('TITLE_NOT_QUESTION', 'title', '标题必须是一句完整的决策问题'));

  if (!background) errors.push(error('BACKGROUND_MISSING', 'background', '背景缺失：必须用产品经理能听懂的话说明发生了什么'));
  if (jargon.length) errors.push(error('TECH_JARGON', 'background', `背景含技术黑话：${jargon.join('、')}`, jargon));
  if (!reason && !/(不决定|后果|为什么现在|需要现在决定|拖下去|待决)/.test(background)) errors.push(error('REASON_MISSING', 'reason', '必须说明待决原因与不决定的后果'));

  const options = Array.isArray(card.options) ? card.options : [];
  if (!options.length) errors.push(error('OPTIONS_EMPTY', 'options', '至少提供两个选项'));
  options.forEach((option, index) => {
    const field = `options[${index}]`;
    if (typeof option === 'string') {
      if (!/(收益|好处|利[:：])/.test(option)) errors.push(error('OPTION_BENEFIT_MISSING', field, '每个选项必须注明收益'));
      if (!/(代价|成本|风险|弊[:：])/.test(option)) errors.push(error('OPTION_COST_MISSING', field, '每个选项必须注明代价'));
    } else if (option && typeof option === 'object') {
      if (!String(option.benefit ?? '').trim()) errors.push(error('OPTION_BENEFIT_MISSING', field, '每个选项必须注明收益'));
      if (!String(option.cost ?? '').trim()) errors.push(error('OPTION_COST_MISSING', field, '每个选项必须注明代价'));
    } else errors.push(error('OPTION_INVALID', field, '选项内容无效'));
  });

  if (card.recommendation != null) {
    const recommendation = typeof card.recommendation === 'string' ? { label: card.recommendation } : card.recommendation;
    if (!recommendation || !String(recommendation.reason ?? '').trim()) errors.push(error('RECOMMENDATION_REASON_MISSING', 'recommendation', '有推荐项时必须说明推荐理由'));
  }

  const pureEngineering = jargon.length >= 2 && !PRODUCT_IMPACT.test(`${title} ${background}`);
  return { ok: errors.length === 0, errors, route: pureEngineering ? 'scheduler' : errors.length ? 'unknown' : 'human' };
}

export function assertCardQuality(card) {
  const result = validateCardQuality(card);
  if (!result.ok) throw new CardQualityError(result.errors);
  return result;
}
