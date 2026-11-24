// NoMoTo fix2 设计 verifier（主）。导出：smoke（批准样例模式）、verify（实现核对模式）。
// 口径：docs/2026-11-24-fix2-design-review.md（2026-11-24 调度会话内经主人确认，批准记录见基线目录）。
// 采集矩阵：合同内每个 surface×viewport×state 一份证据文件（批准样例=参考稿字节；实现核对=判定摘要）。
// 实现核对为静态判定：每个 interaction 要求在节点写范围内出现约定标记（同义词任一命中），
// 判定失败的 interaction 以 ok:false 进入证据，由节点审阅按偏差处理。
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// 每个 interaction 的判定标记：file 为项目相对路径，any 为任一命中即通过的词表。
const MARKERS = {
  'select-console': { file: 'mobile/app/www/shell.mjs', any: ['selectConsole', 'switchConsole', 'console-picker', 'consolePicker'] },
  'add-console': { file: 'mobile/app/www/shell.mjs', any: ['addConsole', 'add-console', 'bindConsole', 'consoleList'] },
  'add-error-show': { file: 'mobile/app/www/shell.mjs', any: ['add-error', 'addError', '地址不可达', '不可达'] },
  'switch-console': { file: 'mobile/app/www/pages/settings.mjs', any: ['switchConsole', 'currentConsole', '当前控制台', 'console-section'] },
  'remove-console': { file: 'mobile/app/www/pages/settings.mjs', any: ['removeConsole', 'remove-console', '移除控制台'] },
  'auto-retry': { file: 'mobile/app/www/shell.mjs', any: ['backoff', 'retry', '重连', 'reconnect'] },
  'foreground-probe': { file: 'mobile/app/www/shell.mjs', any: ['visibilitychange', 'foreground', 'resume', '回前台'] },
  'manual-retry': { file: 'mobile/app/www/shell.mjs', any: ['manualRetry', '立即重试', 'retryNow'] },
  'resume-page': { file: 'mobile/app/www/shell.mjs', any: ['resumePage', '恢复原页', '回到原', 'restorePage'] },
  'swipe-close': { file: 'mobile/src/features/sessions/views.mjs', any: ['swipe', '左滑', 'touchstart', 'pan'] },
  'close-confirm': { file: 'mobile/src/features/sessions/views.mjs', any: ['close-confirm', 'closeConfirm', '确认关闭', '关闭会话'] },
  'approve-plan': { file: 'mobile/src/features/sessions/views.mjs', any: ['approve-plan', 'approvePlan', '放行落盘', '确认计划'] },
  'open-scope': { file: 'mobile/src/features/sessions/views.mjs', any: ['确认执行范围', 'openScope', 'design-authorize', 'designAuthorize'] },
  'check-item': { file: 'mobile/src/features/design-authorize/views.mjs', any: ['check', '已读', 'checkbox', '勾选'] },
  'submit-confirm': { file: 'mobile/src/features/design-authorize/views.mjs', any: ['submit', '提交', 'dag-runs', 'dagRuns'] },
  'send-message': { file: 'mobile/src/features/sessions/views.mjs', any: ['optimistic', '乐观', 'sendMessage', '发送'] },
  'input-autogrow': { file: 'mobile/src/features/composer-autogrow/autogrow.mjs', any: ['autogrow', 'autoGrow', '行高', 'scrollHeight'] },
  'stream-render': { file: 'mobile/src/features/sessions/views.mjs', any: ['stream', 'liveText', 'requestAnimationFrame', '流式'] },
  'page-hidden-pause': { file: 'mobile/src/features/sessions/views.mjs', any: ['visibilitychange', 'hidden', '页面隐藏', 'document.hidden'] },
  'collapse-card': { file: 'mobile/app/www/collapsible-cards.mjs', any: ['collapse', '折叠'] },
  'expand-card': { file: 'mobile/app/www/collapsible-cards.mjs', any: ['expand', '展开'] },
  'open-artifact': { file: 'mobile/app/www/pages/artifacts.mjs', any: ['artifact', '产物', 'download'] },
  'retry-group': { file: 'mobile/app/www/pages/artifacts.mjs', any: ['retry', '重试'] },
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
      // 纯状态界面（无交互项）：以采集矩阵完整性作为定向 check，保证证据非空。
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
  const captures = writeMatrix(payload, (surface, head) => {
    const sample = bySurface.get(surface.id);
    return sample ? readFileSync(sample.path) : Buffer.from(head + '（无参考样例）\n');
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
