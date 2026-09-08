import type { CensorRegion, CropRect, FitMode, Sticker } from '../state/types';
import type { FrameProvider } from '../media/frames';
import type { FramePlan, FrameSource } from '../render/timeline';
import { Compositor, composeFrame } from '../render/compose';
import { MediaError } from '../media/errors';

export interface RenderSettings {
  width: number;
  height: number;
  fitMode: FitMode;
  crop: CropRect;
  background: string;
  stickers: Sticker[];
  censors: CensorRegion[];
}

/**
 * Renders planned frames to RGBA at a fixed output size. The preview uses the
 * same `composeFrame` on a visible canvas, so preview and export cannot drift
 * apart.
 */
export class FrameRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly compositor = new Compositor();

  constructor(width: number, height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(1, Math.round(width));
    this.canvas.height = Math.max(1, Math.round(height));
    // Every frame is read back with getImageData, so ask for the CPU-backed path.
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    if (!ctx) throw new MediaError('This browser cannot use a 2D canvas.');
    this.ctx = ctx;
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  async render(
    provider: FrameProvider,
    source: FrameSource,
    timeMs: number,
    settings: RenderSettings,
  ): Promise<ImageData> {
    const frame = await provider.get(source);
    composeFrame(this.compositor, {
      ctx: this.ctx,
      width: this.canvas.width,
      height: this.canvas.height,
      image: frame?.image ?? null,
      imageWidth: frame?.width ?? 0,
      imageHeight: frame?.height ?? 0,
      fitMode: settings.fitMode,
      crop: settings.crop,
      background: settings.background,
      stickers: settings.stickers,
      censors: settings.censors,
      timeMs,
    });
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose(): void {
    this.compositor.dispose();
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}

/**
 * Renders a spread of frames at reduced resolution for palette generation.
 *
 * Sampling across the *whole* timeline matters: a palette built from only the
 * opening frames misses colours that appear later. The app passes the cheap
 * preview provider here so this costs no extra video seeks.
 */
export async function renderPaletteSamples(
  plan: FramePlan,
  provider: FrameProvider,
  settings: RenderSettings,
  sampleCount: number,
  maxEdge = 180,
): Promise<Uint8ClampedArray[]> {
  if (plan.frames.length === 0) return [];
  const scale = Math.min(1, maxEdge / Math.max(1, Math.max(settings.width, settings.height)));
  const width = Math.max(8, Math.round(settings.width * scale));
  const height = Math.max(8, Math.round(settings.height * scale));

  const renderer = new FrameRenderer(width, height);
  const scaled: RenderSettings = { ...settings, width, height };
  const count = Math.max(1, Math.min(sampleCount, plan.frames.length));
  const samples: Uint8ClampedArray[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const index =
        count === 1 ? 0 : Math.round((i * (plan.frames.length - 1)) / (count - 1));
      const frame = plan.frames[index];
      const data = await renderer.render(provider, frame.source, frame.timeMs, scaled);
      samples.push(data.data);
    }
  } finally {
    renderer.dispose();
  }
  return samples;
}
