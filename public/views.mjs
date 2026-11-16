import { formatState, formatTime, statusLabel, scheduleLabel, projectName, ruleLineStatus } from './format.mjs';
import { splitRunSections, projectForRun, projectForCard, projectActivity, matchesProject, latestChainsByProject, ruleProject, chainUsage } from './status-sections.mjs';
export function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function empty(container, text) { container.replaceChildren(el('div', 'empty', text)); }
function badge(text, kind = '') { return el('span', `status ${kind}`, text); }
const projectText = project => `项目 · ${project}`;
export function renderSummary(snapshot) {
  const view = formatState(snapshot);
  const items = [
    ['正在运行', view.active, 'Agent 正在处理', ''],
    ['等待与重试', view.waiting, '排队或等待下一次尝试', ''],
    ['今日完成', view.doneToday, `输入与输出合计 ${view.tokens} Token`, ''],
    ['需要您处理', view.openCards, `今日费用 ${view.cost}`, 'attention'],
  ];
  return items.map(([label, value, note, kind]) => { const card = el('article', `metric ${kind}`); card.append(el('div', 'metric-label', label), el('div', 'metric-value', String(value)), el('div', 'metric-note', note)); return card; });
}
export function renderEnvironment(snapshot) {
  const items = [...(snapshot.agents || []), ...(snapshot.channels || [])];
  if (!items.length) return [el('div', 'empty', '还没有在线运行环境。')];
  return items.map(item => { const row = el('div', 'list-row'); const text = el('div'); text.append(el('div', 'row-title', item.name || item.id), el('div', 'row-meta', item.worker || '通知通道')); row.append(text, badge(item.online ? '在线' : '离线', item.online ? 'good' : 'bad')); return row; });
}
export function renderTimers(snapshot) {
  if (!(snapshot.timers || []).length) return [el('div', 'empty', '没有等待到期的复查。')];
  return snapshot.timers.map(timer => { const row = el('div', 'list-row'); const text = el('div'); text.append(el('div', 'row-title', timer.rule), el('div', 'row-meta', timer.about || timer.key)); row.append(text, el('time', 'row-meta', formatTime(timer.at))); return row; });
}
function projectChip(cwd) {
  const full = String(cwd || '').trim();
  const chip = el('span', 'chip', `项目 · ${projectName(full)}`);
  if (full) chip.title = full;
  return chip;
}
export function renderRules(snapshot, rules, models = {}) {
  if (!rules.length) return [el('div', 'empty', '还没有调度规则，点击“新建规则”开始。')];
  return rules.map(rule => {
    const line = (snapshot.lines || []).find(item => item.name === rule.name);
    const status = ruleLineStatus(line);
    const card = el('article', `rule-card${line?.paused ? ' paused' : ''}`); card.dataset.rule = rule.name;
    const top = el('div', 'rule-top'); top.append(el('div', 'rule-name', rule.name), badge(status.label, status.kind));
    const description = el('p', 'rule-description', rule.prompt || '未填写处理说明');
    const meta = el('div', 'rule-meta'); meta.append(el('span', 'chip', scheduleLabel(rule)), projectChip(rule.cwd), el('span', 'chip', `Agent · ${rule.to}`), el('span', 'chip', `模型 · ${models[rule.to] || '未配置'}`), el('span', 'chip', rule.resume ? '续接会话' : '新会话'));
    if (status.detail) meta.append(el('span', 'chip', status.detail));
    const actions = el('div', 'actions');
    actions.append(button('立即运行', 'run', rule.name, 'secondary', !!line?.paused));
    actions.append(button(line?.paused ? '恢复' : '暂停', line?.paused ? 'resume' : 'pause', rule.name, 'secondary'));
    actions.append(button('编辑', 'edit', rule.name, 'secondary'));
    card.append(top, description, meta, actions); return card;
  });
}
function button(text, action, id, style = 'secondary', disabled = false) { const node = el('button', `button ${style}`, text); node.type = 'button'; node.dataset.action = action; node.dataset.id = id; node.disabled = disabled; return node; }
export function renderRuns(snapshot, rules = []) {
  const runs = snapshot.runs || [];
  if (!runs.length) return [el('div', 'empty', '还没有执行轮次。')];
  return runs.map(run => {
    const card = el('article', 'run-card'); const top = el('div', 'run-top'); const title = el('div'); title.append(el('div', 'run-name', `#${run.id} · ${run.rule}`), el('div', 'row-meta', `${run.agent} · ${formatTime(run.createdAt)} · 尝试 ${run.attempts || 0} 次`)); top.append(title, badge(statusLabel(run.state), run.state === 'unknown' ? 'bad' : run.state === 'done' ? 'good' : ''));
    const project = projectForRun(run, rules);
    const summary = el('p', `run-summary${run.error ? ' run-error' : ''}`, `${run.error || run.summary || '这一轮还没有结论。'}`);
    card.append(top, projectChip(project), summary);
    if (run.link && /^(https?:|codex:|claude:)/.test(run.link)) { const link = el('a', 'text-button', '打开原会话'); link.href = run.link; link.rel = 'noreferrer'; card.append(link); }
    if (['claimed', 'queued'].includes(run.state)) { const actions = el('div', 'actions'); actions.append(button('停止这一轮', 'cancel', String(run.id), 'danger')); card.append(actions); }
    return card;
  });
}
function chatBubble(message) {
  const bubble = el('div', `bubble ${message.role === 'user' ? 'user' : 'agent'}`);
  bubble.append(el('div', 'bubble-text', message.text), el('div', 'bubble-time', formatTime(message.at)));
  return bubble;
}
export function renderSchedulingSessions(sessions = []) {
  if (!sessions.length) return [el('div', 'empty', '还没有开启的调度会话。')];
  return sessions.map(session => {
    const card = el('article', 'run-card session-card');
    card.dataset.session = session.id;
    const top = el('div', 'run-top');
    const title = el('div');
    const status = session.statusText || session.status || '未知';
    title.append(
      el('div', 'run-name', `${session.agent || 'Codex ACP'} · ${session.id.slice(0, 8)}`),
      el('div', 'row-meta', `ACP · ${session.sessionId || '未识别'} · ${formatTime(session.createdAt)}${session.stopReason ? ` · ${session.stopReason}` : ''}`),
    );
    top.append(title, badge(status, session.status === 'error' ? 'bad' : session.status === 'idle' ? 'good' : ''));
    const meta = el('div', 'rule-meta');
    const projectChip = el('span', 'chip', `项目 · ${projectName(session.project || '')}`); if (session.project) projectChip.title = session.project;
    meta.append(projectChip, el('span', 'chip', `更新 · ${formatTime(session.updatedAt)}`));
    card.append(top, meta);
    if (session.error) card.append(el('p', 'run-summary run-error', session.error));

    const closed = ['closing', 'closed'].includes(session.status);
    const log = el('div', 'chat-log');
    for (const message of session.messages || []) log.append(chatBubble(message));
    if (session.liveText) {
      const streaming = el('div', 'bubble agent streaming');
      streaming.append(el('div', 'bubble-text', session.liveText), el('div', 'bubble-time', '正在输出…'));
      log.append(streaming);
    }
    if (!(session.messages || []).length && !session.liveText) log.append(el('div', 'empty', session.busy ? 'Agent 正在处理首轮调度分析…' : '还没有对话，发一条消息开始。'));
    card.append(log);

    if (!closed) {
      const form = el('form', 'session-message');
      form.dataset.action = 'session-message'; form.dataset.id = session.id;
      const input = el('textarea'); input.name = 'message'; input.required = true; input.rows = 1; input.dataset.autogrow = '';
      input.placeholder = session.busy ? '排队跟进：本轮结束后自动发送；需要立即介入请点「打断」' : '继续指挥这次调度，例如：现在重点看哪一项？回车发送，Alt/Shift+回车换行';
      input.setAttribute('aria-label', `发消息给会话 ${session.id}`);
      const submit = button('发送', '', '', 'primary');
      submit.type = 'submit';
      form.append(input, submit);
      if (session.busy) form.append(button('打断', 'interrupt-session', session.id, 'danger'));
      card.append(form);
      if (session.queued?.length) {
        const queueList = el('div', 'queue-list');
        queueList.setAttribute('aria-label', '排队消息');
        for (const item of session.queued) {
          const row = el('span', 'queue-item');
          const chip = el('button', 'queue-chip', item.text);
          chip.type = 'button';
          chip.dataset.action = 'queue-steer';
          chip.dataset.id = `${session.id}:${item.id}`;
          chip.title = 'steer in：立即追加发送这条（打断当前轮马上送达）';
          const remove = el('button', 'queue-remove', '×');
          remove.type = 'button';
          remove.dataset.action = 'queue-delete';
          remove.dataset.id = `${session.id}:${item.id}`;
          remove.title = '从队列删除这条消息';
          remove.setAttribute('aria-label', `删除队列消息 ${item.text}`);
          row.append(chip, remove);
          queueList.append(row);
        }
        card.append(queueList);
      }
      const actions = el('div', 'actions');
      actions.append(button('关闭会话', 'close-session', session.id, 'danger'));
      card.append(actions);
    }
    return card;
  });
}
export function renderCards(snapshot, rules = []) {
  const cards = (snapshot.cards || []).filter(card => ['open', 'decided'].includes(card.state));
  if (!cards.length) return [el('div', 'empty', '没有等待您回答的卡片。')];
  return cards.map(card => {
    const box = el('article', 'decision-card'); box.dataset.card = String(card.id); const top = el('div', 'run-top'); top.append(el('div', 'run-name', card.title), badge(statusLabel(card.state), card.state === 'open' ? 'warn' : 'good'));
    const meta = el('div', 'row-meta', `规则 · ${card.rule || '未关联'} · ${formatTime(card.createdAt)}`);
    box.append(top, projectChip(projectForCard(card, rules)), meta, el('p', 'decision-text', card.text || ''));
    if (card.state === 'open') {
      const options = el('div', 'option-list'); (card.options || []).forEach((option, index) => options.append(button(option, 'answer-choice', `${card.id}:${index}`, 'secondary')));
      box.append(options);
      const resolve = button('结案', 'resolve', String(card.id), 'secondary'); box.append(resolve);
      const answer = el('form', 'text-answer'); answer.dataset.action = 'answer-text'; answer.dataset.id = card.id;
      const input = el('textarea'); input.name = 'answer'; input.required = true; input.rows = 1; input.dataset.autogrow = ''; input.placeholder = '输入其他回答，回车发送，Alt/Shift+回车换行'; input.setAttribute('aria-label', `回答 ${card.title}`);
      const submit = button('发送回答', '', '', 'primary'); submit.type = 'submit'; answer.append(input, submit); box.append(answer);
    } else box.append(el('p', 'row-meta', `已选择：${card.choice ?? card.answer ?? '—'}，等待后续执行。`));
    return box;
  });
}

const ARCHIVE_STATUS = { interrupted: ['被重启中断', 'warn'], error: ['异常结束', 'bad'], closed: ['已关闭', ''] };

export function renderArchivedSessions(archived = [], discoveredProjects = []) {
  if (!archived.length) return [el('div', 'empty', '还没有已存档的会话。')];
  const known = new Set(discoveredProjects.map(project => projectName(project.path)));
  return archived.map(record => {
    const card = el('article', 'run-card archived');
    const top = el('div', 'run-top');
    const title = el('div');
    title.append(
      el('div', 'run-name', `${record.agent || 'Codex ACP'} · ${record.id.slice(0, 8)}`),
      el('div', 'row-meta', `${formatTime(record.createdAt)} 开始 · 最后更新 ${formatTime(record.updatedAt)} · 转录 ${record.messages.length} 条${record.truncated ? '（早期已截断）' : ''}`),
    );
    const [label, kind] = ARCHIVE_STATUS[record.endStatus] || ['已存档', ''];
    top.append(title, badge(label, kind));
    const meta = el('div', 'rule-meta');
    meta.append(el('span', 'chip', `项目 · ${projectName(record.project)}`));
    if (record.continuedFrom) meta.append(el('span', 'chip', `继续自 ${record.continuedFrom.slice(0, 8)}`));
    card.append(top, meta);
    const log = el('div', 'chat-log');
    for (const message of record.messages.slice(-6)) log.append(chatBubble(message));
    if (record.messages.length > 6) log.prepend(el('div', 'row-meta', `… 更早 ${record.messages.length - 6} 条（继续时会注入最近 10 轮）`));
    if (!record.messages.length) log.append(el('div', 'empty', '没有对话记录。'));
    card.append(log);
    const actions = el('div', 'actions');
    const canContinue = known.has(projectName(record.project));
    const resume = button(canContinue ? '继续调度' : '项目已不可用', 'continue-session', record.id, 'primary', !canContinue);
    if (!canContinue) resume.title = '该项目已不在已发现的 Git 仓库列表中';
    actions.append(resume);
    card.append(actions, el('div', 'row-meta', '继续 = 新建会话并注入最近 10 轮转录，会启动 Codex 消耗模型额度。'));
    return card;
  });
}

const STATUS_TEXT = { done: '完成', pending: '未开始', dev_dispatched: '开发中', in_progress: '进行中', in_review: '审阅中', review: '审阅中', rework: '返工中', external_in_progress: '外部验证中', blocked: '卡住' };

function countsChips(activity, cardsHere) {
  const chips = el('div', 'row-meta chips-line');
  const cost = typeof activity.cost === 'number' ? `$${activity.cost.toFixed(2)}` : '未上报';
  chips.append(
    el('span', 'chip', `等待重试 ${activity.waiting}`),
    el('span', 'chip', `今日完成 ${activity.doneToday}`),
    el('span', 'chip', `待您处理 ${cardsHere} 张`),
    el('span', 'chip', `今日费用 ${cost}`),
  );
  return chips;
}

// 整条链累计口径与计费优先级契约一致：已上报费用 → Token +「费用未上报」→「暂无用量」。
function chainUsageText(usage) {
  const tokens = (usage.tokens || 0).toLocaleString('en-US');
  if (typeof usage.cost === 'number') return `链累计 · ${tokens} Token · $${usage.cost.toFixed(2)}`;
  if (usage.tokens > 0) return `链累计 · ${tokens} Token · 费用未上报`;
  return '链累计 · 暂无用量';
}

// 项目任务进度：每行一个项目（串行链或有活动但无链文件）。节点段可点击，展开卡显示节点摘要。
export function renderProjectProgress({ chains: rawChains = [], sessions = [], rules = [], snapshot = {}, loadError = false } = {}) {
  const chains = latestChainsByProject(rawChains); // 同一项目多条链只显示最近更新的一条
  const openCards = (snapshot.cards || []).filter(card => card.state === 'open');
  const lines = snapshot.lines || [];
  const rows = [];
  const chainNames = new Set(chains.map(chain => projectName(chain.project)));

  // 有串行状态文件的项目：完整任务条
  for (const chain of chains) {
    rows.push(renderChainRow(chain, sessions, rules, openCards, lines));
  }

  // 有活动但没有链文件的项目：只显示计数行（会话绑定项目 + 有今日活动的规则项目）
  const candidates = new Map();
  for (const session of sessions) { const cwd = String(session.project || '').trim(); if (cwd) candidates.set(projectName(cwd), cwd); }
  for (const rule of rules) { const cwd = String(rule.cwd || '').trim(); if (cwd) candidates.set(projectName(cwd), cwd); }
  for (const [name, cwd] of candidates) {
    if (chainNames.has(name)) continue;
    const activity = projectActivity(cwd, rules, lines);
    if (!(activity.running || activity.waiting || activity.doneToday)) continue;
    const cardsHere = openCards.filter(card => matchesProject(projectForCard(card, rules), cwd)).length;
    const row = el('div', 'list-row');
    row.dataset.chain = name;
    const main = el('div', 'progress-main');
    const head = el('div', 'progress-head');
    head.append(el('span', 'row-title', name), badge('无节点计划', 'warn'));
    const session = sessions.find(item => matchesProject(item.project || '', cwd));
    if (session) head.append(badge(session.statusText || session.status || '未知', session.status === 'error' ? 'bad' : session.status === 'idle' ? 'good' : ''));
    main.append(head, el('div', 'row-meta', '该项目没有节点计划文件，仅显示计数。'), countsChips(activity, cardsHere));
    row.append(main);
    rows.push(row);
  }

  if (!rows.length) return [el('div', 'empty', loadError ? '节点进度读取失败，请刷新重试。' : '还没有节点计划。串行推进编排器写入 *-serial.json 后，这里按项目展示任务进度。')];
  return rows;
}

function renderChainRow(chain, sessions, rules, openCards, lines) {
    const name = projectName(chain.project);
    const row = el('div', 'list-row');
    row.dataset.chain = name;
    const main = el('div', 'progress-main');

    const head = el('div', 'progress-head');
    head.append(el('span', 'row-title', name));
    const session = sessions.find(item => matchesProject(item.project || '', chain.project));
    if (session) head.append(badge(session.statusText || session.status || '未知', session.status === 'error' ? 'bad' : session.status === 'idle' ? 'good' : ''));
    head.append(el('span', 'progress-pct', `${Math.round(chain.percent)}%`));
    main.append(head);

    const track = el('div', 'node-track');
    track.setAttribute('role', 'listbox');
    track.setAttribute('aria-label', `${name} 节点进度`);
    const byId = new Map(chain.nodes.map(node => [node.id, node]));
    for (const id of chain.order) {
      const node = byId.get(id);
      if (!node) continue;
      const seg = el('div', `node-seg ${node.kind} w${Math.min(Math.max(node.weight, 1), 10)}${node.id === chain.current?.id ? ' current' : ''}`);
      seg.dataset.node = node.id;
      seg.dataset.title = node.title;
      seg.dataset.status = STATUS_TEXT[node.status] || node.status || '未知';
      seg.dataset.percent = String(node.percent);
      seg.dataset.summary = node.summary || '';
      if (node.part) seg.dataset.part = node.part;
      if (node.prUrl) seg.dataset.pr = node.prUrl;
      seg.title = `${node.title} · ${STATUS_TEXT[node.status] || node.status}${node.id === chain.current?.id ? ` ${node.percent}%` : ''}`;
      seg.setAttribute('role', 'option');
      seg.tabIndex = 0;
      seg.setAttribute('aria-selected', node.id === chain.current?.id ? 'true' : 'false');
      if (node.id === chain.current?.id && node.percent > 0) {
        const fill = el('progress', 'node-fill');
        fill.max = 100; fill.value = node.percent;
        fill.setAttribute('aria-hidden', 'true');
        seg.append(fill);
      }
      seg.append(el('span', '', node.label));
      track.append(seg);
    }
    main.append(track);

    const pop = el('div', 'node-pop');
    pop.hidden = true;
    main.append(pop);

    if (chain.current) {
      const line = el('div', 'current-line');
      line.append(document.createTextNode('当前：'), el('strong', '', `${chain.current.title} · ${chain.current.part || (STATUS_TEXT[chain.current.status] || chain.current.status)} ${chain.current.percent}%`));
      if (chain.current.summary) line.append(document.createTextNode(` — ${chain.current.summary.length > 80 ? `${chain.current.summary.slice(0, 80)}…` : chain.current.summary}`));
      if (chain.current.prUrl) { const link = el('a', 'pr-link', 'PR'); link.href = chain.current.prUrl; link.rel = 'noreferrer'; line.append(link); }
      main.append(line);
    }

    const activity = projectActivity(chain.project, rules, lines);
    const cardsHere = openCards.filter(card => matchesProject(projectForCard(card, rules), chain.project)).length;
    const chips = countsChips(activity, cardsHere);
    chips.append(el('span', 'chip chain-usage', chainUsageText(chainUsage(chain, rules, lines))));
    main.append(chips);
    row.append(main);
    return row;
}

function runRow(item) {
  const row = el('div', 'list-row');
  const text = el('div');
  const project = el('span', 'chip', `项目 · ${item.projectName || projectName(item.project)}`); if (item.project && item.project !== '未识别') project.title = item.project;
  const metaLine = el('div', 'row-meta'); metaLine.append(project, document.createTextNode(` · ${item.status}${item.attempts ? ` · 第 ${item.attempts} 次` : ''}${item.agent ? ` · 执行 · ${item.agent}` : ''} · 模型 · ${item.model} · ${item.text}`));
  text.append(el('div', 'row-title', `#${item.id} · ${item.rule}`), metaLine);
  if (item.state === 'done' || item.state === 'nothing') text.append(el('div', 'row-meta', `计费 · ${item.billing}`));
  row.append(text);
  return row;
}
export function renderRunSection(items, emptyText) {
  if (!items.length) return [el('div', 'empty', emptyText)];
  return items.map(runRow);
}
// 频限绕行条目：契约要求"等待重试/待调度处理"中显示"绕行中（原模型频限，核实恢复中）"及被拦模型/宿主；
// 核实回归后按正常条目展示，不再出现在这里。
function detourItems(detours, rules) {
  return (detours || []).filter((detour) => detour.status === 'detoured')
    .slice() // 最旧在前 → 最新在前，与总览其他队列一致；展示契约每组最多 5 条
    .sort((a, b) => String(b.blockedAt || '').localeCompare(String(a.blockedAt || '')))
    .slice(0, 5)
    .map((detour) => {
      const blocked = detour.blockedModel ? `${detour.blockedAgent}/${detour.blockedModel}` : detour.blockedAgent;
      const firstRule = detour.rules[0]?.name;
      const project = firstRule ? ruleProject(rules, firstRule) : '';
      return {
        id: detour.id, rule: '频限绕行',
        ...(project ? { project, projectName: projectName(project) } : {}),
        status: '绕行中（原模型频限，核实恢复中）',
        agent: detour.fallbackAgent || '未配置', model: blocked || '未配置', text: detour.evidence || '',
      };
    });
}

export function renderAttention(snapshot, rules = [], agentNames = {}, detours = []) {
  const sections = splitRunSections(snapshot, snapshot.models || {}, new Date(), rules, agentNames);
  return renderRunSection([...detourItems(detours, rules), ...sections.needsAttention], '没有等待调度处理的事。');
}
export function renderWorkSections(snapshot, rules = [], agentNames = {}, detours = []) {
  const sections = splitRunSections(snapshot, snapshot.models || {}, new Date(), rules, agentNames);
  const retrying = [...detourItems(detours, rules), ...sections.retrying];
  return {
    running: renderRunSection(sections.running, '没有正在运行的任务。'),
    retrying: renderRunSection(retrying, '没有等待重试的任务。'),
    doneToday: renderRunSection(sections.doneToday, '今天还没有完成任务。'),
    attention: renderAttention(snapshot, rules, agentNames, detours),
  };
}
