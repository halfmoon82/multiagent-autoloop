// 频限绕行登记与回归：模型被频限拦下时记录被拦 Agent/模型、证据与替代派发，
// 按冷却节奏最小核实恢复，核实通过后把规则原子回归原派发。
// 只拥有 detours.json 状态机、rules.json 的原子替换与状态锁；探测命令本身由登记时给出。
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class DetourError extends Error {}

const text = (value, label) => {
  const result = String(value ?? '').trim();
  if (!result) throw new DetourError(`请填写${label}`);
  return result;
};

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lockToken = () => `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const lockFile = (config) => path.join(config.root, '.console-state.lock');

function tryAcquire(config, token) {
  const fd = openSync(lockFile(config), 'wx');
  writeFileSync(fd, token);
  closeSync(fd);
}

function releaseIfOurs(config, token) {
  try {
    if (existsSync(lockFile(config)) && readFileSync(lockFile(config), 'utf8') === token) unlinkSync(lockFile(config));
  } catch { /* 锁已被回收方处理 */ }
}

function staleOrGone(config, staleMs) {
  try {
    if (Date.now() - statSync(lockFile(config)).mtimeMs > staleMs) { unlinkSync(lockFile(config)); return true; }
  } catch { /* 锁文件恰好消失，下一轮 openSync(wx) 直接成功 */ }
  return false;
}

/** 同步状态锁：给 detour 的同步操作用（CLI 进程内自旋等待可接受）。 */
export function withStateLock(config, fn, { timeoutMs = 5000, staleMs = 60000 } = {}) {
  const token = lockToken();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { tryAcquire(config, token); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw new DetourError('状态被其他操作占用，请稍后重试');
      if (!staleOrGone(config, staleMs)) sleepSync(100);
    }
  }
  try { return fn(); } finally { releaseIfOurs(config, token); }
}

/** 异步状态锁：给控制台 server 内的 async 操作用（setTimeout 重试，不阻塞事件循环）。 */
export async function withStateLockAsync(config, fn, { timeoutMs = 15000, staleMs = 60000 } = {}) {
  const token = lockToken();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { tryAcquire(config, token); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw new DetourError('状态被其他操作占用，请稍后重试');
      if (!staleOrGone(config, staleMs)) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await fn(); } finally { releaseIfOurs(config, token); }
}

export function detoursFile(config) { return path.join(config.root, 'detours.json'); }

/** 控制台展示用的公开形态：保留展示字段，剥掉探测命令等运行时细节。 */
export function publicDetour(detour) {
  return {
    id: detour.id, status: detour.status,
    blockedAt: detour.blockedAt, ...(detour.revertedAt ? { revertedAt: detour.revertedAt } : {}),
    blockedAgent: detour.blockedAgent, ...(detour.blockedModel ? { blockedModel: detour.blockedModel } : {}),
    evidence: detour.evidence, fallbackAgent: detour.fallbackAgent,
    rules: detour.rules.map((rule) => ({ name: rule.name, originalTo: rule.originalTo })),
    ...(detour.lastProbeAt ? { lastProbeAt: detour.lastProbeAt } : {}),
    ...(detour.lastProbeOk !== null && detour.lastProbeOk !== undefined ? { lastProbeOk: detour.lastProbeOk } : {}),
  };
}

/** 只读：损坏即抛错，不在只读路径上改名留档。 */
export function readDetours(config) {
  const file = detoursFile(config);
  if (!existsSync(file)) return [];
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new DetourError(`detours.json 损坏：${error.message}（跑一次 record/verify 会自动留档隔离）`); }
  if (!Array.isArray(raw.detours)) throw new DetourError('detours.json 缺少 detours 数组（跑一次 record/verify 会自动留档隔离）');
  return raw.detours;
}

/** 把损坏的 detours.json 改名留档并视为空；只能在持锁写路径上调用。 */
export function quarantineCorruptDetours(config) {
  const file = detoursFile(config);
  if (!existsSync(file)) return false;
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { raw = null; }
  if (raw && Array.isArray(raw.detours)) return false;
  renameSync(file, path.join(config.root, `detours.json.corrupt-${Date.now()}`));
  return true;
}

let detourPersister = null; // 测试注入：写 detours.json 的实现，用于验证回滚路径
export function setDetourPersisterForTest(fn) { detourPersister = fn; }

function writeDetours(config, detours) {
  if (detourPersister) return detourPersister(config, detours);
  const file = detoursFile(config);
  const draft = path.join(config.root, `.detours-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(draft, JSON.stringify({ detours }, null, 2) + '\n', { mode: 0o600 });
    renameSync(draft, file);
  } finally { try { unlinkSync(draft); } catch {} }
}

const timestamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function writeRules(config, raw, { backup, backupName } = {}) {
  const directory = path.dirname(config.rulesFile);
  const safeName = String(backupName || '').replace(/[^\w.-]/g, '_');
  if (backupName && backup) writeFileSync(path.join(directory, safeName), JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
  const draft = path.join(directory, `.rules-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(draft, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
    renameSync(draft, config.rulesFile);
  } finally { try { unlinkSync(draft); } catch {} }
}

function readRules(config) {
  try { return JSON.parse(readFileSync(config.rulesFile, 'utf8')); }
  catch (error) { throw new DetourError(`读不到 ${config.rulesFile}：${error.message}`); }
}

/** 用登记时留的备份把 rules.json 回滚到写 detours 之前。 */
function rollbackRules(config, backupName) {
  renameSync(path.join(path.dirname(config.rulesFile), backupName), config.rulesFile);
}

function findAnyDetour(config, id) {
  const detour = readDetours(config).find((item) => item.id === id);
  if (!detour) throw new DetourError(`没有这个绕行记录：${id}`);
  return detour;
}

/** 登记一次频限绕行：把指定规则切到替代 Agent，留原始派发的快照。 */
export function recordDetour(config, input, now = new Date()) {
  return withStateLock(config, () => {
    quarantineCorruptDetours(config);
    const id = text(input.id, '绕行标识');
    if (!/^[\w.-]+$/.test(id)) throw new DetourError('绕行标识只能是字母、数字、下划线、点和短横');
    if (id.includes('..')) throw new DetourError('绕行标识不能包含连续点');
    const blockedAgent = text(input.blockedAgent, '被拦 Agent');
    const blockedModel = String(input.blockedModel ?? '').trim();
    const evidence = text(input.evidence, '频限证据');
    const fallbackAgent = text(input.fallbackAgent, '替代 Agent');
    const ruleNames = Array.isArray(input.ruleNames) ? input.ruleNames.map((name) => text(name, '规则名称')) : [];
    if (!ruleNames.length) throw new DetourError('请给出至少一条受影响的规则');
    if (blockedAgent === fallbackAgent) throw new DetourError('被拦 Agent 和替代 Agent 不能相同');
    const cooldownMinutes = Number(input.probe?.cooldownMinutes ?? 30);
    if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 1) throw new DetourError('核实冷却要至少是 1 分钟');
    const probeCommand = Array.isArray(input.probe?.command) && input.probe.command.length ? input.probe.command.map(String) : null;

    const detours = readDetours(config);
    if (detours.some((item) => item.id === id)) throw new DetourError(`已有同名绕行记录：${id}（id 是一次性标识，请换一个新的）`);

    const raw = readRules(config);
    const backup = JSON.parse(JSON.stringify(raw));
    const snapshots = [];
    for (const name of ruleNames) {
      const rule = raw.rules.find((item) => item.name === name);
      if (!rule) throw new DetourError(`没有这条规则：${name}`);
      if (rule.to !== blockedAgent) throw new DetourError(`规则「${name}」当前在 ${rule.to}，不在被拦 Agent ${blockedAgent} 上，不记入本次绕行`);
      snapshots.push({ name, originalTo: rule.to });
      rule.to = fallbackAgent;
    }
    const record = {
      id, status: 'detoured', blockedAt: now.toISOString(),
      blockedAgent, ...(blockedModel ? { blockedModel } : {}), evidence,
      fallbackAgent, rules: snapshots,
      probe: { ...(probeCommand ? { command: probeCommand } : {}), cooldownMinutes },
      lastProbeAt: null, lastProbeOk: null, history: [{ at: now.toISOString(), event: 'detoured', note: evidence }],
    };
    const backupName = `rules.json.bak-detour-${id}`;
    writeRules(config, raw, { backup, backupName });
    try { writeDetours(config, [...detours, record]); }
    catch (error) {
      // 登记写失败时把 rules.json 回滚到绕行前，不留「切走但无记录」的状态。
      rollbackRules(config, backupName);
      throw new DetourError(`登记写入失败，rules.json 已回滚：${error.message}`);
    }
    return record;
  });
}

/** 到期的绕行记录：从未探测过，或距上次探测超过冷却。 */
export function dueForProbe(config, now = new Date()) {
  return readDetours(config).filter((detour) => {
    if (detour.status !== 'detoured') return false;
    const cooldownMinutes = Number(detour.probe?.cooldownMinutes) || 30;
    if (!detour.lastProbeAt) return true;
    return now.getTime() - new Date(detour.lastProbeAt).getTime() >= cooldownMinutes * 60000;
  });
}

function applyRevert(config, detour, now, cause) {
  const raw = readRules(config);
  const backup = JSON.parse(JSON.stringify(raw));
  const reverted = [];
  const skipped = [];
  for (const snapshot of detour.rules) {
    const rule = raw.rules.find((item) => item.name === snapshot.name);
    if (!rule) { skipped.push({ name: snapshot.name, currentTo: null, reason: 'missing' }); continue; }
    if (rule.to === snapshot.originalTo) { skipped.push({ name: snapshot.name, currentTo: rule.to, reason: 'already-original' }); continue; }
    if (rule.to !== detour.fallbackAgent) { skipped.push({ name: snapshot.name, currentTo: rule.to, reason: 'left-fallback' }); continue; }
    rule.to = snapshot.originalTo;
    reverted.push(snapshot.name);
  }
  const backupName = `rules.json.bak-revert-${detour.id}-${timestamp()}`;
  writeRules(config, raw, { backup, backupName });
  detour.status = 'reverted';
  detour.revertedAt = now.toISOString();
  detour.history.push({ at: now.toISOString(), event: 'reverted', note: `${cause}；回归 ${reverted.length} 条${skipped.length ? `，跳过 ${skipped.length} 条` : ''}` });
  try { writeDetours(config, readDetours(config).map((item) => (item.id === detour.id ? detour : item))); }
  catch (error) {
    rollbackRules(config, backupName);
    throw new DetourError(`回归记录写入失败，rules.json 已回滚：${error.message}`);
  }
  return { record: detour, reverted, skipped };
}

/** 记一次核实结果；恢复（ok）时回归原派发。 */
export function markProbeResult(config, id, ok, now = new Date()) {
  return withStateLock(config, () => {
    quarantineCorruptDetours(config);
    const detours = readDetours(config);
    const detour = detours.find((item) => item.id === id && item.status === 'detoured');
    if (!detour) throw new DetourError(`没有进行中的绕行：${id}`);
    detour.lastProbeAt = now.toISOString();
    detour.lastProbeOk = !!ok;
    detour.history.push({ at: now.toISOString(), event: ok ? 'probe-ok' : 'probe-fail' });
    if (!ok) { writeDetours(config, detours); return { record: detour, reverted: [], skipped: [] }; }
    return applyRevert(config, detour, now, '核实恢复');
  });
}

/** 不经探测直接回归（例如人工确认已恢复）。已回归的记录返回 already: true，不重复动作。 */
export function revertDetour(config, id, now = new Date()) {
  return withStateLock(config, () => {
    quarantineCorruptDetours(config);
    const target = findAnyDetour(config, id);
    if (target.status === 'reverted') return { record: target, already: true, reverted: [], skipped: [] };
    return applyRevert(config, target, now, '人工回归');
  });
}
