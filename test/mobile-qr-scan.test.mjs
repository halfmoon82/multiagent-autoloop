// qr-scan-bind 节点边界测试：移动端「扫码绑定」的纯逻辑部分。
// 自带纯 JS 解码库把摄像头图像解成文本；scan.mjs 负责校验载荷、相机生命周期与兜底。
// 不调用真实模型、不碰真实设备；用 public/qr.mjs 的编码器生成真实 QR 图像作为输入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr } from '../public/qr.mjs';
import { MobileShellError } from '../mobile/app/www/shell.mjs';
import { decodeQrImage } from '../mobile/app/www/vendor/qr-decoder.mjs';
import {
  SCAN_MESSAGES, describeCameraError, scanFrame, createUserMediaCamera, createScanSession,
} from '../mobile/app/www/scan.mjs';

const token = seed => seed.repeat(64);
const payloadOf = seed => `autoloop://bind?token=${token(seed)}`;

// 用项目自己的 QR 编码器生成真实二维码图像（RGBA），带静区，模拟摄像头帧。
function renderQrImage(text, { scale = 6, quiet = 4 } = {}) {
  const { modules, size } = encodeQr(text);
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  data.fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const row = (y + quiet) * scale + dy;
          const col = (x + quiet) * scale + dx;
          const offset = (row * dim + col) * 4;
          data[offset] = 0; data[offset + 1] = 0; data[offset + 2] = 0; data[offset + 3] = 255;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

// ---------------------------------------------------------------------------
// RED 1：vendor 纯 JS 解码库——从真实 QR 图像读回载荷，不依赖 BarcodeDetector
// ---------------------------------------------------------------------------
test('vendor QR 解码器：从真实 QR 图像读回一次性绑定载荷', () => {
  const payload = payloadOf('a');
  const image = renderQrImage(payload);
  assert.equal(decodeQrImage(image.data, image.width, image.height), payload);
});

test('vendor QR 解码器：二维码不在画面中心也能定位解码', () => {
  const payload = payloadOf('b');
  const qr = renderQrImage(payload, { scale: 5, quiet: 4 });
  const width = qr.width + 80;
  const height = qr.height + 60;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (let y = 0; y < qr.height; y++) {
    for (let x = 0; x < qr.width; x++) {
      const from = (y * qr.width + x) * 4;
      const to = ((y + 23) * width + (x + 37)) * 4;
      data[to] = qr.data[from]; data[to + 1] = qr.data[from + 1];
      data[to + 2] = qr.data[from + 2]; data[to + 3] = qr.data[from + 3];
    }
  }
  assert.equal(decodeQrImage(data, width, height), payload);
});

test('vendor QR 解码器：没有二维码的画面返回 null，不抛异常', () => {
  const width = 200; const height = 200;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  assert.equal(decodeQrImage(data, width, height), null);
});

// ---------------------------------------------------------------------------
// RED 2：scanFrame——合法载荷解码并校验；非 NoMoTo 载荷走兜底且不泄漏原文
// ---------------------------------------------------------------------------
test('scanFrame：合法载荷被解码并校验出 token', () => {
  const payload = payloadOf('c');
  const image = renderQrImage(payload);
  assert.deepEqual(scanFrame(image), { text: payload, token: token('c') });
});

test('scanFrame：非 NoMoTo 载荷抛 INVALID_BIND，提示不含二维码原文', () => {
  const image = renderQrImage('https://evil.example.com/steal?token=123');
  assert.throws(() => scanFrame(image), error => (
    error instanceof MobileShellError
    && error.code === 'INVALID_BIND'
    && !error.message.includes('evil.example.com')
    && !error.message.includes('steal')
  ));
});

test('scanFrame：空帧返回 null，等下一帧', () => {
  assert.equal(scanFrame(null), null);
  assert.equal(scanFrame({ data: new Uint8ClampedArray(0), width: 0, height: 0 }), null);
});

// ---------------------------------------------------------------------------
// RED 3：相机错误映射成可读中文提示
// ---------------------------------------------------------------------------
test('describeCameraError：权限拒绝与无摄像头分别给出可读中文提示', () => {
  const denied = new Error('Permission denied'); denied.name = 'NotAllowedError';
  assert.match(describeCameraError(denied), /权限|相机/);
  const missing = new Error('Requested device not found'); missing.name = 'NotFoundError';
  assert.match(describeCameraError(missing), /摄像头/);
  assert.equal(describeCameraError(new Error('boom')), SCAN_MESSAGES.generic);
});

// ---------------------------------------------------------------------------
// RED 4：createScanSession——成功即回调并关闭摄像头；失败走兜底
// ---------------------------------------------------------------------------
function fakeSession(extra = {}) {
  const state = { closes: 0, frames: 0, payloads: [], errors: [] };
  const session = createScanSession({
    openCamera: async () => ({
      read: () => { state.frames++; return extra.frame ?? null; },
      close: () => { state.closes++; },
    }),
    onPayload: (text, tok) => state.payloads.push({ text, token: tok }),
    onError: message => state.errors.push(message),
    frameIntervalMs: 0,
    maxFrames: 3,
    ...extra.options,
  });
  return { session, state };
}

test('createScanSession：合法帧触发 onPayload 并关闭摄像头流', async () => {
  const payload = payloadOf('d');
  const { session, state } = fakeSession({ frame: renderQrImage(payload) });
  assert.equal(await session.start(), true);
  assert.deepEqual(state.payloads, [{ text: payload, token: token('d') }]);
  assert.equal(state.closes, 1, '扫码完成必须关闭摄像头');
  assert.equal(session.active, false);
});

test('createScanSession：非 NoMoTo 载荷走兜底提示并关闭摄像头', async () => {
  const { session, state } = fakeSession({ frame: renderQrImage('not-a-nomoto-code') });
  await session.start();
  assert.equal(state.payloads.length, 0);
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0], /不是有效|绑定码/);
  assert.equal(state.closes, 1);
});

test('createScanSession：相机权限被拒走兜底，不触发绑定', async () => {
  const denied = new Error('Permission denied'); denied.name = 'NotAllowedError';
  const errors = []; const payloads = [];
  const session = createScanSession({
    openCamera: async () => { throw denied; },
    onPayload: (text, tok) => payloads.push({ text, token: tok }),
    onError: message => errors.push(message),
    frameIntervalMs: 0,
  });
  assert.equal(await session.start(), false);
  assert.equal(payloads.length, 0);
  assert.match(errors[0], /权限|相机/);
});

test('createScanSession：无摄像头设备走兜底提示', async () => {
  const missing = new Error('Requested device not found'); missing.name = 'NotFoundError';
  const errors = [];
  const session = createScanSession({
    openCamera: async () => { throw missing; },
    onError: message => errors.push(message),
    frameIntervalMs: 0,
  });
  await session.start();
  assert.match(errors[0], /摄像头/);
});

test('createScanSession：stop 幂等，重复 stop 只关一次摄像头', async () => {
  const payload = payloadOf('e');
  const { session, state } = fakeSession({ frame: renderQrImage(payload) });
  session.stop(); // 未启动时 stop 不应抛错
  await session.start();
  session.stop();
  assert.equal(state.closes, 1);
});

// ---------------------------------------------------------------------------
// RED 5：生产相机桥——getUserMedia 后置约束与关闭时 track.stop
// ---------------------------------------------------------------------------
test('createUserMediaCamera：请求后置摄像头，关闭时每条 track.stop 都被调用', async () => {
  const stopped = [];
  const stream = {
    getTracks: () => [
      { stop: () => stopped.push('video') },
      { stop: () => stopped.push('audio') },
    ],
  };
  let constraints = null;
  const mediaDevices = { getUserMedia: async value => { constraints = value; return stream; } };
  const video = { videoWidth: 120, videoHeight: 120, srcObject: null, play: async () => {} };
  const doc = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(120 * 120 * 4), width: 120, height: 120 }) }),
    }),
  };
  const source = await createUserMediaCamera({ video, mediaDevices, doc }).open();
  assert.equal(constraints.video.facingMode.ideal, 'environment', '必须优先调用后置摄像头');
  assert.equal(constraints.audio, false);
  assert.equal(video.srcObject, stream);
  assert.ok(source.read());
  source.close();
  assert.deepEqual(stopped, ['video', 'audio'], '关闭时每条轨道都要 stop');
  assert.equal(video.srcObject, null);
});
