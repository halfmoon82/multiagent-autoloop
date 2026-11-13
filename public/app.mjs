import { openRuleForm } from './rule-form.mjs';
import { renderSummary, renderAttention, renderEnvironment, renderTimers, renderRules, renderRuns, renderCards, renderWorkSections } from './views.mjs';
import { el } from './views.mjs';
const state = { snapshot: null, rules: [], view: 'overview', loading: false };
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
    const [snapshot, ruleData] = await Promise.all([api('/api/state'), api('/api/rules')]);
    snapshot.models = state.models || {}; state.snapshot = snapshot; state.rules = ruleData.rules || []; state.agents = ruleData.agents || []; state.sources = ruleData.sources || []; state.models = ruleData.models || {}; setConnection(true, '已连接'); showNotice(''); render();
  } catch (error) { setConnection(false, '连接失败'); showNotice(`无法更新：${error.message}`); }
  finally { state.loading = false; }
}
function render() {
  if (!state.snapshot) return;
  const draftAnswers = Object.fromEntries([...document.querySelectorAll('form[data-action="answer-text"]')].map(form => [form.dataset.id, form.elements.answer.value]));
  replace('summary', renderSummary(state.snapshot));
  const work = renderWorkSections(state.snapshot);
  replace('running-list', work.running); replace('retrying-list', work.retrying); replace('done-list', work.doneToday); replace('attention-list', work.attention); replace('environment-list', renderEnvironment(state.snapshot)); replace('timer-list', renderTimers(state.snapshot));
  replace('rules-list', renderRules(state.snapshot, state.rules, state.models)); replace('runs-list', renderRuns(state.snapshot)); replace('cards-list', renderCards(state.snapshot));
  document.querySelectorAll('form[data-action="answer-text"]').forEach(form => { if (draftAnswers[form.dataset.id] !== undefined) form.elements.answer.value = draftAnswers[form.dataset.id]; });
  const count = state.snapshot.cards?.filter(card => card.state === 'open').length || 0; $('card-count').textContent = String(count); $('card-count').hidden = !count;
}
function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== `view-${name}`; });
  document.querySelectorAll('.nav-item').forEach(item => { const active = item.dataset.view === name; item.classList.toggle('active', active); if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
}
document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => showView(item.dataset.view)));
document.querySelectorAll('[data-go]').forEach(item => item.addEventListener('click', () => showView(item.dataset.go)));
async function perform(action, id, body = {}) {
  const paths = { resolve: `/api/cards/${id}/resolve`, run: `/api/rules/${encodeURIComponent(id)}/run`, pause: `/api/rules/${encodeURIComponent(id)}/pause`, resume: `/api/rules/${encodeURIComponent(id)}/resume`, cancel: `/api/runs/${id}/cancel` };
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
    if (action === 'edit') { const rule = state.rules.find(item => item.name === id); openRuleForm({ rule, agents: state.agents, sources: state.sources, api, onSaved: refresh }); return; }
    if (action === 'answer-choice') { const split = id.lastIndexOf(':'); await api(`/api/cards/${id.slice(0, split)}/answer`, { method: 'POST', body: JSON.stringify({ choice: Number(id.slice(split + 1)) }) }); showNotice('回答已提交，任务将继续。'); await refresh(); return; }
    const body = ['pause', 'resolve'].includes(action) ? { reason: prompt(action === 'pause' ? '暂停原因（可留空）' : '结案说明') || '' } : {};
    await perform(action, id, body);
  } catch (error) { showNotice(error.message); } finally { button.disabled = false; }
});
document.addEventListener('submit', async event => {
  const form = event.target.closest('form[data-action="answer-text"]'); if (!form) return; event.preventDefault();
  const input = form.elements.answer;
  try { await api(`/api/cards/${form.dataset.id}/answer`, { method: 'POST', body: JSON.stringify({ text: input.value }) }); input.value = ''; showNotice('回答已提交，任务将继续。'); await refresh(); }
  catch (error) { showNotice(error.message); }
});
$('new-rule').addEventListener('click', () => openRuleForm({ agents: state.agents, sources: state.sources, api, onSaved: refresh }));
$('refresh').addEventListener('click', refresh);
setInterval(refresh, 5000);
refresh();
