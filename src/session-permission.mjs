// 按会话 kind 的 ACP 权限裁定（纯函数，无副作用；审计与连接由 scheduling-session.mjs 负责）。
// 原则：提示词护栏无强制层不构成约束，权限在这里机械化强制；任何无法识别的请求一律 fail closed。
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const HUB_SERVER = 'autoloop-hub';
export const HUB_READ_TOOLS = ['list_rules', 'list_runs', 'list_cards', 'read_console_doc'];
// 受控写：自愈恢复/暂停/重触发。
export const HUB_WRITE_TOOLS = ['resume_rule', 'pause_rule', 'run_rule'];

// 普通会话允许直推的分支前缀；其余（main/master/release/裸 HEAD/tag 等）一律拒绝。
const FEATURE_BRANCH = /^(feat|fix|hotfix|chore|docs|refactor|test|perf|ci|build)\/[A-Za-z0-9._/-]+$/;
const WRAPPERS = new Set(['env', 'sudo', 'command', 'time', 'nohup', 'exec', 'nice', 'builtin', 'xargs']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);
const PUSH_OPTION_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const PUSH_DENIED_FLAGS = new Set(['--force', '--force-if-includes', '--delete', '--mirror', '--all', '--prune']);

export const deny = reason => ({ allow: false, reason });
export const permit = reason => ({ allow: true, reason });
// 需要主人当场决定：不自动放行也不硬拒绝，由会话内决策卡把请求交给主人（allow_once / reject_once 二选一）。
export const ask = reason => ({ allow: false, ask: true, reason });

// ---- 路径边界 ----
function resolveReal(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try { return path.join(realpathSync(current), ...rest.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

// target 必须在 root 内（realpath 后比较）；目标本身是符号链接一律拒绝；尚不存在的新文件按最近存在的祖先解析。
export function isWithin(root, target) {
  if (!root || !target || !path.isAbsolute(target)) return false;
  let realRoot;
  try { realRoot = realpathSync(root); } catch { return false; }
  try { if (lstatSync(target).isSymbolicLink()) return false; }
  catch (error) { if (error.code !== 'ENOENT') return false; }
  const resolved = resolveReal(target);
  return Boolean(resolved) && (resolved === realRoot || resolved.startsWith(realRoot + path.sep));
}

// ---- shell 命令分析（普通会话）----
function tokenize(command) {
  const segments = [];
  let tokens = []; let text = ''; let quoted = false; let has = false; let quote = null;
  const endToken = () => { if (has) tokens.push({ text, quoted }); text = ''; quoted = false; has = false; };
  const endSegment = () => { endToken(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") { if (ch === "'") quote = null; else text += ch; continue; }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) { text += command[++i]; continue; }
      if (ch === '"') quote = null; else text += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; quoted = true; has = true; continue; }
    if (ch === '\\' && i + 1 < command.length) { text += command[++i]; has = true; continue; }
    if (/\s/.test(ch) && ch !== '\n') { endToken(); continue; }
    if (';&|\n(){}'.includes(ch)) { endSegment(); continue; }
    text += ch; has = true;
  }
  endSegment();
  return segments;
}

function analyzePush(args) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (PUSH_DENIED_FLAGS.has(arg) || arg.startsWith('--force-with-lease') || arg.startsWith('--delete=')) return deny(`禁止 git push ${arg}`);
    if (/^-[A-Za-z]+$/.test(arg) && /[fd]/.test(arg.slice(1))) return deny(`禁止 git push ${arg}（强推/删除）`);
    if (PUSH_OPTION_WITH_VALUE.has(arg)) { i += 1; continue; }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  if (positional.length < 2) return ask('git push 没有显式写出远端与分支名（裸 push / HEAD 推断），需要主人确认');
  for (const spec of positional.slice(1)) {
    if (spec.startsWith('+')) return deny('禁止强制推送 refspec（+）');
    if (spec.startsWith(':')) return deny('禁止删除远端分支（:ref）');
    const parts = spec.split(':');
    if (parts.length > 2) return deny(`无法识别的 refspec：${spec}`);
    const dst = (parts[1] ?? parts[0]).replace(/^refs\/heads\//, '');
    if (dst.includes('..') || !FEATURE_BRANCH.test(dst)) return ask(`直推 ${dst} 不在预授权范围（预授权只含 feat|fix|hotfix|chore|docs|refactor|test|perf|ci|build/<topic> 分支），需要主人确认`);
  }
  return permit('feature 分支推送');
}

function analyzeSegment(tokens, depth) {
  let list = tokens.slice();
  const stripAssignments = () => { while (list.length && !list[0].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[0].text)) list.shift(); };
  stripAssignments();
  while (list.length && WRAPPERS.has(path.basename(list[0].text))) {
    list.shift();
    while (list.length && (list[0].text.startsWith('-') || (!list[0].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[0].text)))) list.shift();
  }
  if (!list.length) return permit('空命令');
  const command = path.basename(list[0].text);
  if (SHELLS.has(command)) {
    const flagIndex = list.findIndex((token, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(token.text));
    if (flagIndex > 0 && list[flagIndex + 1]) return analyzeCommand(list[flagIndex + 1].text, depth + 1);
    return permit('shell 脚本文件（内容不可见）');
  }
  if (command === 'eval') return analyzeCommand(list.slice(1).map(token => token.text).join(' '), depth + 1);
  if (command === 'git') {
    let i = 1;
    while (i < list.length && list[i].text.startsWith('-')) i += GIT_GLOBAL_WITH_VALUE.has(list[i].text) ? 2 : 1;
    if (list[i]?.text === 'push') return analyzePush(list.slice(i + 1).map(token => token.text));
  }
  return permit('非 push 命令');
}

export function analyzeCommand(command, depth = 0) {
  if (depth > 4) return deny('命令嵌套过深，无法审查');
  const text = String(command || '');
  let pending = null; // ask 先记下：同一命令里只要有一处硬拒绝，整条按拒绝处理
  const take = result => { if (!result.allow && !result.ask) return result; if (result.ask && !pending) pending = result; return null; };
  for (const match of text.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const hit = take(analyzeCommand(match[1] ?? match[2], depth + 1));
    if (hit) return hit;
  }
  for (const segment of tokenize(text)) {
    const hit = take(analyzeSegment(segment, depth));
    if (hit) return hit;
  }
  return pending || permit('命令检查通过');
}

// ---- 权限矩阵 ----
const text = value => (typeof value === 'string' ? value : '');
function commandOf(call) {
  const raw = call.rawInput ?? call.input;
  const command = raw && typeof raw === 'object' ? raw.command : null;
  if (Array.isArray(command)) return command.map(String).join(' ');
  return text(command) || text(call.title);
}
function cwdOf(call) {
  const raw = call.rawInput ?? call.input;
  return raw && typeof raw === 'object' ? text(raw.cwd) : '';
}

// 合并适配器此前通过 tool_call 通知上报的信息（权限请求常只带 toolCallId）。
export function mergeCall(known, toolCall) {
  const merged = { ...(known || {}) };
  for (const [key, value] of Object.entries(toolCall || {})) if (value !== undefined && value !== null) merged[key] = value;
  return merged;
}

// kind: normal | scheduling | design。返回 { allow, reason, toolKind, command, paths, optionId }。
export function decideByKind({ kind, params, known, workspace, writableDir }) {
  const call = mergeCall(known, params?.toolCall);
  const toolKind = text(call.kind) || null;
  const paths = (Array.isArray(call.locations) ? call.locations : []).map(location => text(location?.path)).filter(Boolean);
  const command = toolKind === 'execute' ? commandOf(call).slice(0, 400) : '';
  const base = { toolKind, title: text(call.title).slice(0, 200), command, paths };
  const allowOnce = (params?.options || []).find(option => option?.kind === 'allow_once');
  // 拒绝路径优先选 reject_once（没有再选 reject_always）：ACP 协议没有「拒绝」outcome，
  // 若不选 reject 就只能回 cancelled——而 cancelled 的协议语义是「用户打断了本轮」，
  // 上游 agent 会把它误报成主人取消（2026-11-26 设计会话假「取消」事故）。
  const rejectOnce = (params?.options || []).find(option => option?.kind === 'reject_once')
    || (params?.options || []).find(option => option?.kind === 'reject_always');
  const result = verdict => {
    // 批准路径必须有 allow_once 才回 selected；缺失即 fail closed（走拒绝路径，绝不回裸 selected）。
    if ((verdict.allow || verdict.ask) && !allowOnce) verdict = deny('批准路径没有 allow_once 选项（不选 allow_always）');
    return { ...base, ...verdict, optionId: verdict.allow ? allowOnce.optionId : (rejectOnce?.optionId ?? null), allowOptionId: allowOnce?.optionId ?? null, rejectOptionId: rejectOnce?.optionId ?? null };
  };
  if (!allowOnce && !rejectOnce) return result(deny('请求没有 allow_once/reject_once 选项（不选 allow_always）'));

  // 标题可被工具自报：带 command 的请求是 shell 执行，不论标题怎么写都必须落入 execute 分析，不能按 MCP 放行。
  const rawInput = call.rawInput ?? call.input;
  const hasCommand = rawInput && typeof rawInput === 'object' && rawInput.command != null && rawInput.command !== '';
  const mcp = hasCommand ? null : /^mcp\.([^.\s]+)\.(\S+)$/.exec(text(call.title));
  if (mcp) {
    if (kind === 'scheduling' && mcp[1] === HUB_SERVER && [...HUB_READ_TOOLS, ...HUB_WRITE_TOOLS].includes(mcp[2])) return result(permit(`Hub 工具 ${mcp[2]}`));
    return result(kind === 'scheduling' ? deny(`${kind} 会话不允许 MCP 工具 ${mcp[1]}.${mcp[2]}`) : ask(`请求使用 MCP 工具 ${mcp[1]}.${mcp[2]}，需要主人确认`));
  }
  if (!toolKind) return result(kind === 'scheduling' ? deny('无法识别的权限请求（fail closed）') : ask('无法识别的权限请求，需要主人确认'));

  if (toolKind === 'read' || toolKind === 'search' || toolKind === 'think') return result(permit('只读操作'));
  // 设计会话（计划未放行）：只读沙箱 + Plan Mode。除只读操作外的提权请求不静默拒绝，交给主人在会话内决策卡里决定。
  if (kind === 'design') return result(ask('设计会话（计划未放行）请求越出只读范围的操作，需要主人确认'));
  if (toolKind === 'edit') {
    const root = kind === 'scheduling' ? writableDir : workspace;
    if (!root) return result(deny('没有可写范围'));
    if (!paths.length) return result(deny('编辑请求缺少文件路径'));
    if (paths.every(file => isWithin(root, file))) return result(permit(kind === 'scheduling' ? '调度脚本目录内编辑' : '项目工作区内编辑'));
    return result(kind === 'scheduling' ? deny('调度会话只能编辑 AGENT_AUTOLOOP_HOME/scripts') : ask('写入越出项目工作区，需要主人确认'));
  }
  if (kind === 'scheduling') return result(deny(`调度会话不允许 ${toolKind}（shell/网络/合并等远端动作由派发的 worker 执行）`));
  // 以下仅普通会话（含已放行落盘的设计会话）：GitHub 推送 feature 分支 / 开 PR / 合并 PR 已由主人预授权给所有会话。
  if (toolKind === 'fetch') return result(permit('网络访问'));
  if (toolKind === 'execute') {
    if (!command) return result(deny('无法取得待执行命令（fail closed）'));
    const cwd = cwdOf(call);
    if (cwd && !isWithin(workspace, cwd)) return result(ask('命令工作目录越出项目工作区，需要主人确认'));
    return result(analyzeCommand(command));
  }
  return result(ask(`${kind === 'normal' ? '普通' : kind}会话请求 ${toolKind} 类操作，需要主人确认`));
}
