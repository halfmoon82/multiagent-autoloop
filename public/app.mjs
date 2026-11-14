import { openRuleForm } from './rule-form.mjs';
import { renderSummary, renderAttention, renderEnvironment, renderTimers, renderRules, renderRuns, renderCards, renderWorkSections, renderSchedulingSessions, renderSessionProgress } from './views.mjs';
import { projectName } from './format.mjs';
import { projectForRun, projectForCard, matchesProject, collectProjects, scopedTotals, scopedSpending, timersForProject } from './status-sections.mjs';
import { el } from './views.mjs';
const state = { snapshot: null, rules: [], sessions: [], projects: [], view: 'overview', loading: false, projectFilter: '', skipPinOnce: null };
const $ = id => document.getElementById(id);
function replace(id, nodes) { $(id).replaceChildren(...nodes); }
function showNotice(text) { const box = $('notice'); box.textContent = text; box.hidden = !text; }
function setConnection(online, text) { const node = $('connection'); node.className = `connection ${online ? 'online' : 'offline'}`; node.replaceChildren(el('span', 'dot'), document.createTextNode(text)); }
export async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json', 'x-console-request': '1' } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
export async function refresh() {
  if (state.loading) return; state.loading = true;
  try {
    const [snapshot, ruleData, sessions, projectData] = await Promise.all([api('/api/state'), api('/api/rules'), api('/api/scheduling-sessions'), api('/api/projects')]);
    snapshot.models = state.models || {}; state.snapshot = snapshot; state.rules = ruleData.rules || []; state.sessions = sessions || []; state.projects = projectData.projects || []; state.agents = ruleData.agents || []; state.sources = ruleData.sources || []; state.models = ruleData.models || {}; setConnection(true, '已连接'); showNotice(''); render();
  } catch (error) { setConnection(false, '连接失败'); showNotice(`无法更新：${error.message}`); }
  finally { state.loading = false; }
}
function projectView() {
  const filter = state.projectFilter;
  if (!filter) return { snapshot: state.snapshot, rules: state.rules, sessions: state.sessions };
  return {
    snapshot: {
      ...state.snapshot,
      runs: (state.snapshot.runs || []).filter(run => matchesProject(projectForRun(run, state.rules), filter)),
      cards: (state.snapshot.cards || []).filter(card => matchesProject(projectForCard(card), filter)),
    },
    rules: state.rules.filter(rule => matchesProject(rule.cwd, filter)),
    sessions: state.sessions.filter(session => matchesProject(session.project, filter)),
  };
}

function syncProjectFilter() {
  const select = $('project-filter');
  const projects = collectProjects({ rules: state.rules, runs: state.snapshot.runs || [], cards: state.snapshot.cards || [], sessions: state.sessions });
  const byKey = new Map();
  for (const project of projects) {
    const key = projectName(project);
    if (!byKey.has(key)) byKey.set(key, project);
  }
  if (state.projectFilter && !byKey.has(state.projectFilter)) state.projectFilter = '';
  const entries = [['', '全部项目', ''], ...[...byKey.entries()].map(([key, raw]) => [key, key, raw])];
  select.replaceChildren(...entries.map(([value, label, title]) => {
    const option = el('option', '', label); option.value = value; if (title && title !== label) option.title = title; return option;
  }));
  select.value = state.projectFilter;
  $('clear-project-filter').hidden = !state.projectFilter;
  const projectSelect = $('session-project');
  const projectsKey = state.projects.map(project => `${project.name}${project.path}`).join('|');
  if (projectsKey !== state.projectsKey) {
    state.projectsKey = projectsKey;
    const previousProject = projectSelect.value;
    projectSelect.replaceChildren(...[['', state.projects.length ? '选择被调度的项目' : '未发现 Git 项目（配置 AUTOLOOP_PROJECT_ROOTS）'], ...state.projects.map(project => [project.path, project.name])].map(([value, label]) => { const option = el('option', '', label); option.value = value; if (value) option.title = value; return option; }));
    if (state.projects.some(project => project.path === previousProject)) projectSelect.value = previousProject;
  }
}

// 后台刷新每 2 秒整棵重建卡片树；输入框持有焦点或正在输入法组词时，替换 DOM 节点会打断组词。
// 对持有焦点的卡片整棵复用旧节点（内容暂停更新到失焦或提交为止），其余卡片照常重建。
function replaceKeyedPreserving(containerId, freshNodes, keyAttr, pinnedKey) {
  const list = $(containerId);
  if (!pinnedKey) return list.replaceChildren(...freshNodes);
  const kept = [...list.querySelectorAll(`[data-${keyAttr}]`)].find(node => node.dataset[keyAttr] === pinnedKey);
  if (!kept) return list.replaceChildren(...freshNodes);
  list.replaceChildren(...freshNodes.map(node => node.dataset?.[keyAttr] !== undefined && node.dataset[keyAttr] === pinnedKey ? kept : node));
}

function captureFocus() {
  const active = document.activeElement;
  if (!active || !['INPUT', 'TEXTAREA'].includes(active.tagName) || !active.name || !active.form?.dataset?.action) return null;
  return { action: active.form.dataset.action, id: active.form.dataset.id || '', name: active.name, start: active.selectionStart ?? null, end: active.selectionEnd ?? null, element: active };
}
function restoreFocus(info) {
  if (!info) return;
  const form = [...document.querySelectorAll(`form[data-action="${info.action}"]`)].find(item => (item.dataset.id || '') === info.id);
  const input = form?.elements?.[info.name];
  if (!input) return;
  input.focus({ preventScroll: true });
  if (input === info.element) return;
  if (info.start !== null && typeof input.setSelectionRange === 'function') { try { input.setSelectionRange(info.start, info.end); } catch { /* 非文本控件 */ } }
}

function render() {
  if (!state.snapshot) return;
  const focus = captureFocus();
  const pin = focus && state.skipPinOnce !== focus.id && ['session-message', 'answer-text'].includes(focus.action) ? focus : null;
  state.skipPinOnce = null;
  const view = projectView();
  const draftAnswers = Object.fromEntries([...document.querySelectorAll('form[data-action="answer-text"]')].map(form => [form.dataset.id, form.elements.answer.value]));
  const draftMessages = Object.fromEntries([...document.querySelectorAll('form[data-action="session-message"]')].map(form => [form.dataset.id, form.elements.message.value]));
  const chatScrolls = Object.fromEntries([...document.querySelectorAll('.session-card')].map(card => { if (!card.dataset.session) return null; const log = card.querySelector('.chat-log'); if (!log) return null; return [card.dataset.session, { top: log.scrollTop, atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 40 }]; }).filter(Boolean));
  const filter = state.projectFilter;
  const scoped = scopedTotals(view.snapshot, view.rules, filter);
  const spending = scopedSpending(view.snapshot, view.rules, filter);
  const summarySnapshot = scoped ? { ...view.snapshot, totals: scoped, spending: { today: spending } } : state.snapshot;
  replace('summary', renderSummary(summarySnapshot));
  replace('progress-list', renderSessionProgress(view.sessions, view.rules, view.snapshot));
  const work = renderWorkSections(view.snapshot, view.rules);
  replace('running-list', work.running); replace('retrying-list', work.retrying); replace('done-list', work.doneToday); replace('attention-list', work.attention); replace('environment-list', renderEnvironment(state.snapshot)); replace('timer-list', renderTimers({ ...state.snapshot, timers: timersForProject(state.snapshot.timers || [], state.rules, filter) }));
  replace('rules-list', renderRules(view.snapshot, view.rules, state.models)); replaceKeyedPreserving('sessions-list', renderSchedulingSessions(view.sessions), 'session', pin?.action === 'session-message' ? pin.id : null); replace('runs-list', renderRuns(view.snapshot, view.rules)); replaceKeyedPreserving('cards-list', renderCards(view.snapshot), 'card', pin?.action === 'answer-text' ? pin.id : null);
  syncProjectFilter();
  document.querySelectorAll('form[data-action="answer-text"]').forEach(form => { if (draftAnswers[form.dataset.id] !== undefined && form.elements.answer.value !== draftAnswers[form.dataset.id]) form.elements.answer.value = draftAnswers[form.dataset.id]; });
  document.querySelectorAll('form[data-action="session-message"]').forEach(form => { if (draftMessages[form.dataset.id] !== undefined && form.elements.message.value !== draftMessages[form.dataset.id]) form.elements.message.value = draftMessages[form.dataset.id]; });
  document.querySelectorAll('.session-card').forEach(card => {
    const log = card.querySelector('.chat-log'); if (!log) return;
    const previous = chatScrolls[card.dataset.session];
    if (!previous || previous.atBottom) { log.scrollTop = log.scrollHeight; return; }
    log.scrollTop = Math.min(previous.top, Math.max(log.scrollHeight - log.clientHeight, 0));
  });
  const count = state.snapshot.cards?.filter(card => card.state === 'open').length || 0; $('card-count').textContent = String(count); $('card-count').hidden = !count;
  restoreFocus(focus);
}
function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== `view-${name}`; });
  document.querySelectorAll('.nav-item').forEach(item => { const active = item.dataset.view === name; item.classList.toggle('active', active); if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
}
document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => showView(item.dataset.view)));
document.querySelectorAll('[data-go]').forEach(item => item.addEventListener('click', () => showView(item.dataset.go)));
async function perform(action, id, body = {}) {
  const paths = { resolve: `/api/cards/${id}/resolve`, run: `/api/rules/${encodeURIComponent(id)}/run`, pause: `/api/rules/${encodeURIComponent(id)}/pause`, resume: `/api/rules/${encodeURIComponent(id)}/resume`, cancel: `/api/runs/${id}/cancel`, 'close-session': `/api/scheduling-sessions/${encodeURIComponent(id)}/close` };
  if (!paths[action]) throw new Error('不支持的操作');
  await api(paths[action], { method: 'POST', body: JSON.stringify(body) }); showNotice('操作已完成，正在刷新状态。'); await refresh();
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const { action, id } = button.dataset;
  try {
    button.disabled = true;
    if (action === 'run' && !confirm(`立即运行“${id}”？这会启动对应 Agent，并可能消耗模型额度。`)) return;
    if (action === 'cancel' && !confirm(`确定停止第 ${id} 轮？`)) return;
    if (action === 'close-session' && !confirm(`关闭调度会话“${id}”？`)) return;
    if (action === 'edit') { const rule = state.rules.find(item => item.name === id); openRuleForm({ rule, agents: state.agents, sources: state.sources, api, onSaved: refresh }); return; }
    if (action === 'answer-choice') { const split = id.lastIndexOf(':'); await api(`/api/cards/${id.slice(0, split)}/answer`, { method: 'POST', body: JSON.stringify({ choice: Number(id.slice(split + 1)) }) }); showNotice('回答已提交，任务将继续。'); await refresh(); return; }
    if (action === 'interrupt-session') {
      const form = button.closest('form');
      const text = form?.elements?.message?.value.trim() || '';
      if (text && !confirm(`打断当前回复，立即发送「${text.length > 30 ? `${text.slice(0, 30)}…` : text}」？`)) return;
      if (!text && !confirm('停止本轮调度？已排队的消息会在停止后继续跟进。')) return;
      await api(`/api/scheduling-sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text, interrupt: true }) });
      if (form) form.elements.message.value = '';
      await refresh();
      showNotice(text ? '已打断当前回复，新消息立即送出。' : '已停止本轮，排队消息将继续跟进。');
      return;
    }
    let body = {};
    if (['pause', 'resolve'].includes(action)) {
      const reason = prompt(action === 'pause' ? '暂停原因（可留空）' : '结案说明');
      if (reason === null) return;
      body = { reason };
    }
    await perform(action, id, body);
  } catch (error) { showNotice(error.message); } finally { button.disabled = false; }
});
document.addEventListener('submit', async event => {
  const answerForm = event.target.closest('form[data-action="answer-text"]');
  if (answerForm) {
    event.preventDefault();
    const input = answerForm.elements.answer;
    try { await api(`/api/cards/${answerForm.dataset.id}/answer`, { method: 'POST', body: JSON.stringify({ text: input.value }) }); input.value = ''; state.skipPinOnce = answerForm.dataset.id; showNotice('回答已提交，任务将继续。'); await refresh(); }
    catch (error) { showNotice(error.message); }
    return;
  }
  const chatForm = event.target.closest('form[data-action="session-message"]');
  if (!chatForm) return;
  event.preventDefault();
  const input = chatForm.elements.message;
  const text = input.value;
  try {
    const result = await api(`/api/scheduling-sessions/${encodeURIComponent(chatForm.dataset.id)}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    input.value = '';
    state.skipPinOnce = chatForm.dataset.id;
    const queued = result.queuedCount || 0;
    await refresh();
    showNotice(queued ? `已排队，本轮结束后自动跟进（队列 ${queued} 条）。` : '已发送。');
  }
  catch (error) { showNotice(error.message); }
});
$('new-rule').addEventListener('click', () => openRuleForm({ agents: state.agents, sources: state.sources, api, onSaved: refresh }));
$('start-session').addEventListener('click', async event => {
  const button = event.currentTarget;
  const project = $('session-project').value.trim();
  if (!project) { showNotice('请先从列表选择被调度的项目。'); return; }
  if (!confirm(`为项目 ${project} 开启 Codex 调度会话？这会启动 Codex，并可能消耗模型额度。`)) return;
  button.disabled = true;
  try {
    const session = await api('/api/scheduling-sessions', { method: 'POST', body: JSON.stringify({ project }) });
    showNotice(`调度会话 ${session.id} 已开启。`);
    state.projectFilter = projectName(session.project || '');
    $('session-project').selectedIndex = 0;
    await refresh();
  } catch (error) { showNotice(error.message); }
  finally { button.disabled = false; }
});
$('project-filter').addEventListener('change', event => { state.projectFilter = event.target.value; render(); });
$('clear-project-filter').addEventListener('click', () => { state.projectFilter = ''; render(); });
$('refresh').addEventListener('click', refresh);
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
refresh();
