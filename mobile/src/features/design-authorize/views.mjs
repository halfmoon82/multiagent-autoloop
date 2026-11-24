// 设计授权页渲染：把 buildAuthorizeView 的视图模型画成可勾选、可提交的 DOM。
// 页面只负责挂载与状态；勾选「已阅读」(check) 与提交 (submit) 的控件在这里生成。
// 上游文本一律走 textContent（node 由调用方注入），不拼 innerHTML。

export function renderAuthorizeParts(view, auth, { node, onAck, onSubmit }) {
  const parts = [];
  if (auth.error) parts.push(node('p', { className: 'status error', text: auth.error, attrs: { 'data-auth-error': '1' } }));
  if (!view.ready) {
    parts.push(node('p', { className: 'hint', text: auth.loading ? '正在读取计划…' : '填写计划编号并点「读取计划」，逐条核对后才能提交。' }));
    return parts;
  }
  parts.push(node('p', { className: 'sessions-meta', text: `${view.title} · planId ${view.planId}` }));
  parts.push(node('p', { className: 'sessions-meta', text: `项目 ${view.project}`, attrs: { 'data-auth-repo': '1' } }));
  parts.push(node('p', { className: 'sessions-meta', text: `远端 ${view.remoteLabel}`, attrs: { 'data-auth-remote': '1' } }));
  parts.push(node('p', { className: 'sessions-meta', text: `${view.summary.businessNodes} 个业务节点${view.summary.reviewNodes ? ` + ${view.summary.reviewNodes} 个整合审查` : ''}${view.summary.maxParallel ? ` · 最大并行 ${view.summary.maxParallel} 路` : ''}` }));
  const checkBox = node('div', { className: 'sessions-auth-section' }, [node('h3', { text: '环境与权限检查' })]);
  if (auth.preflightError) checkBox.appendChild(node('p', { className: 'hint', text: `预检读取失败：${auth.preflightError}（未知不当成通过）` }));
  for (const check of view.checks) checkBox.appendChild(node('p', { className: `sessions-auth-check ${check.ok ? 'good' : 'warn'}`, text: `${check.ok ? '✓' : '!'} ${check.label}：${check.message}` }));
  parts.push(checkBox);
  const nodesBox = node('div', { className: 'sessions-auth-section' }, [node('h3', { text: '节点及文件范围' })]);
  for (const item of view.nodes) {
    nodesBox.appendChild(node('div', { className: 'sessions-auth-node', attrs: { 'data-auth-node': item.id } }, [
      node('strong', { text: `${item.wave ? `第 ${item.wave} 波 · ` : ''}${item.title}` }),
      node('code', { text: item.files.length ? item.files.join('、') : '只读审查，无写入' }),
      node('small', { text: item.dependsOn.length ? `依赖：${item.dependsOn.join('、')}` : '无依赖，可首批启动' }),
    ]));
  }
  parts.push(nodesBox);
  const allowedBox = node('div', { className: 'sessions-auth-section' }, [node('h3', { text: '本次允许' })]);
  for (const item of view.allowed) allowedBox.appendChild(node('p', { className: 'sessions-auth-allowed', text: `✓ ${item.label}${item.note ? `——${item.note}` : ''}`, attrs: { 'data-action-id': item.id } }));
  parts.push(allowedBox);
  parts.push(node('div', { className: 'sessions-auth-section' }, [node('h3', { text: '始终不包含' }), node('p', { className: 'hint', text: [...view.denied.map(item => item.label), '修改存量串行链'].join('、') })]));
  parts.push(node('p', { className: 'sessions-auth-digest', text: `计划摘要 ${view.planDigest}`, attrs: { 'data-plan-digest': '1' } }));
  // 勾选已读（checkbox）：未勾选不可提交。
  const ack = node('input', { className: 'sessions-auth-ack', attrs: { type: 'checkbox', id: 'sessions-auth-ack', 'aria-label': '我已阅读 PRD、Spec、DAG 和上述执行范围' } });
  ack.checked = auth.ack;
  ack.disabled = auth.submitting || Boolean(auth.created);
  ack.addEventListener('change', () => onAck(ack.checked));
  parts.push(node('label', { className: 'sessions-auth-ack-row', attrs: { for: 'sessions-auth-ack' } }, [ack, node('span', { text: '我已阅读 PRD、Spec、DAG 和上述执行范围。' })]));
  // 提交（submit）：POST /api/mobile/dag-runs，服务端再校验 planDigest。
  const submit = node('button', { type: 'button', className: 'primary sessions-auth-submit', text: auth.submitting ? '正在创建…' : '确认并进入事件链' });
  submit.disabled = !view.canSubmit;
  submit.addEventListener('click', () => onSubmit());
  parts.push(submit);
  if (auth.created) parts.push(node('p', { className: 'status good', text: `已创建 DAG ${auth.created.runId}，授权快照已由服务端写入。`, attrs: { 'data-auth-created': '1' } }));
  return parts;
}
