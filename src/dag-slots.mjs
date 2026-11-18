// 固定槽位运行时：槽位=独立 worktree（.worktrees/dag-<runId>-slot-n）、prepare、沙箱写守卫、WIP 保留。
// 隔离靠路径沙箱（realpath 校验）而非提示词；git 操作串行由调用方（publish 通道）保证。
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_SLOTS } from './dag-run.mjs';
import { defaultGit, restoreWorktree } from './git-safe.mjs';

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

export function createSlotRuntime({ project, runId, remoteUrl = null, git = defaultGit } = {}) {
  if (!project || !runId) throw new SlotError('槽位运行时需要 project 与 runId', 'BAD_INPUT');
  const stateFile = path.join(project, '.git', `dag-${seg(runId)}-slots.json`);
  const loadState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const saveState = state => { writeFileSync(`${stateFile}.tmp`, JSON.stringify(state)); renameSync(`${stateFile}.tmp`, stateFile); };
  const checkSlot = slot => {
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) throw new SlotError(`槽位必须是 1-${MAX_SLOTS} 的整数：${slot}`, 'BAD_SLOT');
    return slot;
  };
  const slotPath = slot => path.join(project, '.worktrees', `dag-${runId}-slot-${checkSlot(slot)}`);
  const dirty = async slot => (await git(slotPath(slot), ['status', '--porcelain', '--untracked-files=all'])).trim().length > 0;

  return {
    project, runId, remoteUrl, slotPath, git, dirty, loadState, saveState,
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
        return { slot, nodeId, branch, reused: true, baseCommit: requestedBaseCommit };
      }
      if (await dirty(slot)) throw new SlotError(`槽位 ${slot} 有未保存改动（脏），换节点前必须先保存 WIP 再释放`, 'SLOT_DIRTY');
      if (remoteUrl) await git(dir, ['fetch', remoteUrl]).catch(() => {}); // 离线测试允许无远端
      const baseCommit = requestedBaseCommit;
      // 不用 checkout/restore：symbolic-ref + read-tree + archive 恢复，避免 smudge filter。
      await git(dir, ['update-ref', `refs/heads/${branch}`, baseCommit]);
      await git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      await restoreWorktree({ git, cwd: dir, commit: baseCommit });
      state[slot] = { nodeId, branch, base, baseCommit }; saveState(state);
      return { slot, nodeId, branch, reused: false, baseCommit };
    },
  };
}
