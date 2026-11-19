// 一次性绑定二维码：纯前端 QR Code 编码器（字节模式）。
// 实现真实 QR 符号（定位角、纠错码、掩码与格式信息），手机可扫码；不引入第三方依赖。
// 本项目载荷固定为 autoloop://bind?token=<hex>，选用版本 1-5 / 纠错级别 L（单块），
// 解码辅助函数 decodeQr 仅用于回归测试，按同样的单块规则读回载荷。

// 纠错级别 L：格式位、每块纠错码字数、分块数（索引 = 版本，0 不用）。
const ECL_L = {
  formatBits: 1,
  perBlock: [-1, 7, 10, 15, 20, 26],
  blocks: [-1, 1, 1, 1, 1, 1],
};
const MAX_VERSION = 5; // 版本 1-5 的 L 级均为单块；载荷超过容量即报错，不静默降级。

// GF(256) 乘法，本原多项式 0x11D。
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xFF;
}

// Reed-Solomon 生成多项式系数。
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

// 计算数据码字的纠错码字。
function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
  }
  return result;
}

function numDataCodewords(ver) {
  return Math.floor(numRawDataModules(ver) / 8) - ECL_L.perBlock[ver] * ECL_L.blocks[ver];
}

function byteLength(text) {
  // 浏览器 TextEncoder 与 Node 24 全局可用。
  return new TextEncoder().encode(text).length;
}

function chooseVersion(textBytes) {
  for (let ver = 1; ver <= MAX_VERSION; ver++) {
    // 版本 1-9 字节模式字符计数占 8 位；模式 4 位。
    if (4 + 8 + 8 * textBytes <= numDataCodewords(ver) * 8) return ver;
  }
  throw new Error('绑定二维码载荷过长，无法编码');
}

function makeDataCodewords(textBytes, ver) {
  const bits = [];
  const append = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4); // 字节模式
  append(textBytes.length, 8);
  for (const byte of textBytes) append(byte, 8);
  const capacityBits = numDataCodewords(ver) * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0); // 终止符
  while (bits.length % 8 !== 0) bits.push(0); // 补齐到字节
  let pad = 0;
  while (bits.length < capacityBits) {
    append(pad % 2 === 0 ? 0xEC : 0x11, 8);
    pad++;
  }
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out[i / 8] = byte;
  }
  return out;
}

function alignmentPositions(size, ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
  const result = new Array(numAlign);
  result[0] = 6;
  for (let i = numAlign - 1, pos = size - 7; i >= 1; i--, pos -= step) result[i] = pos;
  return result;
}

// 构造功能图（true = 功能图形，不可放数据位）：定位角、分隔、定时、对齐、格式信息区。
function buildFunctionMap(size, ver) {
  const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) isFunc[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i); set(i, 6); } // 定时图形

  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) set(cx + dx, cy + dy);
  }

  const align = alignmentPositions(size, ver);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy);
    }
  }

  // 格式信息两处保留区 + 固定黑点。
  for (let i = 0; i <= 8; i++) { set(8, i); set(i, 8); }
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8);
  for (let i = 8; i < 15; i++) set(8, size - 15 + i);
  set(8, size - 8);
  return isFunc;
}

function formatBits(mask) {
  const data = (ECL_L.formatBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function getBit(value, i) { return ((value >>> i) & 1) !== 0; }

function drawFormat(modules, size, mask) {
  const bits = formatBits(mask);
  for (let i = 0; i <= 5; i++) modules[i][8] = getBit(bits, i);
  modules[7][8] = getBit(bits, 6);
  modules[8][8] = getBit(bits, 7);
  modules[8][7] = getBit(bits, 8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = getBit(bits, i);
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = getBit(bits, i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = getBit(bits, i);
  modules[size - 8][8] = true;
}

function drawFunctionPatterns(modules, size, ver, mask) {
  // 定时图形
  for (let i = 0; i < size; i++) {
    modules[i][6] = i % 2 === 0;
    modules[6][i] = i % 2 === 0;
  }
  // 定位角：中心 3×3 与外环为黑，中间白环，外圈分隔白。
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        modules[y][x] = dist !== 2 && dist !== 4;
      }
    }
  }
  // 对齐图形：外环与中心黑，中间白环。
  const align = alignmentPositions(size, ver);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          modules[align[j] + dy][align[i] + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
        }
      }
    }
  }
  // 预留格式信息区后绘制（哪些格子是功能图形由 buildFunctionMap 给出）。
  drawFormat(modules, size, mask);
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error('未知掩码');
  }
}

// 掩码 0：简单、规范允许、可被任意扫码器识别。格式信息写入实际使用的掩码号。
const MASK = 0;

/**
 * 把文本编码成真实 QR 矩阵。
 * @returns {{modules: boolean[][], size: number, version: number, payload: string}}
 */
export function encodeQr(text) {
  const payload = String(text);
  const bytes = new TextEncoder().encode(payload);
  const ver = chooseVersion(bytes.length);
  const size = ver * 4 + 17;
  const data = makeDataCodewords(Array.from(bytes), ver);
  const ecc = rsRemainder(data, rsDivisor(ECL_L.perBlock[ver] * ECL_L.blocks[ver]));
  const all = new Uint8Array(data.length + ecc.length);
  all.set(data, 0);
  all.set(ecc, data.length);

  const isFunc = buildFunctionMap(size, ver);
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  drawFunctionPatterns(modules, size, ver, MASK);

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunc[y][x] && i < all.length * 8) {
          modules[y][x] = getBit(all[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunc[y][x] && maskBit(MASK, x, y)) modules[y][x] = !modules[y][x];
    }
  }

  return { modules, size, version: ver, payload };
}

/**
 * 从 QR 矩阵读回载荷（与 encodeQr 对称，供回归测试校验 DOM 渲染结果）。
 */
export function decodeQr(modules) {
  const size = modules.length;
  if (!modules.every(row => row.length === size)) throw new Error('二维码矩阵不是方阵');
  const ver = (size - 17) / 4;
  if (!Number.isInteger(ver) || ver < 1 || ver > MAX_VERSION) throw new Error('不支持的二维码版本');

  // 从左上角格式信息副本读回掩码号。
  const cell = (x, y) => (modules[y][x] ? 1 : 0);
  const bit = index => {
    if (index <= 5) return cell(8, index);
    if (index === 6) return cell(8, 7);
    if (index === 7) return cell(8, 8);
    if (index === 8) return cell(7, 8);
    return cell(14 - index, 8);
  };
  let format = 0;
  for (let index = 0; index < 15; index++) format |= bit(index) << index;
  format ^= 0x5412;
  const mask = ((format >>> 10) & 0x1F) & 7;
  if (mask !== MASK) throw new Error('二维码掩码与编码器不一致');

  const isFunc = buildFunctionMap(size, ver);
  const totalCodewords = Math.floor(numRawDataModules(ver) / 8);
  const dataCodewords = numDataCodewords(ver);
  const all = new Uint8Array(totalCodewords);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunc[y][x]) continue;
        let dark = modules[y][x];
        if (maskBit(mask, x, y)) dark = !dark;
        if (i < totalCodewords * 8) {
          if (dark) all[i >>> 3] |= 1 << (7 - (i & 7));
          i++;
        }
      }
    }
  }

  // 单块：数据码字即前 dataCodewords 个字节。
  const bits = [];
  for (let k = 0; k < dataCodewords; k++) {
    for (let shift = 7; shift >= 0; shift--) bits.push((all[k] >>> shift) & 1);
  }
  let p = 0;
  const read = len => {
    let value = 0;
    for (let k = 0; k < len; k++) value = (value << 1) | bits[p++];
    return value;
  };
  if (read(4) !== 0b0100) throw new Error('二维码不是字节模式');
  const length = read(8);
  const out = new Uint8Array(length);
  for (let k = 0; k < length; k++) out[k] = read(8);
  return new TextDecoder().decode(out);
}
