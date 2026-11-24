// 调度会话上限展示：只读 /api/session-limit，如实显示当前生效上限与回退告警。
// 上游文本一律走 textContent，不拼不可信 HTML。
const container = document.getElementById('session-limit-list');
if (container) {
  const row = (title, meta, className = 'list-row') => {
    const node = document.createElement('div');
    node.className = className;
    const text = document.createElement('div');
    const titleNode = document.createElement('div');
    titleNode.className = 'row-title';
    titleNode.textContent = title;
    const metaNode = document.createElement('div');
    metaNode.className = 'row-meta';
    metaNode.textContent = meta;
    text.append(titleNode, metaNode);
    node.append(text);
    return node;
  };

  const render = data => {
    container.replaceChildren();
    const limit = Number(data?.maxSessions);
    if (!Number.isInteger(limit)) {
      container.append(row('当前上限暂不可用', '未能读取 config.json 的调度会话上限，未做猜测。'));
      return;
    }
    const source = `来源：config.json · 默认 ${data.default ?? 6} · 允许 ${data.min ?? 1}–${data.max ?? 12}`;
    container.append(row(`当前上限：${limit} 个会话`, source));
    if (data.warning) container.append(row('配置已回退', `maxSessions ${data.warning}，当前按 ${data.default ?? 6} 执行；请改为允许范围内的整数。`, 'list-row bad'));
    const note = document.createElement('div');
    note.className = 'subtle';
    note.textContent = '调度会话计入全局计数；超额开启会被拒绝并提示当前上限。';
    container.append(note);
  };

  try {
    const response = await fetch('/api/session-limit');
    render(response.ok ? await response.json() : null);
  } catch {
    render(null);
  }
}
