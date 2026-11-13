import { formatState, formatTime, statusLabel, scheduleLabel } from './format.mjs';
import { splitRunSections } from './status-sections.mjs';
export function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function empty(container, text) { container.replaceChildren(el('div', 'empty', text)); }
function badge(text, kind = '') { return el('span', `status ${kind}`, text); }
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
export function renderRules(snapshot, rules, models = {}) {
  if (!rules.length) return [el('div', 'empty', '还没有调度规则，点击“新建规则”开始。')];
  return rules.map(rule => {
    const line = (snapshot.lines || []).find(item => item.name === rule.name);
    const card = el('article', `rule-card${line?.paused ? ' paused' : ''}`); card.dataset.rule = rule.name;
    const top = el('div', 'rule-top'); top.append(el('div', 'rule-name', rule.name), badge(line?.paused ? '已暂停' : '运行中', line?.paused ? 'warn' : 'good'));
    const description = el('p', 'rule-description', rule.prompt || '未填写处理说明');
    const meta = el('div', 'rule-meta'); meta.append(el('span', 'chip', scheduleLabel(rule)), el('span', 'chip', `Agent · ${rule.to}`), el('span', 'chip', `模型 · ${models[rule.to] || '未配置'}`), el('span', 'chip', rule.resume ? '续接会话' : '新会话'));
    const actions = el('div', 'actions');
    actions.append(button('立即运行', 'run', rule.name, 'secondary', !!line?.paused));
    actions.append(button(line?.paused ? '恢复' : '暂停', line?.paused ? 'resume' : 'pause', rule.name, 'secondary'));
    actions.append(button('编辑', 'edit', rule.name, 'secondary'));
    card.append(top, description, meta, actions); return card;
  });
}
function button(text, action, id, style = 'secondary', disabled = false) { const node = el('button', `button ${style}`, text); node.type = 'button'; node.dataset.action = action; node.dataset.id = id; node.disabled = disabled; return node; }
export function renderRuns(snapshot) {
  const runs = snapshot.runs || [];
  if (!runs.length) return [el('div', 'empty', '还没有执行轮次。')];
  return runs.map(run => {
    const card = el('article', 'run-card'); const top = el('div', 'run-top'); const title = el('div'); title.append(el('div', 'run-name', `#${run.id} · ${run.rule}`), el('div', 'row-meta', `${run.agent} · ${formatTime(run.createdAt)} · 尝试 ${run.attempts || 0} 次`)); top.append(title, badge(statusLabel(run.state), run.state === 'unknown' ? 'bad' : run.state === 'done' ? 'good' : ''));
    const summary = el('p', `run-summary${run.error ? ' run-error' : ''}`, run.error || run.summary || '这一轮还没有结论。');
    card.append(top, summary);
    if (run.link && /^(https?:|codex:|claude:)/.test(run.link)) { const link = el('a', 'text-button', '打开原会话'); link.href = run.link; link.rel = 'noreferrer'; card.append(link); }
    if (['claimed', 'queued'].includes(run.state)) { const actions = el('div', 'actions'); actions.append(button('停止这一轮', 'cancel', String(run.id), 'danger')); card.append(actions); }
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
  text.append(el('div', 'row-title', `#${item.id} · ${item.rule}`), el('div', 'row-meta', `${item.status}${item.attempts ? ` · 第 ${item.attempts} 次` : ''} · 模型 · ${item.model} · ${item.text}`));
  if (item.state === 'done' || item.state === 'nothing') text.append(el('div', 'row-meta', `计费 · ${item.billing}`));
  row.append(text);
  return row;
}
export function renderRunSection(items, emptyText) {
  if (!items.length) return [el('div', 'empty', emptyText)];
  return items.map(runRow);
}
export function renderAttention(snapshot) {
  const sections = splitRunSections(snapshot, snapshot.models || {});
  const items = [];
  for (const card of (snapshot.cards || []).filter(card => card.state === 'open').slice(0, 5)) {
    items.push({ id: card.id, rule: card.title, status: '待调度', text: card.text || card.result || '需要处理', attempts: 0 });
  }
  items.push(...sections.needsAttention);
  return renderRunSection(items.slice(0, 5), '没有等待调度处理的事。');
}
export function renderWorkSections(snapshot) {
  const sections = splitRunSections(snapshot, snapshot.models || {});
  return {
    running: renderRunSection(sections.running, '没有正在运行的任务。'),
    retrying: renderRunSection(sections.retrying, '没有等待重试的任务。'),
    doneToday: renderRunSection(sections.doneToday, '今天还没有完成任务。'),
    attention: renderAttention(snapshot),
  };
}
