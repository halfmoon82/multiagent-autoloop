// 网页设备授权管理后台：一次性二维码、设备列表、解除授权与审计。
// 所有文本走 textContent，不拼接不可信 HTML；令牌只在生成时展示一次，不写入页面持久化结构。
// 绑定只由设备端提交：网页生成真实二维码并等待设备扫码，绝不代替设备点击绑定而丢弃设备凭证。
import { el } from './views.mjs';
import { encodeQr } from './qr.mjs';

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
    if (!s.qr) return;
    const { modules, size } = encodeQr(s.qr.qrPayload);
    const grid = el('div', 'qr-grid');
    grid.setAttribute('data-size', String(size));
    grid.setAttribute('role', 'img');
    grid.setAttribute('aria-label', '一次性绑定二维码');
    grid.style.setProperty('--qr-size', String(size));
    for (const row of modules) for (const dark of row) grid.append(el('span', dark ? 'on' : ''));
    const token = el('input', 'qr-token');
    token.type = 'text'; token.readOnly = true; token.id = 'device-qr-token';
    // 手输码必须和二维码内容一致：显示完整 qrPayload，用户复制到手机直接粘贴即可。
    token.value = s.qr.qrPayload;
    token.setAttribute('aria-label', '绑定码（复制后在手机粘贴即可）');
    const copy = el('button', 'button text-button', '一键复制');
    copy.type = 'button';
    copy.dataset.action = 'copy-bind';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(s.qr.qrPayload);
        notify('绑定码已复制，去手机粘贴即可');
      } catch {
        notify('复制失败，请长按选中上面的绑定码手动复制');
      }
    });
    const label = el('label', 'qr-token-label');
    label.append(document.createTextNode('备用绑定码（手机无法扫码时复制粘贴）'), token, copy);
    host.append(
      el('p', 'subtle', '用手机 App 扫描上方二维码完成绑定；复制后在手机粘贴即可，一次性有效，过期请重新生成。'),
      grid,
      label,
      el('p', 'subtle', `失效时间：${fmtTime(s.qr.expiresAt)}`),
      el('p', 'subtle', '等待设备扫码绑定：绑定成功后该二维码自动失效，设备会出现在下方「已绑定设备」列表。'),
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
      host.append(el('div', 'empty', '还没有已绑定设备。先生成一次性二维码，再用手机扫码完成绑定。'));
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
      // 设备端完成绑定后，审计里出现同一 bindingId 的 bind 记录，二维码自动失效。
      if (s.qr && s.audit.some(item => item.action === 'bind' && item.bindingId === s.qr.bindingId)) s.qr = null;
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
    notify('一次性二维码已生成，5 分钟内有效，等待设备扫码。');
  }));

  $('device-refresh').addEventListener('click', load);

  return { onShow: load, showView };
}
