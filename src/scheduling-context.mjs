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
const MAX_SUMMARY_CHARS = 1200;
const MAX_SECTION_ITEMS = 5;
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

function section(title, items, { empty = '（无）' } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const body = list.length ? list.slice(0, MAX_SECTION_ITEMS).map(line).join('\n') : empty;
  return `### ${title}\n${body}`;
}

/** 状态快照：由调用方提供 provider（读 Hub/本地台账），本函数只排格式与截断；任一节异常降级为可读占位。 */
export function buildSnapshotSection(providers = {}) {
  const parts = [];
  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
  return (async () => {
    parts.push(section('规则（名称｜事件类型｜agent｜暂停）', await safe(providers.rules, [])));
    parts.push(section('最近轮次（run｜规则｜状态｜失败原因｜费用）', await safe(providers.runs, [])));
    parts.push(section('待处理卡片（编号｜标题｜等待谁）', await safe(providers.cards, [])));
    parts.push(section('DAG 运行（runId｜计划｜节点状态/PR/阻塞）', await safe(providers.dag, [])));
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
 * 组装并写出本轮资料文件，返回绝对路径；不可写/缺参数时返回 null（调用方退回无提示的行为）。
 * providers: { rules, runs, cards, dag } 各返回字符串数组（每元素一条概要行），同步/异步皆可。
 * prevAgent：上一轮执行者标注（如 'claude'），换执行者后首轮提示词据此自报身份；未知传 null。
 */
export async function buildSchedulingContext({ root, sessionId, turn, project, lastSummary = '', openItems = '', prevAgent = null, providers = {} } = {}) {
  if (!root || !sessionId) return null;
  // project 允许不存在：AGENTS.md/契约找不到时按「（未找到）」占位，资料照常落盘——
  // 项目路径本身也是资料，缺路径不应阻断每轮上下文。
  const agents = project ? readCapped(path.join(project, 'AGENTS.md'), MAX_AGENTS_MD_BYTES) : null;
  const contract = project ? readCapped(path.join(project, 'docs', 'scheduling-contract.md'), MAX_CONTRACT_BYTES) : null;
  const snapshot = await buildSnapshotSection(providers);
  const parts = [`# 调度会话本轮资料\n`, `- 项目：${project}`, `- 会话：${sessionId}`, `- 轮次：${turn}`];
  if (prevAgent) parts.push(`- 上一轮执行者：${prevAgent}（若本轮换了执行者，第一行必须自报：我是备用执行者，上一轮由 ${prevAgent} 执行；从本文件重建上下文，不得假装记得聊天历史）`);
  parts.push('\n## 项目 AGENTS.md\n', agents || '（未找到 AGENTS.md）\n');
  if (contract) parts.push('\n## 调度契约（docs/scheduling-contract.md，截断版）\n', contract);
  parts.push('\n', snapshot);
  if (lastSummary) parts.push('\n## 上一轮结论\n', String(lastSummary).slice(0, MAX_SUMMARY_CHARS), '\n');
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

/**
 * 把用户正文与资料提示合成最终事件 detail 的 text；总字节数 ≤ budget（默认 3950）。
 * 提示必须完整保留：先截正文，截到放不下提示时整段丢弃提示（宁缺不残）。
 */
export function composeTurnText({ text, trailer, budget = EVENT_DETAIL_BUDGET }) {
  const body = String(text ?? '');
  const hint = String(trailer ?? '');
  const total = Buffer.byteLength(body, 'utf8') + Buffer.byteLength(hint, 'utf8');
  if (total <= budget) return `${body}${hint}`;
  const room = budget - Buffer.byteLength(hint, 'utf8');
  if (room < 32) return body.length > budget ? truncateToBytes(body, budget) : body;
  return `${truncateToBytes(body, room - Buffer.byteLength('\n[已截断]', 'utf8'))}\n[已截断]${hint}`;
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
