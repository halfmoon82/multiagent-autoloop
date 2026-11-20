// 固定槽位运行时：槽位=独立 worktree（.worktrees/dag-<runId>-slot-n）、prepare、沙箱写守卫、WIP 保留。
// 隔离靠路径沙箱（realpath 校验）而非提示词；git 操作串行由调用方（publish 通道）保证。
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_SLOTS } from './dag-run.mjs';
import { defaultGit, restoreWorktree, worktreeChanges } from './git-safe.mjs';

export class SlotError extends Error {
  constructor(message, code = 'SLOT_ERROR') { super(message); this.name = 'SlotError'; this.code = code; }
}

export { defaultGit } from './git-safe.mjs';
const realOf = file => {
  // 取最深的已存在祖先做 realpath，再拼回不存在的尾部，防符号链接逃逸。
  let current = path.resolve(file); const tail = [];
  while (!existsSync(current)) { tail.unshift(path.basename(current)); const up = path.dirname(current); if (up === current) break; current = up; }
  return path.join(realpathSync(current), ...tail);
};
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
export const seg = value => String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

export function createSlotRuntime({ project, runId, gitDir = null, remoteUrl = null, git = defaultGit, depsSource = null } = {}) {
  if (!project || !runId) throw new SlotError('槽位运行时需要 project 与 runId', 'BAD_INPUT');
  const stateFile = path.join(gitDir || path.join(project, '.git'), `dag-${seg(runId)}-slots.json`);
  const loadState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const saveState = state => { writeFileSync(`${stateFile}.tmp`, JSON.stringify(state)); renameSync(`${stateFile}.tmp`, stateFile); };
  const checkSlot = slot => {
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) throw new SlotError(`槽位必须是 1-${MAX_SLOTS} 的整数：${slot}`, 'BAD_SLOT');
    return slot;
  };
  const slotPath = slot => path.join(project, '.worktrees', `dag-${runId}-slot-${checkSlot(slot)}`);
  const dirty = async slot => (await worktreeChanges({ git, cwd: slotPath(slot) })).length > 0;

  // 共享依赖（2026-11-20：worker 各自 npm ci，每槽位约 395MB，挤占交换区所在磁盘）：
  // 槽位有锁文件且没有 node_modules 时，软链到控制器指定的共享依赖目录；worker 自装的真实目录不覆盖。
  // 软链名写进本仓 info/exclude（不带斜杠，.gitignore 的 node_modules/ 只匹配目录，匹配不到软链），槽位不因此变脏。
  const excludeSharedDeps = () => {
    const file = path.join(gitDir || path.join(project, '.git'), 'info', 'exclude');
    let text = ''; try { text = readFileSync(file, 'utf8'); } catch { /* 没有就新建 */ }
    if (text.split('\n').some(line => line.trim() === 'node_modules' || line.trim() === '/node_modules')) return;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}node_modules\n`);
  };
  const linkSharedDeps = slot => {
    const dir = slotPath(slot);
    if (!existsSync(path.join(dir, 'package-lock.json'))) return 'no-lockfile';
    // depsSource：固定目录（测试/简单场景），或按槽位锁文件解析的函数（控制器共享缓存，未就绪返回 null）。
    let sourceDir = depsSource;
    if (typeof depsSource === 'function') {
      let packageText = ''; let lockText = '';
      try { packageText = readFileSync(path.join(dir, 'package.json'), 'utf8'); lockText = readFileSync(path.join(dir, 'package-lock.json'), 'utf8'); } catch { return 'no-source'; }
      sourceDir = depsSource({ packageText, lockText });
    }
    const target = sourceDir ? path.join(sourceDir, 'node_modules') : null;
    if (!target || !existsSync(target)) return 'no-source';
    const link = path.join(dir, 'node_modules');
    let stat = null; try { stat = lstatSync(link); } catch { /* 不存在 */ }
    if (stat && !stat.isSymbolicLink()) return 'kept-local';
    excludeSharedDeps();
    if (stat) { if (readlinkSync(link) === target) return 'linked'; unlinkSync(link); }
    symlinkSync(target, link, 'dir');
    return 'linked';
  };

  return {
    project, runId, gitDir: gitDir || path.join(project, '.git'), remoteUrl, slotPath, git, dirty, loadState, saveState,
    sharedDepsLinked(slot) { try { return lstatSync(path.join(slotPath(slot), 'node_modules')).isSymbolicLink(); } catch { return false; } },
    // DAG 收尾回收：逐个移除本 run 的槽位 worktree；有未保存改动的保留并报告（不丢 WIP），不碰共享依赖源。
    async removeSlots() {
      const removed = []; const kept = [];
      for (let slot = 1; slot <= MAX_SLOTS; slot++) {
        const dir = slotPath(slot);
        if (!existsSync(dir)) continue;
        if (await dirty(slot)) { kept.push(slot); continue; }
        try { if (lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()) unlinkSync(path.join(dir, 'node_modules')); } catch { /* 无软链 */ }
        await git(project, ['worktree', 'remove', '--force', dir]);
        removed.push(slot);
      }
      if (!kept.length) { try { unlinkSync(stateFile); } catch { /* 已删 */ } }
      else { const state = loadState(); for (const slot of removed) delete state[slot]; saveState(state); }
      return { removed, kept };
    },
    async ensureSlots() {
      mkdirSync(path.join(project, '.worktrees'), { recursive: true });
      for (let slot = 1; slot <= MAX_SLOTS; slot++) {
        const dir = slotPath(slot);
        if (existsSync(dir)) continue;
        // detached：槽位不占用分支名，节点分支由 prepare 切入。
        await git(project, ['worktree', 'add', '--no-checkout', '--detach', dir, 'HEAD']);
        await git(dir, ['read-tree', 'HEAD']);
        await restoreWorktree({ git, cwd: dir, commit: 'HEAD' });
      }
    },
    // 沙箱写守卫：只允许写该槽位自己的 worktree。
    writeAs(slot, file, content) {
      const root = realOf(slotPath(slot));
      const target = realOf(file);
      if (!inside(root, target)) throw new SlotError(`沙箱拒绝：槽位 ${slot} 不得写入 ${file}`, 'SANDBOX_DENIED');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    },
    async prepare({ slot, nodeId, branch, base }) {
      const dir = slotPath(slot);
      if (!existsSync(dir)) throw new SlotError(`槽位 ${slot} 尚未建立`, 'NO_SLOT');
      const state = loadState();
      let requestedBaseCommit;
      try { requestedBaseCommit = String(await git(dir, ['rev-parse', '--verify', `${base}^{commit}`])).trim(); }
      catch { throw new SlotError(`基线 ${base} 不存在，拒绝 prepare`, 'BASELINE_MISSING'); }
      if (state[slot]?.nodeId === nodeId) {
        // slot 状态不是 scope 权威；若被篡改或与请求不一致，fail closed。
        if (state[slot].baseCommit !== requestedBaseCommit || state[slot].branch !== branch || state[slot].base !== base) {
          throw new SlotError(`槽位 ${slot} 状态与请求的 base/branch 不一致，拒绝复用`, 'SLOT_STATE_MISMATCH');
        }
        return { slot, nodeId, branch, reused: true, baseCommit: requestedBaseCommit, sharedDeps: linkSharedDeps(slot) };
      }
      if (await dirty(slot)) throw new SlotError(`槽位 ${slot} 有未保存改动（脏），换节点前必须先保存 WIP 再释放`, 'SLOT_DIRTY');
      const baseCommit = requestedBaseCommit;
      // 不用 checkout/restore：symbolic-ref + read-tree + archive 恢复，避免 smudge filter。
      await git(dir, ['update-ref', `refs/heads/${branch}`, baseCommit]);
      await git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      await restoreWorktree({ git, cwd: dir, commit: baseCommit });
      state[slot] = { nodeId, branch, base, baseCommit }; saveState(state);
      return { slot, nodeId, branch, reused: false, baseCommit, sharedDeps: linkSharedDeps(slot) };
    },
  };
}
