// 控制台派生 ACP 会话专用 CODEX_HOME。
// 背景：会话曾继承用户全局 ~/.codex/config.toml 的 approval_policy="never"，旁路控制台权限门。
// 做法：每次启动会话前重写 <home>/config.toml（不信任残留内容）：强制 approval_policy="on-request"，
// 只从用户配置白名单继承模型/供应商段；hooks（notify）、MCP、项目信任、沙箱/审批相关项一律不继承。
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INHERITED_KEYS = new Set([
  'model', 'model_provider', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity',
  'model_context_window', 'model_auto_compact_token_limit', 'model_catalog_json', 'web_search', 'preferred_auth_method',
]);
// 取舍：model_providers.* 整段继承，可能带内联敏感头（如 api key）；专用配置文件 0600、目录 0700、位于控制台数据目录，不进 git。
const INHERITED_TABLE = /^model_providers(\.|$)/;

// 把 TOML 文本切成语句（顶层键值或表头），多行数组/内联表/多行字符串并入同一语句，避免续行被误判成顶层键。
export function splitTomlStatements(text) {
  const statements = [];
  let current = null;
  let depth = 0; let multiline = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (current === null) { current = [raw]; depth = 0; } else current.push(raw);
    const isHeader = current.length === 1 && /^\s*\[/.test(raw);
    let quote = null;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (multiline) {
        if (raw.startsWith(multiline, i)) { multiline = null; i += 2; }
        else if (multiline === '"""' && ch === '\\') i += 1;
      } else if (quote) {
        if (quote === '"' && ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (raw.startsWith('"""', i) || raw.startsWith("'''", i)) { multiline = raw.slice(i, i + 3); i += 2; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '#') break;
      else if (!isHeader && (ch === '[' || ch === '{')) depth += 1;
      else if (!isHeader && (ch === ']' || ch === '}')) depth -= 1;
    }
    if (depth <= 0 && !multiline) { statements.push(current.join('\n')); current = null; }
  }
  if (current) statements.push(current.join('\n'));
  return statements;
}

export function mergeInheritedConfig(userToml) {
  const kept = [];
  let section = null; // null=顶层；否则为当前表名
  let keepSection = false;
  for (const statement of splitTomlStatements(userToml)) {
    const first = statement.split('\n')[0].trim();
    const header = first.match(/^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header && !first.includes('=')) {
      section = header[1];
      keepSection = !first.startsWith('[[') && INHERITED_TABLE.test(section.replace(/"/g, ''));
      if (keepSection) kept.push(statement);
      continue;
    }
    if (section === null) {
      const key = first.match(/^([A-Za-z0-9_-]+)\s*=/)?.[1];
      if (key && INHERITED_KEYS.has(key)) kept.push(statement);
    } else if (keepSection) kept.push(statement);
  }
  return kept.join('\n');
}

export function defaultUserCodexHome(env = process.env) {
  return env.CODEX_HOME_USER || env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// 返回专用 CODEX_HOME 绝对路径；任何一步失败都抛错，由调用方拒绝启动（不回退全局配置）。
export function prepareSessionCodexHome({ targetDir, userCodexHome = defaultUserCodexHome(), model = null } = {}) {
  if (!targetDir) throw new Error('未指定会话专用 CODEX_HOME 目录');
  const target = path.resolve(targetDir);
  // 预置软链可能指向 ~/.codex，随后的重写/删凭据会波及用户全局配置：软链一律拒绝启动。
  let existing = null;
  try { existing = lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing?.isSymbolicLink()) throw new Error(`会话专用 CODEX_HOME 不能是符号链接：${target}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  let userToml = '';
  try { userToml = readFileSync(path.join(userCodexHome, 'config.toml'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let inherited = mergeInheritedConfig(userToml);
  // 管理后台为本类会话选定的档位模型：替换继承来的顶层 model（模型名已在 platform-models 校验为安全字符）。
  if (model) {
    if (!/^[A-Za-z0-9][\w.:/@+-]{0,99}$/.test(String(model))) throw new Error(`会话模型名不合法：${model}`);
    // TOML：表头之后的键属于该表，只能去掉/插入顶层（首个表头之前）的 model。
    const statements = splitTomlStatements(inherited);
    let topLevel = true;
    const kept = statements.filter(statement => {
      const first = statement.split('\n')[0].trim();
      if (/^\[/.test(first) && !first.includes('=')) topLevel = false;
      return !(topLevel && /^model\s*=/.test(first));
    });
    inherited = [`model = "${model}"`, ...kept].join('\n');
  }
  const content = [
    '# 由控制台生成，每次开会话前重写，请勿手改（改动会被覆盖）。',
    '# 权限由控制台 #decidePermission 裁定：审批请求必须回到控制台，不继承用户全局 approval_policy。',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    inherited,
    '',
    '[sandbox_workspace_write]',
    'network_access = true',
    '',
  ].join('\n');
  // 先写临时文件再原子替换，避免会话读到半截配置
  const temp = path.join(target, `config.toml.${process.pid}.tmp`);
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path.join(target, 'config.toml'));
  // 凭证沿用用户登录态：软链而非复制，避免复制出第二份密钥
  const authSource = path.join(userCodexHome, 'auth.json');
  const authLink = path.join(target, 'auth.json');
  if (existsSync(authSource)) {
    try { lstatSync(authLink); rmSync(authLink, { force: true }); } catch { /* 不存在 */ }
    symlinkSync(authSource, authLink);
  }
  try { chmodSync(target, 0o700); } catch { /* 非致命 */ }
  return target;
}
