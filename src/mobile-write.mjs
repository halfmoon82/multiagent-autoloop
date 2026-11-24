// 移动端写路由实现：在设备鉴权之后、GET-only 闸之前被调用。
// 复用网页控制台的同一服务入口（hubRequest / config.schedulingSessions），不另造状态；
// 所有写入记录来源设备 id。校验口径与 server.mjs 的 checkWrite 对齐（同源 + 自定义头 + JSON），
// 并额外要求 x-device-token（由 server 的 requireMobileDevice 验证后传入 ctx.device）。
// 自包含响应助手与同步 handleMobileWrite 签名，避免改动 server.mjs 或与它形成循环依赖。

import { createReadStream } from 'node:fs';
import { hubRequest, HubError } from './hub.mjs';
import { discoverGitProjects } from './projects.mjs';
import { readRuleOptions, defaultCheck } from './rules.mjs';
import { readPlatformModels, applyPlatformModels, PlatformModelsError } from './platform-models.mjs';
import { loadPolicy } from './detour-policy.mjs';
import { reconcile, syncPrompt, createSyncState } from '../mobile/src/features/device-sync/index.mjs';
import { classifySessionRequest } from './session-classify.mjs';
import { SchedulingSessionError } from './scheduling-session.mjs';

function securityHeaders() {
  return {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

function jsonResponse(res, status, value) {
  res.writeHead(status, { ...securityHeaders(), 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

// 路由表：method + 路径模式 + 稳定 key。后续节点按 key 覆盖实现，不改这张表。
export const MOBILE_WRITE_ROUTES = Object.freeze([
  { key: 'card-answer', method: 'POST', pattern: /^\/api\/mobile\/cards\/([^/]+)\/answer$/ },
  { key: 'card-authorize', method: 'POST', pattern: /^\/api\/mobile\/cards\/([^/]+)\/authorize$/ },
  { key: 'session-continue', method: 'POST', pattern: /^\/api\/mobile\/sessions\/([^/]+)\/continue$/ },
  { key: 'session-download', method: 'GET', pattern: /^\/api\/mobile\/sessions\/([^/]+)\/download$/ },
  { key: 'sync', method: 'GET', pattern: /^\/api\/mobile\/sync$/ },
  { key: 'sync', method: 'POST', pattern: /^\/api\/mobile\/sync$/ },
  { key: 'rule-action', method: 'POST', pattern: /^\/api\/mobile\/rules\/([^/]+)\/(run|pause|resume)$/ },
  { key: 'session-classify', method: 'POST', pattern: /^\/api\/mobile\/session-classify$/ },
  { key: 'admin-platform-models', method: 'GET', pattern: /^\/api\/mobile\/admin\/platform-models$/ },
  { key: 'admin-platform-models', method: 'PUT', pattern: /^\/api\/mobile\/admin\/platform-models$/ },
  { key: 'session-queue-clear', method: 'POST', pattern: /^\/api\/mobile\/sessions\/([^/]+)\/queue\/clear$/ },
  { key: 'session-queue-update', method: 'PUT', pattern: /^\/api\/mobile\/sessions\/([^/]+)\/queue\/([^/]+)$/ },
  { key: 'session-queue-move', method: 'POST', pattern: /^\/api\/mobile\/sessions\/([^/]+)\/queue\/([^/]+)\/move$/ },
  { key: 'session-queue-remove', method: 'DELETE', pattern: /^\/api\/mobile\/sessions\/([^/]+)\/queue\/([^/]+)$/ },
  { key: 'session-queue-steer', method: 'POST', pattern: /^\/api\/mobile\/sessions\/([^/]+)\/queue\/([^/]+)\/steer$/ },
  { key: 'session-message', method: 'POST', pattern: /^\/api\/mobile\/sessions\/([^/]+)\/messages$/ },
  { key: 'session-create', method: 'POST', pattern: /^\/api\/mobile\/sessions$/ },
]);

const NOT_IMPLEMENTED = Object.freeze({
  // 同步路由已实现；仅 scaffold 兼容路径（ctx 无 config/device）仍返回占位。
  sync: '设备同步尚未实现',
});

// 与 checkWrite 同等校验；GET 路由不要求 JSON content-type。
// 隧道形态例外：cloudflared 按 originRequest.httpHostHeader 把 Host 改写为 127.0.0.1:50761，
// WebView 的 Origin 仍是公网控制台地址，两者必然不等。x-forwarded-proto 只可能由本机隧道
// 终结者附加（控制台仅监听回环，公网请求必经过它），此形态下不再要求 Origin===Host；
// 跨站浏览器请求仍被 sec-fetch-site 闸与 x-device-token 双重拦下，CSRF 防线不削弱。
function validate(req, needsJson) {
  const origin = req.headers.origin;
  const tunneled = typeof req.headers['x-forwarded-proto'] === 'string' && req.headers['x-forwarded-proto'].length > 0;
  if (origin && !tunneled && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    return { status: 403, error: '拒绝跨站操作' };
  }
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
    return { status: 403, error: '拒绝跨站操作' };
  }
  if (req.headers['x-console-request'] !== '1') {
    return { status: 403, error: '缺少控制台请求标记' };
  }
  if (needsJson && req.headers['content-type']?.split(';')[0] !== 'application/json') {
    return { status: 415, error: '操作内容必须是 JSON' };
  }
  if (typeof req.headers['x-device-token'] !== 'string' || !req.headers['x-device-token']) {
    return { status: 401, error: '设备未授权或授权已失效，请重新绑定' };
  }
  return null;
}

// 只向客户端返回固定的用户可读文案，绝不回显 Hub 错误体、堆栈或内部配置。
const SAFE_ERRORS = Object.freeze({
  400: '请求无效',
  429: '排队消息过多，请稍后再试',
  401: '设备未授权或授权已失效，请重新绑定',
  403: '拒绝跨站操作',
  404: '目标不存在或已失效',
  409: '事项已失效或已处理',
  413: '请求内容过大',
  415: '操作内容必须是 JSON',
});
class WriteError extends Error { constructor(status, message) { super(message || SAFE_ERRORS[status] || '操作暂时不可用，请稍后重试'); this.status = status; } }
const fail = (status, message) => { throw new WriteError(status, message); };

function parseId(text) {
  if (!/^[1-9][0-9]*$/.test(text)) fail(404);
  const id = Number(text);
  if (!Number.isSafeInteger(id)) fail(404);
  return id;
}

async function readJson(req, maxBytes = 65536) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) fail(413); chunks.push(chunk); }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { fail(400); }
}

function writeError(res, error) {
  if (res.writableEnded) return;
  const status = error instanceof WriteError ? error.status
    : error instanceof HubError && error.status >= 400 && error.status < 500 ? error.status
      : error?.status >= 400 && error?.status < 500 ? error.status
        : 502;
  // 本地会话态错误（已关闭/异常等）的 message 本就是给用户看的中文文案，与网页端同口径透传；
  // 其余非 WriteError 一律回落固定文案，不回显 Hub 错误体或内部细节。
  // PlatformModelsError 与网页端同口径：校验文案（如「三档要么都填，要么都不填」）直接给人看，不吞成「请求无效」。
  const passthrough = (error instanceof SchedulingSessionError || error instanceof PlatformModelsError) && status >= 400 && status < 500 && error.message;
  jsonResponse(res, status, { error: error instanceof WriteError ? error.message : passthrough || (SAFE_ERRORS[status] || '操作暂时不可用，请稍后重试') });
}

// 关键操作审计：来源设备、时间、结果由设备台账写入。成功路径写失败要报错（不吞为成功）；
// 失败路径是尽力留痕，不覆盖原始错误。
function audit(ctx, req, action, fields, result = 'ok') {
  const store = ctx.config.deviceAuth;
  if (typeof store?.recordDeviceEvent !== 'function') return;
  store.recordDeviceEvent(req.headers['x-device-token'], action, fields, result);
}
function auditFailure(ctx, req, action, fields) {
  try { audit(ctx, req, action, fields, 'failed'); } catch { /* 保留原始错误 */ }
}

async function cardWrite(route, req, res, url, ctx, body) {
  const { config, device } = ctx;
  const cardId = parseId(url.pathname.match(route.pattern)[1]);
  // 与网页回答一致：先读状态确认卡片与可答性，再调用同一 /v1/cards/:id/answer。
  const state = await hubRequest(config, '/v1/state');
  const card = (state?.cards || []).find(item => Number(item?.id) === cardId);
  if (!card) fail(404);
  if (card.state !== 'open') {
    // 重复提交幂等：返回当前状态，不再触发 hub 写入。
    jsonResponse(res, 200, { id: card.id, state: card.state, answer: card.answer, idempotent: true });
    return;
  }
  let payload;
  if (route.key === 'card-authorize') {
    if (body.approved === undefined && body.choice === undefined) fail(400);
    payload = body.choice !== undefined ? { choice: Number(body.choice) } : { choice: body.approved === true ? 0 : 1 };
  } else {
    if (body.choice === undefined && typeof body.text !== 'string') fail(400);
    payload = body.choice !== undefined ? { choice: Number(body.choice) } : { text: String(body.text) };
  }
  const auditAction = route.key === 'card-authorize' ? 'card.authorize' : 'card.answer';
  let result;
  try {
    result = await hubRequest(config, `/v1/cards/${cardId}/answer`, { method: 'POST', body: { ...payload, sourceDeviceId: device.id } });
  } catch (error) { auditFailure(ctx, req, auditAction, { cardId: String(cardId) }); throw error; }
  audit(ctx, req, auditAction, { cardId: String(cardId) });
  // 唤醒调度会话：与网页 answer 同一会话管理器与判定，失败不影响卡片已结案。
  let schedulingWake = 'skipped';
  if (typeof config.schedulingSessions?.notifyCardAnswered === 'function') {
    try {
      const answerText = payload.choice !== undefined
        ? String(card.options?.[payload.choice] ?? `选项 ${payload.choice}`)
        : String(payload.text || '');
      schedulingWake = await config.schedulingSessions.notifyCardAnswered({ card, answerText }) ? 'sent' : 'no-session';
    } catch { schedulingWake = 'failed'; }
  }
  jsonResponse(res, 200, { ...result, schedulingWake });
}

async function sessionContinue(res, url, route, ctx) {
  const id = decodeURIComponent(url.pathname.match(route.pattern)[1]);
  if (!id) fail(404);
  const sessions = ctx.config.schedulingSessions;
  const archived = await sessions.listArchived();
  const list = Array.isArray(archived) ? archived : (archived?.sessions || []);
  const record = list.find(item => item?.id === id);
  if (!record) fail(404);
  // 不放宽网页侧校验：项目必须仍在已发现仓库列表中。
  const known = discoverGitProjects({ roots: ctx.config.projectRoots || [], rules: readRuleOptions(ctx.config).rules || [] }).find(item => item.path === record.project);
  if (!known) fail(400);
  const result = await sessions.continueSession(id);
  jsonResponse(res, 201, { ...result, sourceDeviceId: ctx.device.id });
}

async function sessionDownload(res, url, route, ctx) {
  const id = decodeURIComponent(url.pathname.match(route.pattern)[1]);
  const requested = String(url.searchParams.get('path') || '');
  const file = await ctx.config.schedulingSessions.resolveSessionDownload(id, requested);
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
}

// 首轮语义分类：与网页 /api/session-classify 同一纯函数，无额外状态。
function sessionClassifyRoute(res, body) {
  return jsonResponse(res, 200, classifySessionRequest(body.text));
}

// 创建会话：校验口径与网页 /api/scheduling-sessions 逐条对齐（项目必须在已发现列表、
// 首轮提示词必填、kind 只收 normal/scheduling/design，缺省按语义分类），写入复用同一
// config.schedulingSessions.start，不另造状态；来源设备 id 随审计记录。
// 会话消息：与网页 /api/scheduling-sessions/:id/messages 同一 sessions.send，不另造状态。
async function sessionMessageRoute(res, url, route, ctx, body, req) {
  const sessions = ctx.config.schedulingSessions;
  if (!sessions || typeof sessions.send !== 'function') fail(503, '会话通道不可用');
  const id = decodeURIComponent(url.pathname.match(route.pattern)[1]);
  const text = String(body.text ?? '').trim();
  if (!text) fail(400, '消息内容不能为空');
  const fields = { sessionId: id, sourceDeviceId: ctx.device.id };
  let result;
  try {
    result = await sessions.send(id, text, { interrupt: body.interrupt === true, ...(Array.isArray(body.attachments) && body.attachments.length ? { attachments: body.attachments } : {}) });
  } catch (error) { auditFailure(ctx, req, 'session.message', fields); throw error; }
  audit(ctx, req, 'session.message', fields);
  jsonResponse(res, 200, { ...result, sourceDeviceId: ctx.device.id });
}

async function sessionQueueRoute(res, url, route, ctx, body, req) {
  const sessions = ctx.config.schedulingSessions;
  const match = url.pathname.match(route.pattern);
  const id = decodeURIComponent(match[1]);
  const itemId = match[2] ? decodeURIComponent(match[2]) : null;
  const methods = {
    'session-queue-clear': ['clearQueued', [id]],
    'session-queue-update': ['updateQueued', [id, itemId, String(body.text ?? '')]],
    'session-queue-move': ['moveQueued', [id, itemId, String(body.direction ?? '')]],
    'session-queue-remove': ['removeQueued', [id, itemId]],
    'session-queue-steer': ['steerQueued', [id, itemId]],
  };
  const [method, args] = methods[route.key] || [];
  if (!method || typeof sessions?.[method] !== 'function') fail(503, '会话队列通道不可用');
  const fields = { sessionId: id, queueItemId: itemId, sourceDeviceId: ctx.device.id };
  let result;
  try { result = await sessions[method](...args); }
  catch (error) { auditFailure(ctx, req, 'session.queue', fields); throw error; }
  audit(ctx, req, 'session.queue', fields);
  jsonResponse(res, 200, { ...result, sourceDeviceId: ctx.device.id });
}

async function adminPlatformModelsRoute(res, ctx, body, req) {
  const { config, device } = ctx;
  if (req.method === 'GET') {
    let policy = null; try { policy = loadPolicy(config); } catch { policy = null; }
    jsonResponse(res, 200, readPlatformModels(config, { policy }));
    return;
  }
  const dagProjects = discoverGitProjects({ roots: config.projectRoots || [], rules: readRuleOptions(config).rules || [] }).map(item => item.path);
  let result;
  try { result = await applyPlatformModels(config, body, { check: config.platformCheck || defaultCheck, dagProjects }); }
  catch (error) { auditFailure(ctx, req, 'admin.platform.models', { sourceDeviceId: device.id }); throw error; }
  audit(ctx, req, 'admin.platform.models', { sourceDeviceId: device.id });
  jsonResponse(res, 200, { ...result, sourceDeviceId: device.id });
}

async function sessionCreateRoute(res, body, ctx, req) {
  const sessions = ctx.config.schedulingSessions;
  if (!sessions || typeof sessions.start !== 'function') fail(503, '会话通道不可用');
  const project = String(body.project || '');
  const known = discoverGitProjects({ roots: ctx.config.projectRoots || [], rules: readRuleOptions(ctx.config).rules || [] }).find(item => item.path === project);
  if (!known) fail(400, '项目不在已发现的 Git 仓库列表中，请从下拉选择');
  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) fail(400, '请先输入首轮提示词，再创建会话');
  const explicit = body.kind === undefined || body.kind === null || body.kind === '' ? null : String(body.kind);
  if (explicit && !['normal', 'scheduling', 'design'].includes(explicit)) fail(400, '会话类型必须是 normal、scheduling 或 design');
  const kind = explicit || classifySessionRequest(prompt).kind;
  if (!kind) fail(400, '无法判定会话类型，请补充首轮提示词');
  const fields = { project: known.path, kind, sourceDeviceId: ctx.device.id };
  let result;
  try {
    result = await sessions.start({ kind, prompt, project: known.path });
  } catch (error) { auditFailure(ctx, req, 'session.create', fields); throw error; }
  audit(ctx, req, 'session.create', fields);
  jsonResponse(res, 201, { ...result, sourceDeviceId: ctx.device.id });
}

async function ruleAction(req, res, url, route, ctx, body) {
  const match = url.pathname.match(route.pattern);
  const name = decodeURIComponent(match[1]);
  const action = match[2];
  if (!['run', 'pause', 'resume'].includes(action)) fail(404);
  const payload = action === 'run'
    ? { ...(body.subject ? { subject: String(body.subject) } : {}), ...(body.reason ? { reason: String(body.reason) } : {}) }
    : action === 'pause' ? { ...(body.reason ? { reason: String(body.reason) } : {}) } : {};
  const fields = { ruleName: name, ruleAction: action };
  let result;
  try {
    result = await hubRequest(ctx.config, `/v1/rules/${encodeURIComponent(name)}/${action}`, {
      method: 'POST', body: payload,
    });
  } catch (error) { auditFailure(ctx, req, 'rule.action', fields); throw error; }
  audit(ctx, req, 'rule.action', fields);
  jsonResponse(res, 200, result);
}

// 多设备同步：GET 取最新一致状态（含 since 增量判定），POST 提交结论；版本号/冲突按 device-sync reconcile，
// 冲突取最新一次提交、重复提交不双写。移动端只能操作自身设备：指定他人 deviceId 一律 403 并留痕。
async function syncRoute(req, res, url, ctx, body) {
  const store = ctx.config.deviceAuth;
  if (typeof store?.getSyncState !== 'function' || typeof store?.submitDecision !== 'function') fail(503);
  const token = req.headers['x-device-token'];
  const { device } = ctx;
  const requested = req.method === 'GET' ? url.searchParams.get('deviceId') : body.deviceId;
  if (requested !== undefined && requested !== null && requested !== device.id) {
    auditFailure(ctx, req, 'sync.denied', { targetDeviceId: String(requested) });
    fail(403, '移动端只能访问本机设备的同步信息');
  }
  const asRevision = (value, label) => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) fail(400, `${label}无效`);
    return n;
  };
  const before = store.getSyncState(token);
  if (req.method === 'GET') {
    const since = asRevision(url.searchParams.get('since'), '版本号');
    const changed = since === undefined ? true : reconcile({ ...createSyncState(), revision: since }, before).revision > since;
    jsonResponse(res, 200, { device, state: before, changed, prompt: syncPrompt(before) });
    return;
  }
  const baseRevision = asRevision(body.baseRevision, '基准版本号');
  const cardKey = String(body.cardId ?? '').trim();
  const prev = before.decisions[cardKey];
  const state = store.submitDecision(token, { cardId: body.cardId, decision: body.decision });
  const conflict = baseRevision !== undefined && before.revision > baseRevision && Boolean(prev)
    && (prev.value !== body.decision || prev.byDevice !== device.id);
  jsonResponse(res, 200, { device, state, conflict, prompt: syncPrompt(state) });
}

// 实际业务处理；由同步 handleMobileWrite 以 fire-and-forget 方式调用，自行捕获全部错误。
async function executeWrite(route, req, res, url, ctx) {
  try {
    const body = req.method === 'GET' ? {} : await readJson(req, route.key === 'session-message' ? 20 * 1024 * 1024 : 65536);
    if (route.key === 'sync') return await syncRoute(req, res, url, ctx, body);
    if (route.key === 'card-answer' || route.key === 'card-authorize') return await cardWrite(route, req, res, url, ctx, body);
    if (route.key === 'session-continue') return await sessionContinue(res, url, route, ctx);
    if (route.key === 'session-download') return await sessionDownload(res, url, route, ctx);
    if (route.key === 'rule-action') return await ruleAction(req, res, url, route, ctx, body);
    if (route.key === 'session-classify') return sessionClassifyRoute(res, body);
    if (route.key === 'admin-platform-models') return await adminPlatformModelsRoute(res, ctx, body, req);
    if (route.key === 'session-create') return await sessionCreateRoute(res, body, ctx, req);
    if (route.key === 'session-message') return await sessionMessageRoute(res, url, route, ctx, body, req);
    if (route.key.startsWith('session-queue-')) return await sessionQueueRoute(res, url, route, ctx, body, req);
    jsonResponse(res, 501, { error: '该写操作尚未实现', route: route.key, declared: true });
  } catch (error) {
    writeError(res, error);
  }
}

/**
 * @returns {boolean} true 表示本模块已处理该请求（调用方应直接返回），false 表示不接管。
 */
export function handleMobileWrite(req, res, url, ctx) {
  const route = MOBILE_WRITE_ROUTES.find(item => item.method === req.method && item.pattern.test(url.pathname));
  if (!route) return false;
  const failure = validate(req, req.method !== 'GET');
  if (failure) {
    jsonResponse(res, failure.status, { error: failure.error });
    return true;
  }
  // scaffold 兼容：未提供可运行服务（如边界测试只传 device）时仍返回 501 占位。
  if (!ctx?.config || !ctx?.device?.id) {
    jsonResponse(res, 501, { error: NOT_IMPLEMENTED[route.key] || '该写操作尚未实现', route: route.key, declared: true });
    return true;
  }
  void executeWrite(route, req, res, url, ctx);
  return true;
}
