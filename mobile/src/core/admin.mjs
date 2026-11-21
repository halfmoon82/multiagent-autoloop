// 管理后台视图模型（与网页版 public/admin-platform-models.mjs、public/views.mjs renderEnvironment 同口径）：
// 平台与模型 = 只读字段（平台、默认模型、可选模型数）+ 可编辑草稿（开关、三档模型、工作分配、会话档位）；
// 运行环境 = 只读在线状态与待复查。纯函数、不碰 DOM/网络；只取真实字段，缺失给网页版同款空态，不编造。

export const ADMIN_TIERS = Object.freeze([['light', '便宜档'], ['standard', '中档'], ['heavy', '高档']]);
export const ADMIN_ROLE_ROWS = Object.freeze([
  { key: 'dev', title: '开发', hint: 'DAG 节点开发', auto: '按节点自动' },
  { key: 'review', title: '审阅', hint: 'DAG 节点独立审阅', auto: '按节点自动 · 最低中档' },
  { key: 'coord', title: '调度会话', hint: '诊断、协调、派发' },
  { key: 'design', title: '设计会话', hint: 'PRD / Spec / DAG 规划', session: true },
  { key: 'normal', title: '普通会话', hint: '问答、分析、普通开发', session: true },
]);
export const ADMIN_EMPTY = Object.freeze({
  environment: '还没有在线运行环境。',
  timers: '没有等待到期的复查。',
  platforms: '未发现可用的执行平台。',
});

const clone = value => JSON.parse(JSON.stringify(value));
const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const array = value => (Array.isArray(value) ? value : []);
const blankTiers = () => ({ light: '', standard: '', heavy: '' });
export const tiersComplete = tiers => Boolean(tiers && ADMIN_TIERS.every(([tier]) => String(tiers[tier] || '').trim()));

// 服务端响应形态校验：形态不对直接报错回显，不用默认值掩盖。
export function validatePlatformModels(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.platforms)) throw new Error('平台与模型数据格式不正确，未读取到平台列表');
  for (const key of ['roles', 'sessions', 'suggested']) if (!object(data[key]) || data[key] === null) throw new Error(`平台与模型数据缺少 ${key}`);
  return data;
}

// 初始草稿：开关始终显示真实状态；首次进入预填建议值，人打开开关并保存才生效（同网页版）。
export function initialAdminDraft(data) {
  const saved = Boolean(data.lastSaved);
  const suggested = object(object(data.suggested).platforms);
  const platforms = {};
  for (const platform of array(data.platforms)) {
    platforms[platform.id] = platform.tiers ? { ...platform.tiers } : saved ? blankTiers() : { ...(suggested[platform.id] || blankTiers()) };
  }
  const sessions = clone(object(data.sessions));
  for (const kind of ['design', 'normal']) if (!sessions[kind]?.platform) sessions[kind] = { ...object(object(data.suggested).sessions)[kind] };
  return { enabled: data.enabled === true, platforms, roles: clone(object(data.roles)), sessions };
}

export function adminPreviewLines(data, draft) {
  const name = id => array(data.platforms).find(p => p.id === id)?.name || id || '未选择';
  const model = (id, tier) => draft.platforms[id]?.[tier] || '平台默认';
  const pick = (id, tier) => `${name(id)} · ${model(id, tier)}`;
  if (!draft.enabled) return ['分档已关闭：所有工作沿用各平台默认模型。'];
  const { dev, review, coord } = draft.roles;
  return [
    `小节点开发 → ${pick(dev?.primary, 'light')}　|　${name(dev?.primary)} 被频限时 → ${pick(dev?.fallback, 'light')}`,
    `普通审阅 → ${pick(review?.primary, 'standard')}　|　资金/数据/安全节点审阅 → ${pick(review?.primary, 'heavy')}`,
    `调度会话 → ${pick(coord?.primary, draft.sessions.coord?.tier)}　|　新建设计会话 → ${pick(draft.sessions.design?.platform, draft.sessions.design?.tier)}　|　新建普通会话 → ${pick(draft.sessions.normal?.platform, draft.sessions.normal?.tier)}`,
  ];
}

// 保存请求体：只带至少配了一档的平台（同网页版 submit）。
export function buildAdminSavePayload(draft) {
  const platforms = Object.fromEntries(Object.entries(draft.platforms)
    .filter(([, tiers]) => ADMIN_TIERS.some(([tier]) => String(tiers?.[tier] || '').trim())));
  return { ...draft, platforms };
}

// 平台与模型页面模型：只读字段 + 草稿 + 保存前确认摘要。
export function buildAdminPlatformPage(data) {
  const valid = validatePlatformModels(data);
  const platforms = array(valid.platforms).map(platform => ({
    id: platform.id,
    name: platform.name || platform.id,
    defaultModel: platform.defaultModel || '未配置',
    modelCount: Array.isArray(platform.models) ? platform.models.length : null,
    models: Array.isArray(platform.models) ? [...platform.models] : null,
    sessionCapable: platform.sessionCapable !== false,
    access: platform.access || null,
    isNew: Boolean(valid.lastSaved) && !platform.tiers,
  }));
  return {
    platforms, empty: platforms.length === 0, emptyReason: ADMIN_EMPTY.platforms,
    draft: initialAdminDraft(valid),
    lastSaved: valid.lastSaved ? { at: valid.lastSaved.at || null, backup: valid.lastSaved.backup || '无' } : null,
    confirm: '保存会改动真实调度配置：先自动备份，再更新执行者与分档规则；原有规则保留作兜底。正在运行的节点和已打开的会话不受影响。',
    floors: ['审阅至少中档；资金、数据、安全类节点开发至少中档、审阅高档；整合审阅固定高档。', '同一节点失败 3 次自动升一档；计划里可为单个节点指定档位（底线仍生效）。'],
  };
}

// 运行环境：来自 /api/state 的 agents/channels 在线状态与 timers 待复查，和网页版 renderEnvironment/renderTimers 同口径。
export function buildAdminRuntime(snapshot) {
  const available = Boolean(snapshot?.available?.state);
  const error = snapshot?.errors?.state || null;
  const state = object(snapshot?.state);
  if (!available) {
    return { ready: false, error, environment: [], timers: [], environmentReason: `状态数据缺失：${error || '未读取到控制台状态'}（不编造在线状态）`, timersReason: ADMIN_EMPTY.timers };
  }
  const environment = [...array(state.agents), ...array(state.channels)].map(item => ({
    name: String(item?.name || item?.id || '').trim() || '未命名',
    kind: String(item?.worker || '').trim() || '通知通道',
    online: item?.online === true,
    statusLabel: item?.online ? '在线' : '离线',
  }));
  const timers = array(state.timers).map(timer => ({
    rule: String(timer?.rule || '').trim(), about: String(timer?.about || timer?.key || '').trim(), at: String(timer?.at || '').trim() || null,
  }));
  return { ready: true, error: null, environment, timers, environmentReason: ADMIN_EMPTY.environment, timersReason: ADMIN_EMPTY.timers };
}
