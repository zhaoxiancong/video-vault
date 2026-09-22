#!/usr/bin/env node
'use strict';
/**
 * 生成启动快捷方式用的多尺寸 .ico —— 纯 Node，零依赖。
 *
 * 图案延续界面的品牌记号（顶栏那个琥珀色 ▼），做成"视频落进保险箱"：
 *   暖炭灰圆角底 + 琥珀色播放三角 + 收纳槽 + 蓝色进度条 + 顶部绿点。
 * 配色与 src/web/styles.css 的 CSS 变量一致，所以桌面图标与界面是一套。
 *
 * 为什么自己手写 PNG/ICO 而不是用 PowerShell + System.Drawing：
 *   那版脚本在 PS 5.1 下反复报 "does not contain a method named 'op_Addition'"
 *   （类型被意外转成数组，且报错位置指不到真正的原因）。手写格式虽然长，
 *   但**确定性**：同样的输入永远得到同样的字节，不依赖 .NET、不依赖 PS 版本。
 *   PNG 只是 zlib + CRC32，ICO 只是一个小目录 —— 都不难。
 *
 * 抗锯齿：3× 超采样后缩小（没有字体渲染需求，这样就够了）。
 *
 * 用法: node tools/make-icon.js
 * 输出: assets/video-vault.ico
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'video-vault.ico');

// ---------------------------------------------------------------- 画布

/**
 * 一个极小的 RGBA 画布（非预乘 alpha）。
 * 所有绘制都在"设计坐标"（256×256）里做，最后按目标尺寸缩放。
 */
function createCanvas(size) {
  const px = new Uint8ClampedArray(size * size * 4);
  return { size, px };
}

/** 把颜色混合到某个像素上（source-over） */
function blend(canvas, x, y, r, g, b, a) {
  if (a <= 0) return;
  const { width: w } = canvas; // 占位，下面用 size
  const s = canvas.size;
  if (x < 0 || y < 0 || x >= s || y >= s) return;
  const i = (y * s + x) * 4;
  const dst = canvas.px;
  const sa = a / 255;
  const da = dst[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) { dst[i + 3] = 0; return; }
  dst[i] = Math.round((r * sa + dst[i] * da * (1 - sa)) / outA);
  dst[i + 1] = Math.round((g * sa + dst[i + 1] * da * (1 - sa)) / outA);
  dst[i + 2] = Math.round((b * sa + dst[i + 2] * da * (1 - sa)) / outA);
  dst[i + 3] = Math.round(outA * 255);
}

/** 覆盖率 → 画一个圆角矩形 */
function fillRoundRect(canvas, x0, y0, w, h, radius, color) {
  const [r, g, b, a = 255] = color;
  const x1 = x0 + w;
  const y1 = y0 + h;
  const rad = Math.min(radius, w / 2, h / 2);
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      // 到圆角矩形的最短距离（内部为负）
      const dx = Math.max(x0 + rad - x, 0, x - (x1 - rad));
      const dy = Math.max(y0 + rad - y, 0, y - (y1 - rad));
      const dist = Math.hypot(dx, dy) - rad;
      const cov = Math.max(0, Math.min(1, 0.5 - dist));   // 1px 软边
      if (cov > 0) blend(canvas, x, y, r, g, b, a * cov);
    }
  }
}

/** 填一个三角形（带 1px 软边），颜色支持上下渐变 */
function fillTriangle(canvas, p1, p2, p3, colorTop, colorBottom) {
  const minX = Math.floor(Math.min(p1[0], p2[0], p3[0]));
  const maxX = Math.ceil(Math.max(p1[0], p2[0], p3[0]));
  const minY = Math.floor(Math.min(p1[1], p2[1], p3[1]));
  const maxY = Math.ceil(Math.max(p1[1], p2[1], p3[1]));

  // 重心法判内部；对每条边采样判覆盖率（够用的软边）
  const area = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const total = area(p1, p2, p3);
  if (Math.abs(total) < 1e-6) return;

  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const p = [x + 0.5, y + 0.5];
      const w1 = area(p2, p3, p) / total;
      const w2 = area(p3, p1, p) / total;
      const w3 = 1 - w1 - w2;
      const inside = w1 >= 0 && w2 >= 0 && w3 >= 0;
      if (!inside) continue;
      const t = Math.max(0, Math.min(1, (p[1] - minY) / Math.max(1, maxY - minY)));
      const r = Math.round(colorTop[0] + (colorBottom[0] - colorTop[0]) * t);
      const g = Math.round(colorTop[1] + (colorBottom[1] - colorTop[1]) * t);
      const b = Math.round(colorTop[2] + (colorBottom[2] - colorTop[2]) * t);
      blend(canvas, x, y, r, g, b, 255);
    }
  }
}

/** 缩小画布（盒式平均，够用且无依赖） */
function downscale(src, targetSize) {
  const out = createCanvas(targetSize);
  const ratio = src.size / targetSize;
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const sx0 = Math.floor(x * ratio), sx1 = Math.floor((x + 1) * ratio);
      const sy0 = Math.floor(y * ratio), sy1 = Math.floor((y + 1) * ratio);
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * src.size + sx) * 4;
          // 按 alpha 加权，避免边缘变暗
          const pa = src.px[i + 3] / 255;
          r += src.px[i] * pa; g += src.px[i + 1] * pa; b += src.px[i + 2] * pa;
          a += src.px[i + 3];
          n++;
        }
      }
      if (!n) continue;
      const outA = a / n;
      const wsum = a / 255 || 1;
      const o = (y * targetSize + x) * 4;
      out.px[o] = Math.round(r / wsum);
      out.px[o + 1] = Math.round(g / wsum);
      out.px[o + 2] = Math.round(b / wsum);
      out.px[o + 3] = Math.round(outA);
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA 画布 → PNG 字节 */
function toPng(canvas) {
  const { size, px } = canvas;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;                                  // 过滤器：None
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      raw[p++] = px[i]; raw[p++] = px[i + 1]; raw[p++] = px[i + 2]; raw[p++] = px[i + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 图案

const COLOR = {
  bg: [20, 23, 28],
  panel: [31, 36, 43],
  line: [62, 70, 82],
  amber: [240, 160, 42],
  amberDim: [196, 127, 28],
  blue: [88, 166, 255],
  green: [63, 185, 80],
};

/**
 * 在 256×256 的"设计画布"上画图案。
 * @param {boolean} simple 小尺寸用简化画法（细节在 16px 下只会糊成一团）
 */
function drawDesign(simple) {
  const S = 256;
  const c = createCanvas(S);

  // 圆角底
  fillRoundRect(c, 6, 6, S - 12, S - 12, 34, COLOR.bg);
  if (!simple) {
    // 细边：往里再画一圈稍亮的
    fillRoundRect(c, 6, 6, S - 12, S - 12, 34, COLOR.line);
    fillRoundRect(c, 8.5, 8.5, S - 17, S - 17, 31.5, COLOR.bg);
  }

  // 琥珀色播放三角（品牌记号 ▼）
  const triTop = simple ? 40 : 34;
  const triW = simple ? 150 : 140;
  const triH = simple ? 96 : 88;
  const triX = (S - triW) / 2;
  fillTriangle(c,
    [triX, triTop], [triX + triW, triTop], [triX + triW / 2, triTop + triH],
    COLOR.amber, COLOR.amberDim);

  if (!simple) {
    // 金库门环 = "存进保险箱"。
    // 一开始这里是两条横杠（收纳槽 + 进度条），但看图发现那读起来像**两个进度条**，
    // 跟"落进保险箱"的意图对不上。改成门环 + 把手之后叙事就清楚了：
    // 视频（▼）落进库门（◎）。
    const cx = S / 2;
    const cy = 186;
    const outerR = 40;
    const ringW = 13;
    // 外环（琥珀）+ 内圈（深色）→ 挖出圆环
    fillRoundRect(c, cx - outerR, cy - outerR, outerR * 2, outerR * 2, outerR, COLOR.amber);
    fillRoundRect(c, cx - outerR + ringW, cy - outerR + ringW,
      (outerR - ringW) * 2, (outerR - ringW) * 2, outerR - ringW, COLOR.bg);
    // 把手：竖杆 + 上下的小圆头
    fillRoundRect(c, cx - 4, cy - 16, 8, 32, 4, COLOR.amberDim);
    fillRoundRect(c, cx - 9, cy - 20, 18, 9, 4.5, COLOR.amber);
    fillRoundRect(c, cx - 9, cy + 11, 18, 9, 4.5, COLOR.amber);
  }
  return c;
}

// ---------------------------------------------------------------- ICO

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const master = drawDesign(false);
const masterSimple = drawDesign(true);

const images = SIZES.map((size) => {
  // 大尺寸直接从 256 缩；16/24 用简化画法，否则细节糊成一团
  const source = size <= 24 ? masterSimple : master;
  return { size, png: toPng(downscale(source, size)) };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);              // reserved
header.writeUInt16LE(1, 2);              // type: icon
header.writeUInt16LE(images.length, 4);

let offset = 6 + 16 * images.length;
const entries = [];
for (const img of images) {
  const e = Buffer.alloc(16);
  e[0] = img.size >= 256 ? 0 : img.size;  // 256 记作 0
  e[1] = img.size >= 256 ? 0 : img.size;
  e[2] = 0;                                // 调色板数
  e[3] = 0;                                // reserved
  e.writeUInt16LE(1, 4);                   // color planes
  e.writeUInt16LE(32, 6);                  // bits per pixel
  e.writeUInt32LE(img.png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += img.png.length;
  entries.push(e);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, ...entries, ...images.map((i) => i.png)]));

// 顺手导出两个"看得见"的 PNG：.ico 没法直接预览，改图标时靠它们肉眼对照
// （256 看整体设计，48 看小尺寸下还认不认得出）。它们进仓库 —— 是资产，不是垃圾。
fs.writeFileSync(path.join(path.dirname(OUT), 'video-vault-256.png'), images[images.length - 1].png);
fs.writeFileSync(path.join(path.dirname(OUT), 'video-vault-48.png'), images[3].png);

const st = fs.statSync(OUT);
console.log(`  已生成 ${path.relative(ROOT, OUT)}`);
console.log(`  尺寸 ${SIZES.join(' / ')}  ·  ${(st.size / 1024).toFixed(1)} KB`);
console.log(`  另导出 assets/video-vault-256.png 与 -48.png 供肉眼检查`);
