import { GIFEncoder, quantize } from 'gifenc';
import type { LookupFormat, QualityProfile } from './quality';

export type Palette = number[][];

/**
 * Colour-table sizes must be a power of two, and the value also becomes the LZW
 * minimum code size. Using the smallest legal size is a genuine compression win
 * for the low-colour presets.
 */
function colorTableBits(length: number): number {
  return Math.max(2, Math.ceil(Math.log2(Math.max(2, length))));
}

/**
 * gifenc's `quantize` builds a histogram at the given colour resolution and its
 * cost is dominated by the number of occupied bins: rgb565 (65536 bins) takes
 * well over a second for a single frame, while rgb444 (4096 bins) takes under
 * 100ms for the same input at the same palette size. Palette entries are still
 * full 8-bit averages either way, so we always histogram at rgb444 and spend the
 * extra precision on the lookup table instead.
 */
const HISTOGRAM_FORMAT = 'rgb444' as const;

const rgb444Key = (r: number, g: number, b: number): number =>
  ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);

const rgb565Key = (r: number, g: number, b: number): number =>
  ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * A fully precomputed nearest-palette-colour table.
 *
 * Because every frame shares one palette, this is built once per GIF and then
 * every pixel lookup — dithered or not — is a single array read. That is what
 * makes encoding fast enough to run on a phone.
 */
export class PaletteLut {
  readonly table: Uint8Array;
  readonly flat: Int32Array;
  readonly size: number;
  private readonly key: (r: number, g: number, b: number) => number;

  constructor(colors: Palette, format: LookupFormat) {
    this.size = colors.length;
    this.key = format === 'rgb444' ? rgb444Key : rgb565Key;
    this.flat = new Int32Array(colors.length * 3);
    for (let i = 0; i < colors.length; i++) {
      this.flat[i * 3] = colors[i][0];
      this.flat[i * 3 + 1] = colors[i][1];
      this.flat[i * 3 + 2] = colors[i][2];
    }

    const bits = format === 'rgb444' ? [4, 4, 4] : [5, 6, 5];
    const bins = 1 << (bits[0] + bits[1] + bits[2]);
    this.table = new Uint8Array(bins);
    const steps = bits.map((b) => 1 << b);
    // Reconstruct the centre of each bucket and find its nearest palette entry.
    for (let ri = 0; ri < steps[0]; ri++) {
      const r = Math.round((ri * 255) / (steps[0] - 1));
      for (let gi = 0; gi < steps[1]; gi++) {
        const g = Math.round((gi * 255) / (steps[1] - 1));
        for (let bi = 0; bi < steps[2]; bi++) {
          const b = Math.round((bi * 255) / (steps[2] - 1));
          const bin = (ri << (bits[1] + bits[2])) | (gi << bits[2]) | bi;
          this.table[bin] = this.nearestSlow(r, g, b);
        }
      }
    }
  }

  private nearestSlow(r: number, g: number, b: number): number {
    const flat = this.flat;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.size; i++) {
      const o = i * 3;
      const dr = flat[o] - r;
      let d = dr * dr;
      if (d >= bestDist) continue;
      const dg = flat[o + 1] - g;
      d += dg * dg;
      if (d >= bestDist) continue;
      const db = flat[o + 2] - b;
      d += db * db;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  nearest(r: number, g: number, b: number): number {
    return this.table[this.key(r, g, b)];
  }
}

/** Straight nearest-colour mapping, no dithering. */
export function applyPaletteFlat(
  rgba: Uint8ClampedArray | Uint8Array,
  lut: PaletteLut,
): Uint8Array {
  const count = rgba.length / 4;
  const index = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    index[i] = lut.nearest(rgba[p], rgba[p + 1], rgba[p + 2]);
  }
  return index;
}

/**
 * Floyd–Steinberg dithering with a serpentine scan. gifenc has no dithering of
 * its own, so this is the "dither" half of the quality presets: it trades file
 * size (noise compresses badly) for far smoother gradients at low colour counts.
 */
export function applyPaletteDithered(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  lut: PaletteLut,
  strength: number,
): Uint8Array {
  const index = new Uint8Array(width * height);
  const flat = lut.flat;
  const rowLen = width + 2;
  let curr = new Float32Array(rowLen * 3);
  let next = new Float32Array(rowLen * 3);

  for (let y = 0; y < height; y++) {
    const leftToRight = (y & 1) === 0;
    for (let step = 0; step < width; step++) {
      const x = leftToRight ? step : width - 1 - step;
      const e = (x + 1) * 3;
      const p = (y * width + x) * 4;

      const r = clamp255(rgba[p] + curr[e]);
      const g = clamp255(rgba[p + 1] + curr[e + 1]);
      const b = clamp255(rgba[p + 2] + curr[e + 2]);

      const pi = lut.nearest(r | 0, g | 0, b | 0);
      index[y * width + x] = pi;

      const o = pi * 3;
      const er = (r - flat[o]) * strength;
      const eg = (g - flat[o + 1]) * strength;
      const eb = (b - flat[o + 2]) * strength;

      const ahead = leftToRight ? e + 3 : e - 3;
      const behind = leftToRight ? e - 3 : e + 3;
      curr[ahead] += er * 0.4375;
      curr[ahead + 1] += eg * 0.4375;
      curr[ahead + 2] += eb * 0.4375;
      next[behind] += er * 0.1875;
      next[behind + 1] += eg * 0.1875;
      next[behind + 2] += eb * 0.1875;
      next[e] += er * 0.3125;
      next[e + 1] += eg * 0.3125;
      next[e + 2] += eb * 0.3125;
      next[ahead] += er * 0.0625;
      next[ahead + 1] += eg * 0.0625;
      next[ahead + 2] += eb * 0.0625;
    }
    const swap = curr;
    curr = next;
    next = swap;
    next.fill(0);
  }
  return index;
}

/**
 * Derives one palette for the whole animation from an even pixel subsample of
 * the supplied frames. One shared palette is both what ffmpeg's `palettegen`
 * does for GIF and what makes the inter-frame transparency optimisation
 * effective, since unchanged pixels then quantise to identical indices.
 */
export function buildPalette(
  frames: Array<Uint8ClampedArray | Uint8Array>,
  maxColors: number,
  targetSamples = 150_000,
): Palette {
  if (frames.length === 0) throw new Error('Cannot build a palette with no frames.');
  const totalPixels = frames.reduce((sum, f) => sum + f.length / 4, 0);
  if (totalPixels === 0) throw new Error('Cannot build a palette from empty frames.');

  const stride = Math.max(1, Math.floor(totalPixels / targetSamples));
  const sample = new Uint8ClampedArray(Math.ceil(totalPixels / stride) * 4);
  let out = 0;
  let offset = 0; // running position so the stride continues across frames
  for (const frame of frames) {
    const pixels = frame.length / 4;
    for (let i = (stride - (offset % stride)) % stride; i < pixels; i += stride) {
      const p = i * 4;
      const q = out * 4;
      if (q + 3 >= sample.length) break;
      sample[q] = frame[p];
      sample[q + 1] = frame[p + 1];
      sample[q + 2] = frame[p + 2];
      sample[q + 3] = 255;
      out++;
    }
    offset += pixels;
  }

  const used = out > 0 ? new Uint8ClampedArray(sample.buffer, 0, out * 4) : sample;
  const palette = quantize(used, Math.min(255, Math.max(2, maxColors)), {
    format: HISTOGRAM_FORMAT,
    oneBitAlpha: false,
    clearAlpha: false,
  }).map((c) => [c[0], c[1], c[2]]);

  // Never exceed 255 real colours: one table slot is reserved for transparency.
  return palette.slice(0, 255);
}

export interface GifSessionOptions {
  width: number;
  height: number;
  profile: QualityProfile;
  /**
   * Frames used to derive the shared palette. When omitted the session holds
   * back the first few frames it receives and derives the palette from those.
   */
  paletteSamples?: Array<Uint8ClampedArray | Uint8Array>;
  /** Only used to bound the fallback priming buffer. */
  totalFrames?: number;
}

/**
 * Streaming GIF writer.
 *
 * Frames are pushed in one at a time and released immediately, so peak memory
 * stays at a few frames rather than the whole animation. Pixels that match what
 * is already on screen are written as the transparent index with disposal
 * "leave in place" — the standard GIF inter-frame optimisation.
 */
export class GifSession {
  private readonly encoder = GIFEncoder();
  private readonly width: number;
  private readonly height: number;
  private readonly profile: QualityProfile;
  private readonly pixels: number;

  private colors: Palette | null = null;
  private lut: PaletteLut | null = null;
  private transparentIndex = 0;
  private table: Palette = [];
  private colorDepth = 8;

  /** What a decoder currently has on screen, as RGB triples. */
  private displayed: Uint8Array | null = null;
  private frameCount = 0;
  private finished = false;

  private priming: Array<{ rgba: Uint8ClampedArray; delayMs: number }> = [];
  private readonly primeTarget: number;

  constructor({ width, height, profile, paletteSamples, totalFrames = 0 }: GifSessionOptions) {
    if (width < 1 || height < 1) throw new Error('GIF dimensions must be at least 1x1.');
    this.width = width;
    this.height = height;
    this.profile = profile;
    this.pixels = width * height;

    // Bound the fallback buffer to roughly 24 MB of pixel data.
    const budget = Math.max(1, Math.floor(24_000_000 / Math.max(1, this.pixels * 4)));
    this.primeTarget = Math.max(1, Math.min(6, budget, Math.max(1, totalFrames || 6)));

    if (paletteSamples && paletteSamples.length > 0) {
      this.setPalette(buildPalette(paletteSamples, profile.maxColors));
    }
  }

  get written(): number {
    return this.frameCount;
  }

  get paletteSize(): number {
    return this.colors?.length ?? 0;
  }

  addFrame(rgba: Uint8ClampedArray, delayMs: number): void {
    if (this.finished) throw new Error('This GIF has already been finished.');
    if (rgba.length !== this.pixels * 4) {
      throw new Error(
        `Frame size mismatch: expected ${this.pixels * 4} bytes, received ${rgba.length}.`,
      );
    }
    if (this.colors === null) {
      this.priming.push({ rgba, delayMs });
      if (this.priming.length >= this.primeTarget) this.flushPriming();
      return;
    }
    this.writeFrame(rgba, delayMs);
  }

  finish(): Uint8Array {
    if (this.finished) return this.encoder.bytes();
    if (this.priming.length > 0) this.flushPriming();
    if (this.frameCount === 0) throw new Error('Cannot encode a GIF with no frames.');
    this.encoder.finish();
    this.finished = true;
    this.displayed = null;
    return this.encoder.bytes();
  }

  // -------------------------------------------------------------- internals

  private setPalette(colors: Palette): void {
    if (colors.length === 0) throw new Error('Palette generation produced no colours.');
    this.colors = colors;
    this.lut = new PaletteLut(colors, this.profile.lookup);
    this.transparentIndex = colors.length;
    this.table = colors.concat([[0, 0, 0]]);
    this.colorDepth = colorTableBits(this.table.length);
  }

  private flushPriming(): void {
    const held = this.priming;
    this.priming = [];
    if (this.colors === null) {
      this.setPalette(buildPalette(held.map((f) => f.rgba), this.profile.maxColors));
    }
    for (const frame of held) this.writeFrame(frame.rgba, frame.delayMs);
  }

  private writeFrame(rgba: Uint8ClampedArray, delayMs: number): void {
    const lut = this.lut!;
    const colors = this.colors!;
    const { profile } = this;

    const index =
      profile.dither > 0
        ? applyPaletteDithered(rgba, this.width, this.height, lut, profile.dither)
        : applyPaletteFlat(rgba, lut);

    let hasTransparent = false;
    if (this.displayed === null) {
      const displayed = new Uint8Array(this.pixels * 3);
      for (let i = 0; i < this.pixels; i++) {
        const c = colors[index[i]];
        displayed[i * 3] = c[0];
        displayed[i * 3 + 1] = c[1];
        displayed[i * 3 + 2] = c[2];
      }
      this.displayed = displayed;
    } else {
      const displayed = this.displayed;
      const threshold = profile.deltaThreshold;
      const transparent = this.transparentIndex;
      for (let i = 0; i < this.pixels; i++) {
        const c = colors[index[i]];
        const o = i * 3;
        const dr = c[0] - displayed[o];
        const dg = c[1] - displayed[o + 1];
        const db = c[2] - displayed[o + 2];
        if (dr * dr + dg * dg + db * db <= threshold) {
          index[i] = transparent;
          hasTransparent = true;
        } else {
          displayed[o] = c[0];
          displayed[o + 1] = c[1];
          displayed[o + 2] = c[2];
        }
      }
    }

    this.encoder.writeFrame(index, this.width, this.height, {
      // The palette is written once, into the logical screen descriptor; later
      // frames inherit it as the global colour table.
      palette: this.frameCount === 0 ? this.table : null,
      delay: delayMs,
      repeat: 0,
      transparent: hasTransparent,
      transparentIndex: this.transparentIndex,
      // 1 = "do not dispose": required for transparent pixels to reveal the
      // previous frame instead of the background colour.
      dispose: 1,
      colorDepth: this.colorDepth,
    });
    this.frameCount++;
  }
}

/** Encodes a complete set of frames in one call. Used by tests and estimation. */
export function encodeGifFrames(
  frames: Array<{ rgba: Uint8ClampedArray; delayMs: number }>,
  width: number,
  height: number,
  profile: QualityProfile,
  paletteSamples?: Array<Uint8ClampedArray | Uint8Array>,
): Uint8Array {
  const session = new GifSession({
    width,
    height,
    profile,
    totalFrames: frames.length,
    paletteSamples,
  });
  for (const frame of frames) session.addFrame(frame.rgba, frame.delayMs);
  return session.finish();
}
