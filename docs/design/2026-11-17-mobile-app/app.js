const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const icons = {
  back: '<path d="m15 18-6-6 6-6"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/>',
  rules: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="14" cy="18" r="2"/>',
  chat: '<path d="M21 12a8 8 0 0 1-8 8H5l-3 2 1-5a9 9 0 1 1 18-5Z"/><path d="M8 11h8M8 15h5"/>',
  runs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cards: '<path d="M7 3h10v4h3v14H4V7h3Z"/><path d="M9 12h6M9 16h4M9 3v4h6V3"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
  send: '<path d="m4 4 17 8-17 8 3-8Z"/><path d="M7 12h14"/>',
  folder: '<path d="M3 7h7l2-3h9v16H3Z"/>', file: '<path d="M6 2h8l4 4v16H6Z"/><path d="M14 2v5h5M9 12h6M9 16h6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M11 19h2"/>',
  check: '<path d="m5 12 4 4L19 6"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>',
  filter: '<path d="M4 5h16M7 12h10M10 19h4"/>', refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M18 12a6 6 0 0 0-11-4L4 12M6 12a6 6 0 0 0 11 4l3-4"/>',
  fingerprint: '<path d="M12 11a2 2 0 0 1 2 2c0 4-1 7-2 9M8 12a4 4 0 0 1 8 0c0 3-.5 5-1 7M5 13a7 7 0 0 1 14 0M7 17c0 2-.5 4-1 5M12 7a6 6 0 0 1 6 6M9 20c1-2 1-4 1-7a2 2 0 0 1 4 0M4 9a9 9 0 0 1 16 0"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>', download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
};
const icon = (name, cls = '') => `<span class="inline-icon ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[name] || icons.chevron}</svg></span>`;
const iconBtn = (name, action, label = name, extra = '') => `<button class="icon-btn ${extra}" type="button" data-action="${action}" aria-label="${label}">${icon(name)}</button>`;
const chip = (text, kind = '') => `<span class="chip ${kind}">${text}</span>`;
const header = (title, subtitle = '', opts = {}) => `<header class="app-header ${opts.border === false ? 'no-border' : ''}"><div class="header-leading">${opts.back ? iconBtn('back', opts.back, '返回') : opts.logo === false ? '' : '<span class="app-logo">A</span>'}<div class="header-copy"><strong>${title}</strong>${subtitle ? `<small>${subtitle}</small>` : ''}</div></div><div class="header-actions">${opts.actions || iconBtn('more', 'more', '更多操作')}</div></header>`;
const nav = (active = 'overview') => `<nav class="bottom-nav" aria-label="主导航">${[
  ['overview','home','总览'],['rules','rules','规则'],['sessions','chat','会话'],['runs','runs','轮次'],['cards','cards','待办']
].map(([id,ic,label]) => `<button type="button" data-nav="${id}" class="${active === id ? 'active' : ''}"><span class="nav-icon">${icon(ic)}</span><span>${label}</span>${id === 'cards' ? '<span class="nav-badge">3</span>' : ''}</button>`).join('')}</nav>`;
const shell = (content, active = 'overview', opts = {}) => `<div class="mobile-shell">${opts.header || header(opts.title || 'Autoloop 控制台', opts.subtitle || '<span class="online-dot"></span>已安全连接', opts.headerOpts || {})}<main class="screen-scroll"><div class="screen-content ${opts.roomy ? 'roomy' : ''}">${projectFilterBar()}${content}</div></main>${opts.noNav ? '' : nav(active)}</div>`;
const section = (title, aside = '') => `<div class="section-heading"><h2>${title}</h2><span>${aside}</span></div>`;
const fileRow = (name, meta, type = 'MD') => `<button class="file-row" type="button" data-action="open-artifact" data-file="${name}"><span class="file-icon ${type === 'HTML' ? 'html' : ''}">${type}</span><span class="file-copy"><strong>${name}</strong><small>${meta}</small></span><span class="file-chevron">›</span></button>`;

const screens = [
  ['overview','总览','今日自动化 · 触屏首页'],
  ['conversation','会话内待回答组','多个问题 · 选择 / 文字 / 语音'],
  ['artifacts','产物浏览器','文件发现 · 搜索 · 阅读位置'],
  ['artifact-preview','产物阅读','Markdown / HTML / 源码'],
  ['sessions','会话列表','类型筛选 · 搜索 · 归档'],
  ['archived-session','已归档会话','只读转录 · 恢复新会话'],
  ['rules','调度规则','运行 / 暂停 / 编辑'],
  ['rule-form','规则表单','触屏编辑 · 原生选择器'],
  ['runs','执行轮次','状态追踪 · 结果摘要'],
  ['cards','待我处理','独立事项 · 保留决策上下文'],
  ['dag','项目 DAG','节点进度 · 完成通知入口'],
  ['authorize','执行授权','范围确认 · 安全边界'],
  ['new-session','新建会话','语义分类 · 语音首轮输入'],
  ['notifications','系统通知','独立待办 · 锁屏直复'],
  ['biometric','生物识别','打开 App / 锁屏直复'],
  ['devices','设备与偏好','多设备绑定 · 通知 · 字体'],
];
let current = 'overview';
let projectFilter = '全部';
let projectSheetOpen = false;
let archivedOpen = false;
let artifactOrigin = 'manager';
let device = 'phone';
let decisionStep = 0;
let selectedOption = '';
let answered = [];
let listening = false;
let voiceText = '';
let notificationReply = false;
let biometricDone = false;
let previewMode = 'rendered';
let toastTimer;
const savedScroll = {};
const drafts = { composer: '', question: '' };


const PROJECTS = ['全部', '移动控制台', '控制台服务端', '熟小麦'];
function projectFilterBar(note = '全局筛选 · 所有 Tab 一致生效') {
  return `<div class="project-filter-bar"><button type="button" data-action="open-project-filter" aria-label="切换当前项目筛选"><span>项目</span><strong>${projectFilter}</strong>${icon('chevron')}</button><small>${note}</small></div>`;
}
function projectContextBar(note = '当前上下文') {
  return `<div class="project-filter-bar context"><button type="button" data-action="open-project-filter" aria-label="切换当前项目筛选"><span>项目</span><strong>${projectFilter}</strong>${icon('chevron')}</button><small>${note}</small></div>`;
}
function projectSheet() {
  if (!projectSheetOpen) return '';
  return `<div class="project-sheet-backdrop" data-action="close-project-filter"></div><section class="project-sheet" role="dialog" aria-label="项目筛选"><header><strong>切换项目</strong><button type="button" data-action="close-project-filter" aria-label="关闭">${icon('close')}</button></header><p>筛选会同步总览、规则、会话、轮次、待办、DAG 与产物。</p><div>${PROJECTS.map(name=>`<button type="button" class="${projectFilter===name?'selected':''}" data-project-option="${name}">${name}${projectFilter===name?icon('check'):''}</button>`).join('')}</div></section>`;
}
function applyProjectFilter(root = $('#app')) {
  if (projectFilter === '全部') { $$('[data-project]', root).forEach(node=>node.classList.remove('is-project-hidden')); return; }
  $$('[data-project]', root).forEach(node=>node.classList.toggle('is-project-hidden', node.dataset.project !== projectFilter));
}
function dagRing(percent, segments, label) {
  const stops = segments.map(seg=>`${seg.color} ${seg.from}% ${seg.to}%`).join(',');
  return `<div class="dag-ring" role="img" aria-label="${label}总进度 ${percent}%，${segments.length} 个节点，颜色表示波次，深浅表示状态"><div style="background:conic-gradient(${stops})"></div><span><strong>${percent}%</strong><small>总进度</small></span></div>`;
}
function dagOverviewCard({project, plan, percent, segments, nodeCount, wave, totalWaves, slots, usage, status}) {
  return `<article class="card dag-card" data-project="${project}"><div class="dag-card-head"><div><strong>${project}</strong><small>${plan} · ${nodeCount} 个节点 · 第 ${wave}/${totalWaves} 波</small></div>${chip(status,'good')}</div><div class="dag-card-body">${dagRing(percent,segments,project)}<div class="dag-wave-map">${segments.slice(0,6).map(seg=>`<div><i style="background:${seg.color}"></i><span>${seg.node}</span><small>${seg.label}</small></div>`).join('')}</div></div><div class="dag-card-meta"><span>${slots}/5 路占用</span><span>${usage}</span><span>只有 PR 合并后下游才启动</span></div><button class="secondary-btn full-btn" data-action="open-dag">查看运行详情</button></article>`;
}
function dagDetailWaves() {
  const waves=[['第 1 波 · 2 个节点','product-spec,product-design',[['PRD 与通知契约','已完成 · 槽位 dag-slot-1','产出契约：移动端产品需求与通知规则','#157a65'],['设计稿与多问题交互','已完成 · 槽位 dag-slot-2','产出契约：高保真设计稿和交互状态','#157a65']]],['第 2 波 · 2 个节点','mobile-shell,notification',[['移动端交互实现设计','审阅中 · 槽位 dag-slot-3','产出契约：触屏与系统字体适配方案','#4f8fb9'],['通知与设备契约','等待中 · 未占用','产出契约：通知、绑定和撤销规则','#d8d2e7']]],['第 3 波 · 1 个节点','integration-review',[['整合审阅','等待中 · 未占用','验收：设计稿、PRD 与通知行为一致','#a99bd0']]]];
  return `<div class="dag-wave-stack">${waves.map(([title,,nodes])=>`<section class="card dag-wave" data-project="移动控制台"><div class="dag-wave-head"><strong>${title}</strong><span>${nodes.some(n=>n[1].includes('审阅中'))?'1 路在途':'已完成'}</span></div>${nodes.map(([name,state,summary,color])=>`<button class="dag-node-card" type="button" data-action="toast" data-message="打开节点契约、槽位、分支、模型、费用与证据"><i style="background:${color}"></i><span><strong>${name}</strong><small>${state}</small><p>${summary}</p></span></button>`).join('')}</section>`).join('')}</div>`;
}

function overview() {
  const mobile=[{node:'PRD 与通知契约',label:'已完成',color:'#157a65',from:0,to:20},{node:'设计稿',label:'已完成',color:'#157a65',from:20,to:40},{node:'移动交互',label:'审阅中',color:'#4f8fb9',from:40,to:60},{node:'通知契约',label:'等待',color:'#d8d2e7',from:60,to:80},{node:'整合审阅',label:'等待',color:'#a99bd0',from:80,to:100}];
  const server=[{node:'接入预检',label:'已完成',color:'#157a65',from:0,to:25},{node:'服务端适配',label:'进行中',color:'#4f8fb9',from:25,to:50},{node:'测试回归',label:'等待',color:'#d8d2e7',from:50,to:75},{node:'整合审阅',label:'等待',color:'#a99bd0',from:75,to:100}];
  return shell(`
    <p class="eyebrow">PILOT OVERVIEW</p><h1 class="page-title">今天的自动化</h1><p class="page-subtitle">看见进展，只处理真正需要你的事。</p>
    <div class="metric-grid">
      <button class="card metric-card" data-nav="runs"><div class="metric-label">正在运行 ${icon('chevron')}</div><div class="metric-value">8</div><div class="metric-note">按当前项目筛选</div></button>
      <button class="card metric-card" data-nav="runs"><div class="metric-label">等待重试 ${icon('chevron')}</div><div class="metric-value">2</div><div class="metric-note">调度方自愈中，无需通知</div></button>
      <button class="card metric-card" data-action="open-dag"><div class="metric-label">今日完成 ${icon('chevron')}</div><div class="metric-value">16</div><div class="metric-note">节点完成通知已开启</div></button>
      <button class="card metric-card attention" data-nav="cards"><div class="metric-label">需要您处理 ${icon('chevron')}</div><div class="metric-value">3</div><div class="metric-note">每项均有独立系统通知</div></button>
    </div>
    ${section('项目 DAG 进度','环形图 · 波次 · 槽位')}
    ${dagOverviewCard({project:'移动控制台',plan:'mobile-app-prd',percent:40,segments:mobile,nodeCount:5,wave:2,totalWaves:3,slots:1,usage:'费用 $1.20 · Token 18,420',status:'运行中'})}
    <div style="height:10px"></div>
    ${dagOverviewCard({project:'控制台服务端',plan:'console-service-plan',percent:25,segments:server,nodeCount:4,wave:2,totalWaves:3,slots:1,usage:'费用 $0.80 · Token 9,120',status:'运行中'})}
    <div class="fold-columns"><div>${section('最近动态','刚刚更新')}<div class="card activity-card" data-project="移动控制台">
      <button class="activity-row full-btn" data-action="go-conversation"><span class="activity-dot amber"></span><span class="activity-copy"><strong>移动控制台需要您的回答</strong><p>Agent 提出了 3 个问题 · 已回答 0 / 3</p></span><span class="activity-time">现在</span></button>
      <button class="activity-row full-btn" data-action="open-dag"><span class="activity-dot"></span><span class="activity-copy"><strong>「设计稿」节点已完成</strong><p>移动控制台 · 已发送独立完成通知</p></span><span class="activity-time">12 分钟</span></button>
    </div></div><div>${section('待调度处理','不升级给您')}<div class="card activity-card" data-project="控制台服务端"><div class="activity-row"><span class="activity-dot"></span><span class="activity-copy"><strong>规则检查完成</strong><p>调度方自行处理 · 不产生手机通知</p></span><span class="activity-time">38 分钟</span></div><div class="activity-row"><span class="activity-dot amber"></span><span class="activity-copy"><strong>依赖脚本自愈中</strong><p>第 1 次重试 · 冷却 30 分钟</p></span><span class="activity-time">45 分钟</span></div></div></div></div>`, 'overview', { roomy: true });
}

function decisionCard() {
  const questions = [
    { title: '移动端首版需要覆盖哪些网络环境？', bg: '远程访问会成为默认使用方式。此回答用于明确连接与登录验收边界，不涉及工程实现选型。', options: [['任意移动网络或外部 Wi‑Fi','无需先连接 VPN；通过安全连接直接访问'],['仅限可信私网','外出时需要先连接 VPN 或私人网络']] },
    { title: '您希望怎样补充这项产品决策？', bg: '可以使用文字或语音。识别结果会先进入可编辑输入框，不会因停顿自动发送。', text: true },
    { title: '节点完成后，通知应呈现什么信息？', bg: '每个节点成功完成时单独通知，点击后回到对应节点的交付详情。', options: [['项目、节点与完成结果（推荐）','保留必要上下文，点击后查看完整交付'],['只显示节点名称','通知更简短，详情进入 App 查看']] },
  ];
  const q = questions[decisionStep];
  return `<div class="decision-group" id="decision-group"><div class="decision-group-head"><div class="decision-group-title"><strong>需要您的回答</strong><span>${answered.length} / 3 已完成</span></div><div class="step-track">${questions.map((_,i)=>`<span class="${i < decisionStep || answered[i] ? 'done' : i === decisionStep ? 'active' : ''}"></span>`).join('')}</div></div>
    ${answered.map((a,i)=>`<details class="answered-card"><summary>问题 ${i+1} · 已回答：${a}</summary><p>回答已提交并接回原 Agent 会话。此处保留只读记录，不重复发送。</p></details>`).join('')}
    ${decisionStep < 3 ? `<div class="decision-question"><span class="question-count">问题 ${decisionStep+1} / 3</span><h3>${q.title}</h3><p class="question-background">${q.bg}</p><button class="context-link" data-action="context">查看 Agent 原话与相关背景 ↗</button>
      ${q.options ? `<div class="option-list">${q.options.map(([title,desc],i)=>`<button type="button" class="option-card ${selectedOption === title ? 'selected' : ''}" data-option="${title}"><strong>${title}${i===0&&decisionStep===2?'<span class="recommendation">推荐</span>':''}</strong><small>${desc}</small></button>`).join('')}</div>` : `<div class="voice-answer"><div class="voice-input-wrap"><textarea id="question-input" aria-label="问题文字或语音回答" placeholder="输入回答，或点击麦克风说话…">${voiceText}</textarea><button class="mic-btn ${listening?'listening':''}" data-action="voice" aria-label="${listening?'停止语音输入':'开始语音输入'}">${icon(listening?'close':'mic')}</button></div>${listening?'<div class="voice-status"><span class="voice-bars"><i></i><i></i><i></i></span>正在聆听 · 再点麦克风完成，文字可编辑</div>':'<div class="voice-status">语音仅转写为文字，确认后才会提交</div>'}</div>`}
      <div class="decision-actions"><button class="text-btn" data-action="other-answer">退回调度处理</button><button class="primary-btn" data-action="submit-answer" ${q.options&&!selectedOption?'disabled':''}>提交并继续 ${icon('chevron')}</button></div></div>` : `<div class="decision-question"><span class="question-count">全部完成</span><h3>3 个问题均已回答</h3><p class="question-background">Agent 已收到回答并继续执行。所有已答内容保留在会话中，可随时展开回看。</p></div>`}</div>`;
}
function conversationMain() {
  return `${header('移动控制台 PRD','设计会话 · Codex · <span class="online-dot"></span>等待您回答',{back:'go-sessions',logo:false,actions:`${iconBtn('file','go-session-artifacts','会话产物')}${iconBtn('more','more','会话操作')}`})}${projectContextBar('会话上下文 · 切换项目将回到会话列表')}<div class="session-tools"><button data-action="session-info">会话详情</button><button data-action="go-session-artifacts">产物 4</button><button data-action="queue">排队消息 2</button></div><main class="screen-scroll conversation-scroll" id="conversation-scroll"><div class="pending-strip"><button data-action="scroll-question">还有 ${3-answered.length} 个问题待回答 · 立即定位</button><span>不会重复通知已答问题</span></div>
    <div class="message user"><div class="message-body"><div class="message-bubble">请把移动端的所有产品决策一次设计齐，具体实施可以分波次。</div><div class="message-time">09:36</div></div></div>
    <div class="message"><span class="agent-avatar">A</span><div class="message-body"><div class="message-bubble">我已经梳理了移动网络、系统通知和折叠屏的边界。还有 3 个产品问题需要您逐项确认，回答会分别接回原任务，不需要重复描述背景。</div><div class="message-time">09:38</div></div></div>
    ${decisionCard()}
    <div class="session-artifact-panel"><div class="panel-heading-lite"><strong>本会话产物</strong><button type="button" data-action="go-session-artifacts">全部 4</button></div><button type="button" data-action="open-session-artifact" data-file="mobile-app-prd.md"><span class="file-icon">MD</span><span><strong>mobile-app-prd.md</strong><small>来自当前任务 · 设计稿确认 · docs/design</small></span><span class="file-chevron">›</span></button><button type="button" data-action="open-session-artifact" data-file="interaction-preview.html"><span class="file-icon HTML">HTML</span><span><strong>interaction-preview.html</strong><small>来自当前任务 · 多问题交互验证 · docs/design</small></span><span class="file-chevron">›</span></button><p>产物直接挂在会话与当前任务下，打开后只读查看，不脱离上下文。</p></div>
    <div class="message"><span class="agent-avatar">A</span><div class="message-body"><div class="message-bubble">您也可以继续补充其他要求。未回答的问题会保留，切换会话或浏览产物不会丢失当前进度。</div></div></div></main>
    <div class="composer-shell"><div class="queue-preview"><span class="queue-chip">排队 1 · 请同步检查折叠屏</span><span class="queue-chip">排队 2 · 字体跟随系统</span></div><div class="composer">${iconBtn('plus','attachment','添加上下文')}<textarea id="composer-input" aria-label="会话输入" placeholder="继续补充，或使用语音…">${drafts.composer}</textarea><button class="icon-btn" data-action="composer-voice" aria-label="语音输入">${icon('mic')}</button><button class="send-btn" data-action="send" aria-label="发送">${icon('send')}</button></div></div>`;
}

function conversation() {
  if (device === 'fold') return `<div class="conversation-layout"><aside class="conversation-sidebar">${sessionSidebar(true)}</aside><section class="conversation-main">${conversationMain()}</section></div>`;
  return `<div class="mobile-shell conversation-shell">${conversationMain()}</div>`;
}
function sessionSidebar(compact = false) {
  const archived=[['折叠屏阅读体验','移动控制台 · 昨天 · 转录 28 条 · 因控制台重启中断'],['旧通知契约讨论','熟小麦 · 11月15日 · 转录 42 条 · 正常关闭']];
  return `<div class="search-box">${icon('search')}<input placeholder="搜索会话" aria-label="搜索会话"></div><div class="tab-rail" style="margin-bottom:11px"><button class="filter-chip">普通 2</button><button class="filter-chip">调度 3</button><button class="filter-chip active">设计 2</button></div><div class="list-stack"><button class="card session-item" data-project="移动控制台" data-action="go-conversation"><div class="item-top"><div class="item-title">移动控制台 PRD</div>${chip('待回答','warn')}</div><div class="item-subtitle">移动控制台 · 刚刚<br>3 个问题待回答 · 产物 4</div></button><button class="card session-item" data-project="控制台服务端" data-action="go-conversation"><div class="item-top"><div class="item-title">控制面现状分析</div>${chip('运行中','good')}</div><div class="item-subtitle">控制台服务端 · 12 分钟前<br>正在整理模块与接口边界</div></button><button class="card session-item" data-project="熟小麦" data-action="go-conversation"><div class="item-top"><div class="item-title">熟小麦客服梳理</div>${chip('已完成','')}</div><div class="item-subtitle">熟小麦 · 昨天<br>已结束，可在归档查看</div></button></div><div class="archived-sessions"><button type="button" data-action="toggle-archived" aria-expanded="${archivedOpen}"><span>已归档与历史</span><strong>2</strong><em>${archivedOpen?'⌃':'⌄'}</em></button>${archivedOpen?`<div>${archived.map(([title,meta])=>`<div class="archived-entry" data-project="${meta.split(' · ')[0]}"><span><strong>${title}</strong><small>${meta}</small></span><div><button type="button" data-action="view-archive">查看</button><button type="button" data-action="restore-archive">继续调度</button></div></div>`).join('')}</div>`:''}</div>`;
}
function sessions() { return shell(`<p class="eyebrow">SESSIONS</p><h1 class="page-title">会话管理</h1><p class="page-subtitle">对话、调度与 PRD 设计，各就其位。</p><button class="primary-btn full-btn" style="margin-top:15px" data-action="new-session">＋ 新建会话</button>${sessionSidebar()}`, 'sessions'); }
function archivedSession() { return shell(`<p class="eyebrow">ARCHIVED SESSION</p><h1 class="page-title">折叠屏阅读体验</h1><p class="page-subtitle">只读转录 · 因控制台重启中断 · 转录 28 条</p><div class="card conversation-shell" style="margin-top:16px"><div class="message"><span class="agent-avatar">A</span><div class="message-body"><div class="message-bubble">上次看到一半的计划：折叠展开时左侧保持会话列表，右侧切换产物或转录。</div><div class="message-time">昨天 18:42</div></div></div><div class="message user"><div class="message-body"><div class="message-bubble">保留阅读位置，恢复后不要回到第一屏。</div><div class="message-time">昨天 18:43</div></div></div><p class="page-subtitle" style="padding:12px 14px">已归档会话只读；恢复会创建新会话并注入最近 10 轮转录，原记录保留。</p></div><button class="primary-btn full-btn" style="margin-top:12px" data-action="restore-archive">继续调度 · 新建会话</button><button class="secondary-btn full-btn" style="margin-top:8px" data-action="go-sessions">返回会话列表</button>`, 'sessions', { header: header('已归档会话','',{back:'go-sessions',logo:false}) }); }

function artifactListPane() {
  return `${header('会话产物','移动控制台 PRD · 4 个文件',{back:'go-conversation',logo:false,actions:iconBtn('search','artifact-search','搜索产物')})}${projectContextBar('产物管理 · 全局与当前会话均可进入')}<main class="screen-scroll"><div class="screen-content"><div class="artifact-summary"><div class="card artifact-stat"><strong>4</strong><span>全部产物</span></div><div class="card artifact-stat"><strong>3</strong><span>Markdown</span></div><div class="card artifact-stat"><strong>1</strong><span>HTML</span></div></div><div class="search-box">${icon('search')}<input placeholder="搜索文件名或路径" aria-label="搜索产物"></div><div class="filter-rail"><button class="filter-chip active">最近更新</button><button class="filter-chip">文档</button><button class="filter-chip">页面</button><button class="filter-chip">按路径</button></div><div class="breadcrumb"><span>移动控制台</span> / <strong>全部产物</strong></div><div class="card file-list" data-project="移动控制台">${fileRow('mobile-app-prd.md','docs/design · 42 KB · 刚刚','MD')}${fileRow('interaction-preview.html','docs/design · 86 KB · 3 分钟前','HTML')}${fileRow('notification-contract.md','docs/spec · 18 KB · 12 分钟前','MD')}${fileRow('research-notes.md','docs/research · 28 KB · 32 分钟前','MD')}</div><p class="page-subtitle" style="margin:14px 4px">文件按最近更新排序。返回会话时恢复之前的阅读位置、草稿和待回答进度。</p></div></main>`;
}
function artifactPreviewPane() {
  const origin = artifactOrigin === 'session' ? '来自会话 · 移动控制台 PRD · 当前任务：设计稿确认' : '产物管理 · docs/design · 42 KB';
  return `${header('mobile-app-prd.md',origin,{back: device==='phone'?(artifactOrigin==='session'?'go-conversation':'go-artifacts'):'',logo:false,actions:`${iconBtn('download','export','导出或分享')}${iconBtn('more','more','更多')}`})}<div class="preview-toolbar"><button class="${previewMode==='rendered'?'active':''}" data-preview="rendered">阅读</button><button class="${previewMode==='source'?'active':''}" data-preview="source">源码</button><button class="${previewMode==='html'?'active':''}" data-preview="html">HTML 沙箱</button></div><main class="screen-scroll">${previewMode==='source'?`<div class="code-view"># Autoloop 移动控制台 PRD\n\n## 1. 产品目标\n\n- 独立移动前端\n- 共用同一后端控制面\n- 系统通知与会话内回答\n\n## 2. 待回答组\n\nAgent 的多个问题以进度组呈现，\n每次聚焦一个问题。</div>`:`<article class="document-view"><h1>Autoloop<br>移动控制台 PRD</h1><div class="doc-meta">版本 1.0 · 刚刚更新 · 阅读约 12 分钟</div><div class="document-callout"><p><strong>设计原则</strong><br>不是把桌面网页缩小，而是让触屏、通知与对话式决策形成连续体验。</p></div><h2>1. 产品目标</h2><p>在任意移动网络或外部 Wi‑Fi 下，安全查看项目进展、完成人工决策、追踪节点结果并阅读交付产物。</p><h2>2. 会话内待回答组</h2><ul><li>保留 Agent 原话与决策背景</li><li>每次聚焦一个问题，显示整体进度</li><li>支持选项、文字与语音转写</li><li>提交后保留只读回答记录</li></ul><h2>3. 系统字体</h2><p>正文、选项与文档均跟随系统字号。放大后自然换行、增高和滚动，不截断信息。</p></article>`}</main>`;
}
function artifacts() { return device==='fold'?`<div class="artifact-layout"><section class="artifact-browser-pane">${artifactListPane()}</section><section class="artifact-preview-pane fold-only">${artifactPreviewPane()}</section></div>`:`<div class="mobile-shell">${artifactListPane()}</div>`; }
function artifactPreview() { return `<div class="mobile-shell">${artifactPreviewPane()}</div>`; }

function rules() { return shell(`<p class="eyebrow">SCHEDULING</p><h1 class="page-title">调度规则</h1><p class="page-subtitle">定义何时工作，由谁执行，以及在哪里执行。</p><div class="filter-rail"><button class="filter-chip active">全部</button><button class="filter-chip">运行中</button><button class="filter-chip">已暂停</button></div><div class="list-stack"><article class="card rule-item" data-project="移动控制台"><div class="item-top"><div><div class="item-title">移动控制台 · 设计推进</div><div class="item-subtitle">每 10 分钟 · Codex · 工作区已隔离</div></div>${chip('运行中','good')}</div><p class="item-description">读取开放设计项，推进 PRD 与界面审阅；只有产品门禁升级给您。</p><div class="item-actions"><button class="secondary-btn" data-action="toast" data-message="已触发一次最小成本核实">立即运行</button><button class="secondary-btn" data-action="edit-rule">编辑</button><button class="secondary-btn" data-action="toast" data-message="规则已暂停">暂停</button></div></article><article class="card rule-item" data-project="控制台服务端"><div class="item-top"><div><div class="item-title">服务端 · 异常扫描</div><div class="item-subtitle">每天 09:00 · 无模型扫描 · 冷却 30 分钟</div></div>${chip('已暂停','warn')}</div><p class="item-description">发现异常后才唤醒调度 Agent，同一异常不会重复通知。</p><div class="item-actions"><button class="secondary-btn" data-action="edit-rule">编辑</button><button class="primary-btn" data-action="toast" data-message="规则已恢复">恢复</button></div></article></div><button class="primary-btn full-btn" style="margin-top:14px" data-action="edit-rule">＋ 新建规则</button>`, 'rules'); }
function ruleForm() { return shell(`<p class="eyebrow">RULE EDITOR</p><h1 class="page-title">编辑调度规则</h1><p class="page-subtitle">保存前校验草稿；失败不会替换正式规则。</p><div class="card form-card" style="margin-top:18px"><label class="form-field"><span>规则名称</span><input value="移动控制台 · 设计推进"></label><label class="form-field"><span>触发方式</span><select><option>定时触发 · Cron</option><option>事件触发</option></select></label><label class="form-field"><span>Cron 表达式</span><input value="*/10 * * * *"><small class="field-help">使用系统键盘输入；复杂表达式可查看可读说明。</small></label><label class="form-field"><span>项目工作区</span><select><option>移动控制台</option><option>Autoloop 控制台</option></select></label><label class="form-field"><span>处理说明</span><textarea>读取开放设计项，推进 PRD 与界面审阅；只有产品门禁升级给您。</textarea></label></div><button class="primary-btn full-btn" style="margin-top:14px" data-action="toast" data-message="草稿校验通过，规则已保存">校验并保存</button><button class="secondary-btn full-btn" style="margin-top:8px" data-nav="rules">取消</button>`, 'rules', { header: header('编辑规则','',{back:'go-rules',logo:false}) }); }
function runs() { return shell(`<p class="eyebrow">EXECUTION</p><h1 class="page-title">执行轮次</h1><p class="page-subtitle">每个结果都能追溯，异常不会被静默吞掉。</p><div class="filter-rail"><button class="filter-chip active">全部</button><button class="filter-chip">运行中</button><button class="filter-chip">今日完成</button><button class="filter-chip">费用</button></div><div class="list-stack"><article class="card run-item" data-project="移动控制台"><div class="item-top"><div class="item-title">#128 · 移动控制台设计</div>${chip('运行中','good')}</div><div class="item-subtitle">Codex · k3 · 已运行 08:42</div><p class="item-description">正在整合会话问答与产物浏览设计。</p><div class="item-actions"><button class="secondary-btn" data-action="go-conversation">查看会话链接</button><button class="danger-btn" data-action="toast" data-message="已发送停止请求">停止</button></div></article><article class="card run-item" data-project="控制台服务端"><div class="item-top"><div class="item-title">#127 · 通知契约梳理</div>${chip('已完成','')}</div><div class="item-subtitle">今天 09:12 · 12,430 Token · 费用未上报</div><p class="item-description">完成待办去重、节点完成和多设备同步规则。</p><div class="item-actions"><button class="secondary-btn" data-action="open-artifact">查看结果</button></div></article></div>`, 'runs'); }
function cards() { return shell(`<p class="eyebrow">HUMAN DECISIONS</p><h1 class="page-title">待我处理</h1><p class="page-subtitle">只保留真正需要您决策、授权或提供凭据的事项。</p><div class="filter-rail"><button class="filter-chip active">待回答</button><button class="filter-chip">已回答</button><button class="filter-chip">需授权</button></div><div class="list-stack"><article class="card rule-item" data-project="移动控制台"><div class="item-top"><div class="item-title">移动网络的访问边界</div>${chip('待回答','warn')}</div><div class="item-subtitle">规则 · 移动控制台 · 今天 09:38</div><p class="item-description">任意移动网络或外部 Wi-Fi 可直接使用；仅私网需要先连接 VPN。</p><div class="item-actions"><button class="secondary-btn" data-action="toast" data-message="已提交选项：任意移动网络或外部 Wi-Fi">任意网络</button><button class="secondary-btn" data-action="toast" data-message="已提交选项：仅可信私网">仅私网</button><button class="secondary-btn" data-action="toast" data-message="卡片已结案">结案</button></div></article><article class="card rule-item" data-project="控制台服务端"><div class="item-top"><div class="item-title">华为推送服务凭据</div>${chip('需授权','bad')}</div><div class="item-subtitle">规则 · 控制台服务端 · 只有您掌握的凭据</div><p class="item-description">仅说明所需授权和恢复路径，不提供工程选项。</p><div class="item-actions"><button class="primary-btn" data-action="toast" data-message="进入安全凭据提供流程">提供授权</button></div></article></div>`, 'cards'); }
function dag() {
  const segments=[{node:'PRD 与通知契约',label:'已完成',color:'#157a65',from:0,to:20},{node:'设计稿',label:'已完成',color:'#157a65',from:20,to:40},{node:'移动交互',label:'审阅中',color:'#4f8fb9',from:40,to:60},{node:'通知契约',label:'等待',color:'#d8d2e7',from:60,to:80},{node:'整合审阅',label:'等待',color:'#a99bd0',from:80,to:100}];
  return shell(`<p class="eyebrow">PROJECT DAG</p><h1 class="page-title">mobile-app-prd</h1><p class="page-subtitle">移动控制台 · 5 个节点 · 第 2/3 波</p><div class="card dag-detail-card" data-project="移动控制台"><div class="dag-detail-head"><div><strong>并行 DAG</strong><small>颜色 = 波次 · 深浅 = 状态</small></div>${chip('运行中','good')}</div><div class="dag-detail-visual">${dagRing(40,segments,'移动控制台')}<div><dl><div><dt>计划</dt><dd>mobile-app-prd</dd></div><div><dt>槽位</dt><dd>1/5 路占用 · 无隔离槽位</dd></div><div><dt>费用</dt><dd>费用 $1.20 · Token 18,420</dd></div><div><dt>执行边界</dt><dd>PR 合并后下游才启动</dd></div></dl></div></div></div>${section('波次与节点','点击查看契约和证据')}${dagDetailWaves()}<div class="card form-card" data-project="移动控制台" style="margin-top:12px"><div class="item-title">选中节点 · 移动交互实现设计</div><div class="item-subtitle">审阅中 · 槽位 dag-slot-3 · 分支 node/mobile-interaction</div><dl class="fact-list"><div><dt>槽位</dt><dd>dag-slot-3 · 审阅中</dd></div><div><dt>执行 Agent</dt><dd>Codex</dd></div><div><dt>模型</dt><dd>k3 · 按性价比派发</dd></div><div><dt>证据</dt><dd>暂无 PR</dd></div><div><dt>合并提交</dt><dd>尚未合并</dd></div><div><dt>费用 / Token</dt><dd>费用 $0.30 · Token 4,120</dd></div></dl></div>`, 'overview', { header: header('项目 DAG','移动控制台',{back:'go-overview',logo:false,actions:iconBtn('bell','notification-settings','节点通知设置')}) });
}
function authorize() { return shell(`<p class="eyebrow">EXECUTION CONFIRMATION</p><h1 class="page-title">确认执行范围</h1><p class="page-subtitle">这是进入 Hub 事件链的唯一授权确认。</p><div class="card form-card" style="margin-top:17px"><div class="item-title">移动控制台 PRD 与 DAG</div><div class="item-subtitle">计划 mobile-app · 摘要校验通过</div><div class="switch-row"><div class="switch-copy"><strong>目标项目</strong><p>移动控制台 · 独立工作区</p></div>${chip('已隔离','good')}</div><div class="switch-row"><div class="switch-copy"><strong>授权范围</strong><p>6 个节点 · 不包含部署与生产数据变更</p></div>${chip('只读预检','')}</div><div class="switch-row"><div class="switch-copy"><strong>外部动作</strong><p>PR 创建、合并等按既有授权执行</p></div>${chip('待授权','warn')}</div></div><button class="primary-btn full-btn" style="margin-top:14px" data-action="toast" data-message="授权摘要已确认">确认计划与执行范围</button><button class="secondary-btn full-btn" style="margin-top:8px" data-action="go-conversation">返回会话</button>`, 'sessions', { header: header('执行授权','',{back:'go-conversation',logo:false}) }); }
function newSession() { return shell(`<p class="eyebrow">NEW SESSION</p><h1 class="page-title">您想做什么？</h1><p class="page-subtitle">输入第一句话，系统会推荐会话类型，您也可以手动更改。</p><label class="form-field" style="margin-top:18px"><span>项目工作区</span><select><option>移动控制台</option><option>Autoloop 控制台</option></select></label><div class="voice-input-wrap"><textarea style="min-height:125px;width:100%;padding:13px 44px 13px 13px;border:1px solid var(--line-strong);border-radius:15px;resize:none" placeholder="例如：设计移动端控制台并拆解产品需求…">设计移动端控制台并拆解产品需求</textarea><button class="mic-btn" data-action="voice" aria-label="语音输入">${icon('mic')}</button></div><div class="card form-card" style="margin-top:12px"><div class="item-top"><div class="item-title">设计会话 · 推荐</div>${chip('语义分类','good')}</div><p class="item-description">复杂 PRD 与界面设计将进入 Plan Mode + 只读协议。您也可以手动切换为普通或调度会话。</p><div class="filter-rail" style="margin:10px 0 0"><button class="filter-chip active">自动</button><button class="filter-chip">普通</button><button class="filter-chip">调度</button><button class="filter-chip">设计</button></div></div><button class="primary-btn full-btn" style="margin-top:14px" data-action="go-conversation">创建并发送首轮</button>`, 'sessions', { header: header('新建会话','',{back:'go-sessions',logo:false}) }); }

function notifications() { return `<div class="lock-screen"><div class="lock-time">9:41</div><div class="lock-date">11月17日 星期二</div><div class="notification-stack"><div class="system-notification"><div class="notification-head"><span class="app-logo">A</span><span>AUTOLOOP · 待我处理</span><span>现在</span></div><h3>移动控制台 · 需要您的回答</h3><p>移动网络的访问边界<br>问题 1 / 3 · 每项独立通知</p><div class="notification-actions"><button data-action="notification-choice" data-message="同意">同意</button><button data-action="notification-choice" data-message="拒绝">拒绝</button><button data-action="notification-reply">文字回复</button></div>${notificationReply?`<div class="inline-reply"><input id="notification-input" value="任意移动网络或外部 Wi-Fi 都可使用" aria-label="通知直接回复"><button data-action="notification-send">发送</button></div>`:''}</div><button class="system-notification" data-action="go-conversation" type="button"><div class="notification-head"><span class="app-logo">A</span><span>AUTOLOOP · 待我处理</span><span>2分钟前</span></div><h3>节点完成通知的内容</h3><p>问题 3 / 3 · 点击定位到会话中的该问题</p></button><button class="system-notification" data-action="open-dag" type="button"><div class="notification-head"><span class="app-logo">A</span><span>AUTOLOOP · 节点完成</span><span>12分钟前</span></div><h3>「界面设计」节点已完成</h3><p>移动控制台 · 查看节点结果与交付详情</p></button></div><div class="lock-footer"><span>锁屏显示完整摘要</span><span>3 项待处理 · 角标 3</span></div></div>`; }
function biometric() { return `<div class="biometric-screen"><div class="biometric-icon"><svg viewBox="0 0 24 24">${icons.fingerprint}</svg></div><h2>${biometricDone?'验证成功':'解锁 Autoloop'}</h2><p>${biometricDone?'正在返回原来的问题，回答草稿已保留。':'使用系统指纹或人脸验证。<br>仅打开 App 与锁屏直复需要验证，高风险操作不再另外加门槛。'}</p>${biometricDone?`${chip('身份已确认','good')}<button class="primary-btn" data-action="finish-biometric">返回待回答组</button>`:`<button class="primary-btn" data-action="biometric-success">使用指纹 / 人脸继续</button><button class="text-btn" data-action="toast" data-message="可改用系统锁屏密码">使用锁屏密码</button>`}</div>`; }
function devices() { return shell(`<p class="eyebrow">DEVICES & PREFERENCES</p><h1 class="page-title">设备与偏好</h1><p class="page-subtitle">多设备同时使用。任何手机都不能撤销其他设备。</p>${section('已绑定设备','2 台在线')}<div class="card"><div class="device-item"><span class="phone-symbol">▯</span><div class="file-copy"><strong>Pura 70 Ultra</strong><small>本机 · 旧版鸿蒙 · 当前在线</small></div>${chip('本机','good')}</div><div class="device-item"><span class="phone-symbol">▯</span><div class="file-copy"><strong>Pura X Max</strong><small>折叠屏 · 最近使用 10 分钟前</small></div>${chip('已绑定','')}</div></div><button class="secondary-btn full-btn" style="margin-top:10px" data-action="toast" data-message="请在电脑控制台生成本机一次性配对二维码">扫码绑定新设备</button><p class="page-subtitle" style="margin:8px 4px">撤销丢失设备只能在电脑控制台的本机管理入口操作。</p>${section('通知与显示','跟随系统')}<div class="card form-card"><div class="switch-row"><div class="switch-copy"><strong>待我处理通知</strong><p>每项独立通知 · 角标显示待办总数</p></div><button class="switch on" data-action="switch" aria-label="待我处理通知"></button></div><div class="switch-row"><div class="switch-copy"><strong>节点完成通知</strong><p>每个成功节点独立通知</p></div><button class="switch on" data-action="switch" aria-label="节点完成通知"></button></div><div class="switch-row"><div class="switch-copy"><strong>锁屏显示详情</strong><p>显示项目、事项摘要与完成结果</p></div><button class="switch on" data-action="switch" aria-label="锁屏显示详情"></button></div><div class="switch-row"><div class="switch-copy"><strong>系统字体大小</strong><p>100%–160% 自然换行，无截断与遮挡</p></div>${chip('跟随系统','good')}</div></div>`, 'overview', { header: header('设备与偏好','',{back:'go-overview',logo:false}) }); }

const renderers = { overview, conversation, artifacts, 'artifact-preview':artifactPreview, sessions, 'archived-session':archivedSession, rules, 'rule-form':ruleForm, runs, cards, dag, authorize, 'new-session':newSession, notifications, biometric, devices };
function render(preserve = false) {
  if (!preserve) {
    const old = $('.screen-scroll'); if (old) savedScroll[current] = old.scrollTop;
  }
  const app = $('#app');
  app.innerHTML = renderers[current]();
  document.documentElement.style.setProperty('--font-scale', document.documentElement.style.getPropertyValue('--font-scale') || '1');
  $('#device').classList.toggle('large-text', Number(document.documentElement.style.getPropertyValue('--font-scale')) > 1);
  const idx = screens.findIndex(s=>s[0]===current);
  $('#screen-number').textContent = String(idx+1).padStart(2,'0');
  $('#screen-title').textContent = screens[idx][1];
  $('#screen-subtitle').textContent = screens[idx][2];
  $$('#prototype-nav button').forEach(b=>b.classList.toggle('active',b.dataset.screen===current));
  applyProjectFilter();
  $('#app').insertAdjacentHTML('beforeend', projectSheet());
  const scroll = $('.screen-scroll'); if (scroll && savedScroll[current]) scroll.scrollTop = savedScroll[current];
}
function navigate(name, preserve = false) { if (!renderers[name]) return; current = name; render(preserve); }
function toast(message) { const el = $('#prototype-toast'); el.textContent = message; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(()=>el.hidden=true,2200); }
function prototypeNav() { $('#prototype-nav').innerHTML = screens.map(([id,title],i)=>`<button type="button" data-screen="${id}"><span>${String(i+1).padStart(2,'0')}</span><span>${title}</span><span>↗</span></button>`).join(''); }

addEventListener('click', event => {
  const b = event.target.closest('button'); if (!b) return;
  if (b.dataset.screen) { navigate(b.dataset.screen); return; }
  if (b.dataset.device) { device=b.dataset.device; $('#device').className=`device ${device}`; $$('.device-switch button').forEach(x=>x.classList.toggle('active',x===b)); render(true); return; }
  if (b.dataset.font) { const scale=Number(b.dataset.font); document.documentElement.style.setProperty('--font-scale',scale); $$('.prototype-font-switch button').forEach(x=>x.classList.toggle('active',x===b)); $('#device').classList.toggle('large-text',scale>1); toast(`正在模拟系统字体 ${scale*100}% · 布局随文字重排`); return; }
  if (b.dataset.nav) { const map={overview:'overview',rules:'rules',sessions:'sessions',runs:'runs',cards:'cards'}; navigate(map[b.dataset.nav]); return; }
  if (b.dataset.option !== undefined) { selectedOption=b.dataset.option; render(true); return; }
  const action=b.dataset.action;
  if (b.dataset.projectOption !== undefined) { projectFilter=b.dataset.projectOption; projectSheetOpen=false; if(['conversation','artifact-preview'].includes(current)) { navigate('sessions'); } else render(true); toast(`项目筛选已切换为 ${projectFilter}，所有 Tab 同步生效`); return; }
  if (action==='open-project-filter') { projectSheetOpen=true; render(true); return; }
  if (action==='close-project-filter') { projectSheetOpen=false; render(true); return; }
  if (action==='toggle-archived') { archivedOpen=!archivedOpen; render(true); return; }
  if (action==='restore-archive') { navigate('conversation'); toast('恢复将创建新会话并注入最近 10 轮转录'); return; }
  if (action==='go-session-artifacts') { artifactOrigin='manager'; navigate('artifacts'); return; }
  if (b.dataset.preview) { previewMode=b.dataset.preview; render(true); return; }
  if (!action) return;
  const routes={'go-conversation':'conversation','go-artifacts':'artifacts','go-sessions':'sessions','go-rules':'rules','go-overview':'overview','open-dag':'dag','edit-rule':'rule-form','new-session':'new-session','open-artifact':'artifact-preview','view-archive':'archived-session','go-session-artifacts':'artifacts','notification-settings':'devices'};
  if (action==='open-session-artifact') { artifactOrigin='session'; navigate('artifact-preview'); return; }
  if (routes[action]) { navigate(routes[action]); return; }
  if (action==='submit-answer') { const qText=decisionStep===1?(voiceText||$('#question-input')?.value.trim()):selectedOption; if(!qText){toast('请先选择或输入回答');return;} answered[decisionStep]=qText; decisionStep=Math.min(3,decisionStep+1); selectedOption=''; voiceText=''; render(true); setTimeout(()=>$('#decision-group')?.scrollIntoView({block:'start',behavior:'smooth'}),50); toast('回答已提交，已保留在原会话上下文中'); return; }
  if (action==='voice'||action==='composer-voice') { listening=!listening; if(!listening){voiceText='任意移动网络或外部 Wi-Fi 下都可以直接使用。';toast('语音已转为可编辑文字，尚未发送');} render(true); return; }
  if (action==='scroll-question') { $('#decision-group')?.scrollIntoView({block:'start',behavior:'smooth'}); return; }
  if (action==='notification-reply') { notificationReply=true; render(true); setTimeout(()=>$('#notification-input')?.focus(),50); return; }
  if (action==='notification-choice') { biometricDone=false; navigate('biometric'); toast(`将使用生物识别提交「${b.dataset.message}」`); return; }
  if (action==='notification-send') { biometricDone=false; navigate('biometric'); return; }
  if (action==='biometric-success') { biometricDone=true; render(true); return; }
  if (action==='finish-biometric') { navigate('conversation'); toast('验证通过，已回到原问题'); return; }
  if (action==='switch') { b.classList.toggle('on'); toast('偏好已更新，仅影响当前设备'); return; }
  if (action==='context') { toast('定位到该问题对应的 Agent 原话，回答位置保持不变'); return; }
  if (action==='send') { const text=$('#composer-input')?.value.trim(); if(!text){toast('请输入内容或使用语音');return;} drafts.composer=''; toast('消息已发送；未回答问题仍保留'); render(true); return; }
  if (action==='export') { toast('调用系统分享面板；产物保持只读'); return; }
  toast({more:'更多会话与设备操作',attachment:'可添加文件、图片或项目上下文',queue:'可编辑、排序、清空或立即引导排队消息','session-info':'查看项目、模型、权限与创建时间','artifact-search':'按文件名与路径过滤产物','other-answer':'退回调度处理，不代替您作答',export:'导出只读副本'}[action] || '此交互将在 PRD 中定义完整状态');
});
addEventListener('input', event => { if(event.target.id==='composer-input') drafts.composer=event.target.value; if(event.target.id==='question-input') voiceText=event.target.value; });
prototypeNav(); render();
