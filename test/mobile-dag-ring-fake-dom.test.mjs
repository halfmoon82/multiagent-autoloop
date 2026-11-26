// 文件名带 .test 只为落在本节点允许的测试路径内；主要用途是供其他环测试 import。
// 测试用最小 DOM（fix6 project-ring-web-parity）：足够驱动网页版 public/progress-view.mjs、public/views.mjs
// 与移动端 pages/core.mjs 的环渲染，便于在 Node 下用同一份数据做快照对比。不是通用 DOM 实现。
export function makeNode(tag) {
  const el = {
    tag, className: '', textContent: '', hidden: false, attrs: {}, children: [], handlers: {}, dataset: {}, style: {},
    setAttribute(key, value) {
      this.attrs[key] = String(value);
      if (key === 'hidden') this.hidden = true;
      if (key === 'class') this.className = String(value);
    },
    getAttribute(key) { return this.attrs[key] ?? null; },
    removeAttribute(key) { delete this.attrs[key]; if (key === 'hidden') this.hidden = false; },
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); },
    dispatch(type, event = {}) { for (const handler of this.handlers[type] || []) handler({ type, preventDefault() {}, stopPropagation() {}, ...event }); },
    click() { this.dispatch('click'); },
    appendChild(child) { this.children.push(child); return child; },
    append(...items) { for (const item of items) this.children.push(typeof item === 'string' ? { tag: '#text', textContent: item, children: [] } : item); },
    prepend(...items) { this.children.unshift(...items); },
    replaceChildren(...items) { this.children = items; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {},
  };
  return el;
}

export function installFakeDom() {
  globalThis.document = {
    createElement: makeNode,
    createElementNS: (_ns, tag) => makeNode(tag),
    createTextNode: value => ({ tag: '#text', textContent: String(value), children: [] }),
    getElementById: () => null,
    activeElement: null,
    body: null,
  };
  globalThis.requestAnimationFrame ||= () => 0;
  globalThis.CSS ||= { escape: value => String(value) };
}

export const walk = (el, out = []) => { if (!el) return out; out.push(el); for (const child of el.children || []) walk(child, out); return out; };
export const byClass = (root, cls) => walk(root).filter(el => String(el.className || el.attrs?.class || '').split(/\s+/).includes(cls));
export const byAttr = (root, key) => walk(root).filter(el => el.attrs?.[key] !== undefined);
export const textOf = el => walk(el).map(node => node.textContent || '').join('');

// 自检：被其他环测试 import 时也会注册，确保辅助 DOM 的遍历/文本提取行为稳定。
if (import.meta.url.endsWith('mobile-dag-ring-fake-dom.test.mjs')) {
  const { default: test } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');
  test('fake DOM 辅助：遍历、按 class/属性查找与文本拼接', () => {
    const root = makeNode('div');
    const child = makeNode('span');
    child.className = 'a b'; child.textContent = '甲'; child.setAttribute('data-x', '1');
    root.append(child, '乙');
    assert.equal(walk(root).length, 3);
    assert.equal(byClass(root, 'b')[0], child);
    assert.equal(byAttr(root, 'data-x')[0], child);
    assert.equal(textOf(root), '甲乙');
  });
}
