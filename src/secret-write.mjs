import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// 允许写入的密钥：config 型写进 config.json 的字段，file 型写进 <home>/secrets/<name>。
export const ALLOWED_KEYS = Object.freeze({
  owner: { kind: 'config', field: 'owner' },
  'cloudflare-token': { kind: 'file', name: 'cloudflare-token' },
});

export class SecretWriteError extends Error {}

function atomicWrite(target, content) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* 已在失败路径 */ }
    rmSync(tmp, { force: true });
    // 只暴露错误码，绝不带值。
    throw new SecretWriteError(`写入失败（${error.code || 'IO'}）`);
  }
}

export function writeSecret({ root, key, value }) {
  const spec = Object.hasOwn(ALLOWED_KEYS, key) ? ALLOWED_KEYS[key] : null;
  if (!spec) throw new SecretWriteError(`不允许的 key，可用：${Object.keys(ALLOWED_KEYS).join('、')}`);
  if (!root) throw new SecretWriteError('请设置 AGENT_AUTOLOOP_HOME');
  if (typeof value !== 'string' || value === '') throw new SecretWriteError('值为空，未写入');

  if (spec.kind === 'config') {
    const file = path.join(root, 'config.json');
    let config;
    try { config = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new SecretWriteError('config.json 读取或解析失败，未写入'); }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new SecretWriteError('config.json 格式不对，未写入');
    atomicWrite(file, `${JSON.stringify({ ...config, [spec.field]: value }, null, 2)}\n`);
    return { key, location: 'config.json' };
  }

  const dir = path.join(root, 'secrets');
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
  catch (error) { throw new SecretWriteError(`secrets 目录不可用（${error.code || 'IO'}）`); }
  atomicWrite(path.join(dir, spec.name), value);
  return { key, location: `secrets/${spec.name}` };
}
