// 「控制台转写」提供者（DAG 节点 session-inputs）：浏览器录音 → 上传控制台 transcribe 端点 → 文本喂既有状态机。
// 降级链：控制台转写不可用（无录音能力/无权限/端点 404·501·502·503·504/网络失败）→ 原生系统识别器 → 双不可用隐藏麦克风。
// 413/429 等明确拒绝不降级（换提供者也无济于事），保留草稿并提示。依赖全部注入，便于 Node 测试，不调用真实模型。

export const TRANSCRIBE_PATH = '/api/speech/transcribe';
export const RECORD_MIME = 'audio/webm';
const FALLBACK_STATUSES = new Set([404, 501, 502, 503, 504]);

/** 控制台转写整体不可用（应降级到原生识别器）。 */
export class TranscribeUnavailableError extends Error {
  constructor(message = '控制台转写暂不可用') {
    super(message);
    this.name = 'TranscribeUnavailableError';
    this.fallback = true;
  }
}

/** 本次请求被明确拒绝或失败（不降级，保留草稿并提示）。 */
export class TranscribeRejectedError extends Error {
  constructor(message = '转写失败，请重试', status = 0) {
    super(message);
    this.name = 'TranscribeRejectedError';
    this.fallback = false;
    this.status = status;
  }
}

/** HTTP 状态 → 'ok' | 'fallback' | 'rejected'。 */
export function classifyTranscribeStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  return FALLBACK_STATUSES.has(Number(status)) ? 'fallback' : 'rejected';
}

/** 选择语音提供者：控制台转写优先；其后原生；都没有则 'none'（调用方隐藏麦克风）。 */
export function resolveVoiceProvider({ consoleAvailable = false, nativeAvailable = false } = {}) {
  if (consoleAvailable) return 'console';
  if (nativeAvailable) return 'native';
  return 'none';
}

/** 当前环境是否具备录音能力（getUserMedia + MediaRecorder）。 */
export function canRecordAudio({ mediaDevices, MediaRecorderCtor } = {}) {
  return Boolean(mediaDevices && typeof mediaDevices.getUserMedia === 'function' && typeof MediaRecorderCtor === 'function');
}

/** 上传一段录音并返回识别文本。 */
export async function transcribeBlob({ origin, token, blob, fetchImpl }) {
  if (typeof token !== 'string' || !token) throw new TranscribeRejectedError('尚未绑定设备，请重新绑定后再试');
  const doFetch = fetchImpl || ((url, init) => globalThis.fetch(url, init));
  const url = new URL(TRANSCRIBE_PATH, origin);
  if (url.origin !== new URL(origin).origin) throw new TranscribeRejectedError('转写目标不是当前控制台');
  let response;
  try {
    response = await doFetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': RECORD_MIME, 'x-console-request': '1', 'x-device-token': token },
      body: blob,
    });
  } catch {
    throw new TranscribeUnavailableError('无法连接控制台转写');
  }
  const kind = classifyTranscribeStatus(response.status);
  if (kind === 'fallback') throw new TranscribeUnavailableError();
  let payload = {};
  try { payload = await response.json(); } catch { /* 非 JSON 响应用通用文案 */ }
  if (kind === 'rejected') throw new TranscribeRejectedError(String(payload?.error || `转写失败（${response.status}），请重试`), response.status);
  return String(payload?.text ?? '').trim();
}

/** 录音器：start() 申请麦克风并开始录音；stop() 结束并返回 Blob；cancel() 丢弃。权限拒绝/无麦克风 → TranscribeUnavailableError。 */
export function createRecorder({ mediaDevices, MediaRecorderCtor } = {}) {
  let stream = null;
  let recorder = null;
  let chunks = [];
  const release = () => { stream?.getTracks?.().forEach(track => track.stop()); stream = null; recorder = null; chunks = []; };
  return {
    async start() {
      if (!canRecordAudio({ mediaDevices, MediaRecorderCtor })) throw new TranscribeUnavailableError('本机无法录音');
      try { stream = await mediaDevices.getUserMedia({ audio: true }); }
      catch { throw new TranscribeUnavailableError('无法使用麦克风'); }
      chunks = [];
      try {
        recorder = new MediaRecorderCtor(stream, { mimeType: RECORD_MIME });
      } catch {
        try { recorder = new MediaRecorderCtor(stream); } catch { release(); throw new TranscribeUnavailableError('本机无法录音'); }
      }
      recorder.ondataavailable = event => { if (event?.data && event.data.size > 0) chunks.push(event.data); };
      recorder.start();
    },
    stop() {
      return new Promise((resolve, reject) => {
        if (!recorder) { reject(new TranscribeRejectedError('没有正在进行的录音')); return; }
        const active = recorder;
        active.onstop = () => {
          const blob = new Blob(chunks, { type: RECORD_MIME });
          release();
          resolve(blob);
        };
        active.onerror = () => { release(); reject(new TranscribeRejectedError('录音失败，请重试')); };
        try { active.stop(); } catch { release(); reject(new TranscribeRejectedError('录音失败，请重试')); }
      });
    },
    cancel() { try { recorder?.stop?.(); } catch { /* 已停止 */ } release(); },
    get recording() { return Boolean(recorder); },
  };
}
