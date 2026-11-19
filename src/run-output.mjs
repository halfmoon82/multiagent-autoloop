// 读回一轮的完整最终回复：中台回执只保留最后一条消息的第一行（summary），
// 完整文字只在本机接单程序的执行目录里（<运行目录>/worker/runs/<run>-<attempt>/stdout-<n>.log，保留 14 天）。
// 只读、按已知插件输出格式解析（Codex `--json` 事件流、Claude `stream-json`），读不到返回 null，
// 调用方退回中台 summary。不执行、不改写执行目录里的任何东西。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const MAX_FINAL_MESSAGE_CHARS = 8000;
const RECEIPT_BLOCK = /```agent-autoloop[\s\S]*?```/g;
const RUN_DIR = /^(\d+)-(\d+)$/;
const STDOUT = /^stdout-(\d+)\.log$/;

function parseLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { const value = JSON.parse(line); if (value && typeof value === 'object') out.push(value); } catch { /* 登录 shell 的杂行等非 JSON 行跳过 */ }
  }
  return out;
}

/** 从一份 stdout 里取最终回复：Codex 取最后一条 agent_message，Claude 取最后一条 result。 */
export function finalMessageFromStdout(text) {
  const events = parseLines(text);
  const codex = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string');
  if (codex.length) return codex.at(-1).item.text;
  const claude = events.filter(event => event.type === 'result' && typeof event.result === 'string');
  if (claude.length) return claude.at(-1).result;
  return null;
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
export function readFinalMessage({ root, runId } = {}) {
  const id = Number(runId);
  if (!root || !Number.isSafeInteger(id) || id <= 0) return null;
  const runsDir = path.join(root, 'worker', 'runs');
  if (!existsSync(runsDir)) return null;
  let dirs;
  try {
    dirs = readdirSync(runsDir)
      .map(name => { const match = RUN_DIR.exec(name); return match && Number(match[1]) === id ? { name, attempt: Number(match[2]) } : null; })
      .filter(Boolean)
      .sort((a, b) => b.attempt - a.attempt);
  } catch { return null; }
  for (const { name } of dirs) {
    const dir = path.join(runsDir, name);
    let outputs = [];
    try {
      if (!statSync(dir).isDirectory()) continue;
      outputs = readdirSync(dir)
        .map(file => { const match = STDOUT.exec(file); return match ? { file, turn: Number(match[1]) } : null; })
        .filter(Boolean)
        .sort((a, b) => b.turn - a.turn);
    } catch { continue; }
    for (const { file } of outputs) {
      try {
        const message = cleanFinalMessage(finalMessageFromStdout(readFileSync(path.join(dir, file), 'utf8')));
        if (message) return message;
      } catch { /* 单份读不到就看更早的一份 */ }
    }
  }
  return null;
}
