import { openRuleForm } from './rule-form.mjs';
import { renderSummary, renderAttention, renderEnvironment, renderTimers, renderRules, renderRuns, renderCards, renderWorkSections, renderSchedulingSessions, renderProjectProgress, renderArchivedSessions } from './views.mjs';
import { projectName } from './format.mjs';
import { projectForRun, projectForCard, matchesProject, collectProjects, scopedTotals, scopedSpending, timersForProject } from './status-sections.mjs';
import { el } from './views.mjs';
const state = { snapshot: null, rules: [], sessions: [], projects: [], view: 'overview', loading: false, projectFilter: '', skipPinOnce: null, queueEditing: null };
const $ = id => document.getElementById(id);
function replace(id, nodes) { $(id).replaceChildren(...nodes); }
let noticeError = false;
function showNotice(text) { noticeError = false; const box = $('notice'); box.textContent = text; box.hidden = !text; }
function showErrorNotice(text) { showNotice(text); noticeError = true; }
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
    const [snapshot, ruleData, sessions, projectData, serial, archives, detourData] = await Promise.all([api('/api/state'), api('/api/rules'), api('/api/scheduling-sessions'), api('/api/projects'), api('/api/serial-progress').catch(() => null), api('/api/session-archives').catch(() => ({ sessions: [] })), api('/api/detours').catch(() => ({ detours: [] }))]);
    state.serial = serial || { chains: [] };
    state.archived = archives?.sessions || [];
    state.serialFailed = !serial;
    state.detours = detourData?.detours || []; state.models = ruleData.models || {}; snapshot.models = state.models; state.snapshot = snapshot; state.rules = ruleData.rules || []; state.sessions = sessions || []; state.projects = projectData.projects || []; state.agents = ruleData.agents || []; state.sources = ruleData.sources || []; setConnection(true, '已连接'); if (noticeError) { noticeError = false; showNotice(''); } render();
  } catch (error) { setConnection(false, '连接失败'); showErrorNotice(`无法更新：${error.message}`); }
  finally { state.loading = false; }
}
function projectView() {
  const filter = state.projectFilter;
  if (!filter) return { snapshot: state.snapshot, rules: state.rules, sessions: state.sessions };
  return {
    snapshot: {
      ...state.snapshot,
      runs: (state.snapshot.runs || []).filter(run => matchesProject(projectForRun(run, state.rules), filter)),
      cards: (state.snapshot.cards || []).filter(card => matchesProject(projectForCard(card, state.rules), filter)),
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

// 后台刷新每 2 秒重建列表；输入框持有焦点或正在输入法组词时，整棵替换 DOM 会打断组词。
// 与 React 稳定 key 同理：在替换点直接检查 document.activeElement，对其所在卡片钉住旧节点
// （内容暂停更新到失焦或提交为止），其余卡片照常重建。
// 注意：钉住 ≠ 复用。replaceChildren 会把子节点先全部摘除再插入，同一节点也会经历
// remove+insert，输入法组词照样被杀（2026-11-15 实测验证）。所以这里做原地键控更新：
// 钉住节点全程留在 DOM 里，只增删、移动它的兄弟节点。
function replaceKeyedPreserving(containerId, freshNodes, keyAttr, skipKey) {
  const list = $(containerId);
  const active = document.activeElement;
  let pinned = null;
  // 只有输入框里真有内容（草稿或输入法组词中）才值得钉住；空输入框重建无损失。
  // 否则发送后输入框已清空、焦点仍在，卡片会被无限期冻结，刚发出的消息永远不呈现
  // （2026-11-15 事故：回车发送后消息"消失"，必须点按钮让输入框失焦才刷新）。
  if (active && (active.value || active.isComposing) && ['INPUT', 'TEXTAREA'].includes(active.tagName) && list.contains(active)) {
    const card = active.closest(`[data-${keyAttr}]`);
    if (card && card.dataset[keyAttr] === skipKey) {
      // 提交后本轮：跳过更新，让新消息/新状态立即呈现
      return;
    }
    if (card) {
      const key = card.dataset[keyAttr];
      // 卡片在新数据集中仍存在才钉住；已消失（远程关闭/已结案）则照常替换，避免列表持续冻结过期内容
      if (freshNodes.some(node => node.dataset?.[keyAttr] === key)) pinned = card;
    }
    // 聚焦元素在容器内但不在任何卡片里：pinned 保持 null，照常替换（与旧语义一致）
  }
  if (!pinned) { list.replaceChildren(...freshNodes); return; }
  const pinnedKey = pinned.dataset[keyAttr];
  const ordered = freshNodes.map(node => node.dataset?.[keyAttr] === pinnedKey ? pinned : node);
  const wanted = new Set(ordered);
  // 只摘除真正消失的旧卡片；钉住卡片绝不摘除（摘除即打断输入法组词）
  for (const child of [...list.children]) if (child !== pinned && !wanted.has(child)) child.remove();
  // 自尾向头按目标顺序插入其余节点；insertBefore 只触碰钉住卡片的兄弟节点，不移动钉住卡片本身。
  // 钉住卡片因此可能短暂偏离 API 顺序，失焦或提交后下一轮即恢复正常排序。
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i] === pinned) continue;
    list.insertBefore(ordered[i], list.children[i] ?? null);
  }
}

// 慢请求期间后台刷新（2s 周期）可能已重建卡片，事件处理器捕获的 form/input 引用可能已脱离文档；
// 写操作前按 data-action + data-id 重新查询当前 live 节点（2026-11-15 真机事故：打断退回写到死节点上）
function liveFormInput(action, id, name) {
  const form = document.querySelector(`form[data-action="${action}"][data-id="${CSS.escape(String(id))}"]`);
  return form?.elements?.[name] ?? null;
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
  const view = projectView();
  const draftAnswers = Object.fromEntries([...document.querySelectorAll('form[data-action="answer-text"]')].map(form => [form.dataset.id, form.elements.answer.value]));
  const draftMessages = Object.fromEntries([...document.querySelectorAll('form[data-action="session-message"]')].map(form => [form.dataset.id, form.elements.message.value]));
  const chatScrolls = Object.fromEntries([...document.querySelectorAll('.session-card')].map(card => { if (!card.dataset.session) return null; const log = card.querySelector('.chat-log'); if (!log) return null; return [card.dataset.session, { top: log.scrollTop, atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 40 }]; }).filter(Boolean));
  const filter = state.projectFilter;
  const scoped = scopedTotals(view.snapshot, view.rules, filter);
  const spending = scopedSpending(view.snapshot, view.rules, filter);
  const summarySnapshot = scoped ? { ...view.snapshot, totals: scoped, spending: { today: spending } } : state.snapshot;
  replace('summary', renderSummary(summarySnapshot));
  const openNode = (() => { const pop = document.querySelector('.node-pop:not([hidden])'); if (!pop) return null; const row = pop.closest('.list-row'); const seg = row?.querySelector(`[data-node="${CSS.escape(pop.dataset.for)}"]`); return row?.dataset.chain && seg ? { chain: row.dataset.chain, node: seg.dataset.node } : null; })();
  replace('progress-list', renderProjectProgress({ chains: (state.serial?.chains || []).filter(chain => matchesProject(chain.project, filter)), sessions: view.sessions, rules: view.rules, snapshot: view.snapshot, loadError: !!state.serialFailed }));
  if (openNode) {
    const seg = document.querySelector(`.list-row[data-chain="${CSS.escape(openNode.chain)}"] [data-node="${CSS.escape(openNode.node)}"]`);
    if (seg) openNodePop(seg);
  }
  const work = renderWorkSections(view.snapshot, view.rules, Object.fromEntries((state.agents || []).map(agent => [agent.id, agent.name]).filter(([, name]) => name)), state.detours || []);
  replace('running-list', work.running); replace('retrying-list', work.retrying); replace('done-list', work.doneToday); replace('attention-list', work.attention); replace('environment-list', renderEnvironment(state.snapshot)); replace('timer-list', renderTimers({ ...state.snapshot, timers: timersForProject(state.snapshot.timers || [], state.rules, filter) }));
  replace('rules-list', renderRules(view.snapshot, view.rules, state.models)); replaceKeyedPreserving('sessions-list', renderSchedulingSessions(view.sessions, state.queueEditing), 'session', state.skipPinOnce); replace('archived-sessions-list', renderArchivedSessions((state.archived || []).filter(item => matchesProject(item.project, state.projectFilter)), state.projects)); replace('runs-list', renderRuns(view.snapshot, view.rules)); replaceKeyedPreserving('cards-list', renderCards(view.snapshot, view.rules), 'card', state.skipPinOnce); state.skipPinOnce = null;
  syncProjectFilter();
  document.querySelectorAll('form[data-action="answer-text"]').forEach(form => { if (draftAnswers[form.dataset.id] !== undefined && form.elements.answer.value !== draftAnswers[form.dataset.id]) { form.elements.answer.value = draftAnswers[form.dataset.id]; autoGrow(form.elements.answer); } });
  document.querySelectorAll('form[data-action="session-message"]').forEach(form => { if (draftMessages[form.dataset.id] !== undefined && form.elements.message.value !== draftMessages[form.dataset.id]) { form.elements.message.value = draftMessages[form.dataset.id]; autoGrow(form.elements.message); } });
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
function closeNodePop(except) {
  document.querySelectorAll('.node-pop').forEach(pop => { if (pop !== except) pop.hidden = true; });
}
function openNodePop(seg) {
  const row = seg.closest('.list-row');
  const pop = row?.querySelector('.node-pop');
  if (!pop) return;
  if (!pop.hidden && pop.dataset.for === seg.dataset.node) { pop.hidden = true; return; }
  closeNodePop(pop);
  pop.replaceChildren();
  pop.dataset.for = seg.dataset.node;
  pop.append(el('div', 'node-pop-title', seg.dataset.title || seg.dataset.node));
  pop.append(el('div', 'node-pop-meta', `${seg.dataset.part || seg.dataset.status} · 节点内 ${seg.dataset.percent}%`));
  if (seg.dataset.summary) pop.append(el('div', 'node-pop-summary', seg.dataset.summary));
  else pop.append(el('div', 'node-pop-summary', '暂无进展摘要：节点推进后由开发/审阅上报一句话进展。'));
  if (seg.dataset.pr) { const link = el('a', 'pr-link', '打开 PR'); link.href = seg.dataset.pr; link.rel = 'noreferrer'; pop.append(link); }
  pop.hidden = false;
  row.querySelectorAll('.node-seg').forEach(other => other.setAttribute('aria-selected', other === seg ? 'true' : 'false'));
}
document.addEventListener('click', event => {
  const seg = event.target.closest('.node-seg');
  if (seg) { openNodePop(seg); return; }
  if (!event.target.closest('.node-pop')) closeNodePop();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeNodePop(); return; }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.closest?.('.node-seg')) {
    event.preventDefault();
    openNodePop(event.target.closest('.node-seg'));
  }
});
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
    if (action === 'queue-steer' || action === 'queue-delete') {
      // 队列消息管理（与 Codex 输入体验一致）：steer in = 立即追加发送（打断当前轮马上送达）；
      // 删除 = 从队列移除这条，剩余队列保持顺序
      const split = id.lastIndexOf(':');
      const sessionId = id.slice(0, split); const itemId = id.slice(split + 1);
      if (action === 'queue-steer') {
        await api(`/api/scheduling-sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}/steer`, { method: 'POST', body: JSON.stringify({}) });
        showNotice('已立即送出该队列消息，当前轮已打断。');
      } else {
        await api(`/api/scheduling-sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}`, { method: 'DELETE', body: JSON.stringify({}) });
        showNotice('已删除队列消息。');
      }
      await refresh();
      return;
    }
    if (action === 'continue-session') {
      if (!confirm('继续调度将新建会话、注入该存档最近 10 轮转录，并启动 Codex 消耗模型额度。继续？')) return;
      const resumed = await api(`/api/scheduling-sessions/${encodeURIComponent(id)}/continue`, { method: 'POST', body: JSON.stringify({}) });
      showNotice(`会话 ${resumed.id.slice(0, 8)} 已从存档继续。`);
      state.projectFilter = projectName(resumed.project || '');
      await refresh();
      return;
    }
    if (action === 'interrupt-session') {
      // 与 Codex 原生 Stop 一致：纯停止本轮，队列转暂停；不带草稿文本、不动输入框
      if (!confirm('停止本轮调度？队列将暂停，可编辑消息或点「恢复队列」继续跟进。')) return;
      await api(`/api/scheduling-sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text: '', interrupt: true }) });
      await refresh();
      showNotice('已停止本轮，队列已暂停，可点「恢复队列」继续跟进。');
      return;
    }
    if (action === 'queue-edit') { const split = id.lastIndexOf(':'); state.queueEditing = { sessionId: id.slice(0, split), itemId: id.slice(split + 1) }; render(); return; }
    if (action === 'queue-cancel') { state.queueEditing = null; render(); return; }
    if (action === 'queue-save') {
      const split = id.lastIndexOf(':'); const sessionId = id.slice(0, split); const itemId = id.slice(split + 1);
      const editor = button.closest('.queue-item')?.querySelector('.queue-editor');
      await api(`/api/scheduling-sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}`, { method: 'PUT', body: JSON.stringify({ text: editor?.value ?? '' }) });
      state.queueEditing = null;
      editor?.blur(); // 焦点离开编辑器，避免钉住旧编辑态 DOM，让本轮刷新重建为芯片
      showNotice('已保存排队消息修改。');
      await refresh();
      return;
    }
    if (action === 'queue-move') {
      const dSplit = id.lastIndexOf(':'); const direction = id.slice(dSplit + 1); const rest = id.slice(0, dSplit);
      const split = rest.lastIndexOf(':'); const sessionId = rest.slice(0, split); const itemId = rest.slice(split + 1);
      await api(`/api/scheduling-sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}/move`, { method: 'POST', body: JSON.stringify({ direction }) });
      await refresh();
      return;
    }
    if (action === 'queue-resume') { await api(`/api/scheduling-sessions/${encodeURIComponent(id)}/queue/resume`, { method: 'POST', body: JSON.stringify({}) }); showNotice('队列已恢复，本轮结束后继续跟进。'); await refresh(); return; }
    if (action === 'queue-clear') {
      if (!confirm('清空队列中的全部消息？')) return;
      await api(`/api/scheduling-sessions/${encodeURIComponent(id)}/queue/clear`, { method: 'POST', body: JSON.stringify({}) });
      showNotice('队列已清空。');
      await refresh();
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
// 输入体验与 Codex 对齐：Alt 或 Shift+回车在输入框内换行，其余 Enter 直接发送（输入法组词中的回车除外）。
// 只处理 textarea 自身的回车：焦点在表单内按钮上时保持原生语义（Enter=click，打断还是打断）。
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.target.tagName !== 'TEXTAREA' || event.isComposing) return;
  if (event.target.classList?.contains('queue-editor')) {
    // 行内编辑队列消息（对齐 Codex queue_edit）：Enter 保存，Alt/Shift+Enter 换行
    if (event.altKey || event.shiftKey) return;
    event.preventDefault();
    event.target.closest('.queue-item')?.querySelector('button[data-action="queue-save"]')?.click();
    return;
  }
  const form = event.target.closest?.('form[data-action="answer-text"], form[data-action="session-message"]');
  if (!form) return;
  event.preventDefault();
  // Chrome 不会为 Alt/Shift+Enter 插入换行，需手动在光标处插入
  if (event.altKey || event.shiftKey) { insertNewline(event.target); return; }
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
});
function insertNewline(node) {
  const start = node.selectionStart ?? node.value.length;
  const end = node.selectionEnd ?? node.value.length;
  node.value = `${node.value.slice(0, start)}\n${node.value.slice(end)}`;
  node.selectionStart = node.selectionEnd = start + 1;
  node.dispatchEvent(new Event('input', { bubbles: true })); // 让 autoGrow 跟上
}
function autoGrow(node) {
  if (!node || node.tagName !== 'TEXTAREA') return;
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
}
document.addEventListener('input', event => { if (event.target?.dataset?.autogrow !== undefined) autoGrow(event.target); });
document.addEventListener('submit', async event => {
  const answerForm = event.target.closest('form[data-action="answer-text"]');
  if (answerForm) {
    event.preventDefault();
    const input = answerForm.elements.answer;
    const cardId = answerForm.dataset.id;
    const answerText = input.value;
    try { await api(`/api/cards/${cardId}/answer`, { method: 'POST', body: JSON.stringify({ text: answerText }) }); const liveInput = liveFormInput('answer-text', cardId, 'answer'); if (liveInput && liveInput.value === answerText) { liveInput.value = ''; autoGrow(liveInput); } state.skipPinOnce = cardId; showNotice('回答已提交，任务将继续。'); await refresh(); }
    catch (error) { showNotice(error.message); }
    return;
  }
  const chatForm = event.target.closest('form[data-action="session-message"]');
  if (!chatForm) return;
  event.preventDefault();
  const input = chatForm.elements.message;
  const text = input.value;
  const sessionId = chatForm.dataset.id;
  try {
    const result = await api(`/api/scheduling-sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    const liveInput = liveFormInput('session-message', sessionId, 'message');
    if (liveInput && liveInput.value === text) { liveInput.value = ''; autoGrow(liveInput); } // 发送后仍原样才清空；慢请求期间用户已改内容则不打扰
    state.skipPinOnce = sessionId;
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
