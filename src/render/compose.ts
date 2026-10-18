import type { BlurType, CensorRegion, CropRect, FitMode, Sticker } from '../state/types';
import { censorRectAt, isActiveAt } from './timeline';
import { clamp, computePlacement } from './geometry';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const EMOJI_FONT_STACK =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';

type RenderedPatch = { canvas: HTMLCanvasElement | OffscreenCanvas; sx: number; sy: number };

interface Scratch {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: Ctx2D;
}

function createScratch(width: number, height: number): Scratch {
  // Prefer a DOM canvas on the main thread (widest support), OffscreenCanvas in workers.
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is unavailable in this browser.');
    return { canvas, ctx };
  }
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable in this browser.');
  return { canvas, ctx: ctx as Ctx2D };
}

/**
 * Blur radius in pixels for a strength, relative to the canvas's shorter side.
 * On a 480px canvas: 0 → ~4px, 0.6 (the default) → ~22px, 1 → ~34px.
 */
export function blurRadius(strength: number, canvasShortSide: number): number {
  return Math.max(1, Math.round(canvasShortSide * (0.008 + clamp(strength, 0, 1) * 0.062)));
}

/**
 * Pixelation block size in pixels for a strength, relative to the canvas's
 * shorter side. Eased so the low end stays fine-grained: on a 480px canvas
 * 0 → ~5px, 0.6 → ~20px, 1 → ~48px.
 */
export function pixelBlockSize(strength: number, canvasShortSide: number): number {
  const s = clamp(strength, 0, 1);
  return Math.max(1, canvasShortSide * (0.01 + 0.09 * s * s));
}

/** Smooth alpha transition from a blur region's border to its full-strength interior. */
export function featherOpacity(distance: number, featherPx: number): number {
  if (featherPx <= 0) return distance >= 0 ? 1 : 0;
  const t = clamp(distance / featherPx, 0, 1);
  return t * t * (3 - 2 * t);
}

export interface CensorPixelGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  left: number;
  top: number;
  clipW: number;
  clipH: number;
  sampleX: number;
  sampleY: number;
  sampleW: number;
  sampleH: number;
}

/**
 * Converts a normalised censor rectangle to canvas pixels without quantising
 * its visible boundary. Scratch processing still samples whole pixels, but the
 * final clip can grow/shrink fractionally from frame to frame instead of waiting
 * for the next rounded pixel and appearing to snap.
 */
export function censorPixelGeometry(
  r: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): CensorPixelGeometry {
  const w = clamp(r.w, 0.005, 2) * width;
  const h = clamp(r.h, 0.005, 2) * height;
  const x = r.x * width - w / 2;
  const y = r.y * height - h / 2;
  const left = clamp(x, 0, width);
  const top = clamp(y, 0, height);
  const right = clamp(x + w, 0, width);
  const bottom = clamp(y + h, 0, height);
  const sampleX = clamp(Math.floor(left), 0, width);
  const sampleY = clamp(Math.floor(top), 0, height);
  const sampleRight = clamp(Math.ceil(right), 0, width);
  const sampleBottom = clamp(Math.ceil(bottom), 0, height);
  return {
    x,
    y,
    w,
    h,
    left,
    top,
    clipW: Math.max(0, right - left),
    clipH: Math.max(0, bottom - top),
    sampleX,
    sampleY,
    sampleW: Math.max(0, sampleRight - sampleX),
    sampleH: Math.max(0, sampleBottom - sampleY),
  };
}

let canvasFilterSupport: boolean | null = null;

/**
 * Safari only gained `CanvasRenderingContext2D.filter` in 18.0, so we detect it
 * rather than assume it and fall back to a multi-pass downscale blur.
 */
export function supportsCanvasFilter(): boolean {
  if (canvasFilterSupport !== null) return canvasFilterSupport;
  try {
    const { ctx } = createScratch(1, 1);
    if (!('filter' in ctx)) return (canvasFilterSupport = false);
    ctx.filter = 'blur(2px)';
    canvasFilterSupport = ctx.filter !== 'none' && ctx.filter !== '';
    ctx.filter = 'none';
  } catch {
    canvasFilterSupport = false;
  }
  return canvasFilterSupport;
}

/**
 * Reusable scratch surfaces. One Compositor is kept per rendering context
 * (preview, export) so we do not allocate canvases on every frame.
 */
export class Compositor {
  private blurA: Scratch | null = null;
  private blurB: Scratch | null = null;
  private pixel: Scratch | null = null;

  private surface(which: 'a' | 'b' | 'p', w: number, h: number): Scratch {
    const key = which === 'a' ? 'blurA' : which === 'b' ? 'blurB' : 'pixel';
    let s = this[key];
    if (!s) {
      s = createScratch(w, h);
      this[key] = s;
    } else if (s.canvas.width < w || s.canvas.height < h) {
      s.canvas.width = Math.max(w, s.canvas.width);
      s.canvas.height = Math.max(h, s.canvas.height);
    }
    // Always wipe the whole surface, not just the requested sub-rect: a blur
    // reaching past the region's edge would otherwise pull in stale pixels from
    // a previous, larger region.
    s.ctx.save();
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.filter = 'none';
    s.ctx.globalCompositeOperation = 'source-over';
    s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
    s.ctx.restore();
    return s;
  }

  dispose(): void {
    for (const s of [this.blurA, this.blurB, this.pixel]) {
      if (s) {
        s.canvas.width = 1;
        s.canvas.height = 1;
      }
    }
    this.blurA = this.blurB = this.pixel = null;
  }

  // ------------------------------------------------------------- public API

  /** Paints the canvas background. Kept separate so callers can skip it. */
  drawBackground(ctx: Ctx2D, width: number, height: number, background: string): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  drawSource(
    ctx: Ctx2D,
    image: CanvasImageSource,
    imageWidth: number,
    imageHeight: number,
    width: number,
    height: number,
    fitMode: FitMode,
    crop: CropRect,
  ): void {
    if (imageWidth <= 0 || imageHeight <= 0) return;
    const { src, dst } = computePlacement(imageWidth, imageHeight, width, height, fitMode, crop);
    const sx = clamp(src.x, 0, imageWidth);
    const sy = clamp(src.y, 0, imageHeight);
    const sw = clamp(src.w, 1, imageWidth - sx);
    const sh = clamp(src.h, 1, imageHeight - sy);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, sx, sy, sw, sh, dst.x, dst.y, dst.w, dst.h);
    ctx.restore();
  }

  /**
   * Applies every censor region visible at `timeMs`, reading back from the
   * canvas that has already been painted. Regions are drawn in array order so
   * overlapping regions stack predictably.
   */
  drawCensors(
    ctx: Ctx2D,
    width: number,
    height: number,
    censors: CensorRegion[],
    timeMs: number,
  ): void {
    for (const region of censors) {
      if (!isActiveAt(region.range, timeMs)) continue;
      const r = censorRectAt(region, timeMs);
      const g = censorPixelGeometry(r, width, height);

      // The visible clip stays fractional for smooth animated resizing. The
      // effect itself samples the smallest whole-pixel box covering that clip.
      if (g.clipW <= 0 || g.clipH <= 0 || g.sampleW < 1 || g.sampleH < 1) continue;

      if (region.effect === 'black') {
        ctx.save();
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        if (region.shape === 'circle') {
          ctx.ellipse(
            g.x + g.w / 2,
            g.y + g.h / 2,
            Math.max(0.5, g.w / 2),
            Math.max(0.5, g.h / 2),
            0,
            0,
            Math.PI * 2,
          );
        } else {
          ctx.rect(g.left, g.top, g.clipW, g.clipH);
        }
        ctx.fill();
        ctx.restore();
        continue;
      }

      // Strength is measured against the *canvas*, never the region: making a
      // region bigger must not also make its blur softer or its blocks coarser.
      const base = Math.min(width, height);
      const processed =
        region.effect === 'pixelate'
          ? this.pixelateRegion(
              ctx,
              g.sampleX,
              g.sampleY,
              g.sampleW,
              g.sampleH,
              pixelBlockSize(region.strength, base),
            )
          : this.blurRegion(
              ctx,
              g.sampleX,
              g.sampleY,
              g.sampleW,
              g.sampleH,
              blurRadius(region.strength, base),
              width,
              height,
              region.blurType ?? 'gaussian',
              region.motionAngle ?? 0,
              region.grain ?? 0.5,
            );
      if (!processed) continue;
      // Mask the processed patch, not the source frame, so the soft edge
      // smoothly reveals the untouched image underneath.
      const rendered = region.effect === 'blur' && (region.feather ?? 0) > 0
        ? this.featherRegion(processed, g, region)
        : processed;

      ctx.save();
      ctx.beginPath();
      if (region.shape === 'circle') {
        // Ellipse inscribed in the (unclipped) region box, then clipped to canvas.
        ctx.ellipse(
          g.x + g.w / 2,
          g.y + g.h / 2,
          Math.max(0.5, g.w / 2),
          Math.max(0.5, g.h / 2),
          0,
          0,
          Math.PI * 2,
        );
      } else {
        ctx.rect(g.left, g.top, g.clipW, g.clipH);
      }
      ctx.clip();
      ctx.imageSmoothingEnabled = region.effect !== 'pixelate';
      ctx.drawImage(
        rendered.canvas,
        rendered.sx,
        rendered.sy,
        g.sampleW,
        g.sampleH,
        g.sampleX,
        g.sampleY,
        g.sampleW,
        g.sampleH,
      );
      ctx.restore();
    }
  }

  drawStickers(
    ctx: Ctx2D,
    width: number,
    height: number,
    stickers: Sticker[],
    timeMs: number,
  ): void {
    const base = Math.min(width, height);
    for (const sticker of stickers) {
      if (!isActiveAt(sticker.range, timeMs)) continue;
      const px = Math.max(4, sticker.size * base);
      ctx.save();
      ctx.translate(sticker.x * width, sticker.y * height);
      ctx.rotate(sticker.rotation);
      ctx.font = `${px}px ${EMOJI_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(sticker.emoji, 0, 0);
      ctx.restore();
    }
  }

  // -------------------------------------------------------------- internals

  private pixelateRegion(
    ctx: Ctx2D,
    x: number,
    y: number,
    w: number,
    h: number,
    blockPx: number,
  ): { canvas: HTMLCanvasElement | OffscreenCanvas; sx: number; sy: number } | null {
    // Whole blocks across and down; each is then w/bw × h/bh, which is the
    // requested size to within one block's rounding.
    const bw = Math.max(1, Math.round(w / blockPx));
    const bh = Math.max(1, Math.round(h / blockPx));

    // Browsers point-sample when a single drawImage shrinks by a large factor
    // (WebKit especially), so a block would take the colour of one source
    // pixel rather than the block's average — and on video that shimmers from
    // frame to frame. Shrink to bw·2ᵏ × bh·2ᵏ first (a ratio of at most ~2,
    // which bilinear filtering handles well), then halve k times. Each halving
    // is an exact 2×2 average aligned to the block grid, so every final block
    // really is the mean of its own pixels and nothing of its neighbours'.
    let k = 0;
    while ((bw << (k + 1)) <= w && (bh << (k + 1)) <= h) k++;
    let source: CanvasImageSource = ctx.canvas as CanvasImageSource;
    let sx = x;
    let sy = y;
    let sw = w;
    let sh = h;
    let which: 'a' | 'b' = 'a';
    for (; k > 0; k--) {
      const nw = bw << k;
      const nh = bh << k;
      const step = this.surface(which, nw, nh);
      step.ctx.save();
      step.ctx.setTransform(1, 0, 0, 1, 0, 0);
      step.ctx.imageSmoothingEnabled = true;
      step.ctx.imageSmoothingQuality = 'high';
      step.ctx.drawImage(source, sx, sy, sw, sh, 0, 0, nw, nh);
      step.ctx.restore();
      source = step.canvas as CanvasImageSource;
      sx = 0;
      sy = 0;
      sw = nw;
      sh = nh;
      which = which === 'a' ? 'b' : 'a';
    }

    const small = this.surface('p', bw, bh);
    small.ctx.save();
    small.ctx.setTransform(1, 0, 0, 1, 0, 0);
    small.ctx.imageSmoothingEnabled = true;
    small.ctx.imageSmoothingQuality = 'high';
    small.ctx.drawImage(source, sx, sy, sw, sh, 0, 0, bw, bh);
    small.ctx.restore();

    // Blow the tiny image back up with smoothing off to get hard blocks.
    const out = this.surface('a', w, h);
    out.ctx.save();
    out.ctx.setTransform(1, 0, 0, 1, 0, 0);
    out.ctx.imageSmoothingEnabled = false;
    out.ctx.drawImage(small.canvas, 0, 0, bw, bh, 0, 0, w, h);
    out.ctx.restore();
    return { canvas: out.canvas, sx: 0, sy: 0 };
  }

  /**
   * Applies a feather mask on a separate scratch surface. The original image
   * remains on the output canvas and shows through the progressively
   * transparent edge. Coordinates stay anchored to the output canvas.
   */
  private featherRegion(input: RenderedPatch, g: CensorPixelGeometry, region: CensorRegion): RenderedPatch {
    const width = g.sampleW;
    const height = g.sampleH;
    const mask = this.surface('p', width, height);
    mask.ctx.drawImage(input.canvas, input.sx, input.sy, width, height, 0, 0, width, height);
    const pixels = mask.ctx.getImageData(0, 0, width, height);
    const data = pixels.data;
    const featherPx = Math.min(g.w, g.h) * 0.45 * clamp(region.feather ?? 0, 0, 1);
    const rx = Math.max(0.5, g.w / 2);
    const ry = Math.max(0.5, g.h / 2);
    for (let y = 0; y < height; y++) {
      const py = g.sampleY + y + 0.5;
      for (let x = 0; x < width; x++) {
        const px = g.sampleX + x + 0.5;
        let distance: number;
        if (region.shape === 'circle') {
          const nx = (px - (g.x + rx)) / rx;
          const ny = (py - (g.y + ry)) / ry;
          distance = (1 - Math.hypot(nx, ny)) * Math.min(rx, ry);
        } else {
          distance = Math.min(px - g.x, g.x + g.w - px, py - g.y, g.y + g.h - py);
        }
        data[(y * width + x) * 4 + 3] *= featherOpacity(distance, featherPx);
      }
    }
    mask.ctx.putImageData(pixels, 0, 0);
    return { canvas: mask.canvas, sx: 0, sy: 0 };
  }

  /** True separable box blur (a single, uniformly weighted kernel). */
  private boxBlur(work: Scratch, width: number, height: number, radius: number): void {
    const pixels = work.ctx.getImageData(0, 0, width, height);
    const source = pixels.data;
    const intermediate = new Uint8ClampedArray(source.length);
    const r = Math.max(1, Math.round(radius));
    const kernel = 2 * r + 1;
    const within = (value: number, max: number) => Math.max(0, Math.min(max, value));

    for (let y = 0; y < height; y++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          sum += source[(y * width + within(k, width - 1)) * 4 + c];
        }
        for (let x = 0; x < width; x++) {
          intermediate[(y * width + x) * 4 + c] = sum / kernel;
          sum += source[(y * width + within(x + r + 1, width - 1)) * 4 + c]
            - source[(y * width + within(x - r, width - 1)) * 4 + c];
        }
      }
    }
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          sum += intermediate[(within(k, height - 1) * width + x) * 4 + c];
        }
        for (let y = 0; y < height; y++) {
          source[(y * width + x) * 4 + c] = sum / kernel;
          sum += intermediate[(within(y + r + 1, height - 1) * width + x) * 4 + c]
            - intermediate[(within(y - r, height - 1) * width + x) * 4 + c];
        }
      }
    }
    work.ctx.putImageData(pixels, 0, 0);
  }

  /** Stable spatial grain: identical pixels at the same position never flicker between frames. */
  private addFrostGrain(work: Scratch, width: number, height: number, px: number, py: number, grain: number): void {
    const amount = clamp(grain, 0, 1);
    if (amount === 0) return;
    const image = work.ctx.getImageData(0, 0, width, height);
    const data = image.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let seed = Math.imul(px + x + 1, 374761393) ^ Math.imul(py + y + 1, 668265263);
        seed = Math.imul(seed ^ (seed >>> 13), 1274126177);
        const noise = ((seed >>> 0) / 4294967295 - 0.5) * 88 * amount;
        const at = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) {
          data[at + c] = Math.max(0, Math.min(255, data[at + c] + noise + 10 * amount));
        }
      }
    }
    work.ctx.putImageData(image, 0, 0);
  }

  private blurRegion(
    ctx: Ctx2D,
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    canvasW: number,
    canvasH: number,
    style: BlurType,
    angle: number,
    grain: number,
  ): RenderedPatch | null {
    // Neighbouring source pixels must be sampled beyond the censor boundary,
    // otherwise blurred edges go dark or shifted streaks turn transparent.
    const pad = Math.min(radius * 2.5, 256);
    const px = clamp(x - pad, 0, canvasW);
    const py = clamp(y - pad, 0, canvasH);
    const pw = Math.floor(clamp(x + w + pad, 0, canvasW) - px);
    const ph = Math.floor(clamp(y + h + pad, 0, canvasH) - py);
    if (pw < 1 || ph < 1) return null;
    const offsetX = x - px;
    const offsetY = y - py;
    const work = this.surface('a', pw, ph);

    if (style === 'motion' || style === 'radial') {
      const source = this.surface('b', pw, ph);
      source.ctx.drawImage(ctx.canvas as CanvasImageSource, px, py, pw, ph, 0, 0, pw, ph);
      const count = 13;
      const radians = clamp(angle, 0, 360) * Math.PI / 180;
      const centerX = offsetX + w / 2;
      const centerY = offsetY + h / 2;
      work.ctx.save();
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        work.ctx.globalAlpha = 1 / (i + 1);
        if (style === 'motion') {
          const shift = (t - 0.5) * radius * 2.3;
          work.ctx.drawImage(source.canvas, 0, 0, pw, ph,
            shift * Math.cos(radians), shift * Math.sin(radians), pw, ph);
        } else {
          const scale = 1 + t * Math.min(0.85, radius / Math.max(20, Math.min(w, h)));
          work.ctx.drawImage(source.canvas, 0, 0, pw, ph,
            centerX * (1 - scale), centerY * (1 - scale), pw * scale, ph * scale);
        }
      }
      work.ctx.restore();
      return { canvas: work.canvas, sx: offsetX, sy: offsetY };
    }

    work.ctx.save();
    work.ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (style === 'box') {
      work.ctx.drawImage(ctx.canvas as CanvasImageSource, px, py, pw, ph, 0, 0, pw, ph);
      work.ctx.restore();
      this.boxBlur(work, pw, ph, radius);
      return { canvas: work.canvas, sx: offsetX, sy: offsetY };
    }

    if (supportsCanvasFilter()) {
      work.ctx.filter = 'blur(' + radius + 'px)';
      work.ctx.drawImage(ctx.canvas as CanvasImageSource, px, py, pw, ph, 0, 0, pw, ph);
      work.ctx.filter = 'none';
      work.ctx.restore();
      if (style === 'frosted') this.addFrostGrain(work, pw, ph, px, py, grain);
      return { canvas: work.canvas, sx: offsetX, sy: offsetY };
    }

    // Safari < 18: bilinear downscale/upscale approximates Gaussian blur.
    work.ctx.imageSmoothingEnabled = true;
    work.ctx.imageSmoothingQuality = 'high';
    work.ctx.drawImage(ctx.canvas as CanvasImageSource, px, py, pw, ph, 0, 0, pw, ph);
    work.ctx.restore();
    const factor = clamp(1 / Math.max(1.5, radius / 1.6), 0.02, 0.6);
    const tw = Math.max(1, Math.round(pw * factor));
    const th = Math.max(1, Math.round(ph * factor));
    const temp = this.surface('b', tw, th);
    for (let pass = 0; pass < 3; pass++) {
      temp.ctx.save();
      temp.ctx.setTransform(1, 0, 0, 1, 0, 0);
      temp.ctx.clearRect(0, 0, temp.canvas.width, temp.canvas.height);
      temp.ctx.imageSmoothingEnabled = true;
      temp.ctx.imageSmoothingQuality = 'high';
      temp.ctx.drawImage(work.canvas, 0, 0, pw, ph, 0, 0, tw, th);
      temp.ctx.restore();

      work.ctx.save();
      work.ctx.setTransform(1, 0, 0, 1, 0, 0);
      work.ctx.clearRect(0, 0, work.canvas.width, work.canvas.height);
      work.ctx.imageSmoothingEnabled = true;
      work.ctx.imageSmoothingQuality = 'high';
      work.ctx.drawImage(temp.canvas, 0, 0, tw, th, 0, 0, pw, ph);
      work.ctx.restore();
    }
    if (style === 'frosted') this.addFrostGrain(work, pw, ph, px, py, grain);
    return { canvas: work.canvas, sx: offsetX, sy: offsetY };
  }
}

export interface ComposeFrameOptions {
  ctx: Ctx2D;
  width: number;
  height: number;
  image: CanvasImageSource | null;
  imageWidth: number;
  imageHeight: number;
  fitMode: FitMode;
  crop: CropRect;
  background: string;
  stickers: Sticker[];
  censors: CensorRegion[];
  timeMs: number;
}

/**
 * Renders one complete output frame. The preview and the exporter both call
 * this, which is what guarantees "what you see is what you export".
 */
export function composeFrame(compositor: Compositor, o: ComposeFrameOptions): void {
  compositor.drawBackground(o.ctx, o.width, o.height, o.background);
  if (o.image) {
    compositor.drawSource(
      o.ctx,
      o.image,
      o.imageWidth,
      o.imageHeight,
      o.width,
      o.height,
      o.fitMode,
      o.crop,
    );
  }
  compositor.drawCensors(o.ctx, o.width, o.height, o.censors, o.timeMs);
  compositor.drawStickers(o.ctx, o.width, o.height, o.stickers, o.timeMs);
}
