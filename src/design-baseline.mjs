// 可选设计基线：只读加载、内容 hash、一次批准记录与节点合同子集校验。
// 本模块不读 PRD 自由文本，不执行浏览器，也不拥有执行授权。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HEX_64 = /^[0-9a-f]{64}$/;
const VIEWPORT = /^\d+x\d+$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export class DesignBaselineError extends Error {
  constructor(code, message) { super(message); this.name = 'DesignBaselineError'; this.code = code; }
}

const fail = (code, message) => { throw new DesignBaselineError(code, message); };
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const sha256 = value => createHash('sha256').update(value).digest('hex');

function projectFile(projectRoot, relativePath, label = '设计文件') {
  if (!String(projectRoot ?? '').trim()) fail('INVALID_PROJECT', 'projectRoot 不能为空');
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) fail('INVALID_DESIGN_PATH', `${label}路径必须是项目内相对路径`);
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) fail('DESIGN_PATH_ESCAPE', `${label}路径逃逸项目根：${relativePath}`);
  let realRoot;
  let real;
  try { realRoot = realpathSync(root); real = realpathSync(resolved); }
  catch (error) { fail(error?.code === 'ENOENT' ? 'DESIGN_FILE_MISSING' : 'DESIGN_FILE_UNREADABLE', `${label}不可读：${relativePath}`); }
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) fail('DESIGN_PATH_ESCAPE', `${label}通过符号链接逃逸项目根：${relativePath}`);
  if (!statSync(real).isFile()) fail('INVALID_DESIGN_PATH', `${label}不是文件：${relativePath}`);
  return { resolved: real, relativePath: relativePath.split(path.sep).join('/') };
}

function readJson(projectRoot, relativePath, label) {
  const file = projectFile(projectRoot, relativePath, label);
  if (statSync(file.resolved).size > MAX_JSON_BYTES) fail('DESIGN_FILE_TOO_LARGE', `${label}过大：${relativePath}`);
  try { return { ...file, data: JSON.parse(readFileSync(file.resolved, 'utf8')) }; }
  catch (error) { fail('INVALID_DESIGN_JSON', `${label}不是合法 JSON：${error.message}`); }
}

function stringArray(value, label, { empty = false } = {}) {
  if (!Array.isArray(value) || (!empty && value.length === 0) || value.some(item => typeof item !== 'string' || !item.trim())) fail('INVALID_DESIGN_MANIFEST', `${label}必须是${empty ? '可空' : '非空'}字符串数组`);
  return [...new Set(value)];
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schema !== 1) fail('INVALID_DESIGN_MANIFEST', '设计清单 schema 必须为 1');
  if (typeof manifest.designId !== 'string' || !manifest.designId.trim()) fail('INVALID_DESIGN_MANIFEST', '设计清单缺少 designId');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) fail('INVALID_DESIGN_MANIFEST', '设计产物 artifacts 必须是非空数组');
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact.path !== 'string' || !HEX_64.test(String(artifact.sha256 || ''))) fail('INVALID_DESIGN_MANIFEST', '设计产物必须包含 path 与 sha256');
  }
  if (!Array.isArray(manifest.surfaces) || manifest.surfaces.length === 0) fail('INVALID_DESIGN_MANIFEST', '设计清单 surfaces 必须是非空数组');
  const ids = new Set();
  for (const surface of manifest.surfaces) {
    if (!surface || typeof surface.id !== 'string' || !surface.id.trim() || ids.has(surface.id)) fail('INVALID_DESIGN_MANIFEST', 'surface id 缺失或重复');
    ids.add(surface.id);
    if (typeof surface.route !== 'string' || !surface.route.trim()) fail('INVALID_DESIGN_MANIFEST', `surface ${surface.id} 缺少 route`);
    const viewports = stringArray(surface.viewports, `surface ${surface.id}.viewports`);
    if (viewports.some(item => !VIEWPORT.test(item))) fail('INVALID_DESIGN_MANIFEST', `surface ${surface.id} viewport 必须形如 1440x900`);
    stringArray(surface.states, `surface ${surface.id}.states`);
    stringArray(surface.interactions, `surface ${surface.id}.interactions`, { empty: true });
    stringArray(surface.referencePaths, `surface ${surface.id}.referencePaths`);
  }
}

export function loadDesignManifest({ projectRoot, manifestPath } = {}) {
  const { data: manifest, relativePath } = readJson(projectRoot, manifestPath, '设计清单');
  validateManifest(manifest);
  const artifactPaths = new Set();
  for (const artifact of manifest.artifacts) {
    const file = projectFile(projectRoot, artifact.path, '设计产物');
    const actual = sha256(readFileSync(file.resolved));
    if (actual !== artifact.sha256) fail('DESIGN_ARTIFACT_DIGEST_MISMATCH', `设计产物 sha256 摘要不符：${artifact.path}`);
    artifactPaths.add(file.relativePath);
  }
  for (const surface of manifest.surfaces) {
    for (const reference of surface.referencePaths) {
      const file = projectFile(projectRoot, reference, '设计参考图');
      if (!artifactPaths.has(file.relativePath)) fail('UNHASHED_DESIGN_REFERENCE', `referencePaths 必须包含在 artifacts 产物 hash 中：${reference}`);
    }
  }
  if (manifest.verifierPath !== undefined) {
    const verifier = projectFile(projectRoot, manifest.verifierPath, '设计 verifier');
    if (!artifactPaths.has(verifier.relativePath)) fail('UNHASHED_DESIGN_VERIFIER', `verifierPath 必须包含在 artifacts 产物 hash 中：${manifest.verifierPath}`);
  }
  return {
    manifestPath: relativePath,
    designDigest: sha256(canonical(manifest)),
    manifest: JSON.parse(JSON.stringify(manifest)),
    readOnlyPaths: [relativePath, ...artifactPaths],
  };
}

export function loadDesignBaseline({ projectRoot, manifestPath, approvalPath } = {}) {
  const loaded = loadDesignManifest({ projectRoot, manifestPath });
  const { data: approval, relativePath: normalizedApproval } = readJson(projectRoot, approvalPath, '设计批准记录');
  if (!approval || approval.schema !== 1 || !HEX_64.test(String(approval.designDigest || '')) || !Number.isFinite(Date.parse(approval.confirmedAt))) {
    fail('DESIGN_APPROVAL_INVALID', '设计批准记录必须包含 schema=1、designDigest 与有效 confirmedAt');
  }
  if (approval.designDigest !== loaded.designDigest) fail('DESIGN_APPROVAL_MISMATCH', '设计批准记录 designDigest 与当前设计清单不一致，请重新确认');
  return { ...loaded, approvalPath: normalizedApproval, approval: JSON.parse(JSON.stringify(approval)), readOnlyPaths: [...loaded.readOnlyPaths, normalizedApproval] };
}

function snapshotFile(snapshotDirectory, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) fail('INVALID_DESIGN_PATH', '冻结设计路径无效');
  const root = path.resolve(snapshotDirectory || '');
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) fail('DESIGN_PATH_ESCAPE', '冻结设计路径逃逸');
  return resolved;
}

// 创建 DAG 前冻结所有批准字节。目标目录按 designDigest 内容寻址；重复创建幂等，
// 但每次都会重读并校验冻结副本，避免把已有的半截目录当成可恢复基线。
export function freezeDesignBaseline({ projectRoot, designBaseline, directory } = {}) {
  if (!designBaseline?.designDigest || !Array.isArray(designBaseline.readOnlyPaths)) fail('DESIGN_BASELINE_MISSING', '冻结设计需要完整基线');
  if (!String(directory ?? '').trim()) fail('INVALID_DESIGN_PATH', '冻结设计目录不能为空');
  const snapshotDirectory = path.join(path.resolve(directory), designBaseline.designDigest);
  const temporary = path.join(path.resolve(directory), `.${designBaseline.designDigest}.tmp-${process.pid}`);
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const snapshotFiles = {};
  try {
    for (const relativePath of designBaseline.readOnlyPaths) {
      const source = projectFile(projectRoot, relativePath).resolved;
      const bytes = readFileSync(source);
      const target = snapshotFile(temporary, relativePath);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600 });
      snapshotFiles[relativePath] = sha256(bytes);
    }
    // load 与 freeze 之间可能发生正常编辑：在临时目录内重新执行完整批准校验，
    // 不接受“新字节 + 旧 manifest/approval/designDigest”的混合快照。
    const revalidated = loadDesignBaseline({ projectRoot: temporary, manifestPath: designBaseline.manifestPath, approvalPath: designBaseline.approvalPath });
    if (revalidated.designDigest !== designBaseline.designDigest) fail('DESIGN_SNAPSHOT_INVALID', '冻结前后 designDigest 不一致');
    if (existsSync(snapshotDirectory)) {
      // 同一 designDigest 可能被其他活跃 run 使用；校验后复用，绝不删除共享冻结副本。
      const existing = loadDesignBaseline({ projectRoot: snapshotDirectory, manifestPath: designBaseline.manifestPath, approvalPath: designBaseline.approvalPath });
      if (existing.designDigest !== designBaseline.designDigest) fail('DESIGN_SNAPSHOT_INVALID', '已有冻结副本 designDigest 不一致');
      for (const [relativePath, expected] of Object.entries(snapshotFiles)) {
        const target = snapshotFile(snapshotDirectory, relativePath);
        if (!existsSync(target) || sha256(readFileSync(target)) !== expected) fail('DESIGN_SNAPSHOT_INVALID', `已有冻结设计副本不一致：${relativePath}`);
      }
      rmSync(temporary, { recursive: true, force: true });
    } else renameSync(temporary, snapshotDirectory);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  const frozen = { ...JSON.parse(JSON.stringify(designBaseline)), snapshotDirectory, snapshotFiles };
  // 恢复演练：所有字节必须能从冻结目录独立读出且 hash 一致，才允许创建根 run。
  for (const [relativePath, expected] of Object.entries(snapshotFiles)) {
    const file = snapshotFile(snapshotDirectory, relativePath);
    if (!existsSync(file) || sha256(readFileSync(file)) !== expected) fail('DESIGN_SNAPSHOT_INVALID', `冻结设计恢复演练失败：${relativePath}`);
  }
  return frozen;
}

// 运行中只信任创建时冻结的批准字节；可恢复到任意精确 commit 的临时验证 worktree。
export function restoreDesignBaseline({ designBaseline, targetRoot } = {}) {
  if (!designBaseline?.snapshotDirectory || !designBaseline.snapshotFiles) fail('DESIGN_SNAPSHOT_INVALID', '缺少冻结设计副本');
  if (!String(targetRoot ?? '').trim()) fail('INVALID_PROJECT', '恢复设计需要 targetRoot');
  const realTargetRoot = realpathSync(targetRoot);
  const restored = [];
  for (const relativePath of designBaseline.readOnlyPaths || []) {
    const expected = designBaseline.snapshotFiles[relativePath];
    const source = snapshotFile(designBaseline.snapshotDirectory, relativePath);
    let bytes;
    try { bytes = readFileSync(source); } catch { fail('DESIGN_SNAPSHOT_INVALID', `冻结设计副本不可读：${relativePath}`); }
    if (!HEX_64.test(String(expected || '')) || sha256(bytes) !== expected) fail('DESIGN_SNAPSHOT_INVALID', `冻结设计副本摘要不一致：${relativePath}`);
    const target = snapshotFile(targetRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const realParent = realpathSync(path.dirname(target));
    if (realParent !== realTargetRoot && !realParent.startsWith(`${realTargetRoot}${path.sep}`)) fail('DESIGN_PATH_ESCAPE', `恢复设计目标通过符号链接逃逸：${relativePath}`);
    const temporary = `${target}.design-restore-${process.pid}`;
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, target);
    restored.push(relativePath);
  }
  return { restored };
}

const subset = (requested, available, label) => {
  if (requested === undefined) return [...available];
  const values = stringArray(requested, `节点设计合同 ${label}`, { empty: true });
  const outside = values.filter(value => !available.includes(value));
  if (outside.length) fail('DESIGN_CONTRACT_MISMATCH', `节点设计合同 ${label} 超出设计基线：${outside.join(', ')}`);
  return values;
};

export function assertNodeDesignSnapshot(root, node) {
  const contract = node?.contract?.design;
  if (contract === undefined || contract === null) return { ok: true, design: null };
  const baseline = root?.designBaseline;
  if (!baseline || !HEX_64.test(String(baseline.designDigest || '')) || !baseline.manifest) fail('DESIGN_BASELINE_MISSING', `UI 节点 ${node?.id || ''} 缺少已确认设计基线`);
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) fail('INVALID_NODE_DESIGN', '节点 design 合同必须是对象');
  const surfaceIds = stringArray(contract.surfaceIds, '节点设计合同 surfaceIds');
  const selected = [];
  for (const id of surfaceIds) {
    const surface = baseline.manifest.surfaces?.find(item => item.id === id);
    if (!surface) fail('DESIGN_CONTRACT_MISMATCH', `节点 ${node.id} 引用了不存在的 surface：${id}`);
    selected.push({
      id,
      viewports: subset(contract.viewports, surface.viewports, 'viewports'),
      states: subset(contract.states, surface.states, 'states'),
      interactions: subset(contract.interactions, surface.interactions, 'interactions'),
    });
  }
  return { ok: true, design: { surfaceIds, surfaces: selected, contractDigest: designContractDigest({ designDigest: baseline.designDigest, contract }) } };
}

export function designContractDigest({ designDigest, contract } = {}) {
  return sha256(canonical({ designDigest: designDigest || null, contract: contract || null }));
}
