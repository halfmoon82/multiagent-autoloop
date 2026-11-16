// WIP 精确保留：临时索引 + commit-tree + refs/dag-wip，不动真实索引/分支；
// 释放槽位前核验 WIP 完整（含未跟踪文件），再 restore + clean（不加 -x，不用 reset --hard）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SlotError, seg } from './dag-slots.mjs';

export const wipRef = (runId, nodeId, attempt) => `refs/dag-wip/${seg(runId)}/${seg(nodeId)}/${Number(attempt)}`;
const IDENT = ['-c', 'user.name=dag-controller', '-c', 'user.email=dag-controller@localhost', '-c', 'commit.gpgsign=false'];

async function withTempIndex(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dag-idx-'));
  try { return await fn({ GIT_INDEX_FILE: path.join(dir, 'index') }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

// 返回 { tree, commit } 或 null（槽位干净）。tree 构造不触碰真实索引。
async function buildWip(rt, slot, message) {
  const dir = rt.slotPath(slot);
  if (!(await rt.dirty(slot))) return null;
  return withTempIndex(async env => {
    await rt.git(dir, ['read-tree', 'HEAD'], { env });
    await rt.git(dir, ['add', '-A'], { env });
    const tree = (await rt.git(dir, ['write-tree'], { env })).trim();
    const head = (await rt.git(dir, ['rev-parse', 'HEAD'])).trim();
    const commit = (await rt.git(dir, [...IDENT, 'commit-tree', tree, '-p', head, '-m', message])).trim();
    // 核验：HEAD 对比该 tree 的差异必须覆盖全部未跟踪文件。
    const untracked = (await rt.git(dir, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
    const inTree = new Set((await rt.git(dir, ['ls-tree', '-r', '--name-only', tree])).split('\n').filter(Boolean));
    const missing = untracked.filter(file => !inTree.has(file));
    if (missing.length) throw new SlotError(`WIP 未包含未跟踪文件：${missing.join(',')}`, 'WIP_INCOMPLETE');
    return { tree, commit };
  });
}

export async function saveWip(rt, { slot, nodeId, attempt }) {
  const ref = wipRef(rt.runId, nodeId, attempt);
  const built = await buildWip(rt, slot, `${rt.runId}:${nodeId}:${attempt}`);
  if (!built) return null;
  await rt.git(rt.project, ['update-ref', ref, built.commit]);
  return ref;
}

export async function releaseSlotWorktree(rt, { slot, nodeId, attempt }) {
  const dir = rt.slotPath(slot);
  const ref = await saveWip(rt, { slot, nodeId, attempt }); // 失败即抛出，不清理
  if (ref) {
    // 清理前再核验：ref 的树与当前工作区全量一致（临时索引下 add -A 后 diff 为空）。
    const same = await withTempIndex(async env => {
      await rt.git(dir, ['read-tree', 'HEAD'], { env });
      await rt.git(dir, ['add', '-A'], { env });
      const tree = (await rt.git(dir, ['write-tree'], { env })).trim();
      return tree === (await rt.git(rt.project, ['rev-parse', `${ref}^{tree}`])).trim();
    });
    if (!same) throw new SlotError('WIP 与工作区不一致，拒绝清理', 'WIP_MISMATCH');
    await rt.git(dir, ['restore', '--source=HEAD', '--staged', '--worktree', ':/']);
    await rt.git(dir, ['clean', '-fdq']);
  }
  const state = rt.loadState(); delete state[slot]; rt.saveState(state);
  return { wipRef: ref };
}
