// DAG 页面控制器：拉取 /api/dag-runs、渲染总览分组/详情/历史，授权确认与取消/释放槽位。
import { renderDagOverview, renderDagDetail, renderDagHistory, isDagActive } from './dag-views.mjs';
import { renderAuthorize, renderPreflight } from './dag-authorize.mjs';
import { stableReplace } from './dom-stable.mjs';

export function initDag({ api, notify, showView, getProjects }) {
  const $ = id => document.getElementById(id);
  const s = { details: [], loaded: false, failed: '', loading: false, selectedRun: '', selectedNode: '', slotNote: {}, historyOpen: false, plan: null, planError: '', preflight: null, preflightError: '', checked: false, submitting: false, created: null, authProject: '' };
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

  function banner() {
    const box = $('dag-state');
    const text = s.failed ? `加载失败：${s.failed}。保留最后成功数据，可点击顶部“刷新”重试；不会把未知当成完成。`
      : !s.loaded ? '加载中：正在读取 DAG 运行…'
      : !s.details.length ? '空状态：当前没有 DAG 运行。从“新建 DAG（执行授权）”开始。' : '';
    box.textContent = text; box.hidden = !text; box.className = `state-banner ${s.failed ? 'error' : s.loaded ? 'empty' : 'loading'}`;
  }
  function renderAll() {
    const active = s.details.filter(d => isDagActive(d.run));
    // 全部走稳定替换：DAG 详情里有大量可复制的契约/摘要文本，轮询重建同样会打散选区
    stableReplace('dag-overview-list', [...renderDagOverview(s.details)]);
    const current = s.details.find(d => d.run.runId === s.selectedRun) || active[0] || s.details[0];
    if (current) s.selectedRun = current.run.runId;
    stableReplace('dag-detail', current ? [renderDagDetail(current, { selectedNode: s.selectedNode, slotNote: s.slotNote })] : []);
    const history = renderDagHistory(s.details); history.querySelector('#dag-history-list').hidden = !s.historyOpen;
    stableReplace('dag-history', [history]);
    banner();
  }
  function renderAuth() {
    stableReplace('authorize-preflight', [renderPreflight(s.preflight, { error: s.preflightError })]);
    stableReplace('authorize-body', [renderAuthorize(s.plan, { checked: s.checked, submitting: s.submitting, error: s.planError, created: s.created, blocked: s.preflight && !s.preflight.checks.every(c => c.ok) ? '接入预检未全部通过，暂不能创建 DAG。' : '' })]);
  }
  function syncProjects() {
    const select = $('authorize-project'); const projects = getProjects();
    const key = projects.map(p => p.path).join('|'); if (select.dataset.key === key) return;
    select.dataset.key = key; const prev = select.value;
    select.replaceChildren(...[['', projects.length ? '选择目标仓库' : '未发现 Git 项目'], ...projects.map(p => [p.path, p.name])].map(([value, label]) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }));
    if (projects.some(p => p.path === prev)) select.value = prev;
  }
  async function refreshDag() {
    syncProjects();
    if (s.loading) return; s.loading = true;
    try {
      const list = await api('/api/dag-runs');
      const details = await Promise.all((list.runs || []).map(run => api(`/api/dag-runs/${encodeURIComponent(run.runId)}`).catch(() => null)));
      s.details = details.filter(Boolean).sort((a, b) => String(b.run.createdAt).localeCompare(String(a.run.createdAt))); s.failed = ''; s.loaded = true;
    } catch (error) { s.failed = error.message; }
    finally { s.loading = false; }
    renderAll();
  }
  async function loadPlan() {
    const project = $('authorize-project').value; const planId = $('authorize-plan').value.trim();
    s.checked = false; s.created = null; s.planError = ''; s.preflightError = '';
    if (!project || !planId) { s.plan = null; s.planError = '请选择项目并填写计划编号'; renderAuth(); return; }
    s.authProject = project;
    const [plan, pre] = await Promise.allSettled([api(`/api/dag-plan?project=${encodeURIComponent(project)}&planId=${encodeURIComponent(planId)}`), api(`/api/dag-preflight?project=${encodeURIComponent(project)}`)]);
    if (plan.status === 'fulfilled') s.plan = plan.value; else { s.plan = null; s.planError = plan.reason.message; }
    if (pre.status === 'fulfilled') s.preflight = pre.value; else { s.preflight = null; s.preflightError = pre.reason.message; }
    renderAuth();
  }
  async function authorize() {
    if (!s.plan || !s.checked || s.submitting) return;
    s.submitting = true; s.planError = ''; renderAuth();
    try {
      s.created = await post('/api/dag-runs', { project: s.plan.project, planId: s.plan.planId, planDigest: s.plan.planDigest, confirm: true, confirmedActionIds: s.plan.allowedActions });
      notify('已创建 DAG，授权快照由服务端生成。'); s.selectedRun = s.created.runId; await refreshDag(); showView('dag');
    } catch (error) { s.planError = error.message; }
    finally { s.submitting = false; renderAuth(); }
  }
  document.addEventListener('click', async event => {
    const t = event.target; const find = sel => t.closest?.(sel);
    try {
      let hit;
      if ((hit = find('[data-dag-node]'))) { s.selectedRun = hit.dataset.dagRun || s.selectedRun; s.selectedNode = hit.dataset.dagNode; renderAll(); if (hit.closest('#view-overview')) showView('dag'); return; }
      if ((hit = find('[data-dag-open]'))) { s.selectedRun = hit.dataset.dagOpen; s.selectedNode = ''; renderAll(); showView('dag'); return; }
      if (find('[data-dag-history-toggle]')) { s.historyOpen = !s.historyOpen; renderAll(); return; }
      if ((hit = find('[data-dag-cancel]'))) {
        if (!confirm('取消 DAG 运行？将先等待节点 run 终态，再由控制器按证据释放槽位。')) return;
        hit.disabled = true; await post(`/api/dag-runs/${encodeURIComponent(hit.dataset.dagCancel)}/cancel`); notify('已请求取消，等待节点 run 终态。'); await refreshDag(); return;
      }
      if ((hit = find('[data-slot-release]'))) {
        const slot = hit.dataset.slotRelease; const verified = document.querySelector(`[data-slot-verify="${CSS.escape(slot)}"]`)?.checked === true;
        try { await post(`/api/dag-runs/${encodeURIComponent(hit.dataset.dagRun)}/slots/${encodeURIComponent(slot)}/slot-release`, { processGroupVerified: verified }); s.slotNote[slot] = '槽位已释放。'; }
        catch (error) { s.slotNote[slot] = `释放被拒绝：${error.message}`; }
        await refreshDag(); return;
      }
      if (find('#dag-new')) { showView('authorize'); return; }
      if (find('#authorize-load')) { await loadPlan(); return; }
      if (find('[data-dag-authorize]')) { await authorize(); }
    } catch (error) { notify(error.message); }
  });
  document.addEventListener('change', event => { if (event.target.id === 'authorize-check') { s.checked = event.target.checked; renderAuth(); } });
  renderAuth(); renderAll();
  return { refreshDag };
}
