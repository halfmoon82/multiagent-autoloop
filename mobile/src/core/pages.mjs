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
export function buildOverview(snapshot, { now } = {}) {
  const reference = now instanceof Date ? now : new Date(now ?? Date.now());
  const available = Boolean(snapshot?.available?.state);
  const error = snapshot?.errors?.state || null;
  const state = object(snapshot?.state);
  const runs = array(state.runs);
  const cards = array(state.cards);

  const running = runs.filter(run => run?.state === 'claimed');
  const retrying = runs.filter(run => run?.state === 'queued' && (run?.attempts || 0) > 0);
  const doneToday = runs.filter(run => ['done', 'nothing'].includes(run?.state) && sameLocalDay(run?.finishedAt || run?.createdAt, reference));
  const openCards = cards.filter(card => card?.state === 'open');
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
  const projects = collection(dagAvailable ? array(snapshot.dagRuns).map(run => {
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
  }).filter(item => item.runId) : [], dagAvailable ? '暂无项目 DAG 进度' : `DAG 数据缺失：${dagError || '未读取到项目 DAG 进度'}`);

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
    metrics, scheduler, usage: usageText(state, runs, available, error), projects, activity,
  });
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
export function buildTodos(snapshot) {
  const available = Boolean(snapshot?.available?.state);
  const error = snapshot?.errors?.state || null;
  if (!available) return notReady('todos', error, { items: collection([], `状态数据缺失：${error || '未读取到控制台状态'}`) });

  const cards = array(object(snapshot.state).cards);
  const items = cards.filter(card => ['open', 'decided'].includes(String(card?.state || '').trim())).map(card => {
    const stateValue = String(card?.state || '').trim();
    const open = stateValue === 'open';
    const project = String(card?.project || card?.cwd || '').trim();
    return {
      id: card?.id ?? null,
      title: titleOf(card?.title, '待处理事项'),
      text: titleOf(card?.text, ''),
      state: stateValue,
      stateLabel: cardStateLabel(stateValue),
      rule: titleOf(card?.rule, ''),
      project, projectLabel: projectName(project),
      createdAt: String(card?.createdAt || '').trim() || null,
      options: array(card?.options).map(String),
      actions: open ? ['answer-choice', 'answer-text', 'resolve'] : [],
      readOnly: !open,
      choice: open ? null : (card?.choice ?? card?.answer ?? null),
    };
  });
  return page('todos', { items: collection(items, '没有等待您处理的事项。') });
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
    todos: buildTodos(snapshot),
    authorize: buildAuthorization(snapshot),
    navigation: MOBILE_NAVIGATION,
  };
}
