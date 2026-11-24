import http from 'node:http';
import { createReadStream } from 'node:fs';
import { classifySessionRequest } from './session-classify.mjs';
import { mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubError, hubRequest } from './hub.mjs';
import { readRuleOptions, saveRule, RuleError, defaultCheck } from './rules.mjs';
import { readPlatformModels, applyPlatformModels, sessionLaunch, PlatformModelsError } from './platform-models.mjs';
import { loadPolicy } from './detour-policy.mjs';
import { modelLabels } from './models.mjs';
import { SchedulingSessionManager, SchedulingSessionError } from './scheduling-session.mjs';
import { DEFAULT_MAX_SESSIONS, MAX_SESSIONS_UPPER_BOUND } from './config.mjs';
import { HubSchedulingSessionAdapter } from './hub-scheduling-session.mjs';
import { discoverGitProjects } from './projects.mjs';
import { readDetours, publicDetour } from './detour.mjs';
import { loadChains, chainRuleNames } from './serial-progress.mjs';
import { aggregateProjectUsage } from './project-usage.mjs';
import { readArchive } from './archive.mjs';
import { attachArchiveUsage, sumRunUsage } from './archive-usage.mjs';
import { refreshUsage } from './chain-usage.mjs';
import { readCloseouts } from './chain-closeout.mjs';
import { createDagService, DagServiceError, withHubUsage, collectHubRuns } from './dag-service.mjs';
import { CardDelegateError, createCardDelegateStore, delegateOpenCard, settleDelegations } from './card-delegate.mjs';
import { getCardRouting, CardFilterError } from './card-routing.mjs';
import { createDeviceStore, DeviceAuthError } from './device-auth.mjs';
import { handleMobileWrite, redeemPreviewTicket, sendPreviewHtml } from './mobile-write.mjs';
import { createWhisperTranscriber, audioExtension, parseMultipartAudio, WhisperError, MAX_AUDIO_BYTES } from './whisper-transcribe.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(MODULE_DIR, '..', 'public');
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']], ['/format.mjs', ['format.mjs', 'text/javascript; charset=utf-8']],
  ['/dom-stable.mjs', ['dom-stable.mjs', 'text/javascript; charset=utf-8']],
  ['/status-sections.mjs', ['status-sections.mjs', 'text/javascript; charset=utf-8']],
  ['/views.mjs', ['views.mjs', 'text/javascript; charset=utf-8']], ['/rule-form.mjs', ['rule-form.mjs', 'text/javascript; charset=utf-8']],
  ['/dag-model.mjs', ['dag-model.mjs', 'text/javascript; charset=utf-8']], ['/dag-views.mjs', ['dag-views.mjs', 'text/javascript; charset=utf-8']], ['/dag-authorize.mjs', ['dag-authorize.mjs', 'text/javascript; charset=utf-8']], ['/dag-app.mjs', ['dag-app.mjs', 'text/javascript; charset=utf-8']], ['/admin-platform-models.mjs', ['admin-platform-models.mjs', 'text/javascript; charset=utf-8']], ['/progress-view.mjs', ['progress-view.mjs', 'text/javascript; charset=utf-8']], ['/dag.css', ['dag.css', 'text/css; charset=utf-8']],
  ['/device.mjs', ['device.mjs', 'text/javascript; charset=utf-8']], ['/qr.mjs', ['qr.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/archive-view.mjs', ['archive-view.mjs', 'text/javascript; charset=utf-8']], ['/archive.css', ['archive.css', 'text/css; charset=utf-8']],
  ['/session-limit.mjs', ['session-limit.mjs', 'text/javascript; charset=utf-8']],
]);
// 移动端壳资源（独立前端，不与 public/ 网页控制台混用）：固定白名单，不读取任意路径。
const MOBILE = path.join(MODULE_DIR, '..', 'mobile', 'app', 'www');
const MOBILE_FILES = new Map([
  ['/mobile/', ['index.html', 'text/html; charset=utf-8']],
  ['/mobile/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/mobile/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/mobile/shell.mjs', ['shell.mjs', 'text/javascript; charset=utf-8']],
  ['/mobile/scan.mjs', ['scan.mjs', 'text/javascript; charset=utf-8']],
  ['/mobile/icons.mjs', ['icons.mjs', 'text/javascript; charset=utf-8']],
  ['/mobile/collapsible-cards.mjs', ['collapsible-cards.mjs', 'text/javascript; charset=utf-8']],
  ['/mobile/vendor/qr-decoder.mjs', ['vendor/qr-decoder.mjs', 'text/javascript; charset=utf-8']],
  ['/mobile/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/mobile/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/mobile/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
// 受限目录规则（scaffold）：页面模块与视图模型各自限定在一个目录内，页面用 ../src/... 引用视图模型。
// 白名单之上的两条规则：/mobile/pages/<kebab>.(mjs|css) 与 /mobile/src/<kebab 路径>.mjs。
// 仅接受 kebab 名；..、非 .mjs、符号链接、realpath 逃逸一律 404。
const MOBILE_SRC = path.join(MODULE_DIR, '..', 'mobile', 'src');
const KEBAB_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function readMobileFile(file, root, type) {
  try {
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    if (lstatSync(root).isSymbolicLink()) return null;
    let cursor = root;
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) return null;
    }
    if (!statSync(file).isFile()) return null;
    const real = realpathSync(file);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return { body: readFileSync(real), type };
  } catch {
    return null;
  }
}
export function resolveMobileAsset(pathname, { www = MOBILE, src = MOBILE_SRC } = {}) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return null;
  let match;
  if ((match = /^\/mobile\/pages\/([^/]+)\.(mjs|css)$/.exec(decoded))) {
    if (!KEBAB_SEGMENT.test(match[1])) return null;
    const type = match[2] === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    const root = path.join(www, 'pages');
    return readMobileFile(path.join(root, `${match[1]}.${match[2]}`), root, type);
  }
  if ((match = /^\/mobile\/src\/(.+)\.mjs$/.exec(decoded))) {
    const segments = match[1].split('/');
    if (!segments.length || !segments.every(segment => KEBAB_SEGMENT.test(segment))) return null;
    return readMobileFile(path.join(src, `${match[1]}.mjs`), src, 'text/javascript; charset=utf-8');
  }
  return null;
}
// 移动端安全入口只中继这些既定只读控制台 API；不代理任意 URL，设备授权管理 API 不在此列。
const MOBILE_API_ALLOWLIST = new Map([
  ['state', '/api/state'], ['projects', '/api/projects'], ['rules', '/api/rules'],
  ['dag-runs', '/api/dag-runs'], ['archive', '/api/archive'], ['closeouts', '/api/closeouts'],
  ['sessions', '/api/scheduling-sessions'], ['session-archives', '/api/session-archives'],
  ['detours', '/api/detours'], ['serial-progress', '/api/serial-progress'], ['project-usage', '/api/project-usage'],
]);
// 移动端静态资源内容 hash 长缓存：版本 = 全部移动端文件内容的 sha256 前 16 位。
// 入口文档仍 no-store，并把本地 css/mjs 引用与模块 import 改写成带 ?v=<版本>；URL 版本与当前内容一致才发 immutable，
// 内容变化 → 版本变化 → 全部 URL 变化，旧缓存自然失效。不带或带错版本一律保持 no-store。符号链接不进入版本计算。
const MOBILE_CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
let mobileVersionMemo = null;
function walkMobileFiles(root, rel = '') {
  const out = [];
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkMobileFiles(root, next));
    else if (entry.isFile()) out.push(next);
  }
  return out;
}
export function mobileAssetVersion({ roots = [MOBILE, MOBILE_SRC], now = Date.now() } = {}) {
  const key = roots.join('\0');
  if (mobileVersionMemo && mobileVersionMemo.key === key && now - mobileVersionMemo.at < 1000) return mobileVersionMemo.value;
  const hash = createHash('sha256');
  try {
    for (const root of roots) for (const rel of walkMobileFiles(root)) hash.update(`${path.basename(root)}/${rel}\0`).update(readFileSync(path.join(root, rel)));
  } catch { return null; }
  const value = hash.digest('hex').slice(0, 16);
  mobileVersionMemo = { key, at: now, value };
  return value;
}
export function versionMobileText(text, type, version) {
  if (!version) return text;
  if (type.startsWith('text/javascript')) return text.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"?#]+\.mjs)\2/g, `$1$2$3?v=${version}$2`);
  if (type.startsWith('text/html')) return text.replace(/\b(href|src)="(\.\/[^"?#]+\.(?:css|mjs))"/g, `$1="$2?v=${version}"`);
  return text;
}
function sendMobileAsset(res, url, body, type) {
  const version = mobileAssetVersion();
  const requested = url.searchParams.get('v');
  const immutable = Boolean(version) && requested === version && !type.startsWith('text/html');
  const payload = /^(text\/(javascript|html))/.test(type) ? versionMobileText(body.toString('utf8'), type, version) : body;
  res.writeHead(200, { ...securityHeaders(), ...(immutable ? { 'cache-control': MOBILE_CACHE_IMMUTABLE } : {}), 'content-type': type });
  res.end(payload);
}
export function securityHeaders() {
  return { 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
}
export function jsonResponse(res, status, value) { res.writeHead(status, { ...securityHeaders(), 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
class RequestError extends Error { constructor(status, message) { super(message); this.status = status; } }
function checkWrite(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new RequestError(403, '拒绝跨站操作');
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new RequestError(403, '拒绝跨站操作');
  if (req.headers['x-console-request'] !== '1') throw new RequestError(403, '缺少控制台请求标记');
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new RequestError(415, '操作内容必须是 JSON');
}
// 远程访问层必须终结为 HTTPS；本机直连（无转发头）保持不变。
function requireSecureTransport(req) {
  const forwarded = req.headers['x-forwarded-proto'];
  if (forwarded && forwarded.split(',')[0].trim().toLowerCase() !== 'https') throw new RequestError(403, '远程访问必须使用 HTTPS');
}
// 设备级授权：解除授权后同一凭据立即失效；只返回该设备自身的公开信息。
function requireMobileDevice(req, config) {
  const token = req.headers['x-device-token'];
  if (!config.deviceAuth || typeof token !== 'string' || !config.deviceAuth.isAuthorizedToken(token)) {
    throw new RequestError(401, '设备未授权或授权已失效，请重新绑定');
  }
  const device = typeof config.deviceAuth.touch === 'function' ? config.deviceAuth.touch(token) : null;
  if (!device) throw new RequestError(401, '设备未授权或授权已失效，请重新绑定');
  return device;
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new RequestError(413, '请求内容过大'); chunks.push(chunk); }
  if (!size) return {};
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new RequestError(400, '请求内容不是有效的 JSON 对象'); }
}
// 二进制请求体读取：超过 limit 立即中断并抛 413（不再继续接收）。
async function readRaw(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new RequestError(413, '音频过大');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new RequestError(413, '音频过大'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
// 语音转写：设备级鉴权后受理；音频为 audio/* 或 multipart，校验顺序 401→415→503→429→413。
async function handleSpeechTranscribe(config, req, res) {
  requireSecureTransport(req);
  const device = requireMobileDevice(req, config);
  const transcriber = config.whisperTranscriber;
  const contentType = req.headers['content-type'] || '';
  const multipart = contentType.split(';')[0].trim().toLowerCase() === 'multipart/form-data';
  if (!multipart && !audioExtension(contentType)) throw new RequestError(415, '请上传音频内容');
  try { transcriber.assertAvailable(); transcriber.claimCooldown(device.id); }
  catch (error) { if (error instanceof WhisperError) throw new RequestError(error.status, error.message); throw error; }
  let audio = await readRaw(req, MAX_AUDIO_BYTES);
  let extension = audioExtension(contentType);
  if (multipart) {
    const part = parseMultipartAudio(audio, contentType);
    extension = part && audioExtension(part.type);
    if (!extension) throw new RequestError(415, '请上传音频内容');
    audio = part.data;
  }
  try { return jsonResponse(res, 200, await transcriber.transcribe(audio, extension)); }
  catch (error) { if (error instanceof WhisperError) throw new RequestError(error.status, error.message); throw error; }
}
function idOf(text) { const id = Number(text); if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(id)) throw new RequestError(400, '编号无效'); return id; }
// 模型显示映射：每个执行者自己的模型（分档执行者命令里带 --model）优先，缺失才退回宿主默认标签。
// /api/rules（总览、串行链）与 /api/dag-runs/:id（DAG 详情）共用这一个口径，避免两处各算各的。
function modelMap(agents = []) {
  return { ...modelLabels(), ...Object.fromEntries(agents.filter(agent => agent.model).map(agent => [agent.id, agent.model])) };
}

async function handleApi(config, req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') return jsonResponse(res, 200, await hubRequest(config, '/v1/state'));
  if (req.method === 'GET' && url.pathname === '/api/rules') { const options = readRuleOptions(config); return jsonResponse(res, 200, { ...options, models: modelMap(options.agents) }); }
  if (req.method === 'GET' && url.pathname === '/api/admin/platform-models') {
    let policy = null; try { policy = loadPolicy(config); } catch { policy = null; }
    return jsonResponse(res, 200, readPlatformModels(config, { ...(config.platformCatalog ? { catalog: config.platformCatalog } : {}), policy }));
  }
  if (req.method === 'GET' && url.pathname === '/api/scheduling-sessions') return jsonResponse(res, 200, await config.schedulingSessions.list());
  if (req.method === 'GET' && url.pathname === '/api/session-limit') return jsonResponse(res, 200, {
    maxSessions: config.schedulingSessions?.maxSessions ?? config.maxSessions ?? DEFAULT_MAX_SESSIONS,
    default: DEFAULT_MAX_SESSIONS,
    min: 1,
    max: MAX_SESSIONS_UPPER_BOUND,
    warning: config.maxSessionsWarning || null,
  });
  if (req.method === 'GET' && url.pathname === '/api/session-archives') return jsonResponse(res, 200, { sessions: await config.schedulingSessions.listArchived() });
  if (req.method === 'GET' && url.pathname === '/api/projects') return jsonResponse(res, 200, { projects: discoverGitProjects({ roots: config.projectRoots || [], rules: readRuleOptions(config).rules || [] }) });
  if (req.method === 'GET' && url.pathname === '/api/card-router') {
    if (!config.cardRouting) throw new RequestError(503, '卡片路由不可用（未配置数据目录）');
    return jsonResponse(res, 200, config.cardRouting.status());
  }
  let dagMatch;
  if (req.method === 'GET' && url.pathname === '/api/dag-runs') return jsonResponse(res, 200, { runs: config.dagService ? config.dagService.list() : [] });
  if (req.method === 'GET' && (url.pathname === '/api/dag-plan' || url.pathname === '/api/dag-preflight')) {
    if (!config.dagService) throw new RequestError(503, 'DAG 通道不可用（未配置运行目录）');
    const known = discoverGitProjects({ roots: config.projectRoots || [], rules: readRuleOptions(config).rules || [] }).find(item => item.path === path.resolve(String(url.searchParams.get('project') || '')));
    if (!known) throw new RequestError(400, '项目不在已发现的 Git 仓库列表中，请从下拉选择');
    return jsonResponse(res, 200, url.pathname === '/api/dag-plan' ? await config.dagService.preview(known.path, url.searchParams.get('planId')) : config.dagService.preflight(known.path, url.searchParams.get('planId')));
  }
  if (req.method === 'GET' && (dagMatch = url.pathname.match(/^\/api\/dag-runs\/([^/]+)$/))) {
    if (!config.dagService) throw new RequestError(503, 'DAG 通道不可用（未配置运行目录）');
    const detail = config.dagService.get(decodeURIComponent(dagMatch[1]));
    // 节点执行 Agent / Token / 费用只在 Hub 轮次上：首页只有最近一小段，已完成节点的轮次要按轮次号定向取回；
    // 读不到 Hub 时原样返回，界面如实写未上报，不让详情页 502。
    const wanted = detail.nodeRuns.map(item => item?.hub?.hubRun).filter(Number.isInteger);
    const hubRuns = wanted.length ? await collectHubRuns(before => hubRequest(config, '/v1/state' + (before == null ? '' : `?before=${before}`)), wanted) : [];
    let agentMeta = [];
    try { agentMeta = readRuleOptions(config).agents; } catch { agentMeta = []; }
    const adapters = Object.fromEntries(agentMeta.map(agent => [agent.id, agent.adapter]));
    return jsonResponse(res, 200, withHubUsage(detail, hubRuns, modelMap(agentMeta), adapters));
  }
  let sessionMatch;
  if (req.method === 'GET' && (sessionMatch = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/artifacts$/))) return jsonResponse(res, 200, { files: await config.schedulingSessions.listSessionArtifacts(decodeURIComponent(sessionMatch[1])) });
  if (req.method === 'GET' && (sessionMatch = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/file$/))) return jsonResponse(res, 200, await config.schedulingSessions.readSessionArtifact(decodeURIComponent(sessionMatch[1]), String(url.searchParams.get('path') || '')));
  if (req.method === 'GET' && (sessionMatch = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/preview$/))) {
    // A+ 产物预览：同源 GET（与 download 同姿态），HTML 流带独立宽松 CSP，配合 sandbox="allow-scripts" iframe。
    const file = await config.schedulingSessions.readSessionArtifact(decodeURIComponent(sessionMatch[1]), String(url.searchParams.get('path') || ''));
    return sendPreviewHtml(res, file.content);
  }
  if (req.method === 'GET' && (sessionMatch = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/download$/))) {
    // 二进制交付物下载：只做 attachment 流式输出（nosniff，不内联渲染），路径校验同产物读取。
    const file = await config.schedulingSessions.resolveSessionDownload(decodeURIComponent(sessionMatch[1]), String(url.searchParams.get('path') || ''));
    const asciiName = file.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    res.writeHead(200, {
      ...securityHeaders(),
      'content-type': 'application/octet-stream',
      'content-length': String(file.size),
      'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
    await new Promise(resolve => {
      const stream = createReadStream(file.real);
      stream.on('error', () => { res.destroy(); resolve(); });
      res.on('close', () => { stream.destroy(); resolve(); });
      stream.pipe(res);
    });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/detours') return jsonResponse(res, 200, { detours: readDetours(config).map(publicDetour).filter(Boolean) });
  if (req.method === 'GET' && url.pathname === '/api/delegated-cards') {
    // 先按 Hub 轮次收口已被调度处理完的退回；读 Hub 失败只跳过收口，照常列出。
    if (config.cardDelegateStore?.listPending?.().length) {
      try { settleDelegations(config.cardDelegateStore, await hubRequest(config, '/v1/state')); } catch { /* Hub 不可用：保留列表现状 */ }
    }
    const list = config.cardDelegateStore?.listPending?.() || [];
    return jsonResponse(res, 200, { cards: list.map(record => ({ cardId: record.cardId, originId: record.originId, revision: record.revision, at: record.at, status: record.status })) });
  }
  if (req.method === 'GET' && url.pathname === '/api/serial-progress') {
    const rules = readRuleOptions(config).rules || [];
    const data = await loadChains({ root: config.root, rules });
    const usage = await refreshUsage({ config, rules, chains: data.chains });
    for (const chain of data.chains) {
      // loadChains 有 mtime 缓存：拿不到当前链的台账值就必须剥掉旧值，
      // 避免把上一轮（或别的签名下）残留当成当前服务端真累计。
      // 节点自己的最近一轮（服务端台账翻遍 Hub 历史，按触发事件 subject=节点 id 归属）；拿不到就剥掉旧值，界面如实写未上报。
      const rounds = usage?.nodesByChain?.get(chain.sourceFile);
      if (rounds) chain.nodeRounds = rounds;
      else delete chain.nodeRounds;
      const cumulative = usage?.byChain.get(chain.sourceFile);
      if (cumulative) chain.cumulativeUsage = cumulative;
      else delete chain.cumulativeUsage;
    }
    return jsonResponse(res, 200, data);
  }
  if (req.method === 'GET' && url.pathname === '/api/archive') {
    // 只读：规则文件缺失/损坏时退回只用项目根发现，不影响归档读取。
    let rules = [];
    try { rules = readRuleOptions(config).rules || []; } catch { rules = []; }
    let projects = [];
    try { projects = discoverGitProjects({ roots: config.projectRoots || [], rules }).map(item => item.path); } catch { projects = []; }
    const archive = readArchive({ root: config.root, projects });
    // 最终计费/Token：串行读台账累计（按链词干归属规则），DAG 汇总节点轮次的 Hub 自报用量。
    const pseudoChains = archive.archived.filter(item => item.kind === 'serial').map(item => ({ sourceFile: `${item.source}-serial.json`, project: item.project }));
    let byChain = new Map();
    if (pseudoChains.length) { try { byChain = (await refreshUsage({ config, rules, chains: pseudoChains }))?.byChain || new Map(); } catch { byChain = new Map(); } }
    const archived = await attachArchiveUsage(archive.archived, {
      // 链词干没有认领任何规则时不用项目回退（归档链没有活跃链做排除，会把整个项目的用量算给它）。
      chainUsageFor: item => (chainRuleNames(`${item.source}-serial.json`, rules).length ? byChain.get(`${item.source}-serial.json`) : null),
      dagUsageFor: async item => {
        if (!config.dagService) return null;
        const detail = config.dagService.get(item.runId);
        const wanted = detail.nodeRuns.map(run => run?.hub?.hubRun).filter(Number.isInteger);
        const hubRuns = wanted.length ? await collectHubRuns(before => hubRequest(config, '/v1/state' + (before == null ? '' : `?before=${before}`)), wanted) : [];
        // 取不全（Hub 不可达/翻页上限）就不缓存也不给数：宁可写未上报，不给偏低的"最终值"。
        if (wanted.length && !wanted.every(id => hubRuns.some(run => Number(run?.id) === id))) return null;
        return sumRunUsage(withHubUsage(detail, hubRuns).nodeRuns);
      },
    });
    return jsonResponse(res, 200, { archived });
  }
  if (req.method === 'GET' && url.pathname === '/api/project-usage') {
    const rules = readRuleOptions(config).rules || [];
    const usage = await refreshUsage({ config, rules, chains: [] });
    const state = await hubRequest(config, '/v1/state');
    return jsonResponse(res, 200, aggregateProjectUsage({ state, rules, cumulativeByRule: usage?.byRule }));
  }
  if (req.method === 'GET' && url.pathname === '/api/closeouts') return jsonResponse(res, 200, { closeouts: readCloseouts(config.root) });
  if (req.method === 'GET' && url.pathname === '/api/devices') {
    if (!config.deviceAuth) throw new RequestError(503, '设备授权通道不可用（未配置数据目录）');
    return jsonResponse(res, 200, { devices: config.deviceAuth.listDevices(), audit: config.deviceAuth.listAudit() });
  }
  if (req.method === 'POST' && url.pathname === '/api/session-classify') {
    const body = await readJson(req);
    return jsonResponse(res, 200, classifySessionRequest(body.text));
  }
  if (req.method === 'POST' && url.pathname === '/api/speech/transcribe') return handleSpeechTranscribe(config, req, res);
  // 移动端安全入口（Spec §5）：设备级授权 + 固定只读 API 中继 + HTTPS，不新增弱认证入口。
  // 控制台仍只监听本机；公网 HTTPS 终结与设备级网关的部署需单独授权，不在本 PR 内暴露远程访问。
  if (url.pathname.startsWith('/api/mobile/')) {
    requireSecureTransport(req);
    // 首次绑定：一次性二维码令牌是唯一能力凭证；非浏览器客户端不受同源 CSRF 头约束，但拒绝跨站请求。
    if (req.method === 'POST' && url.pathname === '/api/mobile/bind') {
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, '拒绝跨站绑定请求');
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new RequestError(415, '绑定内容必须是 JSON');
      if (!config.deviceAuth) throw new RequestError(503, '设备授权通道不可用（未配置数据目录）');
      const bindBody = await readJson(req);
      return jsonResponse(res, 201, config.deviceAuth.bindDevice(bindBody));
    }
    if (req.method !== 'GET' && url.pathname === '/api/mobile/session') throw new RequestError(404, '没有这个控制台地址');
    const device = requireMobileDevice(req, config);
    // 写路由钩子：设备鉴权之后、GET-only 闸之前。返回 true 表示已处理（当前为 501 占位）。
    if (handleMobileWrite(req, res, url, { device, config })) return true;
    if (req.method !== 'GET') throw new RequestError(404, '没有这个控制台地址');
    if (url.pathname === '/api/mobile/session') {
      return jsonResponse(res, 200, { device, apis: [...MOBILE_API_ALLOWLIST.keys()], secure: true });
    }
    const relayMatch = url.pathname.match(/^\/api\/mobile\/api\/([^/]+)$/);
    if (relayMatch) {
      const target = MOBILE_API_ALLOWLIST.get(relayMatch[1]);
      if (!target) throw new RequestError(404, '该 API 不在移动端允许列表中');
      // 目标路径来自服务端常量，查询串不转发；因此不会成为任意 URL 代理。
      return handleApi(config, req, res, new URL(target, 'http://localhost'));
    }
    throw new RequestError(404, '没有这个控制台地址');
  }
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return false;
  checkWrite(req); const body = await readJson(req);
  const continueMatch = req.method === 'POST' ? url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/continue$/) : null;
  if (continueMatch) {
    const id = decodeURIComponent(continueMatch[1]);
    const archived = await config.schedulingSessions.listArchived();
    const record = archived.find(item => item.id === id);
    if (!record) throw new RequestError(404, '会话存档不存在');
    const known = discoverGitProjects({ roots: config.projectRoots || [], rules: readRuleOptions(config).rules || [] }).find(item => item.path === record.project);
    if (!known) throw new RequestError(400, '该项目已不在已发现的 Git 仓库列表中，无法继续');
    return jsonResponse(res, 201, await config.schedulingSessions.continueSession(id));
  }
  if (req.method === 'POST' && url.pathname === '/api/scheduling-sessions') {
    const project = String(body.project || '');
    const known = discoverGitProjects({ roots: config.projectRoots || [], rules: readRuleOptions(config).rules || [] }).find(item => item.path === project);
    if (!known) throw new RequestError(400, '项目不在已发现的 Git 仓库列表中，请从下拉选择');
    // 创建流：首轮提示词必填，创建完成前会话不执行任何轮次；kind 缺省时按首轮语义分类，显式 kind 视为用户覆盖。
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) throw new RequestError(400, '请先输入首轮提示词，再创建会话');
    const explicit = body.kind === undefined || body.kind === null || body.kind === '' ? null : String(body.kind);
    if (explicit && !['normal', 'scheduling', 'design'].includes(explicit)) throw new RequestError(400, '会话类型必须是 normal、scheduling 或 design');
    const kind = explicit || classifySessionRequest(prompt).kind;
    if (!kind) throw new RequestError(400, '无法判定会话类型，请补充首轮提示词');
    return jsonResponse(res, 201, await config.schedulingSessions.start({ kind, prompt, project: known.path }));
  }
  if (req.method === 'POST' && url.pathname === '/api/dag-runs') {
    if (!config.dagService) throw new RequestError(503, 'DAG 通道不可用（未配置运行目录）');
    const known = discoverGitProjects({ roots: config.projectRoots || [], rules: readRuleOptions(config).rules || [] }).find(item => item.path === path.resolve(String(body.project || '')));
    if (!known) throw new RequestError(400, '项目不在已发现的 Git 仓库列表中，请从下拉选择');
    return jsonResponse(res, 201, await config.dagService.create(body, known.path));
  }
  if (req.method === 'POST' && (dagMatch = url.pathname.match(/^\/api\/dag-runs\/([^/]+)\/cancel$/))) {
    if (!config.dagService) throw new RequestError(503, 'DAG 通道不可用（未配置运行目录）');
    return jsonResponse(res, 200, config.dagService.cancel(decodeURIComponent(dagMatch[1])));
  }
  if (req.method === 'POST' && (dagMatch = url.pathname.match(/^\/api\/dag-runs\/([^/]+)\/revive$/))) {
    if (!config.dagService) throw new RequestError(503, 'DAG 通道不可用（未配置运行目录）');
    return jsonResponse(res, 200, config.dagService.revive(decodeURIComponent(dagMatch[1]), String(body.nodeId || ''), body));
  }
  if (req.method === 'POST' && (dagMatch = url.pathname.match(/^\/api\/dag-runs\/([^/]+)\/slots\/([^/]+)\/slot-release$/))) {
    if (!config.dagService) throw new RequestError(503, 'DAG 通道不可用（未配置运行目录）');
    return jsonResponse(res, 200, await config.dagService.slotRelease(decodeURIComponent(dagMatch[1]), decodeURIComponent(dagMatch[2]), body));
  }
  if (req.method === 'POST' && ['/api/card-router/activate', '/api/card-router/rollback', '/api/card-router/publish'].includes(url.pathname)) {
    if (!config.cardRouting) throw new RequestError(503, '卡片路由不可用（未配置数据目录）');
    if (url.pathname.endsWith('/rollback')) return jsonResponse(res, 200, config.cardRouting.rollback());
    // 服务端发布入口（issue #97）：与 activate/rollback 同一 store 实例，评测→注册→persist，
    // 消除 CLI 与 server 跨进程双写竞态。复用 routing.publish 的评测门禁与幂等语义。
    if (url.pathname.endsWith('/publish')) {
      try { return jsonResponse(res, 200, await config.cardRouting.publish(body)); }
      catch (error) { if (error instanceof CardFilterError) throw new RequestError(error.code === 'SNAPSHOT_WRITE_FAILED' ? 500 : 400, error.message); throw error; }
    }
    if (typeof body.version !== 'string' || !body.version) throw new RequestError(400, '缺少版本号');
    try { return jsonResponse(res, 200, config.cardRouting.activate(body.version)); }
    catch (error) { if (error instanceof CardFilterError) throw new RequestError(error.code === 'VERSION_MISSING' ? 404 : 400, error.message); throw error; }
  }
  if (req.method === 'POST' && url.pathname === '/api/rules') return jsonResponse(res, 201, await saveRule(config, body, null));
  if (req.method === 'PUT' && url.pathname === '/api/admin/platform-models') {
    // DAG 分档规则只为控制台已发现的 Git 项目生成；事件类型由 dagEventType 统一计算（与派发方一致）。
    const dagProjects = discoverGitProjects({ roots: config.projectRoots || [], rules: readRuleOptions(config).rules || [] }).map(item => item.path);
    return jsonResponse(res, 200, await applyPlatformModels(config, body, { check: config.platformCheck || defaultCheck, dagProjects }));
  }
  let match;
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/queue\/clear$/))) return jsonResponse(res, 200, await config.schedulingSessions.clearQueued(decodeURIComponent(match[1])));
  if (req.method === 'PUT' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/queue\/([^/]+)$/))) return jsonResponse(res, 200, await config.schedulingSessions.updateQueued(decodeURIComponent(match[1]), decodeURIComponent(match[2]), String(body.text ?? '')));
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/queue\/([^/]+)\/move$/))) return jsonResponse(res, 200, await config.schedulingSessions.moveQueued(decodeURIComponent(match[1]), decodeURIComponent(match[2]), String(body.direction || '')));
  if (req.method === 'DELETE' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/queue\/([^/]+)$/))) return jsonResponse(res, 200, await config.schedulingSessions.removeQueued(decodeURIComponent(match[1]), decodeURIComponent(match[2])));
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/queue\/([^/]+)\/steer$/))) return jsonResponse(res, 200, await config.schedulingSessions.steerQueued(decodeURIComponent(match[1]), decodeURIComponent(match[2])));
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/close$/))) return jsonResponse(res, 200, await config.schedulingSessions.close(decodeURIComponent(match[1])));
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/approve-plan$/))) return jsonResponse(res, 200, await config.schedulingSessions.approvePlan(decodeURIComponent(match[1])));
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/messages$/))) return jsonResponse(res, 200, await config.schedulingSessions.send(decodeURIComponent(match[1]), body.text, { interrupt: body.interrupt === true }));
  if (req.method === 'PUT' && (match = url.pathname.match(/^\/api\/rules\/([^/]+)$/))) return jsonResponse(res, 200, await saveRule(config, body, decodeURIComponent(match[1])));
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/rules\/([^/]+)\/(run|pause|resume)$/))) {
    const name = decodeURIComponent(match[1]); const action = match[2];
    const payload = action === 'run' ? { ...(body.subject ? { subject: String(body.subject) } : {}), ...(body.reason ? { reason: String(body.reason) } : {}) } : action === 'pause' ? { ...(body.reason ? { reason: String(body.reason) } : {}) } : {};
    return jsonResponse(res, 200, await hubRequest(config, `/v1/rules/${encodeURIComponent(name)}/${action}`, { method: 'POST', body: payload }));
  }
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/))) return jsonResponse(res, 200, await hubRequest(config, `/v1/runs/${idOf(match[1])}/cancel`, { method: 'POST', body: {} }));
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/cards\/([^/]+)\/(answer|resolve)$/))) {
    const id = idOf(match[1]); const action = match[2];
    const payload = action === 'answer' ? (body.choice !== undefined ? { choice: Number(body.choice) } : { text: String(body.text || '') }) : { reason: String(body.reason || '') };
    // 先读状态再结案：已结案卡片可能从 /v1/state 的 cards 列表消失，lane 必须在结案前取到。
    // 读失败不拦回答（answer 本身才是用户动作），只把唤醒标记为 failed。
    // 只有注入了支持唤醒的会话管理器才查状态；生产由 createConsoleServer 自动装配，
    // 无 sessions 形参时 config.schedulingSessions 是新建的（同样带该方法），测试里传 null 即跳过整段。
    const canWake = action === 'answer' && typeof config.schedulingSessions?.notifyCardAnswered === 'function';
    let card = null; let stateFailed = false;
    if (canWake) {
      try {
        const state = await hubRequest(config, '/v1/state');
        card = (state?.cards || []).find(item => Number(item?.id) === id) || null;
      } catch { stateFailed = true; }
    }
    const result = await hubRequest(config, `/v1/cards/${id}/${action}`, { method: 'POST', body: payload });
    // 回答后唤醒卡片所在事项的调度会话：只有 answer 且 card.lane 对应一个活着的 Hub 会话才发事件；
    // 找不到会话/发送失败都不影响卡片已结案的事实。
    let schedulingWake = 'skipped';
    if (canWake) {
      if (stateFailed) schedulingWake = 'failed';
      else if (!card) schedulingWake = 'no-session';
      else {
        try {
          const answerText = payload.choice !== undefined
            ? String(card.options?.[payload.choice] ?? `选项 ${payload.choice}`)
            : String(payload.text || '');
          schedulingWake = await config.schedulingSessions.notifyCardAnswered({ card, answerText }) ? 'sent' : 'no-session';
        } catch { schedulingWake = 'failed'; }
      }
    }
    const routingFeedback = action === 'answer' ? recordCardFeedback(config, id, 'direct-answer') : undefined;
    return jsonResponse(res, 200, { ...result, schedulingWake, ...(routingFeedback ? { routingFeedback } : {}) });
  }
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/cards\/([^/]+)\/delegate$/))) {
    const id = idOf(match[1]);
    const state = await hubRequest(config, '/v1/state');
    const card = (state?.cards || []).find(item => Number(item?.id) === id);
    if (!card) throw new RequestError(404, '卡片不存在或已结案');
    const delegated = await delegateOpenCard({
      card,
      store: config.cardDelegateStore,
      postEvent: event => hubRequest(config, '/v1/events', { method: 'POST', body: event, auth: 'source' }),
      resolveCard: (cardId, reason) => hubRequest(config, `/v1/cards/${cardId}/resolve`, { method: 'POST', body: { reason } }),
    });
    return jsonResponse(res, 200, { ...delegated, routingFeedback: recordCardFeedback(config, id, 'manual-return') });
  }
  // 设备授权管理后台：与规则/会话写操作共用 checkWrite，不新增弱认证入口。
  if (url.pathname.startsWith('/api/devices')) {
    if (!config.deviceAuth) throw new RequestError(503, '设备授权通道不可用（未配置数据目录）');
    if (req.method === 'POST' && url.pathname === '/api/devices/bindings') return jsonResponse(res, 201, config.deviceAuth.createBinding());
    if (req.method === 'POST' && url.pathname === '/api/devices/bind') return jsonResponse(res, 201, config.deviceAuth.bindDevice(body));
    let deviceMatch;
    if (req.method === 'POST' && (deviceMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/))) return jsonResponse(res, 200, config.deviceAuth.revokeDevice(decodeURIComponent(deviceMatch[1]), { type: 'admin' }));
    if (req.method === 'POST' && (deviceMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/rename$/))) return jsonResponse(res, 200, config.deviceAuth.renameDevice(decodeURIComponent(deviceMatch[1]), body.name, { type: 'admin' }));
  }
  return false;
}
// 人工处理结果记成路由学习样本；失败只记日志，不影响退回/回答主路径。
function recordCardFeedback(config, cardId, kind) {
  if (!config.cardRouting?.recordFeedback) return 'skipped';
  try { return config.cardRouting.recordFeedback(cardId, kind); }
  catch (error) { console.error(`[card-router] 反馈记录失败：${error.message}`); return 'failed'; }
}
// 空会话管理器：不暴露 notifyCardAnswered，唤醒分支自动跳过。
// 用于纯转发 API 测试：不装配真实管理器，也不触发 /v1/state 预读。
const NULL_SESSIONS = {
  async list() { return []; },
  async listArchived() { return { sessions: [] }; },
};

export function createConsoleServer(config, schedulingSessions) {
  // schedulingSessions === false 为显式关闭会话：用 NULL_SESSIONS，不装配真实管理器。
  // undefined/null 走默认装配；其余对象按注入件使用。
  if (schedulingSessions === false) schedulingSessions = NULL_SESSIONS;
  else if (!schedulingSessions) {
    const writableDir = config.root ? path.join(config.root, 'scripts') : null;
    let allowedDir = writableDir;
    if (allowedDir) {
      try { mkdirSync(allowedDir, { recursive: true }); }
      catch (error) { console.error(`[console] 脚本目录 ${allowedDir} 创建失败，会话按只读处理：${error.message}`); allowedDir = null; }
    }
    schedulingSessions = new SchedulingSessionManager({ maxSessions: config.maxSessions, writableDir: allowedDir, archiveRoot: config.root, hubScheduling: new HubSchedulingSessionAdapter({ hubConfig: config }), sessionLaunch: kind => sessionLaunch(config, kind) });
  }
  const dagService = config.dagService || (config.root ? createDagService({ root: config.root, storeDirectory: path.join(config.root, 'dag-runs') }) : null);
  // 退回记录落盘：重启后「待代理决策」列表不丢；无运行目录退回内存 store（退回行为不变）。
  const cardDelegateStore = config.cardDelegateStore || createCardDelegateStore({ file: config.root ? path.join(config.root, 'card-delegates.json') : null });
  const deviceAuth = config.deviceAuth || createDeviceStore({ file: config.root ? path.join(config.root, 'device-auth.json') : null });
  const whisperTranscriber = config.whisperTranscriber || createWhisperTranscriber(config.whisper || {});
  config = { ...config, whisperTranscriber, schedulingSessions, dagService, cardDelegateStore, deviceAuth, cardRouting: config.cardRouting || getCardRouting(config) };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const host = req.headers.host?.split(':')[0]?.toLowerCase();
    if (!['127.0.0.1', 'localhost'].includes(host)) return jsonResponse(res, 403, { error: '控制台只接受本机地址' });
    try { if (url.pathname.startsWith('/api/') && await handleApi(config, req, res, url) !== false) return; }
    catch (error) {
      const status = error instanceof RequestError || error instanceof RuleError || error instanceof PlatformModelsError || error instanceof SchedulingSessionError || error instanceof DagServiceError || error instanceof CardDelegateError || error instanceof DeviceAuthError ? error.status || 400 : error instanceof HubError && error.status < 500 ? error.status : 502;
      return jsonResponse(res, status, { error: error.message, ...(error instanceof SchedulingSessionError && error.conflict ? { conflict: error.conflict } : {}) });
    }
    const asset = FILES.get(url.pathname);
    if (asset && req.method === 'GET') {
      try { const body = readFileSync(path.join(PUBLIC, asset[0])); res.writeHead(200, { ...securityHeaders(), 'content-type': asset[1] }); return res.end(body); }
      catch { return jsonResponse(res, 404, { error: '控制台资源尚未安装' }); }
    }
    // A+ 产物预览兑换：一次性票据 → HTML 流（iframe src 带不了设备头，票据在写路由里设备鉴权换发）。
    if (url.pathname === '/mobile/preview' && req.method === 'GET') {
      const entry = redeemPreviewTicket(url.searchParams.get('ticket'));
      if (!entry) return jsonResponse(res, 404, { error: '预览凭证无效或已过期，请重试' });
      const file = await config.schedulingSessions.readSessionArtifact(entry.id, entry.path);
      return sendPreviewHtml(res, file.content);
    }
    const mobileAsset = MOBILE_FILES.get(url.pathname);
    if (mobileAsset && req.method === 'GET') {
      try { return sendMobileAsset(res, url, readFileSync(path.join(MOBILE, mobileAsset[0])), mobileAsset[1]); }
      catch { return jsonResponse(res, 404, { error: '移动端资源尚未安装' }); }
    }
    if (req.method === 'GET') {
      const resolved = resolveMobileAsset(url.pathname);
      if (resolved) {
        return sendMobileAsset(res, url, resolved.body, resolved.type);
      }
    }
    return jsonResponse(res, 404, { error: '没有这个控制台地址' });
  });
  // §6.3 重启后按 Hub 事项恢复调度会话视图；由启动脚本在 listen 后调用。失败只记录，不阻止控制台启动。
  server.restoreSchedulingSessions = () => schedulingSessions.restoreFromHub().catch(error => {
    console.error(`[console] 恢复 Hub 调度会话失败：${error.message}`);
  });
  // 会话新回复通知的事件源：启动脚本手里只有原始 config，会话管理器只在这里装配，故由 server 暴露只读列表。
  server.listSessions = () => schedulingSessions.list();
  server.on('close', () => schedulingSessions.dispose?.());
  return server;
}
