// 纯 JS 二维码图像解码器（自带，无需 BarcodeDetector）。
// 适配旧版鸿蒙 WebView：只吃 RGBA 像素，输出到文本；不碰 DOM、不碰网络、不碰存储。
// 解码范围与控制台 public/qr.mjs 的编码器对称：版本 1-5 / 纠错级别 L / 单块 / 字节模式。
// 图像侧只假设二维码大致正向（-scanning a screen），用三个定位角求模块网格；
// 数据侧直接读数据码字（单块时数据码字在最前），因此对清晰图像无需纠错即可还原载荷。
// 许可证见同目录 LICENSE（MIT）。

const MAX_VERSION = 5;
const ECL_L_PER_BLOCK = [-1, 7, 10, 15, 20, 26];

export function decodeQrImage(data, width, height) {
  try {
    return decode(data, width, height);
  } catch {
    return null; // 没有二维码 / 图像无效一律返回 null，由上层决定提示文案
  }
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
  return Math.floor(numRawDataModules(ver) / 8) - ECL_L_PER_BLOCK[ver];
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

function buildFunctionMap(size, ver) {
  const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) isFunc[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i); set(i, 6); }
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
  for (let i = 0; i <= 8; i++) { set(8, i); set(i, 8); }
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8);
  for (let i = 8; i < 15; i++) set(8, size - 15 + i);
  set(8, size - 8);
  return isFunc;
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
    default: return false;
  }
}

// RGBA -> 二值（1=深色）。用 Otsu 取阈值，兼容真实相机的灰度过渡。
function binarize(data, width, height) {
  const count = width * height;
  if (!data || data.length < count * 4) throw new Error('图像数据不足');
  const lum = new Uint8Array(count);
  const hist = new Uint32Array(256);
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const value = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >>> 8;
    lum[i] = value;
    hist[value]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let weightBackground = 0; let sumBackground = 0; let best = -1; let threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightBackground += hist[t];
    if (weightBackground === 0) continue;
    const weightForeground = count - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += t * hist[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  const bits = new Uint8Array(count);
  for (let i = 0; i < count; i++) bits[i] = lum[i] <= threshold ? 1 : 0;
  return bits;
}

// 沿一行/一列找 1:1:3:1:1 的定位角扫描线，返回中心坐标与估算模块宽。
function scanLine(getBit, length) {
  const hits = [];
  let p = 0;
  while (p < length) {
    const first = getBit(p);
    let end = p;
    while (end < length && getBit(end) === first) end++;
    const runs = [end - p];
    const colors = [first];
    let cursor = end;
    let alternates = true;
    for (let k = 0; k < 4; k++) {
      if (cursor >= length) { alternates = false; break; }
      const color = getBit(cursor);
      if (color === colors[colors.length - 1]) { alternates = false; break; }
      let next = cursor;
      while (next < length && getBit(next) === color) next++;
      runs.push(next - cursor);
      colors.push(color);
      cursor = next;
    }
    if (alternates && first === 1 && colors.join(',') === '1,0,1,0,1') {
      const [d1, l1, d2, l2, d3] = runs;
      const unit = Math.min(d1, l1, l2, d3);
      const near = (a, target) => Math.abs(a - target) <= Math.max(2, unit * 0.6);
      if (unit >= 2 && near(d1, unit) && near(l1, unit) && near(d3, unit) && near(l2, unit) && near(d2, unit * 3)) {
        const span = d1 + l1 + d2 + l2 + d3;
        hits.push({ center: p + span / 2, module: span / 7 });
      }
    }
    p = end;
  }
  return hits;
}

function findFinderCenters(bits, width, height) {
  const rowHits = [];
  for (let y = 0; y < height; y++) {
    for (const hit of scanLine(x => bits[y * width + x], width)) rowHits.push({ ...hit, y });
  }
  const colHits = [];
  for (let x = 0; x < width; x++) {
    for (const hit of scanLine(y => bits[y * width + x], height)) colHits.push({ ...hit, x });
  }
  if (rowHits.length < 3 || colHits.length < 3) return null;

  const points = [];
  for (const row of rowHits) {
    for (const col of colHits) {
      if (Math.abs(row.center - col.x) <= 8 && Math.abs(col.center - row.y) <= 8) {
        points.push({
          x: (row.center + col.x) / 2,
          y: (col.center + row.y) / 2,
          module: (row.module + col.module) / 2,
        });
      }
    }
  }
  const clusters = [];
  for (const point of points) {
    const cluster = clusters.find(item => Math.hypot(item.x / item.count - point.x, item.y / item.count - point.y) <= 16);
    if (cluster) {
      cluster.x += point.x; cluster.y += point.y; cluster.module += point.module; cluster.count++;
    } else {
      clusters.push({ x: point.x, y: point.y, module: point.module, count: 1 });
    }
  }
  const best = clusters.filter(item => item.count >= 2).sort((a, b) => b.count - a.count).slice(0, 3);
  if (best.length < 3) return null;
  return best.map(item => ({ x: item.x / item.count, y: item.y / item.count, module: item.module / item.count }));
}

function cornersOf(centers) {
  let farthest = -1; let pair = null;
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const distance = Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y);
      if (distance > farthest) { farthest = distance; pair = [i, j]; }
    }
  }
  const leftover = [0, 1, 2].find(index => index !== pair[0] && index !== pair[1]);
  const a = centers[pair[0]]; const b = centers[pair[1]];
  return {
    topLeft: centers[leftover],
    topRight: a.y <= b.y ? a : b,
    bottomLeft: a.y <= b.y ? b : a,
  };
}

function readModules(bits, width, height, corners) {
  const { topLeft, topRight, bottomLeft } = corners;
  const roughModule = (topLeft.module + topRight.module + bottomLeft.module) / 3;
  const horizontal = Math.hypot(topLeft.x - topRight.x, topLeft.y - topRight.y);
  const vertical = Math.hypot(topLeft.x - bottomLeft.x, topLeft.y - bottomLeft.y);
  const version = Math.round(((horizontal / roughModule - 10) + (vertical / roughModule - 10)) / 8);
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) return null;
  const size = version * 4 + 17;
  const module = (horizontal + vertical) / (2 * (size - 7));
  if (!Number.isFinite(module) || module < 1) return null;
  const originX = topLeft.x - 3 * module;
  const originY = topLeft.y - 3 * module;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = Math.round(originX + x * module);
      const py = Math.round(originY + y * module);
      if (px < 0 || py < 0 || px >= width || py >= height) return null;
      modules[y][x] = bits[py * width + px] === 1;
    }
  }
  return { modules, size, version };
}

function readPayload(modules, size, version) {
  const cell = (x, y) => (modules[y][x] ? 1 : 0);
  const formatBit = index => {
    if (index <= 5) return cell(8, index);
    if (index === 6) return cell(8, 7);
    if (index === 7) return cell(8, 8);
    if (index === 8) return cell(7, 8);
    return cell(14 - index, 8);
  };
  let format = 0;
  for (let index = 0; index < 15; index++) format |= formatBit(index) << index;
  format ^= 0x5412;
  const mask = ((format >>> 10) & 0x1F) & 7;
  if (mask > 7) return null;

  const isFunc = buildFunctionMap(size, version);
  const totalCodewords = Math.floor(numRawDataModules(version) / 8);
  const all = new Uint8Array(totalCodewords);
  let index = 0;
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
        if (index < totalCodewords * 8) {
          if (dark) all[index >>> 3] |= 1 << (7 - (index & 7));
          index++;
        }
      }
    }
  }

  const bits = [];
  for (let byte = 0; byte < numDataCodewords(version); byte++) {
    for (let shift = 7; shift >= 0; shift--) bits.push((all[byte] >>> shift) & 1);
  }
  let cursor = 0;
  const read = length => {
    let value = 0;
    for (let k = 0; k < length; k++) value = (value << 1) | bits[cursor++];
    return value;
  };
  if (read(4) !== 0b0100) return null; // 仅字节模式
  const length = read(8);
  if (length <= 0 || 8 * length > bits.length - cursor) return null;
  const bytes = new Uint8Array(length);
  for (let k = 0; k < length; k++) bytes[k] = read(8);
  return new TextDecoder().decode(bytes);
}

function decode(data, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 21 || height < 21) return null;
  const bits = binarize(data, width, height);
  const centers = findFinderCenters(bits, width, height);
  if (!centers) return null;
  const grid = readModules(bits, width, height, cornersOf(centers));
  if (!grid) return null;
  return readPayload(grid.modules, grid.size, grid.version);
}
