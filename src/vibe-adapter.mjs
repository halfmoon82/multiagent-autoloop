// 服务端 vibe 规划适配器：对 vibe CLI 的受控适配层（纯模块，不接 HTTP 路由）。
// 固定封装 scan/plan/init --confirm 白名单子命令，argv 全部在模块内部构造；
// 显式 --adapter codex 与 --project-root；清理宿主环境变量；版本预检阻塞式锁定 5.2.7；
// 能力记录只读校验（服务端绝不执行 attest、绝不写能力记录、绝不编造 ACP initialize 不包含的派发事实）。
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const VIBE_MAJOR_VERSION = 5;
// 宿主会话环境变量清理清单：禁止从控制台宿主进程泄漏给被调 vibe CLI。
export const HOST_ENV_DENYLIST = Object.freeze([
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_TURN_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDECODE',
  'CURSOR_SESSION_ID',
  'AGENT_TASK_ID',
]);
export const CAPABILITY_MAX_AGE_MS = 72 * 60 * 60 * 1000;
// 派发形态词表（供 UI 文案与校验消息引用）。注意：codex 清单没有 background 探针，
// 本适配器只能从 facts 推导 visible / in_session_sdd，不会推导 background。
export const DISPATCH_FORMS = Object.freeze(['visible', 'background', 'in_session_sdd']);
const MAX_STATE_BYTES = 1024 * 1024;

export class VibeAdapterError extends Error {
  constructor(code, message, remediation = null) {
    super(message);
    this.name = 'VibeAdapterError';
    this.code = code;
    this.remediation = remediation;
  }
}

const fail = (code, message, remediation = null) => ({ ok: false, error: { code, message, ...(remediation ? { remediation } : {}) } });

export function sanitizeHostEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (!HOST_ENV_DENYLIST.includes(key)) clean[key] = value;
  }
  return clean;
}

/** 项目根只能来自调用方显式传入的已发现 Git 仓路径：绝对路径、无 traversal、存在 .git。 */
export function resolveProjectRoot(projectRoot) {
  const raw = String(projectRoot ?? '').trim();
  if (!raw) throw new VibeAdapterError('invalid_project_root', 'projectRoot 不能为空：必须传入已发现的 Git 仓路径');
  if (!path.isAbsolute(raw)) throw new VibeAdapterError('invalid_project_root', `projectRoot 必须是已发现 Git 仓的绝对路径：${raw}`);
  const resolved = path.resolve(raw);
  if (resolved !== raw.replace(/\/+$/, '') && resolved !== raw) {
    throw new VibeAdapterError('invalid_project_root', `projectRoot 不允许包含 traversal，必须是已发现的 Git 仓：${raw}`);
  }
  if (!existsSync(path.join(resolved, '.git'))) {
    throw new VibeAdapterError('invalid_project_root', `projectRoot 不是已发现的 Git 仓（缺少 .git）：${resolved}`);
  }
  return resolved;
}

/**
 * argv 全部在模块内部构造。白名单子命令：
 *   scan → vibe scan --adapter codex --project-root <root>
 *   plan → vibe plan --from-prd <.vibe/plans/...> --adapter codex --project-root <root>
 *   init → vibe init --confirm --adapter codex --project-root <root>（仅显式 confirm）
 * 调用方没有任何注入额外命令/参数的通道。
 */
export function buildVibeArgv(subcommand, { projectRoot, prdPath = null, confirm = false } = {}) {
  // 严格选项键白名单：调用方不存在注入任意命令/参数的通道，未知键一律拒绝。
  const ALLOWED_KEYS = ['projectRoot', 'prdPath', 'confirm'];
  for (const key of Object.keys(arguments[1] ?? {})) {
    if (!ALLOWED_KEYS.includes(key)) throw new VibeAdapterError('invalid_arguments', `vibe 调用选项不在白名单：${key}`);
  }
  const root = resolveProjectRoot(projectRoot);
  const WHITELIST = ['scan', 'plan', 'init'];
  if (!WHITELIST.includes(subcommand)) {
    throw new VibeAdapterError('invalid_arguments', `vibe 子命令不在服务端白名单（${WHITELIST.join('/')}）：${String(subcommand)}`);
  }
  const argv = [subcommand];
  if (subcommand === 'init') {
    if (confirm !== true) throw new VibeAdapterError('confirmation_required', 'vibe init 只能在显式 confirm 后执行');
    argv.push('--confirm');
  }
  if (subcommand === 'plan') {
    if (!String(prdPath ?? '').trim()) throw new VibeAdapterError('invalid_arguments', 'vibe plan 必须显式提供 from-prd 路径');
    const prd = path.resolve(String(prdPath));
    const plansRoot = path.join(root, '.vibe', 'plans') + path.sep;
    if (!prd.startsWith(plansRoot)) {
      throw new VibeAdapterError('invalid_arguments', `--from-prd 必须位于项目 .vibe/plans/ 目录内：${prdPath}`);
    }
    argv.push('--from-prd', prd);
  }
  argv.push('--adapter', 'codex', '--project-root', root);
  return argv;
}

/** 默认 runner：execFile 固定可执行路径 + 清理后的环境；测试可整体注入假 CLI runner。 */
export async function defaultRunner(argv, { command = 'vibe', env }) {
  const { stdout } = await execFileAsync(command, argv, { env, maxBuffer: 4 * 1024 * 1024 });
  return { stdout };
}

/** 初始化预检：.vibe/state.json 缺失返回 initialization_required（只有显式 confirm 才允许 init）。 */
export function checkInitialization({ projectRoot }) {
  const root = resolveProjectRoot(projectRoot);
  if (!existsSync(path.join(root, '.vibe', 'state.json'))) {
    return fail('initialization_required', `目标项目缺少 .vibe/state.json：${root}`, '在项目根执行 `vibe init --confirm`（控制台目前没有该入口）');
  }
  return { ok: true };
}

// vibe 5.2.7 的 `vibe attest` 只写这一个文件（每适配器一份，见上游 #279）；
// `.vibe/state.json` 里没有 capabilities 段，读它永远读不到真实记录。
const CAPABILITY_RECORD_RELATIVE = ['.vibe', 'provider-actions', 'capabilities-codex.json'];

/**
 * 只读加载 attest 记录；缺失、过大、符号链接（上游同样拒绝）或非法 JSON 一律视为未登记。
 */
function readCapabilityRecord(root) {
  const directory = path.join(root, ...CAPABILITY_RECORD_RELATIVE.slice(0, -1));
  const file = path.join(root, ...CAPABILITY_RECORD_RELATIVE);
  try {
    if (lstatSync(directory).isSymbolicLink()) return null;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) return null;
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch (error) {
    return null;
  }
}

// attest 写入时强制的 9 项探针（codex 清单）；缺任一项就不是一次完整 attest。
export const CAPABILITY_PROBES = Object.freeze([
  'codex.agent',
  'codex.shell',
  'codex.subprocess',
  'codex.worktree',
  'codex.visible_task.create',
  'codex.visible_task.enter',
  'codex.visible_task.resume',
  'codex.visible_task.wait',
  'codex.in_session_sdd',
]);

/**
 * 从真实会话声明的 facts 推出派发形态，语义与上游 detect 一致：
 * subprocess 为假时上游只给 guide（sdd 也不升级）；visible 需七项全真；
 * in_session_sdd 需 subprocess 且显式 true；codex 清单没有 background 探针，不推导 background。
 */
export function dispatchFromCapabilityFacts(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return null;
  const stated = name => facts[`codex.${name}`] === true;
  if (!stated('subprocess')) return null;
  const visible = ['shell', 'worktree', 'visible_task.create', 'visible_task.enter', 'visible_task.resume', 'visible_task.wait'].every(stated);
  if (visible) return 'visible';
  if (stated('in_session_sdd')) return 'in_session_sdd';
  return null;
}

const ATTEST_REMEDIATION = '在真实 Codex 会话执行 `vibe attest --adapter codex --facts <facts.json> --provenance "<观察依据>"` 留下能力记录（项目需先 vibe init --confirm）；服务端只读校验、不代写';

/**
 * 能力记录校验（只读）：读取真实会话执行 `vibe attest` 留下的
 * `.vibe/provider-actions/capabilities-codex.json`——schema_version=1、
 * adapter_id=codex、provenance 非空、9 项探针齐全且为布尔、observed_at 在
 * 72 小时内（允许 5 分钟时钟偏差）、facts 能推导出 visible/in_session_sdd
 * 之一的派发形态。记录里不含 vibe 版本，故本检查不比对版本（版本一致性由
 * runVibe 的 ensureVibeVersion 阻塞式保证）。缺失/过期/不一致一律
 * capability_attestation_required；服务端不执行 attest、不写记录、不编造事实。
 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function checkCapabilities({ projectRoot, now = Date.now() }) {
  const root = resolveProjectRoot(projectRoot);
  const required = (message) => fail('capability_attestation_required',
    message || `目标项目缺少由真实 Codex 会话 vibe attest 留下的能力记录：${root}`, ATTEST_REMEDIATION);
  const record = readCapabilityRecord(root);
  if (!record) return required();
  if (record.schema_version !== 1) {
    return required(`能力记录 schema_version=${String(record.schema_version)}，当前只认 1`);
  }
  if (record.adapter_id !== 'codex') {
    return required(`能力记录 adapter=${String(record.adapter_id)}，必须为 codex`);
  }
  if (typeof record.provenance !== 'string' || !record.provenance.trim()) {
    return required('能力记录缺少 vibe attest 来源说明（provenance）');
  }
  const attestedAt = Date.parse(String(record.observed_at ?? ''));
  if (!Number.isFinite(attestedAt)) {
    return required('能力记录 observed_at 缺失或无法解析');
  }
  if (attestedAt > now + CLOCK_SKEW_MS || now - attestedAt > CAPABILITY_MAX_AGE_MS) {
    return required(`能力记录已超过 72 小时有效期或时间非法（observed_at=${record.observed_at}）`);
  }
  const facts = record.facts;
  const missing = CAPABILITY_PROBES.filter(name => typeof facts?.[name] !== 'boolean');
  if (missing.length) {
    return required(`能力记录不完整，缺少布尔探针：${missing.join('、')}`);
  }
  if (dispatchFromCapabilityFacts(facts) === null) {
    return required('能力记录缺少 visible/in_session_sdd 之一的真实派发形态');
  }
  return { ok: true };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** specDigest：product-spec 约定 JSON 块的确定性 sha256 摘要。 */
export function computeSpecDigest(productSpec) {
  if (!productSpec || typeof productSpec !== 'object' || Array.isArray(productSpec)) {
    throw new VibeAdapterError('invalid_arguments', 'specDigest 输入必须是对象形态的 product-spec');
  }
  return createHash('sha256').update(canonical(productSpec)).digest('hex');
}

/**
 * 从设计会话转录文本提取约定 JSON 块（product-spec）并计算 specDigest。
 * 约定块为 info 字符串含 product-spec 的围栏代码块（```product-spec 或 ```json product-spec）。
 */
export function extractProductSpec(transcript) {
  if (typeof transcript !== 'string' || !transcript.trim()) {
    throw new VibeAdapterError('invalid_arguments', '会话转录必须是字符串');
  }
  const blocks = [...transcript.matchAll(/```([^\n`]*product-spec[^\n`]*)\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return fail('spec_not_found', '转录中找不到 product-spec 约定 JSON 块');
  let productSpec;
  try { productSpec = JSON.parse(blocks[0][2].trim()); }
  catch { return fail('invalid_spec_block', 'product-spec 块不是合法 JSON'); }
  if (!productSpec || typeof productSpec !== 'object' || Array.isArray(productSpec)) {
    return fail('invalid_spec_block', 'product-spec 块必须是 JSON 对象');
  }
  return { ok: true, productSpec, specDigest: computeSpecDigest(productSpec) };
}

/**
 * 固定封装入口：版本预检（阻塞）→ 初始化预检 → 白名单 argv → 清理环境执行。
 * 返回 { ok:true, version, argv, data } 或结构化错误 { ok:false, error:{ code, message, remediation? } }。
 */
export async function runVibe(subcommand, { projectRoot, runner = defaultRunner, command = 'vibe', env, confirm = false, prdPath = null } = {}) {
  let argv;
  try { argv = buildVibeArgv(subcommand, { projectRoot, prdPath, confirm }); }
  catch (error) {
    if (error instanceof VibeAdapterError) return fail(error.code === 'invalid_arguments' ? 'invalid_arguments' : error.code, error.message);
    throw error;
  }
  // init 本身就是初始化动作，跳过 initialization 预检；scan/plan 必须先初始化。
  if (subcommand !== 'init') {
    const init = checkInitialization({ projectRoot });
    if (!init.ok) return init;
  }
  const cleanEnv = sanitizeHostEnv(env ?? process.env);
  try {
    const { stdout } = await runner(argv, { command, env: cleanEnv });
    let data = null;
    try { data = JSON.parse(String(stdout)); } catch { data = String(stdout); }
    return { ok: true, argv, data };
  } catch (error) {
    return fail('vibe_cli_failed', `vibe ${subcommand} 执行失败：${error.message}`);
  }
}
