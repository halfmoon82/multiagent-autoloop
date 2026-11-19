// 多设备同步算法：提交推进、对账（失败保留最新一致状态）、提示、已决卡片视图。
// 纯函数，无隐藏模块状态；at 由调用方注入，保持确定性，便于边界测试。
import { DECISION_KINDS, MAX_STATE_ENTRIES, SyncStateError, createSyncState, normalizeSyncState } from './contract.mjs';

// 任意一台提交即推进共享状态版本；同一设备同一结论重复提交幂等，不刷版本。
export function applySubmission(state, submission = {}, at = null) {
  const base = normalizeSyncState(state);
  const cardId = String(submission.cardId ?? submission.key ?? '').trim();
  if (!cardId || cardId.length > 128) throw new SyncStateError(400, '提交标识无效', 'INVALID_SUBMISSION');
  const decision = submission.decision ?? submission.value;
  if (!DECISION_KINDS.includes(decision)) throw new SyncStateError(400, '提交结论无效', 'INVALID_DECISION');
  const deviceId = String(submission.deviceId ?? '').trim();
  if (!deviceId || deviceId.length > 80) throw new SyncStateError(400, '提交设备无效', 'INVALID_DEVICE');

  const prev = base.decisions[cardId];
  if (prev && prev.value === decision && prev.byDevice === deviceId) return base;

  const stamp = typeof at === 'string' && at ? at : null;
  const decisions = { ...base.decisions, [cardId]: { value: decision, byDevice: deviceId, at: stamp } };
  const keys = Object.keys(decisions);
  if (keys.length > MAX_STATE_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_STATE_ENTRIES)) delete decisions[key];
  }
  return { revision: base.revision + 1, decisions, updatedAt: stamp };
}

// 对账：远端缺失、损坏、版本更旧或相同，都保留本地最新一致状态（同步失败绝不回退）；
// 远端更新则采纳其规范化副本（已去敏）。任何输入都返回新对象，不修改入参。
export function reconcile(localState, remoteState) {
  const local = normalizeSyncState(localState);
  const remote = normalizeSyncState(remoteState);
  if (remote.revision <= local.revision) return local;
  return remote;
}

// 同步提示：成功为 ok；失败给出可读文案，带上保留的版本号，不泄露错误信息里的秘密。
export function syncPrompt(state, error = null) {
  const current = normalizeSyncState(state);
  if (!error) return { kind: 'ok', revision: current.revision, text: '同步正常' };
  return {
    kind: 'stale',
    revision: current.revision,
    text: `同步暂不可用，已保留上次一致状态（版本 ${current.revision}），请稍后重试`,
  };
}

export function processedCardKeys(state) {
  return new Set(Object.keys(normalizeSyncState(state).decisions));
}
