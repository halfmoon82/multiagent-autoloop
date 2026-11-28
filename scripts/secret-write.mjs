#!/usr/bin/env node
// 密钥写入 CLI：值只从 stdin 读取（TTY 下隐藏输入、需二次确认），绝不作为命令行参数。
//   node scripts/secret-write.mjs <key>      key 见 src/secret-write.mjs 的允许列表
//   管道（测试用）：第 1 行为值；若有第 2 行则作为确认值，须一致。
import { writeSecret, ALLOWED_KEYS, SecretWriteError } from '../src/secret-write.mjs';

const fail = (message, code = 1) => { console.error(message); process.exit(code); };
const args = process.argv.slice(2);
const allowed = Object.keys(ALLOWED_KEYS).join('、');
if (args.length !== 1) fail(`用法：secret-write.mjs <key>（值从 stdin 输入，不可作为参数）。可用 key：${allowed}`);
const [key] = args;
if (!Object.hasOwn(ALLOWED_KEYS, key)) fail(`不允许的 key，可用：${allowed}`);

function promptHidden(label) {
  return new Promise(resolve => {
    const { stdin, stderr } = process;
    let buf = '';
    stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\u0003') { stdin.setRawMode(false); stderr.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stderr.write('\n');
          return resolve(buf);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPiped() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

try {
  let value; let confirm;
  if (process.stdin.isTTY) {
    value = await promptHidden('输入密钥（不回显）：');
    confirm = await promptHidden('再输入一次确认：');
  } else {
    [value, confirm] = await readPiped();
  }
  if (!value) fail('值为空，未写入');
  if (confirm !== undefined && confirm !== '' && confirm !== value) fail('两次输入不一致，未写入');
  if (process.stdin.isTTY && confirm !== value) fail('两次输入不一致，未写入');
  const result = writeSecret({ root: process.env.AGENT_AUTOLOOP_HOME, key, value });
  console.log(`已写入 ${result.location}`);
} catch (error) {
  fail(error instanceof SecretWriteError ? error.message : '写入失败');
}
