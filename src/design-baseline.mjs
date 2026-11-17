// 可选设计基线：只读加载、内容 hash、一次批准记录与节点合同子集校验。
// 本模块不读 PRD 自由文本，不执行浏览器，也不拥有执行授权。
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
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
