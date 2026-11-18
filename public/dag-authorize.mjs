// 执行授权范围确认页与接入预检页：逐项展示范围，确认后才可创建 DAG。上游文本只走 textContent。
import { el } from './views.mjs';
import { projectName } from './format.mjs';

export const ACTION_LABELS = {
  worktree: ['独立 worktree', '固定槽位，互不写入，主 checkout 只读'],
  'run-tests': ['离线测试', 'verify 使用固定命令，不执行依赖安装脚本'],
  'push-branch': ['推送分支', '只推送到本项目的 DAG 分支'],
  'create-pr': ['创建 PR', '每个节点一个 PR'],
  'independent-review': ['独立审阅', '审阅同一 commit，P0–P2 必须清零'],
  'rework-p0-p2': ['P0–P2 返工', '三次未收敛先换打法，再决定是否升级'],
  'squash-merge': ['审阅通过后 squash 合并', '远端 head 必须等于已审 commit'],
  'close-superseded-pr': ['替代旧 attempt 的 PR', '仅关闭本 DAG 登记的 PR 并附说明'],
};
export const DENIED_LABELS = { deploy: '部署', release: '发布', 'production-write': '生产数据写入', credentials: '新建或读取其他凭据', 'external-communication': '对外通信' };

export function renderPreflight(data, { loading = false, error = '' } = {}) {
  const root = el('div', 'preflight-layout');
  const panel = el('section', 'panel checklist-panel');
  const head = el('div', 'panel-heading'); const passed = (data?.checks || []).filter(c => c.ok).length; const total = (data?.checks || []).length;
  head.append(el('div', '', '环境与权限'), el('span', `status ${total && passed === total ? 'good' : 'warn'}`, data ? `${passed} / ${total} 项通过` : (loading ? '检查中…' : '未检查')));
  panel.append(head);
  if (error) panel.append(el('div', 'empty', `检查失败：${error}。保留上次结果，可重试；未知不当成通过。`));
  if (!data && !error) panel.append(el('div', 'empty', loading ? '正在读取项目状态…' : '选择项目后开始检查。'));
  for (const check of data?.checks || []) {
    const row = el('div', `preflight-row ${check.ok ? 'good' : 'warn'}`);
    const body = el('div'); body.append(el('strong', '', check.label), el('p', '', check.message));
    row.append(el('span', 'check-icon', check.ok ? '✓' : '!'), body, el('span', `status ${check.ok ? 'good' : 'warn'}`, check.ok ? '通过' : '需处理'));
    panel.append(row);
  }
  root.append(panel);
  const side = el('aside', 'preflight-sidebar'); const note = el('section', 'panel side-card');
  note.append(el('div', 'panel-heading', ''), el('p', 'side-copy', '这些检查只作参考，不阻止创建与派发；真正的硬约束是授权范围（部署、发布、生产写入、凭据、对外通信永不放行）。'));
  note.firstChild.append(el('h3', '', '说明'));
  side.append(note); root.append(side); return root;
}

export function renderAuthorize(plan, { checked = false, submitting = false, error = '', created = null, blocked = '' } = {}) {
  const root = el('div', 'authorize-layout');
  if (!plan) { root.append(el('div', 'empty', error ? `读取计划失败：${error}` : '输入项目与计划编号并点击“读取计划”，逐项核对后才能创建 DAG。')); return root; }
  const main = el('section', 'panel authorization-main');
  const summary = el('div', 'confirmation-summary');
  const business = plan.nodes.filter(n => !n.integrationReview).length; const review = plan.nodes.length - business;
  for (const [label, value] of [['项目', projectName(plan.project)], ['节点', `${business} 业务${review ? ` + ${review} 整合审查` : ''}`], ['最大并行', `${plan.maxParallel} 路`], ['合并策略', '独立审阅后 squash']]) { const cell = el('div'); cell.append(el('span', '', label), el('strong', '', value)); summary.append(cell); }
  const repo = el('div', 'authorization-section'); repo.append(el('h2', '', '目标仓库')); const repoLine = el('p', 'repo-path'); repoLine.dataset.authRepo = '1'; repoLine.textContent = plan.project;
  const remoteLine = el('p', 'repo-path'); remoteLine.dataset.authRemote = '1'; remoteLine.textContent = plan.remoteUrl || '未发现远端（不能推送）'; repo.append(repoLine, remoteLine);
  const nodes = el('div', 'authorization-section'); nodes.append(el('h2', '', '节点及文件范围'));
  const table = el('div', 'scope-list'); table.setAttribute('role', 'list');
  for (const node of plan.nodes) {
    const row = el('div', 'scope-row'); row.setAttribute('role', 'listitem'); row.dataset.authNode = node.id;
    const files = node.files.length ? node.files.join('、') : '只读审查，无写入';
    row.append(el('strong', '', `第 ${node.wave} 波 · ${node.title}`), el('code', '', files), el('small', '', node.dependsOn.length ? `依赖：${node.dependsOn.join('、')}` : '无依赖，可首批启动'));
    table.append(row);
  }
  nodes.append(table);
  const allowed = el('div', 'authorization-section'); allowed.append(el('h2', '', '本次允许'));
  const grid = el('div', 'permission-grid');
  for (const id of plan.allowedActions) {
    const [title, note] = ACTION_LABELS[id] || [id, ''];
    const label = el('label'); const box = el('input'); box.type = 'checkbox'; box.checked = true; box.disabled = true; box.dataset.actionId = id;
    const text = el('span'); text.append(el('strong', '', title), el('small', '', note)); label.append(box, text); grid.append(label);
  }
  allowed.append(grid);
  const excluded = el('div', 'authorization-section excluded'); excluded.append(el('h2', '', '始终不包含'));
  const tags = el('div', 'excluded-tags');
  for (const id of plan.deniedActions) tags.append(el('span', '', DENIED_LABELS[id] || id));
  tags.append(el('span', '', '修改存量串行链')); excluded.append(tags);
  const digest = el('div', 'authorization-section'); digest.append(el('h2', '', '计划摘要'));
  const box = el('div', 'digest-box'); box.append(el('p', '', `${plan.title} · planId ${plan.planId}`)); const code = el('code', '', plan.planDigest); code.dataset.planDigest = '1'; box.append(code); digest.append(box);
  main.append(summary, repo, nodes, allowed, excluded, digest);
  const side = el('aside', 'authorize-sidebar'); const card = el('section', 'panel confirm-card');
  const ch = el('div', 'panel-heading'); ch.append(el('h3', '', '确认前请阅读')); card.append(ch);
  card.append(el('p', '', '确认后，ready 节点会立即进入 Hub 事件链。每个节点仍需独立审阅，合并不代表部署。'));
  if (blocked) card.append(el('p', 'warn-text', blocked));
  const confirmLabel = el('label', 'confirm-check'); const check = el('input'); check.type = 'checkbox'; check.id = 'authorize-check'; check.checked = checked; confirmLabel.append(check, el('span', '', '我已阅读 PRD、Spec、DAG 和上述执行范围。'));
  const go = el('button', 'button primary full', submitting ? '正在创建…' : '确认并进入事件链'); go.type = 'button'; go.id = 'authorize-button'; go.dataset.dagAuthorize = '1'; go.disabled = !checked || submitting || !!blocked || !!created;
  card.append(confirmLabel, go);
  if (error) card.append(el('p', 'warn-text', error));
  if (created) card.append(el('p', 'side-copy', `已创建 DAG ${created.runId}，授权快照已由服务端写入。`));
  card.append(el('small', 'confirm-footnote', '确认动作与计划摘要一起写入服务端生成的 authorizationSnapshot。'));
  side.append(card); root.append(main, side); return root;
}
