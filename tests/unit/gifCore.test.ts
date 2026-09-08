import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeGifFrames } from '../../src/export/gifCore';
import { QUALITY_ORDER, QUALITY_PROFILES } from '../../src/export/quality';

const W = 160;
const H = 120;

/** A moving red square over a smooth blue/green gradient. */
function makeFrames(count: number, delayMs = 100) {
  const frames = [];
  for (let f = 0; f < count; f++) {
    const rgba = new Uint8ClampedArray(W * H * 4);
    const sx = Math.round((f / count) * (W - 40));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const inSquare = x >= sx && x < sx + 40 && y >= 40 && y < 80;
        rgba[i] = inSquare ? 220 : Math.round((x / W) * 255);
        rgba[i + 1] = inSquare ? 30 : Math.round((y / H) * 200);
        rgba[i + 2] = inSquare ? 30 : 180;
        rgba[i + 3] = 255;
      }
    }
    frames.push({ rgba, delayMs });
  }
  return frames;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('GIF encoding', () => {
  it('writes a structurally valid GIF89a with the requested dimensions', () => {
    const bytes = encodeGifFrames(makeFrames(6), W, H, QUALITY_PROFILES.medium);
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('GIF89a');
    expect(readUint16LE(bytes, 6)).toBe(W);
    expect(readUint16LE(bytes, 8)).toBe(H);
    // Trailer byte.
    expect(bytes[bytes.length - 1]).toBe(0x3b);
  });

  it('refuses to encode zero frames', () => {
    expect(() => encodeGifFrames([], W, H, QUALITY_PROFILES.high)).toThrow(/no frames/i);
  });

  it('rejects frames whose size does not match the canvas', () => {
    const bad = [{ rgba: new Uint8ClampedArray(16), delayMs: 100 }];
    expect(() => encodeGifFrames(bad, W, H, QUALITY_PROFILES.high)).toThrow(/size mismatch/i);
  });

  it('produces monotonically larger files as quality increases', () => {
    const frames = makeFrames(10);
    const sizes = QUALITY_ORDER.map((q) => encodeGifFrames(frames, W, H, QUALITY_PROFILES[q]).length);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
    // The spread should be meaningful, not a rounding difference.
    expect(sizes[3] / sizes[0]).toBeGreaterThan(1.5);
  });

  it.skipIf(!hasFfmpeg())('decodes back to the right frame count and pixels', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gifmaker-'));
    try {
      for (const quality of QUALITY_ORDER) {
        const frames = makeFrames(8, 100);
        const bytes = encodeGifFrames(frames, W, H, QUALITY_PROFILES[quality]);
        const file = join(dir, `${quality}.gif`);
        writeFileSync(file, bytes);

        const probe = execFileSync(
          'ffprobe',
          ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
           '-show_entries', 'stream=nb_read_frames,width,height',
           '-of', 'default=nw=1:nk=1', file],
          { encoding: 'utf8' },
        ).trim().split('\n').map((s) => s.trim());

        expect(Number(probe[0])).toBe(W);
        expect(Number(probe[1])).toBe(H);
        expect(Number(probe[2])).toBe(8);

        // Decode the final frame to raw RGB and check the red square landed
        // where the source put it. This proves the delta/transparency
        // optimisation reconstructs correctly rather than just "looking fine".
        const rawPath = join(dir, `${quality}.raw`);
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vf', 'select=eq(n\\,7)',
          '-vframes', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', rawPath]);
        const raw = readFileSync(rawPath);
        const sx = Math.round((7 / 8) * (W - 40));
        const px = (y: number, x: number) => {
          const i = (y * W + x) * 3;
          return [raw[i], raw[i + 1], raw[i + 2]];
        };
        const [r, g, b] = px(60, sx + 20);
        expect(r).toBeGreaterThan(150);
        expect(g).toBeLessThan(110);
        expect(b).toBeLessThan(110);
        // Somewhere the square is not: should still be the blue-ish gradient.
        const [r2, , b2] = px(10, 10);
        expect(b2).toBeGreaterThan(120);
        expect(r2).toBeLessThan(120);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
