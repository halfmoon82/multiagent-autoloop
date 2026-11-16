const screens = ['overview', 'design', 'dag', 'preflight', 'authorize'];
const titles = { overview: '总览', design: '会话管理', dag: 'DAG 运行', preflight: '接入预检', authorize: '执行范围确认' };
const params = new URLSearchParams(location.search);
let currentScreen = screens.includes(params.get('screen')) ? params.get('screen') : 'overview';
let currentKind = 'design';
let currentSession = 'design-tenant';
let typeOverride = 'auto';
let pendingDelete = null;
let toastTimer;
const stateBanner = document.querySelector('#state-banner');
const stateSelect = document.querySelector('#state-select');
const toast = document.querySelector('#toast');
const newSessionDialog = document.querySelector('#new-session-dialog');
const deleteSessionDialog = document.querySelector('#delete-session-dialog');

function showToast(text) {
  clearTimeout(toastTimer);
  toast.textContent = text;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}

function setScreen(screen, updateUrl = true) {
  if (!screens.includes(screen)) return;
  currentScreen = screen;
  for (const name of screens) document.querySelector(`#screen-${name}`).hidden = name !== screen;
  document.querySelectorAll('.nav-item[data-screen]').forEach(button => {
    button.classList.toggle('active', button.dataset.screen === screen || (screen === 'authorize' && button.dataset.screen === 'design'));
  });
  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set('screen', screen);
    history.replaceState(null, '', url);
  }
  document.title = `${titles[screen]} · Autoloop 并行 DAG 设计稿`;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function setState(state) {
  const messages = {
    normal: '',
    empty: '空状态：当前还没有会话或活跃 DAG。从“新建会话”开始，语义会推荐普通、调度或设计。',
    loading: '加载中：正在读取 Hub 状态与会话存档；已有内容保持可用，不会清空。',
    error: '加载失败：暂时无法读取 Hub。保留最后成功数据，可重试；不会把未知状态当成完成。',
    blocked: '阻塞：发票导出需要您选择 CSV 或 PDF；其他 ready 节点仍继续执行。',
  };
  stateBanner.hidden = state === 'normal';
  stateBanner.className = `state-banner ${state}`;
  stateBanner.textContent = messages[state];
  stateSelect.value = state;
}

const nodeDetails = {
  account: ['账户模型', '已合并', 'dag-slot-1', 'PR #412 已 squash 合并', 'feat/run-01-account', '账户与租户关系迁移，越权访问测试全部通过。', '租户账户关系已迁移并合并，越权测试通过。', 'Codex', 'K3.1 Pro'],
  tenant: ['租户配置', '已合并', 'dag-slot-2', 'PR #415 已 squash 合并', 'feat/run-01-tenant', '租户级配置隔离，未修改既有默认值。', '租户配置隔离已合入基线。', 'Codex', 'K3.1 Pro'],
  billing: ['计费规则', '开发中', 'dag-slot-1', '离线测试 · 12/16', 'feat/run-01-billing', '按租户应用计费规则；越权访问必须拒绝并留下审计记录。', '正在拆分租户计费规则并运行越权测试 12/16。', 'WorkBuddy', 'K3'],
  api: ['账单 API', '独立审阅', 'dag-slot-2', 'PR #418 · 等待 reviewer', 'feat/run-01-api', '账单查询按租户过滤；reviewer 正在审阅同一 commit。', 'Reviewer 正在核对租户过滤与 PR #418。', 'Claude', 'Sonnet 5.5'],
  audit: ['审计日志', '开发中', 'dag-slot-3', '离线测试 · 8/11', 'feat/run-01-audit', '记录越权拒绝与配置变化，不写入真实个人数据。', '正在补齐越权拒绝与配置变化审计记录。', 'Codex', 'K3.1 Pro'],
  invoice: ['发票导出', '等待产品决策', 'dag-slot-4', '未派发 · 等待选择格式', 'feat/run-01-invoice', 'CSV 或 PDF 由产品经理决定；不影响其他 ready 节点。', '等待选择 CSV 或 PDF，暂不派发。', '待派发', '待选择'],
  report: ['汇总报表', '未开始', '待分配', '等待上游 PR 合并', 'feat/run-01-report', '依赖计费规则和账单 API 合并后的基线。', '等待上游合并后的新基线。', '待派发', '待选择'],
  integration: ['整合审查', '未开始', 'dag-baseline', '等待全部业务节点', 'detached 基线', '只读审查完整交付，不包含部署。', '等待业务节点完成后只读整合审查。', '待派发', '独立 Reviewer'],
};

function selectNode(id) {
  const detail = nodeDetails[id];
  if (!detail) return;
  const [title, status, slot, stage, branch, contract, summary, agent, model] = detail;
  const panel = document.querySelector('#node-detail');
  panel.querySelector('h3').textContent = title;
  panel.querySelector('.status').textContent = status;
  const values = panel.querySelectorAll('.fact-list dd');
  values[0].textContent = slot;
  values[1].textContent = stage;
  values[2].textContent = branch;
  document.querySelector('#detail-contract').textContent = contract;
  document.querySelector('#detail-summary').textContent = summary;
  document.querySelector('#detail-agent').textContent = agent;
  document.querySelector('#detail-model').textContent = model;
  document.querySelectorAll('.dag-node').forEach(button => button.classList.toggle('selected', button.dataset.node === id));
}

const sessionData = {
  'design-tenant': {
    kind: 'design', title: '多租户计费拆分', project: 'health-service', created: '今天 10:18', mode: '▣ 计划模式', access: '只读', composer: 'Plan · 只读', footnote: 'Codex 原生 Plan Mode 已核验 · vibe 仅负责 PRD/Spec/DAG 规划与校验',
    messages: [
      ['user', '希望把单租户账单改成多租户，允许三个工作包并行开发，先不要动部署。', '10:18'],
      ['agent', '收到。先确认成功标准：每个租户只能看到自己的账单，计费规则可独立灰度；本期不做发票自动推送，对吗？', '10:19 · 仅读取代码与文档'],
      ['user', '对。发票导出保留手动，权限边界不能变。', '10:20'],
      ['agent', 'PRD 已闭合。建议拆成 7 个节点：账户模型、租户配置先行，计费规则、账单 API、审计日志可并行；发票导出依赖“导出格式”产品决策。', '10:24 · 等待您确认 Spec 与 DAG'],
    ],
  },
  'api-analysis': {
    kind: 'normal', title: '账单 API 依赖分析', project: 'health-service', created: '今天 09:42', mode: '默认模式', access: '无附加提示词', composer: 'Default · 项目工作区', footnote: '普通会话 · 直接在项目工作区创建，不组装调度或设计提示词',
    messages: [
      ['user', '帮我分析账单 API 的依赖，先不要修改文件。', '09:42'],
      ['agent', '账单 API 依赖租户配置、计费规则和权限校验。我画出了调用关系，并标注了三个需要保持稳定的输入边界。', '09:44 · 普通会话'],
    ],
  },
  'css-review': {
    kind: 'normal', title: '控制台样式检查', project: 'multiagent-autoloop', created: '11-15 16:20', mode: '默认模式', access: '无附加提示词', composer: 'Default · 项目工作区', footnote: '普通会话 · 直接在项目工作区创建，不组装调度或设计提示词',
    messages: [['user', '检查移动端卡片间距和横向溢出。', '16:20'], ['agent', '发现两处小屏间距不一致，已按影响范围整理成修改建议。', '16:22']],
  },
  'readme-question': {
    kind: 'normal', title: 'README 安装步骤问答', project: 'vibeguide', created: '11-14 11:05', mode: '默认模式', access: '无附加提示词', composer: 'Default · 项目工作区', footnote: '普通会话 · 直接在项目工作区创建，不组装调度或设计提示词',
    messages: [['user', '初始化和能力登记有什么区别？', '11:05'], ['agent', '初始化建立项目规划目录；能力登记记录真实会话观察到的平台能力，两者不能互相替代。', '11:06']],
  },
  'scheduler-v6': {
    kind: 'scheduling', title: 'V6 调度与恢复', project: 'vibeguide', created: '今天 08:30', mode: '调度协议', access: '项目协调', composer: 'Default · 调度会话', footnote: '调度会话 · 读取规则、失败原因和卡片，按契约自愈与升级',
    messages: [['user', '继续处理审阅规则的频限绕行。', '08:30'], ['agent', '已读取频限证据和冷却状态。先用最小成本核实原模型是否恢复，不反复全量派发。', '08:31 · 调度诊断']],
  },
  'scheduler-health': {
    kind: 'scheduling', title: '健康服务调度', project: 'health-service', created: '11-13 14:12', mode: '调度协议', access: '项目协调', composer: 'Default · 调度会话', footnote: '调度会话 · 读取规则、失败原因和卡片，按契约自愈与升级',
    messages: [['user', '部署结果不要阻塞开发调度。', '14:12'], ['agent', '已将部署与开发拆成独立事件分支，远端推送失败不会阻止后续开发节点。', '14:15 · 调度诊断']],
  },
};

function renderMessages(data) {
  const container = document.querySelector('#session-messages');
  container.replaceChildren();
  for (const [role, text, time] of data.messages) {
    const article = document.createElement('article');
    article.className = `message ${role}`;
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = role === 'user' ? '您' : 'A';
    const body = document.createElement('div');
    const paragraph = document.createElement('p'); paragraph.textContent = text;
    const stamp = document.createElement('small'); stamp.textContent = time;
    body.append(paragraph, stamp); article.append(avatar, body); container.append(article);
  }
}

function selectSession(id) {
  const data = sessionData[id];
  if (!data) return;
  currentSession = id;
  currentKind = data.kind;
  document.querySelectorAll('.session-item').forEach(item => item.classList.toggle('active', item.dataset.session === id));
  document.querySelector('#session-title').textContent = data.title;
  document.querySelector('#session-mode').textContent = data.mode;
  document.querySelector('#session-access').textContent = data.access;
  document.querySelector('#session-project').textContent = `${data.project} · ${data.kind === 'design' ? '设计会话' : data.kind === 'scheduling' ? '调度会话' : '普通会话'} · ${data.created} 创建`;
  document.querySelector('#composer-context').textContent = data.project;
  document.querySelector('#composer-mode').textContent = data.composer;
  document.querySelector('#session-footnote').textContent = data.footnote;
  document.querySelector('#design-input').placeholder = data.kind === 'design' ? '继续补充产品要求…' : data.kind === 'scheduling' ? '继续调度诊断或协调…' : '向 Codex 发送消息…';
  document.querySelector('#design-session-progress').hidden = data.kind !== 'design';
  renderMessages(data);
}

function selectKind(kind) {
  currentKind = kind;
  document.querySelectorAll('.session-kind-tabs button').forEach(button => button.classList.toggle('active', button.dataset.kind === kind));
  document.querySelectorAll('.session-item').forEach(item => { item.hidden = item.dataset.kind !== kind; });
  const visible = [...document.querySelectorAll('.session-item')].find(item => !item.hidden);
  if (visible) selectSession(visible.dataset.session);
}

function classifyRequest(text) {
  const value = text.trim();
  if (!value) return null;
  if (/调度|失败任务|规则|重试|频限|自愈|恢复规则|卡片/.test(value)) return { kind: 'scheduling', title: '调度会话', icon: '↻', reason: '意图是读取状态、诊断失败或恢复规则，沿用现有调度协议。', contract: '调度会话：保留现有调度提示词与 Hub 状态工具，负责协调、自愈和最小升级。' };
  if (/设计|规划|PRD|新功能|改造|多租户|并行|拆解|复杂/.test(value) || value.length > 45) return { kind: 'design', title: '设计会话', icon: '▣', reason: '涉及跨模块新能力或产品取舍，需要先形成 PRD、Spec 与 DAG。', contract: '设计会话：原生 Plan Mode + read-only；服务端 vibe 负责 PRD/Spec/DAG 校验。' };
  return { kind: 'normal', title: '普通会话', icon: '○', reason: '单次问答、分析或普通开发，不需要调度协调或 PRD 引导。', contract: '普通会话：直接创建于项目工作区，不组装额外提示词。' };
}

function updateClassification() {
  const text = document.querySelector('#new-session-request').value;
  const result = classifyRequest(text);
  const kind = typeOverride === 'auto' ? result?.kind : typeOverride;
  const labels = {
    normal: ['○', '普通会话', '单次问答、分析或普通开发，不需要调度协调或 PRD 引导。', '普通会话：直接创建于项目工作区，不组装额外提示词。'],
    scheduling: ['↻', '调度会话', '目标是诊断与恢复调度，沿用现有调度协议。', '调度会话：保留现有调度提示词与 Hub 状态工具。'],
    design: ['▣', '设计会话', '复杂产品或跨模块工作，先形成 PRD、Spec 与 DAG。', '设计会话：原生 Plan Mode + read-only； vibe 负责规划校验。'],
  };
  document.querySelector('[data-action="create-session"]').disabled = !text.trim();
  if (!text.trim() && typeOverride === 'auto') {
    document.querySelector('#classification-icon').textContent = '○';
    document.querySelector('#classification-title').textContent = '等待输入';
    document.querySelector('#classification-reason').textContent = '普通问答/分析、调度协调、复杂 PRD 设计会进入不同会话协议。';
    document.querySelector('#classification-contract').textContent = '普通会话：直接创建于项目工作区，不组装额外提示词。';
    return;
  }
  const selected = labels[kind || 'normal'];
  document.querySelector('#classification-icon').textContent = selected[0];
  document.querySelector('#classification-title').textContent = `${selected[1]}${typeOverride === 'auto' ? ' · 推荐' : ' · 手动指定'}`;
  document.querySelector('#classification-reason').textContent = typeOverride === 'auto' ? result.reason : selected[2];
  document.querySelector('#classification-contract').textContent = selected[3];
}

function openNewSession() {
  setScreen('design');
  newSessionDialog.showModal();
}

document.addEventListener('click', event => {
  const kindButton = event.target.closest('[data-kind]');
  if (kindButton && kindButton.classList.contains('session-kind-tabs')) return;
  if (kindButton && kindButton.matches('.session-kind-tabs button')) { selectKind(kindButton.dataset.kind); return; }
  const sessionButton = event.target.closest('.session-select[data-session]');
  if (sessionButton) { selectSession(sessionButton.dataset.session); return; }
  const overrideButton = event.target.closest('[data-type-override]');
  if (overrideButton) {
    typeOverride = overrideButton.dataset.typeOverride;
    document.querySelectorAll('[data-type-override]').forEach(button => button.classList.toggle('active', button === overrideButton));
    updateClassification(); return;
  }
  const screenButton = event.target.closest('[data-screen]');
  if (screenButton) { event.preventDefault(); setScreen(screenButton.dataset.screen); return; }
  const nodeButton = event.target.closest('[data-node]');
  if (nodeButton) { selectNode(nodeButton.dataset.node); return; }
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  const item = actionButton.closest('.session-item');
  if (action === 'new-session') openNewSession();
  else if (action === 'close-new-session') newSessionDialog.close();
  else if (action === 'refresh') showToast('已刷新设计稿数据（原型交互）');
  else if (action === 'existing') showToast('现有页面保持不变，本原型只展示新增与改动视图');
  else if (action === 'send') showToast('消息已加入当前会话（原型不调用模型）');
  else if (action === 'run-report') showToast('运行报告包含节点证据、WIP 和费用摘要');
  else if (action === 'cancel-run') showToast('取消将先等待 run 终态，再执行 slot-release，不会直接清空槽位');
  else if (action === 'evidence') showToast('证据面板：测试命令、结果、PR 与审阅 commit');
  else if (action === 'attest-help') showToast('请在真实 Codex 会话执行 vibe attest；控制台不会伪造能力记录');
  else if (action === 'cleanup-list') showToast('清理清单仅含已确认的证据、构建和缓存目录，WIP 先保存');
  else if (action === 'finish-preflight') showToast('仍有 1 项能力记录待更新，完成后才可创建 DAG');
  else if (action === 'attach') showToast('附件入口（原型）');
  else if (action === 'session-more') showToast('会话设置与详情（原型）');
  else if (action === 'collapse' && item) item.classList.toggle('collapsed');
  else if ((action === 'archive' || action === 'archive-current')) {
    const target = item || document.querySelector(`.session-item[data-session="${currentSession}"]`);
    if (target) { target.hidden = true; showToast('已归档；转录保留，可从“已归档”恢复'); }
  }
  else if (action === 'toggle-archived') {
    const list = document.querySelector('#archived-list'); list.hidden = !list.hidden;
  }
  else if (action === 'toggle-run-history') {
    const list = document.querySelector('#run-history-list'); list.hidden = !list.hidden;
  }
  else if (action === 'view-history') showToast('历史任务以只读方式查看，永久保留，不自动清理');
  else if (action === 'delete') {
    pendingDelete = item; deleteSessionDialog.showModal();
  }
  else if (action === 'cancel-delete') { pendingDelete = null; deleteSessionDialog.close(); }
  else if (action === 'confirm-delete') {
    if (pendingDelete) pendingDelete.remove();
    pendingDelete = null; deleteSessionDialog.close(); showToast('会话已删除（仅原型状态，未删除真实数据）');
  }
  else if (action === 'create-session') {
    const request = document.querySelector('#new-session-request').value.trim();
    const recommendation = classifyRequest(request);
    const kind = typeOverride === 'auto' ? recommendation?.kind : typeOverride;
    if (!request || !kind) return;
    const project = document.querySelector('#new-session-project').value;
    const id = `new-${Date.now()}`;
    const labels = { normal: '普通会话', scheduling: '调度会话', design: '设计会话' };
    sessionData[id] = {
      kind, title: request.slice(0, 18), project, created: '刚刚', mode: kind === 'design' ? '▣ 计划模式' : kind === 'scheduling' ? '调度协议' : '默认模式',
      access: kind === 'design' ? '只读' : kind === 'scheduling' ? '项目协调' : '无附加提示词', composer: kind === 'design' ? 'Plan · 只读' : 'Default',
      footnote: `${labels[kind]} · 按语义分类创建`, messages: [['user', request, '刚刚']],
    };
    const article = document.createElement('article'); article.className = 'session-item'; article.dataset.kind = kind; article.dataset.session = id;
    article.innerHTML = `<div class="session-item-main"><button class="session-select" data-session="${id}"><strong></strong><span></span><small>刚刚创建</small></button></div><div class="session-item-actions"><button title="折叠会话" data-action="collapse">⌃</button><button title="归档会话" data-action="archive">□</button><button title="删除会话" data-action="delete">×</button></div>`;
    article.querySelector('strong').textContent = request.slice(0, 18);
    article.querySelector('.session-select>span').textContent = `${project} · 11-16`;
    document.querySelector('#session-list').prepend(article);
    newSessionDialog.close();
    selectKind(kind); selectSession(id);
    showToast(`${labels[kind]}已创建（原型）`);
  }
  else if (action === 'authorize') {
    if (!document.querySelector('#authorize-check').checked) return;
    showToast('已记录授权快照并创建 DAG（原型不发送真实事件）');
    setTimeout(() => setScreen('dag'), 500);
  }
});

stateSelect.addEventListener('change', () => setState(stateSelect.value));
document.querySelector('#new-session-request').addEventListener('input', updateClassification);
document.querySelector('#authorize-check').addEventListener('change', event => {
  document.querySelector('#authorize-button').disabled = !event.target.checked;
});

setState(params.get('state') || 'normal');
setScreen(currentScreen, false);
selectKind('design');
selectSession('design-tenant');
if (params.get('newSession') === '1') openNewSession();
