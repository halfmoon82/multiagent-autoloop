import { formatState, formatTime, statusLabel, scheduleLabel, projectName, ruleLineStatus } from './format.mjs';
import { splitRunSections, projectForRun, projectForCard } from './status-sections.mjs';
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
    const top = el('div', 'run-top');
    const title = el('div');
    const status = session.statusText || session.status || '未知';
    title.append(
      el('div', 'run-name', `${session.agent || 'Codex ACP'} · ${session.id.slice(0, 8)}`),
      el('div', 'row-meta', `ACP · ${session.sessionId || '未识别'} · ${formatTime(session.createdAt)}${session.stopReason ? ` · ${session.stopReason}` : ''}`),
    );
    top.append(title, badge(status, session.status === 'error' ? 'bad' : session.status === 'idle' ? 'good' : ''));
    const meta = el('div', 'rule-meta');
    meta.append(el('span', 'chip', `项目 · ${session.project || '未识别'}`), el('span', 'chip', `更新 · ${formatTime(session.updatedAt)}`));
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
      const input = el('input'); input.name = 'message'; input.required = true;
      input.placeholder = session.busy ? 'Agent 正在回复…' : '继续指挥这次调度，例如：现在重点看哪一项？';
      input.disabled = !!session.busy;
      input.setAttribute('aria-label', `发消息给会话 ${session.id}`);
      const submit = button(session.busy ? '等待回复' : '发送', '', '', 'primary');
      submit.type = 'submit'; submit.disabled = !!session.busy;
      form.append(input, submit);
      card.append(form);
      const actions = el('div', 'actions');
      actions.append(button('关闭会话', 'close-session', session.id, 'danger'));
      card.append(actions);
    }
    return card;
  });
}
export function renderCards(snapshot) {
  const cards = (snapshot.cards || []).filter(card => ['open', 'decided'].includes(card.state));
  if (!cards.length) return [el('div', 'empty', '没有等待您回答的卡片。')];
  return cards.map(card => {
    const box = el('article', 'decision-card'); const top = el('div', 'run-top'); top.append(el('div', 'run-name', card.title), badge(statusLabel(card.state), card.state === 'open' ? 'warn' : 'good'));
    box.append(top, el('p', 'decision-text', card.text || ''));
    if (card.state === 'open') {
      const options = el('div', 'option-list'); (card.options || []).forEach((option, index) => options.append(button(option, 'answer-choice', `${card.id}:${index}`, 'secondary')));
      box.append(options);
      const resolve = button('结案', 'resolve', String(card.id), 'secondary'); box.append(resolve);
      const answer = el('form', 'text-answer'); answer.dataset.action = 'answer-text'; answer.dataset.id = card.id;
      const input = el('input'); input.name = 'answer'; input.required = true; input.placeholder = '输入其他回答'; input.setAttribute('aria-label', `回答 ${card.title}`);
      const submit = button('发送回答', '', '', 'primary'); submit.type = 'submit'; answer.append(input, submit); box.append(answer);
    } else box.append(el('p', 'row-meta', `已选择：${card.choice ?? card.answer ?? '—'}，等待后续执行。`));
    return box;
  });
}

function runRow(item) {
  const row = el('div', 'list-row');
  const text = el('div');
  const project = el('span', 'chip', `项目 · ${item.projectName || projectName(item.project)}`); if (item.project && item.project !== '未识别') project.title = item.project;
  const metaLine = el('div', 'row-meta'); metaLine.append(project, document.createTextNode(` · ${item.status}${item.attempts ? ` · 第 ${item.attempts} 次` : ''} · 模型 · ${item.model} · ${item.text}`));
  text.append(el('div', 'row-title', `#${item.id} · ${item.rule}`), metaLine);
  if (item.state === 'done' || item.state === 'nothing') text.append(el('div', 'row-meta', `计费 · ${item.billing}`));
  row.append(text);
  return row;
}
export function renderRunSection(items, emptyText) {
  if (!items.length) return [el('div', 'empty', emptyText)];
  return items.map(runRow);
}
export function renderAttention(snapshot, rules = []) {
  const sections = splitRunSections(snapshot, snapshot.models || {}, new Date(), rules);
  const items = [];
  for (const card of (snapshot.cards || []).filter(card => card.state === 'open').slice(0, 5)) {
    items.push({ id: card.id, rule: card.title, project: projectForCard(card), status: '待调度', text: card.text || card.result || '需要处理', attempts: 0 });
  }
  items.push(...sections.needsAttention);
  return renderRunSection(items.slice(0, 5), '没有等待调度处理的事。');
}
export function renderWorkSections(snapshot, rules = []) {
  const sections = splitRunSections(snapshot, snapshot.models || {}, new Date(), rules);
  return {
    running: renderRunSection(sections.running, '没有正在运行的任务。'),
    retrying: renderRunSection(sections.retrying, '没有等待重试的任务。'),
    doneToday: renderRunSection(sections.doneToday, '今天还没有完成任务。'),
    attention: renderAttention(snapshot, rules),
  };
}
