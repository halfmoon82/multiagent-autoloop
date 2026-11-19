// 网页设备授权管理后端：一次性二维码绑定、设备列表、解除授权、重命名与审计。
// 数据落在运行目录（与 config.json/rules.json 同级），不进仓库。
// 令牌只以 sha256 落盘；公开结构与审计都不携带令牌或凭证。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BINDING_TTL_MS = 5 * 60 * 1000;
const MAX_AUDIT = 500;
const MAX_BINDINGS = 200;

export class DeviceAuthError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'DeviceAuthError';
    this.status = status;
    this.code = code;
  }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    status: device.status,
    boundAt: device.boundAt,
    lastActiveAt: device.lastActiveAt ?? null,
    revokedAt: device.revokedAt ?? null,
  };
}

export function createDeviceStore({ file = null, now = () => new Date(), ttlMs = BINDING_TTL_MS, random = randomBytes } = {}) {
  let data = { devices: [], bindings: [], audit: [] };
  const load = () => {
    if (!file || !existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      data = {
        devices: Array.isArray(parsed?.devices) ? parsed.devices : [],
        bindings: Array.isArray(parsed?.bindings) ? parsed.bindings : [],
        audit: Array.isArray(parsed?.audit) ? parsed.audit : [],
      };
    } catch { /* 台账损坏按空表处理，不阻断授权通道 */ }
  };
  const flush = () => {
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const stamp = () => now().toISOString();

  function record(action, fields, source) {
    data.audit.push({ id: random(16).toString('hex'), at: stamp(), action, source, result: 'ok', ...fields });
    if (data.audit.length > MAX_AUDIT) data.audit = data.audit.slice(-MAX_AUDIT);
  }
  function checkActor(actor, device) {
    if (actor?.type === 'admin') return;
    if (actor?.type === 'device') {
      if (actor.deviceId && actor.deviceId === device.id) return;
      if (actor.token && typeof actor.token === 'string' && sha256(actor.token) === device.tokenHash) return;
    }
    throw new DeviceAuthError(403, '无权操作该设备', 'FORBIDDEN');
  }
  function findDevice(deviceId) {
    const device = data.devices.find(item => item && item.id === deviceId);
    if (!device) throw new DeviceAuthError(404, '设备不存在', 'DEVICE_NOT_FOUND');
    return device;
  }
  function requireText(value, label, max) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new DeviceAuthError(400, `${label}不合法`, 'INVALID_INPUT');
    return value.trim();
  }

  load();

  return {
    // 一次性二维码：只返回一次明文令牌，台账里只有哈希；绑定后作废并写审计。
    createBinding(source = 'admin') {
      const token = random(32).toString('hex');
      const createdAt = stamp();
      const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
      const binding = { id: `bind_${random(8).toString('hex')}`, tokenHash: sha256(token), createdAt, expiresAt, usedAt: null };
      data.bindings.push(binding);
      if (data.bindings.length > MAX_BINDINGS) data.bindings = data.bindings.slice(-MAX_BINDINGS);
      record('qr.create', { bindingId: binding.id }, source);
      flush();
      return { token, qrPayload: `autoloop://bind?token=${token}`, createdAt, expiresAt };
    },

    bindDevice({ token, name, platform } = {}, source = 'device') {
      if (typeof token !== 'string' || !token) throw new DeviceAuthError(400, '绑定令牌无效', 'BINDING_INVALID');
      const safeName = requireText(name, '设备名称', 80);
      const safePlatform = requireText(platform, '设备系统', 40);
      const binding = data.bindings.find(item => item && item.tokenHash === sha256(token));
      if (!binding) throw new DeviceAuthError(400, '绑定二维码无效', 'BINDING_INVALID');
      if (binding.usedAt) throw new DeviceAuthError(409, '绑定二维码已使用', 'BINDING_USED');
      if (Date.parse(binding.expiresAt) <= now().getTime()) throw new DeviceAuthError(410, '绑定二维码已过期', 'BINDING_EXPIRED');

      const deviceToken = random(32).toString('hex');
      const device = {
        id: `dev_${random(8).toString('hex')}`,
        name: safeName,
        platform: safePlatform,
        tokenHash: sha256(deviceToken),
        status: 'authorized',
        boundAt: stamp(),
        lastActiveAt: null,
        revokedAt: null,
      };
      binding.usedAt = device.boundAt;
      data.devices.push(device);
      record('bind', { deviceId: device.id, deviceName: safeName, platform: safePlatform }, source);
      flush();
      return { device: publicDevice(device), deviceToken };
    },

    listDevices() { return data.devices.map(publicDevice); },
    listAudit() { return data.audit.map(item => ({ ...item })); },

    // 解除授权：网页管理后台（admin）可解除任意设备；设备凭据只能解除自身。
    revokeDevice(deviceId, actor = { type: 'admin' }) {
      const device = findDevice(deviceId);
      checkActor(actor, device);
      if (device.status === 'revoked') return publicDevice(device);
      device.status = 'revoked';
      device.revokedAt = stamp();
      record('revoke', { deviceId: device.id, deviceName: device.name }, actor.type);
      flush();
      return publicDevice(device);
    },

    renameDevice(deviceId, name, actor = { type: 'admin' }) {
      const device = findDevice(deviceId);
      checkActor(actor, device);
      const safeName = requireText(name, '设备名称', 80);
      device.name = safeName;
      record('rename', { deviceId: device.id, deviceName: safeName }, actor.type);
      flush();
      return publicDevice(device);
    },

    // 访问与通知的统一判定入口：解除授权后同一凭据立即失效。
    isAuthorizedToken(token) {
      if (typeof token !== 'string' || !token) return false;
      const hash = sha256(token);
      return data.devices.some(item => item && item.status === 'authorized' && item.tokenHash === hash);
    },

    touch(token) {
      if (typeof token !== 'string' || !token) return null;
      const hash = sha256(token);
      const device = data.devices.find(item => item && item.status === 'authorized' && item.tokenHash === hash);
      if (!device) return null;
      device.lastActiveAt = stamp();
      flush();
      return publicDevice(device);
    },
  };
}
