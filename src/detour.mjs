// 频限绕行登记与回归：模型被频限拦下时记录被拦 Agent/模型、证据与替代派发，
// 按冷却节奏最小核实恢复，核实通过后把规则原子回归原派发。
// 只拥有 detours.json 状态机与 rules.json 的原子替换；探测命令本身由登记时给出。
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class DetourError extends Error {}

const text = (value, label) => {
  const result = String(value ?? '').trim();
  if (!result) throw new DetourError(`请填写${label}`);
  return result;
};

export function detoursFile(config) { return path.join(config.root, 'detours.json'); }

export function readDetours(config) {
  const file = detoursFile(config);
  if (!existsSync(file)) return [];
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new DetourError(`读不到 ${file}：${error.message}`); }
  if (!Array.isArray(raw.detours)) throw new DetourError('detours.json 缺少 detours 数组');
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

function writeRules(config, raw, { backup, backupName } = {}) {
  const directory = path.dirname(config.rulesFile);
  if (backupName && backup) writeFileSync(path.join(directory, backupName), JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
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

function findDetour(config, id) {
  const detour = readDetours(config).find((item) => item.id === id);
  if (!detour) throw new DetourError(`没有这个绕行记录：${id}`);
  return detour;
}

/** 登记一次频限绕行：把指定规则切到替代 Agent，留原始派发的快照。 */
export function recordDetour(config, input, now = new Date()) {
  const id = text(input.id, '绕行标识');
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
  if (detours.some((item) => item.id === id && item.status === 'detoured')) throw new DetourError(`已有同名进行中的绕行：${id}`);

  const raw = readRules(config);
  const backup = JSON.parse(JSON.stringify(raw));
  const snapshots = [];
  for (const name of ruleNames) {
    const rule = raw.rules.find((item) => item.name === name);
    if (!rule) throw new DetourError(`没有这条规则：${name}`);
    if (rule.to === fallbackAgent) throw new DetourError(`规则「${name}」已经不在被拦 Agent 上，不记入本次绕行`);
    snapshots.push({ name, originalTo: rule.to });
    rule.to = fallbackAgent;
  }
  writeRules(config, raw, { backup, backupName: `rules.json.bak-detour-${id}` });

  const record = {
    id, status: 'detoured', blockedAt: now.toISOString(),
    blockedAgent, ...(blockedModel ? { blockedModel } : {}), evidence,
    fallbackAgent, rules: snapshots,
    probe: { ...(probeCommand ? { command: probeCommand } : {}), cooldownMinutes },
    lastProbeAt: null, lastProbeOk: null, history: [{ at: now.toISOString(), event: 'detoured', note: evidence }],
  };
  writeDetours(config, [...detours, record]);
  return record;
}

/** 到期的绕行记录：从未探测过，或距上次探测超过冷却。 */
export function dueForProbe(config, now = new Date()) {
  return readDetours(config).filter((detour) => {
    if (detour.status !== 'detoured') return false;
    if (!detour.lastProbeAt) return true;
    return now.getTime() - new Date(detour.lastProbeAt).getTime() >= detour.probe.cooldownMinutes * 60000;
  });
}

function applyRevert(config, detour, now, cause) {
  const raw = readRules(config);
  const backup = JSON.parse(JSON.stringify(raw));
  const reverted = [];
  const skipped = [];
  for (const snapshot of detour.rules) {
    const rule = raw.rules.find((item) => item.name === snapshot.name);
    if (!rule) { skipped.push({ name: snapshot.name, currentTo: null }); continue; }
    if (rule.to !== detour.fallbackAgent) { skipped.push({ name: snapshot.name, currentTo: rule.to }); continue; }
    rule.to = snapshot.originalTo;
    reverted.push(snapshot.name);
  }
  writeRules(config, raw, { backup, backupName: `rules.json.bak-detour-${detour.id}` });
  detour.status = 'reverted';
  detour.revertedAt = now.toISOString();
  detour.history.push({ at: now.toISOString(), event: 'reverted', note: `${cause}；回归 ${reverted.length} 条${skipped.length ? `，跳过 ${skipped.length} 条（已离开替代 Agent）` : ''}` });
  writeDetours(config, readDetours(config).map((item) => (item.id === detour.id ? detour : item)));
  return { record: detour, reverted, skipped };
}

/** 记一次核实结果；恢复（ok）时回归原派发。 */
export function markProbeResult(config, id, ok, now = new Date()) {
  const detours = readDetours(config);
  const detour = detours.find((item) => item.id === id);
  if (!detour) throw new DetourError(`没有这个绕行记录：${id}`);
  if (detour.status !== 'detoured') throw new DetourError(`绕行 ${id} 已${detour.status === 'reverted' ? '回归' : '关闭'}，不再核实`);
  detour.lastProbeAt = now.toISOString();
  detour.lastProbeOk = !!ok;
  detour.history.push({ at: now.toISOString(), event: ok ? 'probe-ok' : 'probe-fail' });
  if (!ok) { writeDetours(config, detours); return { record: detour, reverted: [], skipped: [] }; }
  return applyRevert(config, detour, now, '核实恢复');
}

/** 不经探测直接回归（例如人工确认已恢复）。 */
export function revertDetour(config, id, now = new Date()) {
  const target = findDetour(config, id);
  if (target.status === 'reverted') return { record: target, reverted: [], skipped: target.rules.map((s) => ({ name: s.name, currentTo: s.originalTo })) };
  return applyRevert(config, target, now, '人工回归');
}
