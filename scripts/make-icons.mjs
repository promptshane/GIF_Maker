/**
 * Generates the PWA / Apple touch icons as real PNG files with zero dependencies.
 *
 * We rasterise a simple mark (rounded square, vertical gradient, play triangle and
 * three "frame" ticks) with 4x supersampling and write the result using a minimal
 * PNG encoder built on Node's zlib. This keeps the repo free of an image toolchain
 * while still shipping genuine, non-placeholder icons.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ rasteriser

const SS = 4; // supersampling factor per axis

const lerp = (a, b, t) => a + (b - a) * t;

/** Signed-ish inside test for an axis-aligned rounded rectangle. */
function insideRoundRect(x, y, rx0, ry0, rx1, ry1, r) {
  if (x < rx0 || x > rx1 || y < ry0 || y > ry1) return false;
  const cx = Math.min(Math.max(x, rx0 + r), rx1 - r);
  const cy = Math.min(Math.max(y, ry0 + r), ry1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * @param size    output pixel size (square)
 * @param inset   fraction of the canvas kept clear around the mark (maskable safe zone)
 * @param rounded whether the plate has rounded corners (false = full bleed for maskable)
 */
function drawIcon(size, { inset = 0, rounded = true } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  const pad = size * inset;
  const x0 = pad;
  const y0 = pad;
  const x1 = size - pad;
  const y1 = size - pad;
  const plate = x1 - x0;
  const radius = rounded ? plate * 0.225 : 0;

  // Play triangle, centred on the plate.
  const tw = plate * 0.30;
  const th = plate * 0.34;
  const cxp = x0 + plate * 0.52;
  const cyp = y0 + plate * 0.46;
  const ax = cxp - tw / 2, ay = cyp - th / 2;
  const bx = cxp - tw / 2, by = cyp + th / 2;
  const tx = cxp + tw / 2, ty = cyp;

  // Three "frame" ticks below the triangle, evoking a filmstrip / frame sequence.
  const tickW = plate * 0.115;
  const tickH = plate * 0.052;
  const tickY = y0 + plate * 0.735;
  const tickGap = plate * 0.045;
  const ticksTotal = tickW * 3 + tickGap * 2;
  const tickX0 = x0 + (plate - ticksTotal) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!insideRoundRect(px, py, x0, y0, x1, y1, radius)) continue;

          // Diagonal gradient: violet -> magenta -> coral.
          const t = Math.min(1, Math.max(0, (px - x0 + (py - y0)) / (plate * 2)));
          let r, g, b;
          if (t < 0.5) {
            const u = t / 0.5;
            r = lerp(0x4c, 0x9b, u); g = lerp(0x3a, 0x3f, u); b = lerp(0xd6, 0xe0, u);
          } else {
            const u = (t - 0.5) / 0.5;
            r = lerp(0x9b, 0xff, u); g = lerp(0x3f, 0x5c, u); b = lerp(0xe0, 0x8a, u);
          }

          const inGlyph =
            insideTriangle(px, py, ax, ay, bx, by, tx, ty) ||
            [0, 1, 2].some((i) => {
              const gx = tickX0 + i * (tickW + tickGap);
              return insideRoundRect(px, py, gx, tickY, gx + tickW, tickY + tickH, tickH / 2);
            });
          if (inGlyph) { r = 255; g = 255; b = 255; }

          rAcc += r; gAcc += g; bAcc += b; aAcc += 255;
        }
      }
      const samples = SS * SS;
      const a = aAcc / samples;
      const i = (y * size + x) * 4;
      if (a > 0) {
        // Premultiplied average -> straight alpha.
        rgba[i] = Math.round(rAcc / (aAcc / 255));
        rgba[i + 1] = Math.round(gAcc / (aAcc / 255));
        rgba[i + 2] = Math.round(bAcc / (aAcc / 255));
        rgba[i + 3] = Math.round(a);
      }
    }
  }
  return rgba;
}

/** Flattens any transparency onto a solid colour (Apple touch icons must be opaque). */
function flatten(rgba, size, [br, bg, bb]) {
  for (let i = 0; i < size * size * 4; i += 4) {
    const a = rgba[i + 3] / 255;
    rgba[i] = Math.round(rgba[i] * a + br * (1 - a));
    rgba[i + 1] = Math.round(rgba[i + 1] * a + bg * (1 - a));
    rgba[i + 2] = Math.round(rgba[i + 2] * a + bb * (1 - a));
    rgba[i + 3] = 255;
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-192.png', 192, { inset: 0.02 }, null],
  ['icon-512.png', 512, { inset: 0.02 }, null],
  // Maskable icons are cropped to a circle/squircle by the platform, so the mark
  // sits inside a 80% safe zone on a full-bleed plate.
  ['icon-maskable-512.png', 512, { inset: 0.0, rounded: false }, null],
  // iOS renders apple-touch-icon on an opaque tile and applies its own mask.
  ['apple-touch-icon.png', 180, { inset: 0.0, rounded: false }, [12, 12, 18]],
  ['favicon-32.png', 32, { inset: 0.0 }, null],
];

for (const [name, size, opts, bg] of targets) {
  let rgba = drawIcon(size, opts);
  if (bg) rgba = flatten(rgba, size, bg);
  writeFileSync(join(OUT_DIR, name), encodePng(size, size, rgba));
  console.log('wrote', name, `${size}x${size}`);
}
