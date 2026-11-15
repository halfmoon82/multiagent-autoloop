// 频限绕行登记与回归：模型被频限拦下时记录被拦 Agent/模型、证据与替代派发，
// 按冷却节奏最小核实恢复，核实通过后把规则原子回归原派发。
// 只拥有 detours.json 状态机、rules.json 的原子替换与状态锁；探测命令本身由登记时给出。
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class DetourError extends Error {}

const text = (value, label) => {
  const result = String(value ?? '').trim();
  if (!result) throw new DetourError(`请填写${label}`);
  return result;
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 运行目录的状态锁：登记/核实/回归与控制台规则表单互斥，整文件读-改-写不被交错。 */
export function withStateLock(config, fn, { timeoutMs = 5000, staleMs = 60000 } = {}) {
  const lockFile = path.join(config.root, '.console-state.lock');
  const started = Date.now();
  let fd;
  for (;;) {
    try { fd = openSync(lockFile, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - started > timeoutMs) throw new DetourError('状态被其他操作占用，请稍后重试');
        const age = Date.now() - readFileSync(lockFile, 'utf8').trim().split(':')[0];
        if (age > staleMs) { unlinkSync(lockFile); continue; }
      } catch (inner) { if (inner instanceof DetourError) throw inner; }
      sleep(100);
    }
  }
  try {
    writeFileSync(fd, `${Date.now()}:${process.pid}`);
    return fn();
  } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(lockFile); } catch {}
  }
}

export function detoursFile(config) { return path.join(config.root, 'detours.json'); }

export function readDetours(config) {
  const file = detoursFile(config);
  if (!existsSync(file)) return [];
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    // 手滑改坏时留档隔离，而不是卡死所有绕行核实。
    renameSync(file, path.join(config.root, `detours.json.corrupt-${Date.now()}`));
    return [];
  }
  if (!Array.isArray(raw.detours)) {
    renameSync(file, path.join(config.root, `detours.json.corrupt-${Date.now()}`));
    return [];
  }
  return raw.detours;
}

function writeDetours(config, detours) {
  const file = detoursFile(config);
  const draft = path.join(config.root, `.detours-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(draft, JSON.stringify({ detours }, null, 2) + '\n', { mode: 0o600 });
    renameSync(draft, file);
  } finally { try { unlinkSync(draft); } catch {} }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
}

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

function findActiveDetour(config, id) {
  const detour = readDetours(config).find((item) => item.id === id && item.status === 'detoured');
  if (!detour) throw new DetourError(`没有进行中的绕行：${id}`);
  return detour;
}

function findAnyDetour(config, id) {
  const detour = readDetours(config).find((item) => item.id === id);
  if (!detour) throw new DetourError(`没有这个绕行记录：${id}`);
  return detour;
}

/** 登记一次频限绕行：把指定规则切到替代 Agent，留原始派发的快照。 */
export function recordDetour(config, input, now = new Date()) {
  return withStateLock(config, () => {
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
    writeRules(config, raw, { backup, backupName: `rules.json.bak-detour-${id}` });
    try { writeDetours(config, [...detours, record]); }
    catch (error) {
      // 登记写失败时把 rules.json 回滚到绕行前，不留「切走但无记录」的状态。
      renameSync(path.join(config.root, `rules.json.bak-detour-${id}`), config.rulesFile);
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
    renameSync(path.join(config.root, backupName), config.rulesFile);
    throw new DetourError(`回归记录写入失败，rules.json 已回滚：${error.message}`);
  }
  return { record: detour, reverted, skipped };
}

/** 记一次核实结果；恢复（ok）时回归原派发。 */
export function markProbeResult(config, id, ok, now = new Date()) {
  return withStateLock(config, () => {
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
    const target = findAnyDetour(config, id);
    if (target.status === 'reverted') return { record: target, already: true, reverted: [], skipped: [] };
    return applyRevert(config, target, now, '人工回归');
  });
}
