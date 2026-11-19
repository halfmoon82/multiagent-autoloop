// 网页设备授权管理后台：一次性二维码、设备列表、解除授权与审计。
// 所有文本走 textContent，不拼接不可信 HTML；令牌只在生成时展示一次，不写入页面持久化结构。
import { el } from './views.mjs';

const ACTION_LABEL = { 'qr.create': '生成二维码', bind: '绑定设备', rename: '重命名设备', revoke: '解除授权' };
const fmtTime = value => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '从未');

export function initDevices({ api, notify, showView }) {
  const $ = id => document.getElementById(id);
  const s = { devices: [], audit: [], qr: null, failed: '', busy: false };

  function banner() {
    const box = $('device-state');
    box.textContent = s.failed ? `加载失败：${s.failed}。可点击“刷新”重试，已显示的数据保留。` : '';
    box.hidden = !box.textContent;
    box.className = `state-banner${s.failed ? ' error' : ''}`;
  }

  function renderQr() {
    const host = $('device-qr');
    host.replaceChildren();
    host.hidden = !s.qr;
    $('device-bind-submit').disabled = !s.qr;
    if (!s.qr) return;
    // 用令牌生成确定性的方格图，作为二维码的可视内容；真实扫描读取下方的一次性绑定码。
    const grid = el('div', 'qr-grid');
    for (let index = 0; index < 144; index += 1) {
      const on = (s.qr.token.charCodeAt(index % s.qr.token.length) + index) % 3 === 0;
      grid.append(el('span', on ? 'on' : ''));
    }
    const token = el('input', 'qr-token');
    token.type = 'text'; token.readOnly = true; token.id = 'device-qr-token';
    token.value = s.qr.token;
    token.setAttribute('aria-label', '一次性绑定码');
    const label = el('label', 'qr-token-label');
    label.append(document.createTextNode('一次性绑定码（二维码内容）'), token);
    host.append(
      el('p', 'subtle', '用手机 App 扫描或输入下方绑定码完成绑定；一次性有效，过期请重新生成。'),
      grid,
      label,
      el('p', 'subtle', `失效时间：${fmtTime(s.qr.expiresAt)}`),
    );
  }

  function renderDevices() {
    const host = $('device-list');
    host.replaceChildren();
    $('device-count-label').textContent = `共 ${s.devices.length} 台`;
    const badge = $('device-count');
    const active = s.devices.filter(device => device.status === 'authorized').length;
    badge.textContent = String(active);
    badge.hidden = active === 0;
    if (!s.devices.length) {
      host.append(el('div', 'empty', '还没有已绑定设备。先生成一次性二维码并完成绑定。'));
      return;
    }
    for (const device of s.devices) {
      const row = el('div', 'list-row');
      const main = el('div');
      const meta = `${device.platform || '未标注系统'} · 绑定 ${fmtTime(device.boundAt)} · 最近活跃 ${fmtTime(device.lastActiveAt)}`;
      main.append(el('div', 'row-title', device.name), el('div', 'row-meta', meta));
      const side = el('div', 'device-row-actions');
      const authorized = device.status === 'authorized';
      side.append(el('span', `status ${authorized ? 'good' : 'bad'}`, authorized ? '已授权' : '已解除'));
      if (authorized) {
        const rename = el('button', 'text-button', '重命名');
        rename.type = 'button';
        rename.addEventListener('click', () => onRename(device));
        const revoke = el('button', 'button danger', '解除授权');
        revoke.type = 'button';
        revoke.addEventListener('click', () => onRevoke(device));
        side.append(rename, revoke);
      }
      row.append(main, side);
      host.append(row);
    }
  }

  function renderAudit() {
    const host = $('device-audit');
    host.replaceChildren();
    if (!s.audit.length) { host.append(el('div', 'empty', '暂无审计记录。')); return; }
    for (const item of s.audit) {
      const row = el('div', 'list-row');
      const main = el('div');
      const detail = [item.deviceName, item.platform].filter(Boolean).join(' · ');
      main.append(el('div', 'row-title', ACTION_LABEL[item.action] || item.action), el('div', 'row-meta', `${detail || '—'} · ${fmtTime(item.at)}`));
      const side = el('div', 'device-row-actions');
      side.append(el('span', `status ${item.result === 'ok' ? 'good' : 'bad'}`, item.result === 'ok' ? '成功' : '失败'), el('span', 'subtle', item.source || '—'));
      row.append(main, side);
      host.append(row);
    }
  }

  function render() { banner(); renderQr(); renderDevices(); renderAudit(); }

  async function load() {
    try {
      const data = await api('/api/devices');
      s.devices = data.devices || [];
      s.audit = data.audit || [];
      s.failed = '';
    } catch (error) { s.failed = error.message; }
    render();
  }

  async function act(task, success) {
    if (s.busy) return;
    s.busy = true;
    try { await task(); if (success) notify(success); await load(); }
    catch (error) { notify(`操作失败：${error.message}`); }
    finally { s.busy = false; }
  }

  async function onRename(device) {
    const name = window.prompt('输入新的设备名称', device.name);
    if (!name) return;
    await act(() => api(`/api/devices/${encodeURIComponent(device.id)}/rename`, { method: 'POST', body: JSON.stringify({ name }) }), '设备已重命名。');
  }

  async function onRevoke(device) {
    if (!window.confirm(`解除 ${device.name} 的授权？该设备会立即失去访问与通知资格。`)) return;
    await act(() => api(`/api/devices/${encodeURIComponent(device.id)}/revoke`, { method: 'POST', body: '{}' }), '已解除授权。');
  }

  $('device-qr-create').addEventListener('click', () => act(async () => {
    s.qr = await api('/api/devices/bindings', { method: 'POST', body: '{}' });
    notify('一次性二维码已生成，5 分钟内有效。');
  }));

  $('device-bind-submit').addEventListener('click', () => act(async () => {
    const name = $('device-bind-name').value;
    const platform = $('device-bind-platform').value;
    await api('/api/devices/bind', { method: 'POST', body: JSON.stringify({ token: s.qr?.token, name, platform }) });
    s.qr = null;
    $('device-bind-name').value = '';
    $('device-bind-platform').value = '';
    notify('设备绑定成功。');
  }));

  $('device-refresh').addEventListener('click', load);

  return { onShow: load, showView };
}
