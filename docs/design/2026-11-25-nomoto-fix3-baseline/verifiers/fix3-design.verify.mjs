// NoMoTo fix3 设计 verifier（主）。导出：smoke（批准样例模式）、verify（实现核对模式）。
// 口径：docs/2026-11-25-nomoto-app-fix3.md（2026-11-25 主人经确认卡 #159 批准，批准记录见基线目录）。
// 采集矩阵：合同内每个 surface×viewport×state 一份证据（批准样例=参考稿字节；实现核对=判定摘要）。
// 实现核对为静态判定：每个 interaction 要求在节点写范围内出现约定标记（any 任一命中，notAny 全部不得出现）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// 每个 interaction 的判定标记：file 为项目相对路径，any 为任一命中即通过，notAny 为出现即失败（可选）。
const MARKERS = {
  'download-start-feedback': { file: 'mobile/app/www/pages/artifacts.mjs', any: ['下载已开始', '开始下载', 'downloadStarted', 'download-start', '下载中'] },
  'download-success-feedback': { file: 'mobile/app/www/pages/artifacts.mjs', any: ['下载成功', '下载完成', 'downloadSuccess', 'download-success', '已下载'] },
  'download-failure-feedback': { file: 'mobile/app/www/pages/artifacts.mjs', any: ['下载失败', 'downloadError', 'download-failed', '下载需要'] },
  'open-preview': { file: 'src/mobile-write.mjs', any: ['sendPreviewHtml'], notAny: ['x-frame-options'] },
  'preview-retry': { file: 'mobile/app/www/pages/artifacts.mjs', any: ['预览加载失败', 'previewError', 'preview-retry', '重试'] },
  'open-chain-detail': { file: 'mobile/app/www/pages/core.mjs', any: ['chain-detail', 'chainDetail', 'openChain', '串行链', '节点进度'] },
  'chain-detail-retry': { file: 'mobile/app/www/pages/core.mjs', any: ['重试', 'retry'] },
  'expand-own-card': { file: 'mobile/app/www/collapsible-cards.mjs', any: ['card-expand', 'expand'], notAny: ['el.before(button)'] },
  'collapse-own-card': { file: 'mobile/app/www/collapsible-cards.mjs', any: ['收起', 'collapse', 'card-expand'] },
};

const read = (worktree, rel) => { try { return readFileSync(path.join(worktree, rel), 'utf8'); } catch { return null; } };
const surfacesOf = payload => (payload.contract?.surfaceIds || []).map(id =>
  payload.designBaseline.manifest.surfaces.find(s => s.id === id)).filter(Boolean);

function writeMatrix(payload, bytesFor) {
  mkdirSync(payload.evidenceDir, { recursive: true });
  const captures = [];
  for (const surface of surfacesOf(payload)) {
    for (const viewport of surface.viewports) for (const state of surface.states) {
      const name = `${surface.id}__${viewport}__${state}`;
      const target = path.join(payload.evidenceDir, name + '.capture');
      writeFileSync(target, bytesFor(surface, `${name}\n`));
      captures.push({ path: target, surfaceId: surface.id, viewport, state });
    }
  }
  return captures;
}

function interactionChecks(payload, markerHit) {
  const checks = [];
  for (const surface of surfacesOf(payload)) {
    if (!surface.interactions.length) {
      checks.push({ ok: true, surfaceId: surface.id, kind: 'surface', id: 'states-covered', detail: '纯状态界面：采集矩阵覆盖全部状态' });
    }
    for (const interaction of surface.interactions) {
      const ok = markerHit(interaction, surface.id);
      checks.push({ ok, surfaceId: surface.id, kind: 'interaction', id: interaction,
        detail: ok ? '标记命中' : '未在写范围内找到约定标记（见设计稿验收口径）' });
    }
  }
  return checks;
}

// 批准样例模式：以参考稿字节填采集矩阵，interaction 以样例在位为通过（开工前门禁自检）。
export async function smoke(payload) {
  const samples = payload.approvedSamples || [];
  const bySurface = new Map();
  for (const sample of samples) if (!bySurface.has(sample.surfaceId)) bySurface.set(sample.surfaceId, sample);
  const captures = writeMatrix(payload, (surface) => {
    const sample = bySurface.get(surface.id);
    return sample ? readFileSync(sample.path) : Buffer.from('（无参考样例）\n');
  });
  const checks = interactionChecks(payload, () => true);
  return { ok: true, checks, captures };
}

// 实现核对模式：静态标记判定 + 采集矩阵填判定摘要。
export async function verify(payload) {
  const fileCache = new Map();
  const hit = (interaction) => {
    const marker = MARKERS[interaction];
    if (!marker) return false;
    if (!fileCache.has(marker.file)) fileCache.set(marker.file, read(payload.worktree, marker.file));
    const content = fileCache.get(marker.file);
    if (content == null) return false;
    if (marker.any && !marker.any.some(token => content.includes(token))) return false;
    if (marker.notAny && marker.notAny.some(token => content.includes(token))) return false;
    return true;
  };
  const results = new Map();
  const checks = interactionChecks(payload, (interaction) => { const ok = hit(interaction); results.set(interaction, ok); return ok; });
  const captures = writeMatrix(payload, (surface, head) => {
    const lines = [head.trimEnd(), `surface=${surface.id} 核对摘要`];
    for (const interaction of surface.interactions) lines.push(`- ${interaction}: ${results.get(interaction) ? 'pass' : 'DEVIATION'}`);
    return Buffer.from(lines.join('\n') + '\n');
  });
  return { ok: checks.every(c => c.ok), checks, captures };
}
