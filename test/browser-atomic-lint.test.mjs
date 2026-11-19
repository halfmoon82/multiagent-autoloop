// 浏览器回归的「两步式元素读写」守门（#132 / #134 / #137 同一根因）：
// 控制台每 2 秒整块重建页面元素。Playwright 1.65 的 locator 方法里，boundingBox / evaluate / evaluateHandle /
// screenshot / scrollIntoViewIfNeeded / selectText 走 _withElement：先定位拿句柄、再单独执行，两步之间撞上重建
// 就会读到已摘除节点（尺寸 0、scrollTop 0、null）或把写入落进旧节点；elementHandle / elementHandles 拿到的句柄
// 日后同样可能失效。读写会被重建的区域时，改成单个 page.evaluate 在页面内定位当前节点并完成操作。
// 确属有意（例如输入框有内容、卡片被钉住，且本意就是校验同一节点存活）时，在同一行或上一行写
// `// atomic-ok: <理由>` 放行。page.evaluate / page.screenshot 等整页方法不受限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const TWO_STEP = ['boundingBox', 'evaluate', 'evaluateHandle', 'screenshot', 'scrollIntoViewIfNeeded', 'selectText', 'elementHandle', 'elementHandles'];
const CALL = new RegExp(`([A-Za-z_$][\\w$]*|[)\\]])\\s*\\.\\s*(${TWO_STEP.join('|')})\\s*\\(`, 'g');
const PAGE_RECEIVER = 'page';
const MARKER = /\/\/\s*atomic-ok:\s*\S/;

// 把注释与字符串内容替换为空格（保留换行与长度，行号不变），避免注释/文案里提到方法名时误报。
export function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i], next = source[i + 1];
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') { out += ' '; i++; } continue; }
    if (ch === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { out += source[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch; out += ' '; i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { out += '  '; i += 2; continue; }
        out += source[i] === '\n' ? '\n' : ' '; i++;
      }
      out += ' '; i++; continue;
    }
    out += ch; i++;
  }
  return out;
}

export function findTwoStepCalls(source) {
  const code = stripCommentsAndStrings(source);
  const lines = source.split('\n');
  const findings = [];
  for (const match of code.matchAll(CALL)) {
    const [, receiver, method] = match;
    if (receiver === PAGE_RECEIVER) continue;
    const line = code.slice(0, match.index).split('\n').length;
    const here = lines[line - 1] || '';
    let prev = line - 2;
    while (prev >= 0 && !lines[prev].trim()) prev--;
    if (MARKER.test(here) || (prev >= 0 && MARKER.test(lines[prev]))) continue;
    findings.push({ line, method, text: here.trim().slice(0, 120) });
  }
  return findings;
}

test('two-step lint: flags locator two-step calls, allows page-level calls and justified opt-outs', () => {
  const flagged = [
    "await row.evaluate(node => node.scrollTop);",
    "await page.locator('#x').boundingBox();",
    "await page.locator('#x')\n    .first()\n    .evaluate(el => el.id);",
    "const h = await input.elementHandle();",
    "await seg.scrollIntoViewIfNeeded();",
    "await card.screenshot({ path: 'a.png' });",
    "await list.elementHandles();",
    "await getRow()[0].evaluate(el => el.id);",
  ];
  for (const sample of flagged) assert.equal(findTwoStepCalls(sample).length, 1, `应报出：${sample}`);
  const allowed = [
    "await page.evaluate(() => document.title);",
    "await page.screenshot({ path: 'a.png' });",
    "await page.locator('#x').evaluateAll(nodes => nodes.length);",
    "await page.locator('#x').innerText();",
    "// 注释里提到 locator.evaluate 先定位、后执行，不算",
    "const note = 'row.evaluate(x) 只是文案';",
    "const tpl = `seg.boundingBox() 也只是文案`;",
    "/* card.screenshot() 在块注释里 */",
    "// atomic-ok: 输入框有内容、卡片被钉住，本意是校验同一节点存活\nconst h = await input.elementHandle();",
    "const h = await input.elementHandle(); // atomic-ok: 卡片被钉住",
  ];
  for (const sample of allowed) assert.deepEqual(findTwoStepCalls(sample), [], `不应报出：${sample}`);
  // 放行注释必须写理由；空理由不算
  assert.equal(findTwoStepCalls("// atomic-ok:\nconst h = await input.elementHandle();").length, 1, '空理由的 atomic-ok 不放行');
  // 放行只管紧邻的下一行，隔一段代码不算
  assert.equal(findTwoStepCalls("// atomic-ok: 理由\nconst a = 1;\nconst h = await input.elementHandle();").length, 1, 'atomic-ok 只放行同一行或紧邻上一行');
  // 行号准确（报错信息要能直接定位）
  assert.equal(findTwoStepCalls("const a = 1;\n\nawait row.evaluate(x => x);")[0].line, 3);
});

test('browser regression files contain no unjustified two-step element reads/writes', () => {
  const dir = new URL('./', import.meta.url);
  const files = readdirSync(dir).filter(name => name.endsWith('.mjs') && /from\s+['"]@?playwright/.test(readFileSync(new URL(name, dir), 'utf8')));
  assert.ok(files.length >= 4, `应扫描到浏览器回归文件，实际：${files.join(', ')}`);
  const problems = files.flatMap(name => findTwoStepCalls(readFileSync(new URL(name, dir), 'utf8')).map(item => `${name}:${item.line} .${item.method}()  ${item.text}`));
  assert.deepEqual(problems, [], `以下调用会在 2 秒整块重建时读到已摘除节点；改为单个 page.evaluate 在页面内定位并完成读写，或在同一行/上一行写 // atomic-ok: <理由>：\n${problems.join('\n')}`);
});
