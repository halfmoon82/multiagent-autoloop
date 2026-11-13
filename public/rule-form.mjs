import { el } from './views.mjs';
export function openRuleForm({ rule, agents, sources, api, onSaved }) {
  const dialog = document.getElementById('rule-dialog'); const container = document.getElementById('rule-form-container');
  const form = el('form', 'dialog-form'); const title = el('h2', '', rule ? '编辑调度规则' : '新建调度规则'); title.id = 'rule-dialog-title';
  const grid = el('div', 'form-grid');
  const fields = {};
  function field(name, label, type = 'text', options = {}) {
    const box = el('label', `field${options.full ? ' full' : ''}`); box.append(el('span', '', label));
    const input = type === 'textarea' ? el('textarea') : type === 'select' ? el('select') : el('input');
    input.name = name; input.required = !options.optional; if (type === 'textarea') input.rows = 4; if (type === 'number') input.min = '1';
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.hint) { const small = el('small', '', options.hint); box.append(input, small); } else box.append(input);
    fields[name] = input; grid.append(box); return input;
  }
  field('name', '规则名称', 'text', { placeholder: '例如：每日项目摘要' });
  const trigger = field('trigger', '触发方式', 'select'); trigger.append(new Option('定时执行', 'cron'), new Option('外部事件', 'event'));
  field('cron', 'Cron 表达式', 'text', { placeholder: '0 9 * * *', hint: '例如每天 09:00；时区沿用中台配置' });
  const source = field('source', '事件来源', 'select', { optional: true }); sources.forEach(item => source.append(new Option(item.name, item.id)));
  field('types', '事件类型', 'text', { optional: true, placeholder: 'issues.opened, issues.edited', hint: '多个类型用逗号分隔' });
  const agent = field('to', '执行 Agent', 'select'); agents.forEach(item => agent.append(new Option(`${item.name} · ${item.access}`, item.id)));
  field('cwd', '工作目录', 'text', { full: true, placeholder: '/绝对路径 或 ~/目录' });
  field('prompt', '处理说明', 'textarea', { full: true, placeholder: '要完成什么、怎样算完成、哪些事必须先问人' });
  field('parallel', '并发上限（可留空）', 'number', { optional: true, hint: '填写后按事件对象区分事项' });
  const resumeBox = el('label', 'field'); const resume = el('input'); resume.type = 'checkbox'; resume.name = 'resume'; const resumeLabel = el('span', '', '续接上一轮的会话'); resumeBox.append(resumeLabel, resume, el('small', '', '长期任务建议关闭，改为从磁盘状态恢复'));
  grid.append(resumeBox);
  const actions = el('div', 'dialog-actions'); const cancel = el('button', 'button secondary', '取消'); cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
  const submit = el('button', 'button primary', rule ? '保存规则' : '创建规则'); submit.type = 'submit'; actions.append(cancel, submit);
  form.append(title, el('p', 'subtle', '保存前会使用当前 Autoloop 版本校验，失败不会改动正式规则。'), grid, actions);
  if (rule) {
    fields.name.value = rule.name; fields.name.readOnly = true; fields.cwd.value = rule.cwd; fields.prompt.value = rule.prompt; fields.to.value = rule.to; fields.parallel.value = rule.parallel || ''; resume.checked = !!rule.resume;
    const isCron = !!rule.when?.cron; fields.trigger.value = isCron ? 'cron' : 'event'; fields.cron.value = rule.when?.cron || ''; fields.source.value = rule.when?.source || sources[0]?.id; fields.types.value = (rule.when?.types || []).join(', ');
  }
  function updateTrigger() { const cron = fields.trigger.value === 'cron'; fields.cron.required = cron; fields.cron.disabled = !cron; fields.source.disabled = cron; fields.types.disabled = cron; fields.source.required = !cron; fields.types.required = !cron; }
  fields.trigger.addEventListener('change', updateTrigger); updateTrigger();
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    const body = Object.fromEntries(new FormData(form)); body.resume = resume.checked;
    try { await api(rule ? `/api/rules/${encodeURIComponent(rule.name)}` : '/api/rules', { method: rule ? 'PUT' : 'POST', body: JSON.stringify(body) }); dialog.close(); await onSaved(); }
    catch (error) { const old = form.querySelector('.notice'); if (old) old.remove(); const notice = el('div', 'notice', error.message); notice.hidden = false; form.prepend(notice); }
    finally { submit.disabled = false; }
  });
  container.replaceChildren(form); dialog.showModal(); fields.name.focus();
}
