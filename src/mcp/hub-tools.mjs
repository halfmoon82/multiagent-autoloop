// autoloop-hub：调度会话专用的只读 MCP server。
// 通过 stdio JSON-RPC 提供 list_rules / list_runs / list_cards 三个工具，
// 数据来自 Autoloop Hub（/v1/state）与 AGENT_AUTOLOOP_HOME 下的 rules.json。
// 安全边界：owner key 只用于 Hub 请求头，绝不进入工具输出、日志或 stderr。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConsoleConfig } from '../config.mjs';
import { hubRequest } from '../hub.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(MODULE_DIR, '..', '..');
export const SERVER_NAME = 'autoloop-hub';
export const SERVER_VERSION = '0.1.0';
const MAX_ITEMS = 50;

// 与前端 public/format.mjs 的 projectName 归一保持一致：路径或 basename 都可匹配。
export function projectName(cwd) {
  const text = String(cwd || '').trim().replace(/[\\/]+$/, '');
  if (!text) return '未识别';
  const base = text.split(/[\\/]/).filter(Boolean).pop();
  return base || text;
}

export function matchesProject(value, filter) {
  if (!filter) return true;
  return projectName(value) === projectName(filter);
}

function scheduleLabel(rule) {
  if (rule.when?.cron) return `定时 · ${rule.when.cron}`;
  if (rule.when?.source) return `${rule.when.source} · ${(rule.when.types || []).join(', ')}`;
  return '手动触发';
}

function projectForRun(run, rules) {
  const direct = String(run.project || run.cwd || '').trim();
  if (direct) return direct;
  const rule = rules.find(item => item.name === run.rule);
  return String(rule?.cwd || '').trim() || '未识别';
}

function readRules(config) {
  const raw = JSON.parse(readFileSync(config.rulesFile, 'utf8'));
  return raw.rules || [];
}

async function fetchState(deps) {
  return deps.request(deps.config, '/v1/state');
}

async function listRules(args, deps) {
  const rules = readRules(deps.config);
  const state = await fetchState(deps);
  const lines = state.lines || [];
  const result = rules.map(rule => {
    const line = lines.find(item => item.name === rule.name);
    return {
      name: rule.name,
      schedule: scheduleLabel(rule),
      cwd: rule.cwd,
      project: projectName(rule.cwd),
      agent: rule.to,
      paused: line?.paused ? { reason: line.paused.reason || null, until: line.paused.until || null } : null,
    };
  }).filter(rule => matchesProject(rule.cwd, args.project));
  return { rules: result.slice(0, MAX_ITEMS) };
}

async function listRuns(args, deps) {
  const rules = readRules(deps.config);
  const state = await fetchState(deps);
  const result = (state.runs || []).map(run => {
    const project = projectForRun(run, rules);
    return {
      id: run.id,
      rule: run.rule,
      project: projectName(project),
      state: run.state,
      attempts: run.attempts || 0,
      text: run.error || run.summary || '',
      finishedAt: run.finishedAt || null,
    };
  }).filter(run => matchesProject(run.project, args.project));
  return { runs: result.slice(0, MAX_ITEMS) };
}

async function listCards(_args, deps) {
  const state = await fetchState(deps);
  const result = (state.cards || [])
    .filter(card => (card.state || 'open') === 'open')
    .map(card => ({ id: card.id, title: card.title, text: card.text || '' }));
  return { cards: result.slice(0, MAX_ITEMS) };
}

const PROJECT_PROPERTY = {
  project: {
    type: 'string',
    description: '可选。按项目过滤：完整路径或目录名（basename）均可，与控制台项目筛选归一一致。缺省返回全部。',
  },
};

const NAME_PROPERTY = {
  name: { type: 'string', description: '规则名称（必填，非空字符串）。' },
  reason: { type: 'string', description: '可选。本次操作的原因，写入 Hub 请求。' },
};

const WRITE_TOOL_NAMES = ['resume_rule', 'pause_rule', 'run_rule'];

function requireRuleName(args) {
  if (typeof args?.name !== 'string' || !args.name.trim()) {
    const error = new Error('缺少必填参数 name（规则名称），且必须是非空字符串');
    error.code = -32602;
    throw error;
  }
  const name = args.name.trim();
  if (name.length > 200) {
    const error = new Error('规则名称过长');
    error.code = -32602;
    throw error;
  }
  return name;
}

function compactObject(entries) {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

// 受控写工具：与控制台按钮同一套 Hub 动作（服务端直连）。run_rule 会启动 Agent 消耗额度，
// 属于调度契约 §4.2「自愈后恢复或重触发」的授权动作。每次调用打一行审计日志（不含密钥）。
async function callRuleAction(args, deps, action) {
  const name = requireRuleName(args);
  const body = compactObject({ reason: args?.reason, ...(action === 'run' ? { subject: args?.subject } : {}) });
  const result = await deps.request(deps.config, `/v1/rules/${encodeURIComponent(name)}/${action}`, { method: 'POST', body });
  console.error(`[autoloop-hub] 写工具审计: ${action}_rule name=${name} ok`);
  return result;
}

export const TOOLS = [
  {
    name: 'list_rules',
    description: '列出调度规则：名称、触发方式、工作目录所属项目与暂停状态（数据来自 rules.json + Hub 状态线）。只读。',
    inputSchema: { type: 'object', properties: PROJECT_PROPERTY, additionalProperties: false },
  },
  {
    name: 'list_runs',
    description: '列出最近调度轮次：id、规则、状态、尝试次数、错误/概要摘要与完成时间。只读。',
    inputSchema: { type: 'object', properties: PROJECT_PROPERTY, additionalProperties: false },
  },
  {
    name: 'list_cards',
    description: '列出待处理的开放卡片：id、标题与正文摘要。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'resume_rule',
    description: '恢复一条已暂停的调度规则（POST /v1/rules/:name/resume）。受控写工具，用于自愈完成后恢复规则。',
    inputSchema: { type: 'object', properties: NAME_PROPERTY, required: ['name'], additionalProperties: false },
  },
  {
    name: 'pause_rule',
    description: '暂停一条调度规则（POST /v1/rules/:name/pause），例如额度耗尽时避免盲目重试。受控写工具。',
    inputSchema: { type: 'object', properties: NAME_PROPERTY, required: ['name'], additionalProperties: false },
  },
  {
    name: 'run_rule',
    description: '立即触发一次规则（POST /v1/rules/:name/run），会启动 Agent 消耗额度；仅用于自愈验证后的重触发。受控写工具。',
    inputSchema: {
      type: 'object',
      properties: { ...NAME_PROPERTY, subject: { type: 'string', description: '可选。本次运行的稳定 ASCII 事件标识。' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

const IMPLEMENTATIONS = {
  list_rules: listRules,
  list_runs: listRuns,
  list_cards: listCards,
  resume_rule: (args, deps) => callRuleAction(args, deps, 'resume'),
  pause_rule: (args, deps) => callRuleAction(args, deps, 'pause'),
  run_rule: (args, deps) => callRuleAction(args, deps, 'run'),
};

export async function handleToolCall(name, args = {}, { config, request = hubRequest } = {}) {
  const implementation = IMPLEMENTATIONS[name];
  if (!implementation) {
    const error = new Error(`未知工具：${String(name)}。可用工具：${TOOLS.map(tool => tool.name).join(', ')}`);
    error.code = -32602;
    throw error;
  }
  const deps = { config: config || loadConsoleConfig(), request };
  return implementation({ ...args }, deps);
}

// —— stdio JSON-RPC 主循环（仅直接执行 `node src/mcp/hub-tools.mjs` 时运行；被 import 时不启动）——

const LATEST_PROTOCOL_VERSION = '2025-06-18';

export function createRequestHandler(deps = {}) {
  return async function handleRequest(message) {
    const { id, method, params } = message;
    if (method === 'initialize') {
      return {
        protocolVersion: params?.protocolVersion || LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, title: 'Autoloop Hub 只读调度状态工具', version: SERVER_VERSION },
      };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: TOOLS };
    if (method === 'tools/call') {
      try {
        const result = await handleToolCall(params?.name, params?.arguments || {}, deps);
        console.error(`[autoloop-hub] tool call ok: ${params?.name}`); // 只记工具名，不记参数与任何密钥
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `工具调用失败：${error.message}` }],
          isError: true,
        };
      }
    }
    const error = new Error(`不支持的 JSON-RPC 方法：${String(method)}`);
    error.code = -32601;
    throw error;
  };
}

export function runStdioServer(deps = {}, { stdin = process.stdin, stdout = process.stdout } = {}) {
  const handleRequest = createRequestHandler(deps);
  let buffer = '';
  stdin.on('data', async chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无法解析的 JSON-RPC 消息' } })}\n`);
        continue;
      }
      if (message.id === undefined || message.id === null) continue; // notification：initialize 之后无需响应
      try {
        const result = await handleRequest(message);
        if (result !== undefined) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      } catch (error) {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } })}\n`);
      }
    }
  });
}

const invokedDirectly = (() => {
  try { return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (invokedDirectly) runStdioServer();
