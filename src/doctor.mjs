// 环境/配置自检（只读、可重复）：供安装 playbook 每步自验。不修复、不写任何文件、不在输出里回显凭据或响应正文。
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const UPSTREAM_URL = 'https://github.com/KKKKhazix/agent-autoloop';
export const MIN_NODE_MAJOR = 24;
const PROBE_TIMEOUT_MS = 8000;

const pass = (id, detail) => ({ id, status: 'pass', detail });
const fail = (id, detail, fix) => ({ id, status: 'fail', detail, fix });
const skip = (id, detail) => ({ id, status: 'skip', detail });

// 域名：小写、无端口/路径/通配、至少两段、不是 IP / localhost（与 spec §3.3 publicHost 口径一致）。
export function isValidPublicHost(value) {
  if (typeof value !== 'string' || value.length > 253) return false;
  if (/^\d+(\.\d+){3}$/.test(value)) return false;
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}

function readJson(file) {
  try { return { value: JSON.parse(readFileSync(file, 'utf8')) }; }
  catch (error) { return { error: error.code === 'ENOENT' ? '文件不存在' : `不是有效 JSON（${error.name}）` }; }
}

function checkNode(nodeVersion) {
  const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? pass('node-version', `Node ${nodeVersion} ≥ ${MIN_NODE_MAJOR}`)
    : fail('node-version', `Node ${nodeVersion} 低于要求的 ${MIN_NODE_MAJOR}`, `安装 Node.js ${MIN_NODE_MAJOR} 或更高版本后重试（nvm install ${MIN_NODE_MAJOR}）`);
}

function checkLayout(home) {
  if (!home) return fail('home-layout', '未设置 AGENT_AUTOLOOP_HOME', '设置 AGENT_AUTOLOOP_HOME 为仓库外的运行目录绝对路径，参见 docs/setup.md 第 1 节');
  if (!existsSync(home) || !statSync(home).isDirectory()) return fail('home-layout', `运行目录不存在：${home}`, '创建该目录并放入 config.json、rules.json（examples/ 有样例），参见 docs/setup.md');
  const missing = ['config.json', 'rules.json', path.join('app', 'bin', 'agent-autoloop.ts')].filter(rel => !existsSync(path.join(home, rel)));
  if (!missing.length) return pass('home-layout', `运行目录布局完整：${home}`);
  const kernelMissing = missing.some(rel => rel.startsWith('app'));
  const detail = `运行目录缺少：${missing.join('、')}`;
  return fail('home-layout', kernelMissing ? `${detail}。上游内核不随本项目分发，请自行获取：${UPSTREAM_URL}` : detail,
    kernelMissing ? `git clone ${UPSTREAM_URL} "${path.join(home, 'app')}"，按上游 README 安装后确认 app/bin/agent-autoloop.ts 存在` : '按 docs/setup.md 第 1 节补齐缺失文件');
}

async function probe(fetchImpl, url, init = {}) {
  try {
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), ...init });
    try { await res.body?.cancel(); } catch { /* 不读取正文 */ }
    return { status: res.status, location: res.headers?.get?.('location') || '' };
  } catch (error) { return { error: error?.cause?.code || error?.name || 'ERROR' }; }
}

async function checkConsole(fetchImpl, consoleUrl) {
  const res = await probe(fetchImpl, consoleUrl);
  if (res.error) return fail('console-reachable', `控制台不可达 ${consoleUrl}（${res.error}）`, '启动控制台：AGENT_AUTOLOOP_HOME=<运行目录> npm start；或用 AUTOLOOP_CONSOLE_URL 指向实际地址');
  return res.status < 500 ? pass('console-reachable', `控制台可达 ${consoleUrl}（HTTP ${res.status}）`)
    : fail('console-reachable', `控制台返回 HTTP ${res.status}`, '查看控制台进程日志并重启');
}

function checkRules(home) {
  const id = 'rules-draft';
  if (!home) return fail(id, '未设置运行目录，无法校验 rules.json', '先设置 AGENT_AUTOLOOP_HOME');
  const { value, error } = readJson(path.join(home, 'rules.json'));
  if (error) return fail(id, `rules.json ${error}`, '用控制台表单或 examples/rules.example.json 生成合法规则文件');
  if (!value || typeof value !== 'object' || !Array.isArray(value.rules)) return fail(id, 'rules.json 缺少 rules 数组', '参照 examples/rules.example.json 修正结构');
  const agents = value.agents && typeof value.agents === 'object' ? value.agents : {};
  const problems = [];
  value.rules.forEach((rule, index) => {
    const label = `规则 ${rule?.name || `#${index + 1}`}`;
    if (!rule || typeof rule.name !== 'string' || !rule.name.trim()) problems.push(`规则 #${index + 1} 缺少 name`);
    else if (!rule.when || !(typeof rule.when.cron === 'string' || (rule.when.source && Array.isArray(rule.when.types)))) problems.push(`${label} 缺少有效触发方式 when`);
    if (rule && !agents[rule.to]) problems.push(`${label} 的 Agent「${rule.to}」不在 agents 中`);
    if (rule && !(typeof rule.cwd === 'string' && path.isAbsolute(rule.cwd))) problems.push(`${label} 的 cwd 不是绝对路径`);
  });
  return problems.length ? fail(id, problems.join('；'), '在控制台规则页修正后重新保存，或按 docs/setup.md 第 3 节编辑')
    : pass(id, `rules.json 通过校验（${value.rules.length} 条规则）`);
}

function defaultTunnelPaths(home) {
  return [home && path.join(home, 'cloudflared.yml'), path.join(os.homedir(), '.cloudflared', 'config.yml'), '/etc/cloudflared/config.yml'].filter(Boolean);
}

async function publicChecks({ home, fetchImpl, tunnelConfigPaths, deviceToken }) {
  const config = home ? readJson(path.join(home, 'config.json')).value : null;
  const host = config?.publicHost;
  const hostOk = isValidPublicHost(host);
  const out = [hostOk ? pass('public-host', `publicHost = ${host}`)
    : fail('public-host', host === undefined ? 'config.json 未配置 publicHost' : 'config.json 的 publicHost 不合法（需小写域名，无端口、路径、通配）', '在 config.json 设置 "publicHost": "console.example.com"（你自己的域名）')];
  if (!hostOk) {
    for (const id of ['tunnel-config', 'public-reachable', 'access-blocks-anonymous', 'mobile-api']) out.push(skip(id, '需先修复 publicHost'));
    return out;
  }
  const tunnelFile = tunnelConfigPaths.find(file => existsSync(file));
  if (!tunnelFile) out.push(fail('tunnel-config', `未找到 cloudflared 隧道配置（已查：${tunnelConfigPaths.join('、')}）`, '按 playbook 阶段二创建隧道并写入配置'));
  else if (!new RegExp(`hostname:\\s*["']?${host.replace(/\./g, '\\.')}["']?\\s*$`, 'm').test(readFileSync(tunnelFile, 'utf8'))) out.push(fail('tunnel-config', `隧道配置 ${tunnelFile} 的 ingress 不含 ${host}`, `在 ingress 中加入 hostname: ${host} 并指向控制台本机地址`));
  else out.push(pass('tunnel-config', `隧道配置存在且含 ${host}：${tunnelFile}`));

  const base = `https://${host}`;
  const root = await probe(fetchImpl, `${base}/`);
  out.push(root.error ? fail('public-reachable', `${base} 不可达（${root.error}）`, '检查 DNS 记录、cloudflared 进程与隧道状态')
    : pass('public-reachable', `${base} 可达（HTTP ${root.status}）`));

  // 匿名探测：不带任何凭证头；只看状态码，不读取也不输出响应内容。
  const anon = [root.error ? root : root, await probe(fetchImpl, `${base}/api/state`)];
  const failedProbe = anon.find(r => r.error);
  const leaked = anon.find(r => !r.error && r.status >= 200 && r.status < 300);
  const blocked = r => r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400);
  if (failedProbe) out.push(fail('access-blocks-anonymous', `无法确认匿名请求是否被拦截（${failedProbe.error}）`, '先解决公网可达性，再重新自检'));
  else if (leaked || !anon.every(blocked)) out.push(fail('access-blocks-anonymous', `匿名请求未被拦截（HTTP ${anon.map(r => r.status).join('/')}）`, '在 Cloudflare Zero Trust 为该域名配置 Access 应用与登录策略，确保匿名请求被重定向或拒绝'));
  else out.push(pass('access-blocks-anonymous', `匿名请求被拦截（HTTP ${anon.map(r => r.status).join('/')}）`));

  if (!deviceToken) out.push(skip('mobile-api', '未提供设备令牌（环境变量 AUTOLOOP_DEVICE_TOKEN），跳过；绑定 APK 后重跑以验证'));
  else {
    const res = await probe(fetchImpl, `${base}/api/mobile/session`, { headers: { 'x-device-token': deviceToken } });
    out.push(res.error ? fail('mobile-api', `移动端 API 不可达（${res.error}）`, '检查隧道与 Access 对 /api/mobile/ 路径的放行策略')
      : res.status === 200 ? pass('mobile-api', '移动端 API 在设备令牌下可用')
        : fail('mobile-api', `移动端 API 返回 HTTP ${res.status}`, '确认设备已绑定且未被解除授权；检查 Access 是否放行 /api/mobile/'));
  }
  return out;
}

export async function runDoctor(options = {}) {
  const phase = options.phase;
  if (!['local', 'public'].includes(phase)) throw new Error('--phase 只能是 local 或 public');
  const home = 'home' in options ? options.home : process.env.AGENT_AUTOLOOP_HOME;
  const fetchImpl = options.fetch || globalThis.fetch;
  const consoleUrl = options.consoleUrl || process.env.AUTOLOOP_CONSOLE_URL || `http://127.0.0.1:${process.env.AUTOLOOP_CONSOLE_PORT || 50761}`;
  const checks = [
    checkNode(options.nodeVersion || process.versions.node),
    checkLayout(home),
    await checkConsole(fetchImpl, consoleUrl),
    checkRules(home),
  ];
  if (phase === 'public') {
    checks.push(...await publicChecks({
      home, fetchImpl,
      tunnelConfigPaths: options.tunnelConfigPaths || defaultTunnelPaths(home),
      deviceToken: 'deviceToken' in options ? options.deviceToken : process.env.AUTOLOOP_DEVICE_TOKEN,
    }));
  }
  const ok = checks.every(item => item.status !== 'fail');
  return { phase, ok, exitCode: ok ? 0 : 1, checks };
}

const MARK = { pass: '✓', fail: '✗', skip: '-' };
export function formatReport(report) {
  const lines = [`doctor --phase ${report.phase}`];
  for (const item of report.checks) {
    lines.push(`${MARK[item.status]} ${item.id}：${item.detail}`);
    if (item.status === 'fail' && item.fix) lines.push(`    修复：${item.fix}`);
  }
  lines.push(report.ok ? '结果：全部通过' : '结果：有失败项，按上方修复路径处理后重跑');
  return lines.join('\n');
}
