import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubError, hubRequest } from './hub.mjs';
import { readRuleOptions, saveRule, RuleError } from './rules.mjs';
import { modelLabels } from './models.mjs';
import { SchedulingSessionManager, SchedulingSessionError } from './scheduling-session.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']], ['/format.mjs', ['format.mjs', 'text/javascript; charset=utf-8']],
  ['/status-sections.mjs', ['status-sections.mjs', 'text/javascript; charset=utf-8']],
  ['/views.mjs', ['views.mjs', 'text/javascript; charset=utf-8']], ['/rule-form.mjs', ['rule-form.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
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
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new RequestError(413, '请求内容过大'); chunks.push(chunk); }
  if (!size) return {};
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new RequestError(400, '请求内容不是有效的 JSON 对象'); }
}
function idOf(text) { const id = Number(text); if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(id)) throw new RequestError(400, '编号无效'); return id; }
async function handleApi(config, req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') return jsonResponse(res, 200, await hubRequest(config, '/v1/state'));
  if (req.method === 'GET' && url.pathname === '/api/rules') return jsonResponse(res, 200, { ...readRuleOptions(config), models: modelLabels() });
  if (req.method === 'GET' && url.pathname === '/api/scheduling-sessions') return jsonResponse(res, 200, await config.schedulingSessions.list());
  if (!['POST', 'PUT'].includes(req.method)) return false;
  checkWrite(req); const body = await readJson(req);
  if (req.method === 'POST' && url.pathname === '/api/scheduling-sessions') return jsonResponse(res, 201, await config.schedulingSessions.start({ prompt: body.prompt, project: body.project }));
  if (req.method === 'POST' && url.pathname === '/api/rules') return jsonResponse(res, 201, await saveRule(config, body, null));
  let match;
  if ((match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/close$/))) return jsonResponse(res, 200, await config.schedulingSessions.close(decodeURIComponent(match[1])));
  if ((match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/messages$/))) return jsonResponse(res, 200, await config.schedulingSessions.send(decodeURIComponent(match[1]), body.text));
  if (req.method === 'PUT' && (match = url.pathname.match(/^\/api\/rules\/([^/]+)$/))) return jsonResponse(res, 200, await saveRule(config, body, decodeURIComponent(match[1])));
  if ((match = url.pathname.match(/^\/api\/rules\/([^/]+)\/(run|pause|resume)$/))) {
    const name = decodeURIComponent(match[1]); const action = match[2];
    const payload = action === 'run' ? { ...(body.subject ? { subject: String(body.subject) } : {}), ...(body.reason ? { reason: String(body.reason) } : {}) } : action === 'pause' ? { ...(body.reason ? { reason: String(body.reason) } : {}) } : {};
    return jsonResponse(res, 200, await hubRequest(config, `/v1/rules/${encodeURIComponent(name)}/${action}`, { method: 'POST', body: payload }));
  }
  if ((match = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/))) return jsonResponse(res, 200, await hubRequest(config, `/v1/runs/${idOf(match[1])}/cancel`, { method: 'POST', body: {} }));
  if ((match = url.pathname.match(/^\/api\/cards\/([^/]+)\/(answer|resolve)$/))) {
    const id = idOf(match[1]); const action = match[2];
    const payload = action === 'answer' ? (body.choice !== undefined ? { choice: Number(body.choice) } : { text: String(body.text || '') }) : { reason: String(body.reason || '') };
    return jsonResponse(res, 200, await hubRequest(config, `/v1/cards/${id}/${action}`, { method: 'POST', body: payload }));
  }
  return false;
}
export function createConsoleServer(config, schedulingSessions = new SchedulingSessionManager()) {
  config = { ...config, schedulingSessions };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const host = req.headers.host?.split(':')[0]?.toLowerCase();
    if (!['127.0.0.1', 'localhost'].includes(host)) return jsonResponse(res, 403, { error: '控制台只接受本机地址' });
    try { if (url.pathname.startsWith('/api/') && await handleApi(config, req, res, url) !== false) return; }
    catch (error) {
      const status = error instanceof RequestError || error instanceof RuleError || error instanceof SchedulingSessionError ? error.status || 400 : error instanceof HubError && error.status < 500 ? error.status : 502;
      return jsonResponse(res, status, { error: error.message });
    }
    const asset = FILES.get(url.pathname);
    if (asset && req.method === 'GET') {
      try { const body = readFileSync(path.join(PUBLIC, asset[0])); res.writeHead(200, { ...securityHeaders(), 'content-type': asset[1] }); return res.end(body); }
      catch { return jsonResponse(res, 404, { error: '控制台资源尚未安装' }); }
    }
    return jsonResponse(res, 404, { error: '没有这个控制台地址' });
  });
  server.on('close', () => schedulingSessions.dispose?.());
  return server;
}
