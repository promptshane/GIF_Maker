import type { PhotoAsset } from '../state/types';
import type { FrameSource } from '../render/timeline';
import type { VideoFrameReader } from './video';
import { MediaError } from './errors';

export interface FrameImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** Supplies the raw source image for a planned frame. */
export interface FrameProvider {
  get(source: FrameSource): Promise<FrameImage | null>;
  /**
   * Synchronous access, when the provider already holds the frame in memory.
   * The preview render loop needs this: it runs inside requestAnimationFrame
   * and cannot await a promise without dropping frames.
   */
  getSync?(source: FrameSource): FrameImage | null;
  dispose(): void;
}

export class PhotoFrameProvider implements FrameProvider {
  constructor(private readonly photos: PhotoAsset[]) {}

  async get(source: FrameSource): Promise<FrameImage | null> {
    return this.getSync(source);
  }

  getSync(source: FrameSource): FrameImage | null {
    if (source.kind !== 'photo') return null;
    const photo = this.photos[source.index];
    if (!photo) return null;
    return { image: photo.image, width: photo.width, height: photo.height };
  }

  dispose(): void {
    // Photo bitmaps are owned by the store, not by the provider.
  }
}

/**
 * Seeks the real video for every frame. Accurate and memory-light (one frame is
 * live at a time), but each frame costs a seek, so this is the export path.
 */
export class SeekingVideoFrameProvider implements FrameProvider {
  constructor(private readonly reader: VideoFrameReader) {}

  async get(source: FrameSource): Promise<FrameImage | null> {
    if (source.kind !== 'video') return null;
    await this.reader.seek(source.time);
    return {
      image: this.reader.element,
      width: this.reader.width,
      height: this.reader.height,
    };
  }

  dispose(): void {
    // The reader outlives the provider; the store disposes it.
  }
}

export interface PreviewCachePlan {
  /** Ascending, de-duplicated source timestamps to decode. */
  times: number[];
  width: number;
  height: number;
}

/**
 * Chooses how many frames to cache and at what size so preview playback is
 * instant without exhausting memory.
 *
 * The cache deliberately covers the *trim range* at a fixed sampling density
 * rather than the exact timestamps of the current frame plan. That way changing
 * frame rate, speed or playback direction only re-maps which cached frames are
 * requested — no re-decode — and only a trim change forces a rebuild.
 */
export function planPreviewCache(
  trimStart: number,
  trimEnd: number,
  srcW: number,
  srcH: number,
  {
    budgetBytes = 44_000_000,
    maxEdge = 420,
    maxFrames = 96,
    targetFps = 30,
  }: {
    budgetBytes?: number;
    maxEdge?: number;
    maxFrames?: number;
    targetFps?: number;
  } = {},
): PreviewCachePlan {
  const span = Math.max(0, trimEnd - trimStart);
  const scale = Math.min(1, maxEdge / Math.max(1, Math.max(srcW, srcH)));
  let width = Math.max(2, Math.round(srcW * scale));
  let height = Math.max(2, Math.round(srcH * scale));

  let count = Math.max(1, Math.min(maxFrames, Math.round(span * targetFps) + 1));
  let perFrame = width * height * 4;

  // Drop frames before shrinking them: a slightly choppier preview reads better
  // than a blurry one.
  while (count > 1 && count * perFrame > budgetBytes) count = Math.floor(count * 0.8);
  while (count * perFrame > budgetBytes && width > 64) {
    width = Math.max(2, Math.round(width * 0.8));
    height = Math.max(2, Math.round(height * 0.8));
    perFrame = width * height * 4;
  }

  const times =
    count <= 1
      ? [trimStart]
      : Array.from({ length: count }, (_, i) => trimStart + (span * i) / (count - 1));

  return { times, width, height };
}

/**
 * Decoded, downscaled video frames held in memory for preview playback.
 *
 * Seeking is far too slow to drive a live preview (each seek is tens to hundreds
 * of milliseconds), so the preview plays back from this cache instead. Overlays,
 * crop and canvas size are still composited live on top, which is why editing a
 * sticker or censor never triggers a rebuild.
 */
export class VideoPreviewCache implements FrameProvider {
  private readonly times: number[];
  private readonly bitmaps: ImageBitmap[];
  readonly width: number;
  readonly height: number;
  private disposed = false;

  private constructor(times: number[], bitmaps: ImageBitmap[], width: number, height: number) {
    this.times = times;
    this.bitmaps = bitmaps;
    this.width = width;
    this.height = height;
  }

  static async build(
    reader: VideoFrameReader,
    plan: PreviewCachePlan,
    options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<VideoPreviewCache> {
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) throw new MediaError('This browser cannot use a 2D canvas.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';

    const bitmaps: ImageBitmap[] = [];
    const times: number[] = [];
    try {
      for (let i = 0; i < plan.times.length; i++) {
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const time = plan.times[i];
        await reader.seek(time);
        ctx.drawImage(reader.element, 0, 0, plan.width, plan.height);
        bitmaps.push(await createImageBitmap(canvas));
        times.push(time);
        options.onProgress?.(i + 1, plan.times.length);
      }
    } catch (error) {
      for (const bitmap of bitmaps) bitmap.close();
      throw error;
    } finally {
      canvas.width = canvas.height = 1;
    }

    if (bitmaps.length === 0) {
      throw new MediaError(
        'No frames could be read from this video.',
        'The selected range may be empty, or the file may be damaged.',
      );
    }
    return new VideoPreviewCache(times, bitmaps, plan.width, plan.height);
  }

  /** Nearest cached frame to `time`. */
  private nearestIndex(time: number): number {
    const times = this.times;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < time) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(times[lo - 1] - time) <= Math.abs(times[lo] - time)) return lo - 1;
    return lo;
  }

  async get(source: FrameSource): Promise<FrameImage | null> {
    if (this.disposed || source.kind !== 'video') return null;
    const bitmap = this.bitmaps[this.nearestIndex(source.time)];
    if (!bitmap) return null;
    return { image: bitmap, width: this.width, height: this.height };
  }

  /** Synchronous variant used by the preview render loop. */
  getSync(source: FrameSource): FrameImage | null {
    if (this.disposed || source.kind !== 'video') return null;
    const bitmap = this.bitmaps[this.nearestIndex(source.time)];
    if (!bitmap) return null;
    return { image: bitmap, width: this.width, height: this.height };
  }

  get frameCount(): number {
    return this.bitmaps.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const bitmap of this.bitmaps) bitmap.close();
    this.bitmaps.length = 0;
    this.times.length = 0;
  }
}
