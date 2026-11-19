import http from 'node:http';
import { classifySessionRequest } from './session-classify.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubError, hubRequest } from './hub.mjs';
import { readRuleOptions, saveRule, RuleError } from './rules.mjs';
import { modelLabels } from './models.mjs';
import { SchedulingSessionManager, SchedulingSessionError } from './scheduling-session.mjs';
import { HubSchedulingSessionAdapter } from './hub-scheduling-session.mjs';
import { discoverGitProjects } from './projects.mjs';
import { readDetours, publicDetour } from './detour.mjs';
import { loadChains } from './serial-progress.mjs';
import { aggregateProjectUsage } from './project-usage.mjs';
import { refreshUsage } from './chain-usage.mjs';
import { readCloseouts } from './chain-closeout.mjs';
import { createDagService, DagServiceError } from './dag-service.mjs';
import { CardDelegateError, createCardDelegateStore, delegateOpenCard, settleDelegations } from './card-delegate.mjs';
import { getCardRouting, CardFilterError } from './card-routing.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(MODULE_DIR, '..', 'public');
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']], ['/format.mjs', ['format.mjs', 'text/javascript; charset=utf-8']],
  ['/dom-stable.mjs', ['dom-stable.mjs', 'text/javascript; charset=utf-8']],
  ['/status-sections.mjs', ['status-sections.mjs', 'text/javascript; charset=utf-8']],
  ['/views.mjs', ['views.mjs', 'text/javascript; charset=utf-8']], ['/rule-form.mjs', ['rule-form.mjs', 'text/javascript; charset=utf-8']],
  ['/dag-model.mjs', ['dag-model.mjs', 'text/javascript; charset=utf-8']], ['/dag-views.mjs', ['dag-views.mjs', 'text/javascript; charset=utf-8']], ['/dag-authorize.mjs', ['dag-authorize.mjs', 'text/javascript; charset=utf-8']], ['/dag-app.mjs', ['dag-app.mjs', 'text/javascript; charset=utf-8']], ['/progress-view.mjs', ['progress-view.mjs', 'text/javascript; charset=utf-8']], ['/dag.css', ['dag.css', 'text/css; charset=utf-8']],
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
    return jsonResponse(res, 200, config.dagService.get(decodeURIComponent(dagMatch[1])));
  }
  let sessionMatch;
  if (req.method === 'GET' && (sessionMatch = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/artifacts$/))) return jsonResponse(res, 200, { files: await config.schedulingSessions.listSessionArtifacts(decodeURIComponent(sessionMatch[1])) });
  if (req.method === 'GET' && (sessionMatch = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/file$/))) return jsonResponse(res, 200, await config.schedulingSessions.readSessionArtifact(decodeURIComponent(sessionMatch[1]), String(url.searchParams.get('path') || '')));
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
      const cumulative = usage?.byChain.get(chain.sourceFile);
      if (cumulative) chain.cumulativeUsage = cumulative;
      else delete chain.cumulativeUsage;
    }
    return jsonResponse(res, 200, data);
  }
  if (req.method === 'GET' && url.pathname === '/api/project-usage') {
    const rules = readRuleOptions(config).rules || [];
    const usage = await refreshUsage({ config, rules, chains: [] });
    const state = await hubRequest(config, '/v1/state');
    return jsonResponse(res, 200, aggregateProjectUsage({ state, rules, cumulativeByRule: usage?.byRule }));
  }
  if (req.method === 'GET' && url.pathname === '/api/closeouts') return jsonResponse(res, 200, { closeouts: readCloseouts(config.root) });
  if (req.method === 'POST' && url.pathname === '/api/session-classify') {
    const body = await readJson(req);
    return jsonResponse(res, 200, classifySessionRequest(body.text));
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
  let match;
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/queue\/clear$/))) return jsonResponse(res, 200, await config.schedulingSessions.clearQueued(decodeURIComponent(match[1])));
  if (req.method === 'PUT' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/queue\/([^/]+)$/))) return jsonResponse(res, 200, await config.schedulingSessions.updateQueued(decodeURIComponent(match[1]), decodeURIComponent(match[2]), String(body.text ?? '')));
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/queue\/([^/]+)\/move$/))) return jsonResponse(res, 200, await config.schedulingSessions.moveQueued(decodeURIComponent(match[1]), decodeURIComponent(match[2]), String(body.direction || '')));
  if (req.method === 'DELETE' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/queue\/([^/]+)$/))) return jsonResponse(res, 200, await config.schedulingSessions.removeQueued(decodeURIComponent(match[1]), decodeURIComponent(match[2])));
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/queue\/([^/]+)\/steer$/))) return jsonResponse(res, 200, await config.schedulingSessions.steerQueued(decodeURIComponent(match[1]), decodeURIComponent(match[2])));
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/scheduling-sessions\/([^/]+)\/close$/))) return jsonResponse(res, 200, await config.schedulingSessions.close(decodeURIComponent(match[1])));
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
    return jsonResponse(res, 200, await hubRequest(config, `/v1/cards/${id}/${action}`, { method: 'POST', body: payload }));
  }
  if (req.method === 'POST' && (match = url.pathname.match(/^\/api\/cards\/([^/]+)\/delegate$/))) {
    const id = idOf(match[1]);
    const state = await hubRequest(config, '/v1/state');
    const card = (state?.cards || []).find(item => Number(item?.id) === id);
    if (!card) throw new RequestError(404, '卡片不存在或已结案');
    return jsonResponse(res, 200, await delegateOpenCard({
      card,
      store: config.cardDelegateStore,
      postEvent: event => hubRequest(config, '/v1/events', { method: 'POST', body: event }),
      resolveCard: (cardId, reason) => hubRequest(config, `/v1/cards/${cardId}/resolve`, { method: 'POST', body: { reason } }),
    }));
  }
  return false;
}
export function createConsoleServer(config, schedulingSessions) {
  if (!schedulingSessions) {
    const writableDir = config.root ? path.join(config.root, 'scripts') : null;
    let allowedDir = writableDir;
    if (allowedDir) {
      try { mkdirSync(allowedDir, { recursive: true }); }
      catch (error) { console.error(`[console] 脚本目录 ${allowedDir} 创建失败，会话按只读处理：${error.message}`); allowedDir = null; }
    }
    schedulingSessions = new SchedulingSessionManager({ writableDir: allowedDir, archiveRoot: config.root, hubScheduling: new HubSchedulingSessionAdapter({ hubConfig: config }) });
  }
  const dagService = config.dagService || (config.root ? createDagService({ root: config.root, storeDirectory: path.join(config.root, 'dag-runs') }) : null);
  // 退回记录落盘：重启后「待代理决策」列表不丢；无运行目录退回内存 store（退回行为不变）。
  const cardDelegateStore = config.cardDelegateStore || createCardDelegateStore({ file: config.root ? path.join(config.root, 'card-delegates.json') : null });
  config = { ...config, schedulingSessions, dagService, cardDelegateStore, cardRouting: config.cardRouting || getCardRouting(config) };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const host = req.headers.host?.split(':')[0]?.toLowerCase();
    if (!['127.0.0.1', 'localhost'].includes(host)) return jsonResponse(res, 403, { error: '控制台只接受本机地址' });
    try { if (url.pathname.startsWith('/api/') && await handleApi(config, req, res, url) !== false) return; }
    catch (error) {
      const status = error instanceof RequestError || error instanceof RuleError || error instanceof SchedulingSessionError || error instanceof DagServiceError || error instanceof CardDelegateError ? error.status || 400 : error instanceof HubError && error.status < 500 ? error.status : 502;
      return jsonResponse(res, status, { error: error.message });
    }
    const asset = FILES.get(url.pathname);
    if (asset && req.method === 'GET') {
      try { const body = readFileSync(path.join(PUBLIC, asset[0])); res.writeHead(200, { ...securityHeaders(), 'content-type': asset[1] }); return res.end(body); }
      catch { return jsonResponse(res, 404, { error: '控制台资源尚未安装' }); }
    }
    return jsonResponse(res, 404, { error: '没有这个控制台地址' });
  });
  // §6.3 重启后按 Hub 事项恢复调度会话视图；由启动脚本在 listen 后调用。失败只记录，不阻止控制台启动。
  server.restoreSchedulingSessions = () => schedulingSessions.restoreFromHub().catch(error => {
    console.error(`[console] 恢复 Hub 调度会话失败：${error.message}`);
  });
  server.on('close', () => schedulingSessions.dispose?.());
  return server;
}
