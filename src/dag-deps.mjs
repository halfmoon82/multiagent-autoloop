// DAG 槽位共享依赖缓存（2026-11-20）：按锁文件内容各装一份 node_modules，所有槽位与后续 DAG 复用。
// 背景：槽位每次换节点都会被 restoreWorktree 清空（含 node_modules），worker 只能每次重装（本仓约 395MB），
// 挤占交换区所在磁盘并制造大量文件事件。
// 纪律：
//   - 缓存目录归控制器（<运行目录>/dag-deps/<锁文件摘要>），不是主 checkout：worker 改坏依赖只坏缓存，不坏运行中的控制台。
//   - 后台安装、原子启用：先装进临时目录，成功后整体改名；装好之前返回 null，槽位照旧由 worker 自装，不阻塞调度。
//   - npm ci --ignore-scripts --prefer-offline（与 design-verify 同口径），不执行依赖的安装脚本。
//   - 失败不重试风暴：同一锁文件失败后冷却 FAILURE_COOLDOWN_MS 再试。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export const lockDigest = lockText => createHash('sha256').update(String(lockText)).digest('hex').slice(0, 16);

export async function npmCiInstall({ dir, env = process.env } = {}) {
  await execFileAsync('npm', ['ci', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'], {
    cwd: dir, env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
  });
}

export function createSharedDeps({ root, install = npmCiInstall, now = Date.now, log = () => {} } = {}) {
  if (!root) throw new Error('共享依赖缓存需要运行目录 root');
  const base = path.join(root, 'dag-deps');
  const pending = new Map();   // digest → Promise
  const failedAt = new Map();  // digest → 失败时间

  async function installInto(digest, packageText, lockText) {
    mkdirSync(base, { recursive: true });
    const tmp = mkdtempSync(path.join(base, `.tmp-${digest}-`));
    try {
      writeFileSync(path.join(tmp, 'package.json'), packageText);
      writeFileSync(path.join(tmp, 'package-lock.json'), lockText);
      await install({ dir: tmp });
      if (!existsSync(path.join(tmp, 'node_modules'))) throw new Error('安装后没有 node_modules');
      const final = path.join(base, digest);
      if (existsSync(final)) { rmSync(tmp, { recursive: true, force: true }); return; }
      renameSync(tmp, final);
      log(`[dag-deps] 共享依赖已就绪 ${digest}`);
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      failedAt.set(digest, now());
      log(`[dag-deps] 共享依赖安装失败 ${digest}：${error?.message || error}（槽位照旧由 worker 自装）`);
    }
  }

  // 返回已就绪的缓存目录（含 node_modules），未就绪返回 null 并在后台触发安装。
  function resolve({ packageText, lockText }) {
    if (typeof packageText !== 'string' || typeof lockText !== 'string' || !lockText) return null;
    const digest = lockDigest(lockText);
    const dir = path.join(base, digest);
    if (existsSync(path.join(dir, 'node_modules'))) return dir;
    if (pending.has(digest)) return null;
    const failed = failedAt.get(digest);
    if (failed != null && now() - failed < FAILURE_COOLDOWN_MS) return null;
    const job = installInto(digest, packageText, lockText).finally(() => pending.delete(digest));
    pending.set(digest, job);
    return null;
  }
  return { resolve, base, pending };
}
