// 读回一轮的完整最终回复：中台回执只保留最后一条消息的第一行（summary），
// 完整文字只在本机接单程序的执行目录里（<运行目录>/worker/runs/<run>-<attempt>/stdout-<n>.log，保留 14 天）。
// 只读、按已知插件输出格式解析（Codex `--json` 事件流、Claude `stream-json`），读不到返回 null，
// 调用方退回中台 summary。不执行、不改写执行目录里的任何东西。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const MAX_FINAL_MESSAGE_CHARS = 8000;
// 与上游 worker/contract.ts 的 BLOCK 同口径：只认行首的 ```agent-autoloop 代码块，正文里顺带提到的不误删。
const RECEIPT_BLOCK = /(?<=^|\n)[ \t]*```agent-autoloop[ \t]*\r?\n(?:[^\n]*\n)*?[ \t]*```[ \t]*(?=\r?\n|$)/g;
const RUN_DIR = /^(\d+)-(\d+)$/;
const STDOUT = /^stdout-(\d+)\.log$/;

function parseLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    // Claude 插件按 [JSON.parse(line)].flat() 读：同一行可能是事件数组。
    try { for (const value of [JSON.parse(line)].flat()) if (value && typeof value === 'object') out.push(value); } catch { /* 登录 shell 的杂行等非 JSON 行跳过 */ }
  }
  return out;
}

/**
 * 从一份 stdout 里取「这一轮真正交出的」最终回复，口径对齐上游插件 read()：
 * - Codex：必须出现 turn.completed，才取最后一条 agent_message（没跑完的只是半截，不算结论）；
 * - Claude：取最后一条 result，且必须 subtype === 'success' 且不是 is_error。
 * 不满足返回 null，调用方据此退回更早的一份输出（回执重写失败时接单程序同样退回原业务输出）。
 */
export function finalMessageFromStdout(text) {
  const events = parseLines(text);
  if (events.some(event => event.type === 'thread.started' || event.type === 'turn.started' || event.type === 'item.completed')) {
    if (!events.some(event => event.type === 'turn.completed')) return null;
    const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string');
    return messages.length ? messages.at(-1).item.text : null;
  }
  const result = events.filter(event => event.type === 'result').at(-1);
  if (!result || result.is_error || result.subtype !== 'success' || typeof result.result !== 'string') return null;
  return result.result;
}

/** 去掉回执代码块（结构化动作给中台用，不是给人看的），并收敛空行与长度。 */
export function cleanFinalMessage(text, max = MAX_FINAL_MESSAGE_CHARS) {
  const cleaned = String(text ?? '').replace(RECEIPT_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return null;
  const chars = [...cleaned];
  return chars.length > max ? `${chars.slice(0, max).join('')}\n…（已截断，完整输出见执行目录）` : cleaned;
}

/**
 * 读某一轮的完整最终回复。取最后一次执行（attempt 最大）的最后一份 stdout（回执重写会产生 stdout-2…）；
 * 最后一份解析不出时往前找。runId 必须是正整数，杜绝路径拼接越界。
 */
// 发现某轮的全部 stdout 文件（最新 attempt、最新 turn 在前），供最终/部分读取共用。
function listStdoutFiles(root, runId) {
  const id = Number(runId);
  if (!root || !Number.isSafeInteger(id) || id <= 0) return [];
  const runsDir = path.join(root, 'worker', 'runs');
  if (!existsSync(runsDir)) return [];
  let dirs;
  try {
    dirs = readdirSync(runsDir)
      .map(name => { const match = RUN_DIR.exec(name); return match && Number(match[1]) === id ? { name, attempt: Number(match[2]) } : null; })
      .filter(Boolean)
      .sort((a, b) => b.attempt - a.attempt);
  } catch { return []; }
  const files = [];
  for (const { name } of dirs) {
    const dir = path.join(runsDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const entry of readdirSync(dir)
        .map(file => { const match = STDOUT.exec(file); return match ? { file, turn: Number(match[1]) } : null; })
        .filter(Boolean)
        .sort((a, b) => b.turn - a.turn)) {
        files.push(path.join(dir, entry.file));
      }
    } catch { /* 单个目录读不到就跳过 */ }
  }
  return files;
}

export function readFinalMessage({ root, runId } = {}) {
  for (const file of listStdoutFiles(root, runId)) {
    try {
      const message = cleanFinalMessage(finalMessageFromStdout(readFileSync(file, 'utf8')));
      if (message) return message;
    } catch { /* 单份读不到就看更早的一份 */ }
  }
  return null;
}

// 运行中回显：不要求 turn.completed / result success——只要 worker 已吐出部分 agent 文本就返回，
// 让 Hub 会话在前端有流式输出（2026-11-25 真机反馈：Hub 会话整条等对账，期间毫无增量）。
export function partialMessageFromStdout(text) {
  const events = parseLines(text);
  const isCodex = events.some(event => event.type === 'thread.started' || event.type === 'turn.started'
    || event.type === 'item.completed' || event.type === 'turn.completed');
  if (isCodex) {
    const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string');
    return messages.length ? messages.map(message => message.item.text).join('\n') : null;
  }
  // Claude stream-json：同一 msg id 的后续事件内容更全，取最后一条带文本的 assistant 事件。
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'assistant') {
      const texts = (Array.isArray(event.message?.content) ? event.message.content : [])
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text);
      if (texts.length) return texts.join('\n');
    }
    if (event?.type === 'result' && typeof event.result === 'string' && event.result) return event.result;
  }
  return null;
}

export const MAX_PARTIAL_MESSAGE_CHARS = 20000;

/** 读某一轮当前已产出的部分回复（不要求完成）；读不到返回 null。长度收敛，避免长轮撑爆前端。 */
export function readPartialMessage({ root, runId, max = MAX_PARTIAL_MESSAGE_CHARS } = {}) {
  for (const file of listStdoutFiles(root, runId)) {
    try {
      const partial = partialMessageFromStdout(readFileSync(file, 'utf8'));
      if (partial && partial.trim()) {
        const chars = [...partial.trim()];
        return chars.length > max ? chars.slice(0, max).join('') + '\n…（输出过长，已截断实时预览）' : partial.trim();
      }
    } catch { /* 单份读不到就看更早的一份 */ }
  }
  return null;
}
