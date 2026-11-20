// 移动端写路由实现：在设备鉴权之后、GET-only 闸之前被调用。
// 复用网页控制台的同一服务入口（hubRequest / config.schedulingSessions），不另造状态；
// 所有写入记录来源设备 id。校验口径与 server.mjs 的 checkWrite 对齐（同源 + 自定义头 + JSON），
// 并额外要求 x-device-token（由 server 的 requireMobileDevice 验证后传入 ctx.device）。
// 自包含响应助手与同步 handleMobileWrite 签名，避免改动 server.mjs 或与它形成循环依赖。

import { createReadStream } from 'node:fs';
import { hubRequest, HubError } from './hub.mjs';
import { discoverGitProjects } from './projects.mjs';
import { readRuleOptions } from './rules.mjs';
import { reconcile, syncPrompt, createSyncState } from '../mobile/src/features/device-sync/index.mjs';

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
]);

const NOT_IMPLEMENTED = Object.freeze({
  // 同步路由已实现；仅 scaffold 兼容路径（ctx 无 config/device）仍返回占位。
  sync: '设备同步尚未实现',
});

// 与 checkWrite 同等校验；GET 路由不要求 JSON content-type。
function validate(req, needsJson) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
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

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 65536) fail(413); chunks.push(chunk); }
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
  jsonResponse(res, status, { error: error instanceof WriteError ? error.message : (SAFE_ERRORS[status] || '操作暂时不可用，请稍后重试') });
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
      method: 'POST', body: { ...payload, sourceDeviceId: ctx.device.id },
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
    const body = req.method === 'GET' ? {} : await readJson(req);
    if (route.key === 'sync') return await syncRoute(req, res, url, ctx, body);
    if (route.key === 'card-answer' || route.key === 'card-authorize') return await cardWrite(route, req, res, url, ctx, body);
    if (route.key === 'session-continue') return await sessionContinue(res, url, route, ctx);
    if (route.key === 'session-download') return await sessionDownload(res, url, route, ctx);
    if (route.key === 'rule-action') return await ruleAction(req, res, url, route, ctx, body);
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
