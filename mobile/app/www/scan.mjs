// 扫码绑定的纯逻辑：解码摄像头帧、校验一次性载荷、管好相机生命周期与兜底提示。
// 不碰 DOM 装配（在 app.mjs），不写日志/存储，绝不把一次性二维码内容交给 console。
// 注入相机/解码器/校验器即可在 Node 里做边界测试；生产默认走 getUserMedia + 自带 vendor 解码库。
import { parseBindPayload, MobileShellError } from './shell.mjs';
import { decodeQrImage } from './vendor/qr-decoder.mjs';

export const SCAN_MESSAGES = Object.freeze({
  cameraDenied: '无法访问摄像头，请在浏览器或系统设置里允许相机权限，或改用手工粘贴二维码内容。',
  noCamera: '未检测到可用摄像头，请改用手工粘贴二维码内容。',
  cameraUnavailable: '当前环境不支持调用摄像头，请改用手工粘贴二维码内容。',
  invalidPayload: '这不是有效的 NoMoTo 一次性绑定码，请重新扫描或改用手工粘贴。',
  noQr: '没有识别到二维码，请对准二维码重试或改用手工粘贴。',
  decodeFailed: '二维码识别失败，请重试或改用手工粘贴。',
  generic: '扫码失败，请改用手工粘贴二维码内容。',
});

// 把 getUserMedia 的异常映射成可读中文提示；不把原始异常文案（可能含设备信息）透给用户。
export function describeCameraError(error) {
  const name = error?.name || '';
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name)) return SCAN_MESSAGES.cameraDenied;
  if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(name)) return SCAN_MESSAGES.noCamera;
  const message = error?.message || '';
  if (/permission|denied|拒绝|权限/i.test(message)) return SCAN_MESSAGES.cameraDenied;
  if (/not found|no camera|找不到|没有摄像头/i.test(message)) return SCAN_MESSAGES.noCamera;
  return SCAN_MESSAGES.generic;
}

// 解一帧：先由纯 JS 解码库读出文本，再用 shell.mjs 的严格格式校验一次性载荷。
// 没扫到码返回 null 等下一帧；扫到但格式不对抛 INVALID_BIND，提示不含二维码原文。
export function scanFrame(frame, { decode = decodeQrImage, validate = parseBindPayload } = {}) {
  if (!frame || !frame.data || !frame.width || !frame.height) return null;
  const text = decode(frame.data, frame.width, frame.height);
  if (typeof text !== 'string' || !text) return null;
  const token = validate(text); // 非 NoMoTo 载荷在此抛 MobileShellError('INVALID_BIND')
  return { text, token };
}

// 生产相机桥：优先后置摄像头；关闭时逐条 track.stop，不留下常亮的摄像头。
// video / mediaDevices / doc 都可注入，便于单测用假相机验证。
export function createUserMediaCamera({
  video,
  mediaDevices = globalThis.navigator?.mediaDevices,
  doc = globalThis.document,
} = {}) {
  return {
    async open() {
      if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
        const error = new Error('当前环境不支持调用摄像头');
        error.name = 'NotFoundError';
        throw error;
      }
      const stream = await mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      video.srcObject = stream;
      if (typeof video.play === 'function') await video.play();
      const canvas = doc.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      let stopped = false;
      return {
        read() {
          if (stopped || !video.videoWidth || !video.videoHeight) return null;
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          return context.getImageData(0, 0, canvas.width, canvas.height);
        },
        close() {
          if (stopped) return;
          stopped = true;
          for (const track of stream.getTracks?.() || []) track.stop();
          video.srcObject = null;
        },
      };
    },
  };
}

// 扫码会话：打开相机 → 逐帧解码 → 合法载荷回调后立刻关相机 → 交给调用方提交绑定。
// 相机拒绝/无设备/非法载荷/长时间扫不到码都给中文提示并回到手工粘贴；全程不输出二维码内容。
export function createScanSession({
  openCamera,
  decode = decodeQrImage,
  validate = parseBindPayload,
  onPayload = () => {},
  onError = () => {},
  frameIntervalMs = 120,
  maxFrames = 150,
} = {}) {
  let source = null;
  let timer = null;
  let frames = 0;
  let running = false;

  const stop = () => {
    running = false;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const current = source;
    source = null;
    if (current && typeof current.close === 'function') {
      try { current.close(); } catch { /* 关相机失败也要继续走兜底 */ }
    }
  };

  const tick = async () => {
    if (!running || !source) return;
    try {
      const frame = await source.read();
      if (frame) {
        const result = scanFrame(frame, { decode, validate });
        if (result) {
          stop(); // 扫到合法载荷后立刻关摄像头，绑定在相机之外完成
          try { await onPayload(result.text, result.token); }
          catch (error) { onError(error?.message || SCAN_MESSAGES.generic); }
          return;
        }
      }
    } catch (error) {
      const invalid = error instanceof MobileShellError && error.code === 'INVALID_BIND';
      onError(invalid ? SCAN_MESSAGES.invalidPayload : SCAN_MESSAGES.decodeFailed);
      stop();
      return;
    }
    frames++;
    if (frames >= maxFrames) { onError(SCAN_MESSAGES.noQr); stop(); return; }
    if (running) timer = setTimeout(() => void tick(), frameIntervalMs);
  };

  return {
    get active() { return running; },
    async start() {
      stop(); // 重开前先收掉上一次可能还开着的摄像头
      frames = 0;
      try {
        source = await openCamera();
      } catch (error) {
        onError(describeCameraError(error));
        stop();
        return false;
      }
      if (!source || typeof source.read !== 'function') {
        onError(SCAN_MESSAGES.cameraUnavailable);
        stop();
        return false;
      }
      running = true;
      await tick();
      return true;
    },
    stop,
  };
}
