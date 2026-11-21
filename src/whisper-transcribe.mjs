// 语音转写：POST /api/speech/transcribe 的业务层。调用本机 whisper CLI（openai-whisper）。
// 边界：只做音频落临时文件 → 白名单参数调用 CLI → 读 txt → 清理；鉴权与路由分派在 server.mjs。
// 安全：execFile 不经 shell，参数全部来自白名单常量/校验后的配置；stderr 只留服务端不回传。
import { execFile } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const DEFAULT_WHISPER_PATH = '/Users/macmini/.local/bin/whisper';
export const DEFAULT_WHISPER_MODEL = 'small';
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 60;
const FAIL_TEXT = '转写失败，请重试';
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
// 容器扩展名白名单：临时文件名固定为 audio.<ext>，不使用客户端给的文件名。
const EXT_BY_TYPE = new Map([
  ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/wave', 'wav'], ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'],
  ['audio/mp4', 'm4a'], ['audio/m4a', 'm4a'], ['audio/x-m4a', 'm4a'], ['audio/aac', 'aac'], ['audio/ogg', 'ogg'],
  ['audio/opus', 'ogg'], ['audio/webm', 'webm'], ['audio/flac', 'flac'], ['audio/3gpp', '3gp'],
]);

export class WhisperError extends Error {
  constructor(status, message = FAIL_TEXT) { super(message); this.status = status; }
}

export function audioExtension(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('audio/')) return null;
  return EXT_BY_TYPE.get(type) || 'bin';
}

// WAV 头可得时长；非 WAV 无法廉价判定，只受 2MB 上限约束。
export function wavSeconds(buffer) {
  if (buffer.length < 44 || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('latin1', offset, offset + 4); const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 20 <= buffer.length) byteRate = buffer.readUInt32LE(offset + 16);
    if (id === 'data') return byteRate > 0 ? Math.min(size, buffer.length - offset - 8) / byteRate : null;
    offset += 8 + size + (size % 2);
  }
  return null;
}

// 取出 multipart 的第一个带文件名的分片；返回 { type, data } 或 null。
export function parseMultipartAudio(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary[1] || boundary[2]}`);
  let start = buffer.indexOf(delimiter);
  while (start !== -1) {
    const headEnd = buffer.indexOf('\r\n\r\n', start);
    if (headEnd === -1) return null;
    const head = buffer.toString('latin1', start + delimiter.length, headEnd);
    const next = buffer.indexOf(delimiter, headEnd + 4);
    if (/filename=/i.test(head) && next !== -1) {
      const type = /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1] || '';
      return { type, data: buffer.subarray(headEnd + 4, next - 2) };
    }
    start = next;
  }
  return null;
}

export function createWhisperTranscriber(options = {}) {
  const whisperPath = options.path || DEFAULT_WHISPER_PATH;
  const model = options.model || DEFAULT_WHISPER_MODEL;
  if (!MODEL_PATTERN.test(model)) throw new Error('whisper 模型名不合法');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60000;
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : 3000;
  const tmpRoot = options.tmpRoot || tmpdir();
  const lastByDevice = new Map();

  return {
    // 缺失/不可执行 → 503，客户端走降级。
    assertAvailable() {
      try { accessSync(whisperPath, constants.X_OK); } catch { throw new WhisperError(503, '语音转写不可用'); }
    },
    // 同设备冷却：受理即记时；超限抛 429。
    claimCooldown(deviceId, now = Date.now()) {
      const last = lastByDevice.get(deviceId);
      if (last !== undefined && now - last < cooldownMs) throw new WhisperError(429, '请求过于频繁，请稍后再试');
      lastByDevice.set(deviceId, now);
      if (lastByDevice.size > 1000) for (const [key, at] of lastByDevice) if (now - at >= cooldownMs) lastByDevice.delete(key);
    },
    async transcribe(audio, extension) {
      this.assertAvailable();
      const seconds = wavSeconds(audio);
      if (seconds !== null && seconds > MAX_AUDIO_SECONDS) throw new WhisperError(413, '音频过长');
      const dir = mkdtempSync(path.join(tmpRoot, 'whisper-'));
      try {
        const input = path.join(dir, `audio.${extension}`);
        writeFileSync(input, audio, { mode: 0o600 });
        const args = [input, '--model', model, '--output_format', 'txt', '--output_dir', dir, '--fp16', 'False'];
        await new Promise((resolve, reject) => {
          execFile(whisperPath, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME } }, error => {
            if (!error) return resolve();
            // stderr 只记服务端日志，不回传客户端。
            console.error(`[whisper] 转写失败：${error.killed ? '超时' : `退出 ${error.code}`}`);
            reject(new WhisperError(error.killed ? 504 : 502));
          });
        });
        try { return { text: readFileSync(path.join(dir, 'audio.txt'), 'utf8').trim() }; }
        catch { throw new WhisperError(502); }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  };
}
