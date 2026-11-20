// 备用绑定码 UX：后台二维码失效时用户复制的手输码必须是二维码里的完整载荷，
// 而不是裸 64hex token；否则手机端要手输 autoloop://bind?token= 前缀才能绑定。
import test from 'node:test';
import assert from 'node:assert/strict';

function makeNode(tag) {
  return {
    tag, className: '', textContent: '', id: '', type: '', value: '', readOnly: false, hidden: false,
    children: [], dataset: {}, attrs: {}, listeners: {},
    style: { setProperty() {} },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(event, fn) { (this.listeners[event] ||= []).push(fn); },
    async emit(event) { for (const fn of this.listeners[event] || []) await fn(); },
  };
}

const ids = ['device-state', 'device-qr', 'device-list', 'device-count-label', 'device-count', 'device-audit', 'device-qr-create', 'device-refresh'];
const els = Object.fromEntries(ids.map(id => [id, makeNode('div')]));
globalThis.document = {
  createElement: makeNode,
  createTextNode: text => ({ textContent: String(text) }),
  getElementById: id => els[id],
};
let copied = null;
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: { async writeText(text) { copied = text; } },
});

const { initDevices } = await import('../public/device.mjs');

const TOKEN = 'a'.repeat(64);
const QR = {
  token: TOKEN,
  qrPayload: `autoloop://bind?token=${TOKEN}`,
  bindingId: 'bind_1',
  expiresAt: '2026-11-21T00:00:00.000Z',
};

function setup() {
  for (const node of Object.values(els)) {
    node.children = []; node.textContent = ''; node.listeners = {}; node.hidden = false;
  }
  copied = null;
  const notes = [];
  const view = initDevices({
    api: async path => {
      if (path === '/api/devices') return { devices: [], audit: [] };
      if (path === '/api/devices/bindings') return QR;
      throw new Error(`unexpected api: ${path}`);
    },
    notify: message => notes.push(message),
    showView: () => {},
  });
  return { view, notes };
}

const find = (node, predicate) => predicate(node) ? node : (node.children || []).map(child => find(child, predicate)).find(Boolean);
const textOf = node => [node.textContent || '', ...(node.children || []).map(textOf)].join('');

test('备用码框显示完整二维码载荷、可一键复制，文案是「复制后在手机粘贴即可」', async () => {
  const { view, notes } = setup();
  await view.onShow();
  await els['device-qr-create'].emit('click');

  const host = els['device-qr'];
  const token = find(host, node => node.id === 'device-qr-token');
  assert.ok(token, '备用码输入框应存在');
  assert.equal(token.value, QR.qrPayload, '备用码框内容必须等于二维码载荷');
  assert.notEqual(token.value, QR.token, '不能再显示裸 64hex token');
  assert.ok(!textOf(host).includes(QR.token), '裸 token 不应出现在页面上');

  const copy = find(host, node => node.dataset?.action === 'copy-bind');
  assert.ok(copy, '应有一键复制按钮');
  await copy.emit('click');
  assert.equal(copied, QR.qrPayload, '一键复制应复制完整二维码载荷');
  assert.match(textOf(host), /复制后在手机粘贴即可/);
  assert.ok(notes.some(message => message.includes('已复制')), '复制后应给人话提示');
});
