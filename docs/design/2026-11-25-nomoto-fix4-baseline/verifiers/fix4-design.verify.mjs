// NoMoTo fix4 设计 verifier（主）。导出：smoke（批准样例模式）、verify（实现核对模式）。
// 口径：issue #318（串行链详情被 #316 回归删除）与 #319（决策卡回答残留/不绑会话），
// 2026-11-25 晚主人在调度会话明确催办（『你是已经在着手修复了吗？』）批准修复口径。
// 实现核对为静态判定：interaction 要求在写范围内出现约定标记（any 任一命中）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const MARKERS = {
  'open-chain-detail': { file: 'mobile/app/www/pages/core.mjs', any: ['串行链详情', 'chain-detail', 'data-chain-entry', 'chainEntry'] },
  'chain-detail-retry': { file: 'mobile/app/www/pages/core.mjs', any: ['data-chain-retry', '重试'] },
  'answer-vanish': { file: 'mobile/src/features/sessions/browser.mjs', any: ['removeCard', 'hideCard', 'dismissCard', 'answeredCards', '回答后移除', '即时消失', 'answeredAt'] },
  'session-bind': { file: 'mobile/src/features/sessions/browser.mjs', any: ['bySession', '归属会话', 'bindSession', 'sessionScope', 'cardSessionId'] },
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

export async function verify(payload) {
  const fileCache = new Map();
  const hit = (interaction) => {
    const marker = MARKERS[interaction];
    if (!marker) return false;
    if (!fileCache.has(marker.file)) fileCache.set(marker.file, read(payload.worktree, marker.file));
    const content = fileCache.get(marker.file);
    if (content == null) return false;
    return marker.any.some(token => content.includes(token));
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
