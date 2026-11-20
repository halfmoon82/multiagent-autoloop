// 移动端写路由接缝：在设备鉴权之后、GET-only 闸之前被调用。
// 本节点只登记路由表并给出 501 占位，不实现任何业务写操作；实际实现由 mobile-write-api 节点覆盖。
// 校验口径与 server.mjs 的 checkWrite 对齐（同源 + 自定义头 + JSON），并额外要求 x-device-token。
// 自包含响应助手，避免与 server.mjs 形成循环依赖。

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
  'card-answer': '卡片回答尚未实现',
  'card-authorize': '卡片授权尚未实现',
  'session-continue': '会话继续尚未实现',
  'session-download': '会话产物下载尚未实现',
  sync: '设备同步尚未实现',
  'rule-action': '规则运行控制尚未实现',
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
  jsonResponse(res, 501, {
    error: NOT_IMPLEMENTED[route.key] || '该写操作尚未实现',
    route: route.key,
    declared: true,
  });
  return true;
}
