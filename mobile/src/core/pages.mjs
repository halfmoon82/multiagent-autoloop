// 移动端五个核心页面的只读视图模型（Spec §8.2）：总览、调度规则、执行轮次、待我处理、执行授权。
// 纯逻辑：输入是 assembleSnapshot 归一后的后端响应，输出是可安全渲染的普通对象。
// 每个列表都是 collection（空时带明确 reason）；任何状态、模型、费用、进度都只取真实字段。

import {
  MOBILE_PAGE_TITLES, MOBILE_NAVIGATION, statusLabel, dagStatusLabel, cardStateLabel,
  billingText, projectName, scheduleLabel, ruleStatus, collection, titleOf, formatTokens,
  runTaskInfo, sameLocalDay, ACTION_LABELS, OVERVIEW_GROUP_EMPTY,
} from './contract.mjs';

const array = value => (Array.isArray(value) ? value : []);
const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const page = (id, extra = {}) => ({ id, title: MOBILE_PAGE_TITLES[id], ready: true, error: null, ...extra });
const notReady = (id, reason, extra = {}) => ({ id, title: MOBILE_PAGE_TITLES[id], ready: false, error: reason, ...extra });

// 今日用量：已上报费用 → Token + 费用未上报 → 用量未上报。只信 Hub 自报值，不折算、不按模型估算。
function usageText(state, runs, available, error) {
  if (!available) return `状态数据缺失，用量未上报（${error || '未读取到控制台状态'}）`;
  const today = object(state.spending?.today);
  let tokens = 0;
  let cost = null;
  if (Object.keys(today).length) {
    tokens = Number(today.tokens || ((today.input || 0) + (today.output || 0))) || 0;
    cost = typeof today.cost === 'number' ? today.cost : null;
  } else {
    for (const run of runs) {
      const usage = object(run?.usage);
      tokens += (Number(usage.input) || 0) + (Number(usage.output) || 0);
      if (typeof usage.cost === 'number') cost = (cost ?? 0) + usage.cost;
    }
  }
  const tokenText = tokens > 0 ? `Token ${formatTokens(tokens)}` : null;
  if (cost !== null && tokenText) return `费用 $${cost.toFixed(2)} · ${tokenText}`;
  if (cost !== null) return `费用 $${cost.toFixed(2)}`;
  if (tokenText) return `${tokenText} · 费用未上报`;
  return '用量未上报';
}

// 总览：四组计数与最近 5 条标题概要、待调度处理分组、项目 DAG 进度与最近动态。
// 环形进度百分比由后续 dag-ring 节点提供，本节点不编造进度数字。
export function buildOverview(snapshot, { now, hiddenIds } = {}) {
  const reference = now instanceof Date ? now : new Date(now ?? Date.now());
  const available = Boolean(snapshot?.available?.state);
  const error = snapshot?.errors?.state || null;
  const state = object(snapshot?.state);
  const runs = array(state.runs);
  const cards = array(state.cards);

  const running = runs.filter(run => run?.state === 'claimed');
  const retrying = runs.filter(run => run?.state === 'queued' && (run?.attempts || 0) > 0);
  const doneToday = runs.filter(run => ['done', 'nothing'].includes(run?.state) && sameLocalDay(run?.finishedAt || run?.createdAt, reference));
  const openCards = pendingCards(cards, hiddenIds);
  const attention = runs.filter(run => ['unknown', 'cancelled'].includes(run?.state));
  const runTitles = list => list.slice(0, 5).map(run => runTaskInfo(run).taskSummary);
  const group = (id, label, list) => ({ id, label, count: list.length, titles: runTitles(list), emptyReason: OVERVIEW_GROUP_EMPTY[id] });

  // 四组与网页版一致：正在运行 / 等待重试 / 今日完成 / 待调度处理（待调度处理不等于待用户处理）。
  const metrics = collection(available ? [
    group('running', '正在运行', running),
    group('retrying', '等待重试', retrying),
    group('doneToday', '今日完成', doneToday),
    group('attention', '待调度处理', attention),
  ] : [], available ? '暂无可统计的任务' : `状态数据缺失：${error || '未读取到控制台状态'}（不编造四组数字）`);

  const scheduler = collection(attention.slice(0, 5).map(run => ({
    id: run?.id ?? null,
    title: runTaskInfo(run).taskSummary,
    status: run?.state ?? null,
    statusLabel: statusLabel(run?.state),
  })), OVERVIEW_GROUP_EMPTY.attention, { note: '调度方按契约自行处理，不升级给您' });

  const dagAvailable = Boolean(snapshot?.available?.['dag-runs']);
  const dagError = snapshot?.errors?.['dag-runs'] || null;
  // 串行链（如 Health Core）不是 DAG，但同属项目进度，必须与 DAG run 并列展示（真机漏报事故 2026-11-23）。
  const serialAvailable = Boolean(snapshot?.available?.['serial-progress']);
  const serialError = snapshot?.errors?.['serial-progress'] || null;
  const dagItems = dagAvailable ? array(snapshot.dagRuns).map(run => {
    const summary = object(run?.mobileSummary);
    const project = String(summary.project ?? run?.project ?? '').trim();
    const status = String(summary.status ?? run?.status ?? '').trim();
    return {
      runId: String(summary.runId ?? run?.runId ?? '').trim() || null,
      project, projectLabel: projectName(project),
      planId: String(summary.planId ?? run?.planId ?? '').trim() || null,
      status, statusLabel: dagStatusLabel(status),
      nodeCount: Number.isInteger(summary.nodeCount) ? summary.nodeCount : array(run?.nodes).length,
      progressAvailable: false,
      dagEntry: { label: '项目 DAG', page: 'dag', runId: String(summary.runId ?? run?.runId ?? '').trim() },
    };
  }).filter(item => item.runId) : [];
  const chainItems = serialAvailable ? array(object(snapshot.serial).chains).map(chain => {
    const project = String(chain?.project ?? '').trim();
    const nodes = array(chain?.nodes);
    return {
      runId: String(chain?.sourceFile ?? '').trim() || null,
      project, projectLabel: `${projectName(project)}（串行链）`,
      planId: null,
      status: 'serial', statusLabel: `${Math.round(Number(chain?.percent) || 0)}%`,
      nodeCount: nodes.length,
      progressAvailable: false,
      dagEntry: null,
      chainEntry: { label: '串行链详情' },
      chainDetail: chainDetail(chain, nodes),
    };
  }).filter(item => item.runId && item.project) : [];
  // 无活跃（未完结）串行链时如实说明，不把空当成故障，也不误报有进度。
  const serialNote = !serialAvailable ? null
    : (chainItems.some(item => (Number.parseFloat(item.statusLabel) || 0) < 100) ? null : '暂无活跃串行链');
  // 活跃项排前：历史 done/cancelled 的 DAG 沉底，进行中串行链排在活跃 DAG 之后、已完结链之前，
  // 避免活跃项目被挤出首屏（2026-11-24 真机：首屏只见已完成/已取消，误判"活跃项目无展示"）。
  const DONE_STATUSES = new Set(['done', 'cancelled', 'canceled', 'failed', 'complete', 'completed']);
  const FAIL_STATUSES = new Set(['failed', 'error']);
  const itemRank = item => {
    const isSerial = item.status === 'serial';
    const done = isSerial
      ? (Number.parseFloat(item.statusLabel) || 0) >= 100
      : DONE_STATUSES.has(String(item.status || '').toLowerCase());
    if (!done && !isSerial) return 0;
    if (!done) return 1;
    if (isSerial) return 2;
    return 3;
  };
  const projectItems = [...dagItems, ...chainItems]
    .map((item, index) => ({ item, index, rank: itemRank(item) }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    // archived：已完结的归入「已归档」折叠区（2026-11-25 用户定：活跃项直接展示环，完成的收进已归档）。
    // failed/error 不算已完成——失败信号留在首屏可见，绝不藏进归档（同日用户二次确认）。
    .map(entry => ({
      ...entry.item,
      archived: entry.rank >= 2 && !FAIL_STATUSES.has(String(entry.item.status || '').toLowerCase()),
    }));
  const projects = collection(projectItems, dagAvailable || serialAvailable
    ? '暂无项目进度'
    : `DAG 数据缺失：${dagError || '未读取到项目 DAG 进度'}；${serialError || '串行进度数据缺失，未读取到串行链进度'}`);

  const sorted = [...runs].sort((a, b) => String(b?.finishedAt || b?.createdAt || '').localeCompare(String(a?.finishedAt || a?.createdAt || '')));
  const activity = collection(sorted.slice(0, 5).map(run => ({
    id: run?.id ?? null,
    title: runTaskInfo(run).taskSummary,
    status: run?.state ?? null,
    statusLabel: statusLabel(run?.state),
    at: String(run?.finishedAt || run?.createdAt || '').trim() || null,
  })), '暂无最近动态');

  return page('overview', {
    ready: available, error,
    openTodoCount: openCards.length,
    metrics, scheduler, usage: usageText(state, runs, available, error), projects, serialNote, activity,
  });
}

function chainDetail(chain, nodes) {
  // 真实 /api/serial-progress 的 current 是节点对象，测试种子也可能是 id 字符串，两种口径都认（fix4）。
  const current = String(chain?.current?.id ?? chain?.current ?? '').trim();
  const items = nodes.map(n => {
    const id = String(n?.id ?? '').trim();
    return {
      id,
      title: String(n?.title ?? '').trim() || id || '未命名节点',
      status: String(n?.status ?? '').trim(),
      percent: Math.max(0, Math.min(100, Math.round(Number(n?.percent) || 0))),
      summary: String(n?.summary ?? n?.note ?? '').trim(),
      part: String(n?.part ?? '').trim(),
      isCurrent: Boolean(id) && id === current,
    };
  });
  return {
    percent: Math.max(0, Math.min(100, Math.round(Number(chain?.percent) || 0))),
    current: current || null,
    updatedAt: String(chain?.updatedAt ?? '').trim() || null,
    nodes: items,
    empty: items.length === 0,
    reason: items.length ? null : '该串行链暂无节点明细',
  };
}

// 调度规则：结构取服务端只读摘要，状态从 Hub lines 叠加；只保留运行/暂停/恢复/编辑。
export function buildRules(snapshot) {
  const available = Boolean(snapshot?.available?.rules);
  const error = snapshot?.errors?.rules || null;
  if (!available) return notReady('rules', error, { items: collection([], `规则数据缺失：${error || '未读取到调度规则'}`) });

  const rules = object(snapshot.rules);
  const summaries = array(rules.mobileRules).length ? array(rules.mobileRules) : array(rules.rules).map(rule => ({
    name: titleOf(rule?.name, ''), project: titleOf(rule?.cwd, ''), agent: titleOf(rule?.to, ''),
    agentLabel: null, trigger: scheduleLabel(rule), actions: ['run', 'pause', 'resume', 'edit'],
  }));
  const stateAvailable = Boolean(snapshot?.available?.state);
  const lines = array(object(snapshot.state).lines);
  const lineByName = new Map(lines.map(line => [String(line?.name || '').trim(), line]));
  const stateError = snapshot?.errors?.state || null;

  const items = summaries.map(summary => {
    const line = lineByName.get(String(summary.name || '').trim());
    const status = stateAvailable && line
      ? ruleStatus(line)
      : { known: false, label: '状态未知', kind: '', detail: '' };
    const reason = !stateAvailable
      ? `状态数据缺失：${stateError || '未读取到控制台状态'}（不编造运行/暂停）`
      : '该规则没有对应的状态数据，不编造运行状态';
    return {
      id: String(summary.name || '').trim(),
      name: titleOf(summary.name, '未命名规则'),
      project: titleOf(summary.project, ''),
      projectLabel: projectName(summary.project),
      agent: titleOf(summary.agent, ''),
      agentLabel: summary.agentLabel ?? null,
      trigger: titleOf(summary.trigger, scheduleLabel({})),
      actions: array(summary.actions).length ? [...array(summary.actions)] : ['run', 'pause', 'resume', 'edit'],
      status: status.known ? status.label : null,
      statusKnown: status.known,
      statusLabel: status.known ? status.label : '状态未知',
      statusDetail: status.known ? status.detail : reason,
      statusKind: status.kind,
    };
  }).filter(item => item.id);

  return page('rules', { items: collection(items, '暂无调度规则') });
}

// 执行轮次：状态、任务摘要、模型、费用、会话链接与停止能力都取真实字段。
export function buildRuns(snapshot) {
  const available = Boolean(snapshot?.available?.state);
  const error = snapshot?.errors?.state || null;
  if (!available) return notReady('runs', error, { items: collection([], `状态数据缺失：${error || '未读取到控制台状态'}`) });

  const state = object(snapshot.state);
  const models = object(object(snapshot.rules).models);
  const items = array(state.runs).map(run => {
    const info = runTaskInfo(run);
    const stateValue = String(run?.state || '').trim();
    const agent = String(run?.agent || '').trim();
    const project = String(run?.project || run?.cwd || '').trim();
    return {
      id: run?.id ?? null,
      status: stateValue || null,
      statusLabel: stateValue === 'queued' && (run?.attempts || 0) > 0 ? '等待重试' : statusLabel(stateValue),
      taskSummary: info.taskSummary,
      taskNumber: info.taskNumber,
      project, projectLabel: projectName(project),
      agent,
      model: models[agent] || '未配置',
      billing: billingText(run),
      attempts: Number(run?.attempts) || 0,
      canStop: ['claimed', 'queued'].includes(stateValue),
      sessionLink: String(run?.sessionId || '').trim() || null,
    };
  });
  return page('runs', { items: collection(items, '没有执行轮次') });
}

// 待我处理：保留决策上下文，只给选项回答、文字回答与结案，不虚构「进入原始会话」。
// 只列仍待处理（open）的卡：回答/结案后卡片离开待办（2026-11-25 真机反馈「答完卡还在」）。
// hiddenIds：本机刚回答成功、Hub 状态尚未重读到的卡，立即隐藏，避免重读往返期间残留。
// 卡片 lane 为 scheduling:<会话id> 时标注来源会话，让跨会话的卡一眼可辨。
export function buildTodos(snapshot, { hiddenIds } = {}) {
  const available = Boolean(snapshot?.available?.state);
  const error = snapshot?.errors?.state || null;
  if (!available) return notReady('todos', error, { items: collection([], `状态数据缺失：${error || '未读取到控制台状态'}`) });

  const items = pendingCards(object(snapshot.state).cards, hiddenIds).map(card => {
    const project = String(card?.project || card?.cwd || '').trim();
    const sourceLabel = cardSourceLabel(card);
    return {
      id: card?.id ?? null,
      title: titleOf(card?.title, '待处理事项'),
      text: titleOf(card?.text, ''),
      state: 'open',
      stateLabel: cardStateLabel('open'),
      rule: titleOf(card?.rule, ''),
      project, projectLabel: projectName(project),
      createdAt: String(card?.createdAt || '').trim() || null,
      options: array(card?.options).map(String),
      actions: ['answer-choice', 'answer-text', 'resolve'],
      readOnly: false,
      choice: null,
      lane: String(card?.lane || '').trim() || null,
      ...(sourceLabel ? { sourceLabel } : {}),
    };
  });
  return page('todos', { items: collection(items, '没有等待您处理的事项。') });
}

// 仍待处理的卡：state=open 且不在本机刚答过的隐藏集合里。待办列表与角标共用同一口径。
export function pendingCards(cards, hiddenIds) {
  const hidden = new Set([...(hiddenIds || [])].map(String));
  return array(cards).filter(card => String(card?.state || '').trim() === 'open'
    && card?.id !== undefined && card?.id !== null && !hidden.has(String(card.id)));
}

// 卡片来源标注：只认 scheduling:<会话id> 形态的会话 lane；DAG 巡检/代理等系统 lane 不冒充会话。
const SYSTEM_LANES = /^scheduling:(?:dag|dag-stall|card-delegate):/;
export function cardSourceLabel(card) {
  const lane = String(card?.lane || '').trim();
  if (!lane.startsWith('scheduling:') || SYSTEM_LANES.test(lane)) return '';
  const id = lane.slice('scheduling:'.length);
  return id ? `来自会话 ${id.slice(0, 8)}` : '';
}

// 执行授权：目标项目、授权范围、外部动作边界取服务端冻结摘要；移动端只读展示，确认/创建不在本页。
function summarizeRun(run) {
  const raw = object(run);
  const provided = object(raw.mobileSummary);
  const grant = object(raw.authorizationSnapshot);
  const nodes = array(raw.nodes);
  const pick = (key, fallback) => provided[key] ?? fallback;
  return {
    runId: String(pick('runId', raw.runId) || '').trim() || null,
    project: String(pick('project', raw.project) || '').trim() || null,
    planId: String(pick('planId', raw.planId) || '').trim() || null,
    status: String(pick('status', raw.status) || '').trim() || null,
    planDigest: pick('planDigest', grant.planDigest) || null,
    remoteUrl: pick('remoteUrl', raw.remoteUrl || grant.remoteUrl) || null,
    nodeCount: Number.isInteger(provided.nodeCount) ? provided.nodeCount : nodes.length,
    files: array(provided.files).length
      ? array(provided.files).map(String)
      : [...new Set(nodes.flatMap(node => array(object(node).contract?.files).map(String)))],
    allowedActions: array(provided.allowedActions).map(String).sort(),
    deniedActions: array(provided.deniedActions).map(String),
    authorizationPresent: typeof provided.authorizationPresent === 'boolean'
      ? provided.authorizationPresent
      : Object.keys(grant).length > 0,
  };
}

export function buildAuthorization(snapshot) {
  const available = Boolean(snapshot?.available?.['dag-runs']);
  const error = snapshot?.errors?.['dag-runs'] || null;
  if (!available) {
    return notReady('authorize', error, { items: collection([], `DAG 数据缺失：${error || '未读取到执行授权记录'}`) });
  }

  const items = array(snapshot.dagRuns).map(run => {
    const summary = summarizeRun(run);
    const scopeItems = summary.authorizationPresent ? [
      { id: 'allowed', label: '本次允许', values: summary.allowedActions.map(id => ACTION_LABELS[id] || id) },
      { id: 'nodes', label: '节点与文件范围', values: [...summary.files] },
    ] : [];
    return {
      runId: summary.runId,
      target: { project: projectName(summary.project), remoteUrl: summary.remoteUrl || '未发现远端（不能推送）' },
      project: summary.project, projectLabel: projectName(summary.project),
      planId: summary.planId, planDigest: summary.planDigest,
      status: summary.status, statusLabel: dagStatusLabel(summary.status),
      nodeCount: summary.nodeCount,
      files: [...summary.files],
      allowedActions: [...summary.allowedActions],
      deniedActions: [...summary.deniedActions],
      remoteUrl: summary.remoteUrl,
      authorizationPresent: summary.authorizationPresent,
      scope: collection(scopeItems, '授权快照缺失，不显示授权范围'),
      boundary: '始终不包含：部署、发布、生产数据写入、新建或读取其他凭据、对外通信；不授权部署、发布或生产数据变更。',
      readOnly: true,
      actions: [],
    };
  }).filter(item => item.runId);

  return page('authorize', { items: collection(items, '尚无执行授权记录') });
}

export function buildPages(snapshot, options = {}) {
  return {
    overview: buildOverview(snapshot, options),
    rules: buildRules(snapshot),
    runs: buildRuns(snapshot),
    todos: buildTodos(snapshot, options),
    authorize: buildAuthorization(snapshot),
    navigation: MOBILE_NAVIGATION,
  };
}
