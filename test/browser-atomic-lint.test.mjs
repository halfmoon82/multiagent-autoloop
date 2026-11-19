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
const CALL = new RegExp(`([A-Za-z_$][\\w$]*|[)\\]])\\s*\\??\\.\\s*(${TWO_STEP.join('|')})\\s*\\(`, 'g');
// page：整页方法；document：页面内 DOM 自带的 document.evaluate（XPath），出现在推荐的 page.evaluate 写法里
const ALLOWED_RECEIVERS = new Set(['page', 'document']);
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
        if (source[i] === '\\') { out += source[i + 1] === '\n' ? ' \n' : '  '; i += 2; continue; } // 反斜杠续行保留换行，行号不偏
        if (source[i] === '\n' && quote !== '`') break; // 单/双引号字符串不跨行：正则字面量里的单个引号最多影响本行
        out += source[i] === '\n' ? '\n' : ' '; i++;
      }
      if (source[i] === quote) { out += ' '; i++; }
      continue;
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
    const [whole, receiver, method] = match;
    if (ALLOWED_RECEIVERS.has(receiver)) continue;
    const lineOf = offset => code.slice(0, offset).split('\n').length;
    const receiverLine = lineOf(match.index);
    const line = lineOf(match.index + whole.lastIndexOf(method)); // 报 .method( 所在行，跨行链式调用也能直接定位
    const codeLines = code.split('\n');
    const justified = target => {
      if (MARKER.test(lines[target - 1] || '')) return true; // 同一行（含行尾注释）
      let prev = target - 2;
      while (prev >= 0 && !lines[prev].trim()) prev--;
      // 紧邻上一行必须是整行注释：上一条语句行尾的 atomic-ok 只管它自己，不连带放行本行
      return prev >= 0 && !codeLines[prev].trim() && MARKER.test(lines[prev]);
    };
    let head = line; // 跨行链式调用的首行：自方法行向上越过以 . / ?. 开头的续行
    while (head > 1 && /^\s*\??\.(?!\.)/.test(codeLines[head - 1] || '')) head--; // ... 展开不是链式续行
    if (justified(line) || justified(receiverLine) || justified(head)) continue;
    findings.push({ line, method, text: (lines[line - 1] || '').trim().slice(0, 120) });
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
    "const v = await handle?.evaluate(el => el.id);", // 可选链（page.$() 句柄可能为 null）
    "const re = /'/;\nawait row.evaluate(x => x);", // 正则里的单引号不能吞掉下一行
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
    "await page.evaluate(() => document.evaluate('//a', document).iterateNext());", // 页面内 DOM 的 XPath API
    "// atomic-ok: 有意持有旧节点\nconst h = await page.locator('#x')\n  .first()\n  .elementHandle();", // 跨行：注释在语句首行上方
    "const h = await page.locator('#x')\n  .first() // atomic-ok: 有意持有旧节点\n  .elementHandle();", // 跨行：注释在接收者行
  ];
  for (const sample of allowed) assert.deepEqual(findTwoStepCalls(sample), [], `不应报出：${sample}`);
  // 放行注释必须写理由；空理由不算
  assert.equal(findTwoStepCalls("// atomic-ok:\nconst h = await input.elementHandle();").length, 1, '空理由的 atomic-ok 不放行');
  // 放行只管紧邻的下一行，隔一段代码不算
  assert.equal(findTwoStepCalls("// atomic-ok: 理由\nconst a = 1;\nconst h = await input.elementHandle();").length, 1, 'atomic-ok 只放行同一行或紧邻上一行');
  // 上一行是带行尾放行注释的「代码行」时，不能连带放行本行（只有整行注释才算紧邻上一行的放行）
  assert.equal(findTwoStepCalls("const a = await x.elementHandle(); // atomic-ok: pinned\nawait row.evaluate(y => y);").length, 1, '行尾 atomic-ok 不连带放行下一行');
  // 展开运算符 ... 开头的行不是链式续行，不能借数组首行的放行注释
  assert.equal(findTwoStepCalls("// atomic-ok: 只放行这一行\nconst list = [\n  ...(await row.evaluate(y => y)),\n];").length, 1, '... 开头不算链式续行');
  // 反斜杠续行的字符串不改变后续行号
  assert.equal(findTwoStepCalls("const s = 'a\\\nb';\nawait row.evaluate(y => y);")[0]?.line, 3, '反斜杠续行后行号不偏');
  // 行号准确（报错信息要能直接定位）：报方法所在行
  assert.equal(findTwoStepCalls("const a = 1;\n\nawait row.evaluate(x => x);")[0].line, 3);
  assert.equal(findTwoStepCalls("await page.locator('#x')\n  .first()\n  .evaluate(x => x);")[0].line, 3, '跨行链式调用报 .evaluate( 所在行');
});

test('browser regression files contain no unjustified two-step element reads/writes', () => {
  const dir = new URL('./', import.meta.url);
  const files = readdirSync(dir).filter(name => name.endsWith('.mjs') && /from\s+['"]@?playwright/.test(readFileSync(new URL(name, dir), 'utf8')));
  assert.ok(files.length >= 4, `应扫描到浏览器回归文件，实际：${files.join(', ')}`);
  const problems = files.flatMap(name => findTwoStepCalls(readFileSync(new URL(name, dir), 'utf8')).map(item => `${name}:${item.line} .${item.method}()  ${item.text}`));
  assert.deepEqual(problems, [], `以下调用会在 2 秒整块重建时读到已摘除节点；改为单个 page.evaluate 在页面内定位并完成读写，或在同一行/上一行写 // atomic-ok: <理由>（跨行链式调用写在链首行、接收者行或 .方法( 行的同一行/上一行均可；若命中的是 page.evaluate 回调里页面内 DOM 自带的同名方法，同样用 atomic-ok 注明）：\n${problems.join('\n')}`);
});
