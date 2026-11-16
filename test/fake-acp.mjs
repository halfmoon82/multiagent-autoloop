import { PassThrough } from 'node:stream';

const line = value => `${JSON.stringify(value)}\n`;

// 最小假 ACP 适配器：首个 prompt 返回后依次下发 permissions 中的 session/request_permission，
// 并按 id 收集控制台的裁决（outcomes[id]）。
export function fakeAcp({ permissions = [] } = {}) {
  const requests = [];
  const outcomes = {};
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const child = { stdin, stdout, stderr, pid: 4243, kill() { stdout.end(); } };
  let buffer = '';
  const respond = (request, result) => stdout.write(line({ jsonrpc: '2.0', id: request.id, result }));
  stdin.on('data', chunk => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!raw.trim()) continue;
      const message = JSON.parse(raw); requests.push(message);
      if (!message.method) { if (message.result) outcomes[message.id] = message.result.outcome; continue; }
      if (message.method === 'initialize') respond(message, { agentInfo: { name: 'fake-codex' }, agentCapabilities: {} });
      else if (message.method === 'session/new') respond(message, { sessionId: 'fake-session' });
      else if (message.method === 'session/set_mode') respond(message, { configOptions: [{ id: 'mode', currentValue: message.params.modeId }] });
      else if (message.method === 'session/set_config_option') respond(message, { configOptions: [{ id: message.params.configId, currentValue: message.params.value }] });
      else if (message.method === 'session/prompt') {
        setTimeout(() => {
          permissions.forEach((params, i) => stdout.write(line({ jsonrpc: '2.0', id: `perm-${i}`, method: 'session/request_permission', params: { sessionId: 'fake-session', ...params } })));
          respond(message, { stopReason: 'end_turn' });
        }, 0);
      } else if (message.method === 'session/close' || message.method === 'session/cancel') respond(message, {});
    }
  });
  return { child, requests, outcomes };
}

export const ALLOW_ONCE = [{ optionId: 'allow', name: '允许', kind: 'allow_once' }, { optionId: 'deny', name: '拒绝', kind: 'reject_once' }];
export const ALLOW_ALWAYS_ONLY = [{ optionId: 'always', name: '总是允许', kind: 'allow_always' }];

export async function waitFor(predicate, timeout = 1500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error('等待假 ACP 适配器超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
