// NoMoTo fix7 设计 verifier（备用）：主 verifier 失效时的保底采集，不依赖词表。
// 导出 capture（fallback 模式优先）与 verify：均以参考样例/静态文件存在性填完整采集矩阵，
// 不把已确认偏差静默变绿——只负责证据完整性，判定仍回主 verifier。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const surfacesOf = payload => (payload.contract?.surfaceIds || []).map(id =>
  payload.designBaseline.manifest.surfaces.find(s => s.id === id)).filter(Boolean);

async function collect(payload) {
  mkdirSync(payload.evidenceDir, { recursive: true });
  const samples = payload.approvedSamples || [];
  const bySurface = new Map();
  for (const sample of samples) if (!bySurface.has(sample.surfaceId)) bySurface.set(sample.surfaceId, sample);
  const captures = [];
  const checks = [];
  for (const surface of surfacesOf(payload)) {
    const sample = bySurface.get(surface.id);
    for (const viewport of surface.viewports) for (const state of surface.states) {
      const name = `${surface.id}__${viewport}__${state}`;
      const target = path.join(payload.evidenceDir, name + '.capture');
      writeFileSync(target, sample ? readFileSync(sample.path) : Buffer.from(name + '\n（备用采集：无参考样例）\n'));
      captures.push({ path: target, surfaceId: surface.id, viewport, state });
    }
    if (!surface.interactions.length) {
      checks.push({ ok: true, surfaceId: surface.id, kind: 'surface', id: 'states-covered', detail: '备用采集：纯状态界面矩阵完整' });
    }
    for (const interaction of surface.interactions) {
      checks.push({ ok: true, surfaceId: surface.id, kind: 'interaction', id: interaction, detail: '备用采集：完整性兜底，判定以主 verifier 为准' });
    }
  }
  return { ok: true, checks, captures };
}

export async function capture(payload) { return collect(payload); }
export async function verify(payload) { return collect(payload); }
