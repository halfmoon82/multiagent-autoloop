// 调度会话每轮的资料包：项目 AGENTS.md + 调度契约 + 状态快照 + 上一轮结论 + 未收尾事项。
// Hub 事件 detail 上限 4000 字节，正文只放「先读这个文件」的一行路径提示，完整资料落盘到运行目录。
// 本模块只做文件组装与预算校验：Hub/HTTP 依赖一律由调用方经 provider 回调注入。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CONTEXT_DIR = 'scheduling-context';
export const EVENT_DETAIL_LIMIT = 4000;
export const EVENT_DETAIL_BUDGET = 3950;

const MAX_AGENTS_MD_BYTES = 60 * 1024;
const MAX_CONTRACT_BYTES = 12 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024;
// 上一轮结论上限与会话转录回显上限一致（run-output.mjs 的 MAX_FINAL_MESSAGE_CHARS），超出时注明，不静默截断。
const MAX_SUMMARY_CHARS = 8000;
// 交接段里更早几轮的问答，每条只留摘要长度：要的是「之前在聊什么」，全文仍在会话转录里。
const MAX_EARLIER_CHARS = 600;
export const HANDOVER_ROUNDS = 3;
// 每节列多少条：规则多给一些（本项目规则已排前），其余按最近在前。超出时注明总数，绝不静默截断。
export const SECTION_LIMITS = Object.freeze({ rules: 20, runs: 10, cards: 10, dag: 10 });
const TRUNCATED_NOTE = cap => `[已截断：原文超过 ${cap} 字节，完整内容见原文路径]`;

function readCapped(file, cap) {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') <= cap) return raw;
    // 按字节截断：slice(0, cap) 是字符数不是字节数，多字节字符会超预算；逐字符累加字节才可靠。
    let out = '';
    let bytes = 0;
    for (const ch of raw) {
      const size = Buffer.byteLength(ch, 'utf8');
      if (bytes + size > cap) break;
      out += ch;
      bytes += size;
    }
    return `${out}\n\n${TRUNCATED_NOTE(cap)}（原文：${file}）`;
  } catch { return null; }
}

const line = text => `- ${String(text ?? '').replace(/[\r\n]+/g, ' ').trim()}`;

function section(title, items, { empty = '（无）', limit = 10 } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return `### ${title}（共 0 条）\n${empty}`;
  const shown = list.slice(0, limit);
  const note = list.length > shown.length ? `\n（共 ${list.length} 条，此处只列前 ${shown.length} 条；其余未列出，不代表不存在）` : '';
  return `### ${title}（共 ${list.length} 条）\n${shown.map(line).join('\n')}${note}`;
}

/** 状态快照：由调用方提供 provider（读 Hub/本地台账），本函数只排格式与截断；任一节异常降级为可读占位。 */
export function buildSnapshotSection(providers = {}) {
  const parts = [];
  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
  return (async () => {
    parts.push(section('规则（名称｜事件类型｜agent｜暂停，本项目规则在前）', await safe(providers.rules, []), { limit: SECTION_LIMITS.rules }));
    parts.push(section('最近轮次（run｜规则｜执行者｜状态｜失败原因｜费用，最近在前）', await safe(providers.runs, []), { limit: SECTION_LIMITS.runs }));
    parts.push(section('待处理卡片（编号｜标题｜规则）', await safe(providers.cards, []), { limit: SECTION_LIMITS.cards }));
    parts.push(section('DAG 运行（runId｜计划｜状态）', await safe(providers.dag, []), { limit: SECTION_LIMITS.dag }));
    let text = `## 状态快照\n${parts.join('\n')}`;
    if (Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_BYTES) {
      let out = '';
      let bytes = 0;
      for (const ch of text) {
        const size = Buffer.byteLength(ch, 'utf8');
        if (bytes + size > MAX_SNAPSHOT_BYTES) break;
        out += ch;
        bytes += size;
      }
      text = `${out}\n\n${TRUNCATED_NOTE(MAX_SNAPSHOT_BYTES)}`;
    }
    return text;
  })();
}

/**
 * 从会话转录配出最近几轮「用户原话 → 回答」。一轮 = 连续的 user 消息（排队可能多条）+ 其后的第一条 agent 回答；
 * 结尾还没回答的 user 消息（本轮正在发的）不算。最新的在最后。
 */
export function exchangesFrom(messages = [], { rounds = 3 } = {}) {
  const out = [];
  let pending = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'user') pending.push(String(message.text ?? ''));
    else if (message?.role === 'agent') {
      out.push({ user: pending.join('\n\n'), agent: String(message.text ?? '') });
      pending = [];
    }
  }
  return out.slice(-rounds);
}

const capChars = (text, max, note) => {
  const chars = [...String(text ?? '')];
  return chars.length > max ? `${chars.slice(0, max).join('')}\n${note(max, chars.length)}` : chars.join('');
};

/** 交接段：上一轮用户原话全文 + 更早几轮的问答摘要。换执行者后新会话没有聊天记忆，只能靠它知道「问了什么」。 */
export function handoverSection(exchanges = []) {
  if (!exchanges.length) return '';
  const previous = exchanges.at(-1);
  const parts = [];
  if (previous.user) {
    parts.push('## 上一轮用户原话（完整）\n', capChars(previous.user, MAX_SUMMARY_CHARS, (max, total) => `[已截断：上一轮用户原话共 ${total} 字，此处只列前 ${max} 字，完整内容见会话转录]`), '\n');
  }
  const earlier = exchanges.slice(0, -1);
  if (earlier.length) {
    const cut = (max, total) => `[已截断：原文 ${total} 字，此处只列前 ${max} 字]`;
    parts.push(`## 更早的对话（最近 ${earlier.length} 轮，旧的在前，每条最多 ${MAX_EARLIER_CHARS} 字）\n`);
    earlier.forEach((exchange, index) => {
      parts.push(`### 往前第 ${earlier.length - index + 1} 轮`, `- 用户：${capChars(exchange.user || '（无）', MAX_EARLIER_CHARS, cut)}`, `- 回答：${capChars(exchange.agent, MAX_EARLIER_CHARS, cut)}`, '');
    });
  }
  return parts.join('\n');
}

/**
 * 组装并写出本轮资料文件，返回绝对路径；不可写/缺参数时返回 null（调用方退回无提示的行为）。
 * providers: { rules, runs, cards, dag } 各返回字符串数组（每元素一条概要行），同步/异步皆可。
 * prevAgent：上一轮执行者标注（如 'claude'），换执行者后首轮提示词据此自报身份；未知传 null。
 * guide：调度会话护栏/任务说明（首轮的调度提示词），放进资料文件而不是事件正文，避免挤掉用户原话。
 * exchanges：exchangesFrom(转录) 的结果；有则写交接段（上一轮用户原话 + 更早问答），并以其最后一轮回答作上一轮结论。
 */
export async function buildSchedulingContext({ root, sessionId, turn, project, lastSummary = '', openItems = '', prevAgent = null, providers = {}, guide = '', userText = '', exchanges = [] } = {}) {
  if (!root || !sessionId) return null;
  // project 允许不存在：AGENTS.md/契约找不到时按「（未找到）」占位，资料照常落盘——
  // 项目路径本身也是资料，缺路径不应阻断每轮上下文。
  const agents = project ? readCapped(path.join(project, 'AGENTS.md'), MAX_AGENTS_MD_BYTES) : null;
  const contract = project ? readCapped(path.join(project, 'docs', 'scheduling-contract.md'), MAX_CONTRACT_BYTES) : null;
  const snapshot = await buildSnapshotSection(providers);
  const parts = [`# 调度会话本轮资料\n`, `- 项目：${project}`, `- 会话：${sessionId}`, `- 轮次：${turn}`];
  if (prevAgent) parts.push(`- 上一轮执行者：${prevAgent}（若本轮换了执行者，第一行必须自报：我是备用执行者，上一轮由 ${prevAgent} 执行；从本文件重建上下文，不得假装记得聊天历史）`);
  // 用户原话全文：事件正文受 Hub 上限可能被截断，这里保留完整版本，worker 以此为准。
  if (userText) parts.push('\n## 本轮用户原话（完整）\n', String(userText), '\n');
  if (guide) parts.push('\n## 调度会话护栏与任务\n', String(guide), '\n');
  parts.push('\n## 项目 AGENTS.md\n', agents || '（未找到 AGENTS.md）\n');
  if (contract) parts.push('\n## 调度契约（docs/scheduling-contract.md，截断版）\n', contract);
  parts.push('\n', snapshot);
  const handover = handoverSection(exchanges);
  if (handover) parts.push('\n', handover);
  if (lastSummary) {
    const chars = [...String(lastSummary)];
    const cut = chars.length > MAX_SUMMARY_CHARS;
    parts.push('\n## 上一轮结论\n', chars.slice(0, MAX_SUMMARY_CHARS).join(''), cut ? `\n[已截断：上一轮结论超过 ${MAX_SUMMARY_CHARS} 字，完整内容见会话转录]` : '', '\n');
  }
  if (openItems) parts.push('\n## 未收尾事项\n', String(openItems), '\n');
  const dir = path.join(root, CONTEXT_DIR);
  const file = path.join(dir, `${sessionId}-turn${turn}.md`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, parts.join('\n'), { mode: 0o600 });
    renameSync(tmp, file);
    return file;
  } catch { return null; }
}

/** 事件正文尾部提示；没有资料文件时返回空串。 */
export function contextTrailer(file) {
  return file ? `\n\n本轮完整资料（项目规则、状态快照与上一轮结论）：${file}；动手前先读它。` : '';
}

const TRUNCATED_MARK = '\n[已截断：完整原话见本轮资料文件「本轮用户原话（完整）」]';
// Hub 字段上限按 Unicode 码点计算（protocol.md「文字上限按 Unicode 码点计算」）。
export const codePoints = text => [...String(text ?? '')].length;
const detailSize = (project, text) => codePoints(JSON.stringify({ project, text }));

/**
 * 合成最终事件文本：以序列化后的 detail（JSON.stringify({project,text})）为准，码点数 ≤ limit（默认 3950）。
 * JSON 转义（换行→\n 两字符、引号）与 project 路径都计入。提示必须完整保留：先截正文；
 * 连提示都放不下时整段丢弃提示（宁缺不残）。
 */
export function composeTurnText({ text, trailer, project = '', limit = EVENT_DETAIL_BUDGET }) {
  const body = [...String(text ?? '')];
  const hint = String(trailer ?? '');
  const whole = `${body.join('')}${hint}`;
  if (detailSize(project, whole) <= limit) return whole;
  const keepHint = detailSize(project, `${TRUNCATED_MARK}${hint}`) <= limit;
  const tail = keepHint ? `${TRUNCATED_MARK}${hint}` : TRUNCATED_MARK;
  // 二分找能放下的最长正文前缀（码点粒度，不会切断多字节字符或转义序列）。
  let low = 0;
  let high = body.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (detailSize(project, `${body.slice(0, mid).join('')}${tail}`) <= limit) low = mid;
    else high = mid - 1;
  }
  return `${body.slice(0, low).join('')}${tail}`;
}

/** /v1/state 的 runs 只有 id，没有 lane：按 run.events[].subject 归属事项。 */
export function runsOfSubject(state, subject) {
  const runs = Array.isArray(state?.runs) ? state.runs : [];
  if (!subject) return [];
  return runs.filter(run => Array.isArray(run?.events) && run.events.some(event => event?.subject === subject));
}

/** 上一轮执行者：同事项最近一条已结束（done/nothing）轮次的 agent；拿不到返回 null，不编造。 */
export function prevAgentFrom(state, subject) {
  const finished = runsOfSubject(state, subject)
    .filter(run => run.state === 'done' || run.state === 'nothing')
    .sort((a, b) => Number(b.id) - Number(a.id));
  return finished[0]?.agent ?? null;
}

/** 同事项是否还有未收尾卡片（cards[].lane 是 parallel 规则的事件对象）。 */
export function hasOpenCardsFor(state, subject) {
  const cards = Array.isArray(state?.cards) ? state.cards : [];
  return cards.some(card => card?.state === 'open' && (!subject || card.lane === subject));
}

/** 「继续/已解决」这类没有具体内容的续接话术（空上下文守卫只拦这一类）。 */
export function isBareContinuation(text) {
  return /^\s*(继续|接着|好了?|已解决|已处理|搞定|done|ok|继续吧|continue)\s*[。.!！]*\s*$/i.test(String(text ?? ''));
}

/** 快照行：按 /v1/state 真实字段（runs[].id、usage.cost、lines[].paused）排版。 */
export function snapshotLinesFrom(state, { project = '', ruleCwds = new Map() } = {}) {
  const lines = Array.isArray(state?.lines) ? state.lines : [];
  const runs = Array.isArray(state?.runs) ? [...state.runs].sort((a, b) => Number(b.id) - Number(a.id)) : [];
  const cards = Array.isArray(state?.cards) ? state.cards.filter(card => card?.state === 'open') : [];
  const cost = usage => (typeof usage?.cost === 'number' ? `｜$${usage.cost.toFixed(4)}` : '｜费用未上报');
  // /v1/state 的 lines 不带 cwd：规则名 → cwd 由调用方从 rules.json 对出；project 下的规则排最前，暂停的其次。
  const inProject = name => {
    const cwd = ruleCwds.get(name);
    return Boolean(project && cwd && (cwd === project || cwd.startsWith(`${project}/`)));
  };
  const rank = line => (inProject(line.name) ? 0 : line.paused ? 1 : 2);
  const ordered = lines.map((line, index) => ({ line, index })).sort((a, b) => rank(a.line) - rank(b.line) || a.index - b.index).map(item => item.line);
  return {
    rules: ordered.map(line => `${line.name}｜${Array.isArray(line.types) && line.types.length ? line.types.join(',') : line.every || '定时'}｜${line.agent || '未配置'}${line.paused ? `｜已暂停:${line.paused.reason || ''}` : ''}${inProject(line.name) ? '｜本项目' : ''}`),
    runs: runs.map(run => `#${run.id}｜${run.rule}｜${run.agent || '未知'}｜${run.state}${run.error ? `｜${String(run.error).slice(0, 80)}` : ''}${cost(run.usage)}`),
    cards: cards.map(card => `#${card.id}｜${String(card.title || '').slice(0, 60)}｜${card.rule || '未关联'}`),
  };
}

export function truncateToBytes(text, bytes) {
  const raw = String(text ?? '');
  if (Buffer.byteLength(raw, 'utf8') <= bytes) return raw;
  let out = '';
  let used = 0;
  for (const ch of raw) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > bytes) break;
    out += ch;
    used += size;
  }
  return out;
}
